from io import BytesIO
from types import SimpleNamespace
import tracemalloc
import unittest
from unittest.mock import patch

from app.weight_metadata import ERROR, weight_metadata

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
SHEET = 'xl/worksheets/sheet1.xml'
STYLE = 'xl/styles.xml'


class Archive:
    def __init__(self, sheet, styles=None):
        self.parts = {SHEET: sheet}
        if styles is not None:
            self.parts[STYLE] = styles
        self.maximum_read = 0

    def getinfo(self, path):
        value = self.parts[path]
        return SimpleNamespace(file_size=len(value), compress_size=len(value))

    def open(self, path):
        stream = BytesIO(self.parts[path]); read = stream.read

        def bounded(n):
            self.maximum_read = max(self.maximum_read, n)
            return read(n)
        stream.read = bounded
        return stream


def worksheet(body):
    return f'<worksheet xmlns="{NS}"><sheetData>{body}</sheetData></worksheet>'.encode()


def styles(extra=''):
    return (f'<styleSheet xmlns="{NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.000"/></numFmts>'
            f'{extra}<cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>').encode()


def read(archive, rows=(2, 3)):
    items = [{'source_row': row} for row in rows]
    weight_metadata(SimpleNamespace(_archive=archive), SimpleNamespace(_worksheet_path=SHEET), items,
                    {'gross_weight': 'K', 'net_weight': 'L'})
    return items


class WeightMetadataTests(unittest.TestCase):
    def test_shared_formulas_and_separate_formats_with_missing_cells(self):
        archive = Archive(worksheet('<row r="2"><c r="K2" s="1"><f t="shared" si="0" ref="K2:K3">INT(J2*P2)</f></c>'
                                    '<c r="L2"><f>J2*Q2</f></c></row><row r="3"><c r="K3" s="1"><f t="shared" si="0"/></c></row>'), styles())
        first, second = read(archive)
        self.assertEqual('Truncate', first['gross_weight_rule'])
        self.assertEqual('Truncate', second['gross_weight_rule'])
        self.assertEqual('0.000', second['gross_weight_format'])
        self.assertEqual('Exact', first['net_weight_rule'])
        self.assertEqual('General', second['net_weight_format'])
        self.assertLessEqual(archive.maximum_read, 32768)

    def test_guarded_int_and_no_styles_keep_the_int_rule(self):
        archive = Archive(worksheet('<row><c r="K2"><f>IF(OR(J2="",P2=""),"",INT(J2*P2))</f></c></row>'))
        self.assertEqual('Truncate', read(archive, (2,))[0]['weight_rule'])

    def test_unused_style_fonts_do_not_accumulate(self):
        extra = '<fonts count="50000">' + '<font><name val="synthetic"/><sz val="11"/></font>' * 50000 + '</fonts>'
        archive = Archive(worksheet('<row><c r="K2" s="1"/></row>'), styles(extra))
        tracemalloc.start()
        try:
            self.assertEqual('0.000', read(archive, (2,))[0]['gross_weight_format'])
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * 1024 * 1024)

    def test_invalid_xml_styles_and_unresolved_shared_formulas_fail_static(self):
        for archive in [Archive(b'<!DOCTYPE worksheet [<!ENTITY x "hidden">]><worksheet xmlns="'+NS.encode()+b'">&x;</worksheet>'),
                        Archive(worksheet('<row><c r="K2" s="999"/></row>'), styles()),
                        Archive(worksheet('<row><c r="K2"><f><c r="K2"/></f></c></row>'), styles()),
                        Archive(worksheet('<row><c r="K2"><f t="shared" si="missing"/></c></row>'), styles()),
                        Archive(worksheet('<row><c r="K2"><f>'+'X'*4097+'</f></c></row>'), styles())]:
            with self.assertRaisesRegex(ValueError, '^'+ERROR+'$'):
                read(archive, (2,))

    def test_byte_limits_and_memory_error_are_not_silently_ignored(self):
        archive = Archive(worksheet(''))
        with patch.object(archive, 'getinfo', return_value=SimpleNamespace(file_size=64*1024*1024+1, compress_size=1)), self.assertRaisesRegex(ValueError, '^'+ERROR+'$'):
            read(archive)
        with patch.object(archive, 'open', side_effect=MemoryError()), self.assertRaises(MemoryError):
            read(archive)


if __name__ == '__main__':
    unittest.main()
