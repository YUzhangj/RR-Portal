import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from reportlab.pdfgen import canvas
from pypdf import PdfReader

from unified_pdf import (
    _Evidence,
    _build_photo_pages,
    _normalize_photos,
    _packaging_items,
    _percentage_value,
    _timestamp_value,
    _weight_value,
    generate_unified_report_pdf,
)


class UnifiedPDFNormalizationTests(unittest.TestCase):
    def test_semicolon_packaging_requirements_become_report_rows(self):
        rows = _packaging_items(
            {},
            {"individual_packaging": "Open Box=YES; Header=Y; Mailer=NO; Warning label=N"},
        )
        self.assertEqual(
            rows,
            [
                ("Open Box", "YES"),
                ("Header", "YES"),
                ("Mailer", "NO"),
                ("Warning label", "NO"),
            ],
        )

    def test_bilingual_photo_labels_are_english_and_one_warehouse_stays_one(self):
        evidence, warehouse = _normalize_photos(
            {
                "photo_slots": [
                    {
                        "label": "产品整体 / Product overview",
                        "category": "product",
                        "required": True,
                        "instruction": "拍摄完整产品",
                        "photos": [{"file_path": "product.jpg"}],
                    },
                    {
                        "label": "仓库存货 / Warehouse stock",
                        "category": "warehouse",
                        "required": True,
                        "photos": [{"file_path": "warehouse.jpg"}],
                    },
                ]
            }
        )
        self.assertEqual([(item.title, item.caption) for item in evidence], [("Product overview", "Product overview")])
        self.assertEqual([(item.title, item.caption) for item in warehouse], [("Warehouse stock", "Warehouse stock")])

    def test_display_values_do_not_add_invalid_or_duplicate_units(self):
        self.assertEqual(_percentage_value(None), "-")
        self.assertEqual(_percentage_value(100), "100%")
        self.assertEqual(_weight_value("1.21 kg"), "1.21 kg")
        self.assertEqual(_weight_value("1.39"), "1.39 kg")
        self.assertEqual(_timestamp_value("2026-07-15T02:44:45.641526"), "2026-07-15 02:44")

    def test_fixed_photo_slots_preserve_every_actual_photo_once_including_overflow(self):
        evidence = [_Evidence(f"Defect {i}", f"Evidence {i}", f"photo-{i}.jpg") for i in range(13)]
        pages = _build_photo_pages([*evidence, _Evidence("Optional placeholder", "No photo supplied", None)])
        retained = []
        for page in pages:
            for kind, payload in page:
                if kind == "row":
                    retained.extend(item for _, item in payload if item is not None)
                elif kind == "defect_row":
                    retained.extend(item for item in payload if item is not None)
        self.assertEqual(sorted(item.path for item in retained), sorted(item.path for item in evidence))
        self.assertEqual(len(retained), len(evidence))

    def test_pdf_preserves_long_notes_tables_photo_sample_ids_and_page_identity(self):
        payload = {
            "report_no": "SYN-QC-950", "revision": 2, "result": "ON HOLD",
            "result_reason": "SYNTHETIC-HOLD-REASON", "remarks": "\n".join(f"REMARK-{i:03d}" for i in range(120)),
            "defects": [{"description": f"DEFECT-{i:03d} " + "long " * 30 + f"END-DEFECT-{i:03d}", "quantity": 1} for i in range(65)],
            "tests": [{"name": f"TEST-{i:03d}", "standard": "Long standard " * 20 + f"END-TEST-{i:03d}", "result": "PASS"} for i in range(65)],
            "packing": {"individual_packaging": {**{f"Custom-{i}": "YES" for i in range(50)}, "Open Box": "YES"}},
            "photo_slots": [{"label": "Defect evidence", "category": "defect", "photos": [{"file_path": "missing.jpg", "caption": "Evidence caption", "sample_id": "SAMPLE-950"}]}],
        }
        with tempfile.TemporaryDirectory() as folder:
            output = generate_unified_report_pdf(payload, Path(folder) / "report.pdf")
            reader = PdfReader(output)
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
            for token in ["REMARK-119", "Custom-49", "SYNTHETIC-HOLD-REASON", "SAMPLE-950", "END-DEFECT-064", "END-TEST-064"]:
                self.assertIn(token, text)
            for index, page in enumerate(reader.pages, 1):
                self.assertIn("SYN-QC-950 | Rev.2", page.extract_text())
                self.assertIn(f"Page {index} of {len(reader.pages)}", page.extract_text())

    def test_production_image_copies_the_bundled_logo(self):
        root = Path(__file__).resolve().parents[1]
        self.assertTrue((root / "assets/tigerhead_logo.png").is_file())
        self.assertIn("COPY assets ./assets", (root / "Dockerfile").read_text())


if __name__ == "__main__":
    unittest.main()
