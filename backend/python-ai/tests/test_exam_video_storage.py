"""Exam video storage infrastructure. Fake Supabase client only: no network, no video is generated."""
import pytest

from app.services import storage


class _Bucket:
    def __init__(self, log, signed):
        self.log, self.signed = log, signed

    def upload(self, path, data, file_options=None):
        self.log.append((path, len(data), file_options))

    def create_signed_url(self, path, expires_in):
        return {"signedURL": self.signed}


class _SB:
    def __init__(self, signed="https://x.supabase.co/sign/v.mp4?t=1"):
        self.log, self.signed = [], signed
        self.storage = self

    def from_(self, bucket):
        self.log.append(("bucket", bucket))
        return _Bucket(self.log, self.signed)


@pytest.fixture()
def sb(monkeypatch):
    fake = _SB()
    monkeypatch.setattr(storage, "get_supabase", lambda: fake)
    return fake


def test_upload_returns_bucket_prefixed_path_and_sets_content_type(sb):
    assert storage.upload_exam_video("testdaf/h4/a.mp4", b"x", "video/mp4") == "generated-video:testdaf/h4/a.mp4"
    assert ("bucket", "generated-video") in sb.log
    assert sb.log[-1][2]["content-type"] == "video/mp4"


@pytest.mark.parametrize("path", ["", "/abs.mp4", "../escape.mp4", "a/../../b.mp4"])
def test_upload_rejects_unsafe_paths(sb, path):
    with pytest.raises(ValueError):
        storage.upload_exam_video(path, b"x", "video/mp4")


def test_upload_rejects_wrong_type_empty_and_oversize(sb, monkeypatch):
    with pytest.raises(ValueError):
        storage.upload_exam_video("a.avi", b"x", "video/x-msvideo")
    with pytest.raises(ValueError):
        storage.upload_exam_video("a.mp4", b"", "video/mp4")
    monkeypatch.setattr(storage, "MAX_VIDEO_BYTES", 3)
    with pytest.raises(ValueError):
        storage.upload_exam_video("a.mp4", b"1234", "video/mp4")
    assert not [e for e in sb.log if e[0] != "bucket"]


def test_signed_url_must_be_https(monkeypatch):
    monkeypatch.setattr(storage, "get_supabase", lambda: _SB(signed="http://insecure/x"))
    with pytest.raises(ValueError):
        storage.signed_video_url("generated-video:a.mp4")
    monkeypatch.setattr(storage, "get_supabase", lambda: _SB())
    assert storage.signed_video_url("generated-video:a.mp4").startswith("https://")


def test_video_bucket_resolves_and_is_a_known_bucket():
    assert storage._resolve_bucket_and_path("generated-video:a/b.mp4", "x") == ("generated-video", "a/b.mp4")
