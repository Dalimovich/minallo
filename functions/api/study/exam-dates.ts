import { handler } from '../../../backend/functions/study-exam-dates';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
