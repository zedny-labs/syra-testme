import asyncio
import base64
import inspect
import json
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from fastapi.testclient import TestClient
from fastapi import HTTPException
from pydantic import ValidationError

from src.app.main import app, _maintenance_blocks_request, REQUIRED_API_ROUTES
from src.app.api import deps as api_deps
from src.app.api.routes import admin_settings as admin_settings_routes
from src.app.api.routes import auth as auth_routes
from src.app.api.routes import attempts as attempts_routes
from src.app.api.routes import categories as categories_routes
from src.app.api.routes import courses as courses_routes
from src.app.api.routes import exams as exams_routes
from src.app.api.routes import exam_templates as exam_templates_routes
from src.app.api.routes import grading_scales as grading_scales_routes
from src.app.api.routes import nodes as nodes_routes
from src.app.api.routes import precheck as precheck_routes
from src.app.api.routes import question_pools as question_pools_routes
from src.app.api.routes import questions as questions_routes
from src.app.api.routes import report_schedules as report_schedules_routes
from src.app.api.routes import reports as reports_routes
from src.app.api.routes import schedules as schedules_routes
from src.app.api.routes import surveys as surveys_routes
from src.app.api.routes import user_groups as user_groups_routes
from src.app.api.routes import users as users_routes
from src.app.detection.orchestrator import ProctoringOrchestrator
from src.app.modules.tests.proctoring_requirements import get_proctoring_requirements
from src.app.models import AccessMode, Attempt, AttemptAnswer, CourseStatus, Exam, ExamStatus, ExamType, Question, RoleEnum
from src.app.schemas import AttemptAnswerBase, QuestionCreate, QuestionRead, ScheduleUpdate, UserPreferenceUpdate


client = TestClient(app)


def _run(coro_or_value):
    """Call a route handler that may be sync (def) or async (async def).

    Route handlers were converted from async def to def so FastAPI runs them
    in a thread pool.  Tests that called them via asyncio.run() would break
    because plain function calls return values, not coroutines.  This helper
    handles both: if the result is a coroutine it runs it, otherwise it
    returns it directly.
    """
    if inspect.iscoroutine(coro_or_value):
        return asyncio.run(coro_or_value)
    return coro_or_value


def test_required_routes_registered():
    registered = {getattr(route, "path", "") for route in app.router.routes}
    missing = [path for path in REQUIRED_API_ROUTES if path not in registered]
    assert missing == []


def test_fullscreen_only_config_does_not_require_identity():
    req = get_proctoring_requirements({"fullscreen_required": True})
    assert req["system_check_required"] is True
    assert req["identity_required"] is False


def test_face_detection_does_not_imply_lighting_check():
    req = get_proctoring_requirements({"face_detection": True})
    assert req["identity_required"] is False
    assert req["camera_required"] is True
    assert req["lighting_required"] is False


def test_proctoring_orchestrator_uses_configured_object_and_audio_thresholds():
    orchestrator = ProctoringOrchestrator({
        "object_confidence_threshold": 0.72,
        "audio_rms_threshold": 0.11,
        "audio_consecutive_chunks": 4,
        "audio_window": 7,
    })
    assert orchestrator.object_detector.confidence_threshold == 0.72
    assert orchestrator.audio_monitor.noise_threshold == 0.11
    assert orchestrator.audio_monitor.consecutive_threshold == 4
    assert orchestrator.audio_monitor.window == 7


def test_submit_attempt_skips_identity_gate_for_fullscreen_only_proctoring():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    attempt = Attempt(
        id=attempt_id,
        exam_id=exam_id,
        user_id=user_id,
        status=attempts_routes.AttemptStatus.IN_PROGRESS,
        id_verified=False,
        identity_verified=False,
        created_at=now,
        updated_at=now,
    )
    attempt.__dict__["exam"] = SimpleNamespace(proctoring_config={"fullscreen_required": True}, settings={})
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummyScalarResult:
        @staticmethod
        def all():
            return []

    class DummySession:
        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            return None

        def scalars(self, _query):
            return DummyScalarResult()

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    out = _run(
        attempts_routes.submit_attempt(
            str(attempt_id),
            db=DummySession(),
            current=current_user,
        )
    )
    assert out.status == attempts_routes.AttemptStatus.SUBMITTED


def test_precheck_allows_system_only_checks_without_identity_images():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    attempt = Attempt(id=attempt_id, user_id=user_id)
    attempt.__dict__["exam"] = SimpleNamespace(
        proctoring_config={
            "fullscreen_required": True,
            "camera_required": False,
            "mic_required": False,
            "identity_required": False,
        }
    )
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummySession:
        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

    out = _run(
        precheck_routes.precheck(
            str(attempt_id),
            payload={"fs_ok": True},
            db=DummySession(),
            current=current_user,
        )
    )
    assert out["all_pass"] is True
    assert attempt.identity_verified is True


def test_precheck_face_crop_uses_detected_face_region_instead_of_center_crop(monkeypatch):
    import numpy as np

    img = np.zeros((100, 200, 3), dtype=np.uint8)
    img[10:50, 130:170] = 255

    monkeypatch.setattr(precheck_routes, "_largest_face_box", lambda _img: (130, 10, 40, 40))

    crop = precheck_routes._extract_face_crop(img)

    assert crop is not None
    assert crop.shape[0] > 0 and crop.shape[1] > 0
    assert crop.shape[0] < img.shape[0]
    assert crop.shape[1] < img.shape[1]
    assert int(crop.max()) == 255


def test_ocr_falls_back_to_easyocr_when_tesseract_is_unavailable(monkeypatch):
    import numpy as np

    class DummyReader:
        def __init__(self, langs, gpu):
            assert langs == ["en"]
            assert gpu is False

        def readtext(self, _img, detail=0):
            assert detail == 0
            return ["ID NUMBER", "A1234567"]

    monkeypatch.setattr(precheck_routes, "pytesseract", None)
    monkeypatch.setattr(precheck_routes, "easyocr", SimpleNamespace(Reader=DummyReader))
    monkeypatch.setattr(precheck_routes, "_EASYOCR_READER", None)
    monkeypatch.setattr(precheck_routes, "_EASYOCR_INIT_ATTEMPTED", False)

    out = precheck_routes._tesseract_text(np.zeros((32, 32, 3), dtype=np.uint8))

    assert out["available"] is True
    assert out["engine"] == "easyocr"
    assert out["lines"] == ["ID NUMBER", "A1234567"]


def test_invalid_token_returns_401_on_protected_endpoint():
    res = client.get("/api/exams/", headers={"Authorization": "Bearer definitely-not-a-token"})
    assert res.status_code == 401
    assert res.json().get("detail") == "Invalid token"


def test_malformed_token_returns_401_on_protected_endpoint():
    res = client.get("/api/exams/", headers={"Authorization": "Bearer a.b.c"})
    assert res.status_code == 401
    assert res.json().get("detail") == "Invalid token"


def test_learner_can_access_exam_accepts_past_naive_schedule():
    exam_id = uuid.uuid4()
    learner_id = uuid.uuid4()
    exam = SimpleNamespace(id=exam_id, status=ExamStatus.OPEN)
    learner = SimpleNamespace(id=learner_id, role=RoleEnum.LEARNER)
    past_schedule = SimpleNamespace(scheduled_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).replace(tzinfo=None))

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalar(self, _query):
            self.calls += 1
            if self.calls == 1:
                return past_schedule
            return 1

    assert api_deps.learner_can_access_exam(DummySession(), exam, learner) is True


def test_attempt_access_accepts_past_naive_schedule():
    exam_id = uuid.uuid4()
    learner_id = uuid.uuid4()
    exam = SimpleNamespace(id=exam_id, status=ExamStatus.OPEN)
    learner = SimpleNamespace(id=learner_id, role=RoleEnum.LEARNER)
    past_schedule = SimpleNamespace(scheduled_at=(datetime.now(timezone.utc) - timedelta(minutes=5)).replace(tzinfo=None))

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalar(self, _query):
            self.calls += 1
            if self.calls == 1:
                return past_schedule
            return 1

    assert attempts_routes._enforce_attempt_access(DummySession(), exam, learner) is past_schedule


def test_list_exams_orders_newest_first():
    learner = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.LEARNER)

    class DummyScalarResult:
        @staticmethod
        def all():
            return []

    class DummyExecuteResult:
        @staticmethod
        def all():
            return []

        def unique(self):
            return self

        def scalars(self):
            return self

    class DummySession:
        def __init__(self):
            self.query = None

        def scalar(self, query):
            return 0

        def scalars(self, query):
            self.query = query
            return DummyScalarResult()

        def execute(self, query):
            self.query = query
            return DummyExecuteResult()

    session = DummySession()
    out = _run(exams_routes.list_exams(db=session, current=learner))
    assert out == {"items": [], "total": 0, "skip": 0, "limit": 50}
    assert [str(clause) for clause in session.query._order_by_clauses] == [
        "exams.updated_at DESC",
        "exams.created_at DESC",
    ]


def test_list_exams_applies_custom_search_and_sort_for_learner():
    learner = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.LEARNER)

    class DummyScalarResult:
        @staticmethod
        def all():
            return []

    class DummyExecuteResult:
        @staticmethod
        def all():
            return []

        def unique(self):
            return self

        def scalars(self):
            return self

    class DummySession:
        def __init__(self):
            self.query = None
            self.scalar_calls = 0

        def scalar(self, _query):
            self.scalar_calls += 1
            return 0

        def execute(self, query):
            self.query = query
            return DummyExecuteResult()

    session = DummySession()
    out = _run(
        exams_routes.list_exams(
            db=session,
            current=learner,
            page=3,
            page_size=7,
            search="  Algebra  ",
            sort="title",
            order="asc",
        )
    )

    assert out == {"items": [], "total": 0, "skip": 14, "limit": 7}
    assert [str(clause) for clause in session.query._order_by_clauses] == [
        "exams.title ASC",
        "exams.created_at DESC",
    ]
    query_text = str(session.query)
    assert "exams.status" in query_text.lower()
    assert ":status_" in query_text
    normalized_query_text = query_text.lower()
    # The learner catalog scopes to scheduled exams via a JOIN against the
    # learner's own schedules (replaced the earlier EXISTS subquery during the
    # query refactor); the access semantics are unchanged.
    assert "schedules.user_id" in normalized_query_text
    assert "schedules.scheduled_at" in normalized_query_text
    assert "lower(exams.title)" in normalized_query_text


def test_list_exams_prefers_page_over_skip_when_both_provided():
    learner = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.LEARNER)

    class DummyScalarResult:
        @staticmethod
        def all():
            return []

    class DummyExecuteResult:
        @staticmethod
        def all():
            return []

        def unique(self):
            return self

        def scalars(self):
            return self

    class DummySession:
        def __init__(self):
            self.query = None

        def scalar(self, _query):
            return 0

        def execute(self, query):
            self.query = query
            return DummyExecuteResult()

    session = DummySession()
    out = _run(
        exams_routes.list_exams(
            db=session,
            current=learner,
            page=2,
            page_size=5,
            skip=99,
            limit=1,
        )
    )

    assert out["skip"] == 5
    assert out["limit"] == 5
    assert [str(clause) for clause in session.query._order_by_clauses] == [
        "exams.updated_at DESC",
        "exams.created_at DESC",
    ]


def test_list_exams_does_not_apply_learner_schedule_filters_for_admin():
    admin = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)

    class DummyScalarResult:
        @staticmethod
        def all():
            return []

    class DummyExecuteResult:
        @staticmethod
        def all():
            return []

    class DummySession:
        def __init__(self):
            self.query = None
            self.calls = 0

        def scalar(self, _query):
            self.calls += 1
            if self.calls == 1:
                return SimpleNamespace(
                    value='[{"feature":"Edit Tests","admin":true,"instructor":true,"learner":false}]',
                )
            return 0

        def execute(self, query):
            self.query = query
            return DummyExecuteResult()

    session = DummySession()
    out = _run(
        exams_routes.list_exams(
            db=session,
            current=admin,
            page=1,
            page_size=20,
            search=None,
            sort="updated_at",
            order="desc",
        )
    )

    assert out == {"items": [], "total": 0, "skip": 0, "limit": 20}
    query_text = str(session.query)
    assert "exams.status = :status_1" not in query_text
    assert "exists (select" not in query_text.lower()
    assert "exams.created_by_id" in query_text
    query_text = str(session.query)
    assert "exams.status = :status_1" not in query_text
    assert "exists (select" not in query_text.lower()
    assert "exams.library_pool_id IS NULL" in query_text


def test_create_attempt_blocks_retake_when_disabled():
    learner_id = uuid.uuid4()
    exam = SimpleNamespace(
        id=uuid.uuid4(),
        status=ExamStatus.OPEN,
        max_attempts=2,
        settings={"allow_retake": False},
    )
    learner = SimpleNamespace(id=learner_id, role=RoleEnum.LEARNER)
    completed_attempt = SimpleNamespace(
        status=attempts_routes.AttemptStatus.SUBMITTED,
        submitted_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        updated_at=datetime.now(timezone.utc) - timedelta(minutes=10),
        created_at=datetime.now(timezone.utc) - timedelta(minutes=15),
    )
    assigned_schedule = SimpleNamespace(
        scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=30),
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.scalar_calls = 0

        def scalar(self, _query):
            self.scalar_calls += 1
            if self.scalar_calls == 1:
                return assigned_schedule
            return 0

        def scalars(self, _query):
            return DummyScalarResult([completed_attempt])

    try:
        attempts_routes._create_attempt_record(DummySession(), exam, learner)
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Retakes are disabled for this test"
    else:
        raise AssertionError("Expected HTTPException")


def test_create_attempt_blocks_retake_until_cooldown_expires():
    learner_id = uuid.uuid4()
    exam = SimpleNamespace(
        id=uuid.uuid4(),
        status=ExamStatus.OPEN,
        max_attempts=2,
        settings={"allow_retake": True, "retake_cooldown_hours": 1},
    )
    learner = SimpleNamespace(id=learner_id, role=RoleEnum.LEARNER)
    completed_attempt = SimpleNamespace(
        status=attempts_routes.AttemptStatus.SUBMITTED,
        submitted_at=datetime.now(timezone.utc) - timedelta(minutes=15),
        updated_at=datetime.now(timezone.utc) - timedelta(minutes=15),
        created_at=datetime.now(timezone.utc) - timedelta(minutes=20),
    )
    assigned_schedule = SimpleNamespace(
        scheduled_at=datetime.now(timezone.utc) - timedelta(minutes=30),
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.scalar_calls = 0

        def scalar(self, _query):
            self.scalar_calls += 1
            if self.scalar_calls == 1:
                return assigned_schedule
            return 0

        def scalars(self, _query):
            return DummyScalarResult([completed_attempt])

    try:
        attempts_routes._create_attempt_record(DummySession(), exam, learner)
    except HTTPException as exc:
        assert exc.status_code == 400
        assert "Retake available in" in exc.detail
    else:
        raise AssertionError("Expected HTTPException")


def test_auto_score_attempt_counts_skipped_questions_in_denominator():
    exam_id = uuid.uuid4()
    attempt_id = uuid.uuid4()
    question_1_id = uuid.uuid4()
    question_2_id = uuid.uuid4()

    attempt = Attempt(id=attempt_id, exam_id=exam_id)
    attempt.__dict__["exam"] = SimpleNamespace(settings={})
    answer = AttemptAnswer(attempt_id=attempt_id, question_id=question_1_id, answer="A")
    question_one = Question(
        id=question_1_id,
        exam_id=exam_id,
        text="Question 1",
        type=ExamType.MCQ,
        options=["A", "B"],
        correct_answer="A",
        points=1,
        order=0,
    )
    question_two = Question(
        id=question_2_id,
        exam_id=exam_id,
        text="Question 2",
        type=ExamType.MCQ,
        options=["A", "B"],
        correct_answer="A",
        points=1,
        order=1,
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([answer])
            return DummyScalarResult([question_one, question_two])

        def add(self, _obj):
            pass

    result = attempts_routes._auto_score_attempt(attempt, DummySession())

    assert result["pending_manual_review"] is False
    assert result["score"] == 50.0
    assert answer.is_correct is True
    assert answer.points_earned == 1.0


def test_auto_score_attempt_keeps_text_answers_pending_manual_review():
    exam_id = uuid.uuid4()
    attempt_id = uuid.uuid4()
    text_question_id = uuid.uuid4()
    mcq_question_id = uuid.uuid4()

    attempt = Attempt(id=attempt_id, exam_id=exam_id)
    attempt.__dict__["exam"] = SimpleNamespace(settings={})
    text_answer = AttemptAnswer(attempt_id=attempt_id, question_id=text_question_id, answer="A long explanation")
    mcq_answer = AttemptAnswer(attempt_id=attempt_id, question_id=mcq_question_id, answer="A")
    text_question = Question(
        id=text_question_id,
        exam_id=exam_id,
        text="Explain why",
        type=ExamType.TEXT,
        correct_answer="Reference guidance",
        points=5,
        order=0,
    )
    mcq_question = Question(
        id=mcq_question_id,
        exam_id=exam_id,
        text="Choose one",
        type=ExamType.MCQ,
        options=["A", "B"],
        correct_answer="A",
        points=1,
        order=1,
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([text_answer, mcq_answer])
            return DummyScalarResult([text_question, mcq_question])

        def add(self, _obj):
            pass

    result = attempts_routes._auto_score_attempt(attempt, DummySession())

    assert result["pending_manual_review"] is True
    assert result["score"] == 16.67
    assert text_answer.is_correct is None
    assert text_answer.points_earned is None
    assert mcq_answer.is_correct is True
    assert mcq_answer.points_earned == 1.0


def test_evaluate_answer_handles_ordering_matching_and_fill_in_blank_types():
    ordering_question = Question(
        id=uuid.uuid4(),
        exam_id=uuid.uuid4(),
        text="Sort the items",
        type=ExamType.ORDERING,
        correct_answer='["A","B","C"]',
        points=2,
        order=0,
    )
    matching_question = Question(
        id=uuid.uuid4(),
        exam_id=uuid.uuid4(),
        text="Match the pairs",
        type=ExamType.MATCHING,
        correct_answer='{"1":"A","2":"B"}',
        points=2,
        order=1,
    )
    fill_blank_question = Question(
        id=uuid.uuid4(),
        exam_id=uuid.uuid4(),
        text="Fill the blanks",
        type=ExamType.FILLINBLANK,
        correct_answer='["Alpha","Beta"]',
        points=2,
        order=2,
    )

    ordering_result = attempts_routes._evaluate_answer(ordering_question, '["a", "b", "c"]')
    matching_result = attempts_routes._evaluate_answer(matching_question, '{"2":"b","1":"a"}')
    fill_blank_result = attempts_routes._evaluate_answer(fill_blank_question, 'alpha|beta')

    assert ordering_result == (True, 2.0)
    assert matching_result == (True, 2.0)
    assert fill_blank_result == (True, 2.0)


def test_grade_attempt_preserves_original_submission_timestamp():
    attempt_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    submitted_at = datetime.now(timezone.utc) - timedelta(minutes=30)
    attempt = Attempt(
        id=attempt_id,
        exam_id=exam_id,
        user_id=uuid.uuid4(),
        status=attempts_routes.AttemptStatus.SUBMITTED,
        score=None,
        identity_verified=False,
        created_at=submitted_at - timedelta(minutes=10),
        updated_at=submitted_at,
        submitted_at=submitted_at,
    )
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    # Per-admin isolation: the grader must own the exam behind the attempt.
    owned_exam = Exam(id=exam_id, created_by_id=current_user.id)

    class DummySession:
        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            if model is Exam and key == exam_id:
                return owned_exam
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    out = _run(
        attempts_routes.grade_attempt(
            str(attempt_id),
            score=88.5,
            db=DummySession(),
            current=current_user,
        )
    )

    assert out.status == attempts_routes.AttemptStatus.GRADED
    assert out.score == 88.5
    assert attempt.submitted_at == submitted_at


def test_pool_questions_fallback_to_legacy_library_exam_when_pool_id_links_are_missing():
    pool_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    pool = SimpleNamespace(id=pool_id, name="Legacy Pool", description=None, created_by_id=uuid.uuid4())
    library_exam = SimpleNamespace(id=exam_id, settings={"_pool_library": {"pool_id": str(pool_id)}}, created_at=datetime.now(timezone.utc))
    legacy_question = Question(
        id=uuid.uuid4(),
        exam_id=exam_id,
        text="Legacy pooled question",
        type=ExamType.MCQ,
        options=["A", "B"],
        correct_answer="A",
        points=1,
        order=0,
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([])
            if self.calls == 2:
                return DummyScalarResult([library_exam])
            return DummyScalarResult([legacy_question])

    questions = question_pools_routes._load_pool_questions(DummySession(), pool.id)

    assert questions == [legacy_question]


def test_serialize_pool_includes_question_count():
    pool = SimpleNamespace(id=uuid.uuid4(), name="Reusable Pool", description="desc", created_by_id=uuid.uuid4())
    question = Question(
        id=uuid.uuid4(),
        exam_id=uuid.uuid4(),
        text="How many bits are in a byte?",
        type=ExamType.MCQ,
        options=["8", "16"],
        correct_answer="A",
        points=1,
        order=0,
        pool_id=pool.id,
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.calls = 0

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([question])
            return DummyScalarResult([])

    serialized = question_pools_routes._serialize_pool(pool, DummySession())

    assert serialized.question_count == 1


def test_review_attempt_answer_and_finalize_review_publish_score():
    attempt_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    text_question_id = uuid.uuid4()
    mcq_question_id = uuid.uuid4()
    answer_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    attempt = Attempt(
        id=attempt_id,
        exam_id=exam_id,
        user_id=uuid.uuid4(),
        status=attempts_routes.AttemptStatus.SUBMITTED,
        score=None,
        identity_verified=False,
        created_at=now - timedelta(minutes=25),
        updated_at=now - timedelta(minutes=5),
        submitted_at=now - timedelta(minutes=4),
    )
    text_question = Question(
        id=text_question_id,
        exam_id=exam_id,
        text="Explain why",
        type=ExamType.TEXT,
        correct_answer="Reference guidance",
        points=5,
        order=0,
    )
    mcq_question = Question(
        id=mcq_question_id,
        exam_id=exam_id,
        text="Choose one",
        type=ExamType.MCQ,
        options=["A", "B"],
        correct_answer="A",
        points=1,
        order=1,
    )
    text_answer = AttemptAnswer(
        id=answer_id,
        attempt_id=attempt_id,
        question_id=text_question_id,
        answer="Detailed response",
        is_correct=None,
        points_earned=None,
    )
    text_answer.__dict__["question"] = text_question
    mcq_answer = AttemptAnswer(
        attempt_id=attempt_id,
        question_id=mcq_question_id,
        answer="A",
        is_correct=True,
        points_earned=1.0,
    )
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    # Per-admin isolation: the reviewer must own the exam behind the attempt.
    owned_exam = Exam(id=exam_id, created_by_id=current_user.id)

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class ReviewSession:
        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            if model is Exam and key == exam_id:
                return owned_exam
            return None

        def scalar(self, _query):
            return text_answer

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    review_out = _run(
        attempts_routes.review_attempt_answer(
            str(attempt_id),
            str(answer_id),
            attempts_routes.AttemptAnswerReviewUpdate(points_earned=4),
            db=ReviewSession(),
            current=current_user,
        )
    )

    assert review_out.points_earned == 4
    assert text_answer.points_earned == 4

    class FinalizeSession:
        def __init__(self):
            self.calls = 0

        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            if model is Exam and key == exam_id:
                return owned_exam
            return None

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([text_answer, mcq_answer])
            if self.calls == 2:
                return DummyScalarResult([text_answer, mcq_answer])
            if self.calls == 3:
                return DummyScalarResult([text_question, mcq_question])
            return DummyScalarResult([])

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    finalize_out = _run(
        attempts_routes.finalize_attempt_review(
            str(attempt_id),
            db=FinalizeSession(),
            current=current_user,
        )
    )

    assert finalize_out.status == attempts_routes.AttemptStatus.GRADED
    assert finalize_out.score == 83.33
    assert attempt.status == attempts_routes.AttemptStatus.GRADED


def test_finalize_attempt_review_requires_all_manual_answers_to_be_scored():
    attempt_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    question_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    attempt = Attempt(
        id=attempt_id,
        exam_id=exam_id,
        user_id=uuid.uuid4(),
        status=attempts_routes.AttemptStatus.SUBMITTED,
        score=None,
        identity_verified=False,
        created_at=now - timedelta(minutes=10),
        updated_at=now - timedelta(minutes=5),
        submitted_at=now - timedelta(minutes=4),
    )
    text_question = Question(
        id=question_id,
        exam_id=exam_id,
        text="Explain why",
        type=ExamType.TEXT,
        correct_answer="Reference guidance",
        points=5,
        order=0,
    )
    text_answer = AttemptAnswer(
        attempt_id=attempt_id,
        question_id=question_id,
        answer="Detailed response",
        is_correct=None,
        points_earned=None,
    )
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    # Per-admin isolation: the reviewer must own the exam behind the attempt.
    owned_exam = Exam(id=exam_id, created_by_id=current_user.id)

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def __init__(self):
            self.calls = 0

        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            if model is Exam and key == exam_id:
                return owned_exam
            return None

        def scalars(self, _query):
            self.calls += 1
            if self.calls == 1:
                return DummyScalarResult([text_answer])
            if self.calls == 2:
                return DummyScalarResult([text_answer])
            return DummyScalarResult([text_question])

    try:
        _run(
            attempts_routes.finalize_attempt_review(
                str(attempt_id),
                db=DummySession(),
                current=current_user,
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "Review all manual answers before finalizing"
    else:
        raise AssertionError("Expected HTTPException")


def test_invalid_refresh_token_returns_401_not_500():
    res = client.post("/api/auth/refresh", json={"refresh_token": "not-a-token"})
    assert res.status_code == 401
    assert res.json().get("detail") == "Invalid token"


def test_invalid_reset_token_returns_401_not_500():
    res = client.post(
        "/api/auth/reset-password",
        json={"token": "not-a-token", "new_password": "Password123!"},
    )
    assert res.status_code == 401
    assert res.json().get("detail") == "Invalid token"


def test_list_learners_for_scheduling_allows_instructor_with_assign_schedules(monkeypatch):
    learner = SimpleNamespace(
        id=uuid.uuid4(),
        user_id="learner01",
        name="Learner One",
        email="learner01@example.com",
        role=RoleEnum.LEARNER,
        is_active=True,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )

    monkeypatch.setattr(
        users_routes,
        "load_permission_rows",
        lambda _db: [
            {"feature": "Assign Schedules", "admin": True, "instructor": True, "learner": False},
            {"feature": "Manage Users", "admin": True, "instructor": False, "learner": False},
        ],
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def all(self):
            return self.rows

    class DummySession:
        def scalar(self, _query):
            return None

        def scalars(self, _query):
            return DummyScalarResult([learner])

    current_user = SimpleNamespace(role=RoleEnum.INSTRUCTOR)

    out = _run(
        users_routes.list_learners_for_scheduling(
            db=DummySession(),
            current=current_user,
        )
    )

    assert len(out) == 1
    assert out[0].id == learner.id
    assert out[0].user_id == learner.user_id
    assert out[0].email == learner.email


def test_forgot_password_returns_503_when_email_delivery_is_unavailable(monkeypatch):
    monkeypatch.setattr(
        auth_routes,
        "get_email_delivery_status",
        lambda: (False, "Email transport not configured: set BREVO_API_KEY or SMTP settings."),
    )

    response = client.post("/api/auth/forgot-password", json={"email": "admin@example.com"})

    assert response.status_code == 503
    assert response.json()["detail"] == "Email transport not configured: set BREVO_API_KEY or SMTP settings."


def test_signup_request_normalizes_whitespace_and_enforces_password_length():
    normalized = auth_routes.SignupRequest.model_validate(
        {
            "email": " LEARNER@example.com ",
            "name": "  Learner One  ",
            "user_id": "  STU-001  ",
            "password": "Password123!",
        }
    )

    assert normalized.email == "learner@example.com"
    assert normalized.name == "Learner One"
    assert normalized.user_id == "STU-001"

    try:
        auth_routes.SignupRequest.model_validate(
            {
                "email": "learner@example.com",
                "name": "Learner One",
                "user_id": "STU-001",
                "password": "short",
            }
        )
    except ValidationError as exc:
        assert "Password must be at least 8 characters" in str(exc)
    else:
        raise AssertionError("Expected ValidationError")


def test_question_schema_accepts_both_type_inputs_and_serializes_question_type():
    exam_id = uuid.uuid4()
    create_from_question_type = QuestionCreate.model_validate(
        {
            "exam_id": exam_id,
            "text": "Question A",
            "question_type": "MCQ",
            "options": ["A", "B"],
            "correct_answer": "A",
        }
    )
    create_from_type = QuestionCreate.model_validate(
        {
            "exam_id": exam_id,
            "text": "Question B",
            "type": "MCQ",
            "options": ["A", "B"],
            "correct_answer": "A",
        }
    )
    assert create_from_question_type.type.value == "MCQ"
    assert create_from_type.type.value == "MCQ"

    read_model = QuestionRead.model_validate(
        {
            "id": uuid.uuid4(),
            "exam_id": exam_id,
            "text": "Question A",
            "type": "MCQ",
            "options": ["A", "B"],
            "correct_answer": "A",
            "points": 1.0,
            "order": 0,
            "pool_id": None,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
        }
    )
    payload = read_model.model_dump(by_alias=True)
    assert payload["question_type"] == "MCQ"
    assert "type" not in payload


def test_submit_answer_upserts_same_attempt_question_pair():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    question_id = uuid.uuid4()

    exam_id = uuid.uuid4()
    attempt = Attempt(id=attempt_id, user_id=user_id, exam_id=exam_id, status=attempts_routes.AttemptStatus.IN_PROGRESS)
    question = Question(id=question_id, exam_id=exam_id)
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummySession:
        def __init__(self):
            self.answer = None
            self.created_rows = 0

        def get(self, model, key):
            if model is Attempt:
                return attempt
            if model is Question:
                return question
            return None

        def scalar(self, _query):
            return self.answer

        def add(self, obj):
            if isinstance(obj, attempts_routes.AttemptAnswer) and self.answer is None:
                self.answer = obj
                self.created_rows += 1

        def commit(self):
            pass

        def rollback(self):
            pass

        def refresh(self, _obj):
            pass

    db = DummySession()

    first = _run(
        attempts_routes.submit_answer(
            str(attempt_id),
            AttemptAnswerBase(question_id=question_id, answer="A"),
            db=db,
            current=current_user,
        )
    )
    second = _run(
        attempts_routes.submit_answer(
            str(attempt_id),
            AttemptAnswerBase(question_id=question_id, answer="B"),
            db=db,
            current=current_user,
        )
    )

    assert db.created_rows == 1
    assert first is second
    assert second.answer == "B"


def test_submit_answer_accepts_multi_payload_and_serializes():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    question_id = uuid.uuid4()
    exam_id = uuid.uuid4()

    attempt = Attempt(id=attempt_id, user_id=user_id, exam_id=exam_id, status=attempts_routes.AttemptStatus.IN_PROGRESS)
    question = Question(id=question_id, exam_id=exam_id)
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummySession:
        def __init__(self):
            self.answer = None

        def get(self, model, key):
            if model is Attempt:
                return attempt
            if model is Question:
                return question
            return None

        def scalar(self, _query):
            return self.answer

        def add(self, obj):
            if isinstance(obj, attempts_routes.AttemptAnswer):
                self.answer = obj

        def commit(self):
            pass

        def rollback(self):
            pass

        def refresh(self, _obj):
            pass

    db = DummySession()
    created = _run(
        attempts_routes.submit_answer(
            str(attempt_id),
            AttemptAnswerBase(question_id=question_id, answer=["A", "C"]),
            db=db,
            current=current_user,
        )
    )
    assert isinstance(created.answer, str)
    assert json.loads(created.answer) == ["A", "C"]


def test_get_exam_with_invalid_uuid_returns_404_not_500():
    class DummySession:
        def get(self, *_args, **_kwargs):
            raise AssertionError("DB get should not be called for invalid UUID")

    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    try:
        _run(exams_routes.get_exam("1", db=DummySession(), current=current_user))
    except HTTPException as exc:
        assert exc.status_code == 404
        assert exc.detail == "Test not found"
    else:
        raise AssertionError("Expected HTTPException")


def test_list_questions_with_invalid_exam_id_returns_422_not_500():
    class DummySession:
        def scalars(self, *_args, **_kwargs):
            raise AssertionError("Query should not be executed for invalid exam_id")

    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    try:
        _run(questions_routes.list_questions(exam_id="1", db=DummySession(), current=current_user))
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Invalid exam_id"
    else:
        raise AssertionError("Expected HTTPException")


def test_precheck_accepts_nested_payload_bypass_shape():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    attempt = Attempt(id=attempt_id, user_id=user_id)
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummySession:
        def __init__(self):
            self.commits = 0

        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            return None

        def add(self, _obj):
            pass

        def commit(self):
            self.commits += 1

    previous = precheck_routes.ALLOW_TEST_BYPASS
    precheck_routes.ALLOW_TEST_BYPASS = True
    try:
        out = _run(
            precheck_routes.precheck(
                str(attempt_id),
                payload={"data": {"test_pass": True}},
                db=DummySession(),
                current=current_user,
            )
        )
    finally:
        precheck_routes.ALLOW_TEST_BYPASS = previous

    assert out["all_pass"] is True
    assert attempt.identity_verified is True


def test_learner_cannot_access_node_from_draft_course():
    node_id = uuid.uuid4()
    learner = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.LEARNER)
    node = SimpleNamespace(id=node_id, course=SimpleNamespace(status=CourseStatus.DRAFT))

    class DummySession:
        def get(self, model, key):
            if model.__name__ == "Node" and key == node_id:
                return node
            return None

    try:
        _run(nodes_routes.get_node(str(node_id), db=DummySession(), current=learner))
    except HTTPException as exc:
        assert exc.status_code == 404
        assert exc.detail == "Node not found"
    else:
        raise AssertionError("Expected HTTPException")


def test_read_only_maintenance_blocks_non_admin_writes():
    assert _maintenance_blocks_request("read-only", "POST", "/api/attempts/", "LEARNER") is True
    assert _maintenance_blocks_request("read-only", "GET", "/api/exams/", "LEARNER") is False
    assert _maintenance_blocks_request("read-only", "POST", "/api/auth/login", None) is False
    assert _maintenance_blocks_request("read-only", "POST", "/api/questions/", "ADMIN") is False


def test_down_maintenance_blocks_non_admin_api_requests():
    assert _maintenance_blocks_request("down", "GET", "/api/exams/", "LEARNER") is True
    assert _maintenance_blocks_request("down", "POST", "/api/auth/login", None) is False
    assert _maintenance_blocks_request("down", "GET", "/api/admin-settings/maintenance/public", None) is False


def test_user_preferences_are_upserted_per_user():
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)

    class DummySession:
        def __init__(self):
            self.preference = None

        def scalar(self, _query):
            return self.preference

        def add(self, obj):
            self.preference = obj

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    db = DummySession()

    updated = _run(
        users_routes.update_my_preference(
            "favorite_reports",
            UserPreferenceUpdate(value=[{"title": "Risk Alerts", "link": "/admin/reports"}]),
            db=db,
            current=current_user,
        )
    )
    fetched = _run(
        users_routes.get_my_preference("favorite_reports", db=db, current=current_user)
    )

    assert updated.key == "favorite_reports"
    assert updated.value == [{"title": "Risk Alerts", "link": "/admin/reports"}]
    assert fetched.value == updated.value


def test_verify_identity_marks_precheck_fields_for_submit():
    attempt_id = uuid.uuid4()
    user_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    attempt = Attempt(
        id=attempt_id,
        exam_id=exam_id,
        user_id=user_id,
        status=attempts_routes.AttemptStatus.IN_PROGRESS,
        id_verified=False,
        identity_verified=False,
        created_at=now,
        updated_at=now,
    )
    current_user = SimpleNamespace(id=user_id, role=RoleEnum.LEARNER)

    class DummySession:
        def get(self, model, key):
            if model is Attempt and key == attempt_id:
                return attempt
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    original_face_present = attempts_routes._face_present
    original_compute_face_signature = attempts_routes.compute_face_signature
    original_save_identity_photo = attempts_routes._save_identity_photo
    attempts_routes._face_present = lambda _raw: True
    attempts_routes.compute_face_signature = lambda _raw: [0.1, 0.2, 0.3]
    attempts_routes._save_identity_photo = lambda *_args, **_kwargs: None
    try:
        payload = "data:image/jpeg;base64," + base64.b64encode(b"fake-image").decode()
        _run(
            attempts_routes.verify_identity(
                str(attempt_id),
                photo_base64=payload,
                db=DummySession(),
                current=current_user,
            )
        )
    finally:
        attempts_routes._face_present = original_face_present
        attempts_routes.compute_face_signature = original_compute_face_signature
        attempts_routes._save_identity_photo = original_save_identity_photo

    assert attempt.id_verified is True
    assert attempt.identity_verified is True
    assert attempt.precheck_passed_at is not None


def test_custom_report_rows_use_canonical_tests_and_exclude_pool_library_records():
    visible_exam = SimpleNamespace(
        id=uuid.uuid4(),
        title="Physics Midterm",
        status=ExamStatus.OPEN,
        type=SimpleNamespace(value="MCQ"),
        time_limit=45,
        question_count=20,
        settings={reports_routes.ADMIN_META_KEY: {"code": "PHY-101"}},
        node=SimpleNamespace(course=SimpleNamespace(title="Science")),
    )
    hidden_exam = SimpleNamespace(
        id=uuid.uuid4(),
        title="Pool Library",
        status=ExamStatus.CLOSED,
        type=SimpleNamespace(value="MCQ"),
        time_limit=30,
        question_count=5,
        settings={"_pool_library": True, reports_routes.ADMIN_META_KEY: {"code": "POOL-1"}},
        node=None,
    )

    class DummyScalarResult:
        def __init__(self, rows):
            self.rows = rows

        def unique(self):
            return self

        def all(self):
            return self.rows

    class DummySession:
        def scalars(self, _query):
            return DummyScalarResult([hidden_exam, visible_exam])

    rows, columns = reports_routes._build_custom_report_rows(DummySession(), "tests", "phy-101")

    assert columns == reports_routes.CUSTOM_REPORT_DATASETS["tests"]
    assert len(rows) == 1
    assert rows[0]["name"] == "Physics Midterm"
    assert rows[0]["code"] == "PHY-101"
    assert rows[0]["status"] == "PUBLISHED"
    assert rows[0]["course_title"] == "Science"


def test_custom_report_csv_can_export_headers_for_empty_result_set():
    response = reports_routes._csv_response([], "users_report.csv", columns=["id", "email"])

    assert response.headers["content-disposition"] == 'attachment; filename="users_report.csv"'


def test_permission_helper_honors_custom_rows():
    rows = [
        {"feature": "Manage Users", "admin": False, "instructor": True, "learner": False},
        {"feature": "Generate Reports", "admin": True, "instructor": False, "learner": False},
    ]

    assert api_deps.permission_allowed(rows, RoleEnum.ADMIN, "Manage Users") is False
    assert api_deps.permission_allowed(rows, RoleEnum.INSTRUCTOR, "Manage Users") is True


def test_instructor_cannot_open_user_groups_route():
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.INSTRUCTOR, is_active=True)
    original_overrides = app.dependency_overrides.copy()
    app.dependency_overrides[api_deps.get_current_user] = lambda: current_user
    app.dependency_overrides[api_deps.get_db_dep] = lambda: SimpleNamespace()

    try:
        response = client.get("/api/user-groups/")
    finally:
        app.dependency_overrides = original_overrides

    assert response.status_code == 403
    assert response.json()["detail"] == "Insufficient permissions"


def test_permissions_config_is_accessible_without_system_settings():
    now = datetime.now(timezone.utc)
    permissions_setting = SimpleNamespace(
        id=uuid.uuid4(),
        key="permissions_config",
        value=json.dumps([
            {"feature": "System Settings", "admin": False, "instructor": False, "learner": False},
            {"feature": "Manage Roles", "admin": True, "instructor": False, "learner": False},
        ]),
        updated_at=now,
    )

    class DummySession:
        def __init__(self):
            self.saved = permissions_setting

        def scalar(self, _query):
            return self.saved

        def add(self, obj):
            self.saved = obj

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    db = DummySession()

    fetched = _run(admin_settings_routes.get_setting("permissions_config", db=db, current=current_user))
    updated = _run(
        admin_settings_routes.update_setting(
            "permissions_config",
            admin_settings_routes.SystemSettingUpdate(value=json.dumps([
                {"feature": "Manage Roles", "admin": True, "instructor": True, "learner": False},
                {"feature": "System Settings", "admin": True, "instructor": False, "learner": False},
            ])),
            db=db,
            current=current_user,
        )
    )

    assert fetched.key == "permissions_config"
    assert json.loads(updated.value)[0]["feature"] == "Manage Roles"


def test_permissions_config_normalizes_legacy_test_aliases():
    normalized = admin_settings_routes._normalize_permissions_config(json.dumps([
        {"feature": "Edit Exams", "admin": True, "instructor": False, "learner": False},
        {"feature": "Edit Tests", "admin": False, "instructor": True, "learner": False},
        {"feature": "Manage Roles", "admin": True, "instructor": False, "learner": False},
        {"feature": "System Settings", "admin": True, "instructor": False, "learner": False},
    ]))

    parsed = json.loads(normalized)
    assert {"feature": "Edit Tests", "admin": True, "instructor": True, "learner": False} in parsed
    assert {"feature": "Manage Roles", "admin": True, "instructor": False, "learner": False} in parsed
    assert {"feature": "System Settings", "admin": True, "instructor": False, "learner": False} in parsed


def test_integrations_config_requires_http_urls():
    class DummySession:
        def scalar(self, _query):
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)

    try:
        _run(
            admin_settings_routes.update_setting(
                "integrations_config",
                admin_settings_routes.SystemSettingUpdate(
                    value=json.dumps({
                        "webhook": {
                            "enabled": True,
                            "url": "ftp://hooks.example.com/test",
                            "secret": "abc",
                        }
                    })
                ),
                db=DummySession(),
                current=current_user,
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "webhook url must start with http:// or https://"
    else:
        raise AssertionError("Expected HTTPException")


def test_integrations_config_is_trimmed_before_save():
    class DummySession:
        def __init__(self):
            self.saved = None

        def scalar(self, _query):
            return self.saved

        def add(self, obj):
            self.saved = obj

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    db = DummySession()

    saved = _run(
        admin_settings_routes.update_setting(
            "integrations_config",
            admin_settings_routes.SystemSettingUpdate(
                value=json.dumps({
                    "webhook": {
                        "enabled": True,
                        "url": "  https://hooks.example.com/test  ",
                        "secret": "  token  ",
                    }
                })
            ),
            db=db,
            current=current_user,
        )
    )

    assert json.loads(saved.value) == {
        "webhook": {
            "enabled": True,
            "url": "https://hooks.example.com/test",
            "secret": "token",
        }
    }


def test_report_schedule_payload_validates_and_normalizes():
    normalized = report_schedules_routes._normalize_schedule_payload(
        report_schedules_routes.ReportScheduleCreate(
            name=" Daily Summary ",
            report_type="attempt-summary",
            schedule_cron="0 8 * * *",
            recipients=["ADMIN@example.com", "admin@example.com", "ops@example.com", ""],
            is_active=True,
        )
    )

    assert normalized["name"] == "Daily Summary"
    assert normalized["report_type"] == "attempt-summary"
    assert normalized["schedule_cron"] == "0 8 * * *"
    assert normalized["recipients"] == ["admin@example.com", "ops@example.com"]


def test_report_schedule_payload_rejects_invalid_cron_and_email():
    try:
        report_schedules_routes._normalize_schedule_payload(
            report_schedules_routes.ReportScheduleCreate(
                name="Invalid",
                report_type="attempt-summary",
                schedule_cron="not-a-cron",
                recipients=["ops@example.com"],
                is_active=True,
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert "Invalid cron expression" in exc.detail
    else:
        raise AssertionError("Expected HTTPException")

    try:
        report_schedules_routes._normalize_schedule_payload(
            report_schedules_routes.ReportScheduleCreate(
                name="Invalid",
                report_type="attempt-summary",
                schedule_cron="0 8 * * *",
                recipients=["not-an-email"],
                is_active=True,
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 400
        assert exc.detail == "Invalid recipient email: not-an-email"
    else:
        raise AssertionError("Expected HTTPException")


def test_report_schedule_due_uses_created_at_for_first_automatic_run():
    schedule = SimpleNamespace(
        is_active=True,
        schedule_cron="0 8 * * *",
        created_at=datetime(2026, 3, 7, 6, 0, tzinfo=timezone.utc),
        last_run_at=None,
    )

    assert report_schedules_routes.report_schedule_due(
        schedule,
        datetime(2026, 3, 7, 7, 59, tzinfo=timezone.utc),
    ) is False
    assert report_schedules_routes.report_schedule_due(
        schedule,
        datetime(2026, 3, 7, 8, 1, tzinfo=timezone.utc),
    ) is True


def test_run_schedule_now_returns_public_report_url(monkeypatch):
    schedule_id = uuid.uuid4()
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    schedule = SimpleNamespace(
        id=schedule_id,
        name="Daily Risk",
        report_type="risk-alerts",
        recipients=["ops@example.com"],
    )

    class DummySession:
        def get(self, model, key):
            if model is report_schedules_routes.ReportSchedule and key == schedule_id:
                return schedule
            return None

    async def fake_send_email(*_args, **_kwargs):
        return None

    async def fake_send_report_integration_event(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        report_schedules_routes,
        "run_report_schedule",
        lambda *_args, **_kwargs: {
            "file_path": "E:/codexxx/backend/storage/reports/example.html",
            "report_url": "http://127.0.0.1:8000/reports/example.html",
        },
    )
    monkeypatch.setattr(report_schedules_routes, "_load_subscribers", lambda _db: [])
    monkeypatch.setattr(report_schedules_routes, "_load_integrations", lambda _db: {})
    monkeypatch.setattr(report_schedules_routes, "send_email", fake_send_email)
    monkeypatch.setattr(report_schedules_routes, "send_report_integration_event", fake_send_report_integration_event)
    monkeypatch.setattr(report_schedules_routes, "write_audit_log", lambda *_args, **_kwargs: None)

    result = _run(
        report_schedules_routes.run_schedule_now(
            str(schedule_id),
            db=DummySession(),
            current=current_user,
        )
    )

    assert result.report_url == "http://127.0.0.1:8000/reports/example.html"
    assert result.email_status == "sent"
    assert "generated successfully" in result.detail.lower()


def test_schedule_update_changes_existing_assignment():
    schedule_id = uuid.uuid4()
    exam_id = uuid.uuid4()
    user_id = uuid.uuid4()
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    original_time = datetime(2026, 3, 6, 10, 0, tzinfo=timezone.utc)
    updated_time = datetime(2026, 3, 6, 12, 30, tzinfo=timezone.utc)
    schedule = SimpleNamespace(
        id=schedule_id,
        exam_id=exam_id,
        test_id=None,
        user_id=user_id,
        scheduled_at=original_time,
        access_mode=AccessMode.OPEN,
        notes=None,
        created_at=original_time,
        updated_at=original_time,
        exam=SimpleNamespace(title="Chemistry", type="MCQ", time_limit=60),
        test=None,
    )

    class DummySession:
        def get(self, model, key):
            if model is schedules_routes.Schedule and key == schedule_id:
                return schedule
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    original_audit = schedules_routes.write_audit_log
    schedules_routes.write_audit_log = lambda *args, **kwargs: None
    try:
        updated = _run(
            schedules_routes.update_schedule(
                str(schedule_id),
                ScheduleUpdate(
                    scheduled_at=updated_time,
                    access_mode=AccessMode.RESTRICTED,
                    notes="Moved by admin",
                ),
                db=DummySession(),
                current=current_user,
            )
        )
    finally:
        schedules_routes.write_audit_log = original_audit

    assert schedule.scheduled_at == updated_time
    assert schedule.access_mode == AccessMode.RESTRICTED
    assert schedule.notes == "Moved by admin"
    assert updated.access_mode == AccessMode.RESTRICTED


def test_user_update_supports_user_id_changes():
    target_user_id = uuid.uuid4()
    current_user = SimpleNamespace(id=uuid.uuid4(), role=RoleEnum.ADMIN)
    user = SimpleNamespace(
        id=target_user_id,
        user_id="OLD-USER",
        email="old@example.com",
        name="Old Name",
        role=RoleEnum.LEARNER,
        is_active=True,
        updated_at=None,
    )

    class DummySession:
        def __init__(self):
            self.scalar_calls = 0

        def get(self, model, key):
            if getattr(model, "__name__", "") == "User" and key == target_user_id:
                return user
            return None

        def scalar(self, _query):
            # 1st call: per-admin isolation connection check (target user has
            # attempted one of the actor's exams). Later calls: uniqueness
            # lookups for the new user_id/email, which must find no conflict.
            self.scalar_calls += 1
            if self.scalar_calls == 1:
                return 1
            return None

        def add(self, _obj):
            pass

        def commit(self):
            pass

        def refresh(self, _obj):
            pass

    updated = _run(
        users_routes.update_user(
            str(target_user_id),
            users_routes.UserUpdate(user_id="NEW-USER", name="New Name"),
            db=DummySession(),
            current=current_user,
        )
    )

    assert updated.user_id == "NEW-USER"
    assert updated.name == "New Name"


def test_user_group_payload_rejects_non_learner_members():
    instructor_id = uuid.uuid4()
    learner_id = uuid.uuid4()

    class DummySession:
        def get(self, model, key):
            if key == instructor_id:
                return SimpleNamespace(id=instructor_id, role=RoleEnum.INSTRUCTOR)
            if key == learner_id:
                return SimpleNamespace(id=learner_id, role=RoleEnum.LEARNER)
            return None

        def scalars(self, _query):
            class DummyScalarResult:
                @staticmethod
                def all():
                    return []

            return DummyScalarResult()

    try:
        user_groups_routes._normalize_group_payload(
            DummySession(),
            user_groups_routes.UserGroupCreate(
                name=" Cohort A ",
                description="  March intake  ",
                member_ids=[str(instructor_id)],
            ),
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Only learners can be added to groups"
    else:
        raise AssertionError("Expected HTTPException")

    normalized = user_groups_routes._normalize_group_payload(
        DummySession(),
        user_groups_routes.UserGroupCreate(
            name=" Cohort A ",
            description="  March intake  ",
            member_ids=[str(learner_id)],
        ),
    )
    assert normalized["name"] == "Cohort A"
    assert normalized["description"] == "March intake"
    assert normalized["member_ids"] == [str(learner_id)]


def test_course_payload_normalizes_and_rejects_duplicate_titles():
    normalized = courses_routes._normalize_course_payload(
        courses_routes.CourseCreate(
            title="  Secure Testing  ",
            description="  Foundation module  ",
            status=CourseStatus.DRAFT,
            node_titles=None,
        )
    )
    assert normalized["title"] == "Secure Testing"
    assert normalized["description"] == "Foundation module"

    class DummySession:
        def scalars(self, _query):
            class DummyScalarResult:
                @staticmethod
                def all():
                    return [SimpleNamespace(id=uuid.uuid4(), title="secure testing")]

            return DummyScalarResult()

    try:
        courses_routes._ensure_unique_course_title(DummySession(), "Secure Testing")
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "Course title exists"
    else:
        raise AssertionError("Expected HTTPException")


def test_category_payload_normalizes_and_rejects_duplicate_names():
    normalized = categories_routes._normalize_category_payload(
        categories_routes.CategoryBase(
            name="  Placement Tests  ",
            type="TEST",
            description="  Math placement  ",
        )
    )
    assert normalized["name"] == "Placement Tests"
    assert normalized["description"] == "Math placement"

    class DummySession:
        def scalar(self, _query):
            return SimpleNamespace(id=uuid.uuid4(), name="placement tests")

    try:
        categories_routes._ensure_unique_category_name(DummySession(), "Placement Tests")
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "Category exists"
    else:
        raise AssertionError("Expected HTTPException")


def test_grading_scale_payload_normalizes_and_rejects_duplicate_names():
    normalized = grading_scales_routes._normalize_scale_payload(
        grading_scales_routes.GradingScaleBase(
            name="  Standard Letter  ",
            labels=[
                {"label": " A ", "min_score": 90, "max_score": 100},
                {"label": "B", "min_score": 80, "max_score": 89},
            ],
        )
    )
    assert normalized["name"] == "Standard Letter"
    assert normalized["labels"] == [
        {"label": "A", "min_score": 90, "max_score": 100},
        {"label": "B", "min_score": 80, "max_score": 89},
    ]

    class DummySession:
        def scalar(self, _query):
            return SimpleNamespace(id=uuid.uuid4(), name="standard letter")

    try:
        grading_scales_routes._ensure_unique_scale_name(DummySession(), "Standard Letter")
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "Grading scale exists"
    else:
        raise AssertionError("Expected HTTPException")

    try:
        grading_scales_routes._normalize_scale_bands(
            [{"label": "A", "min_score": 95, "max_score": 90}]
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Band 1 minimum score cannot exceed maximum score"
    else:
        raise AssertionError("Expected HTTPException")

    try:
        grading_scales_routes._normalize_scale_bands(
            [
                {"label": "A", "min_score": 90, "max_score": 100},
                {"label": "a", "min_score": 80, "max_score": 89},
            ]
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Band labels must be unique"
    else:
        raise AssertionError("Expected HTTPException")

    try:
        grading_scales_routes._normalize_scale_bands(
            [
                {"label": "A", "min_score": 90, "max_score": 100},
                {"label": "B", "min_score": 85, "max_score": 95},
            ]
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Grade bands cannot overlap"
    else:
        raise AssertionError("Expected HTTPException")


def test_template_payload_normalizes_and_rejects_duplicate_names():
    normalized = exam_templates_routes._normalize_template_payload(
        exam_templates_routes.ExamTemplateCreate(
            name="  Midterm Default  ",
            description="  Standard settings  ",
            config={"shuffle": True},
        )
    )
    assert normalized["name"] == "Midterm Default"
    assert normalized["description"] == "Standard settings"
    assert normalized["config"] == {"shuffle": True}

    class DummySession:
        def scalars(self, _query):
            class DummyScalarResult:
                @staticmethod
                def all():
                    return [SimpleNamespace(id=uuid.uuid4(), name="midterm default")]

            return DummyScalarResult()

    try:
        exam_templates_routes._ensure_unique_template_name(DummySession(), "Midterm Default")
    except HTTPException as exc:
        assert exc.status_code == 409
        assert exc.detail == "Template name exists"
    else:
        raise AssertionError("Expected HTTPException")


def test_survey_payload_normalizes_questions_and_rejects_invalid_choices():
    normalized = surveys_routes._normalize_survey_payload(
        {
            "title": "  Exit Survey  ",
            "description": "  Share feedback  ",
            "questions": [
                {"text": "  Was it clear? ", "question_type": "BOOLEAN"},
                {"text": " Pick tools ", "question_type": "MCQ", "options": ["  A ", "B  ", ""]},
            ],
        },
        partial=False,
    )
    assert normalized["title"] == "Exit Survey"
    assert normalized["description"] == "Share feedback"
    assert normalized["questions"] == [
        {"text": "Was it clear?", "question_type": "BOOLEAN"},
        {"text": "Pick tools", "question_type": "MCQ", "options": ["A", "B"]},
    ]

    try:
        surveys_routes._normalize_survey_payload(
            {
                "questions": [
                    {"text": "One choice", "question_type": "MCQ", "options": ["Only one"]},
                ],
            },
            partial=True,
        )
    except HTTPException as exc:
        assert exc.status_code == 422
        assert exc.detail == "Question 1 needs at least two options"
    else:
        raise AssertionError("Expected HTTPException")
