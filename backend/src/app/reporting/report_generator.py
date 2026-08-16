"""Proctoring incident report generators."""

from __future__ import annotations

import base64
import logging
from collections import defaultdict
from datetime import datetime, timezone
from html import escape
from io import BytesIO
from pathlib import Path
from typing import Any

from jinja2 import Environment
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image as RLImage, LongTable, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Attempt, ProctoringEvent
from ..modules.tests.proctoring_requirements import get_proctoring_requirements
from ..services.crypto_utils import decrypt_bytes
from ..services.pdf_fonts import shape_for_paragraph

_logger = logging.getLogger(__name__)
_IDENTITY_DIR = Path(__file__).resolve().parent.parent.parent / "storage" / "identity"

_HTML_ENV = Environment(autoescape=True)
_SEVERITY_ORDER = {"LOW": 1, "MEDIUM": 2, "HIGH": 3}
_VIDEO_EVENT_TYPES = {"VIDEO_SAVED", "VIDEO_UPLOAD_PROGRESS"}
_INVALID_SAVED_VIDEO_STATUSES = {"error", "failed"}
_REPORT_TEMPLATE = _HTML_ENV.from_string(
    """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{ report_title }}</title>
<style>
  :root { --ink:#132238; --muted:#5b6b82; --line:#d8e1ea; --paper:#fff; --panel:#f7fafc; --brand:#0f766e; --brand-soft:#d8f3ef; --warn:#b45309; --warn-soft:#ffedd5; --bad:#b91c1c; --bad-soft:#fee2e2; --info:#1d4ed8; --info-soft:#dbeafe; }
  * { box-sizing:border-box; }
  body { margin:0; padding:24px; font-family:"Segoe UI",Arial,sans-serif; color:var(--ink); background:#eef3f8; }
  .shell { max-width:1080px; margin:0 auto; background:var(--paper); border:1px solid var(--line); border-radius:22px; overflow:hidden; box-shadow:0 24px 64px rgba(15,23,42,.12); }
  .hero { display:flex; justify-content:space-between; gap:18px; padding:30px 34px; background:linear-gradient(135deg,#f7fbff,#eef8f6); border-bottom:1px solid var(--line); }
  .eyebrow { font-size:12px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; color:var(--brand); margin-bottom:10px; }
  h1 { margin:0; font-size:28px; line-height:1.15; }
  .hero p { margin:12px 0 0; color:var(--muted); line-height:1.55; max-width:720px; }
  .risk { min-width:210px; padding:18px; border-radius:18px; border:1px solid var(--line); background:#fff; }
  .risk.good { background:var(--brand-soft); } .risk.warn { background:var(--warn-soft); } .risk.bad { background:var(--bad-soft); }
  .risk .label { font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .risk .value { margin-top:6px; font-size:34px; font-weight:800; line-height:1; }
  .risk .copy { margin-top:8px; font-size:14px; line-height:1.45; color:var(--muted); }
  .content { padding:28px 34px 34px; }
  .section + .section { margin-top:26px; }
  h2 { margin:0 0 12px; font-size:18px; }
  .sub { margin:-4px 0 12px; color:var(--muted); font-size:14px; line-height:1.5; }
  .card { padding:18px; border:1px solid var(--line); border-radius:18px; background:var(--panel); }
  .grid, .metrics, .categories { display:grid; gap:14px; }
  .grid { grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); }
  .metrics { grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); }
  .categories { grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); }
  .stat-label { font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  .stat-value { margin-top:6px; font-size:24px; font-weight:800; line-height:1.1; }
  .stat-value.good { color:var(--brand); } .stat-value.warn { color:var(--warn); } .stat-value.bad { color:var(--bad); } .stat-value.info { color:var(--info); }
  .stat-note { margin-top:8px; font-size:13px; line-height:1.45; color:var(--muted); }
  .pill { display:inline-flex; align-items:center; padding:4px 10px; border-radius:999px; font-size:11px; font-weight:800; letter-spacing:.06em; text-transform:uppercase; }
  .pill.good { background:var(--brand-soft); color:var(--brand); } .pill.warn { background:var(--warn-soft); color:var(--warn); } .pill.bad { background:var(--bad-soft); color:var(--bad); } .pill.info { background:var(--info-soft); color:var(--info); }
  .summary { margin:0; padding-left:20px; } .summary li { margin:0 0 10px; line-height:1.55; }
  .heatmap { display:grid; grid-template-columns:repeat({{ heatmap|length if heatmap else 1 }},minmax(0,1fr)); gap:10px; align-items:end; }
  .heat { display:flex; flex-direction:column; gap:8px; } .heat-count { font-size:13px; font-weight:800; text-align:center; }
  .heat-track { height:126px; border:1px solid var(--line); border-radius:14px; background:#edf3f7; display:flex; align-items:flex-end; overflow:hidden; }
  .heat-fill { width:100%; border-radius:12px 12px 0 0; } .heat-fill.good { background:linear-gradient(180deg,#7dd3fc,#0f766e); } .heat-fill.warn { background:linear-gradient(180deg,#fdba74,#f59e0b); } .heat-fill.bad { background:linear-gradient(180deg,#fca5a5,#dc2626); }
  .heat-label { font-size:11px; line-height:1.35; color:var(--muted); text-align:center; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:12px; border-bottom:1px solid var(--line); text-align:left; vertical-align:top; font-size:13px; line-height:1.45; }
  th { font-size:11px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  tbody tr:last-child td { border-bottom:none; }
  .muted { color:var(--muted); }
  .empty { text-align:center; color:var(--muted); padding:18px 12px; }
  .footer { padding:18px 34px 26px; border-top:1px solid var(--line); background:#fbfdff; font-size:12px; color:var(--muted); }
  @page { size:A4; margin:14mm; }
  @media print { body { padding:0; background:#fff; } .shell { border:none; border-radius:0; box-shadow:none; } }
  @media (max-width:900px) { body { padding:14px; } .hero,.content,.footer { padding-left:20px; padding-right:20px; } .hero { flex-direction:column; } .risk { width:100%; min-width:0; } }
</style>
</head>
<body>
  <div class="shell">
    <div class="hero">
      <div>
        <div class="eyebrow">Syra LMS Proctoring Incident Report</div>
        <h1>{{ exam_title }}</h1>
        <p>Candidate <strong>{{ user_name }}</strong>{% if user_student_id %} ({{ user_student_id }}){% endif %} completed this session with status <strong>{{ attempt_status }}</strong>. This report summarizes what happened during the exam, when incidents occurred, how severe they were, and whether the session recordings were captured successfully.</p>
      </div>
      <div class="risk {{ risk_tone }}">
        <div class="label">Integrity Score</div>
        <div class="value">{{ integrity_score }}/100</div>
        <div class="copy">{{ risk_label }}. {{ risk_guidance }}</div>
      </div>
    </div>
    <div class="content">
      <section class="section"><h2>Executive Summary</h2><div class="card"><ul class="summary">{% for item in summary_points %}<li>{{ item }}</li>{% endfor %}</ul></div></section>
      <section class="section"><h2>Session Overview</h2><div class="grid">{% for item in overview_items %}<div class="card"><div class="stat-label">{{ item.label }}</div><div class="stat-value {{ item.tone }}">{{ item.value }}</div>{% if item.note %}<div class="stat-note">{{ item.note }}</div>{% endif %}</div>{% endfor %}</div></section>
      <section class="section"><h2>Identity Verification</h2><p class="sub">Selfie and ID document captured during the pre-check step before the exam started.</p>{% if identity.has_identity %}<div class="grid"><div class="card" style="text-align:center;">{% if identity.selfie_b64 %}<div class="stat-label">Selfie</div><img src="{{ identity.selfie_b64 }}" alt="Selfie" style="max-width:240px;max-height:240px;border-radius:12px;margin:10px auto;display:block;border:2px solid var(--line);">{% else %}<div class="stat-label">Selfie</div><div class="stat-note">Not captured</div>{% endif %}</div><div class="card" style="text-align:center;">{% if identity.id_photo_b64 %}<div class="stat-label">ID Document</div><img src="{{ identity.id_photo_b64 }}" alt="ID Document" style="max-width:320px;max-height:240px;border-radius:12px;margin:10px auto;display:block;border:2px solid var(--line);">{% else %}<div class="stat-label">ID Document</div><div class="stat-note">Not captured</div>{% endif %}</div></div><div class="grid" style="margin-top:14px;"><div class="card"><div class="stat-label">Identity Verified</div><div class="stat-value {{ 'good' if identity.identity_verified else 'bad' }}">{{ 'Yes' if identity.identity_verified else 'No' }}</div><div class="stat-note">{{ 'Pre-check passed' if identity.precheck_passed else 'Pre-check not completed' }}</div></div><div class="card"><div class="stat-label">Face Signature</div><div class="stat-value {{ 'good' if identity.has_face_signature else 'warn' }}">{{ 'Stored' if identity.has_face_signature else 'Not captured' }}</div><div class="stat-note">Used for live face mismatch detection during the exam</div></div>{% if identity.lighting_score is not none %}<div class="card"><div class="stat-label">Lighting Score</div><div class="stat-value {{ 'good' if identity.lighting_score >= 35 else 'warn' }}">{{ identity.lighting_score }}%</div><div class="stat-note">Brightness of the selfie photo</div></div>{% endif %}<div class="card"><div class="stat-label">OCR Status</div><div class="stat-value {{ 'good' if identity.ocr_available else 'warn' }}">{{ identity.ocr_engine or 'Not available' }}</div><div class="stat-note">{% if identity.ocr_candidates %}Detected IDs: {{ identity.ocr_candidates|join(', ') }}{% else %}No ID numbers detected from the document{% endif %}</div></div></div>{% if identity.ocr_lines %}<div class="card" style="margin-top:14px;"><div class="stat-label">OCR Extracted Text</div><div class="stat-note" style="white-space:pre-line;font-family:monospace;font-size:12px;line-height:1.6;margin-top:8px;">{% for line in identity.ocr_lines %}{{ line }}
{% endfor %}</div></div>{% endif %}{% else %}<div class="card"><div class="stat-note" style="text-align:center;padding:20px;">No identity photos were captured for this attempt. The exam may not require identity verification, or the pre-check step was skipped.</div></div>{% endif %}</section>
      <section class="section"><h2>Key Metrics</h2><div class="metrics">{% for item in metrics %}<div class="card"><div class="stat-label">{{ item.label }}</div><div class="stat-value {{ item.tone }}">{{ item.value }}</div>{% if item.note %}<div class="stat-note">{{ item.note }}</div>{% endif %}</div>{% endfor %}</div></section>
      <section class="section"><h2>Incident Categories</h2><p class="sub">Grouped view of what happened during the exam so reviewers can spot patterns quickly.</p><div class="categories">{% for row in category_rows %}<div class="card"><div class="stat-label">{{ row.label }}</div><div class="stat-value {{ row.tone }}">{{ row.count }}</div><div class="stat-note">Highest severity: <span class="pill {{ row.pill_tone }}">{{ row.highest_severity }}</span><br>Share of incidents: {{ row.share }}</div></div>{% endfor %}{% if not category_rows %}<div class="card"><div class="stat-label">No incidents</div><div class="stat-note">No reportable proctoring incidents were recorded for this attempt.</div></div>{% endif %}</div></section>
      <section class="section"><h2>Recording Coverage</h2><p class="sub">Capture status for the proctoring sources that were expected or observed during the session.</p><div class="card"><table><thead><tr><th>Source</th><th>Status</th><th>Recorded Duration</th><th>Saved At</th><th>Size</th><th>Notes</th></tr></thead><tbody>{% for row in recording_rows %}<tr><td>{{ row.label }}</td><td><span class="pill {{ row.pill_tone }}">{{ row.status }}</span></td><td>{{ row.recorded_duration }}</td><td>{{ row.saved_at }}</td><td>{{ row.size }}</td><td class="muted">{{ row.note }}</td></tr>{% endfor %}{% if not recording_rows %}<tr><td colspan="6" class="empty">No proctoring recording activity was logged for this attempt.</td></tr>{% endif %}</tbody></table></div></section>
      <section class="section"><h2>Incident Activity Over Time</h2><p class="sub">{% if peak_window %}Highest incident activity occurred during {{ peak_window }}.{% else %}No concentrated incident window was detected for this attempt.{% endif %}</p><div class="card"><div class="heatmap">{% for row in heatmap %}<div class="heat"><div class="heat-count">{{ row.count }}</div><div class="heat-track"><div class="heat-fill {{ row.tone }}" style="height: {{ row.height }}%;"></div></div><div class="heat-label">{{ row.label }}</div></div>{% endfor %}</div></div></section>
      <section class="section"><h2>Incident Breakdown</h2><div class="card"><table><thead><tr><th>Incident</th><th>Count</th><th>Highest Severity</th><th>First Seen</th><th>Last Seen</th><th>Sample Detail</th></tr></thead><tbody>{% for row in breakdown_rows %}<tr><td>{{ row.event_label }}</td><td>{{ row.count }}</td><td><span class="pill {{ row.pill_tone }}">{{ row.highest_severity }}</span></td><td>{{ row.first_seen }}</td><td>{{ row.last_seen }}</td><td class="muted">{{ row.sample_detail }}</td></tr>{% endfor %}{% if not breakdown_rows %}<tr><td colspan="6" class="empty">No incident breakdown is available because no reportable events were recorded.</td></tr>{% endif %}</tbody></table></div></section>
      <section class="section"><h2>Chronological Incident Log</h2><p class="sub">Detailed timeline of what happened during the exam, ordered exactly as the events were recorded.</p><div class="card"><table><thead><tr><th>Offset</th><th>Timestamp</th><th>Category</th><th>Incident</th><th>Severity</th><th>Confidence</th><th>Detail</th></tr></thead><tbody>{% for row in timeline_rows %}<tr><td>{{ row.offset }}</td><td>{{ row.time }}</td><td>{{ row.category }}</td><td>{{ row.event_label }}</td><td><span class="pill {{ row.pill_tone }}">{{ row.severity }}</span></td><td>{{ row.confidence }}</td><td class="muted">{{ row.detail }}</td></tr>{% endfor %}{% if not timeline_rows %}<tr><td colspan="7" class="empty">No chronological incident log is available because no reportable events were captured.</td></tr>{% endif %}</tbody></table></div></section>
    </div>
    <div class="footer">Generated {{ generated_at }}. Attempt ID {{ attempt_id_full }}.</div>
  </div>
</body>
</html>"""
)


def _severity_value(value: object) -> str:
    return str(getattr(value, "value", value or "LOW")).strip().upper() or "LOW"


def _severity_rank(value: object) -> int:
    return _SEVERITY_ORDER.get(_severity_value(value), 0)


def _severity_tone(value: object) -> str:
    severity = _severity_value(value)
    if severity == "HIGH":
        return "bad"
    if severity == "MEDIUM":
        return "warn"
    return "good"


def _event_label(event_type: str | None) -> str:
    raw = str(event_type or "").strip().replace("_", " ").lower()
    return raw.title() if raw else "Unknown Incident"


def _event_category(event_type: str | None) -> str:
    normalized = str(event_type or "").strip().upper()
    if any(token in normalized for token in ("FULLSCREEN", "FOCUS", "TAB", "COPY", "PASTE", "NAVIGATION")):
        return "Navigation & Focus"
    if any(token in normalized for token in ("FACE", "EYE", "HEAD", "LOOKING", "MOUTH")):
        return "Face & Attention"
    if any(token in normalized for token in ("AUDIO", "VOICE", "SPEECH", "MIC")):
        return "Audio & Speech"
    if any(token in normalized for token in ("PHONE", "OBJECT", "CAMERA", "SCREEN")):
        return "Device & Environment"
    if any(token in normalized for token in ("PAUSED", "RESUMED", "CONNECTION", "SUBMIT")):
        return "Session Control"
    return "Other"


def _load_identity_photo_b64(stored_path: str | None) -> str | None:
    """Load an encrypted identity photo and return as a base64 data URI."""
    if not stored_path:
        return None
    try:
        local_path = Path(stored_path)
        if not local_path.is_absolute():
            local_path = _IDENTITY_DIR / Path(stored_path).name
        if not local_path.is_file():
            return None
        encrypted = local_path.read_bytes()
        decrypted = decrypt_bytes(encrypted)
        if not decrypted:
            return None
        encoded = base64.b64encode(decrypted).decode("ascii")
        return f"data:image/jpeg;base64,{encoded}"
    except Exception:
        _logger.debug("Failed to load identity photo from %s", stored_path, exc_info=True)
        return None


def _clean_detail(value: object) -> str:
    text = " ".join(str(value or "").strip().split())
    return text or "No additional detail was recorded."


def _format_dt(value: datetime | None, *, include_tz: bool = True) -> str:
    if not value:
        return "N/A"
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    formatted = value.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return f"{formatted} UTC" if include_tz else formatted


def _format_offset(total_seconds: float | int | None) -> str:
    seconds = max(int(total_seconds or 0), 0)
    hours, remainder = divmod(seconds, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:02d}:{secs:02d}"


def _format_duration(start: datetime | None, end: datetime | None) -> str:
    if not start or not end:
        return "N/A"
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    total_seconds = max(int((end - start).total_seconds()), 0)
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours}h")
    if minutes or hours:
        parts.append(f"{minutes}m")
    parts.append(f"{seconds}s")
    return " ".join(parts)


def _format_confidence(value: object) -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return "N/A"
    if numeric < 0:
        return "N/A"
    if numeric <= 1:
        numeric *= 100
    return f"{round(numeric)}%"


def _format_bytes(value: object) -> str:
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return "N/A"
    if numeric <= 0:
        return "N/A"
    units = ["B", "KB", "MB", "GB"]
    index = 0
    while numeric >= 1024 and index < len(units) - 1:
        numeric /= 1024
        index += 1
    return f"{int(numeric)} {units[index]}" if index == 0 else f"{numeric:.1f} {units[index]}"


def _parse_iso_datetime(value: object) -> datetime | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _normalize_recording_source(value: object) -> str:
    raw = str(value or "").strip().lower()
    return raw if raw else "unknown"


def _recording_duration(meta: dict[str, Any] | None) -> str:
    payload = meta or {}
    started = _parse_iso_datetime(payload.get("recording_started_at"))
    stopped = _parse_iso_datetime(payload.get("recording_stopped_at"))
    if not started or not stopped:
        return "N/A"
    return _format_duration(started, stopped)


def _compute_integrity_score(high: int, medium: int, low: int) -> int:
    score = 100 - (high * 18) - (medium * 9) - (low * 3)
    return max(0, min(100, score))


def _risk_summary(integrity_score: int) -> tuple[str, str, str]:
    if integrity_score >= 85:
        return (
            "Low review priority",
            "good",
            "Only limited anomalies were recorded. The session appears stable from a proctoring perspective.",
        )
    if integrity_score >= 65:
        return (
            "Review recommended",
            "warn",
            "Multiple anomalies were recorded. A reviewer should confirm whether they affected exam integrity.",
        )
    return (
        "High review priority",
        "bad",
        "Repeated or severe anomalies were recorded. This attempt should be reviewed carefully.",
    )


def _expected_recording_sources(attempt: Attempt) -> list[str]:
    config = getattr(attempt.exam, "proctoring_config", None) if attempt.exam else None
    requirements = get_proctoring_requirements(config)
    sources: list[str] = []
    if requirements.get("camera_required"):
        sources.append("camera")
    if requirements.get("screen_required"):
        sources.append("screen")
    return sources


def _load_attempt_events(db: Session, attempt: Attempt) -> list[ProctoringEvent]:
    return db.scalars(
        select(ProctoringEvent)
        .where(ProctoringEvent.attempt_id == attempt.id)
        .order_by(ProctoringEvent.occurred_at)
    ).all()


def _coerce_non_negative_int(value: object) -> int:
    try:
        numeric = int(float(value))
    except (TypeError, ValueError):
        return 0
    return max(0, numeric)


def _saved_video_meta_is_valid(meta: object) -> bool:
    if not isinstance(meta, dict):
        return False
    status = str(meta.get("status") or "").strip().lower()
    if status in _INVALID_SAVED_VIDEO_STATUSES:
        return False
    if meta.get("ready_to_stream") is True:
        return True
    return _coerce_non_negative_int(meta.get("size")) > 0


def _build_recording_rows(events: list[ProctoringEvent], expected_sources: list[str]) -> list[dict[str, str]]:
    latest_progress: dict[str, ProctoringEvent] = {}
    saved: dict[str, ProctoringEvent] = {}
    for event in events:
        event_type = str(event.event_type or "").strip().upper()
        meta = event.meta if isinstance(event.meta, dict) else {}
        source = _normalize_recording_source(meta.get("source"))
        if event_type == "VIDEO_UPLOAD_PROGRESS" and source:
            latest_progress[source] = event
        elif event_type == "VIDEO_SAVED" and source:
            saved[source] = event

    ordered_sources = [source for source in ("camera", "screen") if source in expected_sources or source in latest_progress or source in saved]
    ordered_sources.extend(
        source for source in sorted(set(expected_sources) | set(latest_progress) | set(saved))
        if source not in ordered_sources
    )

    rows: list[dict[str, str]] = []
    for source in ordered_sources:
        saved_event = saved.get(source)
        if saved_event and _saved_video_meta_is_valid(saved_event.meta):
            meta = saved_event.meta if isinstance(saved_event.meta, dict) else {}
            note_bits = [str(meta.get("name") or meta.get("filename") or "").strip(), str(meta.get("playback_type") or "").strip().upper()]
            rows.append({
                "label": source.title(),
                "status": "Saved",
                "pill_tone": "good",
                "recorded_duration": _recording_duration(meta),
                "saved_at": _format_dt(saved_event.occurred_at, include_tz=False),
                "size": _format_bytes(meta.get("size")),
                "note": " | ".join(bit for bit in note_bits if bit) or "Final recording saved successfully.",
            })
            continue
        if saved_event:
            meta = saved_event.meta if isinstance(saved_event.meta, dict) else {}
            status = str(meta.get("status") or "error").replace("_", " ").title()
            detail = "Video upload finished but the stored recording is not playable."
            if str(meta.get("status") or "").strip().lower() in _INVALID_SAVED_VIDEO_STATUSES:
                detail = "Video upload finished but the storage provider marked the recording as failed."
            elif _coerce_non_negative_int(meta.get("size")) <= 0:
                detail = "Video upload finished but the stored recording is empty."
            rows.append({
                "label": source.title(),
                "status": status,
                "pill_tone": "bad",
                "recorded_duration": _recording_duration(meta),
                "saved_at": _format_dt(saved_event.occurred_at, include_tz=False),
                "size": _format_bytes(meta.get("size")),
                "note": detail,
            })
            continue

        progress_event = latest_progress.get(source)
        if progress_event:
            meta = progress_event.meta if isinstance(progress_event.meta, dict) else {}
            progress = meta.get("progress_percent")
            note = f"Latest recorded progress: {int(progress)}%" if progress not in (None, "") else "Upload progress was recorded."
            status = str(meta.get("status") or "in_progress").replace("_", " ").title()
            rows.append({
                "label": source.title(),
                "status": status,
                "pill_tone": "bad" if str(meta.get("status") or "").strip().lower() == "error" else "warn",
                "recorded_duration": "N/A",
                "saved_at": _format_dt(progress_event.occurred_at, include_tz=False),
                "size": _format_bytes(meta.get("total_bytes")),
                "note": note,
            })
            continue

        rows.append({
            "label": source.title(),
            "status": "Not captured",
            "pill_tone": "bad",
            "recorded_duration": "N/A",
            "saved_at": "N/A",
            "size": "N/A",
            "note": "This recording source was expected but no upload activity was logged.",
        })
    return rows


def build_attempt_report_data(db: Session, attempt: Attempt) -> dict[str, Any]:
    events = _load_attempt_events(db, attempt)
    incident_events = [event for event in events if str(event.event_type or "").strip().upper() not in _VIDEO_EVENT_TYPES]
    started_at = attempt.started_at
    finished_at = attempt.submitted_at or datetime.now(timezone.utc)

    high_count = sum(1 for event in incident_events if _severity_value(event.severity) == "HIGH")
    medium_count = sum(1 for event in incident_events if _severity_value(event.severity) == "MEDIUM")
    low_count = sum(1 for event in incident_events if _severity_value(event.severity) == "LOW")
    integrity_score = _compute_integrity_score(high_count, medium_count, low_count)
    risk_label, risk_tone, risk_guidance = _risk_summary(integrity_score)

    type_stats: dict[str, dict[str, Any]] = {}
    category_stats: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0, "highest": "LOW"})
    timeline_rows: list[dict[str, str]] = []
    for event in incident_events:
        event_type = str(event.event_type or "").strip().upper() or "UNKNOWN"
        event_time = event.occurred_at or started_at or finished_at
        severity = _severity_value(event.severity)
        detail = _clean_detail(event.detail)
        category = _event_category(event_type)
        label = _event_label(event_type)
        offset = _format_offset((event_time - started_at).total_seconds()) if started_at and event_time else "00:00"

        stats = type_stats.setdefault(event_type, {
            "event_label": label,
            "count": 0,
            "highest": "LOW",
            "first": event_time,
            "last": event_time,
            "sample": detail,
        })
        stats["count"] += 1
        if _severity_rank(severity) > _severity_rank(stats["highest"]):
            stats["highest"] = severity
        if event_time and event_time < stats["first"]:
            stats["first"] = event_time
        if event_time and event_time > stats["last"]:
            stats["last"] = event_time
        if stats["sample"] == "No additional detail was recorded." and detail != stats["sample"]:
            stats["sample"] = detail

        category_stats[category]["count"] += 1
        if _severity_rank(severity) > _severity_rank(category_stats[category]["highest"]):
            category_stats[category]["highest"] = severity

        timeline_rows.append({
            "offset": offset,
            "time": _format_dt(event_time, include_tz=False),
            "category": category,
            "event_label": label,
            "severity": severity,
            "pill_tone": _severity_tone(severity),
            "confidence": _format_confidence(event.ai_confidence),
            "detail": detail,
        })

    breakdown_rows = [{
        "event_label": row["event_label"],
        "count": row["count"],
        "highest_severity": row["highest"],
        "pill_tone": _severity_tone(row["highest"]),
        "first_seen": _format_dt(row["first"], include_tz=False),
        "last_seen": _format_dt(row["last"], include_tz=False),
        "sample_detail": row["sample"],
    } for _, row in sorted(type_stats.items(), key=lambda item: (-item[1]["count"], -_severity_rank(item[1]["highest"]), item[1]["event_label"]))]

    total_incidents = len(incident_events)
    category_rows = [{
        "label": label,
        "count": stats["count"],
        "highest_severity": stats["highest"],
        "pill_tone": _severity_tone(stats["highest"]),
        "tone": _severity_tone(stats["highest"]),
        "share": f"{round((stats['count'] / total_incidents) * 100) if total_incidents else 0}%",
    } for label, stats in sorted(category_stats.items(), key=lambda item: (-item[1]["count"], item[0]))]

    total_seconds = max((finished_at - started_at).total_seconds(), 1) if started_at else 1
    bucket_count = 10
    bucket_size = total_seconds / bucket_count
    heatmap_counts = [0 for _ in range(bucket_count)]
    if started_at:
        for event in incident_events:
            occurred_at = event.occurred_at or started_at
            seconds_from_start = max((occurred_at - started_at).total_seconds(), 0)
            bucket_index = min(int(seconds_from_start / bucket_size), bucket_count - 1)
            heatmap_counts[bucket_index] += 1
    max_bucket = max(heatmap_counts) if heatmap_counts else 0
    heatmap = []
    for index, count in enumerate(heatmap_counts):
        start_label = _format_offset(index * bucket_size)
        end_label = _format_offset(total_seconds if index == bucket_count - 1 else (index + 1) * bucket_size)
        tone = "good"
        if max_bucket > 0 and count >= max_bucket * 0.75 and count > 0:
            tone = "bad"
        elif count > 0:
            tone = "warn"
        heatmap.append({
            "label": f"{start_label} - {end_label}",
            "count": count,
            "tone": tone,
            "height": 18 if max_bucket == 0 else max(18, int(round((count / max_bucket) * 100))),
        })
    peak_window = ""
    if max_bucket > 0:
        peak_index = heatmap_counts.index(max_bucket)
        peak_window = f"{_format_offset(peak_index * bucket_size)} to {_format_offset(total_seconds if peak_index == bucket_count - 1 else (peak_index + 1) * bucket_size)} from the start of the attempt"

    recording_rows = _build_recording_rows(events, _expected_recording_sources(attempt))
    saved_recordings = sum(1 for row in recording_rows if row["status"] == "Saved")

    exam = attempt.exam
    user = attempt.user
    total_questions = len(getattr(exam, "questions", []) or [])
    answered_count = sum(1 for answer in getattr(attempt, "answers", []) or [] if str(answer.answer or "").strip())
    skipped_count = max(total_questions - answered_count, 0) if total_questions else 0
    passing_score = getattr(exam, "passing_score", None) if exam else None
    score_value = attempt.score
    score_display = f"{round(float(score_value), 2):g}" if score_value is not None else "N/A"
    pass_label = "Pending" if score_value is None else ("Pass" if passing_score is None or float(score_value) >= float(passing_score) else "Review")

    top_incident = breakdown_rows[0] if breakdown_rows else None
    summary_points = [
        f"The attempt ran for {_format_duration(started_at, finished_at)} and ended with status {str(getattr(attempt.status, 'value', attempt.status or 'UNKNOWN')).replace('_', ' ').title()}.",
        f"{total_incidents} reportable incidents were captured: {high_count} high, {medium_count} medium, and {low_count} low severity.",
        f"{saved_recordings} of {len(recording_rows)} recording source{'s were' if len(recording_rows) != 1 else ' was'} saved successfully." if recording_rows else "No proctoring recording sources were logged for this attempt.",
        f"The most frequent incident was {top_incident['event_label']} ({top_incident['count']} occurrence{'s' if top_incident['count'] != 1 else ''})." if top_incident else "No reportable incidents were captured during this attempt.",
        f"The busiest incident window was {peak_window}." if peak_window else "No concentrated incident window was detected during this attempt.",
        risk_guidance,
    ]

    overview_items = [
        {"label": "Attempt ID", "value": str(attempt.id)[:8], "tone": "info", "note": str(attempt.id)},
        {"label": "Candidate", "value": user.name if user else "Unknown learner", "tone": "info", "note": getattr(user, "email", None) if user else None},
        {"label": "Candidate ID", "value": getattr(user, "user_id", "N/A") if user else "N/A", "tone": "info", "note": None},
        {"label": "Started", "value": _format_dt(started_at, include_tz=False), "tone": "info", "note": None},
        {"label": "Submitted", "value": _format_dt(attempt.submitted_at, include_tz=False), "tone": "info", "note": None},
        {"label": "Duration", "value": _format_duration(started_at, finished_at), "tone": "info", "note": f"Time limit: {getattr(exam, 'time_limit', None) or 'Not set'} minute(s)" if exam else None},
        {"label": "Result", "value": pass_label, "tone": "good" if pass_label == "Pass" else ("warn" if pass_label == "Review" else "info"), "note": f"Score: {score_display} / 100"},
        {"label": "Answers Saved", "value": str(answered_count), "tone": "info", "note": f"Skipped: {skipped_count}" if total_questions else "Question totals unavailable"},
    ]

    metrics = [
        {"label": "Integrity score", "value": f"{integrity_score}/100", "tone": risk_tone, "note": risk_label},
        {"label": "Total incidents", "value": str(total_incidents), "tone": "info", "note": "Non-video proctoring events"},
        {"label": "High severity", "value": str(high_count), "tone": "bad", "note": "Immediate review items"},
        {"label": "Medium severity", "value": str(medium_count), "tone": "warn", "note": "Potential integrity issues"},
        {"label": "Recordings saved", "value": str(saved_recordings), "tone": "good" if saved_recordings else "warn", "note": f"Expected/observed sources: {len(recording_rows)}"},
        {"label": "Exam score", "value": score_display, "tone": "good" if pass_label == "Pass" else "warn", "note": f"Passing score: {passing_score:g}" if passing_score is not None else "No passing threshold configured"},
    ]

    # Identity verification data
    selfie_b64 = _load_identity_photo_b64(attempt.selfie_path)
    id_photo_b64 = _load_identity_photo_b64(attempt.id_doc_path)
    id_text_data = attempt.id_text if isinstance(attempt.id_text, dict) else {}
    identity_data = {
        "has_identity": bool(selfie_b64 or id_photo_b64),
        "selfie_b64": selfie_b64,
        "id_photo_b64": id_photo_b64,
        "identity_verified": bool(getattr(attempt, "identity_verified", False)),
        "precheck_passed": bool(getattr(attempt, "precheck_passed_at", None)),
        "has_face_signature": bool(getattr(attempt, "face_signature", None)),
        "lighting_score": round(float(attempt.lighting_score or 0) * 100) if attempt.lighting_score else None,
        "ocr_available": id_text_data.get("ocr_available", False),
        "ocr_engine": id_text_data.get("engine"),
        "ocr_candidates": id_text_data.get("ocr_candidates", []),
        "ocr_lines": id_text_data.get("lines", [])[:5],
        "id_method": id_text_data.get("method"),
    }

    return {
        "report_title": f"Proctoring Incident Report - {str(attempt.id)[:8]}",
        "attempt_id_full": str(attempt.id),
        "attempt_status": str(getattr(attempt.status, "value", attempt.status or "UNKNOWN")).replace("_", " ").title(),
        "exam_title": getattr(exam, "title", None) or "Untitled exam",
        "user_name": getattr(user, "name", None) or "Unknown learner",
        "user_student_id": getattr(user, "user_id", None) or "",
        "integrity_score": integrity_score,
        "risk_label": risk_label,
        "risk_tone": risk_tone,
        "risk_guidance": risk_guidance,
        "summary_points": summary_points,
        "overview_items": overview_items,
        "metrics": metrics,
        "category_rows": category_rows,
        "recording_rows": recording_rows,
        "heatmap": heatmap,
        "peak_window": peak_window,
        "breakdown_rows": breakdown_rows,
        "timeline_rows": timeline_rows,
        "identity": identity_data,
        "generated_at": _format_dt(datetime.now(timezone.utc)),
    }


def generate_html_report(db: Session, attempt: Attempt) -> str:
    data = build_attempt_report_data(db, attempt)
    return _REPORT_TEMPLATE.render(**data)


def _pdf_styles() -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    return {
        "title": ParagraphStyle(
            "ReportTitle",
            parent=sample["Title"],
            fontName="Helvetica-Bold",
            fontSize=20,
            leading=24,
            textColor=colors.HexColor("#132238"),
            spaceAfter=6,
        ),
        "section": ParagraphStyle(
            "ReportSection",
            parent=sample["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=14,
            textColor=colors.HexColor("#132238"),
            spaceAfter=8,
            spaceBefore=10,
        ),
        "body": ParagraphStyle(
            "ReportBody",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=9.2,
            leading=12,
            textColor=colors.HexColor("#1F2937"),
            alignment=TA_LEFT,
        ),
        "small": ParagraphStyle(
            "ReportSmall",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#5B6B82"),
            alignment=TA_LEFT,
        ),
        "table_header": ParagraphStyle(
            "ReportTableHeader",
            parent=sample["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=7.4,
            leading=9,
            textColor=colors.white,
            alignment=TA_LEFT,
        ),
        "table_cell": ParagraphStyle(
            "ReportTableCell",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=10,
            textColor=colors.HexColor("#1F2937"),
            alignment=TA_LEFT,
        ),
        "table_cell_small": ParagraphStyle(
            "ReportTableCellSmall",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=7.2,
            leading=9,
            textColor=colors.HexColor("#1F2937"),
            alignment=TA_LEFT,
        ),
        "metric_label": ParagraphStyle(
            "MetricLabel",
            parent=sample["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=7.2,
            leading=9,
            textColor=colors.HexColor("#5B6B82"),
            alignment=TA_CENTER,
        ),
        "metric_value": ParagraphStyle(
            "MetricValue",
            parent=sample["BodyText"],
            fontName="Helvetica-Bold",
            fontSize=14,
            leading=16,
            textColor=colors.HexColor("#132238"),
            alignment=TA_CENTER,
        ),
        "metric_note": ParagraphStyle(
            "MetricNote",
            parent=sample["BodyText"],
            fontName="Helvetica",
            fontSize=7.2,
            leading=9,
            textColor=colors.HexColor("#5B6B82"),
            alignment=TA_CENTER,
        ),
    }


def _pdf_text(value: object) -> str:
    return shape_for_paragraph(escape(str(value or "")))


def _tone_hex(tone: str) -> str:
    if tone == "bad":
        return "#B91C1C"
    if tone == "warn":
        return "#B45309"
    if tone == "good":
        return "#0F766E"
    return "#1D4ED8"


def _tone_color(tone: str) -> colors.Color:
    return colors.HexColor(_tone_hex(tone))


def _metric_card(item: dict[str, str], styles: dict[str, ParagraphStyle]) -> Table:
    tone_color = _tone_hex(str(item.get("tone") or "info"))
    value = _pdf_text(item.get("value"))
    label = _pdf_text(item.get("label"))
    note = _pdf_text(item.get("note"))
    rows = [
        [Paragraph(label, styles["metric_label"])],
        [Paragraph(f'<font color="{tone_color}">{value}</font>', styles["metric_value"])],
    ]
    if note:
        rows.append([Paragraph(note, styles["metric_note"])])
    table = Table(rows, colWidths=[52 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F7FAFC")),
        ("BOX", (0, 0), (-1, -1), 0.6, colors.HexColor("#D8E1EA")),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
        ("LEFTPADDING", (0, 0), (-1, -1), 8),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    return table


def _build_metric_grid(items: list[dict[str, str]], styles: dict[str, ParagraphStyle], *, columns: int) -> Table:
    if not items:
        return Table([[Paragraph("No data available.", styles["small"])]], colWidths=[160 * mm])
    padded: list[Table | str] = [_metric_card(item, styles) for item in items]
    while len(padded) % columns:
        padded.append("")
    rows = [padded[index:index + columns] for index in range(0, len(padded), columns)]
    widths = [52 * mm for _ in range(columns)]
    table = Table(rows, colWidths=widths, hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return table


def _paragraph_lines(lines: list[str], styles: dict[str, ParagraphStyle]) -> list[Paragraph]:
    result: list[Paragraph] = []
    for line in lines:
        result.append(Paragraph(_pdf_text(line), styles["body"]))
        result.append(Spacer(1, 2 * mm))
    if result:
        result.pop()
    return result


def _table_with_header(
    headers: list[str],
    rows: list[list[str]],
    widths: list[float],
    styles: dict[str, ParagraphStyle],
    *,
    compact: bool = False,
) -> LongTable:
    header_style = styles["table_header"]
    cell_style = styles["table_cell_small"] if compact else styles["table_cell"]
    data = [[Paragraph(_pdf_text(value), header_style) for value in headers]]
    for row in rows:
        data.append([Paragraph(_pdf_text(value), cell_style) for value in row])
    table = LongTable(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#132238")),
        ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#D8E1EA")),
        ("INNERGRID", (0, 0), (-1, -1), 0.35, colors.HexColor("#D8E1EA")),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FBFD")]),
    ]))
    return table


def _draw_pdf_footer(canvas, doc, *, generated_at: str, attempt_id: str) -> None:
    canvas.saveState()
    canvas.setStrokeColor(colors.HexColor("#D8E1EA"))
    canvas.line(doc.leftMargin, 11 * mm, A4[0] - doc.rightMargin, 11 * mm)
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(colors.HexColor("#5B6B82"))
    canvas.drawString(doc.leftMargin, 7.5 * mm, f"Generated {generated_at} | Attempt {attempt_id}")
    canvas.drawRightString(A4[0] - doc.rightMargin, 7.5 * mm, f"Page {canvas.getPageNumber()}")
    canvas.restoreState()


def generate_pdf_report(db: Session, attempt: Attempt) -> bytes:
    data = build_attempt_report_data(db, attempt)
    styles = _pdf_styles()
    buffer = BytesIO()
    document = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title=data["report_title"],
        author="Syra LMS",
    )

    story: list[object] = []
    candidate_suffix = f" ({data['user_student_id']})" if data.get("user_student_id") else ""
    intro = (
        f"Candidate {data['user_name']}{candidate_suffix} completed this session with status "
        f"{data['attempt_status']}. This report summarizes what happened during the exam, which incidents were recorded, "
        "and whether the expected recordings were saved successfully."
    )
    risk_color = _tone_hex(data["risk_tone"])
    integrity_value = _pdf_text(f"{data['integrity_score']}/100")
    risk_table = Table(
        [[
            Paragraph(
                f'<para align="left"><font size="8" color="#5B6B82"><b>Integrity score</b></font><br/>'
                f'<font size="20" color="{risk_color}"><b>{integrity_value}</b></font><br/>'
                f'<font size="8" color="#1F2937">{_pdf_text(data["risk_label"])}</font><br/>'
                f'<font size="8" color="#5B6B82">{_pdf_text(data["risk_guidance"])}</font></para>',
                styles["body"],
            )
        ]],
        colWidths=[60 * mm],
    )
    risk_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#F7FAFC")),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#D8E1EA")),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
    ]))
    hero = Table(
        [[
            [
                Paragraph("SYRA LMS PROCTORING INCIDENT REPORT", styles["small"]),
                Paragraph(_pdf_text(data["exam_title"]), styles["title"]),
                Paragraph(_pdf_text(intro), styles["body"]),
            ],
            risk_table,
        ]],
        colWidths=[115 * mm, 60 * mm],
    )
    hero.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    story.append(hero)
    story.append(Spacer(1, 5 * mm))

    story.append(Paragraph("Executive Summary", styles["section"]))
    story.extend(_paragraph_lines([f"{index + 1}. {line}" for index, line in enumerate(data["summary_points"])], styles))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Session Overview", styles["section"]))
    overview_rows = [
        [row["label"], row["value"], row.get("note") or "-"]
        for row in data["overview_items"]
    ]
    story.append(_table_with_header(
        ["Item", "Value", "Notes"],
        overview_rows,
        [42 * mm, 46 * mm, 92 * mm],
        styles,
    ))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Key Metrics", styles["section"]))
    story.append(_build_metric_grid(data["metrics"], styles, columns=3))
    story.append(Spacer(1, 2 * mm))

    story.append(Paragraph("Incident Categories", styles["section"]))
    category_rows = [
        [row["label"], str(row["count"]), row["highest_severity"], row["share"]]
        for row in data["category_rows"]
    ] or [["No incidents", "0", "LOW", "0%"]]
    story.append(_table_with_header(
        ["Category", "Count", "Highest severity", "Share of incidents"],
        category_rows,
        [70 * mm, 20 * mm, 38 * mm, 42 * mm],
        styles,
    ))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Recording Coverage", styles["section"]))
    recording_rows = [
        [row["label"], row["status"], row["recorded_duration"], row["saved_at"], row["size"], row["note"]]
        for row in data["recording_rows"]
    ] or [["No recording activity", "-", "-", "-", "-", "No proctoring recording activity was logged for this attempt."]]
    story.append(_table_with_header(
        ["Source", "Status", "Recorded duration", "Saved at", "Size", "Notes"],
        recording_rows,
        [24 * mm, 24 * mm, 28 * mm, 30 * mm, 18 * mm, 56 * mm],
        styles,
    ))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Incident Activity Over Time", styles["section"]))
    heatmap_note = (
        f"Highest incident activity occurred during {data['peak_window']}."
        if data["peak_window"]
        else "No concentrated incident window was detected for this attempt."
    )
    story.append(Paragraph(_pdf_text(heatmap_note), styles["body"]))
    story.append(Spacer(1, 2 * mm))
    heatmap_rows = [
        [row["label"], str(row["count"]), row["tone"].title()]
        for row in data["heatmap"]
    ]
    story.append(_table_with_header(
        ["Window from attempt start", "Incident count", "Relative intensity"],
        heatmap_rows,
        [90 * mm, 35 * mm, 45 * mm],
        styles,
    ))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Incident Breakdown", styles["section"]))
    breakdown_rows = [
        [row["event_label"], str(row["count"]), row["highest_severity"], row["first_seen"], row["last_seen"], row["sample_detail"]]
        for row in data["breakdown_rows"]
    ] or [["No incidents", "0", "LOW", "-", "-", "No reportable incidents were recorded."]]
    story.append(_table_with_header(
        ["Incident", "Count", "Highest", "First seen", "Last seen", "Sample detail"],
        breakdown_rows,
        [40 * mm, 16 * mm, 18 * mm, 28 * mm, 28 * mm, 55 * mm],
        styles,
        compact=True,
    ))
    story.append(Spacer(1, 4 * mm))

    story.append(Paragraph("Chronological Incident Log", styles["section"]))
    timeline_rows = [
        [
            row["offset"],
            row["time"],
            row["category"],
            row["event_label"],
            row["severity"],
            row["confidence"],
            row["detail"],
        ]
        for row in data["timeline_rows"]
    ] or [["00:00", "-", "-", "No incidents", "-", "-", "No chronological incident log is available because no reportable events were captured."]]
    story.append(_table_with_header(
        ["Offset", "Timestamp", "Category", "Incident", "Severity", "Confidence", "Detail"],
        timeline_rows,
        [14 * mm, 28 * mm, 28 * mm, 28 * mm, 17 * mm, 20 * mm, 45 * mm],
        styles,
        compact=True,
    ))

    document.build(
        story,
        onFirstPage=lambda canvas, doc: _draw_pdf_footer(canvas, doc, generated_at=data["generated_at"], attempt_id=data["attempt_id_full"]),
        onLaterPages=lambda canvas, doc: _draw_pdf_footer(canvas, doc, generated_at=data["generated_at"], attempt_id=data["attempt_id_full"]),
    )
    return buffer.getvalue()
