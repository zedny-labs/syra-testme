param(
    [switch]$SkipFrontendE2E = $false
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$backendRoot = Join-Path $repoRoot "backend"
$frontendRoot = Join-Path $repoRoot "frontend"
$backendTestPath = Join-Path $repoRoot "_workspace_nonruntime/tests/backend/tests"
$backendTestSupportPath = Join-Path $repoRoot "_workspace_nonruntime/tests/backend"
$frontendUnitMirrorPath = Join-Path $repoRoot "_workspace_nonruntime/tests/frontend/src"
$frontendE2EPath = Join-Path $repoRoot "_workspace_nonruntime/tests/frontend/tests/e2e"
$testDbManager = Join-Path $repoRoot "scripts/manage-test-db.py"

Set-Location $backendRoot

Write-Host "===== Running backend tests ====="
$venvPython = Join-Path $backendRoot ".venv\Scripts\python.exe"
$python = if (Test-Path $venvPython) { $venvPython } else { "python" }
if (-not (Test-Path $backendTestPath)) {
    throw "Backend test path not found: $backendTestPath"
}

$originalEnv = @{
    PYTHONPATH = $env:PYTHONPATH
    JWT_SECRET = $env:JWT_SECRET
    SECRET_KEY = $env:SECRET_KEY
    DATABASE_URL = $env:DATABASE_URL
    AUTO_APPLY_MIGRATIONS = $env:AUTO_APPLY_MIGRATIONS
    PRECHECK_ALLOW_TEST_BYPASS = $env:PRECHECK_ALLOW_TEST_BYPASS
    E2E_SEED_ENABLED = $env:E2E_SEED_ENABLED
    PLAYWRIGHT_BACKEND_PORT = $env:PLAYWRIGHT_BACKEND_PORT
    PLAYWRIGHT_FRONTEND_PORT = $env:PLAYWRIGHT_FRONTEND_PORT
    PLAYWRIGHT_BASE_URL = $env:PLAYWRIGHT_BASE_URL
    PLAYWRIGHT_REUSE_EXISTING_SERVER = $env:PLAYWRIGHT_REUSE_EXISTING_SERVER
    API_BASE_URL = $env:API_BASE_URL
    BACKEND_BASE_URL = $env:BACKEND_BASE_URL
    FRONTEND_BASE_URL = $env:FRONTEND_BASE_URL
    MEDIA_STORAGE_PROVIDER = $env:MEDIA_STORAGE_PROVIDER
    PROCTORING_VIDEO_STORAGE_PROVIDER = $env:PROCTORING_VIDEO_STORAGE_PROVIDER
}

$env:PYTHONPATH = "$backendRoot\.deps;$backendRoot;$backendRoot\src;$backendTestSupportPath"
$env:JWT_SECRET = "test-secret-key-with-at-least-32-chars"
$env:SECRET_KEY = "test-secret-key-with-at-least-32-chars"
$env:DATABASE_URL = if ($env:DATABASE_URL) { $env:DATABASE_URL } else { "postgresql+psycopg://postgres:password@localhost:5432/syra_lms" }
$env:AUTO_APPLY_MIGRATIONS = "false"
$env:PRECHECK_ALLOW_TEST_BYPASS = "true"

try {
    & $python -m pytest -q $backendTestPath
    if ($LASTEXITCODE -ne 0) {
        throw "Backend tests failed with exit code $LASTEXITCODE"
    }
}
finally {
    $env:PYTHONPATH = $originalEnv.PYTHONPATH
    $env:JWT_SECRET = $originalEnv.JWT_SECRET
    $env:SECRET_KEY = $originalEnv.SECRET_KEY
    $env:DATABASE_URL = $originalEnv.DATABASE_URL
    $env:AUTO_APPLY_MIGRATIONS = $originalEnv.AUTO_APPLY_MIGRATIONS
    $env:PRECHECK_ALLOW_TEST_BYPASS = $originalEnv.PRECHECK_ALLOW_TEST_BYPASS
}

Write-Host "===== Running frontend unit tests (mirrored full suite) ====="
Set-Location $frontendRoot
if (-not (Test-Path $frontendUnitMirrorPath)) {
    throw "Frontend mirrored unit test path not found: $frontendUnitMirrorPath"
}
& npm.cmd run test -- --run
if ($LASTEXITCODE -ne 0) {
    throw "Frontend unit tests failed with exit code $LASTEXITCODE"
}

if (-not $SkipFrontendE2E) {
    Write-Host "===== Running frontend end-to-end tests (mirrored suite) ====="
    if (-not (Test-Path $frontendE2EPath)) {
        throw "Frontend mirrored E2E test path not found: $frontendE2EPath"
    }
    if (-not (Test-Path $testDbManager)) {
        throw "E2E test database manager not found: $testDbManager"
    }

    $e2eDatabaseUrl = $null
    try {
        $env:JWT_SECRET = "test-secret-key-with-at-least-32-chars"
        $env:SECRET_KEY = "test-secret-key-with-at-least-32-chars"
        $env:AUTO_APPLY_MIGRATIONS = "true"
        $env:PRECHECK_ALLOW_TEST_BYPASS = "true"
        $env:E2E_SEED_ENABLED = "true"
        $env:PLAYWRIGHT_BACKEND_PORT = "8001"
        $env:PLAYWRIGHT_FRONTEND_PORT = "5174"
        $env:PLAYWRIGHT_BASE_URL = "http://127.0.0.1:5174"
        $env:PLAYWRIGHT_REUSE_EXISTING_SERVER = "false"
        $env:API_BASE_URL = "http://127.0.0.1:8001/api/"
        $env:BACKEND_BASE_URL = "http://127.0.0.1:8001"
        $env:FRONTEND_BASE_URL = "http://127.0.0.1:5174"
        $env:MEDIA_STORAGE_PROVIDER = "local"
        $env:PROCTORING_VIDEO_STORAGE_PROVIDER = "supabase"

        $e2eDatabaseOutput = & $python $testDbManager create-isolated
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to create isolated E2E database"
        }
        $e2eDatabaseUrl = $e2eDatabaseOutput | Select-Object -Last 1
        if ([string]::IsNullOrWhiteSpace($e2eDatabaseUrl)) {
            throw "Failed to create isolated E2E database"
        }
        $e2eDatabaseUrl = $e2eDatabaseUrl.Trim()

        Write-Host "Using isolated E2E database $e2eDatabaseUrl"
        $env:DATABASE_URL = $e2eDatabaseUrl

        & npm.cmd run test:e2e
        if ($LASTEXITCODE -ne 0) {
            throw "Frontend end-to-end tests failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        if (-not [string]::IsNullOrWhiteSpace($e2eDatabaseUrl)) {
            & $python $testDbManager drop $e2eDatabaseUrl
            if ($LASTEXITCODE -ne 0) {
                Write-Warning "Failed to drop isolated E2E database $e2eDatabaseUrl"
            }
        }

        $env:PLAYWRIGHT_BACKEND_PORT = $originalEnv.PLAYWRIGHT_BACKEND_PORT
        $env:PLAYWRIGHT_FRONTEND_PORT = $originalEnv.PLAYWRIGHT_FRONTEND_PORT
        $env:PLAYWRIGHT_BASE_URL = $originalEnv.PLAYWRIGHT_BASE_URL
        $env:PLAYWRIGHT_REUSE_EXISTING_SERVER = $originalEnv.PLAYWRIGHT_REUSE_EXISTING_SERVER
        $env:API_BASE_URL = $originalEnv.API_BASE_URL
        $env:BACKEND_BASE_URL = $originalEnv.BACKEND_BASE_URL
        $env:FRONTEND_BASE_URL = $originalEnv.FRONTEND_BASE_URL
        $env:MEDIA_STORAGE_PROVIDER = $originalEnv.MEDIA_STORAGE_PROVIDER
        $env:PROCTORING_VIDEO_STORAGE_PROVIDER = $originalEnv.PROCTORING_VIDEO_STORAGE_PROVIDER
        $env:E2E_SEED_ENABLED = $originalEnv.E2E_SEED_ENABLED
        $env:JWT_SECRET = $originalEnv.JWT_SECRET
        $env:SECRET_KEY = $originalEnv.SECRET_KEY
        $env:DATABASE_URL = $originalEnv.DATABASE_URL
        $env:AUTO_APPLY_MIGRATIONS = $originalEnv.AUTO_APPLY_MIGRATIONS
        $env:PRECHECK_ALLOW_TEST_BYPASS = $originalEnv.PRECHECK_ALLOW_TEST_BYPASS
    }
}

Write-Host "===== Full test run complete ====="
