"""Only the exact Peise vision-model update may use the single-service rollout."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('peise_compose_guard', ROOT / 'deploy/compose-mailbox-only-change.py')
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

BEFORE = (b'services:\n  other:\n    image: fixture-other\n  peise:\n    environment:\n'
          b'      - BASE_PATH=/peise\n' + guard.PEISE_MODEL_BEFORE
          + b'      - AUTH_PASSWORD=${PEISE_AUTH_PASSWORD:-}\n    volumes:\n      - fixture:/app/instance\n'
          b'networks:\n  platform-net:\n    driver: bridge\n')
AFTER = BEFORE.replace(guard.PEISE_MODEL_BEFORE, guard.PEISE_MODEL_AFTER)

class PeiseComposeOnlyTests(unittest.TestCase):
    def test_exact_model_update_selects_only_peise(self):
        self.assertEqual(guard.incremental_service(BEFORE, AFTER), 'peise')

    def test_actual_compose_diff_is_the_reviewed_update_only(self):
        after = (ROOT / 'docker-compose.cloud.yml').read_bytes()
        before = after.replace(guard.PEISE_MODEL_AFTER, guard.PEISE_MODEL_BEFORE, 1)
        self.assertEqual(guard.incremental_service(before, after), 'peise')

    def test_any_additional_runtime_or_literal_change_is_rejected(self):
        for after in [AFTER.replace(b'fixture-other', b'changed-other'), AFTER.replace(b'bridge', b'host'),
                      AFTER.replace(b'fixture:/app/instance', b'fixture:/app/other'), AFTER + b'# other change\n',
                      AFTER.replace(b'${PEISE_AUTH_PASSWORD:-}', b'literal-value'), AFTER.replace(b'qwen3-vl-plus', b'other-model'),
                      AFTER.replace(b'\n', b'\r\n')]:
            with self.subTest(after=after):
                self.assertIsNone(guard.incremental_service(BEFORE, after))

    def test_other_service_wrong_section_duplicate_or_quoted_layout_is_rejected(self):
        for before in [BEFORE.replace(b'  peise:', b'  wrong-service:'), BEFORE.replace(b'    environment:', b'    volumes:'),
                       BEFORE.replace(b'  peise:', b'  "peise":'), BEFORE + b'services:\n',
                       BEFORE.replace(b'    volumes:', b'    environment:\n      - EXTRA=fixture\n    volumes:'),
                       BEFORE.replace(b'      - BASE_PATH=/peise', b'      - NOTE="unterminated')]:
            with self.subTest(before=before):
                self.assertIsNone(guard.incremental_service(before, before.replace(guard.PEISE_MODEL_BEFORE,guard.PEISE_MODEL_AFTER)))

    def test_noop_reversal_and_two_allowed_changes_fail_closed(self):
        for before, after in [(BEFORE, BEFORE),(AFTER, AFTER),(AFTER, BEFORE),
                              (BEFORE, AFTER + guard.STATION_LINE)]:
            self.assertIsNone(guard.incremental_service(before,after))

    def test_duplicate_environment_keys_fail_closed(self):
        for duplicate in [b'      - BAILIAN_MODEL=synthetic-other-model\n',b'      - AUTH_PASSWORD=fixture\n']:
            before=BEFORE.replace(b'    volumes:',duplicate+b'    volumes:')
            self.assertIsNone(guard.incremental_service(before,before.replace(guard.PEISE_MODEL_BEFORE,guard.PEISE_MODEL_AFTER)))

    def test_other_service_multiline_quoted_and_flow_values_cannot_fake_peise(self):
        for opener,closer in [(b'"',b'"'),(b"'",b"'"),(b'["',b'"]'),(b'{note: "',b'"}')]:
            before=(b'services:\n  other:\n    environment:\n      - '+opener+b'NOTE=synthetic\n'
                    b'  peise:\n    environment:\n'+guard.PEISE_MODEL_BEFORE+b'    dummy: end'+closer+b'\n')
            self.assertIsNone(guard.incremental_service(before,before.replace(guard.PEISE_MODEL_BEFORE,guard.PEISE_MODEL_AFTER)))

    def test_quoted_unicode_and_tagged_mapping_keys_cannot_hide_multiline_values(self):
        for key in [b'"NOTE"',b"'NOTE'",'说明'.encode(),b'!!str NOTE',b'? NOTE',b'NOTE:INNER']:
            before=(b'services:\n  other:\n    environment:\n      '+key+b': "synthetic\n'
                    b'  peise:\n    environment:\n'+guard.PEISE_MODEL_BEFORE+b'    dummy: end"\n')
            with self.subTest(key=key):
                self.assertIsNone(guard.incremental_service(before,before.replace(guard.PEISE_MODEL_BEFORE,guard.PEISE_MODEL_AFTER)))

    def test_sequence_quoted_colons_and_inline_mapping_values_fail_closed(self):
        for item in [b'"NOTE=http: synthetic',b'NOTE: "synthetic',b'"NOTE": "synthetic']:
            before=(b'services:\n  other:\n    environment:\n      - '+item+b'\n'
                    b'  peise:\n    environment:\n'+guard.PEISE_MODEL_BEFORE+b'    dummy: end"\n')
            self.assertIsNone(guard.incremental_service(before,before.replace(guard.PEISE_MODEL_BEFORE,guard.PEISE_MODEL_AFTER)))

if __name__ == '__main__':
    unittest.main()
