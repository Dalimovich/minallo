import { handler } from '../../../../backend/functions/study-task';
import { pagesAdapter } from '../../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
