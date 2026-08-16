"""Arabic/Urdu-capable font registration and text shaping for reportlab PDFs.

reportlab's default fonts (Helvetica, Times) have no Arabic-script glyphs, and
reportlab does not run the Unicode bidi algorithm or Arabic contextual glyph
shaping on its own -- text is drawn in logical character order using whatever
glyphs the active font provides. Any Arabic or Urdu text (e.g. a candidate
name, or a test title/description entered via the translation editor) would
render as missing glyphs or an unshaped, wrongly-ordered character run.

This module registers a single Arabic-script font (Noto Naskh Arabic, bundled
under assets/fonts/) and provides helpers to detect Arabic-range text and
reshape it into a form reportlab can draw correctly. Naskh is used for both
Arabic and Urdu content: the backend has no per-string language tag to
distinguish the two (language is a frontend-only, localStorage concept), and
Nastaliq shaping needs justification/positioning support reportlab's simple
TTFont registration doesn't provide, so Naskh is the practical shared choice.
"""

from __future__ import annotations

import re
from pathlib import Path

import arabic_reshaper
from bidi.algorithm import get_display
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_FONTS_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"

ARABIC_FONT = "NotoNaskhArabic"
ARABIC_FONT_BOLD = "NotoNaskhArabic-Bold"

# Unicode ranges covering Arabic script (also used to write Urdu, Persian, etc.)
_ARABIC_SCRIPT_RE = re.compile(
    r"[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]"
)

_registered = False


def _register_fonts() -> None:
    global _registered
    if _registered:
        return
    pdfmetrics.registerFont(TTFont(ARABIC_FONT, str(_FONTS_DIR / "NotoNaskhArabic-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(ARABIC_FONT_BOLD, str(_FONTS_DIR / "NotoNaskhArabic-Bold.ttf")))
    _registered = True


_register_fonts()


def contains_arabic_script(text: str) -> bool:
    """True if text contains any Arabic-script (Arabic/Urdu/etc.) characters."""
    return bool(text) and bool(_ARABIC_SCRIPT_RE.search(text))


def shape_arabic(text: str) -> str:
    """Reshape Arabic-script text into correct contextual glyph forms and
    reorder it into visual (left-to-right-drawable) order via the bidi
    algorithm, as required for reportlab to draw it correctly."""
    reshaped = arabic_reshaper.reshape(text)
    return get_display(reshaped)


def resolve_font_and_text(text: str, latin_font: str) -> tuple[str, str]:
    """Given text and the font that would normally draw it, return
    (font_to_use, text_to_draw): the Arabic font + shaped text if `text`
    contains Arabic-script characters, otherwise the original font + text
    unchanged. For use with the low-level canvas API (setFont/drawString)."""
    if not contains_arabic_script(text):
        return latin_font, text
    font = ARABIC_FONT_BOLD if "Bold" in latin_font else ARABIC_FONT
    return font, shape_arabic(text)


def draw_centred_shaped(c, cx: float, y: float, text: str, font: str, size: float) -> None:
    """Drop-in replacement for `c.setFont(font, size); c.drawCentredString(cx,
    y, text)` that auto-detects Arabic-script text, reshapes it, and draws it
    with the Arabic-capable font instead."""
    resolved_font, resolved_text = resolve_font_and_text(str(text), font)
    c.setFont(resolved_font, size)
    c.drawCentredString(cx, y, resolved_text)


def draw_wrapped_centred_shaped(c, text: str, cx: float, y: float, font: str, size: float, max_width: float, simple_split) -> float:
    """Drop-in replacement for a word-wrapped, centred multi-line draw loop
    built on reportlab's `simpleSplit`. Auto-detects Arabic-script text,
    reshapes it (so `simple_split` measures the real shaped-glyph widths),
    and bidi-reorders each wrapped line individually before drawing it with
    the Arabic-capable font. `simple_split` is reportlab's
    `reportlab.lib.utils.simpleSplit`, passed in to avoid this module
    depending on it directly. Returns the y position below the last line."""
    text = str(text)
    if not text:
        return y
    step = size * 1.35
    if contains_arabic_script(text):
        font = ARABIC_FONT_BOLD if "Bold" in font else ARABIC_FONT
        text = arabic_reshaper.reshape(text)
    for line in simple_split(text, font, size, max_width):
        display_line = get_display(line) if contains_arabic_script(line) else line
        c.setFont(font, size)
        c.drawCentredString(cx, y, display_line)
        y -= step
    return y


def shape_for_paragraph(text: str) -> str:
    """Shape+reorder Arabic-script text and wrap it in an inline reportlab
    <font name="..."> tag pointing at the Arabic-capable font, so it can be
    safely interpolated into a Platypus Paragraph's markup string (plain, or
    already containing other <font>/<b>/<br/> tags) without altering the
    paragraph's base style. Non-Arabic text is returned unchanged."""
    if not contains_arabic_script(text):
        return text
    return f'<font name="{ARABIC_FONT}">{shape_arabic(text)}</font>'


def shape_table_data(data: list[list]) -> tuple[list[list], list[tuple]]:
    """Shape any Arabic-script cell values in a reportlab Table's 2D data
    grid (plain-string cells, not Paragraphs). Returns (new_data,
    extra_style_commands): new_data has Arabic cells replaced with their
    shaped text, and extra_style_commands is a list of per-cell
    ("FONTNAME", (col, row), (col, row), ARABIC_FONT) TableStyle overrides
    to append to the table's existing TableStyle so those cells render with
    the Arabic-capable font."""
    new_data: list[list] = []
    extra_commands: list[tuple] = []
    for row_index, row in enumerate(data):
        new_row = []
        for col_index, cell in enumerate(row):
            text = "" if cell is None else str(cell)
            if contains_arabic_script(text):
                new_row.append(shape_arabic(text))
                extra_commands.append(("FONTNAME", (col_index, row_index), (col_index, row_index), ARABIC_FONT))
            else:
                new_row.append(cell)
        new_data.append(new_row)
    return new_data, extra_commands
