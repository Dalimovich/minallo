// Lightweight markdown → HTML renderer for AI message bubbles. Handles
// headings, code blocks, math (KaTeX), lists, blockquotes, inline emphasis.

// Map of common fence-language aliases to display names. Anything not in
// here is shown capitalised. "Code" is the fallback when no lang is given.
const LANG_DISPLAY: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX',
  js: 'JavaScript', javascript: 'JavaScript', jsx: 'JSX',
  py: 'Python', python: 'Python',
  rb: 'Ruby', ruby: 'Ruby',
  go: 'Go', golang: 'Go',
  rs: 'Rust', rust: 'Rust',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin', swift: 'Swift',
  c: 'C', cpp: 'C++', 'c++': 'C++', h: 'C', hpp: 'C++', cs: 'C#', csharp: 'C#',
  php: 'PHP', sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
  ps1: 'PowerShell', powershell: 'PowerShell',
  sql: 'SQL', mysql: 'MySQL', psql: 'PostgreSQL', postgresql: 'PostgreSQL',
  html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less',
  json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI',
  md: 'Markdown', markdown: 'Markdown', tex: 'LaTeX', latex: 'LaTeX',
  dockerfile: 'Dockerfile', makefile: 'Makefile',
  r: 'R', matlab: 'MATLAB', m: 'MATLAB', lua: 'Lua', dart: 'Dart',
  scala: 'Scala', haskell: 'Haskell', hs: 'Haskell', clj: 'Clojure',
  elixir: 'Elixir', ex: 'Elixir', erlang: 'Erlang', erl: 'Erlang',
  graphql: 'GraphQL', gql: 'GraphQL', proto: 'Protobuf',
  diff: 'Diff', patch: 'Diff', text: 'Text', plain: 'Text'
};
function prettyLang(raw: string): string {
  const key = (raw || '').trim().toLowerCase();
  if (!key) return 'Code';
  if (LANG_DISPLAY[key]) return LANG_DISPLAY[key];
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// One-time delegated click handler for the copy buttons we emit on every
// code block. Idempotent — re-importing the module won't double-bind. We
// guard for browser environment so the tsx test runner doesn't blow up.
declare global {
  interface Window { _ssCodeCopyBound?: boolean }
}
if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window._ssCodeCopyBound) {
  window._ssCodeCopyBound = true;
  document.addEventListener('click', (ev) => {
    const target = ev.target as Element | null;
    if (!target) return;
    const btn = target.closest('.md-code-copy') as HTMLButtonElement | null;
    if (!btn) return;
    const block = btn.closest('.md-code-block');
    const code = block?.querySelector('pre code');
    const text = code?.textContent || '';
    if (!text) return;
    const done = (): void => {
      btn.classList.add('is-copied');
      const t = window.setTimeout(() => btn.classList.remove('is-copied'), 1400);
      btn.dataset.copyTimer = String(t);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      // Fallback for non-secure contexts / older browsers. textarea + exec.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { /* swallow */ }
      ta.remove();
    }
  });
}

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function scheduleKatex(): void {
    if (window._ssScheduleKatexRender) window._ssScheduleKatexRender();
  }

  function renderKatex(src: string, display: boolean): string {
    if (!window.katex) {
      scheduleKatex();
      return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
    }
    try {
      return window.katex.renderToString(src, { displayMode: display, throwOnError: false });
    } catch {
      return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
    }
  }

  function num(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function renderDiagram(raw: string): string {
    try {
      const spec = JSON.parse(raw) as {
        title?: string;
        caption?: string;
        nodes?: Array<{ id?: string; label?: string; x?: number; y?: number; shape?: string }>;
        edges?: Array<{ from?: string; to?: string; label?: string; type?: string }>;
        labels?: Array<{ text?: string; x?: number; y?: number }>;
      };
      const nodes = Array.isArray(spec.nodes) ? spec.nodes.slice(0, 18) : [];
      const edges = Array.isArray(spec.edges) ? spec.edges.slice(0, 28) : [];
      const labels = Array.isArray(spec.labels) ? spec.labels.slice(0, 18) : [];
      if (!nodes.length && !labels.length) throw new Error('empty diagram');
      // Auto-size rect width from label length so a 3-char node doesn't
      // sit inside a 140px box and a long label doesn't overflow.
      const rectWidth = (label: string): number => {
        const longest = label.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
        const est = Math.max(label.length * 6.5, longest * 9) + 28;
        return Math.max(80, Math.min(220, Math.round(est)));
      };
      const nodeById = new Map<string, { x: number; y: number; w: number; label: string; shape: string }>();
      nodes.forEach((node, idx) => {
        const label = String(node.label || node.id || 'n' + idx).slice(0, 80);
        const shape = String(node.shape || 'rect').toLowerCase();
        nodeById.set(String(node.id || 'n' + idx), {
          x: Math.max(30, Math.min(770, num(node.x, 120 + (idx % 4) * 170))),
          y: Math.max(36, Math.min(420, num(node.y, 100 + Math.floor(idx / 4) * 110))),
          w: shape === 'rect' ? rectWidth(label) : 80,
          label,
          shape,
        });
      });

      const svg: string[] = [
        '<svg class="md-diagram-svg" viewBox="0 0 800 460" role="img" aria-label="' +
          esc(spec.title || 'Rendered diagram') + '">',
        '<defs>',
          '<marker id="mdDiagramArrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker>',
          '<pattern id="mdDiagramHatch" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" stroke-width="1.2"/></pattern>',
        '</defs>',
      ];
      edges.forEach((edge) => {
        const a = edge.from ? nodeById.get(String(edge.from)) : null;
        const b = edge.to ? nodeById.get(String(edge.to)) : null;
        if (!a || !b) return;
        const isSelf = a === b;
        const isArc = isSelf || String(edge.type || '').toLowerCase() === 'arc';
        let labelX = (a.x + b.x) / 2;
        let labelY = (a.y + b.y) / 2 - 8;
        if (isSelf) {
          // Self-loop: small arc above the node.
          const r = 26;
          const p = 'M ' + (a.x - 10) + ' ' + (a.y - 30) +
                    ' a ' + r + ' ' + r + ' 0 1 1 ' + 20 + ' 0';
          svg.push('<path class="md-diagram-edge" d="' + p + '" fill="none" marker-end="url(#mdDiagramArrow)"/>');
          labelX = a.x;
          labelY = a.y - 60;
        } else if (isArc) {
          // Quadratic bezier with perpendicular control offset.
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.max(1, Math.hypot(dx, dy));
          const off = 30;
          const cx = mx + (-dy / len) * off;
          const cy = my + (dx / len) * off;
          svg.push(
            '<path class="md-diagram-edge" d="M ' + a.x + ' ' + a.y +
              ' Q ' + cx + ' ' + cy + ' ' + b.x + ' ' + b.y +
              '" fill="none" marker-end="url(#mdDiagramArrow)"/>'
          );
          labelX = cx;
          labelY = cy - 6;
        } else {
          svg.push(
            '<line class="md-diagram-edge" x1="' + a.x + '" y1="' + a.y +
              '" x2="' + b.x + '" y2="' + b.y + '" marker-end="url(#mdDiagramArrow)"/>'
          );
        }
        if (edge.label) {
          svg.push(
            '<text class="md-diagram-edge-label" x="' + labelX + '" y="' + labelY + '">' +
              esc(String(edge.label).slice(0, 50)) + '</text>'
          );
        }
      });
      nodeById.forEach((node) => {
        // Shapes:
        //   rect     — block / step / component (auto-width)
        //   circle   — joint / wheel / state
        //   joint    — small solid pin marker (FBD pin joints)
        //   triangle — fixed support (apex up, label below)
        //   ground   — immovable surface: horizontal bar + hatched fill below
        //   arrow    — small diamond marker; force vectors should be edges
        //              (which now carry arrow markers), but a labelled point
        //              is useful as an anchor / annotation
        if (node.shape === 'circle') {
          svg.push('<circle class="md-diagram-node" cx="' + node.x + '" cy="' + node.y + '" r="40"/>');
        } else if (node.shape === 'joint') {
          svg.push('<circle class="md-diagram-node md-diagram-node--joint" cx="' + node.x + '" cy="' + node.y + '" r="6"/>');
        } else if (node.shape === 'triangle') {
          const s = 28;
          const pts = (node.x) + ',' + (node.y - s) + ' ' +
                      (node.x - s) + ',' + (node.y + s * 0.6) + ' ' +
                      (node.x + s) + ',' + (node.y + s * 0.6);
          svg.push('<polygon class="md-diagram-node" points="' + pts + '"/>');
          // Hatched ground line under the support apex.
          svg.push('<line class="md-diagram-edge" x1="' + (node.x - s - 6) + '" y1="' + (node.y + s * 0.6 + 1) +
                   '" x2="' + (node.x + s + 6) + '" y2="' + (node.y + s * 0.6 + 1) + '"/>');
          svg.push('<rect x="' + (node.x - s - 6) + '" y="' + (node.y + s * 0.6 + 1) +
                   '" width="' + ((s + 6) * 2) + '" height="6" fill="url(#mdDiagramHatch)" opacity="0.6"/>');
        } else if (node.shape === 'ground') {
          const w = 60;
          svg.push('<line class="md-diagram-edge" x1="' + (node.x - w) + '" y1="' + node.y +
                   '" x2="' + (node.x + w) + '" y2="' + node.y + '"/>');
          svg.push('<rect x="' + (node.x - w) + '" y="' + node.y +
                   '" width="' + (w * 2) + '" height="10" fill="url(#mdDiagramHatch)" opacity="0.6"/>');
        } else if (node.shape === 'arrow') {
          const s = 9;
          const pts = (node.x) + ',' + (node.y - s) + ' ' +
                      (node.x + s) + ',' + (node.y) + ' ' +
                      (node.x) + ',' + (node.y + s) + ' ' +
                      (node.x - s) + ',' + (node.y);
          svg.push('<polygon class="md-diagram-node md-diagram-node--arrow" points="' + pts + '"/>');
        } else {
          const half = node.w / 2;
          svg.push(
            '<rect class="md-diagram-node" x="' + (node.x - half) + '" y="' + (node.y - 30) +
              '" width="' + node.w + '" height="60" rx="12"/>'
          );
        }
        // Label placement: shapes without internal room (triangle/ground/
        // joint/arrow) get the label below the geometry; rect/circle get it
        // centred inside.
        const wordList = node.label.split(/\s+/);
        if (node.shape === 'triangle' || node.shape === 'ground' || node.shape === 'joint' || node.shape === 'arrow') {
          const ly = node.shape === 'triangle' ? node.y + 38 :
                     node.shape === 'ground'   ? node.y + 24 :
                                                 node.y + 18;
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + ly + '">' +
                   esc(wordList.join(' ').slice(0, 40)) + '</text>');
        } else {
          // rect/circle: split into up to 2 lines, sized to fit width.
          const charsPerLine = node.shape === 'rect' ? Math.max(8, Math.floor(node.w / 7)) : 12;
          const lines: string[] = [];
          let buf = '';
          for (const word of wordList) {
            if (!buf) { buf = word; continue; }
            if ((buf + ' ' + word).length <= charsPerLine) buf += ' ' + word;
            else { lines.push(buf); buf = word; if (lines.length >= 1) break; }
          }
          if (buf) lines.push(buf);
          const line1 = lines[0] || '';
          const line2 = lines[1] || '';
          svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (node.y - (line2 ? 4 : -4)) + '">' + esc(line1) + '</text>');
          if (line2) svg.push('<text class="md-diagram-node-label" x="' + node.x + '" y="' + (node.y + 15) + '">' + esc(line2) + '</text>');
        }
      });
      labels.forEach((label) => {
        svg.push(
          '<text class="md-diagram-free-label" x="' + Math.max(20, Math.min(780, num(label.x, 80))) +
            '" y="' + Math.max(24, Math.min(440, num(label.y, 80))) + '">' +
            esc(String(label.text || '').slice(0, 90)) + '</text>'
        );
      });
      svg.push('</svg>');

      return (
        '<figure class="md-diagram-card">' +
          (spec.title ? '<figcaption class="md-diagram-title">' + esc(spec.title) + '</figcaption>' : '') +
          '<div class="md-diagram-stage">' + svg.join('') + '</div>' +
          (spec.caption ? '<figcaption class="md-diagram-caption">' + esc(spec.caption) + '</figcaption>' : '') +
        '</figure>'
      );
    } catch {
      return (
        '<div class="md-diagram-placeholder">' +
          '<div class="md-diagram-placeholder-title">Diagram could not be rendered</div>' +
          '<div class="md-diagram-placeholder-sub">The AI response included an invalid diagram block.</div>' +
        '</div>'
      );
    }
  }

  // Continuous 2D plot primitive — for things renderDiagram cannot represent
  // (stress-strain curves, characteristic curves, x/y data with marked
  // points). Schema accepts one or more polyline series in data coords +
  // optional named markers. We compute the data range, map to a 760×360
  // SVG box with margins for axes / labels.
  function renderPlot(raw: string): string {
    try {
      const spec = JSON.parse(raw) as {
        title?: string;
        caption?: string;
        xAxis?: { label?: string; min?: number; max?: number; unit?: string };
        yAxis?: { label?: string; min?: number; max?: number; unit?: string };
        series?: Array<{ label?: string; points?: Array<[number, number]>; dashed?: boolean }>;
        markers?: Array<{ x?: number; y?: number; label?: string }>;
      };
      const series = Array.isArray(spec.series)
        ? spec.series
            .map((s) => ({
              label: String(s.label || '').slice(0, 60),
              points: Array.isArray(s.points)
                ? s.points
                    .filter((p): p is [number, number] =>
                      Array.isArray(p) && p.length === 2 &&
                      Number.isFinite(p[0]) && Number.isFinite(p[1])
                    )
                    .slice(0, 200)
                : [],
              dashed: Boolean(s.dashed)
            }))
            .filter((s) => s.points.length >= 2)
            .slice(0, 6)
        : [];
      const markers = Array.isArray(spec.markers)
        ? spec.markers
            .filter((m) => Number.isFinite(m.x) && Number.isFinite(m.y))
            .slice(0, 12)
        : [];
      if (!series.length) throw new Error('empty plot');

      // Derive data range from series ∪ markers ∪ explicit axis hints. An
      // explicit min/max wins so callers can pin axes to nice round numbers.
      const allXs: number[] = [];
      const allYs: number[] = [];
      series.forEach((s) => s.points.forEach(([x, y]) => { allXs.push(x); allYs.push(y); }));
      markers.forEach((m) => { allXs.push(num(m.x, 0)); allYs.push(num(m.y, 0)); });
      const xMin = num(spec.xAxis?.min, Math.min(...allXs));
      const xMax = num(spec.xAxis?.max, Math.max(...allXs));
      const yMin = num(spec.yAxis?.min, Math.min(...allYs, 0));
      const yMax = num(spec.yAxis?.max, Math.max(...allYs));
      const xRange = xMax - xMin || 1;
      const yRange = yMax - yMin || 1;

      // SVG layout. 800×420 viewBox; plot area inset for axis labels.
      const W = 800, H = 420;
      const M = { top: 24, right: 24, bottom: 56, left: 72 };
      const plotW = W - M.left - M.right;
      const plotH = H - M.top - M.bottom;
      const sx = (x: number): number => M.left + ((x - xMin) / xRange) * plotW;
      const sy = (y: number): number => M.top + plotH - ((y - yMin) / yRange) * plotH;

      const xUnit = spec.xAxis?.unit ? ' [' + String(spec.xAxis.unit) + ']' : '';
      const yUnit = spec.yAxis?.unit ? ' [' + String(spec.yAxis.unit) + ']' : '';
      const xAxisLabel = String(spec.xAxis?.label || '') + xUnit;
      const yAxisLabel = String(spec.yAxis?.label || '') + yUnit;

      // 5-tick axis labelling. round to a sensible precision based on range.
      const fmt = (v: number, range: number): string => {
        if (range >= 100) return Math.round(v).toString();
        if (range >= 10) return v.toFixed(1);
        if (range >= 1) return v.toFixed(2);
        return v.toFixed(3);
      };
      const ticks = (lo: number, hi: number): number[] =>
        Array.from({ length: 5 }, (_, k) => lo + ((hi - lo) * k) / 4);
      const xTicks = ticks(xMin, xMax);
      const yTicks = ticks(yMin, yMax);

      const svg: string[] = [
        '<svg class="md-plot-svg" viewBox="0 0 ' + W + ' ' + H +
          '" role="img" aria-label="' + esc(spec.title || 'Plot') + '">',
        // Plot frame
        '<rect class="md-plot-frame" x="' + M.left + '" y="' + M.top +
          '" width="' + plotW + '" height="' + plotH + '"/>',
        // Grid + axis ticks
      ];
      xTicks.forEach((t) => {
        const x = sx(t);
        svg.push('<line class="md-plot-grid" x1="' + x + '" y1="' + M.top +
          '" x2="' + x + '" y2="' + (M.top + plotH) + '"/>');
        svg.push('<text class="md-plot-tick" x="' + x + '" y="' + (M.top + plotH + 18) +
          '" text-anchor="middle">' + esc(fmt(t, xRange)) + '</text>');
      });
      yTicks.forEach((t) => {
        const y = sy(t);
        svg.push('<line class="md-plot-grid" x1="' + M.left + '" y1="' + y +
          '" x2="' + (M.left + plotW) + '" y2="' + y + '"/>');
        svg.push('<text class="md-plot-tick" x="' + (M.left - 8) + '" y="' + (y + 4) +
          '" text-anchor="end">' + esc(fmt(t, yRange)) + '</text>');
      });
      // Axis labels
      svg.push('<text class="md-plot-axis-label" x="' + (M.left + plotW / 2) +
        '" y="' + (H - 14) + '" text-anchor="middle">' + esc(xAxisLabel) + '</text>');
      svg.push('<text class="md-plot-axis-label" x="' + (M.left / 2 - 8) +
        '" y="' + (M.top + plotH / 2) + '" text-anchor="middle" transform="rotate(-90 ' +
        (M.left / 2 - 8) + ',' + (M.top + plotH / 2) + ')">' + esc(yAxisLabel) + '</text>');

      // Series polylines. Distinct stroke colours per series via inline CSS variable.
      const colours = ['var(--plot-c1, #2563eb)', 'var(--plot-c2, #dc2626)', 'var(--plot-c3, #16a34a)',
                       'var(--plot-c4, #ea580c)', 'var(--plot-c5, #7c3aed)', 'var(--plot-c6, #0891b2)'];
      series.forEach((s, idx) => {
        const pts = s.points.map((p) => sx(p[0]) + ',' + sy(p[1])).join(' ');
        const dash = s.dashed ? ' stroke-dasharray="6 4"' : '';
        svg.push('<polyline class="md-plot-series" fill="none" stroke="' + colours[idx % colours.length] +
          '" stroke-width="2.4"' + dash + ' points="' + pts + '"/>');
      });

      // Markers — small dot + label offset above/right of the point.
      markers.forEach((m) => {
        const mx = sx(num(m.x, 0));
        const my = sy(num(m.y, 0));
        svg.push('<circle class="md-plot-marker" cx="' + mx + '" cy="' + my + '" r="4"/>');
        if (m.label) {
          svg.push('<text class="md-plot-marker-label" x="' + (mx + 8) + '" y="' + (my - 8) +
            '">' + esc(String(m.label).slice(0, 40)) + '</text>');
        }
      });

      // Series legend, when more than one series.
      if (series.length > 1) {
        let lx = M.left + 10;
        const ly = M.top + 14;
        series.forEach((s, idx) => {
          svg.push('<rect x="' + lx + '" y="' + (ly - 8) + '" width="14" height="3" fill="' +
            colours[idx % colours.length] + '"/>');
          svg.push('<text class="md-plot-legend" x="' + (lx + 18) + '" y="' + (ly + 2) + '">' +
            esc(s.label) + '</text>');
          lx += 18 + s.label.length * 6 + 14;
        });
      }

      svg.push('</svg>');

      return (
        '<figure class="md-diagram-card">' +
          (spec.title ? '<figcaption class="md-diagram-title">' + esc(spec.title) + '</figcaption>' : '') +
          '<div class="md-diagram-stage">' + svg.join('') + '</div>' +
          (spec.caption ? '<figcaption class="md-diagram-caption">' + esc(spec.caption) + '</figcaption>' : '') +
        '</figure>'
      );
    } catch {
      return (
        '<div class="md-diagram-placeholder">' +
          '<div class="md-diagram-placeholder-title">Plot could not be rendered</div>' +
          '<div class="md-diagram-placeholder-sub">The AI response included an invalid plot block.</div>' +
        '</div>'
      );
    }
  }

  function inline(s: string): string {
    // Stash already-rendered math (and code spans) under sentinel placeholders
    // BEFORE escaping, so their trusted HTML survives the esc() pass that
    // protects everything else from injecting raw HTML.
    const placeholders: string[] = [];
    const stash = (html: string): string => {
      const key = ' PH' + placeholders.length + ' ';
      placeholders.push(html);
      return key;
    };
    s = s.replace(/\\\(([^]*?)\\\)/g, (_, m: string) => stash(renderKatex(m, false)));
    s = s.replace(/\$\$([^]*?)\$\$/g, (_, m: string) => stash(renderKatex(m, true)));
    s = s.replace(/\$([^$\n]+?)\$/g, (_, m: string) => stash(renderKatex(m, false)));
    s = s.replace(/`([^`]+)`/g, (_, c: string) => stash('<code>' + esc(c) + '</code>'));

    // Now everything left is user/AI text. Escape it.
    s = esc(s);

    // Apply markdown emphasis on the escaped text — these patterns only need
    // to match ASCII markers, not HTML, so escaping doesn't break them.
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
    s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Restore the stashed math/code HTML.
    s = s.replace(/ PH(\d+) /g, (_, idx: string) => placeholders[Number(idx)] ?? '');
    return s;
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';

    if (/^\s*\\\[/.test(line)) {
      const mathLines: string[] = [];
      if (/\\\]/.test(line)) {
        mathLines.push(line.replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, ''));
      } else {
        i++;
        while (i < lines.length && !/\\\]/.test(lines[i] ?? '')) {
          mathLines.push(lines[i] ?? '');
          i++;
        }
        if (i < lines.length) mathLines.push((lines[i] ?? '').replace(/\\\]\s*$/, ''));
      }
      out.push('<div class="md-math-block">' + renderKatex(mathLines.join('\n'), true) + '</div>');
      i++;
      continue;
    }

    if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) {
      const mathLines2: string[] = [];
      i++;
      while (i < lines.length && !/\$\$/.test(lines[i] ?? '')) {
        mathLines2.push(lines[i] ?? '');
        i++;
      }
      if (i < lines.length) i++;
      out.push('<div class="md-math-block">' + renderKatex(mathLines2.join('\n'), true) + '</div>');
      continue;
    }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
        code.push(lines[i] ?? '');
        i++;
      }
      if (/^(minallo-diagram|diagram-json|diagram)$/i.test(lang)) {
        out.push(renderDiagram(code.join('\n')));
        i++;
        continue;
      }
      if (/^(minallo-plot|plot-json|plot)$/i.test(lang)) {
        out.push(renderPlot(code.join('\n')));
        i++;
        continue;
      }
      // Emit `class="language-X"` on <code> so highlight.js picks up the
      // language hint when present. Without a class, hljs auto-detects.
      const langClass = lang ? ' class="language-' + esc(lang) + '"' : '';
      const langName = prettyLang(lang);
      const codeIcon =
        '<svg class="md-code-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<polyline points="8 6 2 12 8 18"></polyline>' +
        '<polyline points="16 6 22 12 16 18"></polyline>' +
        '</svg>';
      const copyIcon =
        '<svg class="md-code-copy-icon" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
        '<path d="M5 15V5a2 2 0 0 1 2-2h10"></path>' +
        '</svg>';
      out.push(
        '<div class="md-code-block">' +
          '<div class="md-code-header">' +
            '<span class="md-code-lang-tag">' + codeIcon +
              '<span class="md-code-lang-name">' + esc(langName) + '</span>' +
            '</span>' +
            '<button type="button" class="md-code-copy" aria-label="Copy code">' +
              copyIcon +
            '</button>' +
          '</div>' +
          '<pre><code' + langClass + '>' + code.map(esc).join('\n') + '</code></pre>' +
        '</div>'
      );
      i++;
      continue;
    }

    const hm = line.match(/^(#{1,6}) (.+)/);
    if (hm && hm[1] && hm[2]) {
      const hlevel = Math.min(hm[1].length, 3);
      out.push('<h' + hlevel + ' class="md-h md-h' + hlevel + '">' + inline(hm[2]) + '</h' + hlevel + '>');
      i++;
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      out.push('<hr class="md-hr">');
      i++;
      continue;
    }

    if (/^> /.test(line)) {
      const bqLines: string[] = [];
      while (i < lines.length && /^> /.test(lines[i] ?? '')) {
        bqLines.push(inline((lines[i] ?? '').slice(2)));
        i++;
      }
      out.push('<blockquote class="md-bq">' + bqLines.join('<br>') + '</blockquote>');
      continue;
    }

    if (/^\d+\. /.test(line)) {
      const olItems: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
        olItems.push('<li>' + inline((lines[i] ?? '').replace(/^\d+\. /, '')) + '</li>');
        i++;
      }
      out.push('<ol class="md-ol">' + olItems.join('') + '</ol>');
      continue;
    }

    if (/^[•\-*] /.test(line)) {
      const ulItems: string[] = [];
      while (i < lines.length && /^[•\-*] /.test(lines[i] ?? '')) {
        ulItems.push('<li>' + inline((lines[i] ?? '').replace(/^[•\-*] /, '')) + '</li>');
        i++;
      }
      out.push('<ul class="md-ul">' + ulItems.join('') + '</ul>');
      continue;
    }

    if (line.trim() === '') {
      out.push('<div class="md-gap"></div>');
      i++;
      continue;
    }

    out.push('<p class="md-p">' + inline(line) + '</p>');
    i++;
  }

  return out.join('');
}
