import { handler } from '../../../backend/functions/study-flashcard-review';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
