// AI typing speed and render configuration.
// Change values here to tune all AI text animation across the app.

export interface AiTypingConfig {
  streamTokenInterval: number;
  streamCharsPerFrame: number;
  fallbackWordsPerFrame: number;
  fallbackFrameInterval: number;
  chatbotCharInterval: number;
  chatbotWordsPerFrame: number;
  chatbotFrameInterval: number;
  mathRenderTriggers: string[];
}

export const AI_TYPING: AiTypingConfig = {
  // Streaming path. Tokens are buffered, then revealed on animation frames.
  streamTokenInterval: 12,
  streamCharsPerFrame: 18,

  // Fallback path (non-streaming ai-ask endpoint).
  fallbackWordsPerFrame: 1,
  fallbackFrameInterval: 38,

  // Chatbot page typewriter.
  chatbotCharInterval: 6,
  chatbotWordsPerFrame: 4,
  chatbotFrameInterval: 6,

  // Progressive math rendering — re-render with markdown + KaTeX whenever
  // one of these tokens arrives.
  mathRenderTriggers: ['$', '\n', '##', '**', '- ', '> '],
};

window.AI_TYPING = AI_TYPING;
