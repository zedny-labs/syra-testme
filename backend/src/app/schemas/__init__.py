from datetime import datetime
from typing import Any, Generic, Literal, Optional, TypeVar
from uuid import UUID

from pydantic import AliasChoices, BaseModel, Field, EmailStr, field_validator, model_validator
from pydantic.config import ConfigDict

from ..models import (
    RoleEnum,
    CourseStatus,
    ExamType,
    ExamStatus,
    AttemptStatus,
    AccessMode,
    SeverityEnum,
    CategoryType,
)


class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class TokenRefresh(BaseModel):
    access_token: str
    token_type: str = "bearer"


class RefreshRequest(BaseModel):
    refresh_token: str


class Message(BaseModel):
    detail: str


class ProctoringVideoUploadResponse(BaseModel):
    detail: str
    file: dict[str, Any] | None = None
    job_id: str | None = None
    status: str | None = None
    analysis_status_url: str | None = None


class ProctoringJobStatusResponse(BaseModel):
    job_id: str
    status: str
    detail: str
    findings: list[dict[str, Any]] = Field(default_factory=list)
    summary: dict[str, Any] = Field(default_factory=dict)
    file: dict[str, Any] | None = None
    completed_at: datetime | str | None = None


T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int = 1
    page_size: int = 20
    search: str | None = None
    sort: str | None = None
    order: str = "desc"
    skip: int = 0
    limit: int = 20


class ReportScheduleRunResult(BaseModel):
    detail: str
    report_url: str
    email_status: str


class UserBase(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=255)
    user_id: str = Field(max_length=50)
    role: RoleEnum
    is_active: bool = True


class UserCreate(UserBase):
    password: str

    @field_validator("password")
    @classmethod
    def password_len(cls, v: str):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserRead(UserBase):
    id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UserUpdate(BaseModel):
    user_id: Optional[str] = Field(default=None, max_length=50)
    name: Optional[str] = Field(default=None, max_length=255)
    email: Optional[EmailStr] = None
    role: Optional[RoleEnum] = None
    is_active: Optional[bool] = None


class AdminUserPatch(BaseModel):
    user_id: Optional[str] = Field(default=None, max_length=50)
    name: Optional[str] = Field(default=None, max_length=255)
    email: Optional[EmailStr] = None
    role: Optional[RoleEnum] = None
    is_active: Optional[bool] = None


class UserSelfUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=255)
    email: Optional[EmailStr] = None


class UserPreferenceUpdate(BaseModel):
    value: Any = None


class UserPreferenceRead(BaseModel):
    key: str
    value: Any = None
    updated_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class AdminPasswordResetRequest(BaseModel):
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_min_length(cls, v: str) -> str:
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class CourseBase(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)
    status: CourseStatus = CourseStatus.DRAFT


class CourseCreate(CourseBase):
    node_titles: Optional[list[str]] = None


class CourseRead(CourseBase):
    id: UUID
    created_by_id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class NodeBase(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    order: int = 0


class NodeCreate(NodeBase):
    course_id: UUID


class NodeRead(NodeBase):
    id: UUID
    course_id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class CategoryBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    type: CategoryType = CategoryType.TEST
    description: Optional[str] = Field(default=None, max_length=1024)


class CategoryRead(CategoryBase):
    id: UUID

    model_config = ConfigDict(from_attributes=True)


class GradingScaleBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    labels: list[dict]

    @field_validator("labels")
    @classmethod
    def validate_bands(cls, v: list[dict]):
        ranges = sorted(((band.get("min_score"), band.get("max_score")) for band in v), key=lambda x: x[0])
        for i in range(1, len(ranges)):
            prev = ranges[i - 1]
            cur = ranges[i]
            if prev[1] is None or cur[0] is None:
                continue
            if cur[0] < prev[1]:
                raise ValueError("Grading bands overlap")
        return v


class GradingScaleRead(GradingScaleBase):
    id: UUID

    model_config = ConfigDict(from_attributes=True)


class QuestionBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str = Field(max_length=2048)
    type: ExamType = Field(
        validation_alias=AliasChoices("question_type", "type"),
        serialization_alias="question_type",
    )
    options: Optional[list[str]] = None
    correct_answer: Optional[str] = Field(default=None, max_length=255)
    points: float = 1.0
    order: int = 0
    pool_id: Optional[UUID] = None

    @field_validator("text")
    @classmethod
    def text_not_blank(cls, v: str):
        if not v or not v.strip():
            raise ValueError("Question text is required")
        return v.strip()

    @field_validator("options")
    @classmethod
    def normalize_options(cls, v: Optional[list[str]]):
        if v is None:
            return None
        cleaned = [opt.strip() for opt in v if opt and opt.strip()]
        return cleaned or None

    @field_validator("correct_answer")
    @classmethod
    def normalize_answer(cls, v: Optional[str]):
        if v is None:
            return None
        return v.strip()

    @field_validator("type")
    @classmethod
    def validate_type(cls, v: ExamType):
        return v

    @field_validator("points")
    @classmethod
    def validate_points(cls, v: float):
        if v is None or v < 0:
            raise ValueError("points must be greater than or equal to 0")
        return v

    @field_validator("order")
    @classmethod
    def validate_order(cls, v: int):
        if v < 0:
            raise ValueError("order must be greater than or equal to 0")
        return v

    @classmethod
    def _validate_mcq(cls, values):
        q_type: ExamType = values.get("type")
        options = values.get("options")
        correct = values.get("correct_answer")
        if q_type == ExamType.TRUEFALSE:
            if not options or len(options) < 2:
                values["options"] = ["True", "False"]
                options = values["options"]
            if not correct:
                raise ValueError("TRUEFALSE requires a correct_answer")
            valid_letters = {chr(65 + i) for i in range(len(options))}
            if correct not in valid_letters and correct not in options:
                raise ValueError("correct_answer must be a choice letter (A, B, ...) or option value")
        elif q_type in (ExamType.MCQ, ExamType.MULTI):
            if not options or len(options) < 2:
                raise ValueError("MCQ requires at least two options")
            if not correct:
                raise ValueError("MCQ requires a correct_answer")
            valid_letters = {chr(65 + i) for i in range(len(options))}
            if correct not in valid_letters and correct not in options:
                raise ValueError("correct_answer must be a choice letter (A, B, ...) or option value")
        return values

    @model_validator(mode="after")
    def validate_mcq_after(self):
        data = self.model_dump()
        self._validate_mcq(data)
        if data.get("options") != self.options:
            self.options = data["options"]
        return self


class QuestionCreate(QuestionBase):
    exam_id: UUID


class QuestionRead(QuestionBase):
    id: UUID
    exam_id: UUID
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ExamBase(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    # Frontend sends exam_type and time_limit_minutes; keep friendly aliases.
    node_id: Optional[UUID] = None
    title: str = Field(min_length=1, max_length=255)
    type: ExamType = Field(default=ExamType.MCQ, alias="exam_type")
    status: ExamStatus = ExamStatus.CLOSED
    time_limit: Optional[int] = Field(default=None, alias="time_limit_minutes")
    max_attempts: int = 1
    passing_score: Optional[float] = None
    proctoring_config: Optional[dict] = None
    category_id: Optional[UUID] = None
    grading_scale_id: Optional[UUID] = None
    description: Optional[str] = Field(default=None, max_length=4000)
    settings: Optional[dict] = None
    certificate: Optional[dict] = None

    @field_validator("time_limit")
    @classmethod
    def validate_exam_base_time_limit(cls, value: int | None):
        if value is not None and value <= 0:
            raise ValueError("time_limit_minutes must be greater than 0")
        return value

    @field_validator("passing_score")
    @classmethod
    def validate_exam_base_passing_score(cls, value: float | None):
        if value is not None and not 0 <= value <= 100:
            raise ValueError("passing_score must be between 0 and 100")
        return value

    @field_validator("max_attempts")
    @classmethod
    def validate_exam_base_max_attempts(cls, value: int):
        if value < 1:
            raise ValueError("max_attempts must be at least 1")
        return value


class ExamCreate(ExamBase):
    questions: Optional[list[QuestionCreate]] = None


class ExamUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    node_id: Optional[UUID] = None
    title: Optional[str] = Field(default=None, max_length=255)
    type: Optional[ExamType] = Field(default=None, alias="exam_type")
    status: Optional[ExamStatus] = None
    time_limit: Optional[int] = Field(default=None, alias="time_limit_minutes")
    max_attempts: Optional[int] = None
    passing_score: Optional[float] = None
    proctoring_config: Optional[dict] = None
    category_id: Optional[UUID] = None
    grading_scale_id: Optional[UUID] = None
    description: Optional[str] = Field(default=None, max_length=4000)
    settings: Optional[dict] = None
    certificate: Optional[dict] = None

    @field_validator("time_limit")
    @classmethod
    def validate_exam_update_time_limit(cls, value: int | None):
        if value is not None and value <= 0:
            raise ValueError("time_limit_minutes must be greater than 0")
        return value

    @field_validator("passing_score")
    @classmethod
    def validate_exam_update_passing_score(cls, value: float | None):
        if value is not None and not 0 <= value <= 100:
            raise ValueError("passing_score must be between 0 and 100")
        return value

    @field_validator("max_attempts")
    @classmethod
    def validate_exam_update_max_attempts(cls, value: int | None):
        if value is not None and value < 1:
            raise ValueError("max_attempts must be at least 1")
        return value


class ExamRead(ExamBase):
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: UUID
    question_count: int | None = None
    node_title: Optional[str] = None
    course_id: Optional[UUID] = None
    course_title: Optional[str] = None
    category_name: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    # Provide serialization aliases expected by the React admin UI.
    type: ExamType = Field(serialization_alias="exam_type")
    time_limit: Optional[int] = Field(default=None, serialization_alias="time_limit_minutes")


class AttemptBase(BaseModel):
    exam_id: UUID


class AttemptCreate(AttemptBase):
    pass


class AttemptRead(AttemptBase):
    id: UUID
    user_id: UUID
    status: AttemptStatus
    paused: bool = False
    high_violations: int = 0
    med_violations: int = 0
    score: Optional[float]
    grade: Optional[str] = None
    pending_manual_review: Optional[bool] = None
    started_at: Optional[datetime]
    submitted_at: Optional[datetime]
    identity_verified: bool
    precheck_passed_at: Optional[datetime] = None
    lighting_score: Optional[float] = None
    id_text: Optional[dict] = None
    created_at: datetime
    updated_at: datetime
    test_title: Optional[str] = None
    test_type: Optional[ExamType] = None
    test_time_limit: Optional[int] = None
    exam_title: Optional[str] = None
    exam_type: Optional[ExamType] = None
    exam_time_limit: Optional[int] = None
    node_id: Optional[UUID] = None
    attempts_used: Optional[int] = None
    attempts_remaining: Optional[int] = None
    user_name: Optional[str] = None
    user_student_id: Optional[str] = None
    selfie_path: Optional[str] = None
    id_doc_path: Optional[str] = None
    certificate_eligible: Optional[bool] = None
    certificate_issue_rule: Optional[str] = None
    certificate_review_status: Optional[str] = None
    certificate_reviewed_at: Optional[datetime] = None
    certificate_block_reason: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


class AttemptAnswerBase(BaseModel):
    question_id: UUID
    answer: Optional[str | list | dict] = None

    @field_validator("answer")
    @classmethod
    def validate_answer_length(cls, v):
        if isinstance(v, str) and len(v) > 2048:
            raise ValueError("Answer must not exceed 2048 characters")
        return v


class AttemptCertificateReviewUpdate(BaseModel):
    decision: Literal["APPROVED", "REJECTED"]


class AttemptAnswerRead(AttemptAnswerBase):
    id: UUID
    attempt_id: UUID
    question_text: Optional[str] = None
    is_correct: Optional[bool]
    points_earned: Optional[float]

    model_config = ConfigDict(from_attributes=True)


class AttemptAnswerReviewUpdate(BaseModel):
    points_earned: float


class AttemptResolveRequest(AttemptBase):
    pass


class ScheduleBase(BaseModel):
    exam_id: Optional[UUID] = None
    test_id: Optional[UUID] = None
    user_id: UUID
    scheduled_at: datetime
    access_mode: AccessMode = AccessMode.OPEN
    notes: Optional[str] = Field(default=None, max_length=512)

    @model_validator(mode="after")
    def validate_target(self):
        if not self.exam_id and not self.test_id:
            raise ValueError("Either exam_id or test_id is required")
        if self.exam_id and self.test_id and self.exam_id != self.test_id:
            raise ValueError("exam_id and test_id must reference the same test")
        if self.exam_id is None and self.test_id is not None:
            self.exam_id = self.test_id
        return self


class ScheduleRead(ScheduleBase):
    id: UUID
    created_at: datetime
    updated_at: datetime
    user_name: Optional[str] = None
    user_student_id: Optional[str] = None
    test_title: Optional[str] = None
    exam_title: Optional[str] = None
    exam_type: Optional[ExamType] = None
    exam_time_limit: Optional[int] = None
    test_name: Optional[str] = None
    test_type: Optional[str] = None
    test_time_limit: Optional[int] = None

    model_config = ConfigDict(from_attributes=True)

    @model_validator(mode="after")
    def validate_target(self):
        # Skip the parent validator for response models — exam_id can be null
        # for orphaned schedules or during response serialization.
        return self


class QuestionPoolBase(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)


class QuestionPoolCreate(QuestionPoolBase):
    pass


class QuestionPoolRead(QuestionPoolBase):
    id: UUID
    created_by_id: Optional[UUID] = None
    question_count: int = 0

    model_config = ConfigDict(from_attributes=True)


class ProctoringEventRead(BaseModel):
    id: UUID
    attempt_id: UUID
    event_type: str
    severity: SeverityEnum
    detail: Optional[str]
    ai_confidence: Optional[float]
    meta: Optional[dict]
    occurred_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ProctoringRuleAlert(BaseModel):
    event_type: str
    severity: SeverityEnum
    detail: str
    action: str | None = None
    rule_id: str | None = None
    threshold: int | None = None
    actual_count: int | None = None


class ProctoringPingResponse(BaseModel):
    detail: str
    alerts: list[ProctoringRuleAlert] = Field(default_factory=list)
    forced_submit: bool = False
    submit_reason: Optional[str] = None


class AttemptProctoringSummaryRead(BaseModel):
    total_events: int = 0
    severity_counts: dict[str, int] = Field(default_factory=dict)
    serious_alerts: int = 0
    risk_score: int = 0
    saved_recordings: int = 0
    expected_recordings: int = 0
    recent_events: list[ProctoringEventRead] = Field(default_factory=list)


class DashboardSeriesPointRead(BaseModel):
    key: str
    label: str
    value: int


class DashboardTopTestRead(BaseModel):
    exam_id: UUID
    title: str
    attempts: int = 0
    scored_attempts: int = 0
    average_score: Optional[float] = None
    passed_attempts: int = 0
    pass_rate: float = 0
    high_risk_attempts: int = 0
    flagged_attempts: int = 0


class DashboardFlaggedAttemptRead(BaseModel):
    id: UUID
    exam_id: UUID
    user_id: UUID
    status: AttemptStatus
    score: Optional[float] = None
    user_name: Optional[str] = None
    user_student_id: Optional[str] = None
    test_title: Optional[str] = None
    started_at: Optional[datetime] = None
    submitted_at: Optional[datetime] = None
    high_violations: int = 0
    med_violations: int = 0
    integrity_score: int = 100
    risk_level: str = "CLEAN"


class DashboardRead(BaseModel):
    total_exams: int
    total_tests: int = 0
    total_users: int = 0
    total_learners: int = 0
    total_admins: int = 0
    total_instructors: int = 0
    active_users: int = 0
    published_tests: int = 0
    open_tests: int = 0
    closed_tests: int = 0
    total_attempts: int
    in_progress_attempts: int
    completed_attempts: int
    best_score: Optional[float]
    average_score: Optional[float]
    pass_rate: float = 0
    awaiting_review_attempts: int = 0
    high_risk_attempts: int = 0
    medium_risk_attempts: int = 0
    upcoming_count: int
    upcoming_schedules: list[ScheduleRead]
    attempt_status_breakdown: list[DashboardSeriesPointRead] = Field(default_factory=list)
    score_distribution: list[DashboardSeriesPointRead] = Field(default_factory=list)
    role_distribution: list[DashboardSeriesPointRead] = Field(default_factory=list)
    test_status_breakdown: list[DashboardSeriesPointRead] = Field(default_factory=list)
    recent_attempt_trend: list[DashboardSeriesPointRead] = Field(default_factory=list)
    top_tests: list[DashboardTopTestRead] = Field(default_factory=list)
    recent_flagged_attempts: list[DashboardFlaggedAttemptRead] = Field(default_factory=list)
    generated_at: Optional[datetime] = None


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_len(cls, v: str):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def password_len(cls, v: str):
        if len(v) < 8:
            raise ValueError("Password must be at least 8 characters")
        return v


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class NotificationRead(BaseModel):
    id: UUID
    user_id: UUID
    title: str
    message: str
    is_read: bool
    link: Optional[str]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AuditLogUserInfo(BaseModel):
    email: str
    name: str

    model_config = ConfigDict(from_attributes=True)


class AuditLogRead(BaseModel):
    id: UUID
    user_id: Optional[UUID]
    action: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    detail: Optional[str]
    ip_address: Optional[str]
    created_at: datetime
    user: Optional[AuditLogUserInfo] = None

    model_config = ConfigDict(from_attributes=True)


class SurveyCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2048)
    questions: Optional[list[dict]] = None


class SurveyUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = Field(default=None, max_length=2048)
    questions: Optional[list[dict]] = None
    is_active: Optional[bool] = None


class SurveyRead(BaseModel):
    id: UUID
    title: str
    description: Optional[str]
    questions: Optional[list[dict]]
    is_active: bool
    created_by_id: Optional[UUID]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SurveyResponseCreate(BaseModel):
    survey_id: UUID
    answers: Optional[dict] = None


class SurveyResponseRead(BaseModel):
    id: UUID
    survey_id: UUID
    user_id: UUID
    answers: Optional[dict]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class UserGroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)
    member_ids: Optional[list[str]] = None


class UserGroupRead(BaseModel):
    id: UUID
    name: str
    description: Optional[str]
    member_ids: Optional[list]
    member_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ExamTemplateCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: Optional[str] = Field(default=None, max_length=1024)
    config: Optional[dict] = None


class ExamTemplateRead(BaseModel):
    id: UUID
    name: str
    description: Optional[str]
    config: Optional[dict]
    created_by_id: Optional[UUID]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ReportScheduleCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    report_type: str = Field(max_length=100)
    schedule_cron: Optional[str] = None
    recipients: Optional[list[str]] = None
    is_active: bool = True


class ReportScheduleRead(BaseModel):
    id: UUID
    name: str
    report_type: str
    schedule_cron: Optional[str]
    recipients: Optional[list]
    is_active: bool
    last_run_at: Optional[datetime]
    created_by_id: Optional[UUID]
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class ScheduleUpdate(BaseModel):
    scheduled_at: Optional[datetime] = None
    access_mode: Optional[AccessMode] = None
    notes: Optional[str] = None


class CustomReportExportRequest(BaseModel):
    dataset: str
    columns: list[str]
    search: Optional[str] = None

    @field_validator("columns")
    @classmethod
    def validate_columns(cls, v: list[str]):
        cleaned = []
        seen = set()
        for raw in v or []:
            column = str(raw or "").strip()
            if not column or column in seen:
                continue
            seen.add(column)
            cleaned.append(column)
        if not cleaned:
            raise ValueError("At least one column is required")
        return cleaned


class CustomReportPreview(BaseModel):
    rows: list[dict[str, Any]]
    total: int
    available_columns: list[str]


class SystemSettingRead(BaseModel):
    id: UUID
    key: str
    value: Optional[str]
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class SystemSettingUpdate(BaseModel):
    value: Optional[str] = Field(default=None, max_length=4096)
