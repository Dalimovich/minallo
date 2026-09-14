import { handler } from '../../../../backend/functions/study-daily-plan-adjust';
import { pagesAdapter } from '../../../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
