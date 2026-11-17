"""Spreadsheet and PDF writers shared by exports and the AI assistant's downloads.

- Excel: numbers stay numbers (money with two decimals, counts as integers); long digit strings such as
  phone, AWB and account numbers stay text so nothing is rounded; text that looks like a formula is
  written as text, never as a formula. Header row is bold, frozen and filterable.
- PDF: DejaVu Sans (bundled, covers ₹); tables repeat their header on every page; long tables are
  capped with a note pointing to Excel/CSV. Indian-script names are best read in Excel or CSV.
"""
from __future__ import annotations

import io
import re
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

FONT_DIR = Path(__file__).resolve().parents[1] / "assets" / "fonts"
_MONEY = re.compile(r"^-?\d{1,13}\.\d{2}$")
_INT = re.compile(r"^-?(0|[1-9]\d{0,8})$")  # up to 9 digits; longer digit strings (phones, AWBs) stay text
_DEC = re.compile(r"^-?\d{1,9}\.\d{1,4}$")
_ILLEGAL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

PDF_MAX_ROWS = 2000
PDF_MAX_COLUMNS = 14


def excel_value(value: Any) -> tuple[Any, str | None]:
    """(value, number format). Converts numeric text to numbers; everything else stays text."""
    if value is None:
        return "", None
    if isinstance(value, bool):
        return ("yes" if value else "no"), None
    if isinstance(value, int):
        return value, "#,##0"
    if isinstance(value, float):
        return value, "#,##0.00"
    v = _ILLEGAL.sub("", str(value))
    if v.startswith("'") and len(v) > 1 and v[1] in "=+-@":
        v = v[1:]  # CSV's formula guard; Excel cells are typed as text below instead
    if _MONEY.match(v):
        return float(v), "#,##0.00"
    if _INT.match(v):
        return int(v), "0"
    if _DEC.match(v):
        return float(v), "0.####"
    return v, None


# ----------------------------------------------------------------------------- Excel


class XlsxWriter:
    """Streams rows into a write-only workbook backed by a temporary file (constant memory)."""

    HEADER_FILL = PatternFill("solid", fgColor="E8EEF0")

    def __init__(self, sheet_title: str, columns: list[str], wb: Workbook | None = None) -> None:
        self.wb = wb or Workbook(write_only=True)
        self.ws = self.wb.create_sheet(_sheet_name(sheet_title))
        self.columns = columns
        self.widths = [min(max(len(c) + 2, 10), 40) for c in columns]
        self.ws.freeze_panes = "A2"
        self.rows = 0
        self._header_written = False

    def _cell(self, value: Any, *, header: bool = False) -> WriteOnlyCell:
        v, fmt = (str(value), None) if header else excel_value(value)
        cell = WriteOnlyCell(self.ws, value=v)
        if isinstance(v, str):
            cell.data_type = "s"  # never a formula, even when the text starts with "="
        if fmt:
            cell.number_format = fmt
        if header:
            cell.font = Font(bold=True)
            cell.fill = self.HEADER_FILL
            cell.alignment = Alignment(vertical="center")
        return cell

    def _set_widths(self) -> None:
        for i, w in enumerate(self.widths, start=1):
            self.ws.column_dimensions[get_column_letter(i)].width = w

    def append(self, row: Iterable[Any]) -> None:
        if not self._header_written:
            self._set_widths()
            self.ws.append([self._cell(c, header=True) for c in self.columns])
            self._header_written = True
        cells = []
        for i, value in enumerate(row):
            cells.append(self._cell(value))
            if i < len(self.widths) and self.rows < 200:  # size columns from the first rows
                self.widths[i] = min(max(self.widths[i], len(str(value or "")) + 2), 60)
        self.ws.append(cells)
        self.rows += 1

    def add_about(self, title: str, lines: list[tuple[str, str]]) -> None:
        about = self.wb.create_sheet("About")
        about.append([WriteOnlyCell(about, value=title)])
        for k, v in lines:
            c1, c2 = WriteOnlyCell(about, value=k), WriteOnlyCell(about, value=str(v))
            c1.data_type = c2.data_type = "s"
            about.append([c1, c2])

    def close_sheet(self) -> None:
        if not self._header_written:
            self._set_widths()
            self.ws.append([self._cell(c, header=True) for c in self.columns])
            self._header_written = True
        self.ws.auto_filter.ref = f"A1:{get_column_letter(max(1, len(self.columns)))}{self.rows + 1}"

    def finish(self) -> tempfile.SpooledTemporaryFile:
        self.close_sheet()
        out = tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024)
        self.wb.save(out)
        out.seek(0)
        return out


def _sheet_name(title: str) -> str:
    return re.sub(r"[\[\]:*?/\\]", " ", title)[:31] or "Sheet"


def xlsx_bytes(sheets: list[tuple[str, list[str], list[list[Any]]]], about: list[tuple[str, str]] | None = None, about_title: str = "") -> bytes:
    """A small workbook: one sheet per (title, columns, rows)."""
    if not sheets:
        sheets = [("Data", ["Note"], [["No table in this message"]])]
    first = XlsxWriter(sheets[0][0], sheets[0][1])
    for r in sheets[0][2]:
        first.append(r)
    first.close_sheet()
    used = {first.ws.title}
    for title, cols, rows in sheets[1:]:
        name, n = _sheet_name(title), 2
        while name in used:
            name, n = f"{_sheet_name(title)[:28]} {n}", n + 1
        used.add(name)
        w = XlsxWriter(name, cols, wb=first.wb)
        for r in rows:
            w.append(r)
        w.close_sheet()
    if about:
        first.add_about(about_title, about)
    f = first.finish()
    return f.read()


# ----------------------------------------------------------------------------- PDF


_fonts_ready = False


def _fonts() -> tuple[str, str]:
    global _fonts_ready
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont

    regular, bold = FONT_DIR / "DejaVuSans.ttf", FONT_DIR / "DejaVuSans-Bold.ttf"
    if not (regular.exists() and bold.exists()):
        return "Helvetica", "Helvetica-Bold"
    if not _fonts_ready:
        pdfmetrics.registerFont(TTFont("DejaVu", str(regular)))
        pdfmetrics.registerFont(TTFont("DejaVu-Bold", str(bold)))
        pdfmetrics.registerFontFamily("DejaVu", normal="DejaVu", bold="DejaVu-Bold", italic="DejaVu", boldItalic="DejaVu-Bold")
        _fonts_ready = True
    return "DejaVu", "DejaVu-Bold"


@dataclass
class PdfDoc:
    title: str
    subtitle: str = ""
    blocks: list[tuple[str, Any]] = field(default_factory=list)  # ("heading"|"text"|"table"|"metrics"|"chart"|"note", payload)

    def heading(self, text: str) -> PdfDoc:
        self.blocks.append(("heading", text))
        return self

    def text(self, text: str) -> PdfDoc:
        self.blocks.append(("text", text))
        return self

    def note(self, text: str) -> PdfDoc:
        self.blocks.append(("note", text))
        return self

    def table(self, columns: list[str], rows: list[list[Any]], *, total_rows: int | None = None) -> PdfDoc:
        self.blocks.append(("table", (columns, rows, total_rows)))
        return self

    def metrics(self, items: list[tuple[str, str]]) -> PdfDoc:
        self.blocks.append(("metrics", items))
        return self

    def chart(self, kind: str, labels: list[str], series: list[tuple[str, list[float]]], y_label: str = "") -> PdfDoc:
        self.blocks.append(("chart", (kind, labels, series, y_label)))
        return self


def _inline_md(text: str) -> str:
    """Escapes text for a reportlab Paragraph and keeps **bold** from chat answers."""
    t = escape(text)
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)


def _chart(kind: str, labels: list[str], series: list[tuple[str, list[float]]], width: float, font: str = "Helvetica"):
    from reportlab.graphics.charts.barcharts import VerticalBarChart
    from reportlab.graphics.charts.legends import Legend
    from reportlab.graphics.charts.linecharts import HorizontalLineChart
    from reportlab.graphics.shapes import Drawing
    from reportlab.lib import colors

    palette = [colors.HexColor(c) for c in ("#0B5563", "#E07A1F", "#5B7F2B", "#7A4E9C", "#B23A48", "#2E6DB4")]
    d = Drawing(width, 200)
    chart = HorizontalLineChart() if kind == "line" else VerticalBarChart()
    chart.x, chart.y, chart.width, chart.height = 45, 40, width - 60, 140
    data = [[float(v or 0) for v in values] for _, values in series] or [[0]]
    chart.data = data
    chart.categoryAxis.categoryNames = [str(lbl)[:14] for lbl in labels] or [""]
    chart.categoryAxis.labels.fontSize = 6
    chart.categoryAxis.labels.fontName = font
    chart.valueAxis.labels.fontName = font
    chart.categoryAxis.labels.angle = 30 if len(labels) > 8 else 0
    chart.categoryAxis.labels.boxAnchor = "ne" if len(labels) > 8 else "n"
    chart.valueAxis.labels.fontSize = 7
    lo = min(0.0, *[min(s) for s in data])
    hi = max(1.0, *[max(s) for s in data])
    chart.valueAxis.valueMin, chart.valueAxis.valueMax = lo, hi * 1.1
    for i in range(len(data)):
        if kind == "line":
            chart.lines[i].strokeColor = palette[i % len(palette)]
            chart.lines[i].strokeWidth = 1.5
        else:
            chart.bars[i].fillColor = palette[i % len(palette)]
            chart.bars[i].strokeColor = None
    d.add(chart)
    if len(series) > 1:
        legend = Legend()
        legend.x, legend.y, legend.fontSize, legend.fontName = 50, 195, 7, font
        legend.alignment = "right"
        legend.columnMaximum = 1
        legend.colorNamePairs = [(palette[i % len(palette)], name) for i, (name, _) in enumerate(series)]
        d.add(legend)
    return d


def pdf_bytes(doc: PdfDoc, *, brand: str = "") -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A3, A4, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import LongTable, Paragraph, SimpleDocTemplate, Spacer, TableStyle

    regular, bold = _fonts()
    widest = max([len(b[1][0]) for b in doc.blocks if b[0] == "table"] or [0])
    pagesize = landscape(A3) if widest > 9 else (landscape(A4) if widest > 5 else A4)
    buf = io.BytesIO()
    generated = datetime.now().astimezone().strftime("%d %b %Y, %I:%M %p")

    def footer(canvas, d):
        canvas.saveState()
        canvas.setFont(regular, 7)
        canvas.setFillColor(colors.grey)
        canvas.drawString(d.leftMargin, 8 * mm, f"{brand} · {doc.title} · generated {generated}".strip(" ·"))
        canvas.drawRightString(d.pagesize[0] - d.rightMargin, 8 * mm, f"Page {d.page}")
        canvas.restoreState()

    tpl = SimpleDocTemplate(buf, pagesize=pagesize, leftMargin=12 * mm, rightMargin=12 * mm, topMargin=12 * mm, bottomMargin=14 * mm,
                            title=doc.title, author=brand or "", creator=brand or "")
    ss = getSampleStyleSheet()
    s_title = ParagraphStyle("t", parent=ss["Title"], fontName=bold, fontSize=16, alignment=0, spaceAfter=2)
    s_sub = ParagraphStyle("s", parent=ss["Normal"], fontName=regular, fontSize=8.5, textColor=colors.HexColor("#555555"))
    s_h = ParagraphStyle("h", parent=ss["Heading2"], fontName=bold, fontSize=11.5, spaceBefore=8, spaceAfter=4)
    s_p = ParagraphStyle("p", parent=ss["Normal"], fontName=regular, fontSize=9.5, leading=13)
    s_note = ParagraphStyle("n", parent=s_p, fontSize=8, textColor=colors.HexColor("#6b4e00"))
    s_cell = ParagraphStyle("c", parent=ss["Normal"], fontName=regular, fontSize=7, leading=8.5)
    s_head = ParagraphStyle("ch", parent=s_cell, fontName=bold)
    story: list[Any] = [Paragraph(_inline_md(doc.title), s_title)]
    if doc.subtitle:
        story.append(Paragraph(_inline_md(doc.subtitle), s_sub))
    story.append(Spacer(1, 6))
    usable = pagesize[0] - 24 * mm
    for kind, payload in doc.blocks:
        if kind == "heading":
            story.append(Paragraph(_inline_md(payload), s_h))
        elif kind in ("text", "note"):
            for para in str(payload).split("\n\n"):
                lines = [ln for ln in para.split("\n")]
                html = "<br/>".join(("• " + _inline_md(ln[2:])) if ln.startswith(("- ", "* ")) else _inline_md(ln) for ln in lines)
                story.append(Paragraph(html, s_note if kind == "note" else s_p))
                story.append(Spacer(1, 3))
        elif kind == "metrics":
            cells = [[Paragraph(f"<font size=7 color='#666666'>{escape(k)}</font><br/><b>{escape(v)}</b>", s_p) for k, v in payload[i:i + 4]]
                     for i in range(0, len(payload), 4)]
            for row in cells:
                row += [""] * (4 - len(row))
            t = LongTable(cells, colWidths=[usable / 4] * 4)
            t.setStyle(TableStyle([("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#d0d7da")), ("INNERGRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#d0d7da")),
                                   ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f6f8f9")), ("TOPPADDING", (0, 0), (-1, -1), 5), ("BOTTOMPADDING", (0, 0), (-1, -1), 5)]))
            story += [t, Spacer(1, 6)]
        elif kind == "chart":
            ck, labels, series, _ = payload
            story += [_chart(ck, labels, series, min(usable, 520), regular), Spacer(1, 6)]
        elif kind == "table":
            columns, rows, total = payload
            columns = list(columns)[:PDF_MAX_COLUMNS]
            shown = rows[:PDF_MAX_ROWS]
            data = [[Paragraph(_inline_md(str(c)), s_head) for c in columns]]
            for r in shown:
                data.append([Paragraph(_inline_md("" if c is None else str(c))[:400], s_cell) for c in list(r)[:len(columns)]])
            t = LongTable(data, colWidths=[usable / max(1, len(columns))] * len(columns), repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E8EEF0")),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.HexColor("#9aa9ae")),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9fa")]),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
            ]))
            story += [t, Spacer(1, 4)]
            hidden = (total if total is not None else len(rows)) - len(shown)
            if hidden > 0:
                story.append(Paragraph(f"{hidden:,} more rows are not shown in the PDF. Download Excel or CSV for every row.", s_note))
            story.append(Spacer(1, 6))
    tpl.build(story, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
