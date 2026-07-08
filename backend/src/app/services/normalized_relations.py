from __future__ import annotations

from copy import deepcopy
from datetime import datetime
from typing import Any, Iterable

from ..models import (
    Exam,
    ExamAdminConfig,
    ExamCertificateConfig,
    ExamProctoringAlertRule,
    ExamProctoringConfig,
    ExamRuntimeConfig,
    ExamRuntimeExtraSetting,
    ExamRuntimeInstructionItem,
    ExamRuntimeTranslation,
    ExamUiColumn,
    Survey,
    SurveyQuestion,
    SurveyQuestionOption,
    UserGroup,
    UserGroupMember,
)
from ..modules.tests.enums import ReportContent, ReportDisplayed

ADMIN_META_KEY = "_admin_test"
DEFAULT_CERTIFICATE_ISSUE_RULE = "ON_PASS"
CERTIFICATE_ISSUE_RULES = {
    "ON_PASS",
    "POSITIVE_PROCTORING",
    "AFTER_PROCTORING_REVIEW",
}

DEFAULT_SECURITY_SETTINGS = {
    "fullscreen_required": True,
    "tab_switch_detect": True,
    "camera_required": True,
    "mic_required": False,
    "violation_threshold_warn": 3,
    "violation_threshold_autosubmit": 6,
}

DEFAULT_UI_COLUMNS = ["name", "code", "type", "status", "time_limit_minutes", "testing_sessions"]

DEFAULT_PROCTORING = {
    "face_detection": True,
    "multi_face": True,
    "audio_detection": True,
    "object_detection": True,
    "eye_tracking": True,
    "head_pose_detection": True,
    "mouth_detection": False,
    "face_verify": True,
    "fullscreen_enforce": True,
    "tab_switch_detect": True,
    "screen_capture": True,
    "copy_paste_block": True,
    "alert_rules": [],
    "eye_deviation_deg": 12,
    "mouth_open_threshold": 0.35,
    "audio_rms_threshold": 0.08,
    "max_face_absence_sec": 1.5,
    "max_tab_blurs": 3,
    "max_alerts_before_autosubmit": 5,
    "max_fullscreen_exits": 2,
    "max_alt_tabs": 3,
    "lighting_min_score": 0.35,
    "face_verify_id_threshold": 0.42,
    "max_score_before_autosubmit": 15,
    "frame_interval_ms": 900,
    "audio_chunk_ms": 2000,
    "screenshot_interval_sec": 60,
    "face_verify_threshold": 0.15,
    "cheating_consecutive_frames": 5,
    "head_pose_consecutive": 5,
    "eye_consecutive": 5,
    "object_confidence_threshold": 0.35,
    "audio_consecutive_chunks": 2,
    "audio_speech_consecutive_chunks": 2,
    "audio_speech_min_rms": 0.03,
    "audio_speech_baseline_multiplier": 1.35,
    "audio_window": 5,
    "multi_face_min_area_ratio": 0.008,
    "head_pose_yaw_deg": 20,
    "head_pose_pitch_deg": 20,
    "head_pitch_min_rad": -0.3,
    "head_pitch_max_rad": 0.2,
    "head_yaw_min_rad": -0.6,
    "head_yaw_max_rad": 0.6,
    "eye_pitch_min_rad": -0.5,
    "eye_pitch_max_rad": 0.2,
    "eye_yaw_min_rad": -0.5,
    "eye_yaw_max_rad": 0.5,
    "pose_change_threshold_rad": 0.1,
    "eye_change_threshold_rad": 0.2,
    "camera_cover_hard_luma": 20.0,
    "camera_cover_soft_luma": 40.0,
    "camera_cover_stddev_max": 16.0,
    "camera_cover_hard_consecutive_frames": 1,
    "camera_cover_soft_consecutive_frames": 2,
    "identity_required": True,
    "camera_required": True,
    "mic_required": True,
    "fullscreen_required": True,
    "lighting_required": True,
}

_PROCTORING_SCALAR_FIELDS = [
    "face_detection",
    "multi_face",
    "audio_detection",
    "object_detection",
    "eye_tracking",
    "head_pose_detection",
    "mouth_detection",
    "face_verify",
    "fullscreen_enforce",
    "tab_switch_detect",
    "screen_capture",
    "copy_paste_block",
    "eye_deviation_deg",
    "mouth_open_threshold",
    "audio_rms_threshold",
    "max_face_absence_sec",
    "max_tab_blurs",
    "max_alerts_before_autosubmit",
    "max_fullscreen_exits",
    "max_alt_tabs",
    "lighting_min_score",
    "face_verify_id_threshold",
    "max_score_before_autosubmit",
    "frame_interval_ms",
    "audio_chunk_ms",
    "screenshot_interval_sec",
    "face_verify_threshold",
    "cheating_consecutive_frames",
    "head_pose_consecutive",
    "eye_consecutive",
    "object_confidence_threshold",
    "audio_consecutive_chunks",
    "audio_window",
    "head_pose_yaw_deg",
    "head_pose_pitch_deg",
    "head_pitch_min_rad",
    "head_pitch_max_rad",
    "head_yaw_min_rad",
    "head_yaw_max_rad",
    "eye_pitch_min_rad",
    "eye_pitch_max_rad",
    "eye_yaw_min_rad",
    "eye_yaw_max_rad",
    "pose_change_threshold_rad",
    "eye_change_threshold_rad",
    "identity_required",
    "camera_required",
    "mic_required",
    "fullscreen_required",
    "lighting_required",
    "access_mode",
]

_RUNTIME_SCALAR_FIELDS = [
    "instructions",
    "instructions_heading",
    "instructions_body",
    "completion_message",
    "instructions_require_acknowledgement",
    "show_test_instructions",
    "show_score_report",
    "show_answer_review",
    "show_correct_answers",
    "allow_retake",
    "retake_cooldown_hours",
    "auto_logout_after_finish_or_pause",
    "creation_method",
    "score_report_include_certificate_status",
    "sequential_sections",
    "allow_revisit_sections",
]

_RUNTIME_COMPLEX_FIELDS = {
    "instructions_list",
    "test_translations",
}

_RUNTIME_DEFAULTS = {
    "instructions_require_acknowledgement": False,
    "show_test_instructions": True,
    "show_score_report": False,
    "show_answer_review": False,
    "show_correct_answers": False,
    "allow_retake": False,
    "auto_logout_after_finish_or_pause": False,
    "score_report_include_certificate_status": False,
    "sequential_sections": False,
    "allow_revisit_sections": True,
}


def _max_attempts_value(max_attempts: Any) -> int:
    try:
        value = int(max_attempts or 1)
    except (TypeError, ValueError):
        value = 1
    return max(value, 1)


def runtime_attempt_policy_conflicts(payload: dict[str, Any] | None, max_attempts: Any) -> bool:
    return _max_attempts_value(max_attempts) > 1 and isinstance(payload, dict) and payload.get("allow_retake") is False


def apply_runtime_attempt_policy_defaults(payload: dict[str, Any] | None, max_attempts: Any) -> dict[str, Any]:
    data = deepcopy(payload) if isinstance(payload, dict) else {}
    if "allow_retake" not in data and _max_attempts_value(max_attempts) > 1:
        data["allow_retake"] = True
    return data


def _legacy_exam_settings(exam: Exam) -> dict[str, Any]:
    settings = getattr(exam, "settings", None)
    return deepcopy(settings) if isinstance(settings, dict) else {}


def _legacy_admin_meta(exam: Exam) -> dict[str, Any]:
    settings = _legacy_exam_settings(exam)
    meta = settings.get(ADMIN_META_KEY)
    return deepcopy(meta) if isinstance(meta, dict) else {}


def _legacy_runtime_settings(exam: Exam) -> dict[str, Any]:
    settings = _legacy_exam_settings(exam)
    settings.pop(ADMIN_META_KEY, None)
    settings.pop("_pool_library", None)
    return settings


def _merge_payload(target: dict[str, Any], source: dict[str, Any]) -> dict[str, Any]:
    for key, value in (source or {}).items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _merge_payload(target[key], value)
        else:
            target[key] = value
    return target


def exam_library_pool_id(exam: Exam) -> str | None:
    library_pool_id = getattr(exam, "library_pool_id", None)
    if library_pool_id is not None:
        return str(library_pool_id)
    raw = _legacy_exam_settings(exam).get("_pool_library")
    if raw is True:
        return "legacy"
    if isinstance(raw, dict) and raw.get("pool_id"):
        return str(raw["pool_id"])
    return None


def is_exam_pool_library(exam: Exam, pool_id: Any | None = None) -> bool:
    current_pool_id = exam_library_pool_id(exam)
    if current_pool_id is None:
        return False
    if pool_id is None:
        return True
    return current_pool_id == str(pool_id)


def set_exam_library_pool(exam: Exam, pool_id: Any | None) -> None:
    setattr(exam, "library_pool_id", pool_id)
    settings = _legacy_exam_settings(exam)
    if pool_id is None:
        settings.pop("_pool_library", None)
    else:
        settings["_pool_library"] = {"pool_id": str(pool_id)}
    exam.settings = settings


def _runtime_entry_value(entry: ExamRuntimeExtraSetting) -> Any:
    if entry.value_type == "OBJECT":
        return {}
    if entry.value_type == "ARRAY":
        return []
    if entry.value_type == "NULL":
        return None
    if entry.value_type == "BOOLEAN":
        return bool(entry.boolean_value)
    if entry.value_type == "INTEGER":
        return int(entry.integer_value) if entry.integer_value is not None else 0
    if entry.value_type == "FLOAT":
        return float(entry.float_value) if entry.float_value is not None else 0.0
    return entry.string_value


def _path_segments(path: str) -> list[str | int]:
    segments: list[str | int] = []
    for segment in str(path or "").split("."):
        if segment == "":
            continue
        if segment.isdigit():
            segments.append(int(segment))
        else:
            segments.append(segment)
    return segments


def _container_for_segment(segment: str | int) -> dict[str, Any] | list[Any]:
    return [] if isinstance(segment, int) else {}


def _ensure_list_size(items: list[Any], index: int) -> None:
    while len(items) <= index:
        items.append(None)


def _set_nested_value(target: dict[str, Any], path: str, value: Any) -> None:
    segments = _path_segments(path)
    if not segments:
        return
    current: Any = target
    for index, segment in enumerate(segments):
        is_last = index == len(segments) - 1
        next_segment = None if is_last else segments[index + 1]
        if isinstance(segment, int):
            if not isinstance(current, list):
                return
            _ensure_list_size(current, segment)
            if is_last:
                current[segment] = value
                return
            next_value = current[segment]
            if not isinstance(next_value, (dict, list)):
                next_value = _container_for_segment(next_segment)
                current[segment] = next_value
            current = next_value
            continue
        if is_last:
            current[segment] = value
            return
        next_value = current.get(segment)
        if not isinstance(next_value, (dict, list)):
            next_value = _container_for_segment(next_segment)
            current[segment] = next_value
        current = next_value


def _inflate_runtime_extra_settings(entries: Iterable[ExamRuntimeExtraSetting]) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    ordered_entries = sorted(
        entries,
        key=lambda item: (len(_path_segments(item.path)), item.path),
    )
    for entry in ordered_entries:
        _set_nested_value(payload, entry.path, _runtime_entry_value(entry))
    return payload


def _flatten_runtime_setting(path: str, value: Any) -> list[ExamRuntimeExtraSetting]:
    if path == "":
        return []
    if isinstance(value, dict):
        entries = [ExamRuntimeExtraSetting(path=path, value_type="OBJECT")]
        for key, child_value in value.items():
            child_path = f"{path}.{key}"
            entries.extend(_flatten_runtime_setting(child_path, child_value))
        return entries
    if isinstance(value, list):
        entries = [ExamRuntimeExtraSetting(path=path, value_type="ARRAY")]
        for index, child_value in enumerate(value):
            child_path = f"{path}.{index}"
            entries.extend(_flatten_runtime_setting(child_path, child_value))
        return entries
    if value is None:
        return [ExamRuntimeExtraSetting(path=path, value_type="NULL")]
    if isinstance(value, bool):
        return [ExamRuntimeExtraSetting(path=path, value_type="BOOLEAN", boolean_value=value)]
    if isinstance(value, int) and not isinstance(value, bool):
        return [ExamRuntimeExtraSetting(path=path, value_type="INTEGER", integer_value=value)]
    if isinstance(value, float):
        return [ExamRuntimeExtraSetting(path=path, value_type="FLOAT", float_value=value)]
    return [ExamRuntimeExtraSetting(path=path, value_type="STRING", string_value=str(value))]


def _flatten_runtime_extra_settings(payload: dict[str, Any]) -> list[ExamRuntimeExtraSetting]:
    entries: list[ExamRuntimeExtraSetting] = []
    for key, value in payload.items():
        entries.extend(_flatten_runtime_setting(str(key), value))
    return entries


def _sync_collection(
    existing_items: Iterable[Any] | None,
    desired_items: Iterable[Any],
    *,
    key_fn,
    update_fields: Iterable[str],
) -> list[Any]:
    existing_by_key = {
        key_fn(item): item
        for item in (existing_items or [])
    }
    synced: list[Any] = []
    for desired in desired_items:
        current = existing_by_key.pop(key_fn(desired), None)
        if current is None:
            synced.append(desired)
            continue
        for field in update_fields:
            setattr(current, field, getattr(desired, field))
        synced.append(current)
    return synced


def _ensure_admin_config(exam: Exam) -> ExamAdminConfig:
    admin_config = getattr(exam, "admin_config", None)
    if admin_config is None:
        admin_config = ExamAdminConfig(
            report_displayed=ReportDisplayed.IMMEDIATELY_AFTER_GRADING.value,
            report_content=ReportContent.SCORE_AND_DETAILS.value,
            randomize_questions=True,
            **DEFAULT_SECURITY_SETTINGS,
        )
        setattr(exam, "admin_config", admin_config)
    return admin_config


def _ensure_runtime_config(exam: Exam) -> ExamRuntimeConfig:
    runtime_config = getattr(exam, "runtime_config_rel", None)
    if runtime_config is None:
        runtime_config = ExamRuntimeConfig()
        setattr(exam, "runtime_config_rel", runtime_config)
    return runtime_config


def _ensure_certificate_config(exam: Exam) -> ExamCertificateConfig:
    certificate_config = getattr(exam, "certificate_config_rel", None)
    if certificate_config is None:
        certificate_config = ExamCertificateConfig()
        setattr(exam, "certificate_config_rel", certificate_config)
    return certificate_config


def _ensure_proctoring_config(exam: Exam) -> ExamProctoringConfig:
    proctoring_config = getattr(exam, "proctoring_config_rel", None)
    if proctoring_config is None:
        proctoring_config = ExamProctoringConfig(
            **{
                key: DEFAULT_PROCTORING[key]
                for key in _PROCTORING_SCALAR_FIELDS
                if key in DEFAULT_PROCTORING
            }
        )
        setattr(exam, "proctoring_config_rel", proctoring_config)
    return proctoring_config


def serialize_survey_questions(survey: Survey) -> list[dict[str, Any]]:
    if survey.question_items:
        payload: list[dict[str, Any]] = []
        for question in survey.question_items:
            item = {
                "text": question.text,
                "question_type": question.question_type,
            }
            if question.options:
                item["options"] = [option.text for option in question.options]
            payload.append(item)
        return payload
    raw = survey.questions
    return deepcopy(raw) if isinstance(raw, list) else []


def replace_survey_questions(survey: Survey, questions: list[dict[str, Any]]) -> None:
    survey.questions = deepcopy(questions)
    survey.question_items = []
    for question_index, raw_question in enumerate(questions, start=1):
        question = SurveyQuestion(
            position=question_index,
            text=str(raw_question.get("text") or "").strip(),
            question_type=str(raw_question.get("question_type") or raw_question.get("type") or "TEXT").strip().upper(),
        )
        for option_index, option_text in enumerate(raw_question.get("options") or [], start=1):
            question.options.append(
                SurveyQuestionOption(
                    position=option_index,
                    text=str(option_text or "").strip(),
                )
            )
        survey.question_items.append(question)


def serialize_user_group_member_ids(group: UserGroup) -> list[str]:
    if group.member_links:
        ordered = sorted(group.member_links, key=lambda link: (link.position, link.created_at))
        return [str(link.user_id) for link in ordered]
    raw = group.member_ids
    return [str(member_id) for member_id in raw] if isinstance(raw, list) else []


def replace_user_group_members(group: UserGroup, member_ids: Iterable[str], *, db=None) -> None:
    from sqlalchemy import delete as sa_delete
    from sqlalchemy.orm import Session as SASession

    normalized = [str(member_id) for member_id in member_ids]
    group.member_ids = normalized

    # When a session is available, explicitly DELETE old rows, flush, and
    # expire the cached relationship so SQLAlchemy doesn't collide on
    # the UniqueConstraint(group_id, position) during the same flush.
    if db is not None and group.id is not None:
        session: SASession = db
        session.execute(sa_delete(UserGroupMember).where(UserGroupMember.group_id == group.id))
        session.flush()
        session.expire(group, ["member_links"])
        for index, member_id in enumerate(normalized, start=1):
            session.add(UserGroupMember(group_id=group.id, user_id=member_id, position=index))
    else:
        group.member_links = [
            UserGroupMember(user_id=member_id, position=index)
            for index, member_id in enumerate(normalized, start=1)
        ]


def exam_ui_config(exam: Exam) -> dict[str, Any]:
    admin = getattr(exam, "admin_config", None)
    if admin and admin.ui_columns:
        columns = [column.column_key for column in sorted(admin.ui_columns, key=lambda item: item.position)]
        return {"displayed_columns": columns or deepcopy(DEFAULT_UI_COLUMNS)}
    raw = _legacy_admin_meta(exam).get("ui_config") or {}
    columns = raw.get("displayed_columns") if isinstance(raw, dict) else None
    return {"displayed_columns": list(columns) if isinstance(columns, list) and columns else deepcopy(DEFAULT_UI_COLUMNS)}


def set_exam_ui_config(exam: Exam, payload: dict[str, Any] | None) -> None:
    config = _ensure_admin_config(exam)
    raw_columns = payload.get("displayed_columns") if isinstance(payload, dict) else None
    columns = [str(column).strip() for column in (raw_columns or []) if str(column).strip()]
    if not columns:
        columns = deepcopy(DEFAULT_UI_COLUMNS)
    desired_columns = [
        ExamUiColumn(position=index, column_key=column)
        for index, column in enumerate(columns, start=1)
    ]
    config.ui_columns = _sync_collection(
        getattr(config, "ui_columns", None),
        desired_columns,
        key_fn=lambda item: getattr(item, "position", None),
        update_fields=("position", "column_key"),
    )

    settings = _legacy_exam_settings(exam)
    meta = _legacy_admin_meta(exam)
    meta["ui_config"] = {"displayed_columns": columns}
    settings[ADMIN_META_KEY] = meta
    exam.settings = settings


def exam_security_settings(exam: Exam) -> dict[str, Any]:
    admin = getattr(exam, "admin_config", None)
    if admin:
        return {
            "fullscreen_required": bool(admin.fullscreen_required),
            "tab_switch_detect": bool(admin.tab_switch_detect),
            "camera_required": bool(admin.camera_required),
            "mic_required": bool(admin.mic_required),
            "violation_threshold_warn": int(admin.violation_threshold_warn),
            "violation_threshold_autosubmit": int(admin.violation_threshold_autosubmit),
        }
    payload = deepcopy(DEFAULT_SECURITY_SETTINGS)
    payload.update(_legacy_admin_meta(exam).get("settings") or {})
    return payload


def set_exam_security_settings(exam: Exam, payload: dict[str, Any] | None) -> None:
    config = _ensure_admin_config(exam)
    merged = deepcopy(DEFAULT_SECURITY_SETTINGS)
    if isinstance(payload, dict):
        merged.update({key: payload.get(key) for key in DEFAULT_SECURITY_SETTINGS.keys() if key in payload})
    for key, value in merged.items():
        setattr(config, key, value)

    settings = _legacy_exam_settings(exam)
    meta = _legacy_admin_meta(exam)
    meta["settings"] = deepcopy(merged)
    settings[ADMIN_META_KEY] = meta
    exam.settings = settings


def exam_runtime_settings(exam: Exam) -> dict[str, Any]:
    config = getattr(exam, "runtime_config_rel", None)
    if config:
        payload = {
            field: getattr(config, field)
            for field in _RUNTIME_SCALAR_FIELDS
            if getattr(config, field) is not None
        }
        if config.instruction_items:
            payload["instructions_list"] = [item.text for item in sorted(config.instruction_items, key=lambda item: item.position)]
        if config.translations:
            payload["test_translations"] = [
                {
                    "language": translation.locale,
                    "title": translation.title or "",
                    "description": translation.description or "",
                    "instructions_body": translation.instructions_body or "",
                    "completion_message": translation.completion_message or "",
                }
                for translation in sorted(config.translations, key=lambda item: item.locale)
            ]
        if config.extra_settings:
            _merge_payload(payload, _inflate_runtime_extra_settings(config.extra_settings))
        return payload
    return _legacy_runtime_settings(exam)


def set_exam_runtime_settings(exam: Exam, payload: dict[str, Any] | None) -> None:
    runtime = _ensure_runtime_config(exam)
    data = apply_runtime_attempt_policy_defaults(payload, getattr(exam, "max_attempts", 1))
    for field in _RUNTIME_SCALAR_FIELDS:
        if field in data:
            setattr(runtime, field, data.get(field))
        elif field in _RUNTIME_DEFAULTS and getattr(runtime, field, None) is None:
            setattr(runtime, field, _RUNTIME_DEFAULTS[field])
        elif field not in _RUNTIME_DEFAULTS:
            setattr(runtime, field, None)

    instruction_items = []
    for index, item in enumerate(data.get("instructions_list") or [], start=1):
        text = str(item or "").strip()
        if text:
            instruction_items.append(ExamRuntimeInstructionItem(position=index, text=text))
    runtime.instruction_items = _sync_collection(
        getattr(runtime, "instruction_items", None),
        instruction_items,
        key_fn=lambda item: getattr(item, "position", None),
        update_fields=("position", "text"),
    )

    translations = []
    for entry in data.get("test_translations") or []:
        locale = str(entry.get("language") or entry.get("locale") or "").strip()
        if not locale:
            continue
        translations.append(
            ExamRuntimeTranslation(
                locale=locale,
                title=str(entry.get("title") or "").strip() or None,
                description=str(entry.get("description") or "").strip() or None,
                instructions_body=str(entry.get("instructions_body") or "").strip() or None,
                completion_message=str(entry.get("completion_message") or "").strip() or None,
            )
        )
    runtime.translations = _sync_collection(
        getattr(runtime, "translations", None),
        translations,
        key_fn=lambda item: getattr(item, "locale", None),
        update_fields=("locale", "title", "description", "instructions_body", "completion_message"),
    )
    extra_settings = _flatten_runtime_extra_settings(
        {
            key: value
            for key, value in data.items()
            if key not in _RUNTIME_SCALAR_FIELDS and key not in _RUNTIME_COMPLEX_FIELDS
        }
    )
    runtime.extra_settings = _sync_collection(
        getattr(runtime, "extra_settings", None),
        extra_settings,
        key_fn=lambda item: getattr(item, "path", None),
        update_fields=("path", "value_type", "string_value", "integer_value", "float_value", "boolean_value"),
    )

    settings = _legacy_exam_settings(exam)
    settings.pop(ADMIN_META_KEY, None)
    settings.pop("_pool_library", None)
    for key in list(settings.keys()):
        settings.pop(key, None)
    for field in _RUNTIME_SCALAR_FIELDS:
        if data.get(field) is not None:
            settings[field] = data.get(field)
    if instruction_items:
        settings["instructions_list"] = [item.text for item in instruction_items]
    if translations:
        settings["test_translations"] = [
            {
                "language": item.locale,
                "title": item.title or "",
                "description": item.description or "",
                "instructions_body": item.instructions_body or "",
                "completion_message": item.completion_message or "",
            }
            for item in translations
        ]
    for key, value in data.items():
        if key not in _RUNTIME_SCALAR_FIELDS and key not in _RUNTIME_COMPLEX_FIELDS:
            settings[key] = deepcopy(value)
    legacy_meta = _legacy_admin_meta(exam)
    if legacy_meta:
        settings[ADMIN_META_KEY] = legacy_meta
    library_pool_id = getattr(exam, "library_pool_id", None)
    if library_pool_id is not None:
        settings["_pool_library"] = {"pool_id": str(library_pool_id)}
    elif _legacy_exam_settings(exam).get("_pool_library"):
        settings["_pool_library"] = _legacy_exam_settings(exam).get("_pool_library")
    exam.settings = settings


def exam_code(exam: Exam) -> str | None:
    admin_config = getattr(exam, "admin_config", None)
    if admin_config and admin_config.code:
        return admin_config.code
    return _legacy_admin_meta(exam).get("code")


def exam_published_at(exam: Exam) -> datetime | None:
    admin_config = getattr(exam, "admin_config", None)
    if admin_config and admin_config.published_at:
        return admin_config.published_at
    raw = _legacy_admin_meta(exam).get("published_at")
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def exam_archived_at(exam: Exam) -> datetime | None:
    admin_config = getattr(exam, "admin_config", None)
    if admin_config and admin_config.archived_at:
        return admin_config.archived_at
    raw = _legacy_admin_meta(exam).get("archived_at")
    if not raw:
        return None
    if isinstance(raw, datetime):
        return raw
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def exam_randomize_questions(exam: Exam) -> bool:
    admin_config = getattr(exam, "admin_config", None)
    if admin_config is not None:
        return bool(admin_config.randomize_questions)
    return bool(_legacy_admin_meta(exam).get("randomize_questions", True))


def exam_report_displayed(exam: Exam) -> ReportDisplayed:
    admin_config = getattr(exam, "admin_config", None)
    raw = admin_config.report_displayed if admin_config is not None else _legacy_admin_meta(exam).get("report_displayed")
    try:
        return ReportDisplayed(raw or ReportDisplayed.IMMEDIATELY_AFTER_GRADING.value)
    except ValueError:
        return ReportDisplayed.IMMEDIATELY_AFTER_GRADING


def exam_report_content(exam: Exam) -> ReportContent:
    admin_config = getattr(exam, "admin_config", None)
    raw = admin_config.report_content if admin_config is not None else _legacy_admin_meta(exam).get("report_content")
    try:
        return ReportContent(raw or ReportContent.SCORE_AND_DETAILS.value)
    except ValueError:
        return ReportContent.SCORE_AND_DETAILS


def mutate_exam_admin_meta(exam: Exam, **updates: Any) -> None:
    config = _ensure_admin_config(exam)
    settings = _legacy_exam_settings(exam)
    meta = _legacy_admin_meta(exam)
    for key, value in updates.items():
        if key == "code":
            config.code = value
        elif key == "published_at":
            config.published_at = value if isinstance(value, datetime) or value is None else _coerce_datetime(value)
        elif key == "archived_at":
            config.archived_at = value if isinstance(value, datetime) or value is None else _coerce_datetime(value)
        elif key == "randomize_questions":
            config.randomize_questions = bool(value)
        elif key == "report_displayed" and value is not None:
            config.report_displayed = getattr(value, "value", value)
        elif key == "report_content" and value is not None:
            config.report_content = getattr(value, "value", value)
        elif key == "ui_config":
            set_exam_ui_config(exam, value or {})
            continue
        elif key == "settings":
            set_exam_security_settings(exam, value or {})
            continue

        if value is None:
            meta.pop(key, None)
        elif isinstance(value, datetime):
            meta[key] = value.isoformat()
        else:
            meta[key] = getattr(value, "value", value)

    settings[ADMIN_META_KEY] = meta
    exam.settings = settings


def exam_certificate(exam: Exam) -> dict[str, Any] | None:
    certificate = getattr(exam, "certificate", None)
    raw = deepcopy(certificate) if isinstance(certificate, dict) else {}
    config = getattr(exam, "certificate_config_rel", None)
    if config:
        raw.update({
            "title": config.title,
            "subtitle": config.subtitle,
            "issuer": config.issuer,
            "signer": config.signer,
        })
    if not raw:
        return None
    raw["issue_rule"] = normalize_certificate_issue_rule(raw.get("issue_rule"))
    return {key: value for key, value in raw.items() if value not in {None, ""}} or None


def set_exam_certificate(exam: Exam, payload: dict[str, Any] | None) -> None:
    if not isinstance(payload, dict):
        setattr(exam, "certificate_config_rel", None)
        exam.certificate = None
        return

    normalized = deepcopy(payload)
    for key in ("template", "orientation", "description", "title", "subtitle"):
        if key in normalized:
            normalized[key] = str(normalized.get(key) or "").strip() or None
    normalized["issuer"] = str(payload.get("issuer_name") or payload.get("issuer") or "").strip() or None
    normalized["signer"] = str(payload.get("signer_name") or payload.get("signer") or "").strip() or None
    normalized["issue_rule"] = normalize_certificate_issue_rule(payload.get("issue_rule"))
    normalized.pop("issuer_name", None)
    normalized.pop("signer_name", None)

    has_content = any(
        value not in {None, ""}
        for key, value in normalized.items()
        if key != "issue_rule"
    )
    if not has_content:
        setattr(exam, "certificate_config_rel", None)
        exam.certificate = None
        return

    config = _ensure_certificate_config(exam)
    config.title = normalized.get("title")
    config.subtitle = normalized.get("subtitle")
    config.issuer = normalized.get("issuer")
    config.signer = normalized.get("signer")
    exam.certificate = {
        key: value
        for key, value in normalized.items()
        if value not in {None, ""}
    }


def normalize_certificate_issue_rule(value: Any) -> str:
    normalized = str(value or DEFAULT_CERTIFICATE_ISSUE_RULE).strip().upper()
    if normalized not in CERTIFICATE_ISSUE_RULES:
        return DEFAULT_CERTIFICATE_ISSUE_RULE
    return normalized


def exam_proctoring(exam: Exam) -> dict[str, Any]:
    raw = getattr(exam, "proctoring_config", None)
    config = getattr(exam, "proctoring_config_rel", None)

    # Lightweight test doubles often only carry the raw JSON payload. Preserve
    # that shape instead of injecting full production defaults.
    if config is None and not isinstance(exam, Exam):
        payload = deepcopy(raw) if isinstance(raw, dict) else {}
        if not isinstance(payload.get("alert_rules"), list):
            payload["alert_rules"] = []
        return payload

    payload = deepcopy(DEFAULT_PROCTORING)
    if isinstance(raw, dict):
        payload.update(deepcopy(raw))

    if config:
        for key in _PROCTORING_SCALAR_FIELDS:
            value = getattr(config, key)
            if value is not None:
                payload[key] = value
        payload["alert_rules"] = [
            {
                "id": rule.rule_key,
                "event_type": rule.event_type,
                "threshold": rule.threshold,
                "severity": rule.severity,
                "action": rule.action,
                "message": rule.message or "",
            }
            for rule in sorted(config.alert_rules, key=lambda item: item.position)
        ]
        return payload
    if not isinstance(payload.get("alert_rules"), list):
        payload["alert_rules"] = []
    return payload


def set_exam_proctoring(exam: Exam, payload: dict[str, Any] | None) -> None:
    data = deepcopy(payload) if isinstance(payload, dict) else {}
    config = _ensure_proctoring_config(exam)
    merged = deepcopy(DEFAULT_PROCTORING)
    merged.update({key: value for key, value in data.items() if key in merged or key == "access_mode"})
    _BOOL_PROCTORING_KEYS = {
        k for k, v in DEFAULT_PROCTORING.items() if isinstance(v, bool)
    }
    for key in _PROCTORING_SCALAR_FIELDS:
        if key in merged:
            value = merged.get(key)
            if key in _BOOL_PROCTORING_KEYS and not isinstance(value, bool):
                value = str(value).lower() in ("true", "1", "yes")
            setattr(config, key, value)

    rules = []
    for index, rule in enumerate(merged.get("alert_rules") or [], start=1):
        if not isinstance(rule, dict):
            continue
        event_type = str(rule.get("event_type") or "").strip()
        if not event_type:
            continue
        rules.append(
            ExamProctoringAlertRule(
                position=index,
                rule_key=str(rule.get("id") or "").strip() or None,
                event_type=event_type,
                threshold=int(rule.get("threshold") or 1),
                severity=str(rule.get("severity") or "MEDIUM").strip().upper(),
                action=str(rule.get("action") or "WARN").strip().upper(),
                message=str(rule.get("message") or "").strip() or None,
            )
        )
    config.alert_rules = _sync_collection(
        getattr(config, "alert_rules", None),
        rules,
        key_fn=lambda item: getattr(item, "position", None),
        update_fields=("position", "rule_key", "event_type", "threshold", "severity", "action", "message"),
    )
    exam.proctoring_config = {
        key: value
        for key, value in merged.items()
        if key != "alert_rules"
    }
    exam.proctoring_config["alert_rules"] = [
        {
            "id": rule.rule_key,
            "event_type": rule.event_type,
            "threshold": rule.threshold,
            "severity": rule.severity,
            "action": rule.action,
            "message": rule.message or "",
        }
        for rule in rules
    ]


def _coerce_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except ValueError:
        return None
