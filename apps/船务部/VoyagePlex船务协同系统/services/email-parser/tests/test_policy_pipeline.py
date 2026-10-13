import unittest
from email.message import EmailMessage
from io import BytesIO

import openpyxl

from app.main import merge_cabinet_schedules, parse_email_entries
from app.parsing_policy import POLICY_VERSION, apply_policies


SCHEDULE = (
    '<table><tr><th>SO#</th><th>Vessel name</th><th>SI cut</th><th>CY cut</th></tr>'
    '<tr><td>SYNTHETIC111</td><td>VESSEL-A</td><td>7/20 10:00</td><td>7/22 12:00</td></tr>'
    '<tr><td>SYNTHETIC222</td><td>VESSEL-B</td><td>7/21 10:00</td><td>7/23 12:00</td></tr></table>'
)
BODY_ORDERS = (
    '<table><tr><th>Factory</th><th>Order Reference#</th><th>Item#</th><th>Qty(pc)</th>'
    '<th>Qty/Ctn</th><th>No. of ctn</th><th>TTL CBM</th></tr>'
    '<tr><td>兴信</td><td>ORDER-A</td><td>BODY-A</td><td>12</td><td>12</td><td>1</td><td>1</td></tr>'
    '<tr><td>丹尼</td><td>ORDER-B</td><td>BODY-B</td><td>24</td><td>12</td><td>2</td><td>2</td></tr>'
    '<tr><td>兴信</td><td>ORDER-C</td><td>INVALID-C</td><td></td><td>12</td><td></td><td></td></tr></table>'
)


def parse_fixture(rows, body, html=None, company="Xingxin"):
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(["SKU", "Quantity", "Cartons", "Actual Factory", "Main Assembly Factory",
                  "Container No. Loading", "Container Type Loading", "Carrier SO Number"])
    for row in rows:
        sheet.append(row)
    content = BytesIO()
    book.save(content)
    book.close()
    mail = EmailMessage()
    mail["Subject"] = "SYNTHETIC SHIPMENT"
    mail["From"] = "fixture@example.invalid"
    mail["Date"] = "Thu, 16 Jul 2026 10:00:00 +0800"
    mail.set_content(body)
    if html:
        mail.add_alternative(html, subtype="html")
    mail.add_attachment(content.getvalue(), maintype="application",
                        subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        filename="synthetic-cargo.xlsx")
    return parse_email_entries([{"filename": "synthetic.eml", "raw": mail.as_bytes()}], company)["items"][0]


class PolicyPipelineTests(unittest.TestCase):
    def test_delivery_clears_skycastle_multi_container_template(self):
        body = "2*40HQ SKY CASTLE 此票7/31在丹尼提货"
        result = parse_fixture([["OUTGOING-A", 12, 1, "兴信", "丹尼", "C1", "40HQ", "SYNTHETIC111"]],
                               body, "<p>" + body + "</p>" + SCHEDULE)
        self.assertEqual(result["status"], "parsed")
        self.assertEqual(result["shipment_type"], "delivery")
        self.assertEqual(result["fields"]["task_type"], "Delivery")
        self.assertEqual(result["fields"]["delivery_factory"], "丹尼")
        self.assertEqual(result["fields"]["ship_date"], "2026-07-30")
        self.assertEqual(result["fields"]["export_template"], "")
        self.assertEqual(result["fields"]["container_type"], "")
        self.assertEqual(result["fields"]["multi_container"], "false")
        self.assertEqual(result["shipment_groups"], [])

    def test_delivery_destination_uses_only_retained_company_cargo(self):
        result = parse_fixture([
            ["OUR-A", 12, 1, "兴信", "泰亨", "", "", ""],
            ["OTHER-B", 24, 2, "丹尼", "丹尼", "", "", ""],
        ], "7/31提货")
        self.assertEqual(result["status"], "parsed")
        self.assertEqual(result["fields"]["delivery_factory"], "泰亨")
        self.assertEqual(result["fields"]["pickup_date"], "2026-07-31")
        self.assertEqual(result["fields"]["ship_date"], "2026-07-30")
        self.assertEqual([(item["product_code"], item["quantity"]) for item in result["items"]], [("OUR-A", 12)])
        trace = next(t for t in result["rule_trace"] if t["rule_id"] == "XINGXIN-CARGO-001")
        self.assertEqual((trace["result"]["before"], trace["result"]["kept"]), (2, 1))
        self.assertEqual(result["rule_version"], "2026-10-13.3")

    def test_multiple_external_destinations_require_review_without_guessing(self):
        rows = [["OUR-A", 12, 1, "兴信", "泰亨", "", "", ""],
                ["OUR-B", 24, 2, "兴信", "丹尼", "", "", ""]]
        result = parse_fixture(rows, "7/31提货")
        self.assertEqual(result["fields"]["delivery_factory"], "")
        self.assertTrue(any("多个外厂" in reason for reason in result["review_reasons"]))
        explicit = parse_fixture(rows, "7/31在丹尼提货")
        self.assertEqual(explicit["fields"]["delivery_factory"], "丹尼")
        self.assertEqual(len(explicit["items"]), 2)

    def test_loading_instruction_keeps_incoming_cargo_but_explicit_row_assembly_wins(self):
        result = parse_fixture([
            ["INCOMING-A", 12, 1, "丹尼", "", "", "", ""],
            ["OTHER-B", 24, 2, "丹尼", "泰亨", "", "", ""],
        ], "7/31兴信做柜，丹尼送货到兴信做柜")
        self.assertEqual(result["status"], "parsed")
        self.assertEqual(result["shipment_type"], "standard")
        self.assertEqual([item["product_code"] for item in result["items"]], ["INCOMING-A"])
        self.assertEqual(result["attachment_results"][0]["item_count"], 1)

    def test_explicit_cabinets_keep_their_own_schedule_and_cargo(self):
        result = parse_fixture([
            ["ALLOCATED-A", 12, 1, "兴信", "兴信", "C1", "40HQ", "SYNTHETIC111"],
            ["ALLOCATED-B", 24, 2, "兴信", "兴信", "C2", "40HQ", "SYNTHETIC222"],
        ], "2*40HQ 兴信做柜", "<p>2*40HQ 兴信做柜</p>" + SCHEDULE + BODY_ORDERS)
        groups = result["shipment_groups"]
        self.assertEqual([item["product_code"] for item in result["items"]], ["ALLOCATED-A", "ALLOCATED-B"])
        self.assertEqual([(g["group_key"], g["so_number"], g["vessel_name"], g["si_deadline"], g["cutoff_date"])
                          for g in groups], [
            ("C1", "SYNTHETIC111", "VESSEL-A", "2026-07-20T10:00", "2026-07-22T12:00"),
            ("C2", "SYNTHETIC222", "VESSEL-B", "2026-07-21T10:00", "2026-07-23T12:00"),
        ])
        self.assertEqual([[i["quantity"] for i in g["items"]] for g in groups], [[12], [24]])
        trace = next(t for t in result["rule_trace"] if t["rule_id"] == "COMMON-SPLIT-001")
        self.assertEqual([b["si_deadline"] for b in trace["result"]["schedule_bindings"]],
                         [g["si_deadline"] for g in groups])

    def test_body_order_source_is_filtered_once_before_policies_not_restored_afterwards(self):
        result = parse_fixture([["ATTACHMENT-A", 999, 99, "兴信", "", "", "", ""]],
                               "2*40HQ", "<p>2*40HQ</p>" + SCHEDULE + BODY_ORDERS)
        self.assertEqual([(i["product_code"], i["quantity"]) for i in result["items"]], [("BODY-A", 12)])
        self.assertEqual(result["items"][0]["source_file"], "email-body.html")
        self.assertEqual(result["attachment_results"][0]["item_count"], 0)
        trace = next(t for t in result["rule_trace"] if t["rule_id"] == "XINGXIN-CARGO-001")
        self.assertEqual((trace["result"]["before"], trace["result"]["kept"]), (2, 1))
        self.assertEqual(len({t["rule_id"] for t in result["rule_trace"]}), len(result["rule_trace"]))

    def test_huadeng_keeps_body_source_compatibility_but_excludes_invalid_rows(self):
        result = parse_fixture([["ATTACHMENT-A", 999, 99, "华登", "华登", "C1", "40HQ", "SYNTHETIC111"]],
                               "2*40HQ", "<p>2*40HQ</p>" + SCHEDULE + BODY_ORDERS, company="Huadeng")
        self.assertEqual([(i["product_code"], i["quantity"]) for i in result["items"]], [("BODY-A", 12), ("BODY-B", 24)])
        self.assertNotIn("XINGXIN-CARGO-001", [t["rule_id"] for t in result["rule_trace"]])
        self.assertEqual(len(result["shipment_groups"]), 2)

    def test_original_attachment_contract_evidence_survives_body_source_selection(self):
        context = apply_policies({"subject": "", "body_text": "", "received_at": "2026-07-16"},
            {"so_number": "4500191111"},
            [{"filename": "email-body.html", "kind": "order_table", "fields": {},
              "items": [{"product_code": "BODY-A", "quantity": 12, "supplier": "兴信"}]}],
            "standard", "Xingxin", original_contracts={"4500191111"})
        self.assertEqual(context["fields"]["so_number"], "")
        self.assertIn("合同号不能作为SO", " ".join(context["review"]))
        self.assertEqual(POLICY_VERSION, "2026-10-13.3")

    def test_missing_cabinet_so_does_not_inherit_combined_message_so(self):
        result = parse_fixture([
            ["ALLOCATED-A", 12, 1, "兴信", "兴信", "C1", "40HQ", ""],
            ["ALLOCATED-B", 24, 2, "兴信", "兴信", "C2", "40HQ", ""],
        ], "2*40HQ 兴信做柜", "<p>2*40HQ 兴信做柜</p>" + SCHEDULE)
        self.assertEqual([g["so_number"] for g in result["shipment_groups"]], ["", ""])
        self.assertTrue(any("合并SO" in reason for reason in result["review_reasons"]))
        self.assertTrue(all(not g.get("si_deadline") for g in result["shipment_groups"]))

    def test_conflicting_schedule_matches_are_not_selected_by_position(self):
        review = []
        cabinets = [{"group_key": "container-1", "so_number": "SYNTHETIC222", "container_type": "40HQ", "items": []}]
        schedules = [{"group_key": "container-1", "so_number": "SYNTHETIC111", "si_deadline": "2026-07-20T10:00"},
                     {"group_key": "container-2", "so_number": "SYNTHETIC222", "si_deadline": "2026-07-21T10:00"}]
        groups, bindings = merge_cabinet_schedules(cabinets, schedules, review)
        self.assertFalse(groups[0].get("si_deadline"))
        self.assertEqual(bindings[0]["matches"], 2)
        self.assertTrue(any("无法唯一匹配" in reason for reason in review))
