"""Prepare a single full-proctoring sandbox exam for local testing.

This script is intentionally opinionated for local/dev use:
- creates or repairs one dedicated learner account
- creates one MCQ exam with all proctoring checks enabled
- archives every other exam so the UI shows just one test
- assigns the sandbox learner to the exam with immediate access
"""

from __future__ import annotations

import logging
import os
import sys
from copy import deepcopy
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from sqlalchemy import select
from sqlalchemy.orm import Session

from src.app.core.security import hash_password
from src.app.db.base import Base
from src.app.db.session import SessionLocal, engine
from src.app.models import (
    AccessMode,
    Attempt,
    Category,
    CategoryType,
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamType,
    GradingScale,
    Node,
    Question,
    RoleEnum,
    Schedule,
    User,
)
from src.app.services.normalized_relations import (
    DEFAULT_PROCTORING,
    mutate_exam_admin_meta,
    set_exam_proctoring,
    set_exam_runtime_settings,
)

logger = logging.getLogger(__name__)

ADMIN_EMAIL = "admin@example.com"
SANDBOX_LEARNER_EMAIL = "sandbox.learner@example.com"
SANDBOX_LEARNER_PASSWORD = "Sandbox1234!"
SANDBOX_LEARNER_USER_ID = "SBX001"
SANDBOX_LEARNER_NAME = "Sandbox Learner"

COURSE_TITLE = "Local QA Sandbox"
NODE_TITLE = "Full Proctoring Flow"
EXAM_TITLE = "Local Full Proctoring Sandbox"

QUESTION_BANK = [
    {
        "text": "Which browser permission is required for fullscreen proctored capture?",
        "options": ["Camera only", "Fullscreen and screen share", "Notifications", "Location"],
        "correct_answer": "B",
    },
    {
        "text": "Which page comes before the monitored attempt when system checks are enabled?",
        "options": ["Results", "Admin dashboard", "System check", "Certificate review"],
        "correct_answer": "C",
    },
    {
        "text": "What should the learner share for this sandbox exam?",
        "options": ["Only the current tab", "Only a window", "Entire screen", "Nothing"],
        "correct_answer": "C",
    },
    {
        "text": "Which proctoring input is recorded alongside the camera in this sandbox?",
        "options": ["Clipboard history", "Screen recording", "Printer output", "USB events"],
        "correct_answer": "B",
    },
    {
        "text": "What happens after submission in this sandbox flow?",
        "options": ["The score page opens while uploads continue", "The browser closes", "The exam restarts", "Nothing is saved"],
        "correct_answer": "A",
    },
]


def ensure_user(
    db: Session, *, email: str, password: str, name: str, user_id: str, role: RoleEnum, created_by_id=None
) -> User:
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            email=email,
            name=name,
            user_id=user_id,
            role=role,
            hashed_password=hash_password(password),
            created_by_id=created_by_id,
        )
        db.add(user)
        db.flush()
        return user

    user.name = name
    user.user_id = user_id
    user.role = role
    user.hashed_password = hash_password(password)
    if created_by_id is not None and getattr(user, "created_by_id", None) is None:
        user.created_by_id = created_by_id
    if hasattr(user, "is_active"):
        user.is_active = True
    db.flush()
    return user


def ensure_category(db: Session, owner_id) -> Category:
    category = db.scalar(
        select(Category).where(
            Category.name == "Sandbox Exams",
            Category.type == CategoryType.TEST,
            Category.created_by_id == owner_id,
        )
    )
    if category is None:
        category = Category(
            name="Sandbox Exams",
            type=CategoryType.TEST,
            description="Local single-exam sandbox for full proctoring validation.",
            created_by_id=owner_id,
        )
        db.add(category)
        db.flush()
    return category


def ensure_grading_scale(db: Session, owner_id) -> GradingScale:
    scale = db.scalar(
        select(GradingScale).where(
            GradingScale.name == "Sandbox Pass/Fail",
            GradingScale.created_by_id == owner_id,
        )
    )
    if scale is None:
        scale = GradingScale(
            name="Sandbox Pass/Fail",
            created_by_id=owner_id,
            labels=[
                {"label": "Pass", "min_score": 60, "max_score": 100},
                {"label": "Needs Review", "min_score": 0, "max_score": 59.99},
            ],
        )
        db.add(scale)
        db.flush()
    return scale


def ensure_course_and_node(db: Session, *, owner_id) -> tuple[Course, Node]:
    course = db.scalar(select(Course).where(Course.title == COURSE_TITLE))
    if course is None:
        course = Course(
            title=COURSE_TITLE,
            description="Disposable local course used for the single-exam sandbox flow.",
            status=CourseStatus.PUBLISHED,
            created_by_id=owner_id,
        )
        db.add(course)
        db.flush()

    node = db.scalar(select(Node).where(Node.course_id == course.id, Node.title == NODE_TITLE))
    if node is None:
        node = Node(course_id=course.id, title=NODE_TITLE, order=1)
        db.add(node)
        db.flush()
    return course, node


def build_full_proctoring_config() -> dict:
    config = deepcopy(DEFAULT_PROCTORING)
    for key in (
        "face_detection",
        "multi_face",
        "audio_detection",
        "object_detection",
        "eye_tracking",
        "head_pose_detection",
        "mouth_detection",
        "face_verify",
        "fullscreen_enforce",
        "tab_switch_detect",
        "screen_capture",
        "copy_paste_block",
        "identity_required",
        "camera_required",
        "mic_required",
        "fullscreen_required",
        "lighting_required",
    ):
        config[key] = True

    # Keep the sandbox forgiving enough for repeated manual testing.
    config.update({
        "max_attempts": None,
        "max_tab_blurs": 20,
        "max_alt_tabs": 20,
        "max_fullscreen_exits": 20,
        "max_alerts_before_autosubmit": 999,
        "max_score_before_autosubmit": 999,
        "lighting_min_score": 0.2,
        "access_mode": "RESTRICTED",
        "alert_rules": [
            {
                "id": "sandbox-fullscreen-exit",
                "event_type": "FULLSCREEN_EXIT",
                "threshold": 1,
                "severity": "HIGH",
                "action": "WARN",
                "message": "Return to fullscreen to keep the sandbox attempt valid.",
            },
            {
                "id": "sandbox-alt-tab",
                "event_type": "ALT_TAB",
                "threshold": 1,
                "severity": "HIGH",
                "action": "WARN",
                "message": "Tab switching is being tracked in the sandbox.",
            },
            {
                "id": "sandbox-screen-share-lost",
                "event_type": "SCREEN_SHARE_LOST",
                "threshold": 1,
                "severity": "HIGH",
                "action": "WARN",
                "message": "Restore entire-screen sharing to continue testing.",
            },
            {
                "id": "sandbox-audio",
                "event_type": "AUDIO_ANOMALY",
                "threshold": 1,
                "severity": "MEDIUM",
                "action": "WARN",
                "message": "Audio detection is active in the sandbox.",
            },
            {
                "id": "sandbox-multi-face",
                "event_type": "MULTIPLE_FACES",
                "threshold": 1,
                "severity": "MEDIUM",
                "action": "WARN",
                "message": "Multi-face detection is active in the sandbox.",
            },
        ],
    })
    return config


def replace_questions(exam: Exam) -> None:
    exam.questions = []
    for index, item in enumerate(QUESTION_BANK, start=1):
        exam.questions.append(
            Question(
                text=item["text"],
                type=ExamType.MCQ,
                options=item["options"],
                correct_answer=item["correct_answer"],
                points=1.0,
                order=index,
            )
        )


def reset_sandbox_attempts(db: Session, exam: Exam) -> None:
    existing_attempts = db.scalars(select(Attempt).where(Attempt.exam_id == exam.id)).all()
    for attempt in existing_attempts:
        db.delete(attempt)
    if existing_attempts:
        db.flush()


def archive_other_exams(db: Session, *, keep_exam_id, now: datetime) -> None:
    exams = db.scalars(select(Exam)).all()
    for exam in exams:
        if exam.id == keep_exam_id:
            exam.status = ExamStatus.OPEN
            mutate_exam_admin_meta(exam, archived_at=None, published_at=now)
            continue
        exam.status = ExamStatus.CLOSED
        mutate_exam_admin_meta(exam, archived_at=now)


def ensure_schedule(db: Session, *, exam: Exam, learner: User, now: datetime) -> None:
    schedule = db.scalar(select(Schedule).where(Schedule.exam_id == exam.id, Schedule.user_id == learner.id))
    if schedule is None:
        schedule = Schedule(exam_id=exam.id, user_id=learner.id, scheduled_at=now, access_mode=AccessMode.RESTRICTED)
        db.add(schedule)
    schedule.scheduled_at = now - timedelta(minutes=5)
    schedule.access_mode = AccessMode.RESTRICTED
    schedule.notes = "Single-exam sandbox learner assignment"


def prepare() -> None:
    Base.metadata.create_all(bind=engine)
    now = datetime.now(timezone.utc)
    db: Session = SessionLocal()
    try:
        admin = db.scalar(select(User).where(User.email == ADMIN_EMAIL))
        if admin is None:
            raise RuntimeError(
                f"Admin user '{ADMIN_EMAIL}' must exist before preparing the sandbox. "
                "Bring the stack up and seed the demo data first."
            )

        learner = ensure_user(
            db,
            email=SANDBOX_LEARNER_EMAIL,
            password=SANDBOX_LEARNER_PASSWORD,
            name=SANDBOX_LEARNER_NAME,
            user_id=SANDBOX_LEARNER_USER_ID,
            role=RoleEnum.LEARNER,
            created_by_id=admin.id,
        )
        category = ensure_category(db, admin.id)
        scale = ensure_grading_scale(db, admin.id)
        _, node = ensure_course_and_node(db, owner_id=admin.id)

        exam = db.scalar(select(Exam).where(Exam.node_id == node.id, Exam.title == EXAM_TITLE))
        if exam is None:
            exam = Exam(
                node_id=node.id,
                title=EXAM_TITLE,
                description=(
                    "Single local sandbox exam with camera, microphone, fullscreen, "
                    "identity verification, screen capture, and alert monitoring enabled."
                ),
                type=ExamType.MCQ,
                status=ExamStatus.OPEN,
                time_limit=45,
                max_attempts=20,
                passing_score=60.0,
                category_id=category.id,
                grading_scale_id=scale.id,
                created_by_id=admin.id,
            )
            db.add(exam)
            db.flush()
        else:
            exam.description = (
                "Single local sandbox exam with camera, microphone, fullscreen, "
                "identity verification, screen capture, and alert monitoring enabled."
            )
            exam.status = ExamStatus.OPEN
            exam.type = ExamType.MCQ
            exam.time_limit = 45
            exam.max_attempts = 20
            exam.passing_score = 60.0
            exam.category_id = category.id
            exam.grading_scale_id = scale.id
            exam.created_by_id = admin.id

        reset_sandbox_attempts(db, exam)
        replace_questions(exam)
        set_exam_proctoring(exam, build_full_proctoring_config())
        set_exam_runtime_settings(
            exam,
            {
                "show_test_instructions": True,
                "instructions_heading": "Sandbox checklist",
                "instructions_body": (
                    "Use this sandbox to validate the full learner journey: system check, "
                    "identity verification, fullscreen, live monitoring, background upload, "
                    "and admin-side video review."
                ),
                "instructions_list": [
                    "Allow camera, microphone, and entire-screen sharing.",
                    "Stay in fullscreen when the browser prompts you.",
                    "Submit normally to verify the score page and background upload flow.",
                    "Open Manage Tests > Proctoring > Video as admin to review the recordings.",
                ],
                "instructions_require_acknowledgement": True,
                "show_score_report": True,
                "show_answer_review": True,
                "show_correct_answers": True,
                "allow_retake": True,
                "retake_cooldown_hours": 0,
                "completion_message": "Sandbox attempt submitted. Review the score page and the admin proctoring panel.",
            },
        )
        mutate_exam_admin_meta(
            exam,
            code="SANDBOX1",
            published_at=now,
            archived_at=None,
            randomize_questions=False,
        )
        ensure_schedule(db, exam=exam, learner=learner, now=now)
        archive_other_exams(db, keep_exam_id=exam.id, now=now)

        db.commit()
        logger.info("Single-exam sandbox is ready.")
        logger.info("Exam: %s", EXAM_TITLE)
        logger.info("Learner login: %s / %s", SANDBOX_LEARNER_EMAIL, SANDBOX_LEARNER_PASSWORD)
        logger.info("Admin login: %s / %s", ADMIN_EMAIL, "Admin1234!")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    prepare()
