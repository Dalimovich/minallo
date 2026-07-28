import { handler } from '../../../backend/functions/study-preferences';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
