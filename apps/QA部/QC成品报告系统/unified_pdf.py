"""Standalone generator for the unified English AI-assisted QC report.

The public :func:`generate_unified_report_pdf` function intentionally accepts a
plain, normalized mapping so it can be called from Flask, a worker, or a test
without importing the application's ORM models.  The expected top-level keys
are ``report_no``, ``revision``, ``company_name``, ``report_title``,
``inspection_date``, ``result``, ``result_reason``, ``overview``, ``aql``,
``defects``, ``tests``, ``product``, ``packing``, ``remarks``, ``photo_slots``
(or flat ``photos``), and ``inspector``.  Missing optional values render as
blank rather than being invented.

Layout follows the classic TigerHead Toys pre-shipment inspection report:
plain table grid, light section bands, company header on every page.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from io import BytesIO
from math import ceil
from pathlib import Path
import re
from typing import Any, Iterable, Mapping, Sequence

from PIL import Image, ImageOps
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfgen import canvas


__all__ = ["generate_unified_report_pdf"]

PAGE_W, PAGE_H = A4
MARGIN = 46
CONTENT_W = PAGE_W - MARGIN * 2

NAVY = colors.HexColor("#15324A")
BLUE = colors.HexColor("#1E66F5")
SKY = colors.HexColor("#EAF2FF")
INK = colors.HexColor("#182230")
MUTED = colors.HexColor("#667085")
LINE = colors.HexColor("#C7D0DC")
PALE = colors.HexColor("#F5F8FC")
GREEN = colors.HexColor("#067647")
GREEN_BG = colors.HexColor("#ECFDF3")
AMBER = colors.HexColor("#B54708")
AMBER_BG = colors.HexColor("#FFFAEB")
RED = colors.HexColor("#B42318")
RED_BG = colors.HexColor("#FEF3F2")
WHITE = colors.white

# TigerHead classic layout palette
BAND_BG = colors.HexColor("#D9DEE7")
TH_BORDER = colors.HexColor("#3A4150")
TH_GREEN = colors.HexColor("#1E7B34")
TH_GREY = colors.HexColor("#777777")

HEADER_COMPANY = "TigerHead Toys Ltd."
HEADER_ADDRESS = [
    "Room 916, 9/F, Houston Centre",
    "63 Mody Road, Tsim Sha Tsui East",
    "Kowloon, Hong Kong",
    "Phone (+852) 3103 7300",
]

try:
    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
except Exception:
    # The CID font is bundled with ReportLab.  Registration may already have
    # happened elsewhere in the process, which is safe to ignore.
    pass


@dataclass(frozen=True)
class _Evidence:
    title: str
    caption: str
    path: str | None
    required: bool = False
    sample_id: str = ""
    category: str = ""


def _mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    return [value]


def _first(data: Mapping[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        value = data.get(key)
        if value is not None and value != "":
            return value
    return default


def _text_value(value: Any, fallback: str = "-") -> str:
    if value is None or value == "":
        return fallback
    if isinstance(value, bool):
        return "YES" if value else "NO"
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ", timespec="minutes") if isinstance(value, datetime) else value.isoformat()
    if isinstance(value, (list, tuple, set)):
        rendered = ", ".join(_text_value(item, "") for item in value if item not in (None, ""))
        return rendered or fallback
    return str(value)


def _contains_cjk(text: str) -> bool:
    return any("\u2e80" <= char <= "\u9fff" or "\uf900" <= char <= "\ufaff" for char in text)


def _english_text(value: Any, fallback: str = "-") -> str:
    """Return an English-only display label without inventing a translation."""
    rendered = _text_value(value, "").strip()
    if not rendered:
        return fallback
    if not _contains_cjk(rendered):
        return rendered
    for part in reversed(re.split(r"\s*(?:/|｜|\|)\s*", rendered)):
        candidate = part.strip()
        if candidate and re.search(r"[A-Za-z]", candidate) and not _contains_cjk(candidate):
            return candidate
    ascii_only = re.sub(r"\s+", " ", "".join(char if ord(char) < 128 else " " for char in rendered)).strip(" -/|")
    return ascii_only if re.search(r"[A-Za-z]", ascii_only) else fallback


def _photo_label_fallback(category: Any) -> str:
    return {
        "product": "Product",
        "marking": "Product marking",
        "date_code": "Date code",
        "packaging": "Packaging",
        "barcode": "Barcode",
        "defect": "Defect evidence",
        "carton": "Carton",
        "warehouse": "Warehouse stock",
        "instruction": "Instruction",
    }.get(_text_value(category, "").strip().lower(), "Photo evidence")


def _percentage_value(value: Any) -> str:
    rendered = _text_value(value, "-").strip()
    if rendered == "-":
        return rendered
    return rendered if rendered.endswith("%") else f"{rendered}%"


def _weight_value(value: Any) -> str:
    rendered = _text_value(value, "-").strip()
    if rendered == "-":
        return rendered
    return rendered if re.search(r"\bkgs?\b", rendered, re.IGNORECASE) else f"{rendered} kg"


def _weights(net: Any, gross: Any) -> str:
    return f"N.W. {_weight_value(net)} / G.W. {_weight_value(gross)}" if net not in (None, "") or gross not in (None, "") else ""


def _timestamp_value(value: Any) -> str:
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="minutes")
    rendered = _text_value(value, "-").strip()
    if rendered == "-":
        return rendered
    try:
        parsed = datetime.fromisoformat(rendered.replace("Z", "+00:00"))
    except ValueError:
        return rendered
    return parsed.isoformat(sep=" ", timespec="minutes")


def _font(text: Any = "", bold: bool = False) -> str:
    return "STSong-Light" if _contains_cjk(_text_value(text, "")) else ("Helvetica-Bold" if bold else "Helvetica")


def _split_long_token(token: str, font_name: str, size: float, width: float) -> list[str]:
    pieces: list[str] = []
    current = ""
    for char in token:
        candidate = current + char
        if current and pdfmetrics.stringWidth(candidate, font_name, size) > width:
            pieces.append(current)
            current = char
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces or [token]


def _wrap(text: Any, width: float, size: float, bold: bool = False) -> list[str]:
    rendered = _text_value(text, "").replace("\r", " ").replace("\n", " ").strip()
    if not rendered:
        return [""]
    font_name = _font(rendered, bold)
    tokens = list(rendered) if _contains_cjk(rendered) else rendered.split()
    joiner = "" if _contains_cjk(rendered) else " "
    lines: list[str] = []
    current = ""
    for raw_token in tokens:
        token_parts = (
            _split_long_token(raw_token, font_name, size, width)
            if pdfmetrics.stringWidth(raw_token, font_name, size) > width
            else [raw_token]
        )
        for token in token_parts:
            candidate = token if not current else current + joiner + token
            if not current or pdfmetrics.stringWidth(candidate, font_name, size) <= width:
                current = candidate
            else:
                lines.append(current)
                current = token
    if current:
        lines.append(current)
    return lines or [""]


def _fit_lines(text: Any, width: float, size: float, max_lines: int, bold: bool = False) -> list[str]:
    lines = _wrap(text, width, size, bold)
    if len(lines) <= max_lines:
        return lines
    clipped = lines[:max_lines]
    last = clipped[-1].rstrip()
    font_name = _font(last, bold)
    while last and pdfmetrics.stringWidth(last + "...", font_name, size) > width:
        last = last[:-1]
    clipped[-1] = (last.rstrip() + "...") if last else "..."
    return clipped


def _draw_text(
    c: canvas.Canvas,
    x: float,
    y: float,
    text: Any,
    *,
    size: float = 8,
    bold: bool = False,
    color: colors.Color = INK,
    width: float | None = None,
    max_lines: int = 1,
    leading: float | None = None,
) -> float:
    rendered = _text_value(text)
    font_name = _font(rendered, bold)
    c.setFont(font_name, size)
    c.setFillColor(color)
    lines = _fit_lines(rendered, width, size, max_lines, bold) if width else rendered.splitlines()[:max_lines]
    line_height = leading or size * 1.25
    for index, line in enumerate(lines):
        c.drawString(x, y - index * line_height, line)
    return y - len(lines) * line_height


def _status_style(result: str) -> tuple[colors.Color, colors.Color]:
    upper = result.upper()
    if upper == "PASS":
        return GREEN, GREEN_BG
    if upper == "REJECT":
        return RED, RED_BG
    return AMBER, AMBER_BG


def _draw_image_contain(c: canvas.Canvas, path: str | Path | None, x: float, y: float, w: float, h: float) -> bool:
    if not path:
        return False
    image_path = Path(str(path))
    if not image_path.is_file():
        return False
    try:
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source)
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGB")
            max_side = max(image.size)
            if max_side > 3600:
                ratio = 3600 / max_side
                image = image.resize(
                    (max(1, round(image.width * ratio)), max(1, round(image.height * ratio))),
                    Image.Resampling.LANCZOS,
                )
            buffer = BytesIO()
            if image.mode == "RGBA":
                image.save(buffer, format="PNG", optimize=True)
            else:
                image.save(buffer, format="JPEG", quality=95, optimize=True, subsampling=0)
            buffer.seek(0)
            reader = ImageReader(buffer)
            iw, ih = reader.getSize()
            scale = min(w / iw, h / ih)
            draw_w, draw_h = iw * scale, ih * scale
            c.drawImage(
                reader,
                x + (w - draw_w) / 2,
                y + (h - draw_h) / 2,
                draw_w,
                draw_h,
                preserveAspectRatio=True,
                mask="auto",
            )
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Data normalization helpers (payload contract kept stable)
# ---------------------------------------------------------------------------


def _normalize_aql(data: Mapping[str, Any]) -> list[list[Any]]:
    source = data.get("aql")
    lookup: dict[str, Mapping[str, Any]] = {}
    if isinstance(source, Mapping):
        lookup = {str(key).lower(): _mapping(value) for key, value in source.items()}
    else:
        for raw in _list(source):
            row = _mapping(raw)
            severity = _text_value(_first(row, "severity", "class", default=""), "").lower()
            if severity:
                lookup[severity] = row
    rows: list[list[Any]] = []
    for severity in ("critical", "major", "minor"):
        row = lookup.get(severity, {})
        found = _first(row, "found", "count", "quantity", default=_first(data, f"{severity}_count", default=0))
        ac = _first(row, "ac", "accept", "acceptance", default="-")
        reject = _first(row, "re", "reject", "rejection", default="-")
        decision = _first(row, "decision", default="OK" if isinstance(found, (int, float)) and isinstance(ac, (int, float)) and found <= ac else "CHECK")
        rows.append([severity.title(), _first(row, "aql", default=_first(data, f"{severity}_aql", default="-")), ac, reject, found, decision])
    return rows


def _confirmed_defects(data: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    confirmed: list[Mapping[str, Any]] = []
    for raw in _list(data.get("defects")):
        defect = _mapping(raw)
        state = _text_value(_first(defect, "qc_status", "status", "decision", default="confirmed"), "confirmed").lower()
        if state in {"rejected", "reject", "pending", "unreviewed", "suggested"}:
            continue
        confirmed.append(defect)
    return confirmed


def _defect_rows(defects: Iterable[Mapping[str, Any]]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for defect in defects:
        severity = _text_value(_first(defect, "severity", "classification", default="minor"), "minor").lower()
        quantity = _first(defect, "quantity", "affected_quantity", "count", default=0)
        description = _first(defect, "description", "english_description", "name", default="")
        sample_ids = _first(defect, "sample_ids", "sample_id")
        if sample_ids:
            description = f"{_text_value(description, '')} | Sample: {_text_value(sample_ids)}"
        rows.append([
            quantity if severity == "critical" else 0,
            quantity if severity == "major" else 0,
            quantity if severity == "minor" else 0,
            description,
        ])
    return rows or [[0, 0, 0, ""]]


def _test_rows(data: Mapping[str, Any]) -> list[list[Any]]:
    rows: list[list[Any]] = []
    for raw in _list(_first(data, "tests", "performance_tests", default=[])):
        test = _mapping(raw)
        rows.append([
            _first(test, "name", "test_name", default=""),
            _first(test, "standard", "requirement", default=""),
            _first(test, "result", default=""),
        ])
    return rows


def _normalize_photos(data: Mapping[str, Any]) -> tuple[list[_Evidence], list[_Evidence]]:
    evidence: list[_Evidence] = []
    warehouses: list[_Evidence] = []
    seen: set[tuple[str, str]] = set()

    def is_warehouse(*values: Any) -> bool:
        combined = " ".join(_text_value(value, "").lower() for value in values)
        return any(token in combined for token in ("warehouse", "stock", "all goods", "storage"))

    def append_item(item: _Evidence, warehouse: bool) -> None:
        key = (item.path or "", item.title + "|" + item.caption)
        if key in seen:
            return
        seen.add(key)
        (warehouses if warehouse else evidence).append(item)

    def order_value(item: Mapping[str, Any]) -> float:
        try:
            return float(_first(item, "slot_order", "order", "sort_order", default=9999))
        except (TypeError, ValueError):
            return 9999

    raw_slots = sorted(
        [_mapping(slot) for slot in _list(data.get("photo_slots"))],
        key=lambda slot: (order_value(slot), _text_value(_first(slot, "name", "label", default=""))),
    )
    for slot in raw_slots:
        category = _text_value(_first(slot, "category", "section", default=""), "")
        slot_name = _english_text(
            _first(slot, "label", "name", "slot_name", default="Photo evidence"),
            _photo_label_fallback(category),
        )
        required = bool(_first(slot, "required", "is_required", default=False))
        raw_photos = _list(slot.get("photos"))
        if not raw_photos and _first(slot, "file_path", "path", "analysis_path"):
            raw_photos = [slot]
        warehouse = is_warehouse(slot_name, category)
        if not raw_photos and required:
            append_item(_Evidence(slot_name, "Required photo not supplied", None, True, category=category), warehouse)
        for index, raw_photo in enumerate(raw_photos, start=1):
            photo = _mapping(raw_photo)
            title = slot_name if len(raw_photos) == 1 else f"{slot_name} {index}"
            caption = _english_text(
                _first(photo, "caption", "description", default=slot.get("instruction") or slot_name),
                slot_name,
            )
            sample_id = _text_value(_first(photo, "sample_id", "sample_no", default=""), "")
            path = _first(photo, "file_path", "path", "analysis_path", "original_path")
            append_item(_Evidence(title, caption, str(path) if path else None, required, sample_id, category), warehouse or is_warehouse(_first(photo, "category", "section")))

    flat_photos = sorted(
        [_mapping(photo) for photo in _list(data.get("photos"))],
        key=lambda photo: (order_value(photo), _text_value(_first(photo, "slot_name", "category", default=""))),
    )
    for photo in flat_photos:
        category = _text_value(_first(photo, "category", "section", default=""), "")
        title = _english_text(
            _first(photo, "slot_label", "slot_name", "category", default="Photo evidence"),
            _photo_label_fallback(category),
        )
        caption = _english_text(_first(photo, "caption", "description", default=title), title)
        path = _first(photo, "file_path", "path", "analysis_path", "original_path")
        item = _Evidence(
            title=title,
            caption=caption,
            path=str(path) if path else None,
            required=bool(_first(photo, "required", "is_required", default=False)),
            sample_id=_text_value(_first(photo, "sample_id", "sample_no", default=""), ""),
            category=category,
        )
        append_item(item, is_warehouse(title, category))

    if not raw_slots and len(evidence) < 8:
        defaults = [
            "Product overview",
            "Product details",
            "Marking and date code",
            "Barcode",
            "Individual packaging",
            "Master carton",
            "Carton markings",
            "Defect evidence",
        ]
        used = {item.title.lower() for item in evidence}
        for label in defaults:
            if len(evidence) >= 8:
                break
            if label.lower() not in used:
                evidence.append(_Evidence(label, "No photo supplied", None, False))

    if len(warehouses) > 4:
        evidence.extend(warehouses[4:])
        warehouses = warehouses[:4]
    return evidence, warehouses


def _product_and_packing(data: Mapping[str, Any]) -> tuple[Mapping[str, Any], Mapping[str, Any]]:
    return _mapping(data.get("product")), _mapping(data.get("packing"))


def _packaging_items(product: Mapping[str, Any], packing: Mapping[str, Any]) -> list[tuple[str, str]]:
    raw = _first(packing, "individual_packaging", "packaging_requirements", default=product.get("individual_packaging"))
    if isinstance(raw, Mapping):
        return [(_english_text(key, "Requirement"), _text_value(value)) for key, value in raw.items()]
    if isinstance(raw, (list, tuple)):
        items: list[tuple[str, str]] = []
        for entry in raw:
            if isinstance(entry, Mapping):
                items.append((_english_text(_first(entry, "name", "label", default="Requirement"), "Requirement"), _text_value(_first(entry, "value", "required", default=""))))
            else:
                items.append((_english_text(entry, "Requirement"), "YES"))
        return items
    if raw not in (None, ""):
        rendered = _text_value(raw, "").replace("；", ";")
        parsed: list[tuple[str, str]] = []
        for segment in re.split(r"[;\r\n]+", rendered):
            segment = segment.strip()
            if not segment:
                continue
            match = re.match(r"^(.+?)\s*(?:=|:)\s*(.+)$", segment)
            if not match:
                continue
            label = _english_text(match.group(1), "Requirement")
            value = match.group(2).strip()
            normalized = value.upper()
            if normalized in {"Y", "YES", "TRUE", "REQUIRED"}:
                value = "YES"
            elif normalized in {"N", "NO", "FALSE", "NOT REQUIRED"}:
                value = "NO"
            parsed.append((label, value))
        return parsed or [("Requirement", rendered)]
    return []


# ---------------------------------------------------------------------------
# TigerHead classic layout
# ---------------------------------------------------------------------------


def _bundled_logo() -> str | None:
    candidate = Path(__file__).resolve().parent / "assets" / "tigerhead_logo.png"
    return str(candidate) if candidate.is_file() else None


def _th_header(c: canvas.Canvas, data: Mapping[str, Any]) -> float:
    """Company logo (left) + address block (right). Returns content top y."""
    top = PAGE_H - 22
    logo = _first(data, "logo_path", "logo") or _bundled_logo()
    if logo and Path(str(logo)).is_file():
        _draw_image_contain(c, logo, MARGIN, top - 50, 105, 50)
    company = _text_value(_first(data, "header_company", default=HEADER_COMPANY))
    address = data.get("company_address") or HEADER_ADDRESS
    if isinstance(address, str):
        address = [line.strip() for line in address.splitlines() if line.strip()]
    lines = [company, *[_text_value(line, "") for line in address]]
    y = top - 8
    for index, line in enumerate(lines):
        bold = index == 0
        c.setFont(_font(line, bold), 8.5 if bold else 8)
        c.setFillColor(colors.black)
        c.drawRightString(PAGE_W - MARGIN, y, line)
        y -= 11
    return PAGE_H - 84


def _th_footer(c: canvas.Canvas, data: Mapping[str, Any], page: int, total: int) -> None:
    c.setStrokeColor(LINE)
    c.line(MARGIN, 32, PAGE_W - MARGIN, 32)
    _draw_text(c, MARGIN, 20, f"{_text_value(data.get('report_no'), 'DRAFT')} | Rev.{_text_value(data.get('revision'), '0')}", size=7, width=CONTENT_W - 90)
    c.setFont("Helvetica", 7)
    c.drawRightString(PAGE_W - MARGIN, 20, f"Page {page} of {total}")


def _band(c: canvas.Canvas, y: float, title: str, *, x: float = MARGIN, w: float = CONTENT_W, h: float = 17, size: float = 9) -> float:
    c.setFillColor(BAND_BG)
    c.setStrokeColor(TH_BORDER)
    c.setLineWidth(0.8)
    c.rect(x, y - h, w, h, fill=1, stroke=1)
    _draw_text(c, x + 6, y - h + 5, title, size=size, bold=True, color=colors.black, width=w - 12)
    return y - h


def _cell(
    c: canvas.Canvas,
    x: float,
    row_top: float,
    w: float,
    h: float,
    text: Any,
    *,
    size: float = 9,
    bold: bool = False,
    color: colors.Color = colors.black,
    align: str = "left",
    max_lines: int = 2,
    pad: float = 6,
    border: bool = True,
) -> None:
    if border:
        c.setFillColor(WHITE)
        c.setStrokeColor(TH_BORDER)
        c.setLineWidth(0.8)
        c.rect(x, row_top - h, w, h, fill=0, stroke=1)
    lines = _fit_lines(text, w - pad * 2, size, max_lines, bold) if text not in (None, "") else []
    if not lines:
        return
    leading = size * 1.22
    block_h = len(lines) * leading
    start_y = row_top - (h - block_h) / 2 - size * 0.82
    for index, line in enumerate(lines):
        font_name = _font(line, bold)
        c.setFont(font_name, size)
        c.setFillColor(color)
        line_y = start_y - index * leading
        if align == "center":
            c.drawCentredString(x + w / 2, line_y, line)
        elif align == "right":
            c.drawRightString(x + w - pad, line_y, line)
        else:
            c.drawString(x + pad, line_y, line)


def _checkbox(c: canvas.Canvas, x: float, y_center: float, checked: bool, s: float = 9) -> None:
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.9)
    c.rect(x, y_center - s / 2, s, s, fill=0, stroke=1)
    if checked:
        c.setLineWidth(1.1)
        c.line(x + 1, y_center - s / 2 + 1, x + s - 1, y_center + s / 2 - 1)
        c.line(x + 1, y_center + s / 2 - 1, x + s - 1, y_center - s / 2 + 1)


def _kv_row(c: canvas.Canvas, y: float, pairs: Sequence[tuple[str, Any]], *, h: float = 22, col_w: float | None = None, size: float = 9) -> float:
    """One bordered row of 1 or 2 'Label: value' cells."""
    col_w = col_w or CONTENT_W / len(pairs)
    x = MARGIN
    for label, value in pairs:
        c.setStrokeColor(TH_BORDER)
        c.setLineWidth(0.8)
        c.rect(x, y - h, col_w, h, fill=0, stroke=1)
        text = f"{label} {_text_value(value, '')}".rstrip()
        _cell(c, x, y, col_w, h, text, size=size, bold=True, max_lines=2, border=False)
        x += col_w
    return y - h


def _spec_row(c: canvas.Canvas, y: float, label: str, value: Any, *, h: float = 20, label_w: float = 170) -> float:
    c.setStrokeColor(TH_BORDER)
    c.setLineWidth(0.8)
    c.rect(MARGIN, y - h, CONTENT_W, h, fill=0, stroke=1)
    c.line(MARGIN + label_w, y, MARGIN + label_w, y - h)
    _cell(c, MARGIN, y, label_w, h, label, size=8.8, bold=True, border=False)
    _cell(c, MARGIN + label_w, y, CONTENT_W - label_w, h, _text_value(value, ""), size=8.8, bold=True, max_lines=2, border=False)
    return y - h


def _result_options(c: canvas.Canvas, x: float, y_center: float, w: float, result: str) -> None:
    """Render 'PASS / ON HOLD / REJECT / AOD' with the active one highlighted."""
    options = ["PASS", "ON HOLD", "REJECT", "AOD"]
    size = 6.5
    segments: list[tuple[str, str, bool]] = []  # (text, kind, active)
    for index, option in enumerate(options):
        if index:
            segments.append((" / ", "sep", False))
        segments.append((option, "opt", option == result))
    total_w = sum(pdfmetrics.stringWidth(text, "Helvetica-Bold" if active else "Helvetica", size) for text, _kind, active in segments)
    cursor = x + (w - total_w) / 2
    for text, kind, active in segments:
        font_name = "Helvetica-Bold" if active else "Helvetica"
        c.setFont(font_name, size)
        c.setFillColor(TH_GREEN if active else TH_GREY)
        c.drawString(cursor, y_center, text)
        seg_w = pdfmetrics.stringWidth(text, font_name, size)
        if kind == "opt" and not active:
            c.setStrokeColor(TH_GREY)
            c.setLineWidth(0.6)
            c.line(cursor, y_center + 2, cursor + seg_w, y_center + 2)
        cursor += seg_w


def _num_text(value: Any) -> str:
    """Format AQL figures without a trailing '.0'."""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return _text_value(value, "")


def _draw_page_one(c: canvas.Canvas, data: Mapping[str, Any], total_pages: int, defect_rows: list[list[Any]], test_rows: list[list[Any]]) -> None:
    y = _th_header(c, data)
    overview = _mapping(data.get("overview"))
    product, packing = _product_and_packing(data)
    master = _mapping(_first(packing, "master_carton", default={}))
    result = _text_value(_first(data, "result", "status", default="")).upper()

    # Title
    title = "Pre-Shipment Inspection Report"
    c.setFont("Helvetica-Bold", 14.5)
    c.setFillColor(colors.black)
    title_w = pdfmetrics.stringWidth(title, "Helvetica-Bold", 14.5)
    title_y = y - 16
    c.drawCentredString(PAGE_W / 2, title_y, title)
    c.setLineWidth(1)
    c.line(PAGE_W / 2 - title_w / 2, title_y - 3, PAGE_W / 2 + title_w / 2, title_y - 3)
    y = title_y - 12

    # Info table: label | value | Result (rowspan 5)
    label_w, result_w = 128, 106
    value_w = CONTENT_W - label_w - result_w
    row_h = 21
    table_top = y
    info_rows = [
        ("Factory Name", _first(overview, "factory", "factory_name", default=_first(data, "factory"))),
        ("Customer Name", _first(overview, "customer", "customer_name", default=_first(product, "customer", "customer_name"))),
        ("Country", _first(overview, "country", default=_first(product, "country"))),
        ("Inspection Date", _first(data, "inspection_date", default=_first(overview, "inspection_date"))),
    ]
    for row_index, (label, value) in enumerate(info_rows):
        row_top = table_top - row_index * row_h
        c.setStrokeColor(TH_BORDER)
        c.setLineWidth(0.8)
        c.rect(MARGIN, row_top - row_h, label_w, row_h, fill=0, stroke=1)
        c.rect(MARGIN + label_w, row_top - row_h, value_w, row_h, fill=0, stroke=1)
        _cell(c, MARGIN, row_top, label_w, row_h, label, size=9, bold=True, align="center", border=False)
        _cell(c, MARGIN + label_w, row_top, value_w, row_h, _text_value(value, ""), size=9.5, bold=True, align="center", border=False)
    # Inspection Status row with checkboxes
    status_top = table_top - 4 * row_h
    c.rect(MARGIN, status_top - row_h, label_w, row_h, fill=0, stroke=1)
    c.rect(MARGIN + label_w, status_top - row_h, value_w, row_h, fill=0, stroke=1)
    _cell(c, MARGIN, status_top, label_w, row_h, "Inspection Status", size=9, bold=True, align="center", border=False)
    stage = _text_value(_first(overview, "inspection_stage", default=_first(data, "inspection_stage", default="")), "").lower()
    stage = re.sub(r"^final\s+", "", stage)
    cx = MARGIN + label_w + 12
    cy = status_top - row_h / 2
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(colors.black)
    c.drawString(cx, cy - 3.2, "Final 1st")
    cx += pdfmetrics.stringWidth("Final 1st", "Helvetica-Bold", 9) + 5
    _checkbox(c, cx, cy, stage in {"1", "1st", "first"})
    cx += 14
    c.drawString(cx, cy - 3.2, "2nd")
    cx += pdfmetrics.stringWidth("2nd", "Helvetica-Bold", 9) + 5
    _checkbox(c, cx, cy, stage in {"2", "2nd", "second"})
    cx += 14
    c.drawString(cx, cy - 3.2, "3rd")
    cx += pdfmetrics.stringWidth("3rd", "Helvetica-Bold", 9) + 5
    _checkbox(c, cx, cy, stage in {"3", "3rd", "third"})
    cx += 14
    c.drawString(cx, cy - 3.2, "/  In-line")
    cx += pdfmetrics.stringWidth("/  In-line", "Helvetica-Bold", 9) + 5
    _checkbox(c, cx, cy, stage in {"in-line", "inline", "in line"})
    # Result cell spanning all 5 rows
    result_x = MARGIN + label_w + value_w
    c.setStrokeColor(TH_BORDER)
    c.rect(result_x, table_top - 5 * row_h, result_w, 5 * row_h, fill=0, stroke=1)
    _cell(c, result_x, table_top, result_w, 18, "Result", size=9.5, bold=True, align="center", border=False)
    _result_options(c, result_x, table_top - 32, result_w, result)
    if result:
        result_color, _ = _status_style(result)
        _cell(c, result_x, table_top - 38, result_w, 62, result, size=13, bold=True, color=result_color, align="center", border=False)
    y = table_top - 5 * row_h - 12

    # GENERAL INFORMATION
    y = _band(c, y, "GENERAL INFORMATION")
    po_qty = _first(overview, "order_qty", "order_quantity", "po_quantity", "quantity", default=_first(product, "order_qty", "po_quantity"))
    carton_count = _first(master, "carton_count", default=_first(packing, "carton_count"))
    completed = _first(product, "qty_completed", "completed_qty", "completed_pct", default=_first(overview, "completed_pct", "completion"))
    completed_txt = _percentage_value(completed) if completed not in (None, "") else ""
    sample_size = _first(overview, "sample_size", default=_first(data, "sample_size"))
    inspected_qty = _first(overview, "inspected_qty", "inspected_quantity", default=_first(data, "inspected_qty", "inspected_quantity"))
    half = CONTENT_W / 2
    y = _kv_row(c, y, [("P.O. No.:", _first(overview, "po_no", "po_number", default=_first(product, "po_no"))), ("P.O. Qty:", f"{_text_value(po_qty, '')} PCS" if po_qty not in (None, "") else "")], h=21)
    y = _kv_row(c, y, [("Item No.:", _first(overview, "item_no", "sku", "product_no", default=_first(product, "item_no"))), ("Item Description:", _first(product, "description", "product_description", default=_first(overview, "description")))], h=21)
    y = _kv_row(c, y, [("Batch code (Date Code):", _first(product, "date_code", "batch_code")), ("No. of Carton:", f"{_text_value(carton_count, '')} ctn" if carton_count not in (None, "") else "")], h=21)
    y = _kv_row(c, y, [("Age Grade:", _first(product, "age_grade")), ("Qty Completed:", completed_txt)], h=21)
    y = _kv_row(c, y, [("Samples Size:", f"{_text_value(sample_size, '')}PCS" if sample_size not in (None, "") else ""), ("Inspected Qty :", f"{_text_value(inspected_qty, '')}pcs" if inspected_qty not in (None, "") else "")], h=21)
    # Signed sample row with checkboxes
    signed = _text_value(_first(product, "signed_sample", "signed_sample_available", default=""), "").lower()
    row_top = y
    c.setStrokeColor(TH_BORDER)
    c.rect(MARGIN, row_top - 21, half, 21, fill=0, stroke=1)
    c.rect(MARGIN + half, row_top - 21, half, 21, fill=0, stroke=1)
    sx = MARGIN + 6
    sy = row_top - 21 / 2
    c.setFont("Helvetica-Bold", 9)
    c.setFillColor(colors.black)
    c.drawString(sx, sy - 3.2, "Signed Sample available :  Yes (")
    sx += pdfmetrics.stringWidth("Signed Sample available :  Yes (", "Helvetica-Bold", 9) + 3
    _checkbox(c, sx, sy, signed in {"yes", "y", "true", "1"})
    sx += 13
    c.drawString(sx, sy - 3.2, ")   No (")
    sx += pdfmetrics.stringWidth(")   No (", "Helvetica-Bold", 9) + 3
    _checkbox(c, sx, sy, signed in {"no", "n", "false", "0"})
    c.drawString(sx + 13, sy - 3.2, ")")
    _cell(c, MARGIN + half, row_top, half, 21, f"Country of Origin : {_text_value(_first(product, 'origin', 'country_of_origin'), '')}".rstrip(), size=9, bold=True, border=False)
    y = row_top - 21 - 12

    # AQL table + Product photo
    aql_rows = _normalize_aql(data)
    aql_w = 300
    photo_w = CONTENT_W - aql_w - 10
    std = _text_value(_first(overview, "inspection_std", default="ANSI/ASQ Z1.4"))
    level = _text_value(_first(overview, "inspection_level", default="Level II"), "")
    if level and not level.lower().startswith("level"):
        level = f"Level {level}"
    header_h, class_h = 32, 24
    aql_top = y
    col_ws = [86, 54, 54, 54, 52]
    x = MARGIN
    headers = [f"Inspection Std\n{std}", f"AQL\n{level}", "Accept", "Reject", "Total"]
    for col_w, header in zip(col_ws, headers):
        c.setStrokeColor(TH_BORDER)
        c.rect(x, aql_top - header_h, col_w, header_h, fill=0, stroke=1)
        _cell(c, x, aql_top, col_w, header_h, header.replace("\n", " ") if "\n" not in header else None, size=8, bold=True, align="center", border=False)
        # two-line header
        parts = header.split("\n")
        if len(parts) == 2:
            _cell(c, x, aql_top, col_w, header_h / 2 + 4, parts[0], size=8, bold=True, align="center", border=False)
            _cell(c, x, aql_top - header_h / 2 + 4, col_w, header_h / 2 - 4, parts[1], size=7.5, bold=True, align="center", border=False)
        x += col_w
    for row_index, row in enumerate(aql_rows):
        row_top = aql_top - header_h - row_index * class_h
        values = [row[0], _num_text(row[1]), _num_text(row[2]), _num_text(row[3]), _num_text(row[4])]
        x = MARGIN
        for col_w, value in zip(col_ws, values):
            c.setStrokeColor(TH_BORDER)
            c.rect(x, row_top - class_h, col_w, class_h, fill=0, stroke=1)
            _cell(c, x, row_top, col_w, class_h, value, size=9, bold=(col_w == col_ws[0]), align="center" if col_w != col_ws[0] else "left", border=False)
            x += col_w
    # Product photo box
    photo_x = MARGIN + aql_w + 10
    photo_h = header_h + 3 * class_h
    c.setStrokeColor(TH_BORDER)
    c.rect(photo_x, aql_top - photo_h, photo_w, photo_h, fill=0, stroke=1)
    _cell(c, photo_x, aql_top, photo_w, 16, "Product Photo", size=8.5, bold=False, align="center", border=False)
    product_photo = _first(data, "product_photo", "product_photo_path")
    evidence_for_photo, _wh = _normalize_photos(data)
    if not product_photo:
        for item in evidence_for_photo:
            if item.path and item.category in {"product", ""}:
                product_photo = item.path
                break
    if not product_photo:
        for item in evidence_for_photo:
            if item.path:
                product_photo = item.path
                break
    _draw_image_contain(c, product_photo, photo_x + 4, aql_top - photo_h + 4, photo_w - 8, photo_h - 24)
    y = aql_top - photo_h - 12

    # Defects (left) + Product Performance & Reliability (right)
    left_w = 262
    gap = 8
    right_w = CONTENT_W - left_w - gap
    bottom_limit = 42

    # Defect table header (two rows)
    cr_w, maj_w, min_w = 34, 34, 34
    desc_w = left_w - cr_w - maj_w - min_w
    x = MARGIN
    c.setStrokeColor(TH_BORDER)
    c.rect(x, y - 16, cr_w + maj_w + min_w, 16, fill=0, stroke=1)
    c.rect(x + cr_w + maj_w + min_w, y - 32, desc_w, 32, fill=0, stroke=1)
    _cell(c, x, y, cr_w + maj_w + min_w, 16, "Defective", size=8.5, bold=True, align="center", border=False)
    _cell(c, x + cr_w + maj_w + min_w, y, desc_w, 32, "Description of Defect", size=8.5, bold=True, align="center", border=False)
    for label, w in (("CR", cr_w), ("Maj", maj_w), ("Min", min_w)):
        c.rect(x, y - 32, w, 16, fill=0, stroke=1)
        _cell(c, x, y - 16, w, 16, label, size=8.5, bold=True, align="center", border=False)
        x += w
    defect_row_h = 17
    max_defect_rows = max(1, int((y - 32 - bottom_limit) / defect_row_h) )
    max_defect_rows = min(max_defect_rows, 12)
    for row_index, row in enumerate(defect_rows[:max_defect_rows]):
        row_top = y - 32 - row_index * defect_row_h
        values = [row[0], row[1], row[2], row[3]]
        x = MARGIN
        for w, value in zip((cr_w, maj_w, min_w, desc_w), values):
            c.setStrokeColor(TH_BORDER)
            c.rect(x, row_top - defect_row_h, w, defect_row_h, fill=0, stroke=1)
            _cell(c, x, row_top, w, defect_row_h, _text_value(value, ""), size=8, bold=False, align="center" if w != desc_w else "left", max_lines=1, border=False)
            x += w

    # Test table
    tx = MARGIN + left_w + gap
    c.setStrokeColor(TH_BORDER)
    c.rect(tx, y - 16, right_w, 16, fill=0, stroke=1)
    _cell(c, tx, y, right_w, 16, "Product Performance & Reliability", size=8.5, bold=True, align="center", border=False)
    name_w = right_w * 0.46
    std_w = right_w * 0.32
    res_w = right_w - name_w - std_w
    x = tx
    for label, w in (("Abuse Test", name_w), ("Standard", std_w), ("Result", res_w)):
        c.rect(x, y - 32, w, 16, fill=0, stroke=1)
        _cell(c, x, y - 16, w, 16, label, size=8.5, bold=True, align="center", border=False)
        x += w
    test_row_h = 17
    max_test_rows = min(12, max(1, int((y - 32 - bottom_limit) / test_row_h)))
    for row_index, row in enumerate(test_rows[:max_test_rows]):
        row_top = y - 32 - row_index * test_row_h
        values = [_text_value(row[0], ""), _text_value(row[1], ""), _text_value(row[2], "")]
        x = tx
        for col_index, (w, value) in enumerate(zip((name_w, std_w, res_w), values)):
            c.setStrokeColor(TH_BORDER)
            c.rect(x, row_top - test_row_h, w, test_row_h, fill=0, stroke=1)
            is_result = col_index == 2
            color = _status_style(value.upper())[0] if is_result and value.upper() in {"PASS", "REJECT"} else colors.black
            _cell(c, x, row_top, w, test_row_h, value, size=8, bold=is_result, color=color, align="center" if col_index else "left", max_lines=1, border=False)
            x += w


def _draw_continuation_page(
    c: canvas.Canvas,
    data: Mapping[str, Any],
    page_no: int,
    total_pages: int,
    defects: list[list[Any]],
    tests: list[list[Any]],
) -> None:
    y = _th_header(c, data)
    y = _band(c, y, "INSPECTION DETAILS (CONTINUED)")
    left_w = 262
    gap = 8
    right_w = CONTENT_W - left_w - gap
    cr_w, maj_w, min_w = 34, 34, 34
    desc_w = left_w - cr_w - maj_w - min_w
    row_h = 17
    # defects
    x = MARGIN
    c.setStrokeColor(TH_BORDER)
    c.rect(x, y - 16, cr_w + maj_w + min_w, 16, fill=0, stroke=1)
    c.rect(x + cr_w + maj_w + min_w, y - 32, desc_w, 32, fill=0, stroke=1)
    _cell(c, x, y, cr_w + maj_w + min_w, 16, "Defective", size=8.5, bold=True, align="center", border=False)
    _cell(c, x + cr_w + maj_w + min_w, y, desc_w, 32, "Description of Defect", size=8.5, bold=True, align="center", border=False)
    for label, w in (("CR", cr_w), ("Maj", maj_w), ("Min", min_w)):
        c.rect(x, y - 32, w, 16, fill=0, stroke=1)
        _cell(c, x, y - 16, w, 16, label, size=8.5, bold=True, align="center", border=False)
        x += w
    for row_index, row in enumerate(defects[:38]):
        row_top = y - 32 - row_index * row_h
        x = MARGIN
        for w, value in zip((cr_w, maj_w, min_w, desc_w), row):
            c.setStrokeColor(TH_BORDER)
            c.rect(x, row_top - row_h, w, row_h, fill=0, stroke=1)
            _cell(c, x, row_top, w, row_h, _text_value(value, ""), size=8, align="center" if w != desc_w else "left", max_lines=1, border=False)
            x += w
    # tests
    tx = MARGIN + left_w + gap
    c.setStrokeColor(TH_BORDER)
    c.rect(tx, y - 16, right_w, 16, fill=0, stroke=1)
    _cell(c, tx, y, right_w, 16, "Product Performance & Reliability", size=8.5, bold=True, align="center", border=False)
    name_w = right_w * 0.46
    std_w = right_w * 0.32
    res_w = right_w - name_w - std_w
    x = tx
    for label, w in (("Abuse Test", name_w), ("Standard", std_w), ("Result", res_w)):
        c.rect(x, y - 32, w, 16, fill=0, stroke=1)
        _cell(c, x, y - 16, w, 16, label, size=8.5, bold=True, align="center", border=False)
        x += w
    for row_index, row in enumerate(tests[:38]):
        row_top = y - 32 - row_index * row_h
        x = tx
        for col_index, (w, value) in enumerate(zip((name_w, std_w, res_w), [_text_value(row[0], ""), _text_value(row[1], ""), _text_value(row[2], "")])):
            c.setStrokeColor(TH_BORDER)
            c.rect(x, row_top - row_h, w, row_h, fill=0, stroke=1)
            is_result = col_index == 2
            color = _status_style(value.upper())[0] if is_result and value.upper() in {"PASS", "REJECT"} else colors.black
            _cell(c, x, row_top, w, row_h, value, size=8, bold=is_result, color=color, align="center" if col_index else "left", max_lines=1, border=False)
            x += w


_FIXED_PACKAGING_LABELS = [
    "Open Box", "Closed Box", "Window Box",
    "Mailer", "Bulk", "Header",
    "PolyBag", "Hang Tag", "Sewn-in label",
    "Blister Tray/ Card", "Instruction Sheet", "Warning label",
    "Customer label", "Price Label / tag", "CE Marks",
    "Green Dot", "Name & Address", "WEEE",
]


def _label_key(label: str) -> str:
    return re.sub(r"[^a-z0-9]", "", label.lower())


def _draw_page_two(c: canvas.Canvas, data: Mapping[str, Any], total_pages: int, detail_notes: Sequence[str] = ()) -> list[str]:
    y = _th_header(c, data)
    product, packing = _product_and_packing(data)
    master = _mapping(_first(packing, "master_carton", default={}))
    inner = _first(packing, "inner_carton", "inner_carton_details", default={})
    inner_map = _mapping(inner)

    y = _band(c, y, "PRODUCT SPECIFICATION")
    y = _spec_row(c, y, "Product Size (mm)", _first(product, "size_mm", "product_size", "dimensions"))
    nw = _text_value(_first(product, "net_weight_kg", "nw"), "")
    gw = _text_value(_first(product, "gross_weight_kg", "gw"), "")
    weight = _weights(nw, gw)
    y = _spec_row(c, y, "Product Weight (kg)", weight)
    y = _spec_row(c, y, "Date Code", _first(product, "date_code", "batch_code"))
    y = _spec_row(c, y, "UPC / EAN barcode", _first(product, "barcode", "upc", "ean"))
    y = _spec_row(c, y, "Assortment Ratio", _first(product, "assortment_ratio", default=_first(packing, "assortment_ratio")))
    y -= 10

    y = _band(c, y, "Individual Packaging", h=15, size=8.5)
    provided = {_label_key(label): value for label, value in _packaging_items(product, packing)}
    packaging_rows: list[tuple[str, str]] = []
    used_keys: set[str] = set()
    for label in _FIXED_PACKAGING_LABELS:
        key = _label_key(label)
        value = provided.get(key, "")
        if value:
            used_keys.add(key)
        packaging_rows.append((label, value))
    col_w = CONTENT_W / 3
    value_w = 42
    row_h = 19
    for row_index in range(ceil(len(packaging_rows) / 3)):
        row_top = y - row_index * row_h
        for col in range(3):
            index = row_index * 3 + col
            x = MARGIN + col * col_w
            c.setStrokeColor(TH_BORDER)
            c.setLineWidth(0.8)
            c.rect(x, row_top - row_h, col_w, row_h, fill=0, stroke=1)
            if index < len(packaging_rows):
                label, value = packaging_rows[index]
                c.line(x + col_w - value_w, row_top, x + col_w - value_w, row_top - row_h)
                _cell(c, x, row_top, col_w - value_w, row_h, label, size=8, bold=True, max_lines=1, border=False)
                _cell(c, x + col_w - value_w, row_top, value_w, row_h, value, size=8, bold=True, align="center", max_lines=1, border=False)
    y -= ceil(len(packaging_rows) / 3) * row_h + 10

    y = _band(c, y, "PACKING")
    y = _band(c, y, "MASTER CARTON", h=15, size=8.5)
    master_rows = [
        ("Dimension", _first(master, "dimension", "dimensions", default=_first(packing, "master_carton_dimension"))),
        ("Carton Weight (kg)", _weights(
            _text_value(_first(master, "net_weight_kg", "net_weight", "nw", default=_first(packing, "master_carton_nw")), ""),
            _text_value(_first(master, "gross_weight_kg", "gross_weight", "gw", default=_first(packing, "master_carton_gw")), ""),
        )),
        ("Outer Carton barcode", _first(master, "barcode", "outer_carton_barcode", default=_first(packing, "outer_carton_barcode"))),
        ("Case Pack", _first(master, "case_pack", default=_first(packing, "case_pack"))),
        ("Assortment Ratio", _first(master, "assortment_ratio", default=_first(packing, "assortment_ratio"))),
        ("Date Code", _first(master, "date_code", default=_first(product, "date_code"))),
    ]
    for label, value in master_rows:
        y = _spec_row(c, y, label, _text_value(value, ""), h=18)
    y = _band(c, y, "INNER CARTON", h=15, size=8.5)
    inner_rows = [
        ("Dimension", _first(inner_map, "dimension", "dimensions")),
        ("Carton Weight (kg)", _weights(
            _text_value(_first(inner_map, "net_weight_kg", "net_weight", "nw"), ""),
            _text_value(_first(inner_map, "gross_weight_kg", "gross_weight", "gw"), ""),
        )),
        ("Outer Carton barcode", _first(inner_map, "barcode")),
        ("Case Pack", _first(inner_map, "case_pack")),
        ("Assortment Ratio", _first(inner_map, "assortment_ratio")),
        ("Date Code", _first(inner_map, "date_code")),
    ]
    for label, value in inner_rows:
        y = _spec_row(c, y, label, _text_value(value, ""), h=18)
    if isinstance(inner, str) and inner.strip():
        y = _spec_row(c, y, "Details", inner.strip(), h=18)
    y -= 10

    remarks = _first(data, "remarks", default="")
    if isinstance(remarks, Mapping):
        lines = [f"{_text_value(key)}: {_text_value(value)}" for key, value in remarks.items()]
    elif isinstance(remarks, (list, tuple)):
        lines = [_text_value(item, "") for item in remarks]
    else:
        lines = [line.strip() for line in _text_value(remarks, "").splitlines() if line.strip()]
    reason = _text_value(data.get("result_reason"), "")
    if reason:
        lines.insert(0, f"Result reason: {reason}")
    fixed_keys = {_label_key(label) for label in _FIXED_PACKAGING_LABELS}
    lines.extend(f"Packaging - {label}: {value}" for label, value in _packaging_items(product, packing) if _label_key(label) not in fixed_keys)
    lines.extend(detail_notes)
    wrapped_lines = [wrapped for line in lines for wrapped in _wrap(line, CONTENT_W - 12, 8.5)]
    if lines:
        y = _band(c, y, "REMARKS:")
        for index, wrapped in enumerate(wrapped_lines):
            if y - 10 < 46:
                return wrapped_lines[index:]
            _draw_text(c, MARGIN + 6, y - 10, wrapped, size=8.5, color=colors.black, width=CONTENT_W - 12)
            y -= 11
    return []


def _detail_notes(defects: Sequence[list[Any]], tests: Sequence[list[Any]], evidence: Sequence[_Evidence]) -> list[str]:
    """Preserve values shortened to fit the classic fixed-height tables/captions."""
    notes = []
    for index, row in enumerate(defects, 1):
        if len(_wrap(row[3], 148, 8)) > 1:
            notes.append(f"Defect {index}: {_text_value(row[3], '')}")
    for index, row in enumerate(tests, 1):
        if any(len(_wrap(value, width, 8)) > 1 for value, width in zip(row, (95, 62, 27))):
            notes.append(f"Test {index}: " + " | ".join(_text_value(value, "") for value in row))
    for item in evidence:
        caption = _evidence_caption(item)
        if len(_wrap(caption, (CONTENT_W - 10) / 2 - 12, 7)) > 2:
            notes.append(f"Photo - {item.title}: {caption}")
    return [line for note in notes for line in _wrap(note, CONTENT_W - 12, 8.5)]


def _draw_notes_page(c: canvas.Canvas, data: Mapping[str, Any], lines: Sequence[str]) -> None:
    y = _band(c, _th_header(c, data), "INSPECTION NOTES (CONTINUED)") - 12
    for line in lines:
        _draw_text(c, MARGIN + 6, y, line, size=8.5, color=colors.black)
        y -= 11


# ---------------------------------------------------------------------------
# Fixed photo template (matches the classic report photo pages)
# ---------------------------------------------------------------------------

_PHOTO_LABEL_H = 15
_PHOTO_IMG_H = 135
_PHOTO_CELL_H = _PHOTO_LABEL_H + _PHOTO_IMG_H  # 150
_PHOTO_ROW_STEP = _PHOTO_CELL_H + 8

# Fixed slot layout. Each row holds 1~2 cells: (label, keywords, negatives).
_FIXED_PHOTO_PAGES: list[list[list[tuple[str, tuple[str, ...], tuple[str, ...]]]]] = [
    [
        [("Components Photo", ("component",), ())],
        [("Product / TSD Marking on Product", ("marking", "tsd"), ()), ("Date Code on Product", ("date code",), ("pack",))],
        [("Packaging Photo  Front Side View", ("front",), ("mark",)), ("Packaging Photo  Rear side View", ("rear",), ())],
        [("Left Side View", ("left",), ()), ("Right Side View", ("right",), ())],
    ],
    [
        [("Top Side View", ("top side", "top view"), ()), ("Bottom Side View", ("bottom side", "bottom view", "buttom side"), ())],
        [("Barcode reading", ("barcode",), ()), ("Menu book", ("menu", "book", "instruction"), ())],
        [("Date Code on Packing", ("date code",), ())],
        [("Voltage of battery", ("voltage", "battery"), ()), ("Label", ("label",), ())],
    ],
]

_CARTON_ROWS = [
    [("Front Mark photo", ("front mark", "frontmark"), ()), ("Side Mark Photo", ("side mark", "sidemark"), ())],
    [("Top and Buttom photo", ("top and", "top &", "top/buttom", "top/bottom"), ()), ("Open the master carton", ("open",), ())],
]


def _photo_text(item: _Evidence) -> str:
    return f"{item.title} {item.caption} {item.category}".lower()


def _pop_match(pool: list[_Evidence], keywords: tuple[str, ...], negatives: tuple[str, ...] = ()) -> _Evidence | None:
    for index, item in enumerate(pool):
        text = _photo_text(item)
        if any(neg in text for neg in negatives):
            continue
        if any(keyword in text for keyword in keywords):
            return pool.pop(index)
    return None


def _pop_all_defects(pool: list[_Evidence]) -> list[_Evidence]:
    defects = [item for item in pool if "defect" in _photo_text(item)]
    for item in defects:
        pool.remove(item)
    return defects


def _build_photo_pages(evidence: Sequence[_Evidence]) -> list[list[tuple[str, Any]]]:
    """Render every fixed photo slot (empty box when no photo) and never drop photos."""
    pool = [item for item in evidence if item.path or item.required]
    pages: list[list[tuple[str, Any]]] = []
    for fixed_page in _FIXED_PHOTO_PAGES:
        elements: list[tuple[str, Any]] = []
        for row in fixed_page:
            cells = [(label, _pop_match(pool, keywords, negatives)) for label, keywords, negatives in row]
            elements.append(("row", cells))
        pages.append(elements)

    defects = _pop_all_defects(pool)
    defect_rows = [defects[index : index + 2] for index in range(0, len(defects), 2)]
    page_c: list[tuple[str, Any]] = [("band", "DEFECT PHOTO")]
    page_c_defects = defect_rows[:2]
    extra_defects = defect_rows[2:]
    if page_c_defects:
        for row in page_c_defects:
            page_c.append(("defect_row", row))
    else:
        page_c.append(("defect_row", [None]))
    page_c.append(("band", "CARTON PACK"))
    for row in _CARTON_ROWS:
        cells = [(label, _pop_match(pool, keywords, negatives)) for label, keywords, negatives in row]
        page_c.append(("row", cells))
    pages.append(page_c)

    overflow: list[tuple[str, Any]] = []
    if extra_defects:
        overflow.append(("band", "DEFECT PHOTO (CONTINUED)"))
        for row in extra_defects:
            overflow.append(("defect_row", row))
    while pool:
        pair = [pool.pop(0) for _ in range(min(2, len(pool)))]
        overflow.append(("row", [(item.title or "Photo", item) for item in pair]))
    while overflow:
        page = overflow[:4]
        overflow = overflow[4:]
        pages.append(page)
    return pages


def _evidence_caption(item: _Evidence) -> str:
    caption = item.caption
    if item.sample_id:
        caption += f" | Sample: {item.sample_id}"
    return caption


def _photo_image(c: canvas.Canvas, item: _Evidence, x: float, bottom: float, w: float, h: float) -> None:
    _draw_image_contain(c, item.path, x + 2, bottom + 24, w - 4, h - 26)
    _draw_text(c, x + 6, bottom + 16, _evidence_caption(item), size=7, width=w - 12, max_lines=2, leading=8)


def _th_photo_cell(c: canvas.Canvas, x: float, top: float, w: float, label: str, item: _Evidence | None) -> None:
    c.setStrokeColor(TH_BORDER)
    c.setLineWidth(0.8)
    if label:
        c.rect(x, top - _PHOTO_LABEL_H, w, _PHOTO_LABEL_H, fill=0, stroke=1)
        _cell(c, x, top, w, _PHOTO_LABEL_H, label, size=8, bold=True, max_lines=1, border=False)
        img_top = top - _PHOTO_LABEL_H
        c.rect(x, img_top - _PHOTO_IMG_H, w, _PHOTO_IMG_H, fill=0, stroke=1)
        if item is not None:
            _photo_image(c, item, x, img_top - _PHOTO_IMG_H, w, _PHOTO_IMG_H)
    else:
        c.rect(x, top - _PHOTO_CELL_H, w, _PHOTO_CELL_H, fill=0, stroke=1)
        if item is not None:
            _photo_image(c, item, x, top - _PHOTO_CELL_H, w, _PHOTO_CELL_H)


def _draw_photo_page(c: canvas.Canvas, data: Mapping[str, Any], elements: Sequence[tuple[str, Any]], *, first: bool) -> None:
    y = _th_header(c, data)
    if first:
        y = _band(c, y, "PHOTOS")
        y -= 8
    gap = 10
    col_w = (CONTENT_W - gap) / 2
    for kind, payload in elements:
        if kind == "band":
            y = _band(c, y, _text_value(payload), h=16, size=8.5)
            y -= 6
        elif kind == "defect_row":
            for col in range(2):
                item = payload[col] if col < len(payload) else None
                x = MARGIN + col * (col_w + gap)
                c.setStrokeColor(TH_BORDER)
                c.setLineWidth(0.8)
                c.rect(x, y - _PHOTO_CELL_H, col_w, _PHOTO_CELL_H, fill=0, stroke=1)
                if item is not None:
                    _photo_image(c, item, x, y - _PHOTO_CELL_H, col_w, _PHOTO_CELL_H)
            y -= _PHOTO_ROW_STEP
        else:
            for col in range(2):
                label, item = payload[col] if col < len(payload) else ("", None)
                _th_photo_cell(c, MARGIN + col * (col_w + gap), y, col_w, label, item)
            y -= _PHOTO_ROW_STEP


def _draw_final_page(c: canvas.Canvas, data: Mapping[str, Any], warehouse: Sequence[_Evidence]) -> None:
    y = _th_header(c, data)
    y = _band(c, y, "PICTURES OF ALL GOODS STORE IN WAREHOUSE")
    y -= 8
    gap = 10
    col_w = (CONTENT_W - gap) / 2
    items = list(warehouse[:4])
    for index, item in enumerate(items):
        row, col = divmod(index, 2)
        x = MARGIN + col * (col_w + gap)
        top = y - row * _PHOTO_ROW_STEP
        c.setStrokeColor(TH_BORDER)
        c.setLineWidth(0.8)
        c.rect(x, top - _PHOTO_CELL_H, col_w, _PHOTO_CELL_H, fill=0, stroke=1)
        _photo_image(c, item, x, top - _PHOTO_CELL_H, col_w, _PHOTO_CELL_H)

    # Signature area
    inspector_value = data.get("inspector")
    inspector = _mapping(inspector_value)
    inspector_name = _text_value(_first(inspector, "name", "inspector_name", default=inspector_value if isinstance(inspector_value, str) else _first(data, "inspector_name")), "")
    signature = _first(inspector, "signature_path", "signature", default=_first(data, "signature_path"))
    line_y = 110
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.9)
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(colors.black)
    _draw_text(c, MARGIN, line_y, f"Inspected By: {inspector_name}", size=10, bold=True, width=210)
    c.line(MARGIN, line_y - 6, MARGIN + 200, line_y - 6)
    c.drawString(MARGIN + 240, line_y, "Supplier/ Factory Signature:")
    c.line(MARGIN + 240 + pdfmetrics.stringWidth("Supplier/ Factory Signature: ", "Helvetica-Bold", 10), line_y - 6, PAGE_W - MARGIN, line_y - 6)
    if signature:
        _draw_image_contain(c, signature, MARGIN + 30, line_y + 4, 150, 44)
    signed_at = _first(inspector, "signed_at")
    if signed_at:
        _draw_text(c, MARGIN, line_y - 20, f"Signed at: {_timestamp_value(signed_at)}", size=7, width=210)


def generate_unified_report_pdf(payload: Mapping[str, Any], destination: str | Path) -> Path:
    """Generate the TigerHead-format QC report and return its output path.

    ``payload`` must be a mapping of already-normalized application data.  The
    generator never calls a database or an AI service and never infers missing
    inspection facts.  ``photo_slots`` controls evidence ordering and supports
    multiple photos per slot; additional photos create overflow evidence pages.
    Confirmed defects should use ``qc_status``/``status`` values such as
    ``confirmed``, ``accepted``, or ``modified``.  Rejected, pending, and
    unreviewed findings are excluded from the formal defect table.
    """
    if not isinstance(payload, Mapping):
        raise TypeError("payload must be a mapping")
    output = Path(destination)
    output.parent.mkdir(parents=True, exist_ok=True)

    data = dict(payload)
    defect_rows = _defect_rows(_confirmed_defects(data))
    test_rows = _test_rows(data)
    evidence, warehouse = _normalize_photos(data)

    page_one_defects = defect_rows[:12]
    page_one_tests = test_rows[:12]
    extra_defects = defect_rows[12:]
    extra_tests = test_rows[12:]
    continuation_count = max(ceil(len(extra_defects) / 38), ceil(len(extra_tests) / 38)) if extra_defects or extra_tests else 0
    photo_pages = _build_photo_pages(evidence)
    # Measure the fixed form's remaining notes with the same renderer. No file
    # is emitted; this keeps pagination in sync with optional inner-carton rows.
    detail_notes = _detail_notes(defect_rows, test_rows, [*evidence, *warehouse])
    remaining_notes = _draw_page_two(canvas.Canvas(BytesIO(), pagesize=A4), data, 0, detail_notes)
    note_pages = [remaining_notes[index:index + 60] for index in range(0, len(remaining_notes), 60)]
    total_pages = 2 + continuation_count + len(note_pages) + len(photo_pages) + 1

    pdf = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    report_no = _text_value(_first(data, "report_no", default="DRAFT"))
    revision = _text_value(_first(data, "revision", default=0), "0")
    pdf.setTitle(f"{report_no} Rev.{revision} - Pre-Shipment Inspection Report")
    pdf.setAuthor(HEADER_COMPANY)
    pdf.setSubject("Pre-Shipment Inspection Report")

    _draw_page_one(pdf, data, total_pages, page_one_defects, page_one_tests)
    _th_footer(pdf, data, 1, total_pages)
    pdf.showPage()
    _draw_page_two(pdf, data, total_pages, detail_notes)
    _th_footer(pdf, data, 2, total_pages)
    pdf.showPage()

    for index in range(continuation_count):
        _draw_continuation_page(
            pdf,
            data,
            3 + index,
            total_pages,
            extra_defects[index * 38 : (index + 1) * 38],
            extra_tests[index * 38 : (index + 1) * 38],
        )
        _th_footer(pdf, data, 3 + index, total_pages)
        pdf.showPage()

    page_no = 3 + continuation_count
    for lines in note_pages:
        _draw_notes_page(pdf, data, lines)
        _th_footer(pdf, data, page_no, total_pages)
        pdf.showPage()
        page_no += 1
    for page_index, cells in enumerate(photo_pages):
        _draw_photo_page(pdf, data, cells, first=page_index == 0)
        _th_footer(pdf, data, page_no, total_pages)
        pdf.showPage()
        page_no += 1

    _draw_final_page(pdf, data, warehouse)
    _th_footer(pdf, data, page_no, total_pages)
    pdf.showPage()
    pdf.save()
    return output
