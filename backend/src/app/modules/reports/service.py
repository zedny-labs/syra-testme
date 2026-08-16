from __future__ import annotations

import csv
import io
import json
import re
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from croniter import croniter
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import and_, case, func, select
from sqlalchemy.orm import joinedload, selectinload

from ...api.deps import parse_uuid_param
from ...core.config import get_settings
from ...core.security import create_report_access_token
from ...models import Attempt, AttemptStatus, Exam, ExamStatus, ProctoringEvent, ReportSchedule, RoleEnum, SeverityEnum, SystemSettings, User
from ...schemas import CustomReportExportRequest, CustomReportPreview
from ...services.audit import write_audit_log
from ...services.email import send_email
from ...services.integrations import send_report_integration_event
from ...services.normalized_relations import exam_archived_at, exam_code, is_exam_pool_library
from ...services.pdf_fonts import shape_for_paragraph, shape_table_data
from ...core.i18n import translate as _t
from ...services.report_rendering import render_report_template
from ...services.supabase_storage import upload_bytes as upload_bytes_to_supabase
from .repository import ReportRepository
from .schemas import Message, ReportScheduleCreate, ReportScheduleRunResult


CUSTOM_REPORT_DATASETS = {
    "attempts": ["id", "test_title", "user_name", "status", "score", "started_at", "submitted_at"],
    "tests": ["id", "name", "code", "status", "type", "time_limit_minutes", "question_count", "course_title"],
    "users": ["id", "user_id", "name", "email", "role", "is_active", "created_at"],
}
CUSTOM_REPORT_COLUMN_ALIASES = {
    "attempts": {
        "exam_title": "test_title",
    }
}
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
REPORT_TYPES = {"attempt-summary", "risk-alerts", "usage"}
CRON_FIELD_RE = re.compile(r"^[\d*/,\-]+$")
settings = get_settings()


class ReportService:
    def __init__(self, repository: ReportRepository):
        self.repository = repository

    def _require_actor(self, actor_id):
        if not actor_id:
            raise HTTPException(status_code=403, detail=_t("not_allowed"))

    def preview_custom_report(self, body: CustomReportExportRequest, *, actor_id=None, actor_role=None) -> CustomReportPreview:
        self._require_actor(actor_id)
        requested_columns, available_columns = self._validate_custom_report_columns(body.dataset, body.columns)
        rows, _ = self._build_custom_report_rows(body.dataset, body.search, actor_id=actor_id, actor_role=actor_role)
        selected_rows = self._select_custom_report_columns(rows, requested_columns)
        return CustomReportPreview(
            rows=selected_rows[:10],
            total=len(selected_rows),
            available_columns=available_columns,
        )

    def export_custom_report(self, *, body: CustomReportExportRequest, actor_id, actor_role=None) -> StreamingResponse:
        self._require_actor(actor_id)
        requested_columns, _ = self._validate_custom_report_columns(body.dataset, body.columns)
        rows, _ = self._build_custom_report_rows(body.dataset, body.search, actor_id=actor_id, actor_role=actor_role)
        selected_rows = self._select_custom_report_columns(rows, requested_columns)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        write_audit_log(
            self.repository.db,
            actor_id,
            action="CUSTOM_REPORT_EXPORTED",
            resource_type="custom_report",
            resource_id=body.dataset,
            detail=f"dataset={body.dataset}; rows={len(selected_rows)}; search={body.search or ''}",
        )
        return self._csv_response(selected_rows, f"{body.dataset}_report_{ts}.csv", columns=requested_columns)

    def generate_predefined_report(self, *, slug: str, actor_id, actor_role=None) -> StreamingResponse:
        self._require_actor(actor_id)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

        if slug in {"test-performance", "exam-performance"}:
            query = (
                select(
                    Exam.title,
                    func.count(Attempt.id).label("attempt_count"),
                    func.count(case((Attempt.status != AttemptStatus.IN_PROGRESS, 1))).label("submitted_count"),
                    func.avg(case((Attempt.status != AttemptStatus.IN_PROGRESS, Attempt.score), else_=None)).label("avg_score"),
                    func.count(
                        case(
                            (
                                and_(
                                    Attempt.status != AttemptStatus.IN_PROGRESS,
                                    Exam.passing_score.is_not(None),
                                    Attempt.score.is_not(None),
                                    Attempt.score >= Exam.passing_score,
                                ),
                                1,
                            )
                        )
                    ).label("passed_count"),
                )
                .select_from(Exam)
                .outerjoin(Attempt, Attempt.exam_id == Exam.id)
                .where(Exam.library_pool_id.is_(None))
            )
            if actor_id:
                query = query.where(Exam.created_by_id == actor_id)
            query = query.group_by(Exam.id, Exam.title, Exam.passing_score, Exam.created_at).order_by(Exam.created_at.desc())
            exam_rows = self.repository.execute(query).all()
            rows = []
            for title, attempt_count, submitted_count, avg_score, passed_count in exam_rows:
                submitted_total = int(submitted_count or 0)
                pass_rate = ((int(passed_count or 0) / submitted_total) * 100) if submitted_total else 0
                rows.append(
                    {
                        "Test": title,
                        "Attempts": int(attempt_count or 0),
                        "Avg Score": f"{float(avg_score or 0):.1f}",
                        "Pass Rate": f"{pass_rate:.1f}%",
                    }
                )
            self._write_predefined_audit(actor_id, slug)
            return self._csv_response(rows, f"{slug}_{ts}.csv")

        if slug == "proctoring-alerts":
            proctoring_query = (
                select(
                    Attempt.id,
                    User.name,
                    User.user_id,
                    func.sum(case((ProctoringEvent.severity == SeverityEnum.HIGH, 1), else_=0)).label("high_alerts"),
                    func.sum(case((ProctoringEvent.severity == SeverityEnum.MEDIUM, 1), else_=0)).label("medium_alerts"),
                )
                .select_from(Attempt)
                .outerjoin(User, User.id == Attempt.user_id)
                .outerjoin(ProctoringEvent, ProctoringEvent.attempt_id == Attempt.id)
            )
            if actor_id:
                proctoring_query = proctoring_query.join(Exam, Exam.id == Attempt.exam_id).where(Exam.created_by_id == actor_id)
            proctoring_query = proctoring_query.group_by(Attempt.id, User.name, User.user_id, Attempt.created_at).order_by(Attempt.created_at.desc())
            attempt_rows = self.repository.execute(proctoring_query).all()
            rows = [
                {
                    "Attempt": str(attempt_id),
                    "User": user_name or user_id or "",
                    "High Alerts": int(high_alerts or 0),
                    "Medium Alerts": int(medium_alerts or 0),
                }
                for attempt_id, user_name, user_id, high_alerts, medium_alerts in attempt_rows
            ]
            self._write_predefined_audit(actor_id, slug)
            return self._csv_response(rows, f"{slug}_{ts}.csv")

        if slug == "learner-activity":
            learner_query = (
                select(
                    User.name,
                    func.count(Attempt.id).label("attempt_count"),
                    func.count(case((Attempt.status != AttemptStatus.IN_PROGRESS, 1))).label("submitted_count"),
                )
                .select_from(User)
            )
            if actor_id:
                learner_query = (
                    learner_query
                    .outerjoin(Attempt, Attempt.user_id == User.id)
                    .outerjoin(Exam, Exam.id == Attempt.exam_id)
                    .where(User.role == RoleEnum.LEARNER)
                    .where(Exam.created_by_id == actor_id)
                )
            else:
                learner_query = (
                    learner_query
                    .outerjoin(Attempt, Attempt.user_id == User.id)
                    .where(User.role == RoleEnum.LEARNER)
                )
            learner_query = learner_query.group_by(User.id, User.name, User.created_at).order_by(User.created_at.desc())
            learner_rows = self.repository.execute(learner_query).all()
            rows = [
                {
                    "User": user_name,
                    "Attempts": int(attempt_count or 0),
                    "Submitted": int(submitted_count or 0),
                }
                for user_name, attempt_count, submitted_count in learner_rows
            ]
            self._write_predefined_audit(actor_id, slug)
            return self._csv_response(rows, f"{slug}_{ts}.csv")

        raise HTTPException(status_code=404, detail=_t("unknown_report_slug"))

    def generate_test_report_csv(self, *, test_id: str, actor_id) -> StreamingResponse:
        self._require_actor(actor_id)
        _, exam = self._get_test_or_404(test_id, actor_id=actor_id)
        attempts = self.repository.scalars(select(Attempt).where(Attempt.exam_id == exam.id)).all()
        self._load_attempt_report_events(attempts)
        rows = self._build_test_report_rows(exam, attempts)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_title = re.sub(r'[^\w\-]', '_', (exam.title or str(exam.id)))
        write_audit_log(
            self.repository.db,
            actor_id,
            action="EXAM_REPORT_EXPORTED",
            resource_type="exam",
            resource_id=str(exam.id),
            detail="format=csv",
        )
        return self._csv_response(
            rows
            or [
                {
                    "Test": exam.title or str(exam.id),
                    "Attempt": "",
                    "User Name": "",
                    "User ID": "",
                    "User Email": "",
                    "Status": "",
                    "Score": "",
                    "Started": "",
                    "Submitted": "",
                    "PrecheckPassed": "",
                    "ID Verified": "",
                    "LightingScore": "",
                    "High Alerts": "",
                    "Medium Alerts": "",
                    "Low Alerts": "",
                    "Total Events": "",
                    "Timeline": "",
                }
            ],
            f"test_{safe_title}_{ts}.csv",
        )

    def generate_test_report_pdf(self, *, test_id: str, actor_id) -> StreamingResponse:
        self._require_actor(actor_id)
        _, exam = self._get_test_or_404(test_id, actor_id=actor_id)
        attempts = self.repository.scalars(select(Attempt).where(Attempt.exam_id == exam.id)).all()
        buf = BytesIO()
        doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=32, rightMargin=32, topMargin=32, bottomMargin=32)
        styles = getSampleStyleSheet()
        story = []

        story.append(Paragraph(f"<b>Test Report:</b> {shape_for_paragraph(str(exam.title or exam.id))}", styles["Title"]))
        story.append(Paragraph(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}", styles["Normal"]))

        total_attempts = len(attempts)
        submitted = [attempt for attempt in attempts if attempt.submitted_at]
        scored = [attempt.score for attempt in attempts if attempt.score is not None]
        avg_score = round(sum(scored) / len(scored), 2) if scored else "N/A"
        pass_rate = "N/A"
        if submitted and exam.passing_score is not None:
            passed = [attempt for attempt in submitted if (attempt.score or 0) >= exam.passing_score]
            pass_rate = f"{round((len(passed) / len(submitted)) * 100, 1)}%" if submitted else "N/A"

        summary_data = [
            ["Type", exam.type, "Status", exam.status],
            ["Category", getattr(exam, "category_id", ""), "Time limit", f"{exam.time_limit} min"],
            ["Max attempts", getattr(exam, "max_attempts", ""), "Total attempts", total_attempts],
            ["Submitted", len(submitted), "Avg score / Pass rate", f"{avg_score} / {pass_rate}"],
        ]
        summary_data, summary_arabic_cells = shape_table_data(summary_data)
        summary_table = Table(summary_data, hAlign="LEFT", colWidths=[80, 140, 90, 120])
        summary_table.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, 0), colors.whitesmoke),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
                    ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                    ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                    ("FONTSIZE", (0, 0), (-1, -1), 9),
                    *summary_arabic_cells,
                ]
            )
        )
        story.append(Spacer(1, 8))
        story.append(summary_table)
        story.append(Spacer(1, 12))

        if not attempts:
            story.append(Paragraph(_t("no_attempts_report"), styles["Normal"]))
        else:
            for attempt in attempts:
                events = self.repository.scalars(
                    select(ProctoringEvent)
                    .where(ProctoringEvent.attempt_id == attempt.id)
                    .order_by(ProctoringEvent.occurred_at)
                ).all()
                high = sum(1 for event in events if event.severity == SeverityEnum.HIGH)
                med = sum(1 for event in events if event.severity == SeverityEnum.MEDIUM)
                low = sum(1 for event in events if event.severity == SeverityEnum.LOW)

                story.append(Paragraph(f"Attempt {str(attempt.id)}", styles["Heading3"]))
                info_rows = [
                    ["User", attempt.user.name if attempt.user else ""],
                    ["User ID", attempt.user.user_id if attempt.user else ""],
                    ["Email", attempt.user.email if attempt.user else ""],
                    ["Status", attempt.status],
                    ["Score", attempt.score if attempt.score is not None else "N/A"],
                    ["Started", attempt.started_at or "N/A"],
                    ["Submitted", attempt.submitted_at or "N/A"],
                    ["Precheck passed", "Yes" if attempt.precheck_passed_at else "No"],
                    ["ID verified", "Yes" if attempt.id_verified else "No"],
                    ["Lighting score", round(attempt.lighting_score, 3) if attempt.lighting_score is not None else "N/A"],
                    ["Alerts (H/M/L)", f"{high}/{med}/{low}"],
                    ["Total events", len(events)],
                ]
                info_rows, info_arabic_cells = shape_table_data(info_rows)
                info_table = Table(info_rows, hAlign="LEFT", colWidths=[120, 360])
                info_table.setStyle(
                    TableStyle(
                        [
                            ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
                            ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                            ("BACKGROUND", (0, 0), (0, -1), colors.whitesmoke),
                            ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                            ("FONTSIZE", (0, 0), (-1, -1), 9),
                            *info_arabic_cells,
                        ]
                    )
                )
                story.append(info_table)
                story.append(Spacer(1, 8))

                if events:
                    story.append(Paragraph("Proctoring Timeline", styles["Heading4"]))
                    event_data = [["Time", "Event", "Severity", "Detail"]]
                    for event in events:
                        ts = event.occurred_at.strftime("%Y-%m-%d %H:%M:%S") if event.occurred_at else ""
                        event_data.append([ts, event.event_type, event.severity.value, event.detail or ""])
                    event_data, event_arabic_cells = shape_table_data(event_data)
                    event_table = Table(event_data, hAlign="LEFT", colWidths=[110, 110, 70, 230])
                    event_table.setStyle(
                        TableStyle(
                            [
                                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#0f172a")),
                                ("TEXTCOLOR", (0, 0), (-1, 0), colors.whitesmoke),
                                ("BOX", (0, 0), (-1, -1), 0.5, colors.grey),
                                ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
                                ("FONTNAME", (0, 0), (-1, -1), "Helvetica"),
                                ("FONTSIZE", (0, 0), (-1, -1), 8),
                                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                                *event_arabic_cells,
                            ]
                        )
                    )
                    story.append(event_table)
                else:
                    story.append(Paragraph("No proctoring events recorded.", styles["Normal"]))
                story.append(Spacer(1, 16))

        doc.build(story)
        buf.seek(0)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        safe_pdf_title = re.sub(r'[^\w\-]', '_', (exam.title or str(exam.id)))
        filename = f"test_{safe_pdf_title}_{ts}.pdf"
        write_audit_log(
            self.repository.db,
            actor_id,
            action="EXAM_REPORT_EXPORTED",
            resource_type="exam",
            resource_id=str(exam.id),
            detail="format=pdf",
        )
        return StreamingResponse(
            buf,
            media_type="application/pdf",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def create_report_schedule(self, *, body: ReportScheduleCreate, actor_id) -> ReportSchedule:
        payload = self._normalize_schedule_payload(body)
        schedule = ReportSchedule(
            name=payload["name"],
            report_type=payload["report_type"],
            schedule_cron=payload["schedule_cron"],
            recipients=payload["recipients"],
            is_active=payload["is_active"],
            created_by_id=actor_id,
        )
        self.repository.add(schedule)
        self.repository.commit()
        self.repository.refresh(schedule)
        write_audit_log(
            self.repository.db,
            actor_id,
            action="REPORT_SCHEDULE_CREATED",
            resource_type="report_schedule",
            resource_id=str(schedule.id),
            detail=f"type={schedule.report_type}",
        )
        return schedule

    def list_report_schedules(self, *, actor_id=None) -> list[ReportSchedule]:
        query = select(ReportSchedule).order_by(ReportSchedule.created_at.desc())
        if actor_id:
            query = query.where(ReportSchedule.created_by_id == actor_id)
        return self.repository.scalars(query).all()

    def get_report_schedule(self, schedule_id: str, *, actor_id=None) -> ReportSchedule:
        schedule_pk = parse_uuid_param(schedule_id, detail=_t("not_found"))
        schedule = self.repository.get(ReportSchedule, schedule_pk)
        if not schedule:
            raise HTTPException(status_code=404, detail=_t("not_found"))
        if actor_id and schedule.created_by_id != actor_id:
            raise HTTPException(status_code=403, detail=_t("not_allowed"))
        return schedule

    def delete_report_schedule(self, *, schedule_id: str, actor_id) -> Message:
        schedule = self.get_report_schedule(schedule_id, actor_id=actor_id)
        schedule_name = schedule.name
        self.repository.delete(schedule)
        self.repository.commit()
        write_audit_log(
            self.repository.db,
            actor_id,
            action="REPORT_SCHEDULE_DELETED",
            resource_type="report_schedule",
            resource_id=schedule_id,
            detail=schedule_name,
        )
        return Message(detail=_t("deleted"))

    async def run_schedule_now(self, *, schedule_id: str, actor_id) -> ReportScheduleRunResult:
        schedule = self.get_report_schedule(schedule_id, actor_id=actor_id)
        artifact = await self._run_report_schedule(schedule)
        report_url = artifact["report_url"]
        subscribers = self._load_subscribers()
        recipients = list({*(schedule.recipients or []), *subscribers})
        send_status = "no recipients"
        if recipients:
            results = [
                await send_email(f"Report {schedule.name}", recipient, f"Report generated: {report_url}")
                for recipient in recipients
            ]
            normalized_results = [result is not False for result in results]
            if all(normalized_results):
                send_status = "sent"
            elif any(normalized_results):
                send_status = "partially sent"
            else:
                send_status = "delivery failed"
        try:
            await send_report_integration_event(report_url, self._load_integrations())
        except Exception:
            pass
        write_audit_log(
            self.repository.db,
            actor_id,
            action="REPORT_SCHEDULE_RUN",
            resource_type="report_schedule",
            resource_id=str(schedule.id),
            detail=f"type={schedule.report_type}; recipients={len(recipients)}",
        )
        return ReportScheduleRunResult(
            detail=f"Report generated successfully (emails: {send_status})",
            report_url=report_url,
            email_status=send_status,
        )

    def _csv_response(self, rows: list[dict], filename: str, columns: list[str] | None = None) -> StreamingResponse:
        if not rows and not columns:
            raise HTTPException(status_code=400, detail=_t("no_data_to_export"))
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=columns or list(rows[0].keys()))
        writer.writeheader()
        if rows:
            writer.writerows(rows)
        buffer.seek(0)
        return StreamingResponse(
            iter([buffer.getvalue()]),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def _serialize_value(self, value):
        if value is None:
            return ""
        if isinstance(value, datetime):
            return value.isoformat()
        if hasattr(value, "value"):
            return value.value
        return value

    def _normalize_custom_report_column(self, dataset: str, column: str) -> str:
        aliases = CUSTOM_REPORT_COLUMN_ALIASES.get(dataset, {})
        return aliases.get(column, column)

    def _validate_custom_report_columns(self, dataset: str, requested: list[str]) -> tuple[list[str], list[str]]:
        allowed = CUSTOM_REPORT_DATASETS.get(dataset)
        if not allowed:
            raise HTTPException(status_code=400, detail=_t("unknown_dataset"))
        normalized: list[str] = []
        seen = set()
        invalid: list[str] = []
        for column in requested:
            canonical = self._normalize_custom_report_column(dataset, column)
            if canonical in seen:
                continue
            if canonical not in allowed:
                invalid.append(column)
                continue
            seen.add(canonical)
            normalized.append(canonical)
        if invalid:
            raise HTTPException(status_code=400, detail=_t("unsupported_columns", dataset=dataset, invalid=", ".join(invalid)))
        return normalized, allowed

    def _build_custom_report_rows(self, dataset: str, search: str | None = None, *, actor_id=None, actor_role=None) -> tuple[list[dict], list[str]]:
        dataset = dataset or ""
        if dataset == "attempts":
            query = (
                select(Attempt)
                .options(joinedload(Attempt.exam), joinedload(Attempt.user))
                .order_by(Attempt.created_at.desc())
            )
            if actor_id:
                query = query.where(Attempt.exam_id.in_(select(Exam.id).where(Exam.created_by_id == actor_id)))
            attempts = self.repository.scalars(query).unique().all()
            rows = [
                {
                    "id": str(attempt.id),
                    "test_title": attempt.exam.title if attempt.exam else "",
                    "exam_title": attempt.exam.title if attempt.exam else "",
                    "user_name": attempt.user.name if attempt.user else "",
                    "status": self._serialize_value(attempt.status),
                    "score": attempt.score if attempt.score is not None else "",
                    "started_at": self._serialize_value(attempt.started_at),
                    "submitted_at": self._serialize_value(attempt.submitted_at),
                }
                for attempt in attempts
            ]
        elif dataset == "tests":
            from ...models import Node, Course
            test_query = (
                select(Exam)
                .options(joinedload(Exam.node).joinedload(Node.course))
                .order_by(Exam.created_at.desc())
            )
            if actor_id:
                test_query = test_query.where(Exam.created_by_id == actor_id)
            exams = self.repository.scalars(test_query).unique().all()
            rows = []
            for exam in exams:
                if is_exam_pool_library(exam):
                    continue
                course = exam.node.course if exam.node and exam.node.course else None
                rows.append(
                    {
                        "id": str(exam.id),
                        "name": exam.title or "",
                        "code": str(exam_code(exam) or ""),
                        "status": self._test_status(exam),
                        "type": self._serialize_value(exam.type),
                        "time_limit_minutes": exam.time_limit or "",
                        "question_count": exam.question_count or 0,
                        "course_title": course.title if course else "",
                    }
                )
        elif dataset == "users":
            user_query = select(User).order_by(User.created_at.desc())
            if actor_id:
                # Only show users who have attempted exams created by this actor
                user_query = user_query.where(
                    User.id.in_(
                        select(Attempt.user_id).where(
                            Attempt.exam_id.in_(select(Exam.id).where(Exam.created_by_id == actor_id))
                        )
                    )
                )
            users = self.repository.scalars(user_query).all()
            rows = [
                {
                    "id": str(user.id),
                    "user_id": user.user_id or "",
                    "name": user.name or "",
                    "email": user.email or "",
                    "role": self._serialize_value(user.role),
                    "is_active": bool(user.is_active),
                    "created_at": self._serialize_value(user.created_at),
                }
                for user in users
            ]
        else:
            raise HTTPException(status_code=400, detail=_t("unknown_dataset"))

        query = (search or "").strip().lower()
        if query:
            rows = [
                row for row in rows if any(query in str(self._serialize_value(value)).lower() for value in row.values())
            ]
        return rows, CUSTOM_REPORT_DATASETS[dataset]

    def _select_custom_report_columns(self, rows: list[dict], columns: list[str]) -> list[dict]:
        return [{column: row.get(column, "") for column in columns} for row in rows]

    def _get_test_or_404(self, exam_id: str, *, actor_id=None) -> tuple[str, Exam]:
        exam_pk = parse_uuid_param(exam_id, detail=_t("test_not_found"))
        exam = self.repository.get(Exam, exam_pk)
        if not exam:
            raise HTTPException(status_code=404, detail=_t("test_not_found"))
        if actor_id and exam.created_by_id != actor_id:
            raise HTTPException(status_code=403, detail=_t("not_allowed"))
        return exam_pk, exam

    def _load_attempt_report_events(self, attempts: list[Attempt]) -> None:
        for attempt in attempts:
            setattr(
                attempt,
                "_report_events",
                self.repository.scalars(
                    select(ProctoringEvent)
                    .where(ProctoringEvent.attempt_id == attempt.id)
                    .order_by(ProctoringEvent.occurred_at)
                ).all(),
            )

    def _build_test_report_rows(self, exam: Exam, attempts: list[Attempt]) -> list[dict]:
        rows = []
        for attempt in attempts:
            events = getattr(attempt, "_report_events", []) or []
            high = sum(1 for event in events if event.severity == SeverityEnum.HIGH)
            med = sum(1 for event in events if event.severity == SeverityEnum.MEDIUM)
            low = sum(1 for event in events if event.severity == SeverityEnum.LOW)
            timeline = " | ".join(
                f"{(event.occurred_at or datetime.now(timezone.utc)).strftime('%H:%M:%S')} {event.event_type} ({event.severity.value}) - {event.detail or ''}"
                for event in events
            )
            rows.append(
                {
                    "Test": exam.title or str(exam.id),
                    "Attempt": str(attempt.id),
                    "User Name": attempt.user.name if attempt.user else "",
                    "User ID": attempt.user.user_id if attempt.user else "",
                    "User Email": attempt.user.email if attempt.user else "",
                    "Status": attempt.status.value if hasattr(attempt.status, "value") else attempt.status,
                    "Score": attempt.score if attempt.score is not None else "",
                    "Started": attempt.started_at.isoformat() if attempt.started_at else "",
                    "Submitted": attempt.submitted_at.isoformat() if attempt.submitted_at else "",
                    "PrecheckPassed": bool(attempt.precheck_passed_at),
                    "ID Verified": bool(attempt.id_verified),
                    "LightingScore": attempt.lighting_score if attempt.lighting_score is not None else "",
                    "High Alerts": high,
                    "Medium Alerts": med,
                    "Low Alerts": low,
                    "Total Events": len(events),
                    "Timeline": timeline,
                }
            )
        return rows

    def _test_status(self, exam: Exam) -> str:
        if exam_archived_at(exam):
            return "ARCHIVED"
        if exam.status == ExamStatus.OPEN:
            return "PUBLISHED"
        return "DRAFT"

    def _write_predefined_audit(self, actor_id, slug: str) -> None:
        write_audit_log(
            self.repository.db,
            actor_id,
            action="PREDEFINED_REPORT_EXPORTED",
            resource_type="predefined_report",
            resource_id=slug,
        )

    def _normalize_schedule_payload(self, body: ReportScheduleCreate) -> dict:
        name = str(body.name or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail=_t("schedule_name_required"))

        report_type = str(body.report_type or "").strip()
        if report_type not in REPORT_TYPES:
            raise HTTPException(status_code=400, detail=_t("invalid_report_type"))

        cron_value = str(body.schedule_cron or "").strip()
        if not cron_value:
            raise HTTPException(status_code=400, detail=_t("valid_cron_required"))
        self._validate_cron_expression(cron_value)

        return {
            "name": name,
            "report_type": report_type,
            "schedule_cron": cron_value,
            "recipients": self._normalize_recipients(body.recipients),
            "is_active": bool(body.is_active),
        }

    def _normalize_recipients(self, raw_recipients: list[str] | None) -> list[str]:
        normalized: list[str] = []
        seen: set[str] = set()
        for raw in raw_recipients or []:
            email = str(raw or "").strip().lower()
            if not email:
                continue
            if not EMAIL_RE.match(email):
                raise HTTPException(status_code=400, detail=_t("invalid_recipient_email", email=email))
            if email in seen:
                continue
            seen.add(email)
            normalized.append(email)
        return normalized

    def _cron_error(self, detail: str) -> None:
        raise HTTPException(status_code=422, detail=detail)

    def _validate_cron_atom(self, atom: str, field_name: str, minimum: int, maximum: int) -> None:
        if atom == "*":
            return
        if "-" in atom:
            parts = atom.split("-", 1)
            if len(parts) != 2 or not all(part.isdigit() for part in parts):
                self._cron_error(f"Invalid cron expression: {field_name} contains an invalid range")
            start, end = (int(part) for part in parts)
            if start > end:
                self._cron_error(f"Invalid cron expression: {field_name} range start cannot exceed end")
            if start < minimum or end > maximum:
                self._cron_error(f"Invalid cron expression: {field_name} range must be between {minimum} and {maximum}")
            return
        if not atom.isdigit():
            self._cron_error(f"Invalid cron expression: {field_name} contains an invalid value")
        value = int(atom)
        if value < minimum or value > maximum:
            self._cron_error(f"Invalid cron expression: {field_name} must be between {minimum} and {maximum}")

    def _validate_cron_field(self, field_value: str, field_name: str, minimum: int, maximum: int) -> None:
        if not field_value or not CRON_FIELD_RE.fullmatch(field_value):
            self._cron_error(f"Invalid cron expression: {field_name} contains unsupported characters")
        for part in field_value.split(","):
            if not part:
                self._cron_error(f"Invalid cron expression: {field_name} contains an empty segment")
            if "/" in part:
                step_parts = part.split("/")
                if len(step_parts) != 2 or not step_parts[1].isdigit() or int(step_parts[1]) <= 0:
                    self._cron_error(f"Invalid cron expression: {field_name} contains an invalid step value")
                self._validate_cron_atom(step_parts[0], field_name, minimum, maximum)
                continue
            self._validate_cron_atom(part, field_name, minimum, maximum)

    def _validate_cron_expression(self, cron_value: str) -> None:
        fields = cron_value.split()
        if len(fields) != 5:
            self._cron_error("Invalid cron expression: expected 5 fields (minute hour day month weekday)")
        limits = (
            ("minute", 0, 59),
            ("hour", 0, 23),
            ("day", 1, 31),
            ("month", 1, 12),
            ("weekday", 0, 7),
        )
        for field_value, (field_name, minimum, maximum) in zip(fields, limits):
            self._validate_cron_field(field_value, field_name, minimum, maximum)

    def _render_attempts_report(self, attempts: list[Attempt]) -> str:
        rows = [
            {
                "attempt_id": str(attempt.id),
                "test_title": attempt.exam.title if attempt.exam else "",
                "user_name": attempt.user.name if attempt.user else "",
                "score": "" if attempt.score is None else attempt.score,
                "status": getattr(attempt.status, "value", attempt.status),
            }
            for attempt in attempts
        ]
        labels = {
            "attempt_id": _t("report_attempt_id"),
            "test": _t("report_test"),
            "user": _t("report_user"),
            "score": _t("report_score"),
            "status": _t("report_status"),
            "no_attempts_found": _t("report_no_attempts_found"),
        }
        return render_report_template(
            "attempt_summary.html",
            report_title="Attempt Summary Report",
            generated_at=datetime.now(timezone.utc).isoformat(),
            rows=rows,
            labels=labels,
        )

    def _render_risk_alerts_report(self, attempts: list[Attempt]) -> str:
        rows = []
        for attempt in attempts:
            events = attempt.events or []
            high = len([event for event in events if str(event.severity) == "SeverityEnum.HIGH" or getattr(event.severity, "value", "") == "HIGH"])
            medium = len([event for event in events if str(event.severity) == "SeverityEnum.MEDIUM" or getattr(event.severity, "value", "") == "MEDIUM"])
            rows.append(
                {
                    "attempt_id": str(attempt.id),
                    "user_name": attempt.user.name if attempt.user else "",
                    "test_title": attempt.exam.title if attempt.exam else "",
                    "high_alerts": high,
                    "medium_alerts": medium,
                }
            )
        labels = {
            "attempt": _t("report_attempt"),
            "user": _t("report_user"),
            "test": _t("report_test"),
            "high_alerts": _t("report_high_alerts"),
            "medium_alerts": _t("report_medium_alerts"),
            "no_alert_data": _t("report_no_alert_data"),
        }
        return render_report_template(
            "risk_alerts.html",
            report_title="Risk Alerts Report",
            generated_at=datetime.now(timezone.utc).isoformat(),
            rows=rows,
            labels=labels,
        )

    def _render_usage_report(self, attempts: list[Attempt]) -> str:
        total = len(attempts)
        graded = len([attempt for attempt in attempts if getattr(attempt.status, "value", attempt.status) == "GRADED"])
        submitted = len([attempt for attempt in attempts if getattr(attempt.status, "value", attempt.status) == "SUBMITTED"])
        in_progress = len([attempt for attempt in attempts if getattr(attempt.status, "value", attempt.status) == "IN_PROGRESS"])
        scores = [attempt.score for attempt in attempts if attempt.score is not None]
        avg_score = round(sum(scores) / len(scores), 2) if scores else None
        return render_report_template(
            "usage.html",
            report_title="Usage Report",
            generated_at=datetime.now(timezone.utc).isoformat(),
            stats=[
                {"label": "Total Attempts", "value": total},
                {"label": "In Progress", "value": in_progress},
                {"label": "Submitted", "value": submitted},
                {"label": "Graded", "value": graded},
                {"label": "Average Score", "value": avg_score if avg_score is not None else "N/A"},
            ],
        )

    def _load_subscribers(self) -> list[str]:
        row = self.repository.scalar(select(SystemSettings).where(SystemSettings.key == "subscribers"))
        if row and row.value:
            try:
                return json.loads(row.value)
            except Exception:
                return []
        return []

    def _load_integrations(self) -> dict:
        row = self.repository.scalar(select(SystemSettings).where(SystemSettings.key == "integrations_config"))
        if row and row.value:
            try:
                return json.loads(row.value)
            except Exception:
                return {}
        return {}

    def _report_public_url(self, filename: Path) -> str:
        base = settings.BACKEND_BASE_URL.rstrip("/")
        token = create_report_access_token(filename.name)
        return f"{base}/api/media/reports/public/{token}"

    def report_schedule_due(self, schedule: ReportSchedule, now: datetime | None = None) -> bool:
        if not getattr(schedule, "is_active", True):
            return False
        cron_value = str(getattr(schedule, "schedule_cron", "") or "").strip()
        if not cron_value:
            return False
        baseline = getattr(schedule, "last_run_at", None) or getattr(schedule, "created_at", None)
        if baseline is None:
            return False
        current_time = now or datetime.now(timezone.utc)
        try:
            next_time = croniter(cron_value, baseline).get_next(datetime)
        except Exception:
            return False
        return next_time <= current_time

    async def _run_report_schedule(self, schedule: ReportSchedule) -> dict[str, str]:
        attempts = self.repository.scalars(
            select(Attempt)
            .options(
                joinedload(Attempt.exam),
                joinedload(Attempt.user),
                selectinload(Attempt.events),
            )
            .order_by(Attempt.created_at.desc())
            .limit(50)
        ).all()
        renderers = {
            "attempt-summary": self._render_attempts_report,
            "risk-alerts": self._render_risk_alerts_report,
            "usage": self._render_usage_report,
        }
        html = renderers.get(schedule.report_type, self._render_attempts_report)(attempts)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        filename = f"{schedule.id}_{ts}.html"
        if settings.MEDIA_STORAGE_PROVIDER == "supabase":
            stored = await upload_bytes_to_supabase(
                "reports",
                filename,
                html.encode("utf-8"),
                content_type="text/html; charset=utf-8",
            )
            file_path = str(stored.get("path") or filename)
        else:
            reports_dir = Path(__file__).resolve().parent.parent.parent.parent.parent / "storage" / "reports"
            reports_dir.mkdir(parents=True, exist_ok=True)
            output_path = reports_dir / filename
            output_path.write_text(html, encoding="utf-8")
            file_path = str(output_path)
        schedule.last_run_at = datetime.now(timezone.utc)
        self.repository.add(schedule)
        self.repository.commit()
        return {
            "file_path": file_path,
            "report_url": self._report_public_url(Path(filename)),
        }
