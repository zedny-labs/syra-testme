import uuid
from datetime import datetime, timezone
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...core.config import get_settings
from ...models import Question, Exam, ExamStatus, RoleEnum
from ...schemas import QuestionCreate, QuestionRead, QuestionBase, Message
from ...services.sanitization import sanitize_question_payload
from ...services.supabase_storage import upload_bytes as upload_bytes_to_supabase
from ...core.i18n import translate as _t
from ..deps import ensure_exam_owner, ensure_permission, get_current_user, get_db_dep, learner_can_access_exam, require_permission

router = APIRouter()
settings = get_settings()

QUESTION_IMAGE_MAX_BYTES = 5 * 1024 * 1024  # 5 MB
QUESTION_IMAGE_CONTENT_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
}
QUESTIONS_STORAGE_DIR = Path(__file__).resolve().parent.parent.parent.parent.parent / "storage" / "questions"


def _validate_question_image(content_type: str | None, size: int) -> None:
    if content_type not in QUESTION_IMAGE_CONTENT_TYPES:
        raise HTTPException(status_code=400, detail=_t("question_image_bad_type"))
    if size > QUESTION_IMAGE_MAX_BYTES:
        raise HTTPException(status_code=413, detail=_t("question_image_too_large"))


def _parse_uuid(value: str, detail: str) -> str:
    try:
        return str(UUID(value))
    except (TypeError, ValueError):
        raise HTTPException(status_code=404, detail=detail)


def _learner_question_response(question: Question) -> dict:
    masked = QuestionRead.model_validate(question, from_attributes=True).model_copy(
        update={"correct_answer": None}
    )
    return jsonable_encoder(masked, by_alias=True)


@router.post("/image")
async def upload_question_image(
    file: UploadFile = File(...),
    current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR)),
):
    content = await file.read()
    _validate_question_image(file.content_type, len(content))
    if not content:
        raise HTTPException(status_code=400, detail=_t("question_image_empty"))

    ext = QUESTION_IMAGE_CONTENT_TYPES[file.content_type]
    filename = f"q_{uuid.uuid4().hex}{ext}"

    if settings.MEDIA_STORAGE_PROVIDER == "supabase":
        await upload_bytes_to_supabase("questions", filename, content, content_type=file.content_type)
    else:
        QUESTIONS_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        (QUESTIONS_STORAGE_DIR / filename).write_bytes(content)

    return {"image_url": f"/api/media/questions/{filename}"}


@router.post("/", response_model=QuestionRead)
def create_question(body: QuestionCreate, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    exam = db.get(Exam, body.exam_id)
    if not exam:
        raise HTTPException(status_code=404, detail=_t("test_not_found"))
    ensure_exam_owner(exam, current, detail=_t("not_allowed"), status_code=403)
    if exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_add_to_published"))
    now = datetime.now(timezone.utc)
    q = Question(**sanitize_question_payload(body.model_dump()), created_at=now, updated_at=now)
    db.add(q)
    db.commit()
    db.refresh(q)
    return q


@router.get("/", response_model=list[QuestionRead])
def list_questions(exam_id: str | None = None, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    if current.role != RoleEnum.LEARNER:
        ensure_permission(db, current, "Edit Tests")
    elif not exam_id:
        raise HTTPException(status_code=403, detail=_t("exam_id_required"))

    query = select(Question)
    if exam_id:
        try:
            parsed_exam_id = str(UUID(exam_id))
        except (TypeError, ValueError):
            raise HTTPException(status_code=422, detail=_t("invalid_exam_id"))
        if current.role == RoleEnum.LEARNER:
            exam = db.get(Exam, parsed_exam_id)
            if not learner_can_access_exam(db, exam, current):
                raise HTTPException(status_code=404, detail=_t("test_not_found"))
        else:
            exam = db.get(Exam, parsed_exam_id)
            if not exam:
                raise HTTPException(status_code=404, detail=_t("test_not_found"))
            ensure_exam_owner(exam, current)
        query = query.where(Question.exam_id == parsed_exam_id)
    elif current.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR}:
        query = query.join(Question.exam).where(Exam.created_by_id == current.id)
    questions = db.scalars(query.order_by(Question.order.asc(), Question.created_at.asc())).all()
    if current.role == RoleEnum.LEARNER:
        return JSONResponse(content=[_learner_question_response(q) for q in questions])
    return questions


@router.get("/{question_id}", response_model=QuestionRead)
def get_question(
    question_id: str,
    db: Session = Depends(get_db_dep),
    current=Depends(get_current_user),
):
    if current.role != RoleEnum.LEARNER:
        ensure_permission(db, current, "Edit Tests")
    parsed_id = _parse_uuid(question_id, "Question not found")
    q = db.get(Question, parsed_id)
    if not q:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))
    if current.role == RoleEnum.LEARNER:
        return JSONResponse(content=_learner_question_response(q))
    ensure_exam_owner(q.exam, current)
    return q


@router.put("/{question_id}", response_model=QuestionRead)
def update_question(question_id: str, body: QuestionBase, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    parsed_id = _parse_uuid(question_id, "Question not found")
    q = db.get(Question, parsed_id)
    if not q:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))
    ensure_exam_owner(q.exam, current, detail=_t("not_allowed"), status_code=403)
    if q.exam and q.exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_modify_published"))
    protected = {"exam_id", "created_at"}
    now = datetime.now(timezone.utc)
    for field, value in sanitize_question_payload(body.model_dump()).items():
        if field not in protected:
            setattr(q, field, value)
    q.updated_at = now
    db.add(q)
    db.commit()
    db.refresh(q)
    return q


@router.delete("/{question_id}", response_model=Message)
def delete_question(question_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    parsed_id = _parse_uuid(question_id, "Question not found")
    q = db.get(Question, parsed_id)
    if not q:
        raise HTTPException(status_code=404, detail=_t("question_not_found"))
    ensure_exam_owner(q.exam, current, detail=_t("not_allowed"), status_code=403)
    if q.exam and q.exam.status == ExamStatus.OPEN:
        raise HTTPException(status_code=409, detail=_t("cannot_delete_published"))
    db.delete(q)
    db.commit()
    return Message(detail=_t("deleted"))
