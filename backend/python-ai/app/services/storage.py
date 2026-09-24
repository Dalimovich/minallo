"""Download files from Supabase Storage.

Uses the service-role client, so RLS is bypassed. The caller is responsible
for verifying the requesting user owns the document (Phase 2's indexer
loads the document row from `documents` and trusts user_id from there).
"""

from ..config import get_settings
from ..supabase_client import get_supabase


# Known buckets that may appear as the optional "<bucket>:<path>" prefix
# in documents.storage_path. Older rows were saved with this prefix while
# newer ones (see backend/functions/documents-upload.js) store a plain path
# and rely on the bucket coming from the RAG_STORAGE_BUCKET env var.
_KNOWN_BUCKETS = {"course-uploads", "course-documents", "chat-attachments", "generated-audio", "generated-video"}


def _resolve_bucket_and_path(storage_path: str, default_bucket: str) -> tuple[str, str]:
    """Split `<bucket>:<path>` if present, else use the default bucket."""
    if ":" in storage_path:
        head, rest = storage_path.split(":", 1)
        if head in _KNOWN_BUCKETS and rest:
            return head, rest
    return default_bucket, storage_path


def download_document_bytes(storage_path: str, bucket: str | None = None) -> bytes:
    """Return raw PDF bytes for a document at the given storage path.

    storage_path is what's stored in `documents.storage_path` — typically
    `<user_id>/<course_id>/<file_name>`. We pass it through verbatim.
    """
    if not storage_path:
        raise ValueError("storage_path is required")

    sb = get_supabase()
    default_bucket = bucket or get_settings().rag_storage_bucket
    resolved_bucket, resolved_path = _resolve_bucket_and_path(storage_path, default_bucket)
    return sb.storage.from_(resolved_bucket).download(resolved_path)


def upload_generated_audio(path: str, wav_bytes: bytes, *, bucket: str | None = None) -> str:
    """Store generated Hören TTS audio and return its storage_path.

    Content-addressed by the caller (see services/tts_cache.py — path is
    derived from the same sha256 text hash used as the cache key), so a
    repeat upload of identical content just overwrites the same object
    rather than accumulating duplicates.
    """
    if not path:
        raise ValueError("path is required")
    sb = get_supabase()
    target_bucket = bucket or get_settings().tts_audio_bucket
    sb.storage.from_(target_bucket).upload(
        path,
        wav_bytes,
        file_options={"content-type": "audio/wav", "upsert": "true"},
    )
    return f"{target_bucket}:{path}"


def signed_audio_url(storage_path: str, *, expires_in: int = 3600) -> str:
    """Short-lived signed URL for a generated-audio object (private bucket)."""
    bucket, resolved_path = _resolve_bucket_and_path(storage_path, get_settings().tts_audio_bucket)
    sb = get_supabase()
    result = sb.storage.from_(bucket).create_signed_url(resolved_path, expires_in)
    return result.get("signedURL") or result.get("signed_url") or ""


# Video assets are supplied by an acquisition step, never generated here. Only these
# container types are accepted so the media renderer can play what is stored.
ALLOWED_VIDEO_CONTENT_TYPES = frozenset({"video/mp4", "video/webm"})
MAX_VIDEO_BYTES = 200 * 1024 * 1024


def upload_exam_video(path: str, video_bytes: bytes, content_type: str, *, bucket: str | None = None) -> str:
    """Store an exam video asset and return its `<bucket>:<path>` storage_path."""
    if not path or path.startswith("/") or ".." in path.split("/"):
        raise ValueError("a relative, non-traversing path is required")
    if content_type not in ALLOWED_VIDEO_CONTENT_TYPES:
        raise ValueError(f"unsupported video content type {content_type!r}")
    if not video_bytes or len(video_bytes) > MAX_VIDEO_BYTES:
        raise ValueError("video is empty or exceeds the size limit")
    sb = get_supabase()
    target_bucket = bucket or get_settings().exam_video_bucket
    sb.storage.from_(target_bucket).upload(
        path, video_bytes, file_options={"content-type": content_type, "upsert": "true"},
    )
    return f"{target_bucket}:{path}"


def signed_video_url(storage_path: str, *, expires_in: int = 3600) -> str:
    """Short-lived signed https URL for an exam video (private bucket)."""
    bucket, resolved_path = _resolve_bucket_and_path(storage_path, get_settings().exam_video_bucket)
    sb = get_supabase()
    result = sb.storage.from_(bucket).create_signed_url(resolved_path, expires_in)
    url = result.get("signedURL") or result.get("signed_url") or ""
    if not url.startswith("https://"):
        raise ValueError("storage did not return a secure signed URL")
    return url
