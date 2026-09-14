// AUTO-GENERATED-style Cloudflare Pages adapter for the feedback endpoint.
import { handler } from '../../backend/functions/feedback';
import { pagesAdapter } from '../../backend/lib/pages-adapter';

export const onRequest = pagesAdapter(handler);
