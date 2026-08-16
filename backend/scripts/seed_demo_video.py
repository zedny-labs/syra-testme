"""Seed a demo VIDEO_SAVED proctoring event so the admin Proctoring tab has a
playable recording to preview.

Usage (from backend/ with venv active and DATABASE_URL set):
    PYTHONPATH=src python scripts/seed_demo_video.py <attempt_id> [--url URL] [--source camera|screen]

If <attempt_id> is omitted, seeds the most recent attempt for the exam owned by
the current admin ("mostafa@testme.com" by default).
"""
import argparse
import logging
import sys
import uuid
from datetime import datetime, timezone

from src.app.db.session import SessionLocal
from src.app.models import Attempt, ProctoringEvent, SeverityEnum, User

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(message)s")

DEFAULT_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"


def resolve_attempt(session, attempt_id: str | None, owner_email: str):
    if attempt_id:
        attempt = session.query(Attempt).filter(Attempt.id == uuid.UUID(attempt_id)).first()
        if not attempt:
            raise SystemExit(f"Attempt {attempt_id} not found")
        return attempt
    owner = session.query(User).filter(User.email == owner_email).first()
    if not owner:
        raise SystemExit(f"Owner {owner_email} not found; pass attempt_id explicitly")
    attempt = (
        session.query(Attempt)
        .join(Attempt.exam)
        .filter(Attempt.exam.has(created_by=owner.id))
        .order_by(Attempt.created_at.desc())
        .first()
    )
    if not attempt:
        raise SystemExit("No attempts found for owner; pass attempt_id explicitly")
    return attempt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("attempt_id", nargs="?", default=None)
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--source", choices=["camera", "screen"], default="camera")
    parser.add_argument("--owner-email", default="mostafa@testme.com")
    args = parser.parse_args()

    session = SessionLocal()
    try:
        attempt = resolve_attempt(session, args.attempt_id, args.owner_email)
        now = datetime.now(timezone.utc)
        meta = {
            "provider": "supabase",
            "playback_url": args.url,
            "url": args.url,
            "status": "ready",
            "ready_to_stream": True,
            "source": args.source,
            "size": 158008374,
            "duration": 596,
            "session_id": f"demo-seed-{uuid.uuid4().hex[:8]}",
            "name": "demo-recording.mp4",
            "created_at": now.isoformat(),
            "recording_started_at": now.isoformat(),
            "recording_stopped_at": now.isoformat(),
        }
        event = ProctoringEvent(
            attempt_id=attempt.id,
            event_type="VIDEO_SAVED",
            severity=SeverityEnum.LOW,
            meta=meta,
            occurred_at=now,
        )
        session.add(event)
        session.commit()
        logger.info("Seeded VIDEO_SAVED for attempt %s (source=%s)", attempt.id, args.source)
        logger.info("Playback URL: %s", args.url)
    finally:
        session.close()


if __name__ == "__main__":
    sys.exit(main())
