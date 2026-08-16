from __future__ import annotations

import logging
import secrets
import string
import uuid
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError

from ...models import Exam, ExamStatus, ExamType, RoleEnum
from ...services.audit import write_audit_log
from ...services.notifications import notify_user
from ...services.normalized_relations import (
    apply_runtime_attempt_policy_defaults,
    exam_archived_at,
    exam_certificate,
    exam_code,
    exam_proctoring,
    exam_published_at,
    exam_randomize_questions,
    exam_report_content,
    exam_report_displayed,
    exam_runtime_settings,
    exam_security_settings,
    exam_ui_config,
    mutate_exam_admin_meta,
    normalize_certificate_issue_rule,
    runtime_attempt_policy_conflicts,
    set_exam_runtime_settings,
)
from ...core.i18n import translate as _t
from ...services.report_rendering import render_report_template
from ...services.sanitization import sanitize_html_fragment, sanitize_instructions
from ...utils.pagination import PaginationParams, build_page_response
from .enums import ReportContent, ReportDisplayed, TestStatus, TestType
from .proctoring_requirements import normalize_proctoring_config
from .repository import TestListQuery, TestListRow, TestRepository
from .schemas import TestCreateDTO, TestResponseDTO


DEFAULT_UI_CONFIG = {
    "displayed_columns": ["name", "code", "type", "status", "time_limit_minutes", "testing_sessions"],
}

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class ServiceActor:
    id: uuid.UUID | None
    role: RoleEnum | None


class TestServiceError(Exception):
    def __init__(self, *, code: str, message: str, status_code: int, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}

    def to_response(self) -> dict:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "details": self.details,
            }
        }


class TestService:
    def __init__(self, repository: TestRepository):
        self.repository = repository

    def list_tests(
        self,
        *,
        actor: ServiceActor,
        pagination: PaginationParams,
        status: tuple[TestStatus, ...] | None = None,
        test_type=None,
        category_id: uuid.UUID | None = None,
        created_from: datetime | None = None,
        created_to: datetime | None = None,
    ) -> dict:
        query = TestListQuery(
            owner_id=actor.id if actor.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR} else None,
            search=pagination.search,
            status=status,
            type=test_type,
            category_id=category_id,
            created_from=created_from,
            created_to=created_to,
            sort=pagination.sort,
            order=pagination.order,
            page=pagination.page,
            page_size=pagination.page_size,
        )
        items, total, schedule_counts, question_counts = self.repository.list_tests(query)
        payload = [
            self._serialize_list_item(
                exam,
                testing_sessions=schedule_counts.get(exam.id, 0),
                question_count=question_counts.get(exam.id, 0),
            )
            for exam in items
        ]
        return build_page_response(items=payload, total=total, pagination=pagination)

    def create_test(
        self,
        *,
        body: TestCreateDTO,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> TestResponseDTO:
        if body.code and self.repository.code_exists(body.code.strip()):
            self._raise("VALIDATION_ERROR", "Code already exists", status_code=400)

        runtime_settings = apply_runtime_attempt_policy_defaults(
            sanitize_instructions(body.runtime_settings or {}),
            body.attempts_allowed or 1,
        )
        self._assert_runtime_attempt_policy(runtime_settings, body.attempts_allowed or 1)

        node = self._ensure_node(actor, body.node_id)
        now = datetime.now(timezone.utc)
        exam = Exam(
            node_id=node.id,
            title=body.name.strip(),
            description=sanitize_html_fragment(body.description),
            type=ExamType(body.type.value),
            status=ExamStatus.CLOSED,
            time_limit=body.time_limit_minutes or 60,
            max_attempts=body.attempts_allowed or 1,
            passing_score=body.passing_score,
            category_id=body.category_id,
            grading_scale_id=body.grading_scale_id,
            created_by_id=actor.id,
            created_at=now,
            updated_at=now,
        )
        self.repository.create_test(
            exam=exam,
            runtime_settings=runtime_settings,
            proctoring_config=normalize_proctoring_config(body.proctoring_config or {}),
            certificate=body.certificate,
        )
        mutate_exam_admin_meta(
            exam,
            code=body.code.strip() if body.code else None,
            randomize_questions=True if body.randomize_questions is None else body.randomize_questions,
            report_displayed=(body.report_displayed or ReportDisplayed.IMMEDIATELY_AFTER_GRADING).value,
            report_content=(body.report_content or ReportContent.SCORE_AND_DETAILS).value,
            ui_config=body.ui_config or deepcopy(DEFAULT_UI_CONFIG),
            settings=body.settings.model_dump() if body.settings else None,
            published_at=None,
            archived_at=None,
        )
        self.repository.commit()
        self.repository.refresh(exam)
        self._invalidate_test_list_cache()
        self._write_audit_log(
            actor=actor,
            action="TEST_CREATED",
            resource_id=str(exam.id),
            detail=f"Created test: {exam.title}",
            request_ip=request_ip,
        )
        return self._serialize_detail(exam)

    def get_test(self, test_id: str, *, actor: ServiceActor) -> TestResponseDTO:
        exam = self._get_test_or_raise(test_id, actor=actor)
        return self._serialize_detail(exam)

    def update_test(
        self,
        *,
        test_id: str,
        body,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> TestResponseDTO:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        payload = body.model_dump(exclude_unset=True, exclude_none=True)
        if "certificate" in getattr(body, "model_fields_set", set()) and body.certificate is None:
            payload["certificate"] = None
        self._assert_can_mutate(exam, set(payload.keys()))
        return self._update_test_with_retry(
            test_id=test_id,
            exam=exam,
            payload=payload,
            actor=actor,
            request_ip=request_ip,
        )
        next_max_attempts = payload.get("attempts_allowed", exam.max_attempts)

        if "code" in payload:
            next_code = payload["code"].strip() if payload["code"] else None
            if next_code and self.repository.code_exists(next_code, exclude_exam_id=exam.id):
                self._raise("VALIDATION_ERROR", "Code already exists", status_code=400)
            mutate_exam_admin_meta(exam, code=next_code)
        if "name" in payload:
            exam.title = payload["name"].strip()
        if "description" in payload:
            exam.description = sanitize_html_fragment(payload["description"])
        if "type" in payload:
            exam.type = ExamType(payload["type"])
        if "node_id" in payload:
            exam.node_id = self._ensure_node(actor, payload["node_id"]).id
        if "category_id" in payload:
            exam.category_id = payload["category_id"]
        if "grading_scale_id" in payload:
            exam.grading_scale_id = payload["grading_scale_id"]
        if "time_limit_minutes" in payload:
            exam.time_limit = payload["time_limit_minutes"]
        if "attempts_allowed" in payload:
            exam.max_attempts = payload["attempts_allowed"]
        if "passing_score" in payload:
            exam.passing_score = payload["passing_score"]
        if "runtime_settings" in payload:
            sanitized_runtime = apply_runtime_attempt_policy_defaults(
                sanitize_instructions(
                    deepcopy(payload["runtime_settings"]) if isinstance(payload["runtime_settings"], dict) else {}
                ),
                next_max_attempts,
            )
            self._assert_runtime_attempt_policy(sanitized_runtime, next_max_attempts)
            set_exam_runtime_settings(exam, sanitized_runtime)
        elif "attempts_allowed" in payload and next_max_attempts > 1:
            current_runtime = exam_runtime_settings(exam)
            if current_runtime.get("allow_retake") is False:
                set_exam_runtime_settings(exam, {**current_runtime, "allow_retake": True})
        if "proctoring_config" in payload:
            from ...services.normalized_relations import set_exam_proctoring, exam_proctoring

            old_config = exam_proctoring(exam) or {}
            new_config = normalize_proctoring_config(payload["proctoring_config"] or {})
            set_exam_proctoring(exam, new_config)
            # Write a dedicated audit entry with the config diff
            changed_keys = [
                k for k in set(list(old_config.keys()) + list(new_config.keys()))
                if old_config.get(k) != new_config.get(k)
            ]
            if changed_keys:
                diff_parts = []
                for k in sorted(changed_keys)[:20]:
                    diff_parts.append(f"{k}: {old_config.get(k)!r} → {new_config.get(k)!r}")
                self._write_audit_log(
                    actor=actor,
                    action="PROCTORING_CONFIG_UPDATED",
                    resource_id=str(exam.id),
                    detail=f"Proctoring config changed on '{exam.title}': {'; '.join(diff_parts)}",
                    request_ip=request_ip,
                )
        if "certificate" in payload:
            from ...services.normalized_relations import set_exam_certificate

            set_exam_certificate(exam, payload["certificate"])

        admin_updates = {}
        for field in ("randomize_questions", "report_displayed", "report_content", "ui_config", "settings"):
            if field in payload:
                admin_updates[field] = payload[field]
        if admin_updates:
            mutate_exam_admin_meta(exam, **admin_updates)

        exam.updated_at = datetime.now(timezone.utc)
        self.repository.save(exam)
        self.repository.commit()
        self.repository.refresh(exam)
        self._invalidate_test_list_cache()
        self._write_audit_log(
            actor=actor,
            action="TEST_UPDATED",
            resource_id=str(exam.id),
            detail=f"Updated test: {exam.title}",
            request_ip=request_ip,
        )
        return self._serialize_detail(exam)

    def _update_test_with_retry(
        self,
        *,
        test_id: str,
        exam: Exam,
        payload: dict,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> TestResponseDTO:
        for attempt in range(2):
            try:
                self._apply_test_update_payload(
                    exam=exam,
                    payload=payload,
                    actor=actor,
                    request_ip=request_ip,
                )
                self.repository.save(exam)
                self.repository.commit()
                self.repository.refresh(exam)
                self._invalidate_test_list_cache()
                self._write_audit_log(
                    actor=actor,
                    action="TEST_UPDATED",
                    resource_id=str(exam.id),
                    detail=f"Updated test: {exam.title}",
                    request_ip=request_ip,
                )
                return self._serialize_detail(exam)
            except IntegrityError as exc:
                self.repository.rollback()
                if attempt >= 1 or not self._is_retryable_test_update_conflict(exc):
                    raise
                logger.warning(
                    "Retrying concurrent test update after config insert conflict",
                    extra={"test_id": test_id, "actor_id": str(actor.id) if actor.id else None},
                )
                exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        return self._serialize_detail(exam)

    def _apply_test_update_payload(
        self,
        *,
        exam: Exam,
        payload: dict,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> None:
        next_max_attempts = payload.get("attempts_allowed", exam.max_attempts)

        if "code" in payload:
            next_code = payload["code"].strip() if payload["code"] else None
            if next_code and self.repository.code_exists(next_code, exclude_exam_id=exam.id):
                self._raise("VALIDATION_ERROR", "Code already exists", status_code=400)
            mutate_exam_admin_meta(exam, code=next_code)
        if "name" in payload:
            exam.title = payload["name"].strip()
        if "description" in payload:
            exam.description = sanitize_html_fragment(payload["description"])
        if "type" in payload:
            exam.type = ExamType(payload["type"])
        if "node_id" in payload:
            exam.node_id = self._ensure_node(actor, payload["node_id"]).id
        if "category_id" in payload:
            exam.category_id = payload["category_id"]
        if "grading_scale_id" in payload:
            exam.grading_scale_id = payload["grading_scale_id"]
        if "time_limit_minutes" in payload:
            exam.time_limit = payload["time_limit_minutes"]
        if "attempts_allowed" in payload:
            exam.max_attempts = payload["attempts_allowed"]
        if "passing_score" in payload:
            exam.passing_score = payload["passing_score"]
        if "runtime_settings" in payload:
            sanitized_runtime = apply_runtime_attempt_policy_defaults(
                sanitize_instructions(
                    deepcopy(payload["runtime_settings"]) if isinstance(payload["runtime_settings"], dict) else {}
                ),
                next_max_attempts,
            )
            self._assert_runtime_attempt_policy(sanitized_runtime, next_max_attempts)
            set_exam_runtime_settings(exam, sanitized_runtime)
        elif "attempts_allowed" in payload and next_max_attempts > 1:
            current_runtime = exam_runtime_settings(exam)
            if current_runtime.get("allow_retake") is False:
                set_exam_runtime_settings(exam, {**current_runtime, "allow_retake": True})
        if "proctoring_config" in payload:
            from ...services.normalized_relations import set_exam_proctoring, exam_proctoring

            old_config = exam_proctoring(exam) or {}
            new_config = normalize_proctoring_config(payload["proctoring_config"] or {})
            set_exam_proctoring(exam, new_config)
            changed_keys = [
                key for key in set(list(old_config.keys()) + list(new_config.keys()))
                if old_config.get(key) != new_config.get(key)
            ]
            if changed_keys:
                diff_parts = []
                for key in sorted(changed_keys)[:20]:
                    diff_parts.append(f"{key}: {old_config.get(key)!r} â†’ {new_config.get(key)!r}")
                self._write_audit_log(
                    actor=actor,
                    action="PROCTORING_CONFIG_UPDATED",
                    resource_id=str(exam.id),
                    detail=f"Proctoring config changed on '{exam.title}': {'; '.join(diff_parts)}",
                    request_ip=request_ip,
                )
        if "certificate" in payload:
            from ...services.normalized_relations import set_exam_certificate

            set_exam_certificate(exam, payload["certificate"])

        admin_updates = {}
        for field in ("randomize_questions", "report_displayed", "report_content", "ui_config", "settings"):
            if field in payload:
                admin_updates[field] = payload[field]
        if admin_updates:
            mutate_exam_admin_meta(exam, **admin_updates)

        exam.updated_at = datetime.now(timezone.utc)

    def _is_retryable_test_update_conflict(self, exc: IntegrityError) -> bool:
        detail = " ".join(
            str(part)
            for part in (
                getattr(exc, "orig", None),
                getattr(exc, "statement", None),
                exc,
            )
            if part
        ).lower()
        retryable_markers = (
            "exam_certificate_configs",
            "exam_certificate_configs_pkey",
            "exam_runtime_configs",
            "exam_runtime_instruction_items",
            "exam_runtime_translations",
            "exam_runtime_extra_settings",
            "exam_proctoring_configs",
            "exam_proctoring_alert_rules",
        )
        return any(marker in detail for marker in retryable_markers)

    def _assert_runtime_attempt_policy(self, runtime_settings: dict | None, max_attempts: int | None) -> None:
        if runtime_attempt_policy_conflicts(runtime_settings, max_attempts):
            self._raise(
                "VALIDATION_ERROR",
                "Enable retakes or reduce max attempts to 1.",
                status_code=422,
            )

    def publish_test(self, *, test_id: str, actor: ServiceActor) -> TestResponseDTO:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        if not exam.title or not exam.title.strip():
            self._raise("VALIDATION_ERROR", "Name is required before publishing", status_code=400)
        if self.repository.question_count(exam.id) <= 0:
            self._raise("VALIDATION_ERROR", "Test must have at least one question before publishing", status_code=400)
        if not exam_code(exam):
            mutate_exam_admin_meta(exam, code=self._generate_code())

        if self._status(exam) != TestStatus.PUBLISHED:
            now = datetime.now(timezone.utc)
            exam.status = ExamStatus.OPEN
            exam.updated_at = now
            mutate_exam_admin_meta(exam, published_at=now, archived_at=None)
            self.repository.save(exam)
            self.repository.commit()
            self.repository.refresh(exam)
            self._invalidate_test_list_cache()
            self._write_audit_log(
                actor=actor,
                action="TEST_PUBLISHED",
                resource_id=str(exam.id),
                detail=exam.title,
                request_ip=None,
            )
            self._notify_published(exam)
        return self._serialize_detail(exam)

    def duplicate_test(
        self,
        *,
        test_id: str,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> TestResponseDTO:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        duplicate = self.repository.duplicate_test(exam, actor.id)
        mutate_exam_admin_meta(duplicate, code=None, published_at=None, archived_at=None)
        duplicate.updated_at = duplicate.created_at
        self.repository.commit()
        self.repository.refresh(duplicate)
        self._invalidate_test_list_cache()
        self._write_audit_log(
            actor=actor,
            action="TEST_DUPLICATED",
            resource_id=str(duplicate.id),
            detail=f"Duplicated test: {exam.title} -> {duplicate.title}",
            request_ip=request_ip,
        )
        return self._serialize_detail(duplicate)

    def archive_test(self, *, test_id: str, actor: ServiceActor) -> TestResponseDTO:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        previous_status = self._status(exam)
        if previous_status == TestStatus.ARCHIVED:
            return self._serialize_detail(exam)

        now = datetime.now(timezone.utc)
        exam.status = ExamStatus.CLOSED
        exam.updated_at = now
        mutate_exam_admin_meta(exam, archived_at=now)
        self.repository.save(exam)
        self.repository.commit()
        self.repository.refresh(exam)
        self._invalidate_test_list_cache()
        if previous_status == TestStatus.PUBLISHED:
            self._write_audit_log(
                actor=actor,
                action="TEST_UNPUBLISHED",
                resource_id=str(exam.id),
                detail=exam.title,
                request_ip=None,
            )
        self._write_audit_log(
            actor=actor,
            action="TEST_ARCHIVED",
            resource_id=str(exam.id),
            detail=exam.title,
            request_ip=None,
        )
        return self._serialize_detail(exam)

    def unarchive_test(self, *, test_id: str, actor: ServiceActor) -> TestResponseDTO:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        now = datetime.now(timezone.utc)
        previously_published_at = exam_published_at(exam)
        if previously_published_at is None:
            exam.status = ExamStatus.CLOSED
            mutate_exam_admin_meta(exam, archived_at=None)
        else:
            exam.status = ExamStatus.OPEN
            mutate_exam_admin_meta(exam, archived_at=None, published_at=previously_published_at)
        exam.updated_at = now
        self.repository.save(exam)
        self.repository.commit()
        self.repository.refresh(exam)
        self._invalidate_test_list_cache()
        self._write_audit_log(
            actor=actor,
            action="TEST_UNARCHIVED",
            resource_id=str(exam.id),
            detail=exam.title,
            request_ip=None,
        )
        return self._serialize_detail(exam)

    def delete_test(
        self,
        *,
        test_id: str,
        actor: ServiceActor,
        request_ip: str | None,
    ) -> None:
        exam = self._get_test_for_write_or_raise(test_id, actor=actor)
        if self._status(exam) != TestStatus.DRAFT:
            self._raise("FORBIDDEN", "Only draft tests can be deleted", status_code=409)
        if self.repository.attempt_count(exam.id) > 0:
            self._raise("FORBIDDEN", "Cannot delete a test with attempts", status_code=409)

        for user_id in self.repository.scheduled_user_ids(exam.id):
            notify_user(
                self.repository.db,
                user_id,
                "Test Cancelled",
                f"The test '{exam.title}' has been removed.",
                "/schedule",
            )
        exam_id = str(exam.id)
        exam_title = exam.title
        self.repository.delete(exam)
        self.repository.commit()
        self._invalidate_test_list_cache()
        self._write_audit_log(
            actor=actor,
            action="TEST_DELETED",
            resource_id=exam_id,
            detail=f"Deleted test: {exam_title}",
            request_ip=request_ip,
        )

    def render_report(self, test_id: str, *, actor: ServiceActor) -> str:
        exam = self._get_test_or_raise(test_id, actor=actor)
        attempts = self.repository.list_report_attempts(exam.id)
        labels = {
            "user": _t("report_user"),
            "status": _t("report_status"),
            "score": _t("report_score"),
            "no_attempts_yet": _t("report_no_attempts_yet"),
        }
        return render_report_template(
            "test_report.html",
            report_title=f"{exam.title} Report",
            generated_at=datetime.now(timezone.utc).isoformat(),
            exam_title=exam.title,
            rows=[
                {
                    "user_name": attempt.user.name if attempt.user else "",
                    "status": getattr(attempt.status, "value", attempt.status),
                    "score": "" if attempt.score is None else attempt.score,
                }
                for attempt in attempts
            ],
            labels=labels,
        )

    def _get_test_or_raise(self, test_id: str, *, actor: ServiceActor) -> Exam:
        exam = self.repository.get_test(self._parse_test_id(test_id))
        if exam is None:
            self._raise("NOT_FOUND", "Test not found", status_code=404)
        self._ensure_actor_can_access_exam(exam, actor)
        return exam

    def _get_test_for_write_or_raise(self, test_id: str, *, actor: ServiceActor) -> Exam:
        exam = self.repository.get_test_for_write(self._parse_test_id(test_id))
        if exam is None:
            self._raise("NOT_FOUND", "Test not found", status_code=404)
        self._ensure_actor_can_access_exam(exam, actor)
        return exam

    def _ensure_actor_can_access_exam(self, exam: Exam, actor: ServiceActor) -> None:
        if actor.role in {RoleEnum.ADMIN, RoleEnum.INSTRUCTOR} and exam.created_by_id == actor.id:
            return
        self._raise("NOT_FOUND", "Test not found", status_code=404)

    def _ensure_node(self, actor: ServiceActor, node_id: uuid.UUID | None):
        actor_proxy = type(
            "Actor",
            (),
            {"id": actor.id, "role": actor.role or RoleEnum.ADMIN},
        )()
        try:
            return self.repository.ensure_node(actor_proxy, node_id)
        except LookupError:
            self._raise("NOT_FOUND", "Node not found", status_code=404)

    def _generate_code(self) -> str:
        alphabet = string.ascii_uppercase + string.digits
        for _ in range(20):
            code = "".join(secrets.choice(alphabet) for _ in range(secrets.choice(range(6, 13))))
            if not self.repository.code_exists(code):
                return code
        self._raise("VALIDATION_ERROR", "Unable to generate unique code", status_code=400)

    def _assert_can_mutate(self, exam: Exam, fields: set[str]) -> None:
        status = self._status(exam)
        if status == TestStatus.ARCHIVED:
            self._raise("LOCKED_FIELDS", "Archived tests are read-only", status_code=409)

    def _status(self, exam: Exam) -> TestStatus:
        return self._status_from_runtime(
            is_archived=bool(exam_archived_at(exam)),
            runtime_status=getattr(exam, "status", None),
        )

    def _serialize_detail(self, exam: Exam) -> TestResponseDTO:
        node = exam.node
        course = node.course if node else None
        return TestResponseDTO.model_validate(
            {
                "id": exam.id,
                "code": exam_code(exam),
                "name": exam.title,
                "description": exam.description,
                "type": self._test_type_value(getattr(exam, "type", None)),
                "status": self._status(exam).value,
                "runtime_status": self._runtime_status_value(getattr(exam, "status", None)),
                "node_id": exam.node_id,
                "node_title": node.title if node else None,
                "course_id": course.id if course else None,
                "course_title": course.title if course else None,
                "category_id": exam.category_id,
                "grading_scale_id": exam.grading_scale_id,
                "time_limit_minutes": exam.time_limit or 60,
                "attempts_allowed": exam.max_attempts or 1,
                "passing_score": exam.passing_score,
                "randomize_questions": exam_randomize_questions(exam),
                "report_displayed": exam_report_displayed(exam).value,
                "report_content": exam_report_content(exam).value,
                "ui_config": exam_ui_config(exam),
                "settings": exam_security_settings(exam),
                "runtime_settings": exam_runtime_settings(exam),
                "proctoring_config": exam_proctoring(exam),
                "certificate": exam_certificate(exam),
                "question_count": len(exam.questions or []),
                "created_by_id": exam.created_by_id,
                "created_by_name": exam.creator.name if exam.creator else None,
                "created_at": exam.created_at,
                "updated_at": exam.updated_at,
                "published_at": exam_published_at(exam),
                "archived_at": exam_archived_at(exam),
            }
        )

    def _serialize_list_item(self, exam: TestListRow, *, testing_sessions: int, question_count: int) -> dict:
        category = None
        if exam.category_id and exam.category_name:
            category = {"id": exam.category_id, "name": exam.category_name}
        return {
            "id": exam.id,
            "code": exam.code,
            "name": exam.name or "Untitled test",
            "type": self._test_type_value(exam.raw_type),
            "status": self._status_from_runtime(
                is_archived=exam.is_archived,
                runtime_status=exam.raw_runtime_status,
            ).value,
            "category": category,
            "time_limit_minutes": exam.time_limit_minutes or 60,
            "testing_sessions": testing_sessions,
            "question_count": question_count,
            "certificate": self._serialize_list_certificate(exam),
            "created_at": exam.created_at,
            "updated_at": exam.updated_at,
        }

    def _status_from_runtime(self, *, is_archived: bool, runtime_status) -> TestStatus:
        if is_archived:
            return TestStatus.ARCHIVED
        if self._runtime_status_value(runtime_status) == ExamStatus.OPEN.value:
            return TestStatus.PUBLISHED
        return TestStatus.DRAFT

    def _test_type_value(self, raw_type) -> str:
        normalized = getattr(raw_type, "value", raw_type)
        try:
            return TestType(str(normalized or TestType.MCQ.value)).value
        except ValueError:
            return TestType.MCQ.value

    def _runtime_status_value(self, raw_status) -> str:
        normalized = getattr(raw_status, "value", raw_status)
        try:
            return ExamStatus(str(normalized or ExamStatus.CLOSED.value)).value
        except ValueError:
            return ExamStatus.CLOSED.value

    def _serialize_list_certificate(self, exam: TestListRow) -> dict | None:
        certificate = deepcopy(exam.certificate) if isinstance(exam.certificate, dict) else {}
        for key, value in (
            ("title", exam.certificate_title),
            ("subtitle", exam.certificate_subtitle),
            ("issuer", exam.certificate_issuer),
            ("signer", exam.certificate_signer),
        ):
            if value not in {None, ""}:
                certificate[key] = value
        if not certificate:
            return None
        certificate["issue_rule"] = normalize_certificate_issue_rule(certificate.get("issue_rule"))
        return {key: value for key, value in certificate.items() if value not in {None, ""}} or None

    def _notify_published(self, exam: Exam) -> None:
        seen: set[str] = set()
        for user_id in self.repository.scheduled_user_ids(exam.id):
            user_key = str(user_id)
            if user_key in seen:
                continue
            seen.add(user_key)
            notify_user(
                self.repository.db,
                user_id,
                title="Test published",
                message=f"{exam.title} is now published and available.",
                link=f"/tests/{exam.id}",
            )

    def _write_audit_log(
        self,
        *,
        actor: ServiceActor,
        action: str,
        resource_id: str,
        detail: str,
        request_ip: str | None,
    ) -> None:
        write_audit_log(
            self.repository.db,
            actor.id,
            action=action,
            resource_type="test",
            resource_id=resource_id,
            detail=detail,
            ip_address=request_ip,
        )

    def _parse_test_id(self, raw_value: str) -> uuid.UUID:
        try:
            return uuid.UUID(str(raw_value))
        except (ValueError, TypeError):
            self._raise("NOT_FOUND", "Test not found", status_code=404)

    def _raise(self, code: str, message: str, *, status_code: int, details: dict | None = None) -> None:
        raise TestServiceError(code=code, message=message, status_code=status_code, details=details)

    def _invalidate_test_list_cache(self) -> None:
        pass
