import { generateStudyTool, courseHasRagDocs } from '../../services/ai-service.js';

export function closeAllOpts(): void {
  document.querySelectorAll('.chip-drawer').forEach((el) => {
    el.classList.remove('open');
  });
}

interface RagSource {
  file_name?: string;
  pages?: string | null;
  section?: string | null;
}

interface QuizItem {
  question: string;
  options?: Record<string, string>;
  answer?: string;
  explanation?: string;
}

interface FlashcardItem {
  front: string;
  back: string;
  source?: string;
}

interface GenerateResult {
  items?: QuizItem[] & FlashcardItem[];
  text?: string;
  sources?: RagSource[];
  error?: string;
}

function _sourcesFooter(sources?: RagSource[]): string {
  if (!sources || !sources.length) return '';
  return (
    '\n\n**Sources:** ' +
    sources
      .map((s) =>
        (s.file_name || '') +
        (s.pages ? ', p.' + s.pages : '') +
        (s.section ? ' · *' + s.section + '*' : '')
      )
      .join(' · ')
  );
}

function _renderFlashcards(items: FlashcardItem[] | undefined, sources?: RagSource[]): string {
  if (!items || !items.length) {
    return 'No flashcards could be generated from your course materials.';
  }
  let md = '## Flashcards\n\n';
  items.forEach((card, i) => {
    md += '**' + (i + 1) + '. ' + card.front + '**\n';
    md += card.back + '\n';
    if (card.source) md += '*(' + card.source + ')*\n';
    md += '\n';
  });
  return md + _sourcesFooter(sources);
}

function _renderQuiz(items: QuizItem[] | undefined, sources?: RagSource[]): string {
  if (!items || !items.length) {
    return 'No quiz questions could be generated from your course materials.';
  }
  let md = '## Quiz\n\n';
  items.forEach((q, i) => {
    md += '**' + (i + 1) + '. ' + q.question + '**\n';
    const opts = q.options || {};
    (['A', 'B', 'C', 'D'] as const).forEach((k) => {
      const choice = opts[k];
      if (choice) {
        const marker = k === q.answer ? '✅ ' : '';
        md += marker + k + '. ' + choice + '\n';
      }
    });
    if (q.explanation) md += '\n*' + q.explanation + '*\n';
    md += '\n';
  });
  return md + _sourcesFooter(sources);
}

function _renderSummary(text: string | undefined, sources?: RagSource[]): string {
  return (text || 'No summary could be generated.') + _sourcesFooter(sources);
}

const _TOOL_LABELS: Record<string, string> = {
  flashcards: '🃏 Generate flashcards',
  quiz: '📝 Quiz me',
  summary: '✨ Summarise',
};

interface SendButton extends HTMLButtonElement {
  _ragStopHandler?: (() => void) | null;
}

let _ragAborted = false;

function _ragSetGenerating(on: boolean): void {
  const btn = document.getElementById('aiSend') as SendButton | null;
  if (!btn) return;
  if (on) {
    _ragAborted = false;
    btn.disabled = false; // keep clickable so stop works
    btn.classList.add('is-stop');
    btn._ragStopHandler = () => {
      if (!btn.classList.contains('is-stop')) return;
      _ragAborted = true;
      _ragSetGenerating(false);
      document.querySelectorAll('.typing-wrap').forEach((el) => el.remove());
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

async function _generateWithRag(tool: string, level?: string, topic?: string): Promise<boolean> {
  const courseId = window.activeCourseId || window.currentCourseId || '';
  if (!courseId) return false;
  const hasRag = await courseHasRagDocs(courseId).catch(() => false);
  if (!hasRag) return false;

  let label = _TOOL_LABELS[tool] || tool;
  if (level && (tool === 'quiz' || tool === 'summary')) label += ' (' + level + ')';
  if (window.addUserMsg) window.addUserMsg(label);
  _ragSetGenerating(true);

  if (window.addTyping) window.addTyping();

  try {
    const countMap: Record<string, number> = { easy: 5, medium: 6, hard: 8 };
    const result = (await generateStudyTool(courseId, tool as 'flashcards' | 'quiz' | 'summary', {
      count: countMap[level || ''] || 8,
      difficulty: level as 'easy' | 'medium' | 'hard' | 'mixed' | undefined,
      topic: topic || null,
    } as Parameters<typeof generateStudyTool>[2])) as GenerateResult;

    let md: string;
    if (tool === 'flashcards') md = _renderFlashcards(result.items, result.sources);
    else if (tool === 'quiz') md = _renderQuiz(result.items, result.sources);
    else md = _renderSummary(result.text, result.sources);

    if (result.error) md = '⚠️ ' + result.error;

    document.querySelectorAll('.typing-wrap').forEach((el) => el.remove());
    _ragSetGenerating(false);
    if (!_ragAborted && window.addBotMsg) window.addBotMsg(md);
    return !_ragAborted;
  } catch {
    document.querySelectorAll('.typing-wrap').forEach((el) => el.remove());
    _ragSetGenerating(false);
    return false;
  }
}

const prompts = {
  summarise: {
    short: 'give me a SHORT summary',
    medium: 'give me a MEDIUM summary',
    thorough: 'give me a THOROUGH summary',
  },
} as const;

export function chipPrompt(type: string, level?: string): void {
  const pdfFullText = window.pdfFullText || '';
  const activeFileName = window.activeFileName || '';
  const hasDoc = !!pdfFullText;
  const base = hasDoc
    ? 'Using ONLY the content of the document "' + activeFileName + '" provided in the system prompt, '
    : 'As a knowledgeable tutor, ';
  if (!hasDoc && window.addBotMsg && window._t) window.addBotMsg(window._t('ai_tip_no_pdf'));

  const promptMap: Record<string, string | Record<string, string>> = {
    summarise: {
      small:
        base +
        'give me a SHORT summary of the document in exactly 3 bullet points. Each bullet must be one sentence only. No intro, no outro, just the 3 bullets.',
      medium:
        base +
        'give me a MEDIUM summary of the document. Structure it with: ## 📝 Overview (3-4 sentences), ## 🔑 Main Topics (bullet points), ## 💡 Key Takeaways (3-5 points).',
      thorough:
        base +
        'give me a THOROUGH and detailed summary of the entire document. Cover every section in depth. Structure it with: ## 📝 Overview, ## 🔑 Main Topics (with sub-points for each), ## 🔢 Formulas Mentioned, ## 💡 Key Takeaways, ## 📌 Things to Remember for the Exam.',
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
        'create a HARD quiz of 10 challenging questions based on the document. Include calculation problems, tricky concepts, and application questions. After each question provide a detailed answer and explanation.',
    },
    keyideas:
      base +
      'identify and explain the 8-10 most important concepts and key ideas from the document. For each concept give a clear definition and explain why it matters.',
    analogy:
      base +
      'explain the main concepts from the document using simple real-world analogies that an engineering student would understand easily. Make each analogy vivid and memorable.',
  };

  const entry = promptMap[type];
  const prompt = typeof entry === 'object' ? entry[level || 'medium'] || '' : (entry || '');
  closeAllOpts();

  // For quiz and summarise, try the RAG generate endpoint first
  if (type === 'quiz' || type === 'summarise') {
    const ragTool = type === 'summarise' ? 'summary' : 'quiz';
    _generateWithRag(ragTool, level || 'medium').then((used) => {
      if (!used && window.askAI) window.askAI(prompt);
    });
    return;
  }

  if (window.askAI) window.askAI(prompt);
}

void prompts; // kept for type narrowing if needed later

export function initChipListeners(): void {
  document.getElementById('chip-summarise')?.addEventListener('click', () => {
    closeAllOpts();
    document.getElementById('opts-summarise')?.classList.toggle('open');
  });
  document.getElementById('chip-quiz')?.addEventListener('click', () => {
    closeAllOpts();
    document.getElementById('opts-quiz')?.classList.toggle('open');
  });
  document.getElementById('chip-formulas')?.addEventListener('click', () => {
    closeAllOpts();
    chipPrompt('formulas');
  });
  document.getElementById('chip-keyideas')?.addEventListener('click', () => {
    closeAllOpts();
    chipPrompt('keyideas');
  });
  document.getElementById('chip-analogy')?.addEventListener('click', () => {
    closeAllOpts();
    chipPrompt('analogy');
  });
  document.getElementById('chip-flashcards')?.addEventListener('click', () => {
    closeAllOpts();
    _generateWithRag('flashcards', 'medium').then((used) => {
      if (!used && window.askAI) {
        window.askAI(
          'Create 8 flashcards from the key concepts in this document. Format each as Q: [question] A: [answer].'
        );
      }
    });
  });
  document.querySelectorAll<HTMLElement>('.chip-sub').forEach((opt) => {
    opt.addEventListener('click', () => {
      chipPrompt(opt.getAttribute('data-type') || '', opt.getAttribute('data-level') || undefined);
    });
  });
}
