"""Recognize explicit warehouse names in current delivery instructions."""
import re


def warehouse_name(text: str) -> str:
    current = re.split(r"(?im)^\s*(?:From|发件人|Sent|发送时间)[：:]", text or "", maxsplit=1)[0]
    scan = text if re.search(r"请特别留意下面.{0,30}(?:要求|交仓)|以下.{0,15}最新|最新的操作方式", current) else current
    for pattern in (
        r"((?:盐田|深圳)[\u4e00-\u9fffA-Za-z0-9]{0,35}?普洛斯仓库)",
        r"((?:盐田港)[\u4e00-\u9fffA-Za-z0-9]{0,20}?\d+号仓)(?:库)?",
        r"(?:交仓仓库|收货仓库|仓库名称|仓库名)[：:\s]+([^\n，,；;：:]{1,200})",
        r"(?:^|[\s，,；;。])((?:盐田|深圳|普洛斯|星辉|华晖|美邦|中通)[\u4e00-\u9fffA-Za-z0-9]{0,30}?仓库)(?:为|是|[：:\s，,。])",
        r"(?:仓库地址|交仓地址|送仓地址)[：:\s]+([^\n，,；;]{2,200})",
        r"(?:^|[\s，,；;])入\s*((?!仓|库|境)[^\s，,；;：:（(]{2,100})",
        r"(?:^|[/\s#])([^/\s#，,；;：:]{2,30})进仓通知",
    ):
        match = re.search(pattern, scan)
        if not match:
            continue
        name = re.split(r"\s+(?:如下|各|货物|产品)|\s+\d+\s*[*×xX]", match[1])[0].strip()
        if name not in {"仓", "库", "仓库", "监管仓库", "海关监管仓库", "仓时间", "库时间", "仓日期", "库日期"} and not re.search(r"否则|缴纳|自送|申报|资料|时间|费用", name) and not re.match(r"\d+[/月.-]", name):
            return name
    return ""
