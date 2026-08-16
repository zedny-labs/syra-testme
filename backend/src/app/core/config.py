from functools import lru_cache
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_PLACEHOLDER_API_KEYS = {
    "",
    "change-me",
    "none",
    "null",
    "your-openai-key",
    "your-openai-key-optional",
}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    DATABASE_URL: str = Field(default="postgresql+psycopg://postgres:password@localhost:5432/syra_lms")
    DATABASE_MIGRATION_URL: str | None = None
    DB_POOL_SIZE: int = Field(default=5, ge=1)
    DB_MAX_OVERFLOW: int = Field(default=5, ge=0)
    DB_POOL_TIMEOUT_SECONDS: int = Field(default=30, ge=1)
    DB_POOL_RECYCLE_SECONDS: int = Field(default=1800, ge=60)
    DB_DISABLE_POOLING: bool | None = None
    JWT_SECRET: str = Field(..., min_length=32, validation_alias=AliasChoices("JWT_SECRET", "SECRET_KEY"))
    JWT_ALGORITHM: str = Field(default="HS256", validation_alias=AliasChoices("JWT_ALGORITHM", "ALGORITHM"))
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(default=30)
    REFRESH_TOKEN_EXPIRE_DAYS: int = Field(default=7)
    PASSWORD_RESET_EXPIRE_MINUTES: int = Field(default=60)
    LOG_LEVEL: str = Field(default="INFO")

    BREVO_API_KEY: str | None = None
    BREVO_BASE_URL: str = "https://api.brevo.com/v3"
    BREVO_SENDER_EMAIL: str | None = "lms@zedny.ai"
    BREVO_SENDER_NAME: str | None = None
    BREVO_SANDBOX: bool = False

    OPENAI_API_KEY: str | None = None

    SMTP_HOST: str | None = None
    SMTP_PORT: int | None = None
    SMTP_USER: str | None = None
    SMTP_PASS: str | None = None
    SMTP_FROM: str | None = None
    SMTP_TLS: bool = True

    FRONTEND_BASE_URL: str | None = None
    BACKEND_BASE_URL: str = Field(default="http://127.0.0.1:8000")

    CORS_ORIGINS: str = Field(default="")
    # Git SHA of the deployed commit, seeded by the deploy pipeline. Exposed at
    # /api/version so the deploy can verify the running app == the shipped commit.
    BUILD_SHA: str = Field(default="")
    RATE_LIMIT_LOGIN: str = Field(default="120/minute")
    RATE_LIMIT_REFRESH: str = Field(default="60/minute")
    RATE_LIMIT_FORGOT: str = Field(default="5/minute")
    E2E_SEED_ENABLED: bool = False
    DEV_LOG_REQUESTS: bool = False
    PRECHECK_ALLOW_TEST_BYPASS: bool = False
    AUTO_APPLY_MIGRATIONS: bool = False
    WEB_REPORT_SCHEDULER_ENABLED: bool = True
    IDENTITY_RETENTION_DAYS: int = Field(default=7, ge=1)
    PROCTORING_VIDEO_RETENTION_DAYS: int = Field(default=90, ge=1)
    PROCTORING_EVIDENCE_RETENTION_DAYS: int = Field(default=90, ge=1)
    MAX_VIDEO_UPLOAD_MB: int = Field(default=512, ge=16, le=4096)
    MEDIA_STORAGE_PROVIDER: str = Field(default="local")
    PROCTORING_VIDEO_STORAGE_PROVIDER: str = Field(default="vimeo")
    PROCTORING_INFERENCE_MODE: str = Field(default="local")
    AI_INFERENCE_URL: str = Field(default="http://127.0.0.1:8081")
    PROCTORING_INFERENCE_QUEUE: str = Field(default="proctoring-inference")
    PROCTORING_INFERENCE_OPEN_TIMEOUT_SECONDS: int = Field(default=180, ge=5)
    PROCTORING_INFERENCE_TASK_TIMEOUT_SECONDS: int = Field(default=30, ge=5)
    PROCTORING_BATCH_ANALYSIS_ENABLED: bool = False
    PROCTORING_BATCH_ANALYSIS_DISPATCH_DELAY_SECONDS: int = Field(default=120, ge=0)
    REDIS_URL: str | None = None
    CELERY_BROKER_URL: str | None = None
    CELERY_RESULT_BACKEND: str | None = None
    SENTRY_DSN: str | None = None
    THREADPOOL_SIZE: int = Field(default=40, ge=10)
    MAINTENANCE_CACHE_TTL_SECONDS: float = Field(default=300.0, ge=60.0)
    SUPABASE_URL: str | None = None
    SUPABASE_PUBLISHABLE_KEY: str | None = None
    SUPABASE_SECRET_KEY: str | None = None
    SUPABASE_STORAGE_BUCKET: str = Field(default="syra-media")
    SUPABASE_SIGNED_URL_EXPIRES_SECONDS: int = Field(default=3600, ge=60)
    # Vimeo proctoring-video storage (used when PROCTORING_VIDEO_STORAGE_PROVIDER == "vimeo").
    VIMEO_ACCESS_TOKEN: str = Field(default="")
    # Optional Vimeo folder/project id (numeric) to keep proctoring recordings isolated
    # from other content on the account.
    VIMEO_FOLDER_ID: str | None = None
    # Privacy applied to each uploaded recording. "unlisted" hides it from vimeo.com but
    # keeps it embeddable via its private hash; "disable" additionally blocks direct viewing.
    VIMEO_PRIVACY_VIEW: str = Field(default="unlisted")
    # Optional domain to whitelist for embedding (tighter than unlisted+hash). Empty = any.
    VIMEO_EMBED_DOMAIN: str | None = None

    @field_validator("DATABASE_URL")
    @classmethod
    def validate_database_url(cls, value: str) -> str:
        normalized = cls._normalize_database_url_value(value, required=True)
        assert normalized is not None
        return normalized

    @field_validator("DATABASE_MIGRATION_URL", mode="before")
    @classmethod
    def validate_database_migration_url(cls, value: str | None) -> str | None:
        return cls._normalize_database_url_value(value, required=False)

    @classmethod
    def _normalize_database_url_value(cls, value: str | None, *, required: bool) -> str | None:
        normalized = str(value or "").strip()
        if not normalized:
            if required:
                raise ValueError("DATABASE_URL is required")
            return None
        if normalized.startswith("postgres://"):
            normalized = f"postgresql+psycopg://{normalized[len('postgres://'):]}"
        elif normalized.startswith("postgresql://"):
            normalized = f"postgresql+psycopg://{normalized[len('postgresql://'):]}"
        if not normalized.startswith("postgresql+psycopg://"):
            raise ValueError("DATABASE_URL must use a PostgreSQL connection string")
        return cls._ensure_supabase_sslmode(normalized)

    @staticmethod
    def _ensure_supabase_sslmode(value: str) -> str:
        try:
            parts = urlsplit(value)
        except Exception:
            return value

        hostname = str(parts.hostname or "").lower()
        if "supabase" not in hostname:
            return value

        query_pairs = parse_qsl(parts.query, keep_blank_values=True)
        if any(str(key).lower() == "sslmode" for key, _ in query_pairs):
            return value

        query_pairs.append(("sslmode", "require"))
        return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query_pairs), parts.fragment))

    @field_validator("JWT_SECRET")
    @classmethod
    def validate_secret_key(cls, v: str) -> str:
        if len(v) < 32:
            raise ValueError("JWT_SECRET must be at least 32 characters")
        return v

    @field_validator("JWT_ALGORITHM")
    @classmethod
    def validate_jwt_algorithm(cls, value: str) -> str:
        normalized = str(value or "").strip().upper()
        if normalized != "HS256":
            raise ValueError("JWT_ALGORITHM must be HS256")
        return normalized

    @field_validator("LOG_LEVEL")
    @classmethod
    def normalize_log_level(cls, value: str) -> str:
        normalized = str(value or "INFO").strip().upper()
        if normalized not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG"}:
            raise ValueError("LOG_LEVEL must be one of CRITICAL, ERROR, WARNING, INFO, DEBUG")
        return normalized

    @field_validator("MEDIA_STORAGE_PROVIDER")
    @classmethod
    def normalize_media_storage_provider(cls, value: str) -> str:
        normalized = str(value or "local").strip().lower()
        if normalized not in {"local", "supabase"}:
            raise ValueError("MEDIA_STORAGE_PROVIDER must be either 'local' or 'supabase'")
        return normalized

    @field_validator("PROCTORING_VIDEO_STORAGE_PROVIDER")
    @classmethod
    def normalize_video_storage_provider(cls, value: str) -> str:
        normalized = str(value or "vimeo").strip().lower()
        if normalized == "cloudflare":
            # Cloudflare support was removed; coerce any stale deployed config
            # instead of refusing to boot on it.
            normalized = "vimeo"
        if normalized not in {"supabase", "vimeo"}:
            raise ValueError("PROCTORING_VIDEO_STORAGE_PROVIDER must be 'supabase' or 'vimeo'")
        return normalized

    @field_validator("VIMEO_PRIVACY_VIEW")
    @classmethod
    def normalize_vimeo_privacy_view(cls, value: str) -> str:
        normalized = str(value or "unlisted").strip().lower()
        if normalized not in {"unlisted", "disable", "nobody", "anybody"}:
            raise ValueError("VIMEO_PRIVACY_VIEW must be one of 'unlisted', 'disable', 'nobody', 'anybody'")
        return normalized

    @field_validator("PROCTORING_INFERENCE_MODE")
    @classmethod
    def normalize_proctoring_inference_mode(cls, value: str) -> str:
        normalized = str(value or "local").strip().lower()
        if normalized not in {"local", "remote", "celery"}:
            raise ValueError("PROCTORING_INFERENCE_MODE must be 'local', 'remote', or 'celery'")
        return normalized

    @field_validator("AI_INFERENCE_URL", mode="before")
    @classmethod
    def normalize_ai_inference_url(cls, value: str | None) -> str:
        normalized = str(value or "http://127.0.0.1:8081").strip().rstrip("/")
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("AI_INFERENCE_URL must start with http:// or https://")
        return normalized

    @field_validator("PROCTORING_INFERENCE_QUEUE")
    @classmethod
    def normalize_proctoring_inference_queue(cls, value: str) -> str:
        normalized = str(value or "proctoring-inference").strip()
        if not normalized:
            raise ValueError("PROCTORING_INFERENCE_QUEUE is required")
        return normalized

    @field_validator("DB_DISABLE_POOLING", mode="before")
    @classmethod
    def normalize_db_disable_pooling(cls, value: object) -> object:
        # Treat empty string as None (unset) so bool parsing doesn't fail.
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("REDIS_URL", "CELERY_BROKER_URL", "CELERY_RESULT_BACKEND", mode="before")
    @classmethod
    def normalize_queue_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    @field_validator("SUPABASE_URL", mode="before")
    @classmethod
    def normalize_supabase_url(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip().rstrip("/")
        if not normalized:
            return None
        if not normalized.startswith(("http://", "https://")):
            raise ValueError("SUPABASE_URL must start with http:// or https://")
        return normalized

    @field_validator("SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY", mode="before")
    @classmethod
    def normalize_supabase_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    @field_validator("SUPABASE_STORAGE_BUCKET")
    @classmethod
    def normalize_supabase_bucket(cls, value: str) -> str:
        normalized = str(value or "syra-media").strip()
        if not normalized:
            raise ValueError("SUPABASE_STORAGE_BUCKET is required")
        return normalized

    @field_validator("OPENAI_API_KEY", mode="before")
    @classmethod
    def normalize_openai_api_key(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = str(value).strip()
        if not normalized:
            return None
        if normalized.lower() in _PLACEHOLDER_API_KEYS or normalized.lower().startswith("your-openai-key"):
            return None
        return normalized

    @property
    def precheck_test_bypass_enabled(self) -> bool:
        return bool(self.PRECHECK_ALLOW_TEST_BYPASS)

    @property
    def db_disable_pooling(self) -> bool:
        # When the app is already talking to Supabase's pooler, layering
        # SQLAlchemy's own QueuePool on top can starve request handling under
        # bursty navigation and long-lived sessions. Prefer one connection per
        # request and let Supabase own the pooling.
        if ".pooler.supabase.com:" in self.DATABASE_URL:
            return True
        if self.DB_DISABLE_POOLING is not None:
            return bool(self.DB_DISABLE_POOLING)
        return False

    @property
    def database_migration_url(self) -> str:
        return self.DATABASE_MIGRATION_URL or self.DATABASE_URL

    @property
    def celery_broker_url(self) -> str | None:
        return self.CELERY_BROKER_URL or self.REDIS_URL

    @property
    def celery_result_backend(self) -> str | None:
        return self.CELERY_RESULT_BACKEND or self.REDIS_URL


@lru_cache
def get_settings() -> Settings:
    return Settings()
