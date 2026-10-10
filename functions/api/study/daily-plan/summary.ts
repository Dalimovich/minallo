import { handler } from '../../../../backend/functions/study-daily-plan-summary';
import { pagesAdapter } from '../../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
