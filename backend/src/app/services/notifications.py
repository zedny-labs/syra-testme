import logging

from sqlalchemy.orm import Session

from ..models import Notification

logger = logging.getLogger(__name__)


def notify_user(db: Session, user_id, title: str, message: str, link: str = None):
    try:
        db.begin_nested()
        notif = Notification(user_id=user_id, title=title, message=message, link=link)
        db.add(notif)
        db.flush()
        return True
    except Exception as exc:
        logger.warning("Notification persist failed for user %s: %s", user_id, exc)
        return False


def notify_proctoring_event(db: Session, attempt_id, event: dict):
    from ..models import Attempt
    try:
        attempt = db.get(Attempt, attempt_id)
        if not attempt:
            return False
        return notify_user(
            db,
            attempt.user_id,
            title=f"Proctoring Alert: {event.get('event_type', 'Unknown')}",
            message=event.get("detail", "A proctoring event was detected."),
            link=f"/attempt-result/{attempt_id}",
        )
    except Exception as exc:
        db.rollback()
        logger.warning("Failed to persist proctoring notification for attempt %s: %s", attempt_id, exc)
        return False
