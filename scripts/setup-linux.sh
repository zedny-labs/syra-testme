#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
ROOT_ENV="${REPO_ROOT}/.env"
ROOT_ENV_EXAMPLE="${REPO_ROOT}/.env.example"
BACKEND_LOCAL_ENV="${REPO_ROOT}/backend/.env"
BACKEND_LOCAL_ENV_EXAMPLE="${REPO_ROOT}/backend/.env.example"
BACKEND_ENV="${REPO_ROOT}/backend/.env.docker"
BACKEND_ENV_EXAMPLE="${REPO_ROOT}/backend/.env.docker.example"
FRONTEND_LOCAL_ENV="${REPO_ROOT}/frontend/.env"
FRONTEND_LOCAL_ENV_EXAMPLE="${REPO_ROOT}/frontend/.env.example"
FRONTEND_ENV="${REPO_ROOT}/frontend/.env.production"
FRONTEND_ENV_EXAMPLE="${REPO_ROOT}/frontend/.env.production.example"
COMPOSE_FILES=()
PREPARE_ONLY=0
SETUP_MODE="${SYRA_SETUP_MODE:-auto}"
RUN_LOCAL_DB=0

usage() {
  cat <<'EOF'
Usage: bash scripts/setup-linux.sh [--prepare-only] [--local] [--production]

Bootstrap and run the full Linux Docker stack:
- creates .env if missing
- creates backend/.env if missing
- creates backend/.env.docker if missing
- creates frontend/.env if missing
- creates frontend/.env.production if missing
- fills the important env values from overrides or safe defaults
- chooses local PostgreSQL or external PostgreSQL automatically
- starts the website stack
- waits for backend/frontend health
- seeds demo data in local mode
- ensures standard login users exist in external-db mode

Flags:
- --prepare-only   only create/update env files and storage directories
- --local          force local PostgreSQL mode
- --production     force external PostgreSQL mode

Environment overrides:
- SYRA_SETUP_MODE=auto|local|production
- SYRA_DATABASE_URL
- SYRA_DATABASE_MIGRATION_URL
- SYRA_POSTGRES_PASSWORD
- SYRA_JWT_SECRET
- SYRA_APP_DATABASE_URL
- SYRA_APP_FRONTEND_URL
- SYRA_APP_BACKEND_URL
- SYRA_APP_CORS_ORIGINS
- SYRA_FRONTEND_URL
- SYRA_BACKEND_URL
- SYRA_CORS_ORIGINS
- SYRA_FRONTEND_DEV_API_BASE_URL
- SYRA_BREVO_API_KEY
- SYRA_BREVO_SENDER_EMAIL
- SYRA_BREVO_SENDER_NAME
- SYRA_BREVO_BASE_URL
- SYRA_BREVO_SANDBOX
- SYRA_MEDIA_STORAGE_PROVIDER=local|supabase
- SYRA_PROCTORING_VIDEO_STORAGE_PROVIDER=vimeo|supabase
- SYRA_VIMEO_ACCESS_TOKEN
- SYRA_DB_CONNECT_RETRIES
- SYRA_DB_CONNECT_RETRY_DELAY_SECONDS
- SYRA_DB_MIGRATION_TIMEOUT_SECONDS
- SYRA_BACKEND_HEALTH_TIMEOUT_SECONDS
- SYRA_FRONTEND_HEALTH_TIMEOUT_SECONDS
- SYRA_PRECHECK_ALLOW_TEST_BYPASS
- SYRA_WEB_REPORT_SCHEDULER_ENABLED
- SYRA_NGINX_CLIENT_MAX_BODY_SIZE
- SYRA_WORKERS
- SYRA_SEED_DEMO_DATA=0|1
- SYRA_SEED_FORCE=0|1
- SYRA_SEED_LOGIN_USERS=0|1
- SYRA_RESET_LOGIN_PASSWORDS=0|1
- SYRA_ADMIN_PASSWORD
- SYRA_INSTRUCTOR_PASSWORD
- SYRA_STUDENT_PASSWORD
EOF
}

log() {
  printf '[setup-linux] %s\n' "$*"
}

die() {
  printf '[setup-linux] %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

ensure_linux() {
  [[ "$(uname -s)" == "Linux" ]] || die "This script is intended for Linux."
}

ensure_docker() {
  require_command docker
  require_command curl
  require_command timeout
  docker compose version >/dev/null 2>&1 || die "Docker Compose plugin is required."
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable. Start Docker and try again."
}

ensure_file() {
  local source_file="$1"
  local target_file="$2"
  if [[ -f "$target_file" ]]; then
    return
  fi
  [[ -f "$source_file" ]] || die "Missing example file: $source_file"
  cp "$source_file" "$target_file"
}

compose() {
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" docker compose "${COMPOSE_FILES[@]}" "$@"
}

cleanup_stale_backend_migration_containers() {
  local project_name
  local stale_containers=()

  project_name="$(basename "$REPO_ROOT")"
  mapfile -t stale_containers < <(
    docker ps -aq \
      --filter "label=com.docker.compose.project=${project_name}" \
      --filter "label=com.docker.compose.service=backend" \
      --filter "name=${project_name}-backend-run-" 2>/dev/null || true
  )

  if (( ${#stale_containers[@]} > 0 )); then
    log "Removing ${#stale_containers[@]} stale backend migration container(s)."
    docker rm -f "${stale_containers[@]}" >/dev/null 2>&1 || true
  fi
}

dump_latest_backend_migration_logs() {
  local project_name
  local latest_container

  project_name="$(basename "$REPO_ROOT")"
  latest_container="$(
    docker ps -a --format '{{.ID}} {{.CreatedAt}} {{.Names}}' \
      --filter "label=com.docker.compose.project=${project_name}" \
      --filter "label=com.docker.compose.service=backend" \
      --filter "name=${project_name}-backend-run-" 2>/dev/null |
      tail -n 1 |
      awk '{ print $1 }'
  )"

  if [[ -n "$latest_container" ]]; then
    log "Latest backend migration container logs:"
    docker logs --tail 200 "$latest_container" >&2 || true
  fi
}

prepare_backend_for_deploy() {
  local backend_cid

  cleanup_stale_backend_migration_containers
  backend_cid="$(compose ps -a -q backend 2>/dev/null || true)"
  if [[ -n "$backend_cid" ]]; then
    log "Removing existing backend container before standalone migrations."
    compose rm -sf backend >/dev/null 2>&1 || true
  fi
}

generate_secret() {
  printf '%s%s\n' "$(tr -d '-' </proc/sys/kernel/random/uuid)" "$(tr -d '-' </proc/sys/kernel/random/uuid)"
}

read_env_value() {
  local file="$1"
  local key="$2"
  if [[ ! -f "$file" ]]; then
    return
  fi
  awk -F= -v key="$key" 'index($0, key "=") == 1 { sub(/^[^=]*=/, "", $0); print; exit }' "$file"
}

first_non_empty() {
  local value
  for value in "$@"; do
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return 0
    fi
  done
  return 0
}

rewrite_supabase_pooler_url_port() {
  local url="$1"
  local target_port="$2"
  local scheme
  local remainder
  local userinfo
  local host_and_path
  local host_port
  local host_only
  local path_and_query

  [[ -n "$url" && "$url" == *".pooler.supabase.com"* ]] || return 1

  scheme="${url%%://*}://"
  remainder="${url#*://}"
  [[ "$remainder" == *@* ]] || return 1

  userinfo="${remainder%%@*}"
  host_and_path="${remainder#*@}"

  if [[ "$host_and_path" == */* ]]; then
    host_port="${host_and_path%%/*}"
    path_and_query="/${host_and_path#*/}"
  else
    host_port="$host_and_path"
    path_and_query=""
  fi

  host_only="${host_port%%:*}"
  [[ -n "$host_only" ]] || return 1

  printf '%s%s@%s:%s%s' "$scheme" "$userinfo" "$host_only" "$target_port" "$path_and_query"
}

derive_supabase_transaction_pooler_url() {
  rewrite_supabase_pooler_url_port "$1" "6543"
}

derive_supabase_session_pooler_url() {
  rewrite_supabase_pooler_url_port "$1" "5432"
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print key "=" value
      }
    }
  ' "$file" >"$tmp_file"
  mv "$tmp_file" "$file"
}

is_placeholder_secret() {
  local value="$1"
  [[ -z "$value" || "$value" == "change-me-to-a-random-32-character-string" || "$value" == "local-dev-secret-with-at-least-32-chars" ]]
}

configure_compose_files() {
  COMPOSE_FILES=(-f "${REPO_ROOT}/docker-compose.yml")
  if [[ "$RUN_LOCAL_DB" == "1" ]]; then
    COMPOSE_FILES+=(-f "${REPO_ROOT}/docker-compose.local-db.yml")
  fi
}

wait_for_service_health() {
  local service="$1"
  local timeout_seconds="${2:-900}"
  local interval_seconds=5
  local elapsed=0
  local next_progress_log_at=0
  local container_id
  local status

  container_id="$(compose ps -q "$service")"
  [[ -n "$container_id" ]] || die "Could not determine container id for service: $service"

  while (( elapsed < timeout_seconds )); do
    status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    case "$status" in
      healthy)
        log "Service '$service' is healthy."
        return 0
        ;;
      unhealthy|exited|dead)
        docker logs --tail 120 "$container_id" >&2 || true
        die "Service '$service' became $status."
        ;;
    esac
    if (( elapsed >= next_progress_log_at )); then
      log "Waiting for service '$service' to become healthy (status: ${status:-unknown}, elapsed: ${elapsed}s/${timeout_seconds}s)."
      next_progress_log_at=$((elapsed + 30))
    fi
    sleep "$interval_seconds"
    elapsed=$((elapsed + interval_seconds))
  done

  docker logs --tail 120 "$container_id" >&2 || true
  die "Timed out waiting for service '$service' to become healthy."
}

require_http_200() {
  local url="$1"
  local label="$2"
  local timeout_seconds="${3:-30}"
  local max_attempts="${4:-1}"
  local retry_delay_seconds="${5:-5}"
  local status=""
  local attempt=1

  while (( attempt <= max_attempts )); do
    status="$(curl --silent --show-error --location --max-time "$timeout_seconds" --output /dev/null --write-out '%{http_code}' "$url" || true)"
    if [[ "$status" == "200" ]]; then
      log "${label} check passed (${url})."
      return 0
    fi

    if (( attempt < max_attempts )); then
      log "${label} check attempt ${attempt}/${max_attempts} failed for ${url} (status ${status:-unreachable}); retrying in ${retry_delay_seconds}s."
      sleep "$retry_delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  die "${label} check failed for ${url} (status ${status:-unreachable})."
}

seed_demo_data() {
  if [[ "$SEED_DEMO_DATA" != "1" ]]; then
    log "Skipping demo seed because SYRA_SEED_DEMO_DATA=${SEED_DEMO_DATA}."
    return
  fi

  log "Seeding demo data."
  if [[ "$SEED_FORCE" == "1" ]]; then
    compose run --rm -T -v "${REPO_ROOT}/backend/scripts:/app/scripts:ro" backend python scripts/seed_mass_data.py --force
  else
    compose run --rm -T -v "${REPO_ROOT}/backend/scripts:/app/scripts:ro" backend python scripts/seed_mass_data.py
  fi
}

seed_login_users() {
  if [[ "$SEED_LOGIN_USERS" != "1" ]]; then
    log "Skipping login-user seed because SYRA_SEED_LOGIN_USERS=${SEED_LOGIN_USERS}."
    return
  fi

  log "Ensuring standard login users exist."
  if compose run --rm -T \
    -v "${REPO_ROOT}/backend/scripts:/app/scripts:ro" \
    -e SYRA_RESET_LOGIN_PASSWORDS="$RESET_LOGIN_PASSWORDS" \
    -e SYRA_ADMIN_PASSWORD="$ADMIN_PASSWORD" \
    -e SYRA_INSTRUCTOR_PASSWORD="$INSTRUCTOR_PASSWORD" \
    -e SYRA_STUDENT_PASSWORD="$STUDENT_PASSWORD" \
    backend python scripts/ensure_login_users.py; then
    return
  fi

  if [[ "$RUN_LOCAL_DB" == "0" ]]; then
    log "WARNING: Standard login-user seed failed against the external database."
    log "Continuing deploy because runtime health checks still validate the app."
    return
  fi

  die "Standard login-user seed failed."
}

preflight_memory_warning() {
  local avail_mem_mb
  avail_mem_mb="$(awk '/MemAvailable/ {printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if (( avail_mem_mb > 0 )); then
    log "Available memory: ${avail_mem_mb} MB"
    if (( avail_mem_mb < 1500 )); then
      log "WARNING: Low memory (${avail_mem_mb} MB)."
      log "  Consider adding swap or setting SYRA_WORKERS=1."
    fi
  fi
}

database_connectivity_check() {
  if [[ "$RUN_LOCAL_DB" == "1" ]]; then
    return 0
  fi

  local existing_backend_cid
  local existing_backend_state
  existing_backend_cid="$(compose ps -q backend 2>/dev/null || true)"
  if [[ -n "$existing_backend_cid" ]]; then
    existing_backend_state="$(docker inspect --format '{{.State.Status}}' "$existing_backend_cid" 2>/dev/null || true)"
    if [[ "$existing_backend_state" == "running" ]]; then
      log "Existing backend container detected; skipping database preflight and relying on post-start health checks."
      return 0
    fi
  fi

  log "Testing database connectivity..."
  local db_check_url="$DATABASE_URL"
  local db_check_output=""
  local max_attempts="${SYRA_DB_CONNECT_RETRIES:-12}"
  local retry_delay_seconds="${SYRA_DB_CONNECT_RETRY_DELAY_SECONDS:-5}"
  local attempt=1

  if [[ -n "${DATABASE_MIGRATION_URL:-}" ]]; then
    db_check_url="$DATABASE_MIGRATION_URL"
    log "Using DATABASE_MIGRATION_URL for preflight connectivity check."
  fi

  while (( attempt <= max_attempts )); do
    db_check_output="$(
      cd "$REPO_ROOT"
      compose run --rm --no-deps -T \
        -e DATABASE_URL="$db_check_url" \
        backend python -c '
import os, sys
from sqlalchemy import create_engine, text
from sqlalchemy.pool import NullPool
try:
    connect_args = {"connect_timeout": 10}
    if ".pooler.supabase.com:6543" in os.environ["DATABASE_URL"]:
        connect_args["prepare_threshold"] = None
    engine = create_engine(
        os.environ["DATABASE_URL"],
        poolclass=NullPool,
        connect_args=connect_args,
        future=True,
    )
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    engine.dispose()
    print("OK")
except Exception as exc:
    print(f"FAIL: {exc}", file=sys.stderr)
    sys.exit(1)
' 2>&1
    )" || true

    if echo "$db_check_output" | grep -q "^OK$"; then
      log "Database connectivity check passed."
      return 0
    fi

    if (( attempt < max_attempts )); then
      log "Database connectivity attempt ${attempt}/${max_attempts} failed; retrying in ${retry_delay_seconds}s."
      sleep "$retry_delay_seconds"
    fi
    attempt=$((attempt + 1))
  done

  log "ERROR: Cannot connect to the database."
  log "  URL: ${db_check_url%%@*}@*** (host hidden)"
  log "  Error: $db_check_output"
  return 1
}

for arg in "$@"; do
  case "$arg" in
    --prepare-only)
      PREPARE_ONLY=1
      ;;
    --local)
      SETUP_MODE="local"
      ;;
    --production)
      SETUP_MODE="production"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $arg"
      ;;
  esac
done

ensure_linux

POSTGRES_PASSWORD="${SYRA_POSTGRES_PASSWORD:-syra-local-password}"
LOCAL_DATABASE_URL="postgresql+psycopg://syra:${POSTGRES_PASSWORD}@db:5432/syra_lms"

ensure_file "$ROOT_ENV_EXAMPLE" "$ROOT_ENV"
ensure_file "$BACKEND_LOCAL_ENV_EXAMPLE" "$BACKEND_LOCAL_ENV"
ensure_file "$BACKEND_ENV_EXAMPLE" "$BACKEND_ENV"
ensure_file "$FRONTEND_LOCAL_ENV_EXAMPLE" "$FRONTEND_LOCAL_ENV"
ensure_file "$FRONTEND_ENV_EXAMPLE" "$FRONTEND_ENV"

existing_root_database_url="$(read_env_value "$ROOT_ENV" "DATABASE_URL")"
existing_root_database_migration_url="$(read_env_value "$ROOT_ENV" "DATABASE_MIGRATION_URL")"
existing_root_jwt_secret="$(read_env_value "$ROOT_ENV" "JWT_SECRET")"
existing_root_frontend_url="$(read_env_value "$ROOT_ENV" "FRONTEND_BASE_URL")"
existing_root_backend_url="$(read_env_value "$ROOT_ENV" "BACKEND_BASE_URL")"
existing_root_public_frontend_url="$(read_env_value "$ROOT_ENV" "PUBLIC_FRONTEND_BASE_URL")"
existing_root_public_backend_url="$(read_env_value "$ROOT_ENV" "PUBLIC_BACKEND_BASE_URL")"
existing_root_cors_origins="$(read_env_value "$ROOT_ENV" "CORS_ORIGINS")"
existing_root_media_storage_provider="$(read_env_value "$ROOT_ENV" "MEDIA_STORAGE_PROVIDER")"
existing_root_video_storage_provider="$(read_env_value "$ROOT_ENV" "PROCTORING_VIDEO_STORAGE_PROVIDER")"
existing_root_workers="$(read_env_value "$ROOT_ENV" "WORKERS")"
existing_root_nginx_client_max_body_size="$(read_env_value "$ROOT_ENV" "NGINX_CLIENT_MAX_BODY_SIZE")"
existing_root_vite_api_base_url="$(read_env_value "$ROOT_ENV" "VITE_API_BASE_URL")"
existing_database_url="$(read_env_value "$BACKEND_ENV" "DATABASE_URL")"
existing_database_migration_url="$(read_env_value "$BACKEND_ENV" "DATABASE_MIGRATION_URL")"
existing_jwt_secret="$(read_env_value "$BACKEND_ENV" "JWT_SECRET")"
existing_frontend_url="$(read_env_value "$BACKEND_ENV" "FRONTEND_BASE_URL")"
existing_backend_url="$(read_env_value "$BACKEND_ENV" "BACKEND_BASE_URL")"
existing_cors_origins="$(read_env_value "$BACKEND_ENV" "CORS_ORIGINS")"
existing_brevo_api_key="$(read_env_value "$BACKEND_ENV" "BREVO_API_KEY")"
existing_brevo_base_url="$(read_env_value "$BACKEND_ENV" "BREVO_BASE_URL")"
existing_brevo_sender_email="$(read_env_value "$BACKEND_ENV" "BREVO_SENDER_EMAIL")"
existing_brevo_sender_name="$(read_env_value "$BACKEND_ENV" "BREVO_SENDER_NAME")"
existing_brevo_sandbox="$(read_env_value "$BACKEND_ENV" "BREVO_SANDBOX")"
existing_media_storage_provider="$(read_env_value "$BACKEND_ENV" "MEDIA_STORAGE_PROVIDER")"
existing_video_storage_provider="$(read_env_value "$BACKEND_ENV" "PROCTORING_VIDEO_STORAGE_PROVIDER")"
existing_vimeo_access_token="$(read_env_value "$BACKEND_ENV" "VIMEO_ACCESS_TOKEN")"
existing_root_vimeo_access_token="$(read_env_value "$ROOT_ENV" "VIMEO_ACCESS_TOKEN")"
existing_workers="$(read_env_value "$BACKEND_ENV" "WORKERS")"
existing_nginx_client_max_body_size="$(read_env_value "$FRONTEND_ENV" "NGINX_CLIENT_MAX_BODY_SIZE")"
existing_backend_local_database_url="$(read_env_value "$BACKEND_LOCAL_ENV" "DATABASE_URL")"
existing_backend_local_database_migration_url="$(read_env_value "$BACKEND_LOCAL_ENV" "DATABASE_MIGRATION_URL")"
existing_backend_local_frontend_url="$(read_env_value "$BACKEND_LOCAL_ENV" "FRONTEND_BASE_URL")"
existing_backend_local_backend_url="$(read_env_value "$BACKEND_LOCAL_ENV" "BACKEND_BASE_URL")"
existing_backend_local_cors_origins="$(read_env_value "$BACKEND_LOCAL_ENV" "CORS_ORIGINS")"
existing_frontend_local_vite_api_base_url="$(read_env_value "$FRONTEND_LOCAL_ENV" "VITE_API_BASE_URL")"

if [[ "$SETUP_MODE" == "production" ]]; then
  # backend/.env.docker is generated output. In production, prefer the persisted
  # root .env values so a previous bad deploy does not permanently poison future
  # deploys by making the generated file authoritative.
  DATABASE_URL="${SYRA_DATABASE_URL:-$(first_non_empty "$existing_root_database_url" "$existing_database_url" "$LOCAL_DATABASE_URL")}"
  DATABASE_MIGRATION_URL="${SYRA_DATABASE_MIGRATION_URL:-$(first_non_empty "$existing_root_database_migration_url" "$existing_database_migration_url" "$existing_backend_local_database_migration_url" "")}"
else
  DATABASE_URL="${SYRA_DATABASE_URL:-$(first_non_empty "$existing_database_url" "$existing_root_database_url" "$LOCAL_DATABASE_URL")}"
  DATABASE_MIGRATION_URL="${SYRA_DATABASE_MIGRATION_URL:-$(first_non_empty "$existing_database_migration_url" "$existing_root_database_migration_url" "$existing_backend_local_database_migration_url" "")}"
fi
JWT_SECRET="${SYRA_JWT_SECRET:-$(first_non_empty "$existing_jwt_secret" "$existing_root_jwt_secret" "")}"
FRONTEND_URL="${SYRA_FRONTEND_URL:-$(first_non_empty "$existing_frontend_url" "$existing_root_public_frontend_url" "http://localhost")}"
BACKEND_URL="${SYRA_BACKEND_URL:-$(first_non_empty "$existing_backend_url" "$existing_root_public_backend_url" "${FRONTEND_URL%/}/api")}"
CORS_ORIGINS="${SYRA_CORS_ORIGINS:-$(first_non_empty "$existing_cors_origins" "$existing_root_cors_origins" "$FRONTEND_URL")}"
BREVO_API_KEY="${SYRA_BREVO_API_KEY:-$existing_brevo_api_key}"
BREVO_BASE_URL="${SYRA_BREVO_BASE_URL:-$(first_non_empty "$existing_brevo_base_url" "https://api.brevo.com/v3")}"
BREVO_SENDER_EMAIL="${SYRA_BREVO_SENDER_EMAIL:-$(first_non_empty "$existing_brevo_sender_email" "lms@zedny.ai")}"
BREVO_SENDER_NAME="${SYRA_BREVO_SENDER_NAME:-$(first_non_empty "$existing_brevo_sender_name" "Zedny Learning Management System")}"
BREVO_SANDBOX="${SYRA_BREVO_SANDBOX:-$(first_non_empty "$existing_brevo_sandbox" "false")}"
MEDIA_STORAGE_PROVIDER="${SYRA_MEDIA_STORAGE_PROVIDER:-$(first_non_empty "$existing_media_storage_provider" "$existing_root_media_storage_provider" "local")}"
NGINX_CLIENT_MAX_BODY_SIZE="${SYRA_NGINX_CLIENT_MAX_BODY_SIZE:-$(first_non_empty "$existing_nginx_client_max_body_size" "$existing_root_nginx_client_max_body_size" "512m")}"
PROCTORING_VIDEO_STORAGE_PROVIDER="${SYRA_PROCTORING_VIDEO_STORAGE_PROVIDER:-$(first_non_empty "$existing_video_storage_provider" "$existing_root_video_storage_provider" "")}"
VIMEO_ACCESS_TOKEN="${SYRA_VIMEO_ACCESS_TOKEN:-$(first_non_empty "$existing_vimeo_access_token" "$existing_root_vimeo_access_token" "")}"

existing_worker_value="$(first_non_empty "$existing_workers" "$existing_root_workers" "")"
default_workers="1"

if [[ -n "${SYRA_WORKERS:-}" ]]; then
  WORKERS="$SYRA_WORKERS"
else
  WORKERS="${existing_worker_value:-$default_workers}"
fi

if is_placeholder_secret "$JWT_SECRET"; then
  JWT_SECRET="$(generate_secret)"
  log "Generated a persistent JWT_SECRET."
fi

case "$SETUP_MODE" in
  local)
    RUN_LOCAL_DB=1
    ;;
  production)
    RUN_LOCAL_DB=0
    ;;
  auto)
    if [[ "$DATABASE_URL" == *"@db:"* ]]; then
      RUN_LOCAL_DB=1
    else
      RUN_LOCAL_DB=0
    fi
    ;;
  *)
    die "Unsupported setup mode: ${SETUP_MODE}. Use auto, local, or production."
    ;;
esac

if [[ "$RUN_LOCAL_DB" == "0" ]]; then
  derived_supabase_migration_url=""
  derived_supabase_runtime_url=""
  if [[ "$DATABASE_URL" == *".pooler.supabase.com"* ]]; then
    derived_supabase_migration_url="$(derive_supabase_session_pooler_url "$DATABASE_URL" || true)"
    derived_supabase_runtime_url="$(derive_supabase_transaction_pooler_url "$DATABASE_URL" || true)"
  elif [[ -z "${DATABASE_MIGRATION_URL:-}" || "$DATABASE_MIGRATION_URL" == *".pooler.supabase.com"* ]]; then
    derived_supabase_migration_url="$(derive_supabase_session_pooler_url "${DATABASE_MIGRATION_URL:-$DATABASE_URL}" || true)"
  fi
  if [[ -n "$derived_supabase_migration_url" ]]; then
    DATABASE_MIGRATION_URL="$derived_supabase_migration_url"
    log "Derived Supabase session-pooler DATABASE_MIGRATION_URL for migrations and preflight."
  fi
  if [[ -n "$derived_supabase_runtime_url" ]]; then
    DATABASE_URL="$derived_supabase_runtime_url"
    log "Derived Supabase transaction-pooler DATABASE_URL for runtime app connections."
  fi
fi

DB_DISABLE_POOLING_VALUE=""
if [[ "$DATABASE_URL" == *".pooler.supabase.com:"* ]]; then
  DB_DISABLE_POOLING_VALUE="true"
fi

DB_POOL_SIZE_VALUE="$(first_non_empty "${SYRA_DB_POOL_SIZE:-}" "$(read_env_value "$BACKEND_ENV" "DB_POOL_SIZE")" "$(read_env_value "$ROOT_ENV" "DB_POOL_SIZE")" "")"
DB_MAX_OVERFLOW_VALUE="$(first_non_empty "${SYRA_DB_MAX_OVERFLOW:-}" "$(read_env_value "$BACKEND_ENV" "DB_MAX_OVERFLOW")" "$(read_env_value "$ROOT_ENV" "DB_MAX_OVERFLOW")" "")"
DB_POOL_TIMEOUT_VALUE="$(first_non_empty "${SYRA_DB_POOL_TIMEOUT_SECONDS:-}" "$(read_env_value "$BACKEND_ENV" "DB_POOL_TIMEOUT_SECONDS")" "$(read_env_value "$ROOT_ENV" "DB_POOL_TIMEOUT_SECONDS")" "")"

if [[ "$DATABASE_URL" == *".pooler.supabase.com:6543"* ]]; then
  DB_POOL_SIZE_VALUE="${DB_POOL_SIZE_VALUE:-3}"
  DB_MAX_OVERFLOW_VALUE="${DB_MAX_OVERFLOW_VALUE:-1}"
  DB_POOL_TIMEOUT_VALUE="${DB_POOL_TIMEOUT_VALUE:-15}"
fi

# Overridable so dev can disable boot-time migrations (they already run as a
# one-shot before services start). No SYRA_ override on main -> unchanged there.
if [[ -n "${SYRA_AUTO_APPLY_MIGRATIONS:-}" ]]; then
  AUTO_APPLY_MIGRATIONS_VALUE="${SYRA_AUTO_APPLY_MIGRATIONS}"
elif [[ "$RUN_LOCAL_DB" == "1" ]]; then
  AUTO_APPLY_MIGRATIONS_VALUE="true"
else
  AUTO_APPLY_MIGRATIONS_VALUE="false"
fi

if [[ "$PREPARE_ONLY" -eq 0 && "$RUN_LOCAL_DB" == "0" && "$DATABASE_URL" == "$LOCAL_DATABASE_URL" ]]; then
  die "Production mode requires SYRA_DATABASE_URL or backend/.env.docker DATABASE_URL to point at an external database."
fi

configure_compose_files

if [[ -n "${SYRA_PRECHECK_ALLOW_TEST_BYPASS:-}" ]]; then
  PRECHECK_ALLOW_TEST_BYPASS="${SYRA_PRECHECK_ALLOW_TEST_BYPASS}"
elif [[ "$RUN_LOCAL_DB" == "1" ]]; then
  PRECHECK_ALLOW_TEST_BYPASS="true"
else
  PRECHECK_ALLOW_TEST_BYPASS="false"
fi

if [[ -n "${SYRA_WEB_REPORT_SCHEDULER_ENABLED:-}" ]]; then
  WEB_REPORT_SCHEDULER_ENABLED="${SYRA_WEB_REPORT_SCHEDULER_ENABLED}"
elif [[ "$RUN_LOCAL_DB" == "1" ]]; then
  WEB_REPORT_SCHEDULER_ENABLED="true"
else
  WEB_REPORT_SCHEDULER_ENABLED="false"
fi

if [[ -z "$PROCTORING_VIDEO_STORAGE_PROVIDER" ]]; then
  if [[ -n "$VIMEO_ACCESS_TOKEN" ]]; then
    PROCTORING_VIDEO_STORAGE_PROVIDER="vimeo"
  else
    PROCTORING_VIDEO_STORAGE_PROVIDER="supabase"
  fi
fi
PROCTORING_VIDEO_STORAGE_PROVIDER="$(printf '%s' "$PROCTORING_VIDEO_STORAGE_PROVIDER" | tr '[:upper:]' '[:lower:]')"
if [[ "$PROCTORING_VIDEO_STORAGE_PROVIDER" == "cloudflare" ]]; then
  log "WARNING: Cloudflare proctoring video storage was removed. Using vimeo instead of the persisted 'cloudflare' setting."
  PROCTORING_VIDEO_STORAGE_PROVIDER="vimeo"
fi

case "$PROCTORING_VIDEO_STORAGE_PROVIDER" in
  supabase)
    log "Using Supabase proctoring video storage."
    ;;
  vimeo)
    if [[ -z "$VIMEO_ACCESS_TOKEN" ]]; then
      log "WARNING: Vimeo storage was selected without a Vimeo access token."
      log "Falling back to supabase proctoring video storage."
      PROCTORING_VIDEO_STORAGE_PROVIDER="supabase"
    else
      log "Using Vimeo proctoring video storage."
    fi
    ;;
  *)
    die "Unsupported SYRA_PROCTORING_VIDEO_STORAGE_PROVIDER: ${PROCTORING_VIDEO_STORAGE_PROVIDER}. Use 'supabase' or 'vimeo'."
    ;;
esac

if [[ "$RUN_LOCAL_DB" == "0" && "$FRONTEND_URL" == "http://localhost" ]]; then
  log "WARNING: FRONTEND_BASE_URL is still http://localhost."
  log "  Set SYRA_FRONTEND_URL and SYRA_BACKEND_URL for a public deployment."
fi

if [[ -n "${SYRA_SEED_DEMO_DATA:-}" ]]; then
  SEED_DEMO_DATA="${SYRA_SEED_DEMO_DATA}"
elif [[ "$RUN_LOCAL_DB" == "1" ]]; then
  SEED_DEMO_DATA="1"
else
  SEED_DEMO_DATA="0"
fi

if [[ -n "${SYRA_SEED_LOGIN_USERS:-}" ]]; then
  SEED_LOGIN_USERS="${SYRA_SEED_LOGIN_USERS}"
elif [[ "$RUN_LOCAL_DB" == "1" && "$SEED_DEMO_DATA" == "1" ]]; then
  SEED_LOGIN_USERS="0"
else
  SEED_LOGIN_USERS="0"
fi

if [[ -n "${SYRA_RESET_LOGIN_PASSWORDS:-}" ]]; then
  RESET_LOGIN_PASSWORDS="${SYRA_RESET_LOGIN_PASSWORDS}"
elif [[ "$RUN_LOCAL_DB" == "1" ]]; then
  RESET_LOGIN_PASSWORDS="1"
else
  RESET_LOGIN_PASSWORDS="0"
fi

SEED_FORCE="${SYRA_SEED_FORCE:-0}"
ADMIN_PASSWORD="${SYRA_ADMIN_PASSWORD:-Admin1234!}"
INSTRUCTOR_PASSWORD="${SYRA_INSTRUCTOR_PASSWORD:-Instructor1234!}"
STUDENT_PASSWORD="${SYRA_STUDENT_PASSWORD:-Student1234!}"
DB_MIGRATION_TIMEOUT_SECONDS="${SYRA_DB_MIGRATION_TIMEOUT_SECONDS:-360}"
BACKEND_HEALTH_TIMEOUT_SECONDS="${SYRA_BACKEND_HEALTH_TIMEOUT_SECONDS:-240}"
FRONTEND_HEALTH_TIMEOUT_SECONDS="${SYRA_FRONTEND_HEALTH_TIMEOUT_SECONDS:-120}"

[[ "$DB_MIGRATION_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$DB_MIGRATION_TIMEOUT_SECONDS" -gt 0 ]] || die "SYRA_DB_MIGRATION_TIMEOUT_SECONDS must be a positive integer."
[[ "$BACKEND_HEALTH_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$BACKEND_HEALTH_TIMEOUT_SECONDS" -gt 0 ]] || die "SYRA_BACKEND_HEALTH_TIMEOUT_SECONDS must be a positive integer."
[[ "$FRONTEND_HEALTH_TIMEOUT_SECONDS" =~ ^[0-9]+$ && "$FRONTEND_HEALTH_TIMEOUT_SECONDS" -gt 0 ]] || die "SYRA_FRONTEND_HEALTH_TIMEOUT_SECONDS must be a positive integer."

if [[ "$RUN_LOCAL_DB" == "1" ]]; then
  APP_DATABASE_URL_DEFAULT="postgresql+psycopg://postgres:postgres@localhost:5432/syra_lms"
  APP_FRONTEND_URL_DEFAULT="http://localhost:5173"
  APP_BACKEND_URL_DEFAULT="http://localhost:8000"
  APP_CORS_ORIGINS_DEFAULT="http://localhost:5173,http://127.0.0.1:5173"
  FRONTEND_DEV_API_BASE_URL_DEFAULT="http://127.0.0.1:8000/api"

  APP_DATABASE_URL="${SYRA_APP_DATABASE_URL:-$(first_non_empty "$existing_backend_local_database_url" "$existing_root_database_url" "$APP_DATABASE_URL_DEFAULT")}"
  APP_DATABASE_MIGRATION_URL="${SYRA_DATABASE_MIGRATION_URL:-$(first_non_empty "$existing_backend_local_database_migration_url" "$existing_root_database_migration_url" "$DATABASE_MIGRATION_URL")}"
  APP_FRONTEND_URL="${SYRA_APP_FRONTEND_URL:-$(first_non_empty "$existing_backend_local_frontend_url" "$existing_root_frontend_url" "$APP_FRONTEND_URL_DEFAULT")}"
  APP_BACKEND_URL="${SYRA_APP_BACKEND_URL:-$(first_non_empty "$existing_backend_local_backend_url" "$existing_root_backend_url" "$APP_BACKEND_URL_DEFAULT")}"
  APP_CORS_ORIGINS="${SYRA_APP_CORS_ORIGINS:-$(first_non_empty "$existing_backend_local_cors_origins" "$existing_root_cors_origins" "$APP_CORS_ORIGINS_DEFAULT")}"
  FRONTEND_DEV_API_BASE_URL="${SYRA_FRONTEND_DEV_API_BASE_URL:-$(first_non_empty "$existing_frontend_local_vite_api_base_url" "$existing_root_vite_api_base_url" "$FRONTEND_DEV_API_BASE_URL_DEFAULT")}"
else
  APP_DATABASE_URL_DEFAULT="$DATABASE_URL"
  APP_FRONTEND_URL_DEFAULT="$FRONTEND_URL"
  APP_BACKEND_URL_DEFAULT="$BACKEND_URL"
  APP_CORS_ORIGINS_DEFAULT="$CORS_ORIGINS"
  FRONTEND_DEV_API_BASE_URL_DEFAULT="${BACKEND_URL%/}"

  # In production, prefer the resolved deployment URLs over local-dev env files.
  # backend/.env is intentionally localhost-oriented and must not override the
  # container runtime DATABASE_URL written to backend/.env.docker.
  APP_DATABASE_URL="${SYRA_APP_DATABASE_URL:-$APP_DATABASE_URL_DEFAULT}"
  APP_DATABASE_MIGRATION_URL="${SYRA_DATABASE_MIGRATION_URL:-${DATABASE_MIGRATION_URL:-$DATABASE_URL}}"
  APP_FRONTEND_URL="${SYRA_APP_FRONTEND_URL:-$APP_FRONTEND_URL_DEFAULT}"
  APP_BACKEND_URL="${SYRA_APP_BACKEND_URL:-$APP_BACKEND_URL_DEFAULT}"
  APP_CORS_ORIGINS="${SYRA_APP_CORS_ORIGINS:-$APP_CORS_ORIGINS_DEFAULT}"
  FRONTEND_DEV_API_BASE_URL="${SYRA_FRONTEND_DEV_API_BASE_URL:-$FRONTEND_DEV_API_BASE_URL_DEFAULT}"
fi

set_env_value "$ROOT_ENV" "DATABASE_URL" "$APP_DATABASE_URL"
set_env_value "$ROOT_ENV" "DATABASE_MIGRATION_URL" "$APP_DATABASE_MIGRATION_URL"
set_env_value "$ROOT_ENV" "JWT_SECRET" "$JWT_SECRET"
set_env_value "$ROOT_ENV" "FRONTEND_BASE_URL" "$APP_FRONTEND_URL"
set_env_value "$ROOT_ENV" "BACKEND_BASE_URL" "$APP_BACKEND_URL"
set_env_value "$ROOT_ENV" "PUBLIC_FRONTEND_BASE_URL" "$FRONTEND_URL"
set_env_value "$ROOT_ENV" "PUBLIC_BACKEND_BASE_URL" "$BACKEND_URL"
set_env_value "$ROOT_ENV" "CORS_ORIGINS" "$APP_CORS_ORIGINS"
set_env_value "$ROOT_ENV" "BREVO_BASE_URL" "$BREVO_BASE_URL"
set_env_value "$ROOT_ENV" "BREVO_SENDER_EMAIL" "$BREVO_SENDER_EMAIL"
set_env_value "$ROOT_ENV" "BREVO_SENDER_NAME" "$BREVO_SENDER_NAME"
set_env_value "$ROOT_ENV" "BREVO_SANDBOX" "$BREVO_SANDBOX"
set_env_value "$ROOT_ENV" "VITE_API_BASE_URL" "$FRONTEND_DEV_API_BASE_URL"
set_env_value "$ROOT_ENV" "MAX_VIDEO_UPLOAD_MB" "512"
set_env_value "$ROOT_ENV" "NGINX_CLIENT_MAX_BODY_SIZE" "$NGINX_CLIENT_MAX_BODY_SIZE"
set_env_value "$ROOT_ENV" "WORKERS" "$WORKERS"
set_env_value "$ROOT_ENV" "DB_DISABLE_POOLING" "$DB_DISABLE_POOLING_VALUE"
if [[ -n "$DB_POOL_SIZE_VALUE" ]]; then
  set_env_value "$ROOT_ENV" "DB_POOL_SIZE" "$DB_POOL_SIZE_VALUE"
fi
if [[ -n "$DB_MAX_OVERFLOW_VALUE" ]]; then
  set_env_value "$ROOT_ENV" "DB_MAX_OVERFLOW" "$DB_MAX_OVERFLOW_VALUE"
fi
if [[ -n "$DB_POOL_TIMEOUT_VALUE" ]]; then
  set_env_value "$ROOT_ENV" "DB_POOL_TIMEOUT_SECONDS" "$DB_POOL_TIMEOUT_VALUE"
fi
set_env_value "$ROOT_ENV" "AUTO_APPLY_MIGRATIONS" "$AUTO_APPLY_MIGRATIONS_VALUE"
set_env_value "$ROOT_ENV" "PRECHECK_ALLOW_TEST_BYPASS" "$PRECHECK_ALLOW_TEST_BYPASS"
set_env_value "$ROOT_ENV" "WEB_REPORT_SCHEDULER_ENABLED" "$WEB_REPORT_SCHEDULER_ENABLED"
set_env_value "$ROOT_ENV" "MEDIA_STORAGE_PROVIDER" "$MEDIA_STORAGE_PROVIDER"
set_env_value "$ROOT_ENV" "PROCTORING_VIDEO_STORAGE_PROVIDER" "$PROCTORING_VIDEO_STORAGE_PROVIDER"

set_env_value "$BACKEND_LOCAL_ENV" "DATABASE_URL" "$APP_DATABASE_URL"
set_env_value "$BACKEND_LOCAL_ENV" "DATABASE_MIGRATION_URL" "$APP_DATABASE_MIGRATION_URL"
set_env_value "$BACKEND_LOCAL_ENV" "JWT_SECRET" "$JWT_SECRET"
set_env_value "$BACKEND_LOCAL_ENV" "FRONTEND_BASE_URL" "$APP_FRONTEND_URL"
set_env_value "$BACKEND_LOCAL_ENV" "BACKEND_BASE_URL" "$APP_BACKEND_URL"
set_env_value "$BACKEND_LOCAL_ENV" "CORS_ORIGINS" "$APP_CORS_ORIGINS"
set_env_value "$BACKEND_LOCAL_ENV" "AUTO_APPLY_MIGRATIONS" "$AUTO_APPLY_MIGRATIONS_VALUE"
set_env_value "$BACKEND_LOCAL_ENV" "PRECHECK_ALLOW_TEST_BYPASS" "$PRECHECK_ALLOW_TEST_BYPASS"
set_env_value "$BACKEND_LOCAL_ENV" "WEB_REPORT_SCHEDULER_ENABLED" "$WEB_REPORT_SCHEDULER_ENABLED"
set_env_value "$BACKEND_LOCAL_ENV" "DB_DISABLE_POOLING" "$DB_DISABLE_POOLING_VALUE"
if [[ -n "$DB_POOL_SIZE_VALUE" ]]; then
  set_env_value "$BACKEND_LOCAL_ENV" "DB_POOL_SIZE" "$DB_POOL_SIZE_VALUE"
fi
if [[ -n "$DB_MAX_OVERFLOW_VALUE" ]]; then
  set_env_value "$BACKEND_LOCAL_ENV" "DB_MAX_OVERFLOW" "$DB_MAX_OVERFLOW_VALUE"
fi
if [[ -n "$DB_POOL_TIMEOUT_VALUE" ]]; then
  set_env_value "$BACKEND_LOCAL_ENV" "DB_POOL_TIMEOUT_SECONDS" "$DB_POOL_TIMEOUT_VALUE"
fi
set_env_value "$BACKEND_LOCAL_ENV" "MAX_VIDEO_UPLOAD_MB" "512"
set_env_value "$BACKEND_LOCAL_ENV" "MEDIA_STORAGE_PROVIDER" "$MEDIA_STORAGE_PROVIDER"
set_env_value "$BACKEND_LOCAL_ENV" "PROCTORING_VIDEO_STORAGE_PROVIDER" "$PROCTORING_VIDEO_STORAGE_PROVIDER"

set_env_value "$BACKEND_ENV" "DATABASE_URL" "$APP_DATABASE_URL"
set_env_value "$BACKEND_ENV" "DATABASE_MIGRATION_URL" "$APP_DATABASE_MIGRATION_URL"
set_env_value "$BACKEND_ENV" "JWT_SECRET" "$JWT_SECRET"
set_env_value "$BACKEND_ENV" "FRONTEND_BASE_URL" "$FRONTEND_URL"
set_env_value "$BACKEND_ENV" "BACKEND_BASE_URL" "$BACKEND_URL"
set_env_value "$BACKEND_ENV" "CORS_ORIGINS" "$CORS_ORIGINS"
set_env_value "$BACKEND_ENV" "BREVO_API_KEY" "$BREVO_API_KEY"
set_env_value "$BACKEND_ENV" "BREVO_BASE_URL" "$BREVO_BASE_URL"
set_env_value "$BACKEND_ENV" "BREVO_SENDER_EMAIL" "$BREVO_SENDER_EMAIL"
set_env_value "$BACKEND_ENV" "BREVO_SENDER_NAME" "$BREVO_SENDER_NAME"
set_env_value "$BACKEND_ENV" "BREVO_SANDBOX" "$BREVO_SANDBOX"
set_env_value "$BACKEND_ENV" "AUTO_APPLY_MIGRATIONS" "$AUTO_APPLY_MIGRATIONS_VALUE"
set_env_value "$BACKEND_ENV" "MEDIA_STORAGE_PROVIDER" "$MEDIA_STORAGE_PROVIDER"
set_env_value "$BACKEND_ENV" "PROCTORING_VIDEO_STORAGE_PROVIDER" "$PROCTORING_VIDEO_STORAGE_PROVIDER"
if [[ -n "$VIMEO_ACCESS_TOKEN" ]]; then
  set_env_value "$BACKEND_ENV" "VIMEO_ACCESS_TOKEN" "$VIMEO_ACCESS_TOKEN"
fi
set_env_value "$BACKEND_ENV" "PRECHECK_ALLOW_TEST_BYPASS" "$PRECHECK_ALLOW_TEST_BYPASS"
set_env_value "$BACKEND_ENV" "WEB_REPORT_SCHEDULER_ENABLED" "$WEB_REPORT_SCHEDULER_ENABLED"
set_env_value "$BACKEND_ENV" "WORKERS" "$WORKERS"
set_env_value "$BACKEND_ENV" "DB_DISABLE_POOLING" "$DB_DISABLE_POOLING_VALUE"
if [[ -n "$DB_POOL_SIZE_VALUE" ]]; then
  set_env_value "$BACKEND_ENV" "DB_POOL_SIZE" "$DB_POOL_SIZE_VALUE"
fi
if [[ -n "$DB_MAX_OVERFLOW_VALUE" ]]; then
  set_env_value "$BACKEND_ENV" "DB_MAX_OVERFLOW" "$DB_MAX_OVERFLOW_VALUE"
fi
if [[ -n "$DB_POOL_TIMEOUT_VALUE" ]]; then
  set_env_value "$BACKEND_ENV" "DB_POOL_TIMEOUT_SECONDS" "$DB_POOL_TIMEOUT_VALUE"
fi

set_env_value "$FRONTEND_ENV" "VITE_API_BASE_URL" "/api/"
set_env_value "$FRONTEND_ENV" "VITE_PRECHECK_TEST_BYPASS" "$PRECHECK_ALLOW_TEST_BYPASS"
set_env_value "$FRONTEND_ENV" "NGINX_CLIENT_MAX_BODY_SIZE" "$NGINX_CLIENT_MAX_BODY_SIZE"

set_env_value "$FRONTEND_LOCAL_ENV" "VITE_API_BASE_URL" "$FRONTEND_DEV_API_BASE_URL"

mkdir -p \
  "${REPO_ROOT}/backend/storage" \
  "${REPO_ROOT}/backend/storage/videos" \
  "${REPO_ROOT}/backend/storage/evidence" \
  "${REPO_ROOT}/backend/storage/identity" \
  "${REPO_ROOT}/backend/storage/reports" \
  "${REPO_ROOT}/backend/storage/video_chunks"

if [[ "$PREPARE_ONLY" -eq 1 ]]; then
  log "Prepared env files and storage directories."
  exit 0
fi

ensure_docker

if [[ "$RUN_LOCAL_DB" == "1" ]]; then
  log "Running in local PostgreSQL mode."
else
  log "Running in external PostgreSQL mode."
fi

preflight_memory_warning
if ! database_connectivity_check; then
  log "WARNING: Database preflight failed. Continuing to service startup; post-start health checks will validate the deployment."
fi

prepare_backend_for_deploy

log "Building backend image..."
(
  cd "$REPO_ROOT"
  compose build backend
)

# Local-DB mode: the migration runs with --no-deps, so the Postgres container
# must already be up (else 'db' does not resolve). No-op in external/production
# mode (RUN_LOCAL_DB=0), so main is unaffected.
if [[ "$RUN_LOCAL_DB" == "1" ]]; then
  log "Starting local database container before migrations..."
  (
    cd "$REPO_ROOT"
    compose up -d db
  )
  wait_for_service_health db 120 || log "WARNING: db health not confirmed; migration will surface a clear error if it can't connect."
fi

log "Running database migrations (timeout: ${DB_MIGRATION_TIMEOUT_SECONDS}s)..."
(
  cd "$REPO_ROOT"
  # Run migrations in a one-shot container before the backend starts.
  # This avoids a race where the Docker health check times out while
  # slow DDL (CREATE INDEX on large tables) runs inside the startup CMD.
  # If a migration stalls on a long lock or DDL, fail fast with a clear error.
  # --no-deps: do not start redis / other services just for migrations.
  migration_exit_code=0
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
    timeout --foreground --signal=TERM --kill-after=30s "${DB_MIGRATION_TIMEOUT_SECONDS}s" \
      docker compose "${COMPOSE_FILES[@]}" run --rm --no-deps backend alembic upgrade head || migration_exit_code=$?
  if (( migration_exit_code != 0 )); then
    dump_latest_backend_migration_logs
    cleanup_stale_backend_migration_containers
    if (( migration_exit_code == 124 )); then
      die "Database migrations timed out after ${DB_MIGRATION_TIMEOUT_SECONDS}s."
    fi
    die "Database migrations failed with exit code ${migration_exit_code}."
  fi
)

log "Starting services..."
(
  cd "$REPO_ROOT"
  compose up --build -d --remove-orphans --force-recreate
)

sleep 3

backend_cid="$(compose ps -a -q backend 2>/dev/null || true)"
if [[ -n "$backend_cid" ]]; then
  backend_state="$(docker inspect --format '{{.State.Status}}' "$backend_cid" 2>/dev/null || true)"
  if [[ "$backend_state" == "exited" || "$backend_state" == "dead" ]]; then
    docker logs --tail 200 "$backend_cid" >&2 || true
    die "Backend container crashed on startup."
  fi
fi

wait_for_service_health backend "$BACKEND_HEALTH_TIMEOUT_SECONDS"
seed_demo_data
seed_login_users
wait_for_service_health frontend "$FRONTEND_HEALTH_TIMEOUT_SECONDS"

API_HEALTH_URL="${BACKEND_URL%/}"
if [[ "$API_HEALTH_URL" == */api ]]; then
  API_HEALTH_URL="${API_HEALTH_URL}/health"
else
  API_HEALTH_URL="${API_HEALTH_URL}/api/health"
fi
DB_HEALTH_URL="${API_HEALTH_URL%/health}/health/db"
LOGIN_URL="${FRONTEND_URL%/}/login"

require_http_200 "$FRONTEND_URL" "Frontend"
# Local backend host port (prod: 8000; dev remaps to 8001 via SYRA_LOCAL_BACKEND_PORT).
require_http_200 "http://127.0.0.1:${SYRA_LOCAL_BACKEND_PORT:-8000}/api/health" "Local API health" 10 6 5
require_http_200 "http://127.0.0.1:${SYRA_LOCAL_BACKEND_PORT:-8000}/api/health/db" "Local API DB health" 15 6 5
require_http_200 "$API_HEALTH_URL" "API health" 30 6 5
require_http_200 "$DB_HEALTH_URL" "API DB health" 30 6 5

log "Stack started."
(
  cd "$REPO_ROOT"
  compose ps
)

if [[ "$RUN_LOCAL_DB" == "1" ]]; then
  STOP_CMD="docker compose -f docker-compose.yml -f docker-compose.local-db.yml down"
else
  STOP_CMD="docker compose -f docker-compose.yml down"
fi

cat <<EOF

App: ${FRONTEND_URL}
Login: ${LOGIN_URL}
API health: ${API_HEALTH_URL}
DB health: ${DB_HEALTH_URL}

Standard login users are managed by:
  SYRA_SEED_LOGIN_USERS=${SEED_LOGIN_USERS}
  SYRA_RESET_LOGIN_PASSWORDS=${RESET_LOGIN_PASSWORDS}

Default login passwords when accounts are created or reset:
  admin@example.com / ${ADMIN_PASSWORD}
  instructor@example.com / ${INSTRUCTOR_PASSWORD}
  student1@example.com / ${STUDENT_PASSWORD}
  student2@example.com / ${STUDENT_PASSWORD}

Stop the stack with:
  ${STOP_CMD}
EOF
