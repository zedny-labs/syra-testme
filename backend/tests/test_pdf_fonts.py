"""Arabic/Urdu PDF font + shaping support (app.services.pdf_fonts).

Covers script detection, glyph shaping/bidi reordering, and the font-resolution
helpers used by certificate and report PDF generation so Arabic/Urdu text
renders with real glyphs instead of tofu/missing-character boxes.
"""

from __future__ import annotations

from reportlab.pdfbase import pdfmetrics

from app.services import pdf_fonts

ARABIC_SAMPLE = "مرحبا بالعالم"
URDU_SAMPLE = "یہ اردو کا نمونہ ہے"
ENGLISH_SAMPLE = "Hello World"


def test_fonts_are_registered():
    names = pdfmetrics.getRegisteredFontNames()
    assert pdf_fonts.ARABIC_FONT in names
    assert pdf_fonts.ARABIC_FONT_BOLD in names


def test_contains_arabic_script_detects_arabic_and_urdu():
    assert pdf_fonts.contains_arabic_script(ARABIC_SAMPLE) is True
    assert pdf_fonts.contains_arabic_script(URDU_SAMPLE) is True


def test_contains_arabic_script_false_for_latin_and_empty():
    assert pdf_fonts.contains_arabic_script(ENGLISH_SAMPLE) is False
    assert pdf_fonts.contains_arabic_script("") is False
    assert pdf_fonts.contains_arabic_script(None) is False


def test_shape_arabic_reorders_and_joins_glyphs():
    shaped = pdf_fonts.shape_arabic(ARABIC_SAMPLE)
    # Reshaping+bidi produces a different codepoint sequence than the raw
    # logical string (contextual presentation forms, visual order).
    assert shaped != ARABIC_SAMPLE
    assert len(shaped) > 0


def test_resolve_font_and_text_switches_font_only_for_arabic():
    font, text = pdf_fonts.resolve_font_and_text(ARABIC_SAMPLE, "Helvetica")
    assert font == pdf_fonts.ARABIC_FONT
    assert text != ARABIC_SAMPLE

    font, text = pdf_fonts.resolve_font_and_text(ENGLISH_SAMPLE, "Helvetica")
    assert font == "Helvetica"
    assert text == ENGLISH_SAMPLE


def test_resolve_font_and_text_picks_bold_variant():
    font, _ = pdf_fonts.resolve_font_and_text(ARABIC_SAMPLE, "Helvetica-Bold")
    assert font == pdf_fonts.ARABIC_FONT_BOLD


def test_shape_for_paragraph_wraps_arabic_in_font_tag():
    result = pdf_fonts.shape_for_paragraph(ARABIC_SAMPLE)
    assert result.startswith(f'<font name="{pdf_fonts.ARABIC_FONT}">')
    assert result.endswith("</font>")


def test_shape_for_paragraph_passes_through_non_arabic():
    assert pdf_fonts.shape_for_paragraph(ENGLISH_SAMPLE) == ENGLISH_SAMPLE


def test_shape_table_data_shapes_only_arabic_cells():
    data = [["User", "Email"], [ARABIC_SAMPLE, "test@example.com"]]
    new_data, extra_commands = pdf_fonts.shape_table_data(data)

    assert new_data[0] == ["User", "Email"]
    assert new_data[1][0] != ARABIC_SAMPLE
    assert new_data[1][1] == "test@example.com"

    assert extra_commands == [("FONTNAME", (0, 1), (0, 1), pdf_fonts.ARABIC_FONT)]


def test_shape_table_data_handles_none_and_non_string_cells():
    data = [[None, 42]]
    new_data, extra_commands = pdf_fonts.shape_table_data(data)
    assert new_data == [[None, 42]]
    assert extra_commands == []
