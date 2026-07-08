from fastapi import APIRouter

from .routes import (
    auth,
    users,
    courses,
    nodes,
    exams,
    questions,
    attempts,
    schedules,
    categories,
    grading_scales,
    question_pools,
    dashboard,
    proctoring,
    notifications,
    gdpr,
    surveys,
    user_groups,
    exam_templates,
    report_schedules,
    integrations,
    audit_log,
    admin_settings,
    health,
    testing,
    search,
    ai,
    reports,
    precheck,
)

router = APIRouter(redirect_slashes=False)


@router.get("/version", tags=["health"])
def version():
    """Git SHA baked into this deploy (BUILD_SHA). The deploy pipeline curls this
    to verify the running app is serving exactly the shipped commit."""
    from ..core.config import settings

    sha = settings.BUILD_SHA or ""
    return {"sha": sha, "short_sha": sha[:7], "service": "syra"}


router.include_router(auth.router, prefix="/auth", tags=["auth"])
router.include_router(users.router, prefix="/users", tags=["users"])
router.include_router(courses.router, prefix="/courses", tags=["courses"])
router.include_router(nodes.router, prefix="/nodes", tags=["nodes"])
router.include_router(exams.router, prefix="/exams", tags=["exams"])
router.include_router(questions.router, prefix="/questions", tags=["questions"])
router.include_router(attempts.router, prefix="/attempts", tags=["attempts"])
router.include_router(schedules.router, prefix="/schedules", tags=["schedules"])
router.include_router(categories.router, prefix="/categories", tags=["categories"])
router.include_router(grading_scales.router, prefix="/grading-scales", tags=["grading-scales"])
router.include_router(question_pools.router, prefix="/question-pools", tags=["question-pools"])
router.include_router(dashboard.router, prefix="/dashboard", tags=["dashboard"])
router.include_router(proctoring.router, prefix="/proctoring", tags=["proctoring"])
router.include_router(notifications.router, prefix="/notifications", tags=["notifications"])
router.include_router(gdpr.router, tags=["gdpr"])
router.include_router(surveys.router, prefix="/surveys", tags=["surveys"])
router.include_router(user_groups.router, prefix="/user-groups", tags=["user-groups"])
router.include_router(exam_templates.router, prefix="/exam-templates", tags=["exam-templates"])
router.include_router(report_schedules.router, prefix="/report-schedules", tags=["report-schedules"])
router.include_router(integrations.router, prefix="/integrations", tags=["integrations"])
router.include_router(audit_log.router, prefix="/audit-log", tags=["audit-log"])
router.include_router(admin_settings.router, prefix="/admin-settings", tags=["admin-settings"])
router.include_router(search.router, prefix="/search", tags=["search"])
router.include_router(ai.router, prefix="/ai", tags=["ai"])
router.include_router(reports.router, prefix="/reports", tags=["reports"])
router.include_router(precheck.router, tags=["precheck"])
try:
    from ..modules.tests.routes_admin import router as tests_router
except Exception as exc:
    raise RuntimeError("Failed to register admin tests router (/admin/tests)") from exc
router.include_router(tests_router, tags=["tests"])
router.include_router(health.router, tags=["health"])
router.include_router(testing.router, tags=["testing"])
