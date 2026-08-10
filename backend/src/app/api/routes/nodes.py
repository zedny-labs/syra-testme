from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ...models import Attempt, Course, CourseStatus, Exam, Node, RoleEnum
from ...schemas import NodeCreate, NodeRead, NodeBase, Message
from ...services.sanitization import sanitize_plain_text
from ...core.i18n import translate as _t
from ..deps import ensure_permission, get_current_user, get_db_dep, parse_uuid_param, require_permission
from .courses import _exclude_internal_library_courses

router = APIRouter()


@router.post("/", response_model=NodeRead)
def create_node(body: NodeCreate, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    course = db.get(Course, body.course_id)
    if not course:
        raise HTTPException(status_code=404, detail=_t("course_not_found"))
    if course.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    now = datetime.now(timezone.utc)
    node = Node(course_id=body.course_id, title=sanitize_plain_text(body.title) or body.title, order=body.order, created_at=now, updated_at=now)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


@router.get("/", response_model=list[NodeRead])
def list_nodes(course_id: str | None = None, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    # Join Course once so we can hide modules that belong to the internal
    # "Question Pool Library" course (its "Shared Pool Questions" node is pool
    # storage, not a real module) from every role.
    query = _exclude_internal_library_courses(select(Node).join(Course, Node.course_id == Course.id))
    if course_id:
        course_pk = parse_uuid_param(course_id, detail=_t("invalid_course_id"))
        query = query.where(Node.course_id == course_pk)
    if current.role == RoleEnum.LEARNER:
        query = query.where(Course.status == CourseStatus.PUBLISHED)
    else:
        ensure_permission(db, current, "Edit Tests")
        query = query.where(Course.created_by_id == current.id)
    query = query.order_by(Node.order)
    return db.scalars(query).all()


@router.get("/{node_id}", response_model=NodeRead)
def get_node(node_id: str, db: Session = Depends(get_db_dep), current=Depends(get_current_user)):
    node_pk = parse_uuid_param(node_id, detail=_t("node_not_found"))
    node = db.get(Node, node_pk)
    if not node:
        raise HTTPException(status_code=404, detail=_t("node_not_found"))
    if current.role == RoleEnum.LEARNER and node.course and node.course.status != CourseStatus.PUBLISHED:
        raise HTTPException(status_code=404, detail=_t("node_not_found"))
    if current.role != RoleEnum.LEARNER:
        ensure_permission(db, current, "Edit Tests")
        course = node.course or db.get(Course, node.course_id)
        if not course or course.created_by_id != current.id:
            raise HTTPException(status_code=404, detail=_t("node_not_found"))
    return node


@router.put("/{node_id}", response_model=NodeRead)
def update_node(node_id: str, body: NodeBase, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    node_pk = parse_uuid_param(node_id, detail=_t("node_not_found"))
    node = db.get(Node, node_pk)
    if not node:
        raise HTTPException(status_code=404, detail=_t("node_not_found"))
    if not node.course or node.course.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    node.title = sanitize_plain_text(body.title) or body.title
    node.order = body.order
    node.updated_at = datetime.now(timezone.utc)
    db.add(node)
    db.commit()
    db.refresh(node)
    return node


@router.delete("/{node_id}", response_model=Message)
def delete_node(node_id: str, db: Session = Depends(get_db_dep), current=Depends(require_permission("Edit Tests", RoleEnum.ADMIN, RoleEnum.INSTRUCTOR))):
    node_pk = parse_uuid_param(node_id, detail=_t("node_not_found"))
    node = db.get(Node, node_pk)
    if not node:
        raise HTTPException(status_code=404, detail=_t("node_not_found"))
    if not node.course or node.course.created_by_id != current.id:
        raise HTTPException(status_code=403, detail=_t("not_allowed"))
    attempt_count = int(
        db.scalar(
            select(func.count(Attempt.id))
            .select_from(Attempt)
            .join(Exam, Attempt.exam_id == Exam.id)
            .where(Exam.node_id == node.id)
        )
        or 0
    )
    if attempt_count:
        raise HTTPException(
            status_code=409,
            detail=_t("cannot_delete_node_attempts"),
        )
    db.delete(node)
    db.commit()
    return Message(detail=_t("deleted"))
