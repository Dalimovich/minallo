import { handler } from '../../../backend/functions/study-done-files';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
