import { handler } from '../../../backend/functions/study-possible-match';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
