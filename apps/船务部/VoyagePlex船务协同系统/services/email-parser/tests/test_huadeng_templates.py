from copy import deepcopy
from io import BytesIO
import unittest
from openpyxl import load_workbook
from app.shipment_export import build_shipment_workbook
from app.rules import parse_body


class HuadengTemplateTests(unittest.TestCase):
    def task(self, mode="Warehouse"):
        return {"company":"Huadeng","customer":"ACTUAL CUSTOMER","port":"盐田","transportReference":"28车" if mode=="Warehouse" else "78柜","containerType":"1*5T" if mode=="Warehouse" else "1*40HQ","soNumber":"SO-A","plannedShipDate":"2026-01-28","items":[{"product_code":"A","product_name":"产品A","quantity":"1080","pieces":"540","gross_weight_per_box":"0.6","net_weight_per_box":"0.44","volume":4.183,"pallet_count":3,"brand":"ZURU/RAINBOCORNS","box_dimensions":"22.5*15.5*21.5","customer_item_number":"ITEM-A"}],"exportDetails":{"shipmentMode":mode,"warehouse":"盐港二号仓","consignee":"ACTUAL IMPORTER LTD."}}

    def sheet(self, task):
        return load_workbook(BytesIO(build_shipment_workbook(task)[0])).active

    def test_rr_titles_actual_customer_and_red_brand(self):
        for mode,title in (("Container","盐田 RR 78柜"),("Warehouse","RR 28车")):
            sheet=self.sheet(self.task(mode))
            self.assertEqual(title,sheet["F2"].value)
            self.assertEqual("ACTUAL CUSTOMER",sheet["C6"].value)
            self.assertEqual("TO：余振军",sheet["A1"].value)
            brand=next(cell for row in sheet for cell in row if str(cell.value).startswith("品牌："))
            self.assertEqual("FF0000",brand.font.color.rgb[-6:])
            self.assertTrue(any("ACTUAL IMPORTER" in str(cell.value) for row in sheet for cell in row))

    def test_default_preserves_decimals_and_numeric_cartons(self):
        task=self.task("Container");task["items"][0]["weight_rule"]="Truncate"
        sheet=self.sheet(task)
        self.assertEqual(540,sheet["J6"].value)
        self.assertEqual("=J6*P6",sheet["K6"].value)
        self.assertEqual("=J6*Q6",sheet["L6"].value)
        self.assertEqual("0",sheet["K6"].number_format)
        self.assertEqual("0",sheet["L6"].number_format)
        self.assertEqual("=SUM(K6:K7)",sheet["K8"].value)
        task["exportTemplate"]={"weightRule":"Truncate"}
        self.assertEqual("=INT(J6*Q6)",self.sheet(task)["L6"].value)
        task["exportTemplate"]["weightRule"]="Exact"
        self.assertEqual("0.00",self.sheet(task)["L6"].number_format)

    def test_three_cargo_pallet_lines_match_28_truck_sample(self):
        task=self.task();second=deepcopy(task["items"][0]);second.update(product_code="B",pieces=576,quantity=1152,gross_weight_per_box=.56,net_weight_per_box=.43,volume=3.901)
        task["items"]=[task["items"][0],second,deepcopy(task["items"][0])]
        task["exportDetails"]["palletWeight"]="999"
        sheet=self.sheet(task)
        for row in (7,9,11):
            self.assertEqual("3个卡板",sheet[f"F{row}"].value)
            self.assertEqual(3,sheet[f"K{row}"].value)
        self.assertEqual("=J8*P8",sheet["K8"].value)
        self.assertEqual("=SUM(K6:K12)",sheet["K13"].value)
        self.assertEqual("=SUM(L6:L12)",sheet["L13"].value)
        self.assertIn("1*5T 吨车如下：各",sheet["E3"].value)
        self.assertTrue(any("A：22.5*15.5*21.5" in str(cell.value) for row in sheet for cell in row))

    def test_confirmed_mixed_group_stays_contiguous_with_one_pallet_line(self):
        task=self.task();first=task["items"][0];first["packing_group"]="confirmed-A"
        task["items"].append(dict(first,net_weight_per_box=.26,quantity=100))
        sheet=self.sheet(task)
        self.assertIn("J6:J7",str(sheet.merged_cells))
        self.assertEqual("=J6*Q7",sheet["L7"].value)
        self.assertEqual(3,sheet["K8"].value)
        self.assertEqual(1,sum(cell.value=="3个卡板" for row in sheet for cell in row))

    def test_pickup_is_an_option_not_another_template(self):
        task=self.task("Container");task["exportDetails"].update(pickupMode="CustomerPickup",customsAgent="海格报关行")
        sheet=self.sheet(task)
        self.assertIn("客自提",sheet["F1"].value);self.assertIn("海格报关行",sheet["F1"].value)
        task["exportDetails"]["pickupMode"]="CustomerLoading"
        self.assertIn("客上柜",self.sheet(task)["F1"].value)
        task["exportDetails"].update(pickupMode="Normal",customsAgent="")
        self.assertIsNone(self.sheet(task)["F1"].fill.patternType)

    def test_customer_item_layout_maps_columns_and_formulas_by_mode(self):
        for mode,item_col,gross_formula in (("Warehouse","O6","=J6*Q6"),("Container","R6","=J6*P6")):
            task=self.task(mode);task["exportTemplate"]={"layoutKey":"CustomerItem","weightRule":"DisplayInteger"};task["exportVariant"]="warehouse"
            sheet=self.sheet(task)
            self.assertEqual("ITEM-A",sheet[item_col].value)
            self.assertEqual(gross_formula,sheet["K6"].value)
            self.assertEqual("放货区",sheet["S5"].value)

    def test_carton_marks_layout_uses_net_net_and_separate_order_quantity(self):
        task=self.task();task["exportTemplate"]={"layoutKey":"CartonMarks"}
        task["items"][0].update(net_net_weight_per_box=.3,order_total_quantity=1080,production_line="拉1")
        sheet=self.sheet(task)
        self.assertEqual("拉",sheet["A5"].value);self.assertEqual("拉1",sheet["A6"].value)
        self.assertIn("N5:P5",str(sheet.merged_cells))
        self.assertEqual("=J6*S6",sheet["K6"].value)
        self.assertEqual("=J6*T6",sheet["L6"].value)
        self.assertEqual(1080,sheet["R6"].value)
        self.assertEqual("每箱净净重",sheet["T5"].value)
        task["exportDetails"]["shipmentMode"]="Container"
        with self.assertRaises(ValueError):self.sheet(task)

    def test_current_mail_pickup_extraction_ignores_history_and_negation(self):
        self.assertEqual("CustomerPickup",parse_body("本次客自提，报关行：海格")['pickup_mode'])
        self.assertEqual("",parse_body("正常装柜\nFrom: old\n客自提")['pickup_mode'])
        self.assertEqual("",parse_body("取消客自提")['pickup_mode'])
