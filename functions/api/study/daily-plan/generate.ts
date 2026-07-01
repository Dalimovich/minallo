import { handler } from '../../../../backend/functions/study-daily-plan-generate';
import { pagesAdapter } from '../../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
