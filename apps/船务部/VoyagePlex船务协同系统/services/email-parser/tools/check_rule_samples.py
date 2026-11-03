"""Run the approved sample expectations without retaining private mail contents."""
import asyncio
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi import UploadFile
from app.main import parse_email_batch
from app.parsing_policy import POLICY_VERSION, RULES

EXPECTED = {
    "1.eml": {"date": "2026-09-14", "so": "898604"},
    "2.eml": {"date": "2026-07-22", "delivery_time":"11:00"},
    "3.eml": {"count": 8, "groups": [2, 6]},
    "4.eml": {"count": 17, "groups": [17], "so":""},
    "5.eml": {"warehouse":"普洛斯"},
    "10.eml": {"warehouse":"盐田港三号区"},
    "11.eml": {"container_type":"1*40HQ+1*40GP", "count":26},
    "15.eml": {"so":"SBK0003801037"},
    "18.eml": {"so":"SHZ8361948"},
    "19.eml": {"si_deadline":"2026-07-16T12:00"},
    "20.eml": {"si_deadline":"2026-07-21T17:00"},
    "6.eml": {"date": "2026-07-18", "warehouse": "中通百富"},
    "8.eml": {"count": 2},
    "9.eml": {"count": 16, "groups": [16]},
    "12.eml": {"count": 4, "groups": [1, 1, 1, 1]},
    "13.eml": {"waiting": "true"},
    "21.eml": {"count": 7},
    "22.eml": {"count": 1, "date": "2026-07-20"},
    "23.eml": {"count": 1, "date": "2026-07-20", "so":"LSZAW55224", "delivery_time":"15:00"},
    "25.eml": {"count": 12, "so": "SHZ8332517"},
    "26.eml": {"date": "2026-07-30", "count": 1},
    "27.eml": {"date": "2026-07-27"},
}

async def check(folder):
    paths = sorted(folder.glob("*.eml"), key=lambda p: int(p.stem) if p.stem.isdigit() else 9999)
    if not paths:
        raise ValueError("样本目录没有 EML 文件")
    uploads = [UploadFile(filename=p.name, file=io.BytesIO(p.read_bytes())) for p in paths]
    try:
        batch = await parse_email_batch(uploads, company="Xingxin")
    finally:
        for upload in uploads:
            await upload.close()
    rows = []
    for path, item in zip(paths, batch["items"]):
        fields = item.get("fields", {})
        actual = {"delivery_time":fields.get("delivery_time", ""), "si_deadline":fields.get("si_deadline", ""), "container_type":fields.get("container_type", ""), "count": len(item.get("items", [])), "date": fields.get("ship_date", ""),
                  "groups": [len(g.get("items", [])) for g in item.get("shipment_groups", [])],
                  "warehouse": " / ".join(g["warehouse"] for g in item.get("warehouse_groups", [])),
                  "waiting": fields.get("waiting_notification", ""), "so": fields.get("so_number", "")}
        errors = []
        for key, value in EXPECTED.get(path.name, {}).items():
            ok = value in actual[key] if key == "warehouse" else actual[key] == value
            if not ok: errors.append(f"{key}: expected={value}, actual={actual[key]}")
        if item["status"] != "parsed": errors.append(item.get("error", "解析失败"))
        rows.append({"file": path.name, "actual": actual, "checks": EXPECTED.get(path.name, {}),
                     "errors": errors, "review_reasons": item.get("review_reasons", []),
                     "executed_rules": [r["rule_id"] for r in item.get("rule_trace", [])]})
    missing = sorted(set(EXPECTED) - {p.name for p in paths})
    report = {"rule_version": POLICY_VERSION, "rules": RULES, "samples": rows,
              "missing_expected_samples": missing,
              "note": "通过只代表列出的已确认检查；未列出字段及待确认规则不视为验证通过。"}
    return report, bool(missing or any(r["errors"] for r in rows))

if __name__ == "__main__":
    report, failed = asyncio.run(check(Path(sys.argv[1])))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(1 if failed else 0)
