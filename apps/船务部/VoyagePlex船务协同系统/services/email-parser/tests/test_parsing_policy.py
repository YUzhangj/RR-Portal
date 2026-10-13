import unittest
from app.parsing_policy import apply_policies, RULES


class ParsingPolicyTests(unittest.TestCase):
    def test_contract_is_not_so_even_if_factory_excluded(self):
        c=apply_policies({"subject":"SO#45001","body_text":"","received_at":"2026-07-16"}, {"so_number":"45001"}, [{"filename":"packing.xlsx","kind":"packing_list","fields":{},"items":[{"product_code":"A","contract_number":"45001","supplier":"丹尼","quantity":12},{"product_code":"B","contract_number":"45002","supplier":"兴信","quantity":24}]}], "warehouse", "Xingxin")
        self.assertEqual(c["fields"]["so_number"], "")

    def test_current_schedule_table_and_si_typo(self):
        from app.carrier_schedule import apply_carrier_schedule
        fields={"si_deadline":"2026-07-20T00:00"}
        apply_carrier_schedule(fields, [[['Container','SI AND VGM CUT OFF','CY CUT OFF'],['1*40HC','2026/7/16 12:00','2026/7/20 23:00']]])
        self.assertEqual(fields['si_deadline'], '2026-07-16T12:00')
        c=self.context(body="Sl & VGM Cut Off:\n07/21/2026 17:00:00")
        self.assertEqual(c['fields']['si_deadline'], '2026-07-21T17:00')
        self.assertEqual(self.context(body="Cargoes delivery date:16-Jul ~20-Jul 15:00 P.M")['fields']['delivery_time'], '15:00')

    def test_warehouse_name_and_so_compact_label(self):
        from app.rules import parse_body
        self.assertEqual(parse_body('S/O NO.SHZ8361948')['so_number'], 'SHZ8361948')
        self.assertEqual(parse_body('ARGOS盐田普洛斯仓库散货报关费')['warehouse'], '盐田普洛斯仓库')

    def test_warehouse_so_matches_retained_contract(self):
        c=apply_policies({"subject":"交仓", "body_text":"", "received_at":"2026-07-16", "body_tables":[[["45001","泰亨","SO#OTHER"],["45002","兴信","SO#OURS"]]]}, {}, [{"filename":"packing.xlsx","kind":"packing_list","fields":{},"items":[{"product_code":"A","supplier":"兴信","contract_number":"45002","quantity":12}]}], "warehouse", "Xingxin")
        self.assertEqual(c["fields"]["so_number"], "OURS")
        self.assertEqual(c["details"][0]["items"][0]["carrier_so"], "OURS")

    def test_external_delivery_explicit_and_default_date(self):
        cargo = [{"product_code":"A", "supplier":"兴信", "factory_remark":"丹尼", "quantity":12}, {"product_code":"B", "supplier":"丹尼", "factory_remark":"丹尼", "quantity":24}]
        c = self.context(body="此票7/31 在丹尼提货，务必赶7/30送到丹尼", cargo=cargo)
        self.assertEqual(c["shipment_type"], "delivery")
        self.assertEqual(c["fields"]["ship_date"], "2026-07-30")
        self.assertEqual(c["fields"]["pickup_date"], "2026-07-31")
        self.assertEqual(len(c["details"][0]["items"]), 1)
        self.assertEqual(c["cabinet_groups"], [])
        c = self.context(body="此票1/1 在丹尼提货", cargo=cargo)
        self.assertEqual(c["fields"]["ship_date"], "2025-12-31")
        self.assertEqual(c["fields"]["dispatch_date_source"], "pickup_previous_day")

    def test_incoming_factory_cargo_stays_container(self):
        c = self.context(body="7/31提货，外厂送兴信做柜", cargo=[{"product_code":"A","supplier":"丹尼","factory_remark":"兴信","quantity":12}])
        self.assertEqual(c["shipment_type"], "standard")
        self.assertEqual(c["fields"]["ship_date"], "2026-07-31")
        h = self.context(body="7/31 在丹尼提货", company="Huadeng", cargo=[{"product_code":"A","supplier":"兴信","factory_remark":"丹尼","quantity":12}])
        self.assertEqual(h["shipment_type"], "standard")
    def context(self, subject="", body="", company="Xingxin", kind="standard", cargo=None):
        return apply_policies({"subject": subject, "body_text": body, "received_at": "2026-07-16T00:00:00Z"}, {},
            [{"filename": "packing.xlsx", "kind": "packing_list", "items": cargo or [], "fields": {}}], kind, company)

    def test_end_date_and_latest_single_instruction(self):
        c = self.context("交仓时间：7/11-7/18")
        self.assertEqual(c["fields"]["ship_date"], "2026-07-18")
        self.assertEqual(c["fields"]["delivery_window_start"], "2026-07-11")
        c = self.context("CFS 9/6-9/12", "请按排9/14当天交仓")
        self.assertEqual(c["fields"]["ship_date"], "2026-09-14")
        self.assertEqual(self.context(body="Cargoes delivery date:16-Jul ~20-Jul\n0755-2525交仓咨询")["fields"]["ship_date"], "2026-07-20")

    def test_waiting_does_not_invent_date(self):
        c = self.context(body="等首单验货通过后才能安排，目前时间待定，请等后续通知")
        self.assertEqual(c["fields"]["waiting_notification"], "true")
        self.assertEqual(c["fields"]["ship_date"], "")

    def test_warehouse_filter_is_company_scoped(self):
        cargo = [{"product_code":"A", "supplier":"兴信", "quantity":12}, {"product_code":"B", "supplier":"丹尼", "quantity":24}]
        x = self.context(kind="warehouse", cargo=cargo)
        h = self.context(kind="warehouse", cargo=cargo, company="Huadeng")
        self.assertEqual(len(x["details"][0]["items"]), 1)
        self.assertEqual(len(h["details"][0]["items"]), 2)
        self.assertNotIn("XINGXIN-CARGO-001", [t["rule_id"] for t in h["trace"]])

    def test_explicit_cabinet_ownership_and_assembly_filter(self):
        cargo = [
            {"product_code":"A", "supplier":"丹尼", "factory_remark":"兴信", "quantity":12,"container_assignment":"C1","container_type":"45HQ"},
            {"product_code":"A", "supplier":"兴信", "factory_remark":"兴信", "quantity":24,"container_assignment":"C2","container_type":"40HQ"},
            {"product_code":"B", "supplier":"库有", "factory_remark":"库有", "quantity":36,"container_assignment":"C3","container_type":"40HQ"},
        ]
        c = self.context(cargo=cargo)
        self.assertEqual([g["group_key"] for g in c["cabinet_groups"]], ["C1","C2"])
        self.assertEqual([g["items"][0]["quantity"] for g in c["cabinet_groups"]], [12,24])
        trace=next(t for t in c["trace"] if t["rule_id"]=="XINGXIN-CARGO-001")
        self.assertEqual((trace["result"]["before"],trace["result"]["kept"]),(3,2))

    def test_cfs_internal_container_ids_are_not_cabinet_tasks(self):
        c=self.context(kind="warehouse",cargo=[{"product_code":"A","supplier":"兴信","quantity":12,"container_assignment":"C1","container_type":"CFS"}])
        self.assertEqual(c["cabinet_groups"], [])

    def test_templates_and_instruction_rows_are_not_cargo(self):
        cargo=[{"product_code":"请注意交仓要求", "quantity":None},{"product_code":"A", "quantity":12,"supplier":"兴信"}]
        self.assertEqual(len(self.context(cargo=cargo)["details"][0]["items"]),1)
        c=apply_policies({"subject":"", "body_text":""},{},[{"filename":"ASN例子.xlsx","kind":"packing_list","items":cargo,"fields":{}}],"warehouse","Xingxin")
        self.assertEqual(c["details"][0]["items"],[])

    def test_pending_rules_cannot_execute(self):
        self.assertEqual(len({rule["id"] for rule in RULES}),len(RULES))
        for rule in RULES:
            if rule["status"]=="pending_confirmation":
                self.assertIsNone(rule["handler"])
            else:
                self.assertTrue(rule["samples"])
