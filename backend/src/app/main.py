import logging
from pathlib import Path
from contextlib import asynccontextmanager
import os
import re
import sys
import time
from threading import Lock

from alembic import command
from alembic.config import Config
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
import asyncio
from datetime import datetime, timezone

from .api.router import router as api_router
from .api.routes import media
from .core.config import get_settings
from .core.logging import setup_logging
from .core.limiter import limiter
from .core.security import verify_token
from .db.session import SessionLocal
from sqlalchemy import create_engine, inspect, select
from sqlalchemy.pool import NullPool
from .models import ReportSchedule, SystemSettings
from .api.routes.report_schedules import report_schedule_due, run_report_schedule
from starlette.middleware.base import BaseHTTPMiddleware

setup_logging()
logger = logging.getLogger("syra")
settings = get_settings()

if settings.SENTRY_DSN:
    import sentry_sdk
    sentry_sdk.init(
        dsn=settings.SENTRY_DSN,
        traces_sample_rate=0.1,
        send_default_pii=False,
    )
    logger.info("Sentry error tracking enabled")
BASE_DIR = Path(__file__).resolve().parent.parent.parent  # backend/src/app -> backend
STORAGE_DIR = BASE_DIR / "storage"
IDENTITY_DIR = STORAGE_DIR / "identity"
EVIDENCE_DIR = STORAGE_DIR / "evidence"
REPORTS_DIR = STORAGE_DIR / "reports"
VIDEOS_DIR = STORAGE_DIR / "videos"
for directory in (IDENTITY_DIR, EVIDENCE_DIR, REPORTS_DIR, VIDEOS_DIR):
    directory.mkdir(parents=True, exist_ok=True)

LOCAL_DEV_ORIGIN_REGEX = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
LEGACY_ALEMBIC_STAMP_REVISION = "202603091130"


def _is_local_dev_origin(origin: str) -> bool:
    return bool(re.match(LOCAL_DEV_ORIGIN_REGEX, origin))


# Parse allowed CORS origins; fall back to explicit list so credentials work.
_raw_origins = [o.strip() for o in settings.CORS_ORIGINS.split(",") if o.strip()]
USE_DEFAULT_LOCAL_DEV_CORS = not _raw_origins or _raw_origins == ["*"]
USE_LOCAL_DEV_CORS_REGEX = USE_DEFAULT_LOCAL_DEV_CORS or all(_is_local_dev_origin(origin) for origin in _raw_origins)
ALLOWED_ORIGINS = _raw_origins if not USE_DEFAULT_LOCAL_DEV_CORS else [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
ALLOWED_ORIGIN_REGEX = LOCAL_DEV_ORIGIN_REGEX if USE_LOCAL_DEV_CORS_REGEX else None


def _origin_is_allowed(origin: str | None) -> bool:
    if not origin:
        return False
    if "*" in ALLOWED_ORIGINS or origin in ALLOWED_ORIGINS:
        return True
    if ALLOWED_ORIGIN_REGEX and re.match(ALLOWED_ORIGIN_REGEX, origin):
        return True
    return False


app = FastAPI(title="SYRA LMS", redirect_slashes=False)

TRAILING_RESOURCES = {
    "/api/courses",
    "/api/nodes",
    "/api/exams",
    "/api/questions",
    "/api/attempts",
    "/api/schedules",
    "/api/categories",
    "/api/grading-scales",
    "/api/question-pools",
    "/api/dashboard",
    "/api/notifications",
    "/api/surveys",
    "/api/user-groups",
    "/api/exam-templates",
    "/api/report-schedules",
    "/api/audit-log",
    "/api/admin-settings",
    "/api/proctoring",
    "/api/admin/tests",
}

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
MAINTENANCE_PUBLIC_PATHS = {
    "/api/admin-settings/maintenance/public",
}
MAINTENANCE_BYPASS_PREFIXES = (
    "/api/health",
)
MAINTENANCE_ALLOWED_WRITE_PATHS = {
    "/api/auth/login",
    "/api/auth/refresh",
    "/api/auth/forgot-password",
    "/api/auth/reset-password",
}
MAINTENANCE_CACHE_TTL_SECONDS = settings.MAINTENANCE_CACHE_TTL_SECONDS
_maintenance_mode_cache = {
    "mode": "off",
    "expires_at": 0.0,
}
_maintenance_mode_lock = Lock()
REQUIRED_API_ROUTES = (
    "/api/auth/signup-status",
    "/api/exams/",
    "/api/attempts/resolve",
    "/api/precheck/{attempt_id}",
    "/api/admin/tests/",
    "/api/admin/tests/{test_id}",
    "/api/admin/tests/{test_id}/publish",
    "/api/admin/tests/{test_id}/archive",
    "/api/admin/tests/{test_id}/unarchive",
)


def _request_role_from_headers(request: Request) -> str | None:
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        return None
    token = auth_header.split(" ", 1)[1].strip()
    if not token:
        return None
    try:
        payload = verify_token(token, expected_type="access")
    except Exception:
        return None
    return payload.get("role")


def _maintenance_blocks_request(mode: str, method: str, path: str, role: str | None) -> bool:
    if not path.startswith("/api"):
        return False
    if path in MAINTENANCE_PUBLIC_PATHS:
        return False
    if role == "ADMIN":
        return False
    normalized_method = method.upper()
    if mode == "read-only":
        if normalized_method in SAFE_METHODS:
            return False
        if path in MAINTENANCE_ALLOWED_WRITE_PATHS:
            return False
        return True
    if mode == "down":
        if path in MAINTENANCE_PUBLIC_PATHS or path in MAINTENANCE_ALLOWED_WRITE_PATHS:
            return False
        return True
    return False


def _read_maintenance_mode_from_db() -> str:
    with SessionLocal() as db:
        setting = db.scalar(select(SystemSettings).where(SystemSettings.key == "maintenance_mode"))
        if setting and setting.value:
            return setting.value
    return "off"


def _get_cached_maintenance_mode() -> str:
    now = time.monotonic()
    if _maintenance_mode_cache["expires_at"] > now:
        return _maintenance_mode_cache["mode"]

    with _maintenance_mode_lock:
        now = time.monotonic()
        if _maintenance_mode_cache["expires_at"] > now:
            return _maintenance_mode_cache["mode"]

        try:
            mode = _read_maintenance_mode_from_db()
        except Exception:
            mode = _maintenance_mode_cache["mode"] or "off"

        _maintenance_mode_cache["mode"] = mode or "off"
        _maintenance_mode_cache["expires_at"] = now + MAINTENANCE_CACHE_TTL_SECONDS
        return _maintenance_mode_cache["mode"]


def _assert_required_api_routes() -> None:
    registered = {getattr(route, "path", "") for route in app.router.routes}
    missing = [path for path in REQUIRED_API_ROUTES if path not in registered]
    if missing:
        raise RuntimeError(f"Missing required API routes: {', '.join(missing)}")


def _is_test_env() -> bool:
    return "pytest" in sys.modules or "PYTEST_CURRENT_TEST" in os.environ


class TrailingSlashNormalizeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.scope.get("path", "")
        # If request hits a known resource root without slash, rewrite path to include slash without redirect.
        if path in TRAILING_RESOURCES and not path.endswith("/"):
            request.scope["path"] = path + "/"
            request.scope["raw_path"] = (path + "/").encode()
        return await call_next(request)


class MaintenanceModeMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.scope.get("path", "")
        if not path.startswith("/api"):
            return await call_next(request)
        if any(path.startswith(prefix) for prefix in MAINTENANCE_BYPASS_PREFIXES):
            return await call_next(request)

        mode = await asyncio.to_thread(_get_cached_maintenance_mode)

        role = _request_role_from_headers(request)
        if _maintenance_blocks_request(mode, request.method, path, role):
            detail = (
                "System is currently read-only for maintenance."
                if mode == "read-only"
                else "System is temporarily unavailable for maintenance."
            )
            return JSONResponse(status_code=503, content={"detail": detail})
        return await call_next(request)


if settings.DEV_LOG_REQUESTS:
    class LogRequestsMiddleware(BaseHTTPMiddleware):
        async def dispatch(self, request: Request, call_next):
            rid = request.headers.get("x-request-id") or str(id(request))
            logger.info("REQ %s %s %s", rid, request.method, request.url.path)
            response = await call_next(request)
            logger.info("RES %s %s %s", rid, response.status_code, request.url.path)
            return response
    app.add_middleware(LogRequestsMiddleware)

app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)
# Normalize path before CORS so preflights/post match expected route
app.add_middleware(TrailingSlashNormalizeMiddleware)
app.add_middleware(MaintenanceModeMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=ALLOWED_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


# Safety net: ensure CORS header exists on all responses for allowed origins
class EnsureCORSHeaders(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        origin = request.headers.get("origin")
        if _origin_is_allowed(origin):
            if "access-control-allow-origin" not in {k.lower() for k in response.headers.keys()}:
                response.headers["Access-Control-Allow-Origin"] = origin
                response.headers["Access-Control-Allow-Credentials"] = "true"
        return response


app.add_middleware(EnsureCORSHeaders)


@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    origin = request.headers.get("origin", "")
    headers: dict[str, str] = {"Retry-After": str(exc.detail or "60")}
    if _origin_is_allowed(origin):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=429,
        content={"detail": "Rate limit exceeded. Try again later."},
        headers=headers,
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Ensure CORS headers are present even on unhandled 500 errors."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    origin = request.headers.get("origin", "")
    headers: dict[str, str] = {}
    if _origin_is_allowed(origin):
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=headers,
    )


app.include_router(api_router, prefix="/api")
app.include_router(media.router, prefix="/api/media", tags=["media"])


def _run_alembic_upgrade() -> None:
    max_retries = 5
    for attempt_number in range(max_retries):
        migration_engine = None
        try:
            alembic_ini = BASE_DIR / "alembic.ini"
            alembic_dir = BASE_DIR / "alembic"
            if not alembic_ini.exists() or not alembic_dir.exists():
                raise RuntimeError("Alembic is not configured. Expected backend/alembic and backend/alembic.ini")
            alembic_config = Config(str(alembic_ini))
            alembic_config.set_main_option("script_location", str(alembic_dir))
            alembic_config.set_main_option("prepend_sys_path", str(BASE_DIR))
            migration_url = settings.database_migration_url
            # Alembic uses configparser interpolation, so '%' in passwords must be escaped.
            alembic_config.set_main_option("sqlalchemy.url", migration_url.replace("%", "%%"))
            connect_args = {"connect_timeout": 10}
            if ".pooler.supabase.com:6543" in migration_url:
                connect_args["prepare_threshold"] = None
            migration_engine = create_engine(
                migration_url,
                poolclass=NullPool,
                pool_pre_ping=True,
                future=True,
                connect_args=connect_args,
            )
            inspector = inspect(migration_engine)
            table_names = set(inspector.get_table_names())
            if "alembic_version" not in table_names and {"users", "exams", "attempts", "schedules"}.issubset(table_names):
                logger.warning(
                    "Detected legacy schema without Alembic version tracking; stamping revision %s before upgrade",
                    LEGACY_ALEMBIC_STAMP_REVISION,
                )
                command.stamp(alembic_config, LEGACY_ALEMBIC_STAMP_REVISION)
            command.upgrade(alembic_config, "head")
            return
        except Exception as exc:
            if attempt_number < max_retries - 1:
                wait_seconds = 2 ** attempt_number
                logger.warning("Database not ready, retrying in %ds: %s", wait_seconds, exc)
                time.sleep(wait_seconds)
            else:
                logger.error("Database unavailable after %d retries", max_retries)
                raise
        finally:
            if migration_engine is not None:
                migration_engine.dispose()


def _run_retention_cleanup() -> None:
    retention_targets = (
        ("identity", IDENTITY_DIR, settings.IDENTITY_RETENTION_DAYS),
        ("videos", VIDEOS_DIR, settings.PROCTORING_VIDEO_RETENTION_DAYS),
        ("evidence", EVIDENCE_DIR, settings.PROCTORING_EVIDENCE_RETENTION_DAYS),
    )
    now_ts = datetime.now(timezone.utc).timestamp()
    deleted_counts: dict[str, int] = {}

    for label, directory, retention_days in retention_targets:
        cutoff = now_ts - (retention_days * 24 * 60 * 60)
        deleted = 0
        directory.mkdir(parents=True, exist_ok=True)
        for file_path in directory.rglob("*"):
            if not file_path.is_file():
                continue
            try:
                if file_path.stat().st_mtime < cutoff:
                    file_path.unlink(missing_ok=True)
                    deleted += 1
            except FileNotFoundError:
                continue
        deleted_counts[label] = deleted

    logger.info(
        "Retention cleanup completed: identity=%s, videos=%s, evidence=%s",
        deleted_counts.get("identity", 0),
        deleted_counts.get("videos", 0),
        deleted_counts.get("evidence", 0),
    )


def _run_startup_initialization(*, is_test_env: bool) -> None:
    _assert_required_api_routes()
    if settings.precheck_test_bypass_enabled:
        if settings.AUTO_APPLY_MIGRATIONS and not getattr(settings, "E2E_SEED_ENABLED", False):
            raise RuntimeError(
                "PRECHECK_ALLOW_TEST_BYPASS=true is not allowed when AUTO_APPLY_MIGRATIONS=true (production mode). "
                "Either disable the bypass or set E2E_SEED_ENABLED=true to confirm this is a test environment."
            )
        logger.critical("PRECHECK_ALLOW_TEST_BYPASS is enabled - identity verification accepts the local test bypass flag.")
    if str(settings.CLOUDFLARE_MEDIA_API_BASE_URL or "").strip() and not settings.CLOUDFLARE_MEDIA_REQUIRE_SIGNED_URLS:
        logger.critical(
            "SECURITY: Cloudflare video storage is configured but CLOUDFLARE_MEDIA_REQUIRE_SIGNED_URLS is false. "
            "Proctoring videos will be publicly accessible. Set CLOUDFLARE_MEDIA_REQUIRE_SIGNED_URLS=true for production."
        )
    if is_test_env:
        logger.info("Skipping automatic Alembic migrations in test environment")
        return
    if not settings.AUTO_APPLY_MIGRATIONS:
        logger.info("Automatic Alembic migrations disabled; run `alembic upgrade head` before starting the app")
        return
    _run_alembic_upgrade()
    logger.info("Alembic migrations applied successfully")


def _run_startup_initialization_once_per_container(*, is_test_env: bool) -> None:
    """Serialize startup init so gunicorn workers do not race migrations."""
    marker_path = Path(os.getenv("SYRA_STARTUP_INIT_MARKER", "/tmp/syra-startup-init.done"))
    lock_path = Path(os.getenv("SYRA_STARTUP_INIT_LOCK", "/tmp/syra-startup-init.lock"))

    if marker_path.exists():
        return

    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with open(lock_path, "a", encoding="utf-8") as lock_fd:  # noqa: SIM115
            try:
                import fcntl

                fcntl.flock(lock_fd, fcntl.LOCK_EX)
            except (ImportError, AttributeError):
                _run_startup_initialization(is_test_env=is_test_env)
                return

            if marker_path.exists():
                return

            _run_startup_initialization(is_test_env=is_test_env)
            marker_path.write_text(datetime.now(timezone.utc).isoformat(), encoding="utf-8")
    except Exception:
        marker_path.unlink(missing_ok=True)
        raise


async def _schedule_loop():
    while True:
        await asyncio.sleep(300)  # check every 5 min instead of 60s to reduce DB pressure
        try:
            await asyncio.to_thread(_run_report_scheduler_tick_sync)
        except Exception as exc:
            logger.error("Report scheduler error: %s", exc)


def _run_report_scheduler_tick_sync() -> None:
    """Run report scheduling work off the request event loop.

    The scheduler touches the database and may perform report rendering/upload
    work; keeping it in a worker thread prevents transient DB stalls from
    freezing normal HTTP request handling on the leader process.
    """
    with SessionLocal() as db:
        schedules = db.scalars(
            select(ReportSchedule).where(ReportSchedule.is_active.is_(True))
        ).all()
        now = datetime.now(timezone.utc)
        for sched in schedules:
            if report_schedule_due(sched, now):
                asyncio.run(run_report_schedule(db, sched))


def _auto_submit_stale_attempts() -> None:
    """Find IN_PROGRESS attempts past their time limit and auto-submit them."""
    from datetime import timedelta
    from .models import Attempt, AttemptStatus, Exam, ProctoringEvent, SeverityEnum
    from .modules.attempts.routes_public import _auto_score_attempt

    now = datetime.now(timezone.utc)
    submitted = 0
    try:
        with SessionLocal() as db:
            # Find all IN_PROGRESS attempts
            stale = db.scalars(
                select(Attempt).where(
                    Attempt.status == AttemptStatus.IN_PROGRESS,
                    Attempt.started_at.isnot(None),
                )
            ).all()

            for attempt in stale:
                # Determine the deadline: time_limit + 30min grace, or 24h fallback
                exam = attempt.exam
                time_limit_min = getattr(exam, "time_limit", None) if exam else None
                if time_limit_min:
                    deadline = attempt.started_at + timedelta(minutes=int(time_limit_min) + 30)
                else:
                    deadline = attempt.started_at + timedelta(hours=24)

                if now < deadline:
                    continue

                # Auto-submit this stale attempt
                try:
                    score_result = _auto_score_attempt(attempt, db)
                    attempt.status = AttemptStatus.SUBMITTED
                    attempt.submitted_at = now
                    if score_result["score"] is not None:
                        attempt.score = score_result["score"]
                        attempt.grade = score_result.get("grade")

                    # Record a proctoring event for audit trail
                    event = ProctoringEvent(
                        attempt_id=attempt.id,
                        event_type="AUTO_SUBMITTED_TIMEOUT",
                        severity=SeverityEnum.MEDIUM,
                        detail=f"Attempt auto-submitted after timeout ({time_limit_min or 'no'} min limit + grace period)",
                        occurred_at=now,
                    )
                    db.add(event)
                    db.add(attempt)
                    db.commit()
                    submitted += 1
                except Exception as sub_err:
                    logger.warning("Failed to auto-submit stale attempt %s: %s", attempt.id, sub_err)
                    try:
                        db.rollback()
                    except Exception:
                        pass
    except Exception as exc:
        logger.error("Stale attempt cleanup error: %s", exc)

    if submitted:
        logger.info("Auto-submitted %d stale IN_PROGRESS attempt(s)", submitted)


async def _stale_attempt_cleanup_loop():
    """Run stale attempt cleanup every 30 minutes."""
    while True:
        await asyncio.sleep(30 * 60)
        try:
            await asyncio.to_thread(_auto_submit_stale_attempts)
        except Exception as exc:
            logger.error("Stale attempt cleanup loop error: %s", exc)


async def _retention_cleanup_loop():
    while True:
        try:
            await asyncio.to_thread(_run_retention_cleanup)
        except Exception as exc:
            logger.error("Retention cleanup error: %s", exc)
        await asyncio.sleep(24 * 60 * 60)


def _try_acquire_leader_lock() -> bool:
    """Acquire an exclusive file lock so only one gunicorn worker runs background tasks.

    Returns True if this process acquired the lock (becomes the leader).
    The lock file is held open for the process lifetime — OS releases it on exit.
    Falls back to True (run tasks) if locking is unavailable (e.g. Windows dev).
    """
    lock_path = STORAGE_DIR / ".leader.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        # Open in append mode so we don't truncate if another worker holds it
        lock_fd = open(lock_path, "a")  # noqa: SIM115
        try:
            import fcntl
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (ImportError, AttributeError):
            # Windows or missing fcntl — single-worker dev mode, always leader
            lock_fd.close()
            return True
        except OSError:
            # Another worker already holds the lock
            lock_fd.close()
            return False
        # Keep lock_fd open (process-lifetime lock)
        _try_acquire_leader_lock._fd = lock_fd  # prevent GC from closing it
        return True
    except Exception as exc:
        logger.warning("Could not acquire leader lock, assuming leader: %s", exc)
        return True


@asynccontextmanager
async def lifespan(_: FastAPI):
    import anyio
    limiter = anyio.to_thread.current_default_thread_limiter()
    limiter.total_tokens = settings.THREADPOOL_SIZE
    logger.info("anyio thread pool size set to %d", settings.THREADPOOL_SIZE)

    is_test_env = _is_test_env()
    _run_startup_initialization_once_per_container(is_test_env=is_test_env)
    is_leader = _try_acquire_leader_lock()
    background_tasks = []
    if not is_test_env and is_leader:
        logger.info("This worker is the background-task leader (PID %s)", os.getpid())
        if settings.WEB_REPORT_SCHEDULER_ENABLED:
            background_tasks.append(asyncio.create_task(_schedule_loop()))
        else:
            logger.info("In-process report scheduler is disabled for this worker.")
        background_tasks.extend(
            [
                asyncio.create_task(_retention_cleanup_loop()),
                asyncio.create_task(_stale_attempt_cleanup_loop()),
            ]
        )
    elif not is_test_env:
        logger.info("This worker defers background tasks to the leader (PID %s)", os.getpid())
    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)


app.router.lifespan_context = lifespan

# TEST DEPLOY

