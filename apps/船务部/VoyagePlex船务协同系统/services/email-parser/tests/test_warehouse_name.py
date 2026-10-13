import unittest
import asyncio
from io import BytesIO
from email.message import EmailMessage

import openpyxl
from app.warehouse_name import warehouse_name
from app.main import parse_email_batch, build_warehouse_groups
from starlette.datastructures import UploadFile


class WarehouseNameTests(unittest.TestCase):
    def test_explicit_name_and_missing_name(self):
        self.assertEqual(warehouse_name("8月7日 星期五 入普洛斯二期 如下：各"), "普洛斯二期")
        self.assertEqual(warehouse_name("仓库名称：盐港二号仓"), "盐港二号仓")
        self.assertEqual(warehouse_name("入仓时间：8月7日"), "")
        self.assertEqual(warehouse_name("已收到\nFrom: old\n入普洛斯二期"), "")
        self.assertEqual(warehouse_name("入仓资料（交仓时间：7/17-7/20）"), "")
        forwarded = "星辉进仓通知\n请特别留意下面货代邮件交仓要求\nFrom: forwarder\n盐田星辉仓库为海关监管仓库"
        from app.rules import parse_body
        self.assertEqual(parse_body(forwarded)["warehouse"], "盐田星辉仓库")

    def test_excel_name_survives_full_email_parse(self):
        book = openpyxl.Workbook()
        sheet = book.active
        sheet.append(["8月7日 星期五", "入普洛斯二期", "如下：各"])
        sheet.append(["SKU", "Quantity", "Cartons", "CBM", "Actual Factory"])
        sheet.append(["MTQ70-92104-S001-NB", 7152, 596, 24.526, "兴信"])
        data = BytesIO(); book.save(data); book.close()
        message = EmailMessage()
        message["Subject"] = "交仓通知"
        message["From"] = "test@example.com"
        message.set_content("请核对附件")
        message.add_attachment(data.getvalue(), maintype="application", subtype="vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename="packing.xlsx")
        result = asyncio.run(parse_email_batch([UploadFile(filename="delivery.eml", file=BytesIO(message.as_bytes()))]))["items"][0]
        self.assertEqual(result["status"], "parsed")
        self.assertEqual(result["fields"]["warehouse"], "普洛斯二期")
        self.assertEqual(result["warehouse_groups"][0]["warehouse"], "普洛斯二期")
        self.assertEqual(result["shipment_type"], "warehouse")

    def test_each_warehouse_keeps_its_own_cargo(self):
        groups = build_warehouse_groups([
            {"filename":"a.xlsx", "fields":{"warehouse":"普洛斯二期"}, "items":[{"product_code":"A"}]},
            {"filename":"b.xlsx", "fields":{"warehouse":"盐港二号仓"}, "items":[{"product_code":"B"}]},
        ])
        self.assertEqual([(g["warehouse"], g["items"][0]["product_code"]) for g in groups], [("普洛斯二期", "A"), ("盐港二号仓", "B")])

    def test_huadeng_form_header_name(self):
        from app.huadeng_forms import parse_huadeng_form
        rows = [["", "入普洛斯二期"], ["备注", "序号", "洋行", "合同", "货号", "货名", "国家", "玩具类别"] + [""] * 9,
                ["华登", 1, "ZURU", "4500198881", "MTQ70", "混装", "罗马尼亚", "塑胶", 7152, 596, 1804, 1538, 24.526, "ORD", 596, 3.027, 2.58]]
        self.assertEqual(parse_huadeng_form(rows, [])["fields"]["warehouse"], "普洛斯二期")
