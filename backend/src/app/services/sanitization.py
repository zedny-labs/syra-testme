import re
from copy import deepcopy
from typing import Any

import bleach

ALLOWED_HTML_TAGS = ["b", "i", "u", "p", "br", "ul", "ol", "li", "strong", "em"]

QUESTION_IMAGE_URL_RE = re.compile(r"^/api/media/questions/[A-Za-z0-9._-]+$")


def sanitize_image_reference(value: str | None) -> str | None:
    """Only accept image references our own upload endpoint produced."""
    if value is None:
        return None
    candidate = str(value).strip()
    if QUESTION_IMAGE_URL_RE.match(candidate):
        return candidate
    return None


def sanitize_plain_text(value: str | None) -> str | None:
    """Strip ALL HTML tags from a plain-text field (names, titles, etc.)."""
    if value is None:
        return None
    cleaned = bleach.clean(str(value).strip(), tags=[], attributes={}, protocols=[], strip=True)
    return cleaned.strip()


def sanitize_html_fragment(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = bleach.clean(
        str(value).strip(),
        tags=ALLOWED_HTML_TAGS,
        attributes={},
        protocols=[],
        strip=True,
    )
    return cleaned.strip()


def sanitize_string_list(values: list[str] | None) -> list[str] | None:
    if values is None:
        return None
    cleaned_values: list[str] = []
    for value in values:
        cleaned = sanitize_html_fragment(value)
        if cleaned:
            cleaned_values.append(cleaned)
    return cleaned_values or None


def sanitize_question_payload(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned = deepcopy(payload)
    if "text" in cleaned:
        cleaned["text"] = sanitize_html_fragment(cleaned.get("text")) or ""
    if "options" in cleaned:
        cleaned["options"] = sanitize_string_list(cleaned.get("options"))
    if "correct_answer" in cleaned:
        cleaned["correct_answer"] = sanitize_html_fragment(cleaned.get("correct_answer"))
    if "image_url" in cleaned:
        cleaned["image_url"] = sanitize_image_reference(cleaned.get("image_url"))
    return cleaned


def sanitize_exam_payload(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned = deepcopy(payload)
    if "description" in cleaned:
        cleaned["description"] = sanitize_html_fragment(cleaned.get("description"))
    if "settings" in cleaned:
        cleaned["settings"] = sanitize_instructions(cleaned.get("settings"))
    return cleaned


def sanitize_instructions(value: Any, *, parent_key: str | None = None) -> Any:
    if isinstance(value, dict):
        sanitized: dict[str, Any] = {}
        for key, item in value.items():
            sanitized[key] = sanitize_instructions(item, parent_key=key)
        return sanitized
    if isinstance(value, list):
        return [sanitize_instructions(item, parent_key=parent_key) for item in value]
    if parent_key == "instructions" and isinstance(value, str):
        return sanitize_html_fragment(value)
    return value
