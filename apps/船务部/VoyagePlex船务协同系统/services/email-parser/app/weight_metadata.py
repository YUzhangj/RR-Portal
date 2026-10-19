"""Read only weight formula rules and number formats, without building styles/cells."""
import re
from xml.parsers import expat

from openpyxl.styles.numbers import builtin_format_code
from openpyxl.xml.constants import ARC_STYLE, SHEET_MAIN_NS

ERROR = "XLSX weight metadata is invalid or exceeds safe limits"
NS = SHEET_MAIN_NS + "}"


def _xml(archive, member, root, start, end=lambda *_: None, text=lambda *_: None):
    limit = 64 * 1024 * 1024
    stack = []
    nodes = 0

    def invalid(*_):
        raise ValueError(ERROR)

    def opened(tag, attrs):
        nonlocal nodes
        nodes += 1
        if nodes > 2000000 or len(stack) >= 64 or not stack and tag != NS + root:
            invalid()
        start(tag, attrs, stack)
        stack.append(tag)

    def closed(tag):
        end(tag, stack)
        if not stack or stack.pop() != tag:
            invalid()

    try:
        info = archive.getinfo(member)
        if not 0 < info.file_size <= limit or not 0 <= info.compress_size <= limit:
            invalid()
        parser = expat.ParserCreate(namespace_separator="}")
        parser.StartElementHandler, parser.EndElementHandler = opened, closed
        parser.CharacterDataHandler = lambda value: text(value, stack)
        parser.StartDoctypeDeclHandler = parser.EntityDeclHandler = parser.ExternalEntityRefHandler = invalid
        consumed = 0
        with archive.open(member) as stream:
            while True:
                chunk = stream.read(min(32768, limit - consumed + 1))
                consumed += len(chunk)
                if consumed > limit:
                    invalid()
                parser.Parse(chunk, not chunk)
                if not chunk:
                    break
        if stack or consumed != info.file_size:
            invalid()
    except MemoryError:
        raise
    except Exception:
        raise ValueError(ERROR) from None


def weight_metadata(wb, sheet, items, columns):
    wanted = {f"{column}{item['source_row']}": (item, key)
              for item in items for key, column in columns.items()}
    cells, shared = {}, {}
    current = None
    formula = None
    shared_id = None

    def start(tag, attrs, stack):
        nonlocal current, formula, shared_id
        if tag == NS + "c":
            if stack != [NS + "worksheet", NS + "sheetData", NS + "row"]:
                raise ValueError(ERROR)
            current = attrs.get("r")
            if current in wanted:
                style = int(attrs.get("s", "0"))
                if not 0 <= style < 1000000:
                    raise ValueError(ERROR)
                cells[current] = {"style": style, "truncate": False}
        elif tag == NS + "f":
            if stack != [NS + "worksheet", NS + "sheetData", NS + "row", NS + "c"]:
                raise ValueError(ERROR)
            shared_id = attrs.get("si") if attrs.get("t") == "shared" else None
            if shared_id is not None and len(shared_id) > 32:
                raise ValueError(ERROR)
            formula = "" if current in wanted or shared_id is not None else None

    def text(value, stack):
        nonlocal formula
        if formula is not None and stack[-1:] == [NS + "f"]:
            formula += value
            if len(formula) > 4096:
                raise ValueError(ERROR)

    def end(tag, stack):
        nonlocal current, formula, shared_id
        if tag == NS + "f" and formula is not None:
            truncated = bool(re.match(r'^\s*(?:INT\s*\(|IF\s*\(\s*OR\s*\([^)]*\)\s*,\s*""\s*,\s*INT\s*\()', formula, re.I))
            if shared_id is not None and formula:
                if len(shared) >= 10000 or len(shared_id) > 32:
                    raise ValueError(ERROR)
                shared[shared_id] = truncated
            if current in wanted:
                cells[current]["truncate"] = truncated
                if shared_id is not None:
                    cells[current]["shared"] = shared_id
            formula = None
            shared_id = None
        elif tag == NS + "c":
            current = None

    _xml(wb._archive, sheet._worksheet_path, "worksheet", start, end, text)
    requested = {cell["style"] for cell in cells.values()}
    formats = _formats(wb._archive, requested)
    for coordinate, (item, key) in wanted.items():
        cell = cells.get(coordinate, {"style": 0, "truncate": False})
        if "shared" in cell and cell["shared"] not in shared:
            raise ValueError(ERROR)
        truncated = shared[cell["shared"]] if "shared" in cell else cell["truncate"]
        item[key + "_rule"] = "Truncate" if truncated else "Exact"
        item[key + "_format"] = formats.get(cell["style"], "General")
    for item in items:
        item["weight_rule"] = item.get("gross_weight_rule", "Exact")


def _formats(archive, requested):
    try:
        archive.getinfo(ARC_STYLE)
    except KeyError:
        return {0: "General"}
    indices = {}
    index = 0

    def style(tag, attrs, stack):
        nonlocal index
        if tag == NS + "xf" and stack[-1:] == [NS + "cellXfs"]:
            if index in requested:
                indices[index] = int(attrs.get("numFmtId", "0"))
            index += 1
            if index > 1000000:
                raise ValueError(ERROR)

    _xml(archive, ARC_STYLE, "styleSheet", style)
    if not index:
        indices[0] = 0
    if requested - indices.keys():
        raise ValueError(ERROR)
    needed = set(indices.values())
    custom = {}

    def number(tag, attrs, stack):
        if tag == NS + "numFmt" and stack[-1:] == [NS + "numFmts"]:
            number_id = int(attrs["numFmtId"])
            if number_id in needed:
                code = attrs["formatCode"]
                if len(code) > 4096:
                    raise ValueError(ERROR)
                custom[number_id] = code

    _xml(archive, ARC_STYLE, "styleSheet", number)
    return {style_id: custom.get(number_id, builtin_format_code(number_id)) or "General"
            for style_id, number_id in indices.items()}
