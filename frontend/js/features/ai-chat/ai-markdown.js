// Lightweight markdown → HTML renderer for AI message bubbles. Handles
// headings, code blocks, math (KaTeX), lists, blockquotes, inline emphasis.
export function renderMarkdown(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    function esc(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function scheduleKatex() {
        if (window._ssScheduleKatexRender)
            window._ssScheduleKatexRender();
    }
    function renderKatex(src, display) {
        if (!window.katex) {
            scheduleKatex();
            return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
        }
        try {
            return window.katex.renderToString(src, { displayMode: display, throwOnError: false });
        }
        catch {
            return display ? '\\[' + src + '\\]' : '\\(' + src + '\\)';
        }
    }
    function inline(s) {
        s = s.replace(/\\\(([^]*?)\\\)/g, (_, m) => renderKatex(m, false));
        s = s.replace(/\$\$([^]*?)\$\$/g, (_, m) => renderKatex(m, true));
        s = s.replace(/\$([^$\n]+?)\$/g, (_, m) => renderKatex(m, false));
        s = s.replace(/`([^`]+)`/g, (_, c) => '<code>' + esc(c) + '</code>');
        s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
        s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
        return s;
    }
    while (i < lines.length) {
        const line = lines[i] ?? '';
        if (/^\s*\\\[/.test(line)) {
            const mathLines = [];
            if (/\\\]/.test(line)) {
                mathLines.push(line.replace(/^\s*\\\[/, '').replace(/\\\]\s*$/, ''));
            }
            else {
                i++;
                while (i < lines.length && !/\\\]/.test(lines[i] ?? '')) {
                    mathLines.push(lines[i] ?? '');
                    i++;
                }
                if (i < lines.length)
                    mathLines.push((lines[i] ?? '').replace(/\\\]\s*$/, ''));
            }
            out.push('<div class="md-math-block">' + renderKatex(mathLines.join('\n'), true) + '</div>');
            i++;
            continue;
        }
        if (/^\s*\$\$/.test(line) && !/\$\$.*\$\$/.test(line)) {
            const mathLines2 = [];
            i++;
            while (i < lines.length && !/\$\$/.test(lines[i] ?? '')) {
                mathLines2.push(lines[i] ?? '');
                i++;
            }
            if (i < lines.length)
                i++;
            out.push('<div class="md-math-block">' + renderKatex(mathLines2.join('\n'), true) + '</div>');
            continue;
        }
        if (/^```/.test(line)) {
            const lang = line.slice(3).trim();
            const code = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i] ?? '')) {
                code.push(esc(lines[i] ?? ''));
                i++;
            }
            out.push('<div class="md-code-block">' +
                (lang ? '<div class="md-code-lang">' + esc(lang) + '</div>' : '') +
                '<pre><code>' + code.join('\n') + '</code></pre></div>');
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
            const bqLines = [];
            while (i < lines.length && /^> /.test(lines[i] ?? '')) {
                bqLines.push(inline((lines[i] ?? '').slice(2)));
                i++;
            }
            out.push('<blockquote class="md-bq">' + bqLines.join('<br>') + '</blockquote>');
            continue;
        }
        if (/^\d+\. /.test(line)) {
            const olItems = [];
            while (i < lines.length && /^\d+\. /.test(lines[i] ?? '')) {
                olItems.push('<li>' + inline((lines[i] ?? '').replace(/^\d+\. /, '')) + '</li>');
                i++;
            }
            out.push('<ol class="md-ol">' + olItems.join('') + '</ol>');
            continue;
        }
        if (/^[•\-*] /.test(line)) {
            const ulItems = [];
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
//# sourceMappingURL=ai-markdown.js.map