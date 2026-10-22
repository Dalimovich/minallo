// Polished, dependency-free SVG charts for the admin dashboard.
// Labelled X/Y axes (with titles), grid lines, a floating hover tooltip, a
// profit area fill and a peak marker.
//
// The SVG scales UNIFORMLY (width:100%, height:auto, default preserveAspectRatio)
// so axis text never stretches. Each renderer clears `host`, injects the svg +
// an absolutely-positioned tooltip, and wires hover handlers.

const NS = 'http://www.w3.org/2000/svg';
const W = 920;
const H = 340;

function _prep(host: HTMLElement): { svg: SVGSVGElement; tip: HTMLDivElement } {
  host.innerHTML = '';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
  svg.setAttribute('class', 'adm-chart');
  // Uniform scaling — let width drive, height follows the viewBox aspect ratio.
  svg.style.cssText = 'width:100%;height:auto;display:block;overflow:visible';
  host.appendChild(svg);
  const tip = document.createElement('div');
  tip.className = 'adm-chart-tip';
  host.appendChild(tip);
  return { svg, tip };
}

function _moveTip(host: HTMLElement, tip: HTMLDivElement, clientX: number, clientY: number, html: string): void {
  const box = host.getBoundingClientRect();
  tip.innerHTML = html;
  tip.style.left = (clientX - box.left) + 'px';
  tip.style.top = (clientY - box.top) + 'px';
  tip.style.opacity = '1';
}

// ── Bar chart (daily / weekly signups) ───────────────────────────────────────
export interface BarPoint { label: string; value: number; }

export function renderBarChart(
  host: HTMLElement,
  points: BarPoint[],
  opts: { caption?: string; tooltipNoun?: string; yTitle?: string; xTitle?: string } = {}
): void {
  const { svg, tip } = _prep(host);
  const m = { top: 26, right: 26, bottom: 58, left: 70 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const maxVal = points.reduce((a, p) => (p.value > a ? p.value : a), 0);
  const max = Math.max(maxVal, 4);
  const band = iw / Math.max(points.length, 1);
  const barW = Math.max(4, band * 0.6);
  const y = (v: number): number => m.top + (max - v) / max * ih;
  const noun = opts.tooltipNoun || 'signup';

  // Whole-number Y ticks, capped at ~6 lines.
  const tickStep = Math.max(1, Math.ceil(max / 6));
  let html =
    '<defs><linearGradient id="admBar" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#0284c7"/>' +
    '</linearGradient></defs>';
  for (let i = 0; i <= max; i += tickStep) {
    const yy = y(i);
    html += '<line class="adm-gridline" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + yy + '" y2="' + yy + '"/>';
    html += '<text class="adm-axis" x="' + (m.left - 12) + '" y="' + (yy + 4) + '" text-anchor="end">' + i + '</text>';
  }
  // Axes.
  html += '<line class="adm-axis-line" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + (H - m.bottom) + '" y2="' + (H - m.bottom) + '"/>';
  html += '<line class="adm-axis-line" x1="' + m.left + '" x2="' + m.left + '" y1="' + m.top + '" y2="' + (H - m.bottom) + '"/>';

  points.forEach((p, i) => {
    const x = m.left + i * band + (band - barW) / 2;
    const h = Math.max(p.value > 0 ? 2 : 0, H - m.bottom - y(p.value));
    const cls = p.value > 0 ? 'adm-bar' : 'adm-bar-ghost';
    html += '<rect class="' + cls + '" x="' + x + '" y="' + y(p.value) + '" width="' + barW + '" height="' + h + '" rx="3"/>';
    const every = Math.max(1, Math.ceil(points.length / 8));
    if (i % every === 0 || i === points.length - 1) {
      html += '<text class="adm-axis" x="' + (x + barW / 2) + '" y="' + (H - m.bottom + 18) + '" text-anchor="middle">' + _esc(p.label) + '</text>';
    }
    if (p.value === maxVal && maxVal > 0) {
      html += '<text class="adm-peak" x="' + (x + barW / 2) + '" y="' + (y(p.value) - 8) + '" text-anchor="middle">Peak ' + p.value + '</text>';
    }
    html += '<rect data-i="' + i + '" x="' + (m.left + i * band) + '" y="' + m.top + '" width="' + band + '" height="' + ih + '" fill="transparent"/>';
  });

  // Axis titles.
  if (opts.yTitle) {
    html += '<text class="adm-axis-title" transform="translate(18 ' + (m.top + ih / 2) + ') rotate(-90)" text-anchor="middle">' + _esc(opts.yTitle) + '</text>';
  }
  html += '<text class="adm-axis-title" x="' + (m.left + iw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + _esc(opts.xTitle || 'Date') + '</text>';

  svg.innerHTML = html;
  _wireHover(svg, tip, host, (i, e) => {
    const p = points[i];
    if (!p) return;
    _moveTip(host, tip, e.clientX, e.clientY,
      '<strong>' + _esc(p.label) + '</strong><span>' + p.value + ' ' + noun + (p.value === 1 ? '' : 's') + '</span>');
  });

  if (opts.caption) {
    const cap = document.createElement('div');
    cap.className = 'adm-chart-cap';
    cap.textContent = opts.caption;
    host.appendChild(cap);
  }
}

// ── Line chart (revenue / cost / profit, or the user equivalents) ─────────────
export interface LinePoint { label: string; revenue: number; cost: number; profit: number; }

export function renderLineChart(
  host: HTMLElement,
  points: LinePoint[],
  fmt: (n: number) => string,
  opts: { yTitle?: string; xTitle?: string } = {}
): void {
  const { svg, tip } = _prep(host);
  const m = { top: 26, right: 26, bottom: 58, left: 78 };
  const iw = W - m.left - m.right;
  const ih = H - m.top - m.bottom;
  const vals = points.flatMap((d) => [d.revenue, d.cost, d.profit]);
  const rawMin = Math.min(0, ...vals);
  const rawMax = Math.max(1, ...vals);
  // Pad the top a little so the highest line isn't glued to the frame.
  const max = rawMax * 1.12;
  const min = rawMin < 0 ? rawMin * 1.12 : 0;
  const span = max - min || 1;
  const y = (v: number): number => m.top + (max - v) / span * ih;
  const x = (i: number): number => m.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);

  const rev = points.map((d, i) => ({ x: x(i), y: y(d.revenue) }));
  const cost = points.map((d, i) => ({ x: x(i), y: y(d.cost) }));
  const profit = points.map((d, i) => ({ x: x(i), y: y(d.profit) }));

  const line = (pts: Array<{ x: number; y: number }>): string =>
    pts.map((p, i) => (i ? 'L' : 'M') + ' ' + p.x + ' ' + p.y).join(' ');
  const area = (pts: Array<{ x: number; y: number }>, baseY: number): string =>
    pts.length ? 'M ' + pts[0]!.x + ' ' + baseY + ' L ' + pts.map((p) => p.x + ' ' + p.y).join(' L ') +
      ' L ' + pts[pts.length - 1]!.x + ' ' + baseY + ' Z' : '';

  let html =
    '<defs><linearGradient id="admArea" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#6ee7b7" stop-opacity="0.28"/>' +
    '<stop offset="1" stop-color="#6ee7b7" stop-opacity="0"/></linearGradient></defs>';

  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = min + (span / ticks) * i;
    const yy = y(v);
    html += '<line class="adm-gridline" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + yy + '" y2="' + yy + '"/>';
    html += '<text class="adm-axis" x="' + (m.left - 12) + '" y="' + (yy + 4) + '" text-anchor="end">' + _esc(fmt(v)) + '</text>';
  }
  // Axes (Y on the left, X on the zero baseline).
  html += '<line class="adm-axis-line" x1="' + m.left + '" x2="' + m.left + '" y1="' + m.top + '" y2="' + (H - m.bottom) + '"/>';
  html += '<line class="adm-axis-line" x1="' + m.left + '" x2="' + (W - m.right) + '" y1="' + y(Math.max(0, min)) + '" y2="' + y(Math.max(0, min)) + '"/>';
  points.forEach((d, i) => {
    html += '<text class="adm-axis" x="' + x(i) + '" y="' + (H - m.bottom + 18) + '" text-anchor="middle">' + _esc(d.label) + '</text>';
  });

  html += '<path class="adm-area" d="' + area(profit, y(Math.max(0, min))) + '"/>';
  html += '<path class="adm-line-cost" d="' + line(cost) + '"/>';
  html += '<path class="adm-line-rev" d="' + line(rev) + '"/>';
  html += '<path class="adm-line-profit" d="' + line(profit) + '"/>';
  rev.forEach((p) => { html += '<circle class="adm-dot" cx="' + p.x + '" cy="' + p.y + '" r="3.5" fill="#38bdf8"/>'; });
  profit.forEach((p) => { html += '<circle class="adm-dot" cx="' + p.x + '" cy="' + p.y + '" r="4" fill="#6ee7b7"/>'; });

  points.forEach((_, i) => {
    const bx = points.length <= 1 ? m.left : x(i) - iw / points.length / 2;
    html += '<rect data-i="' + i + '" x="' + bx + '" y="' + m.top + '" width="' + (iw / points.length) + '" height="' + ih + '" fill="transparent"/>';
  });

  if (opts.yTitle) {
    html += '<text class="adm-axis-title" transform="translate(18 ' + (m.top + ih / 2) + ') rotate(-90)" text-anchor="middle">' + _esc(opts.yTitle) + '</text>';
  }
  html += '<text class="adm-axis-title" x="' + (m.left + iw / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + _esc(opts.xTitle || 'Month') + '</text>';

  svg.innerHTML = html;
  _wireHover(svg, tip, host, (i, e) => {
    const d = points[i];
    if (!d) return;
    _moveTip(host, tip, e.clientX, e.clientY,
      '<strong>' + _esc(d.label) + '</strong>' +
      '<span><i style="background:#38bdf8"></i>Revenue: ' + _esc(fmt(d.revenue)) + '</span>' +
      '<span><i style="background:#fb7185"></i>Costs: ' + _esc(fmt(d.cost)) + '</span>' +
      '<span><i style="background:#6ee7b7"></i>Profit: ' + _esc(fmt(d.profit)) + '</span>');
  });
}

function _wireHover(
  svg: SVGSVGElement,
  tip: HTMLDivElement,
  host: HTMLElement,
  onMove: (i: number, e: MouseEvent) => void
): void {
  svg.querySelectorAll<SVGRectElement>('rect[data-i]').forEach((r) => {
    r.addEventListener('mousemove', (e) => onMove(Number(r.dataset['i']), e));
    r.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
  void host;
}

function _esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
