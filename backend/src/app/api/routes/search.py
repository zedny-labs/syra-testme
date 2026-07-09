from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import or_, select
from sqlalchemy.orm import Session, joinedload

from ...models import Attempt, Exam, ExamStatus, RoleEnum, Schedule, User
from ...services.normalized_relations import is_exam_pool_library
from ...core.i18n import translate as _t
from ..deps import get_current_user, get_db_dep, learner_can_access_exam, load_permission_rows, permission_allowed

router = APIRouter()


def _is_pool_library_exam(exam: Exam) -> bool:
    return is_exam_pool_library(exam)


@router.get("/")
def search(q: str, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    query = q.strip().lower()
    if not query:
        raise HTTPException(status_code=400, detail=_t("search_query_required"))
    rows = load_permission_rows(db)
    can_edit_tests = permission_allowed(rows, current.role, "Edit Tests")
    can_view_attempt_analysis = permission_allowed(rows, current.role, "View Attempt Analysis")
    can_manage_users = permission_allowed(rows, current.role, "Manage Users")

    like_pattern = f"%{query}%"

    exams = []
    if current.role == RoleEnum.LEARNER:
        exam_query = select(Exam).where(
            Exam.title.ilike(like_pattern),
            Exam.status == ExamStatus.OPEN,
        )
        exams = [
            exam
            for exam in db.scalars(exam_query).all()
            if not _is_pool_library_exam(exam) and learner_can_access_exam(db, exam, current)
        ]
    elif can_edit_tests:
        exam_query = select(Exam).where(
            Exam.title.ilike(like_pattern),
            Exam.created_by_id == current.id,
        )
        exams = [exam for exam in db.scalars(exam_query).all() if not _is_pool_library_exam(exam)]

    attempts = []
    attempt_query = (
        select(Attempt)
        .join(Exam, Attempt.exam_id == Exam.id, isouter=True)
        .join(User, Attempt.user_id == User.id, isouter=True)
        .options(joinedload(Attempt.exam), joinedload(Attempt.user))
        .where(
            or_(
                Exam.title.ilike(like_pattern),
                User.name.ilike(like_pattern),
            )
        )
    )
    if current.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR} and can_view_attempt_analysis:
        attempt_query = attempt_query.where(Exam.created_by_id == current.id)
        attempts = db.execute(attempt_query).unique().scalars().all()
    else:
        attempt_query = attempt_query.where(Attempt.user_id == current.id)
        attempts = db.execute(attempt_query).unique().scalars().all()

    users = []
    if current.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR} and can_manage_users:
        actor_exam_ids = select(Exam.id).where(Exam.created_by_id == current.id)
        users = db.scalars(
            select(User).where(
                (User.name.ilike(like_pattern))
                | (User.email.ilike(like_pattern))
                | (User.user_id.ilike(like_pattern))
            ).where(
                or_(
                    User.created_by_id == current.id,
                    User.id.in_(
                        select(Attempt.user_id).where(Attempt.exam_id.in_(actor_exam_ids))
                    ),
                    User.id.in_(
                        select(Schedule.user_id).where(Schedule.exam_id.in_(actor_exam_ids))
                    ),
                )
            )
        ).all()

    return {
        "exams": [{"id": e.id, "title": e.title, "status": e.status} for e in exams],
        "attempts": [
            {
                "id": a.id,
                "test_title": a.exam.title if a.exam else None,
                "exam_title": a.exam.title if a.exam else None,
                "user_name": a.user.name if a.user else None,
            }
            for a in attempts
        ],
        "users": [{"id": u.id, "name": u.name, "email": u.email, "user_id": u.user_id} for u in users],
    }
