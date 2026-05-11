import { generateStudyTool, courseHasRagDocs } from '../../services/ai-service.js';

export function closeAllOpts() {
  document.querySelectorAll('.chip-drawer').forEach(function (el) {
    el.classList.remove('open');
  });
}

// ─── Rendered output helpers ──────────────────────────────────────────────────

function _sourcesFooter(sources) {
  if (!sources || !sources.length) return '';
  return (
    '\n\n**Sources:** ' +
    sources
      .map(function (s) {
        return (
          s.file_name +
          (s.pages ? ', p.' + s.pages : '') +
          (s.section ? ' · *' + s.section + '*' : '')
        );
      })
      .join(' · ')
  );
}

function _renderFlashcards(items, sources) {
  if (!items || !items.length)
    return 'No flashcards could be generated from your course materials.';
  var md = '## Flashcards\n\n';
  items.forEach(function (card, i) {
    md += '**' + (i + 1) + '. ' + card.front + '**\n';
    md += card.back + '\n';
    if (card.source) md += '*(' + card.source + ')*\n';
    md += '\n';
  });
  return md + _sourcesFooter(sources);
}

function _renderQuiz(items, sources) {
  if (!items || !items.length)
    return 'No quiz questions could be generated from your course materials.';
  var md = '## Quiz\n\n';
  items.forEach(function (q, i) {
    md += '**' + (i + 1) + '. ' + q.question + '**\n';
    var opts = q.options || {};
    ['A', 'B', 'C', 'D'].forEach(function (k) {
      if (opts[k]) {
        var marker = k === q.answer ? '✅ ' : '';
        md += marker + k + '. ' + opts[k] + '\n';
      }
    });
    if (q.explanation) md += '\n*' + q.explanation + '*\n';
    md += '\n';
  });
  return md + _sourcesFooter(sources);
}

function _renderSummary(text, sources) {
  return (text || 'No summary could be generated.') + _sourcesFooter(sources);
}

// ─── RAG-powered generate (falls back to text prompt when no docs) ────────────

var _TOOL_LABELS = {
  flashcards: '🃏 Generate flashcards',
  quiz: '📝 Quiz me',
  summary: '✨ Summarise'
};

var _ragAborted = false;

function _ragSetGenerating(on) {
  var btn = document.getElementById('aiSend');
  if (!btn) return;
  if (on) {
    _ragAborted = false;
    btn.disabled = false; // keep clickable so stop works
    btn.classList.add('is-stop');
    btn._ragStopHandler = function () {
      if (!btn.classList.contains('is-stop')) return;
      _ragAborted = true;
      _ragSetGenerating(false);
      document.querySelectorAll('.typing-wrap').forEach(function (el) { el.remove(); });
    };
    btn.addEventListener('click', btn._ragStopHandler);
  } else {
    btn.classList.remove('is-stop');
    btn.disabled = false;
    if (btn._ragStopHandler) {
      btn.removeEventListener('click', btn._ragStopHandler);
      btn._ragStopHandler = null;
    }
  }
}

async function _generateWithRag(tool, level, topic) {
  var courseId = window.activeCourseId || window.currentCourseId || '';
  if (!courseId) return false;
  var hasRag = await courseHasRagDocs(courseId).catch(function () {
    return false;
  });
  if (!hasRag) return false;

  // Show user message bubble and lock the send button
  var label = _TOOL_LABELS[tool] || tool;
  if (level && (tool === 'quiz' || tool === 'summary')) label += ' (' + level + ')';
  if (window.addUserMsg) window.addUserMsg(label);
  _ragSetGenerating(true);

  // Show typing indicator while generating
  if (window.addTyping) window.addTyping();

  try {
    var countMap = { easy: 5, medium: 6, hard: 8 };
    var result = await generateStudyTool(courseId, tool, {
      count: countMap[level] || 8,
      difficulty: level,
      topic: topic || null
    });

    var md = '';
    if (tool === 'flashcards') md = _renderFlashcards(result.items, result.sources);
    else if (tool === 'quiz') md = _renderQuiz(result.items, result.sources);
    else md = _renderSummary(result.text, result.sources);

    if (result.error) md = '⚠️ ' + result.error;

    // Remove typing indicator and add the bot message (unless user stopped)
    document.querySelectorAll('.typing-wrap').forEach(function (el) {
      el.remove();
    });
    _ragSetGenerating(false);
    if (!_ragAborted && window.addBotMsg) window.addBotMsg(md);
    return !_ragAborted;
  } catch (e) {
    document.querySelectorAll('.typing-wrap').forEach(function (el) {
      el.remove();
    });
    _ragSetGenerating(false);
    return false;
  }
}

export function chipPrompt(type, level) {
  var pdfFullText = window.pdfFullText || '';
  var activeFileName = window.activeFileName || '';
  var hasDoc = !!pdfFullText;
  var base = hasDoc
    ? 'Using ONLY the content of the document "' +
      activeFileName +
      '" provided in the system prompt, '
    : 'As a knowledgeable tutor, ';
  if (!hasDoc && window.addBotMsg && window._t) window.addBotMsg(window._t('ai_tip_no_pdf'));

  var prompts = {
    summarise: {
      small:
        base +
        'give me a SHORT summary of the document in exactly 3 bullet points. Each bullet must be one sentence only. No intro, no outro, just the 3 bullets.',
      medium:
        base +
        'give me a MEDIUM summary of the document. Structure it with: ## 📝 Overview (3-4 sentences), ## 🔑 Main Topics (bullet points), ## 💡 Key Takeaways (3-5 points).',
      thorough:
        base +
        'give me a THOROUGH and detailed summary of the entire document. Cover every section in depth. Structure it with: ## 📝 Overview, ## 🔑 Main Topics (with sub-points for each), ## 🔢 Formulas Mentioned, ## 💡 Key Takeaways, ## 📌 Things to Remember for the Exam.'
    },
    formulas:
      base +
      'extract and explain every formula, equation and mathematical expression in the document. For each one: show the formula, define every symbol, and give a brief explanation of what it calculates.',
    quiz: {
      easy:
        base +
        'create an EASY quiz of 6 questions based on the document. Focus on basic definitions and straightforward facts. After each question provide the answer with a simple explanation.',
      medium:
        base +
        'create a MEDIUM difficulty quiz of 8 questions based on the document. Mix multiple choice and open questions requiring understanding. After each question provide the answer and explanation.',
      hard:
        base +
        'create a HARD quiz of 10 challenging questions based on the document. Include calculation problems, tricky concepts, and application questions. After each question provide a detailed answer and explanation.'
    },
    keyideas:
      base +
      'identify and explain the 8-10 most important concepts and key ideas from the document. For each concept give a clear definition and explain why it matters.',
    analogy:
      base +
      'explain the main concepts from the document using simple real-world analogies that an engineering student would understand easily. Make each analogy vivid and memorable.'
  };

  var prompt = typeof prompts[type] === 'object' ? prompts[type][level || 'medium'] : prompts[type];
  closeAllOpts();

  // For quiz and summarise, try the RAG generate endpoint first
  if (type === 'quiz' || type === 'summarise') {
    var ragTool = type === 'summarise' ? 'summary' : 'quiz';
    _generateWithRag(ragTool, level || 'medium').then(function (used) {
      if (!used && window.askAI) window.askAI(prompt);
    });
    return;
  }

  if (window.askAI) window.askAI(prompt);
}

export function initChipListeners() {
  (
    document.getElementById('chip-summarise') || { addEventListener: function () {} }
  ).addEventListener('click', function () {
    closeAllOpts();
    var opts = document.getElementById('opts-summarise');
    if (opts) opts.classList.toggle('open');
  });
  (document.getElementById('chip-quiz') || { addEventListener: function () {} }).addEventListener(
    'click',
    function () {
      closeAllOpts();
      var opts = document.getElementById('opts-quiz');
      if (opts) opts.classList.toggle('open');
    }
  );
  (
    document.getElementById('chip-formulas') || { addEventListener: function () {} }
  ).addEventListener('click', function () {
    closeAllOpts();
    chipPrompt('formulas');
  });
  (
    document.getElementById('chip-keyideas') || { addEventListener: function () {} }
  ).addEventListener('click', function () {
    closeAllOpts();
    chipPrompt('keyideas');
  });
  (
    document.getElementById('chip-analogy') || { addEventListener: function () {} }
  ).addEventListener('click', function () {
    closeAllOpts();
    chipPrompt('analogy');
  });

  (
    document.getElementById('chip-flashcards') || { addEventListener: function () {} }
  ).addEventListener('click', function () {
    closeAllOpts();
    _generateWithRag('flashcards', 'medium').then(function (used) {
      if (!used && window.askAI)
        window.askAI(
          'Create 8 flashcards from the key concepts in this document. Format each as Q: [question] A: [answer].'
        );
    });
  });

  document.querySelectorAll('.chip-sub').forEach(function (opt) {
    opt.addEventListener('click', function () {
      chipPrompt(opt.getAttribute('data-type'), opt.getAttribute('data-level'));
    });
  });
}
