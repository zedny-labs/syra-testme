import uuid
from datetime import datetime
from enum import Enum

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    Enum as SAEnum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Index,
    text,
)
from ..db.types import GUID as UUID
from sqlalchemy.orm import relationship, Mapped, mapped_column
from sqlalchemy.sql import func
from sqlalchemy.ext.hybrid import hybrid_property

from ..db.base import Base


class RoleEnum(str, Enum):
    ADMIN = "ADMIN"
    INSTRUCTOR = "INSTRUCTOR"
    LEARNER = "LEARNER"


class CourseStatus(str, Enum):
    DRAFT = "DRAFT"
    PUBLISHED = "PUBLISHED"


class ExamType(str, Enum):
    MCQ = "MCQ"
    MULTI = "MULTI"
    TRUEFALSE = "TRUEFALSE"
    ORDERING = "ORDERING"
    FILLINBLANK = "FILLINBLANK"
    MATCHING = "MATCHING"
    TEXT = "TEXT"


class ExamStatus(str, Enum):
    OPEN = "OPEN"
    CLOSED = "CLOSED"


class AttemptStatus(str, Enum):
    IN_PROGRESS = "IN_PROGRESS"
    SUBMITTED = "SUBMITTED"
    GRADED = "GRADED"


class AccessMode(str, Enum):
    OPEN = "OPEN"
    RESTRICTED = "RESTRICTED"


class SeverityEnum(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class CategoryType(str, Enum):
    TEST = "TEST"
    SURVEY = "SURVEY"
    TRAINING = "TRAINING"


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[str] = mapped_column(String(50), unique=True, nullable=False, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[RoleEnum] = mapped_column(SAEnum(RoleEnum), default=RoleEnum.LEARNER, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    token_invalid_before: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    courses = relationship("Course", back_populates="creator")
    attempts = relationship("Attempt", back_populates="user")
    question_pools = relationship("QuestionPool", back_populates="creator")
    created_exams = relationship("Exam", back_populates="creator")
    schedules = relationship("Schedule", back_populates="user")
    notifications = relationship("Notification", back_populates="user")
    audit_logs = relationship("AuditLog", back_populates="user")
    created_surveys = relationship("Survey", back_populates="creator")
    survey_responses = relationship("SurveyResponse", back_populates="user")
    preferences = relationship("UserPreference", back_populates="user")
    exam_templates = relationship("ExamTemplate", back_populates="creator")
    report_schedules = relationship("ReportSchedule", back_populates="creator")
    group_memberships = relationship("UserGroupMember", back_populates="user", cascade="all, delete-orphan")


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1024), nullable=True)
    status: Mapped[CourseStatus] = mapped_column(SAEnum(CourseStatus), default=CourseStatus.DRAFT, nullable=False)
    created_by_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    creator = relationship("User", back_populates="courses")
    nodes = relationship("Node", back_populates="course", cascade="all, delete-orphan")


class Node(Base):
    __tablename__ = "nodes"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    course_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("courses.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    order: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    course = relationship("Course", back_populates="nodes")
    exams = relationship("Exam", back_populates="node", cascade="all, delete-orphan")


class Category(Base):
    __tablename__ = "categories"
    __table_args__ = (UniqueConstraint("created_by_id", "name", name="uq_category_owner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    type: Mapped[CategoryType] = mapped_column(SAEnum(CategoryType), default=CategoryType.TEST, nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))

    exams = relationship("Exam", back_populates="category")


class GradingScale(Base):
    __tablename__ = "grading_scales"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    labels: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))

    exams = relationship("Exam", back_populates="grading_scale")


class QuestionPool(Base):
    __tablename__ = "question_pools"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    creator = relationship("User", back_populates="question_pools")
    questions = relationship("Question", back_populates="pool")
    library_exams = relationship("Exam", back_populates="library_pool", foreign_keys="Exam.library_pool_id")


class ExamSection(Base):
    __tablename__ = "exam_sections"
    __table_args__ = (
        Index("ix_exam_section_exam_order", "exam_id", "order"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    source_pool_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("question_pools.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", back_populates="sections")
    questions = relationship("Question", back_populates="section", order_by="Question.order")
    source_pool = relationship("QuestionPool", foreign_keys=[source_pool_id])

    @hybrid_property
    def question_count(self):
        return len(self.questions) if self.questions else 0


class Exam(Base):
    __tablename__ = "exams"
    __table_args__ = (
        UniqueConstraint("node_id", "title", name="uq_exam_node_title"),
        CheckConstraint("time_limit > 0 OR time_limit IS NULL", name="ck_exams_time_limit_positive"),
        CheckConstraint("passing_score >= 0 AND passing_score <= 100", name="ck_exams_passing_score_range"),
        CheckConstraint("max_attempts >= 1", name="ck_exams_max_attempts_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    node_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("nodes.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(String(4000))
    type: Mapped[ExamType] = mapped_column(SAEnum(ExamType), default=ExamType.MCQ, nullable=False)
    status: Mapped[ExamStatus] = mapped_column(SAEnum(ExamStatus), default=ExamStatus.CLOSED, nullable=False, index=True)
    time_limit: Mapped[int | None] = mapped_column(Integer)
    max_attempts: Mapped[int] = mapped_column(Integer, default=1)
    passing_score: Mapped[float | None] = mapped_column(Float)
    proctoring_config: Mapped[dict | None] = mapped_column(JSON)
    settings: Mapped[dict | None] = mapped_column(JSON)
    certificate: Mapped[dict | None] = mapped_column(JSON)
    category_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("categories.id", ondelete="SET NULL"))
    library_pool_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("question_pools.id", ondelete="SET NULL"), index=True)
    grading_scale_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("grading_scales.id", ondelete="SET NULL"))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    node = relationship("Node", back_populates="exams")
    questions = relationship("Question", back_populates="exam", cascade="all, delete-orphan")
    sections = relationship("ExamSection", back_populates="exam", cascade="all, delete-orphan", order_by="ExamSection.order")
    attempts = relationship("Attempt", back_populates="exam")
    schedules = relationship("Schedule", back_populates="exam")
    category = relationship("Category", back_populates="exams")
    library_pool = relationship("QuestionPool", back_populates="library_exams", foreign_keys=[library_pool_id])
    grading_scale = relationship("GradingScale", back_populates="exams")
    creator = relationship("User", back_populates="created_exams")
    admin_config = relationship("ExamAdminConfig", back_populates="exam", uselist=False, cascade="all, delete-orphan")
    runtime_config_rel = relationship("ExamRuntimeConfig", back_populates="exam", uselist=False, cascade="all, delete-orphan")
    certificate_config_rel = relationship("ExamCertificateConfig", back_populates="exam", uselist=False, cascade="all, delete-orphan")
    proctoring_config_rel = relationship("ExamProctoringConfig", back_populates="exam", uselist=False, cascade="all, delete-orphan")

    @hybrid_property
    def question_count(self):
        return len(self.questions) if self.questions else 0


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        Index("ix_question_exam_order", "exam_id", "order"),
        CheckConstraint("points >= 0", name="ck_questions_points_non_negative"),
        CheckConstraint('"order" >= 0', name="ck_questions_order_non_negative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"))
    text: Mapped[str] = mapped_column(String(2048), nullable=False)
    type: Mapped[ExamType] = mapped_column(SAEnum(ExamType), default=ExamType.MCQ, nullable=False)
    options: Mapped[list | None] = mapped_column(JSON)
    correct_answer: Mapped[str | None] = mapped_column(String(255))
    points: Mapped[float] = mapped_column(Float, default=1.0)
    order: Mapped[int] = mapped_column(Integer, default=0)
    image_url: Mapped[str | None] = mapped_column(String(1024))
    pool_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("question_pools.id", ondelete="SET NULL"))
    section_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_sections.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", back_populates="questions")
    pool = relationship("QuestionPool", back_populates="questions")
    section = relationship("ExamSection", back_populates="questions")
    attempt_answers = relationship("AttemptAnswer", back_populates="question")


class Attempt(Base):
    __tablename__ = "attempts"
    __table_args__ = (
        Index("ix_attempt_user_exam", "user_id", "exam_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[AttemptStatus] = mapped_column(SAEnum(AttemptStatus), default=AttemptStatus.IN_PROGRESS, nullable=False, index=True)
    score: Mapped[float | None] = mapped_column(Float)
    grade: Mapped[str | None] = mapped_column(String(100))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    face_signature: Mapped[dict | list | None] = mapped_column(JSON)
    sections_finished: Mapped[list | None] = mapped_column(JSON, default=list)
    base_head_pose: Mapped[dict | None] = mapped_column(JSON)
    id_doc_path: Mapped[str | None] = mapped_column(String(512))
    selfie_path: Mapped[str | None] = mapped_column(String(512))
    id_text: Mapped[dict | None] = mapped_column(JSON)
    id_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    lighting_score: Mapped[float | None] = mapped_column(Float)
    precheck_passed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", back_populates="attempts")
    user = relationship("User", back_populates="attempts")
    answers = relationship("AttemptAnswer", back_populates="attempt", cascade="all, delete-orphan")
    events = relationship("ProctoringEvent", back_populates="attempt", cascade="all, delete-orphan")


class AttemptAnswer(Base):
    __tablename__ = "attempt_answers"
    __table_args__ = (
        UniqueConstraint("attempt_id", "question_id", name="uq_attempt_answer_attempt_question"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("attempts.id", ondelete="CASCADE"))
    question_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("questions.id", ondelete="CASCADE"))
    answer: Mapped[str | None] = mapped_column(String(2048))
    is_correct: Mapped[bool | None] = mapped_column(Boolean)
    points_earned: Mapped[float | None] = mapped_column(Float)

    attempt = relationship("Attempt", back_populates="answers")
    question = relationship("Question", back_populates="attempt_answers")


class Schedule(Base):
    __tablename__ = "schedules"
    __table_args__ = (
        UniqueConstraint("user_id", "exam_id", name="uq_schedule_user_exam"),
        # Covering index for the EXISTS check in the learner catalog query.
        # Including scheduled_at avoids a heap fetch for the date comparison.
        Index("ix_schedule_user_exam_scheduled", "user_id", "exam_id", "scheduled_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), nullable=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    access_mode: Mapped[AccessMode] = mapped_column(SAEnum(AccessMode), default=AccessMode.OPEN, nullable=False)
    notes: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    exam = relationship("Exam", back_populates="schedules")
    user = relationship("User", back_populates="schedules")


class ProctoringEvent(Base):
    __tablename__ = "proctoring_events"
    __table_args__ = (
        Index("ix_event_attempt", "attempt_id"),
        Index("ix_event_attempt_time", "attempt_id", "occurred_at"),
        Index("ix_event_type_severity", "event_type", "severity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    attempt_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("attempts.id", ondelete="CASCADE"))
    event_type: Mapped[str] = mapped_column(String(255), nullable=False)
    severity: Mapped[SeverityEnum] = mapped_column(SAEnum(SeverityEnum), nullable=False)
    detail: Mapped[str | None] = mapped_column(String(2048))
    ai_confidence: Mapped[float | None] = mapped_column(Float)
    meta: Mapped[dict | None] = mapped_column(JSON)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    attempt = relationship("Attempt", back_populates="events")


class Notification(Base):
    __tablename__ = "notifications"
    __table_args__ = (
        Index("ix_notification_user_id", "user_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    message: Mapped[str] = mapped_column(String(2048), nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    link: Mapped[str | None] = mapped_column(String(512))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="notifications")


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_log_user_id", "user_id"),
        Index("ix_audit_log_created_at", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(255), nullable=False)
    resource_type: Mapped[str | None] = mapped_column(String(100))
    resource_id: Mapped[str | None] = mapped_column(String(255))
    detail: Mapped[str | None] = mapped_column(String(2048))
    ip_address: Mapped[str | None] = mapped_column(String(45))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User", back_populates="audit_logs")


class Survey(Base):
    __tablename__ = "surveys"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(2048))
    questions: Mapped[list | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    creator = relationship("User", back_populates="created_surveys")
    responses = relationship("SurveyResponse", back_populates="survey", cascade="all, delete-orphan")
    question_items = relationship("SurveyQuestion", back_populates="survey", cascade="all, delete-orphan", order_by="SurveyQuestion.position")


class SurveyResponse(Base):
    __tablename__ = "survey_responses"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"))
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"))
    answers: Mapped[dict | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    survey = relationship("Survey", back_populates="responses")
    user = relationship("User", back_populates="survey_responses")


class UserGroup(Base):
    __tablename__ = "user_groups"
    __table_args__ = (UniqueConstraint("created_by_id", "name", name="uq_user_group_owner_name"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    member_ids: Mapped[list | None] = mapped_column(JSON)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    member_links = relationship("UserGroupMember", back_populates="group", cascade="all, delete-orphan", order_by="UserGroupMember.position")


class UserPreference(Base):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_preference_user_key"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    key: Mapped[str] = mapped_column(String(255), nullable=False)
    value: Mapped[dict | list | str | int | float | bool | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    user = relationship("User", back_populates="preferences")


class ExamTemplate(Base):
    __tablename__ = "exam_templates"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(String(1024))
    config: Mapped[dict | None] = mapped_column(JSON)
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    creator = relationship("User", back_populates="exam_templates")


class ReportSchedule(Base):
    __tablename__ = "report_schedules"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    report_type: Mapped[str] = mapped_column(String(100), nullable=False)
    schedule_cron: Mapped[str | None] = mapped_column(String(100))
    recipients: Mapped[list | None] = mapped_column(JSON)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())

    creator = relationship("User", back_populates="report_schedules")


class SurveyQuestion(Base):
    __tablename__ = "survey_questions"
    __table_args__ = (
        UniqueConstraint("survey_id", "position", name="uq_survey_question_survey_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("surveys.id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    text: Mapped[str] = mapped_column(String(2048), nullable=False)
    question_type: Mapped[str] = mapped_column(String(64), nullable=False)

    survey = relationship("Survey", back_populates="question_items")
    options = relationship("SurveyQuestionOption", back_populates="question", cascade="all, delete-orphan", order_by="SurveyQuestionOption.position")


class SurveyQuestionOption(Base):
    __tablename__ = "survey_question_options"
    __table_args__ = (
        UniqueConstraint("survey_question_id", "position", name="uq_survey_question_option_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    survey_question_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("survey_questions.id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    text: Mapped[str] = mapped_column(String(1024), nullable=False)

    question = relationship("SurveyQuestion", back_populates="options")


class UserGroupMember(Base):
    __tablename__ = "user_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_user_group_member_group_user"),
        UniqueConstraint("group_id", "position", name="uq_user_group_member_group_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    group_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("user_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    group = relationship("UserGroup", back_populates="member_links")
    user = relationship("User", back_populates="group_memberships")


class ExamAdminConfig(Base):
    __tablename__ = "exam_admin_configs"

    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), primary_key=True)
    code: Mapped[str | None] = mapped_column(String(32), unique=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    randomize_questions: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    report_displayed: Mapped[str] = mapped_column(String(64), nullable=False, server_default=text("'IMMEDIATELY_AFTER_GRADING'"))
    report_content: Mapped[str] = mapped_column(String(64), nullable=False, server_default=text("'SCORE_AND_DETAILS'"))
    fullscreen_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    tab_switch_detect: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    camera_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    mic_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    violation_threshold_warn: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("3"))
    violation_threshold_autosubmit: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("6"))

    exam = relationship("Exam", back_populates="admin_config")
    ui_columns = relationship("ExamUiColumn", back_populates="admin_config", cascade="all, delete-orphan", order_by="ExamUiColumn.position")


class ExamUiColumn(Base):
    __tablename__ = "exam_ui_columns"
    __table_args__ = (
        UniqueConstraint("exam_id", "position", name="uq_exam_ui_column_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_admin_configs.exam_id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    column_key: Mapped[str] = mapped_column(String(128), nullable=False)

    admin_config = relationship("ExamAdminConfig", back_populates="ui_columns")


class ExamRuntimeConfig(Base):
    __tablename__ = "exam_runtime_configs"

    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), primary_key=True)
    instructions: Mapped[str | None] = mapped_column(String(4000))
    instructions_heading: Mapped[str | None] = mapped_column(String(512))
    instructions_body: Mapped[str | None] = mapped_column(String(8000))
    completion_message: Mapped[str | None] = mapped_column(String(4000))
    instructions_require_acknowledgement: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    show_test_instructions: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    show_score_report: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    show_answer_review: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    show_correct_answers: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    allow_retake: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    retake_cooldown_hours: Mapped[float | None] = mapped_column(Float)
    auto_logout_after_finish_or_pause: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    creation_method: Mapped[str | None] = mapped_column(String(128))
    score_report_include_certificate_status: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    sequential_sections: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    allow_revisit_sections: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))

    exam = relationship("Exam", back_populates="runtime_config_rel")
    instruction_items = relationship("ExamRuntimeInstructionItem", back_populates="runtime_config", cascade="all, delete-orphan", order_by="ExamRuntimeInstructionItem.position")
    translations = relationship("ExamRuntimeTranslation", back_populates="runtime_config", cascade="all, delete-orphan", order_by="ExamRuntimeTranslation.locale")
    extra_settings = relationship("ExamRuntimeExtraSetting", back_populates="runtime_config", cascade="all, delete-orphan", order_by="ExamRuntimeExtraSetting.path")


class ExamRuntimeInstructionItem(Base):
    __tablename__ = "exam_runtime_instruction_items"
    __table_args__ = (
        UniqueConstraint("exam_id", "position", name="uq_exam_runtime_instruction_item_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_runtime_configs.exam_id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    text: Mapped[str] = mapped_column(String(2048), nullable=False)

    runtime_config = relationship("ExamRuntimeConfig", back_populates="instruction_items")


class ExamRuntimeTranslation(Base):
    __tablename__ = "exam_runtime_translations"
    __table_args__ = (
        UniqueConstraint("exam_id", "locale", name="uq_exam_runtime_translation_locale"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_runtime_configs.exam_id", ondelete="CASCADE"), nullable=False, index=True)
    locale: Mapped[str] = mapped_column(String(32), nullable=False)
    title: Mapped[str | None] = mapped_column(String(255))
    description: Mapped[str | None] = mapped_column(String(4000))
    instructions_body: Mapped[str | None] = mapped_column(String(4000))
    completion_message: Mapped[str | None] = mapped_column(String(4000))

    runtime_config = relationship("ExamRuntimeConfig", back_populates="translations")


class ExamRuntimeExtraSetting(Base):
    __tablename__ = "exam_runtime_extra_settings"
    __table_args__ = (
        UniqueConstraint("exam_id", "path", name="uq_exam_runtime_extra_setting_path"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_runtime_configs.exam_id", ondelete="CASCADE"), nullable=False, index=True)
    path: Mapped[str] = mapped_column(String(512), nullable=False)
    value_type: Mapped[str] = mapped_column(String(16), nullable=False)
    string_value: Mapped[str | None] = mapped_column(Text)
    integer_value: Mapped[int | None] = mapped_column(Integer)
    float_value: Mapped[float | None] = mapped_column(Float)
    boolean_value: Mapped[bool | None] = mapped_column(Boolean)

    runtime_config = relationship("ExamRuntimeConfig", back_populates="extra_settings")


class ExamCertificateConfig(Base):
    __tablename__ = "exam_certificate_configs"

    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), primary_key=True)
    title: Mapped[str | None] = mapped_column(String(255))
    subtitle: Mapped[str | None] = mapped_column(String(512))
    issuer: Mapped[str | None] = mapped_column(String(255))
    signer: Mapped[str | None] = mapped_column(String(255))

    exam = relationship("Exam", back_populates="certificate_config_rel")


class ExamProctoringConfig(Base):
    __tablename__ = "exam_proctoring_configs"

    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exams.id", ondelete="CASCADE"), primary_key=True)
    face_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    multi_face: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    audio_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    object_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    eye_tracking: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    head_pose_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    mouth_detection: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    face_verify: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    fullscreen_enforce: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    tab_switch_detect: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    screen_capture: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    copy_paste_block: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    eye_deviation_deg: Mapped[float | None] = mapped_column(Float)
    mouth_open_threshold: Mapped[float | None] = mapped_column(Float)
    audio_rms_threshold: Mapped[float | None] = mapped_column(Float)
    max_face_absence_sec: Mapped[int | None] = mapped_column(Integer)
    max_tab_blurs: Mapped[int | None] = mapped_column(Integer)
    max_alerts_before_autosubmit: Mapped[int | None] = mapped_column(Integer)
    max_fullscreen_exits: Mapped[int | None] = mapped_column(Integer)
    max_alt_tabs: Mapped[int | None] = mapped_column(Integer)
    lighting_min_score: Mapped[float | None] = mapped_column(Float)
    face_verify_id_threshold: Mapped[float | None] = mapped_column(Float)
    max_score_before_autosubmit: Mapped[int | None] = mapped_column(Integer)
    frame_interval_ms: Mapped[int | None] = mapped_column(Integer)
    audio_chunk_ms: Mapped[int | None] = mapped_column(Integer)
    screenshot_interval_sec: Mapped[int | None] = mapped_column(Integer)
    face_verify_threshold: Mapped[float | None] = mapped_column(Float)
    cheating_consecutive_frames: Mapped[int | None] = mapped_column(Integer)
    head_pose_consecutive: Mapped[int | None] = mapped_column(Integer)
    eye_consecutive: Mapped[int | None] = mapped_column(Integer)
    object_confidence_threshold: Mapped[float | None] = mapped_column(Float)
    audio_consecutive_chunks: Mapped[int | None] = mapped_column(Integer)
    audio_window: Mapped[int | None] = mapped_column(Integer)
    head_pose_yaw_deg: Mapped[float | None] = mapped_column(Float)
    head_pose_pitch_deg: Mapped[float | None] = mapped_column(Float)
    head_pitch_min_rad: Mapped[float | None] = mapped_column(Float)
    head_pitch_max_rad: Mapped[float | None] = mapped_column(Float)
    head_yaw_min_rad: Mapped[float | None] = mapped_column(Float)
    head_yaw_max_rad: Mapped[float | None] = mapped_column(Float)
    eye_pitch_min_rad: Mapped[float | None] = mapped_column(Float)
    eye_pitch_max_rad: Mapped[float | None] = mapped_column(Float)
    eye_yaw_min_rad: Mapped[float | None] = mapped_column(Float)
    eye_yaw_max_rad: Mapped[float | None] = mapped_column(Float)
    pose_change_threshold_rad: Mapped[float | None] = mapped_column(Float)
    eye_change_threshold_rad: Mapped[float | None] = mapped_column(Float)
    identity_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    camera_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    mic_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    fullscreen_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    lighting_required: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    access_mode: Mapped[str | None] = mapped_column(String(64))

    exam = relationship("Exam", back_populates="proctoring_config_rel")
    alert_rules = relationship("ExamProctoringAlertRule", back_populates="proctoring_config", cascade="all, delete-orphan", order_by="ExamProctoringAlertRule.position")


class ExamProctoringAlertRule(Base):
    __tablename__ = "exam_proctoring_alert_rules"
    __table_args__ = (
        UniqueConstraint("exam_id", "position", name="uq_exam_proctoring_alert_rule_position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    exam_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), ForeignKey("exam_proctoring_configs.exam_id", ondelete="CASCADE"), nullable=False, index=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    rule_key: Mapped[str | None] = mapped_column(String(128))
    event_type: Mapped[str] = mapped_column(String(128), nullable=False)
    threshold: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("1"))
    severity: Mapped[str] = mapped_column(String(32), nullable=False, server_default=text("'MEDIUM'"))
    action: Mapped[str] = mapped_column(String(32), nullable=False, server_default=text("'WARN'"))
    message: Mapped[str | None] = mapped_column(String(2048))

    proctoring_config = relationship("ExamProctoringConfig", back_populates="alert_rules")


class SystemSettings(Base):
    __tablename__ = "system_settings"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    key: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    value: Mapped[str | None] = mapped_column(String(4096))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
