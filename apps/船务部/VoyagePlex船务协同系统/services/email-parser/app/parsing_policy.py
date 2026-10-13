"""Versioned, executable parsing policies; company exceptions remain explicit."""
import re
from collections import defaultdict
from datetime import datetime, timedelta
from .rules import normalize_deadline, _split_current_message

POLICY_VERSION = "2026-10-13.2"


def shipping_field_evidence(context):
    fields = context["fields"]
    current, _ = _split_current_message(context["message"]["subject"] + "\n" + context["message"]["body_text"])
    year = int(re.search(r"20\d{2}", context["message"].get("received_at", "") or str(datetime.now().year))[0])
    contracts = context["original_contracts"]
    if fields.get("so_number") in contracts:
        fields["so_number"] = ""
        context["review"].append("合同号不能作为SO，本票SO待确认")
    for detail in context["details"]:
        for item in detail["items"]:
            if item.get("carrier_so") in contracts:
                item["carrier_so"] = ""
    typo = re.search(r"\bSl\s*&\s*VGM\s*Cut\s*Off\s*[:：]\s*([^\n]+)", current, re.I)
    if typo:
        fields["si_deadline"] = normalize_deadline(typo[1], year)
    # A delivery window can carry a latest acceptance time as well as a day.
    time = re.search(r"(?:交仓时间|delivery date)[^\n]{0,100}?\b(\d{1,2}):(\d{2})\s*(P\.?M\.?|A\.?M\.?)?", current, re.I)
    if not time:
        time = re.search(r"\d{1,2}/\d{1,2}\s*(上午|下午|中午|晚上)?\s*(\d{1,2})点(?:前)?交仓", current)
        if time:
            hour = int(time[2]) + (12 if time[1] in {"下午", "晚上"} and int(time[2]) < 12 else 0)
            fields["delivery_time"] = f"{hour:02d}:00"
    else:
        hour, minute = int(time[1]), int(time[2])
        if time[3] and time[3].upper().startswith("P") and hour < 12:
            hour += 12
        if time[3] and time[3].upper().startswith("A") and hour == 12:
            hour = 0
        if hour < 24 and minute < 60:
            fields["delivery_time"] = f"{hour:02d}:{minute:02d}"
    if fields.get("delivery_time"):
        context["review"].append("交仓时间要求：" + fields["delivery_time"] + "，请按邮件截止要求安排")
    return {key: fields.get(key, "") for key in ("so_number", "si_deadline", "delivery_time")}


def external_delivery(context):
    fields = context["fields"]
    current, _ = _split_current_message(context["message"]["body_text"])
    cargo = [i for d in context["details"] for i in d["items"]]
    factories = {str(i.get("factory_remark", "")).strip() for i in cargo if i.get("factory_remark")}
    from .factory_mapping import FACTORY_MAPPINGS
    names = {row["chinese_short_name"] for row in FACTORY_MAPPINGS} | factories
    factory_pattern = "|".join(re.escape(name) for name in sorted(names, key=len, reverse=True) if name)
    target = re.search(r"(?:送到|送往|在)\s*(" + factory_pattern + r")(?:工厂)?(?:提货|[，,。]|\s|$)", current)
    factory = target[1].removesuffix("工厂") if target else fields.get("loading_factory", "")
    other = lambda name: bool(name) and not re.search(r"兴信|新信|hanson", name, re.I)
    # Assembly ownership distinguishes outward delivery from external cargo
    # arriving at Xingxin. CFS delivery stays a warehouse task.
    external = context["shipment_type"] != "warehouse" and bool(cargo) and (
        (factories and all(other(name) for name in factories)) or
        (other(factory) and re.search(r"做柜|提货|送到|送往", current)))
    if not external:
        return {"delivery": False}
    context["shipment_type"] = "delivery"
    fields["task_type"] = "Delivery"
    fields["delivery_factory"] = factory or next(iter(sorted(factories)), "")
    fields["pickup_date"] = fields.get("ship_date", "")
    date = r"(?:20\d{2}[/.-])?\d{1,2}[/月.-]\d{1,2}日?号?"
    year = int(re.search(r"20\d{2}", context["message"].get("received_at", "") or str(datetime.now().year))[0])
    pickup = re.search(r"(" + date + r")\s*(?:在[^\n，,。]{1,20})?提货", current)
    if pickup:
        fields["pickup_date"] = normalize_deadline(pickup[1].rstrip("号"), year)[:10]
    dispatch = re.search(r"(" + date + r")\s*(?:送到|送往|送货到)", current)
    if dispatch:
        fields["dispatch_date"] = normalize_deadline(dispatch[1].rstrip("号"), year)[:10]
        fields["dispatch_date_source"] = "explicit"
    elif fields.get("pickup_date"):
        fields["dispatch_date"] = (datetime.fromisoformat(fields["pickup_date"]) - timedelta(days=1)).date().isoformat()
        fields["dispatch_date_source"] = "pickup_previous_day"
    if fields.get("waiting_notification") == "true":
        fields["ship_date"] = ""
    else:
        fields["ship_date"] = fields.get("dispatch_date", "")
    for key in ("explicit_container_allocation", "multi_container"):
        fields[key] = "false"
    fields["container_type"] = ""
    return {"delivery": True, "factory": fields["delivery_factory"], "dispatch_date": fields.get("dispatch_date", ""), "pickup_date": fields.get("pickup_date", "")}


def warehouse_evidence(context):
    from .rules import parse_body
    names = list(dict.fromkeys(d["fields"].get("warehouse", "") for d in context["details"] if d["fields"].get("warehouse")))
    body_name = parse_body(context["message"]["subject"] + "\n" + context["message"]["body_text"]).get("warehouse", "")
    if context["shipment_type"] == "warehouse":
        if len(names) == 1:
            context["fields"]["warehouse"] = names[0]
        elif body_name and not names:
            context["fields"]["warehouse"] = body_name
        if len(names) > 1:
            context["review"].append("附件出现多个仓库，需核对各仓货物归属")
        if not names and not body_name:
            context["review"].append("交仓邮件未识别到明确仓库，需人工补充")
    return {"attachment_warehouses": names, "body_warehouse": body_name}


def warehouse_so_ownership(context):
    if context["shipment_type"] != "warehouse":
        return {"applicable": False}
    bindings = {}
    for table in context["message"].get("body_tables", []):
        for row in table:
            numbers = re.findall(r"\bSO\s*#\s*([A-Z0-9/-]+)", " ".join(str(cell) for cell in row), re.I)
            if len(set(numbers)) == 1:
                for cell in row:
                    value = str(cell).strip()
                    if re.fullmatch(r"450\d+", value):
                        bindings.setdefault(value, set()).add(numbers[0])
    numbers = []
    for detail in context["details"]:
        for item in detail["items"]:
            matches = bindings.get(str(item.get("contract_number", "")), set())
            if len(matches) == 1:
                item["carrier_so"] = next(iter(matches))
            if item.get("carrier_so"):
                numbers.append(item["carrier_so"])
    numbers = list(dict.fromkeys(numbers))
    if numbers:
        context["fields"]["so_number"] = ",".join(numbers)
    return {"applicable": True, "so_numbers": numbers}


def dated_instructions(context):
    message, fields = context["message"], context["fields"]
    text, _ = _split_current_message(message["subject"] + "\n" + message["body_text"])
    year = int(re.search(r"20\d{2}", message.get("received_at", "") or str(datetime.now().year))[0])
    date = r"(?:(?:20\d{2}[/.-])?\d{1,2}[/月.-]\d{1,2}日?号?|\d{1,2}-[A-Za-z]{3,9})"
    ranges = re.findall(r"(?:交仓|入仓|送仓|delivery date)[^\n]{0,30}?(" + date + r")\s*[-–—~～至到]\s*(" + date + r")", text, re.I)
    ranges += re.findall(r"(" + date + r")\s*[-–—~～至到]\s*(" + date + r")\s*(?:交仓|入仓|送仓)", text, re.I)
    singles = re.findall(r"(?:请安排|请按排|安排|交仓时间[：:]?)\s*(" + date + r")[^\n]{0,20}?(?:当天)?交仓", text)
    singles += re.findall(r"(" + date + r")\s*(?:号)?(?:下午|上午|晚上|中午|\s|\d|点|前|：|:){0,20}(?:交仓|交空运仓|提货|发HK|港车发HK)", text)
    singles += re.findall(r"(?:Pick\s*up\s*Date|预计提货时间|提货时间)[：:\s]*(" + date + r")", text, re.I)
    range_dates = {value for pair in ranges for value in pair}
    singles = [value for value in singles if value not in range_dates]
    dates = [normalize_deadline(value.rstrip("号"), year)[:10] for value in singles]
    dates = [value for value in dates if value]
    if not dates and ranges:
        dates = [normalize_deadline(ranges[0][1].rstrip("号"), year)[:10]]
    if dates:
        fields["ship_date"] = dates[0]
    if ranges:
        fields["delivery_window_start"] = normalize_deadline(ranges[0][0].rstrip("号"), year)[:10]
        fields["delivery_window_end"] = normalize_deadline(ranges[0][1].rstrip("号"), year)[:10]
    waiting = re.search(r"(?:时间待定|等后续通知|没有确认船期|未确认船期|验货通过后才能安排)", text)
    if waiting:
        fields["waiting_notification"] = "true"
        fields["ship_date"] = ""
    # Both days are different events: preserve the local dispatch instruction.
    dispatch = re.search(r"(?:赶|于|在)(" + date + r")\s*送到([^\s，,。]+)", text)
    if dispatch:
        fields["dispatch_date"] = normalize_deadline(dispatch[1], year)[:10]
    return {"ship_date": fields.get("ship_date", ""), "window_end": fields.get("delivery_window_end", ""), "waiting": bool(waiting)}


def attachment_roles(context):
    removed = []
    for detail in context["details"]:
        name = detail["filename"]
        if re.search(r"(?:例子|示例|模板|template|操作指引|指南|报备表|Application report|检查表|Check.List|Charges|收费|注意事项|通知|目录)", name, re.I):
            if detail["items"]:
                removed.append(name)
            detail["items"] = []
            detail["auxiliary"] = True
        else:
            detail["items"] = [i for i in detail["items"] if
                re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,79}", str(i.get("product_code", "")))
                and any(i.get(k) is not None for k in ("quantity", "pieces", "volume"))]
    return {"excluded_sources": removed}


def xingxin_filter(context):
    xingxin = lambda name: bool(re.search(r"兴信|新信|hanson", str(name or ""), re.I))
    before = sum(len(d["items"]) for d in context["details"])
    excluded = []
    external = False
    for detail in context["details"]:
        if detail.get("kind") == "amazon_allocation":
            continue
        cargo = detail["items"]
        if context["shipment_type"] in {"warehouse", "delivery"}:
            selected = [i for i in cargo if xingxin(i.get("supplier"))]
        elif any(xingxin(i.get("factory_remark")) for i in cargo):
            selected = [i for i in cargo if xingxin(i.get("factory_remark"))]
        elif any(i.get("factory_remark") for i in cargo):
            selected = [i for i in cargo if xingxin(i.get("supplier"))]
            external = external or bool(selected)
        else:
            selected = [i for i in cargo if xingxin(i.get("supplier"))]
            if not any(i.get("supplier") for i in cargo):
                selected = cargo
                if cargo: context["review"].append("走柜货物缺少生产及做柜工厂，需人工核对归属")
        excluded.extend({"file": detail["filename"], "row": i.get("source_row"), "product": i.get("product_code")} for i in cargo if i not in selected)
        detail["items"] = selected
    if before and not any(d["items"] for d in context["details"]):
        context["review"].append("筛选后无兴信货物，不能视为可直接建任务的成功结果")
    return {"before": before, "kept": sum(len(d["items"]) for d in context["details"]), "excluded": excluded}


def explicit_cabinets(context):
    if context["shipment_type"] in {"warehouse", "delivery"}:
        return {"cabinet_count": 0, "reason": "交仓附件内部装载编号不视为做柜任务"}
    buckets = defaultdict(list)
    for detail in context["details"]:
        for item in detail["items"]:
            if item.get("container_assignment") and item.get("container_type"):
                buckets[(item["container_assignment"], item["container_type"], item.get("carrier_so", ""))].append(item)
    groups = []
    current, _ = _split_current_message(context["message"]["body_text"])
    for (key, kind, so), items in buckets.items():
        if kind == "40NOR" and re.search(r"NOR.{0,30}改为.{0,15}40GP", current, re.I):
            kind = "40GP"
        groups.append({"group_key": key, "container_type": kind, "so_number": so or context["fields"].get("so_number", ""), "items": items})
    if groups:
        context["cabinet_groups"] = groups
        context["fields"]["explicit_container_allocation"] = "true"
        context["fields"]["multi_container"] = "true" if len(groups) > 1 else "false"
        context["fields"]["container_count"] = str(len(groups))
        context["fields"]["container_type"] = "+".join("1*" + g["container_type"] for g in groups)
        # A retained cabinet must use its own SO, not the first SO in the message.
        numbers = list(dict.fromkeys(g["so_number"] for g in groups if g["so_number"]))
        if numbers: context["fields"]["so_number"] = ",".join(numbers)
    return {"cabinet_count": len(groups), "keys": [g["group_key"] for g in groups]}


def huadeng_compatibility(context):
    from .rules import filter_items_for_email
    for detail in context["details"]:
        if detail["kind"] != "amazon_allocation":
            detail["items"] = filter_items_for_email(detail["items"], context["shipment_type"], context["fields"].get("loading_factory", ""))
    return {"mode": "existing_company_behavior"}


RULES = [
    {"id": "COMMON-ATT-001", "name": "附件角色与有效货物行", "scope": "common", "handler": "attachment_roles", "status": "implemented", "samples": ["8.eml", "21.eml", "22.eml", "23.eml"]},
    {"id": "COMMON-DATE-001", "name": "业务日期范围取结束日及待通知", "scope": "common", "handler": "dated_instructions", "status": "implemented", "samples": ["1.eml", "2.eml", "6.eml", "8.eml", "13.eml", "22.eml", "27.eml"]},
    {"id": "COMMON-WAREHOUSE-001", "name": "明确本地仓库证据与缺失提示", "scope": "common", "handler": "warehouse_evidence", "status": "implemented", "samples": ["6.eml", "22.eml"]},
    {"id": "XINGXIN-EXTERNAL-001", "name": "送外厂建立送货任务及送货日期", "scope": "Xingxin", "handler": "external_delivery", "status": "implemented", "samples": ["16.eml", "18.eml", "26.eml"]},
    {"id": "XINGXIN-CARGO-001", "name": "兴信交仓按生产工厂、做柜按装配工厂筛选", "scope": "Xingxin", "handler": "xingxin_filter", "status": "implemented", "samples": ["4.eml", "22.eml", "23.eml"]},
    {"id": "HUADENG-COMPAT-001", "name": "保留华登原有筛选，差异另行审核", "scope": "Huadeng", "handler": "huadeng_compatibility", "status": "implemented", "samples": ["company-isolation"]},
    {"id": "COMMON-FIELDS-001", "name": "编号角色、截期及交仓时间核对", "scope": "common", "handler": "shipping_field_evidence", "status": "implemented", "samples": ["4.eml", "18.eml", "19.eml", "20.eml", "23.eml"]},
    {"id": "COMMON-SO-001", "name": "交仓逐行SO归属及同仓不同SO分任务", "scope": "common", "handler": "warehouse_so_ownership", "status": "implemented", "samples": ["1.eml", "23.eml", "warehouse-so-isolation"]},
    {"id": "COMMON-SPLIT-001", "name": "附件逐行柜归属", "scope": "common", "handler": "explicit_cabinets", "status": "implemented", "samples": ["3.eml", "9.eml", "12.eml", "25.eml"]},
    {"id": "HUADENG-CARGO-001", "name": "华登专属货物筛选差异", "scope": "Huadeng", "handler": None, "status": "pending_confirmation", "samples": []},
]


def apply_policies(message, fields, details, shipment_type, company):
    if company not in {"Xingxin", "Huadeng"}:
        raise ValueError("公司板块无效")
    context = {"message": message, "fields": fields, "details": details, "shipment_type": shipment_type,
               "review": [], "cabinet_groups": [], "trace": [],
               "original_contracts": {str(i.get("contract_number", "")) for d in details for i in d["items"]}}
    for rule in RULES:
        if rule["scope"] not in {"common", company} or not rule["handler"]:
            continue
        handler = globals().get(rule["handler"])
        if not callable(handler):
            raise RuntimeError(f"规则{rule['id']}已登记但没有执行函数")
        result = handler(context)
        context["trace"].append({"rule_id": rule["id"], "scope": rule["scope"], "result": result})
    return context
