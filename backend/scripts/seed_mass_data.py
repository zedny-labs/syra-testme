"""Seed a large demo dataset for local UI testing.

Run from backend folder:
  export DATABASE_URL=postgresql+psycopg://postgres:password@localhost:5432/syra_lms
  python scripts/seed_mass_data.py

Run inside the Docker backend container:
  python scripts/seed_mass_data.py
"""

import argparse
import logging
import os
import random
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from src.app.core.security import hash_password
from src.app.db.base import Base
from src.app.db.session import SessionLocal, engine
from src.app.models import (
    AccessMode,
    Attempt,
    AttemptStatus,
    AuditLog,
    Category,
    CategoryType,
    Course,
    CourseStatus,
    Exam,
    ExamStatus,
    ExamTemplate,
    ExamType,
    GradingScale,
    Node,
    Notification,
    ProctoringEvent,
    Question,
    QuestionPool,
    ReportSchedule,
    RoleEnum,
    Schedule,
    SeverityEnum,
    Survey,
    SurveyResponse,
    SystemSettings,
    User,
    UserGroup,
)
logger = logging.getLogger(__name__)


def env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def random_name(prefix: str, idx: int) -> str:
    return f"{prefix} {idx:03d}"


def chunked(lst, size):
    for i in range(0, len(lst), size):
        yield lst[i : i + size]


def seed(*, force: bool = False):
    random.seed(42)
    run_tag = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    now = datetime.now(timezone.utc)

    Base.metadata.create_all(bind=engine)
    db = SessionLocal()

    try:
        existing_users = db.query(User).count()
        if existing_users and not force:
            logger.info(
                "Existing users detected (%s). Skipping mass seed to avoid duplicate demo data. "
                "Re-run with --force or SYRA_SEED_FORCE=1 to append another batch.",
                existing_users,
            )
            return

        # Core users (keep known credentials predictable).
        admin = db.query(User).filter(User.email == "admin@example.com").first()
        if not admin:
            admin = User(
                email="admin@example.com",
                name="Admin User",
                user_id="ADM001",
                role=RoleEnum.ADMIN,
                hashed_password=hash_password("Admin1234!"),
                is_active=True,
            )
            db.add(admin)

        instructor = db.query(User).filter(User.email == "instructor@example.com").first()
        if not instructor:
            instructor = User(
                email="instructor@example.com",
                name="Lead Instructor",
                user_id="INS001",
                role=RoleEnum.INSTRUCTOR,
                hashed_password=hash_password("Instructor1234!"),
                is_active=True,
            )
            db.add(instructor)

        student1 = db.query(User).filter(User.email == "student1@example.com").first()
        if not student1:
            student1 = User(
                email="student1@example.com",
                name="Omar Hassan",
                user_id="STU001",
                role=RoleEnum.LEARNER,
                hashed_password=hash_password("Student1234!"),
                is_active=True,
            )
            db.add(student1)

        student2 = db.query(User).filter(User.email == "student2@example.com").first()
        if not student2:
            student2 = User(
                email="student2@example.com",
                name="Fatima Ali",
                user_id="STU002",
                role=RoleEnum.LEARNER,
                hashed_password=hash_password("Student1234!"),
                is_active=True,
            )
            db.add(student2)
        db.flush()

        # Many learners.
        learners = [student1, student2]
        bulk_learners = []
        for i in range(1, 81):
            email = f"learner{run_tag}_{i:03d}@example.com"
            user = User(
                email=email,
                name=random_name("Learner", i),
                user_id=f"LRN{run_tag[-6:]}{i:03d}",
                role=RoleEnum.LEARNER,
                hashed_password=hash_password("Student1234!"),
                is_active=True,
            )
            bulk_learners.append(user)
            learners.append(user)
        db.add_all(bulk_learners)
        db.flush()

        # Categories and grading scales.
        categories = []
        for i in range(1, 11):
            categories.append(
                Category(
                    name=f"Seed {run_tag} Category {i}",
                    type=CategoryType.TEST,
                    description=f"Seeded category {i}",
                    created_by_id=instructor.id,
                )
            )
        db.add_all(categories)

        scale = GradingScale(
            name=f"Seed {run_tag} Standard Scale",
            created_by_id=instructor.id,
            labels=[
                {"label": "A", "min_score": 90, "max_score": 100},
                {"label": "B", "min_score": 80, "max_score": 89.99},
                {"label": "C", "min_score": 70, "max_score": 79.99},
                {"label": "D", "min_score": 60, "max_score": 69.99},
                {"label": "F", "min_score": 0, "max_score": 59.99},
            ],
        )
        db.add(scale)
        db.flush()

        # Courses and nodes.
        courses = []
        for i in range(1, 13):
            courses.append(
                Course(
                    title=f"Seed {run_tag} Course {i}",
                    description=f"Comprehensive seeded course {i}",
                    status=CourseStatus.PUBLISHED,
                    created_by_id=instructor.id,
                )
            )
        db.add_all(courses)
        db.flush()

        nodes = []
        for c in courses:
            for order in range(1, 4):
                nodes.append(Node(course_id=c.id, title=f"{c.title} - Module {order}", order=order))
        db.add_all(nodes)
        db.flush()

        # Question pools.
        pools = []
        for i in range(1, 11):
            pools.append(
                QuestionPool(
                    name=f"Seed {run_tag} Pool {i}",
                    description=f"Reusable seeded pool {i}",
                    created_by_id=instructor.id,
                )
            )
        db.add_all(pools)
        db.flush()

        # Legacy exams + questions.
        exams = []
        for i in range(1, 61):
            node = random.choice(nodes)
            exams.append(
                Exam(
                    node_id=node.id,
                    title=f"Seed {run_tag} Exam {i}",
                    type=random.choice([ExamType.MCQ, ExamType.TEXT]),
                    status=random.choice([ExamStatus.OPEN, ExamStatus.CLOSED]),
                    time_limit=random.choice([15, 20, 30, 45, 60, 90]),
                    max_attempts=random.choice([1, 2, 3]),
                    passing_score=random.choice([50.0, 60.0, 70.0]),
                    proctoring_config={
                        "face_detection": True,
                        "audio_detection": bool(i % 2),
                        "object_detection": bool(i % 3),
                    },
                    category_id=random.choice(categories).id,
                    grading_scale_id=scale.id,
                    created_by_id=instructor.id,
                )
            )
        db.add_all(exams)
        db.flush()

        questions = []
        for exam in exams:
            q_count = random.randint(6, 12)
            for q_idx in range(1, q_count + 1):
                q_type = ExamType.MCQ if exam.type != ExamType.TEXT else random.choice([ExamType.TEXT, ExamType.MCQ])
                options = ["Option A", "Option B", "Option C", "Option D"] if q_type == ExamType.MCQ else None
                correct = random.choice(["A", "B", "C", "D"]) if q_type == ExamType.MCQ else "Sample answer"
                questions.append(
                    Question(
                        exam_id=exam.id,
                        text=f"{exam.title} Question {q_idx}",
                        type=q_type,
                        options=options,
                        correct_answer=correct,
                        points=1.0,
                        order=q_idx,
                        pool_id=random.choice(pools).id if q_idx % 3 == 0 else None,
                    )
                )
        db.add_all(questions)
        db.flush()

        # Schedules for exams.
        schedules = []
        for user in learners:
            for exam in random.sample(exams, k=3):
                schedules.append(
                    Schedule(
                        exam_id=exam.id,
                        user_id=user.id,
                        scheduled_at=now + timedelta(days=random.randint(-20, 30), hours=random.randint(0, 20)),
                        access_mode=random.choice([AccessMode.OPEN, AccessMode.RESTRICTED]),
                        notes=f"Seeded exam schedule {run_tag}",
                    )
                )
        db.add_all(schedules)
        db.flush()

        # Attempts and proctoring events.
        attempts = []
        for user in random.sample(learners, k=min(len(learners), 50)):
            for exam in random.sample(exams, k=4):
                started = now - timedelta(days=random.randint(1, 30), hours=random.randint(0, 12))
                status = random.choice([AttemptStatus.GRADED, AttemptStatus.SUBMITTED, AttemptStatus.IN_PROGRESS])
                submitted = started + timedelta(minutes=random.randint(15, 90)) if status != AttemptStatus.IN_PROGRESS else None
                score = random.randint(35, 98) if status != AttemptStatus.IN_PROGRESS else None
                attempts.append(
                    Attempt(
                        exam_id=exam.id,
                        user_id=user.id,
                        status=status,
                        score=score,
                        started_at=started,
                        submitted_at=submitted,
                        identity_verified=True,
                        id_verified=True,
                        lighting_score=round(random.uniform(0.45, 0.95), 2),
                        precheck_passed_at=started - timedelta(minutes=8),
                    )
                )
        db.add_all(attempts)
        db.flush()

        events = []
        event_types = ["MULTI_FACE", "FOCUS_LOSS", "GAZE_DEVIATION", "FORBIDDEN_OBJECT", "VOICE_DETECTED"]
        for att in attempts:
            for i in range(random.randint(3, 8)):
                events.append(
                    ProctoringEvent(
                        attempt_id=att.id,
                        event_type=random.choice(event_types),
                        severity=random.choice([SeverityEnum.LOW, SeverityEnum.MEDIUM, SeverityEnum.HIGH]),
                        detail=f"Seed event {i + 1} for attempt {str(att.id)[:8]}",
                        ai_confidence=round(random.uniform(0.55, 0.99), 2),
                        occurred_at=(att.started_at or now) + timedelta(minutes=i * 4 + 2),
                    )
                )
        for batch in chunked(events, 200):
            db.add_all(batch)
            db.flush()

        # Remaining admin modules.
        surveys = []
        for i in range(1, 13):
            surveys.append(
                Survey(
                    title=f"Seed {run_tag} Survey {i}",
                    description="Seeded survey for UI testing.",
                    questions=[
                        {"type": "rating", "label": "How was your experience?"},
                        {"type": "text", "label": "What can we improve?"},
                    ],
                    is_active=bool(i % 2),
                    created_by_id=admin.id,
                )
            )
        db.add_all(surveys)
        db.flush()

        survey_responses = []
        for s in surveys:
            for user in random.sample(learners, k=10):
                survey_responses.append(
                    SurveyResponse(
                        survey_id=s.id,
                        user_id=user.id,
                        answers={"rating": random.randint(2, 5), "comment": f"Seed feedback {run_tag}"},
                    )
                )
        db.add_all(survey_responses)

        groups = []
        for i in range(1, 9):
            members = random.sample([str(u.id) for u in learners], k=12)
            groups.append(
                UserGroup(
                    name=f"Seed {run_tag} Group {i}",
                    description=f"Seeded learner group {i}",
                    member_ids=members,
                    created_by_id=admin.id,
                )
            )
        db.add_all(groups)

        templates = []
        for i in range(1, 9):
            templates.append(
                ExamTemplate(
                    name=f"Seed {run_tag} Template {i}",
                    description="Template for seeded records",
                    config={"duration": random.choice([30, 45, 60]), "question_count": random.choice([20, 30, 40])},
                    created_by_id=admin.id,
                )
            )
        db.add_all(templates)

        report_schedules = []
        for i in range(1, 7):
            report_schedules.append(
                ReportSchedule(
                    name=f"Seed {run_tag} Report Schedule {i}",
                    report_type=random.choice(["attempt_summary", "exam_overview", "proctoring_violations"]),
                    schedule_cron="0 8 * * *",
                    recipients=["admin@example.com", "instructor@example.com"],
                    is_active=bool(i % 2),
                    created_by_id=admin.id,
                )
            )
        db.add_all(report_schedules)

        notifications = []
        for user in random.sample([admin, instructor] + learners, k=40):
            notifications.append(
                Notification(
                    user_id=user.id,
                    title="Seeded Notification",
                    message=f"Demo notification generated at {run_tag}.",
                    is_read=bool(random.randint(0, 1)),
                    link="/admin/dashboard",
                )
            )
        db.add_all(notifications)

        audit_logs = []
        actions = ["LOGIN", "CREATE_TEST", "UPDATE_EXAM", "ASSIGN_CANDIDATE", "DOWNLOAD_REPORT"]
        for i in range(1, 201):
            actor = random.choice([admin, instructor] + learners[:20])
            audit_logs.append(
                AuditLog(
                    user_id=actor.id,
                    action=random.choice(actions),
                    resource_type=random.choice(["test", "exam", "schedule", "report"]),
                    resource_id=str(random.choice(exams).id),
                    detail=f"Seeded audit entry {i}",
                    ip_address=f"10.10.0.{random.randint(2, 200)}",
                )
            )
        db.add_all(audit_logs)

        maintenance = db.query(SystemSettings).filter(SystemSettings.key == "maintenance").first()
        if not maintenance:
            db.add(SystemSettings(key="maintenance", value='{"mode":"off","banner":""}'))

        db.commit()

        logger.info("Mass seed completed for run %s", run_tag)
        logger.info("Login credentials: admin@example.com / Admin1234!")
        logger.info("Login credentials: instructor@example.com / Instructor1234!")
        logger.info("Login credentials: student1@example.com / Student1234!")
        logger.info("Login credentials: student2@example.com / Student1234!")
        logger.info("Additional learner password: Student1234!")
        logger.info("Example generated learner: learner%s_001@example.com", run_tag)
        logger.info("Created learners=%s", len(learners))
        logger.info("Created exams=%s questions=%s", len(exams), len(questions))
        logger.info(
            "Created schedules=%s attempts=%s events=%s",
            len(schedules),
            len(attempts),
            len(events),
        )
        logger.info("Created surveys=%s survey_responses=%s", len(surveys), len(survey_responses))
        logger.info("Created groups=%s templates=%s", len(groups), len(templates))
        logger.info(
            "Created report_schedules=%s notifications=%s audit_logs=%s",
            len(report_schedules),
            len(notifications),
            len(audit_logs),
        )
    finally:
        db.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    parser = argparse.ArgumentParser(description="Seed a large demo dataset for the SYRA LMS stack.")
    parser.add_argument(
        "--force",
        action="store_true",
        help="Append another seeded batch even when users already exist.",
    )
    args = parser.parse_args()
    seed(force=args.force or env_flag("SYRA_SEED_FORCE"))
