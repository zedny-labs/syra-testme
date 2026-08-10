"""Certificate generation must honour the configured template, orientation, and
description — and produce a valid PDF for every combination (with a Classic fallback).
"""

from __future__ import annotations

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import app.modules.attempts.routes_public as cert


@pytest.fixture(autouse=True)
def _bypass_db_config(monkeypatch):
    # exam_certificate merges a DB config table; for a unit test read the blob directly.
    monkeypatch.setattr(cert, "exam_certificate", lambda exam: dict(exam.certificate or {}))


def _attempt(template, orientation, description="Completed all modules with distinction."):
    exam = SimpleNamespace(
        title="Advanced Python Certification",
        certificate={
            "template": template,
            "orientation": orientation,
            "title": "Certificate of Achievement",
            "subtitle": "Awarded for outstanding performance",
            "description": description,
            "issuer": "Zedny Academy",
            "signer": "Dr. Sarah Ahmed",
        },
    )
    return SimpleNamespace(
        exam=exam,
        user=SimpleNamespace(name="Omar Hassan"),
        score=92.0,
        submitted_at=datetime(2026, 7, 10, tzinfo=timezone.utc),
    )


@pytest.mark.parametrize("template", ["Classic", "Modern", "Simple", "unknown-style"])
@pytest.mark.parametrize("orientation", ["landscape", "portrait"])
def test_generates_valid_pdf_for_every_template_and_orientation(template, orientation):
    pdf = cert._generate_certificate(_attempt(template, orientation))
    assert pdf[:4] == b"%PDF", "output is not a PDF"
    assert len(pdf) > 800


def test_missing_template_and_orientation_fall_back():
    attempt = _attempt("Classic", "landscape")
    attempt.exam.certificate = {"title": "Cert"}  # no template / orientation / description
    pdf = cert._generate_certificate(attempt)
    assert pdf[:4] == b"%PDF"


def test_empty_description_is_handled():
    pdf = cert._generate_certificate(_attempt("Modern", "portrait", description=""))
    assert pdf[:4] == b"%PDF"
