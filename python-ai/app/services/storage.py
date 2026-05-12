"""Download files from Supabase Storage.

Uses the service-role client, so RLS is bypassed. The caller is responsible
for verifying the requesting user owns the document (Phase 2's indexer
loads the document row from `documents` and trusts user_id from there).
"""

from ..config import get_settings
from ..supabase_client import get_supabase


def download_document_bytes(storage_path: str, bucket: str | None = None) -> bytes:
    """Return raw PDF bytes for a document at the given storage path.

    storage_path is what's stored in `documents.storage_path` — typically
    `<user_id>/<course_id>/<file_name>`. We pass it through verbatim.
    """
    if not storage_path:
        raise ValueError("storage_path is required")

    sb = get_supabase()
    target_bucket = bucket or get_settings().rag_storage_bucket
    return sb.storage.from_(target_bucket).download(storage_path)
