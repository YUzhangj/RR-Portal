"""Xingxin warehouse truck recommendation; Yutai's per-truck maximum is 35 CBM; allocation requires human confirmation."""
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re

VOLUME_BANDS = json.loads(Path(__file__).with_name("truck-rules.json").read_text())["volumeBands"]


def normalize_truck_type(value):
    match = re.fullmatch(r"(?:(\d+)\s*[*x×]\s*)?(\d+(?:\.\d+)?)\s*(?:T|吨(?:车)?)", str(value or "").strip(), re.I)
    if not match or int(match[1] or 1) <= 0 or Decimal(match[2]) <= 0:
        return ""
    tonnes = format(Decimal(match[2]).normalize(), "f")
    return f"{int(match[1] or 1)}*{tonnes}T"


def recommend_truck(items):
    if not items:
        return ""
    groups = {}
    for index, item in enumerate(items):
        group = str(item.get("packing_group") or "")
        key = (item.get("source_file", ""), group) if group else (index,)
        groups.setdefault(key, None)
        raw = item.get("volume")
        if raw in (None, ""):
            raw = item.get("cbm")
        if raw in (None, ""):
            if not group:
                return ""
            continue
        try:
            value = Decimal(str(raw))
        except (InvalidOperation, ValueError):
            return ""
        if not value.is_finite() or value < 0:
            return ""
        if groups[key] is not None and groups[key] != value:
            return ""
        groups[key] = value
    if any(value is None for value in groups.values()):
        return ""
    volume = sum(groups.values(), Decimal(0))
    if volume <= 0:
        return ""
    band = next((band for band in VOLUME_BANDS if volume <= band["maximumCbm"]), None)
    return f"1*{band['tonnes']}T" if band else ""


def warehouse_truck_type(task, items):
    details = task.get("exportDetails") or {}
    if details.get("truckTypeSource") != "recommended":
        current = str(task.get("containerType") or "").strip()
        provided = normalize_truck_type(current) or normalize_truck_type(details.get("vehicleType"))
        if provided:
            return provided
        if current and details.get("truckTypeSource") == "manual":
            raise ValueError("请填写正确的吨车规格，例如 1*3T")
    return recommend_truck(items)
