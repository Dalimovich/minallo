import { handler } from '../../../backend/functions/study-course-settings';
import { pagesAdapter } from '../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
