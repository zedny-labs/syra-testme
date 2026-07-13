import pytest

from app.core.config import Settings

BASE = {"JWT_SECRET": "x" * 32}


def _settings(monkeypatch=None, **overrides):
    # Isolate from any ambient VIMEO_* / provider env vars and the real .env file.
    if monkeypatch is not None:
        for key in (
            "VIMEO_ACCESS_TOKEN",
            "VIMEO_FOLDER_ID",
            "VIMEO_PRIVACY_VIEW",
            "VIMEO_EMBED_DOMAIN",
            "PROCTORING_VIDEO_STORAGE_PROVIDER",
        ):
            monkeypatch.delenv(key, raising=False)
    return Settings(_env_file=None, **{**BASE, **overrides})


def test_provider_accepts_vimeo():
    s = _settings(PROCTORING_VIDEO_STORAGE_PROVIDER="vimeo")
    assert s.PROCTORING_VIDEO_STORAGE_PROVIDER == "vimeo"


def test_provider_normalizes_case_and_whitespace():
    s = _settings(PROCTORING_VIDEO_STORAGE_PROVIDER="  VIMEO ")
    assert s.PROCTORING_VIDEO_STORAGE_PROVIDER == "vimeo"


def test_provider_still_accepts_cloudflare_and_supabase():
    assert _settings(PROCTORING_VIDEO_STORAGE_PROVIDER="cloudflare").PROCTORING_VIDEO_STORAGE_PROVIDER == "cloudflare"
    assert _settings(PROCTORING_VIDEO_STORAGE_PROVIDER="supabase").PROCTORING_VIDEO_STORAGE_PROVIDER == "supabase"


def test_provider_rejects_unknown():
    with pytest.raises(ValueError):
        _settings(PROCTORING_VIDEO_STORAGE_PROVIDER="youtube")


def test_vimeo_settings_defaults(monkeypatch):
    s = _settings(monkeypatch)
    assert s.VIMEO_ACCESS_TOKEN == ""
    assert s.VIMEO_FOLDER_ID is None
    assert s.VIMEO_PRIVACY_VIEW == "unlisted"
    assert s.VIMEO_EMBED_DOMAIN is None


def test_vimeo_privacy_view_normalized(monkeypatch):
    s = _settings(monkeypatch, VIMEO_PRIVACY_VIEW="  Unlisted ")
    assert s.VIMEO_PRIVACY_VIEW == "unlisted"
