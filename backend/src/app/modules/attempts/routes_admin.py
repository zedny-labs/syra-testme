from fastapi import APIRouter, Depends

from ...api.deps import get_db_dep, require_permission
from ...models import Attempt, RoleEnum, User
from ...schemas import Message
from sqlalchemy.orm import Session

router = APIRouter()


@router.delete("/purge", response_model=Message)
def purge_all_attempts(
    db: Session = Depends(get_db_dep),
    current: User = Depends(require_permission("View Attempt Analysis", RoleEnum.ADMIN)),
) -> Message:
    """Admin-only: delete ALL attempt records (and cascaded proctoring/answer data).
    Used for test environment cleanup. Protected by ADMIN role + permission check."""
    deleted = db.query(Attempt).delete(synchronize_session=False)
    db.commit()
    return Message(message=f"Deleted {deleted} attempt(s)")
