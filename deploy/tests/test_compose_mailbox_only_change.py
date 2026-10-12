"""Fail-closed checks for the two permitted single-line environment additions."""

import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / "deploy/compose-mailbox-only-change.py"
spec = importlib.util.spec_from_file_location("compose_mailbox_only_change", HELPER)
compose_change = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compose_change)
ADDED_LINE = compose_change.ADDED_LINE
BEFORE = b"""services:
  paiji:
    image: fixture-paiji
    environment:
      TZ: UTC
  voyageplex-api:
    image: fixture-voyageplex
    environment:
      ASPNETCORE_ENVIRONMENT: Production
      SSO_SECRET: ${SSO_SECRET:?required}
    volumes:
      - fixture-data:/app/data
    networks:
      - platform-net
  voyageplex-parser:
    image: fixture-parser
networks:
  platform-net:
    driver: bridge
volumes:
  fixture-data:
"""
AFTER = BEFORE.replace(b"      SSO_SECRET:", ADDED_LINE + b"      SSO_SECRET:")
STATION_LINE = compose_change.STATION_LINE
STATION_BEFORE = AFTER.replace(b"networks:\n  platform-net:", b"""  printlink:
    image: fixture-printlink
    environment:
      COOKIE_SECURE: "false"
    volumes:
      - fixture-data:/app/runtime
networks:
  platform-net:""", 1)
STATION_AFTER = STATION_BEFORE.replace(b'      COOKIE_SECURE: "false"\n',
                                      b'      COOKIE_SECURE: "false"\n' + STATION_LINE)


class ComposeMailboxOnlyTests(unittest.TestCase):
    def assert_rejected(self, before, after):
        self.assertFalse(compose_change.is_mailbox_only_addition(before, after))

    def test_only_exact_addition_under_api_environment_is_allowed(self):
        self.assertTrue(compose_change.is_mailbox_only_addition(BEFORE, AFTER))

    def test_real_compose_has_only_one_candidate_addition(self):
        after = (ROOT / "docker-compose.cloud.yml").read_bytes()
        self.assertEqual(after.count(ADDED_LINE), 1)
        before = after.replace(ADDED_LINE, b"", 1)
        self.assertTrue(compose_change.is_mailbox_only_addition(before, after))

    def test_no_addition_existing_variable_removal_and_value_change_are_rejected(self):
        for before, after in [
            (BEFORE, BEFORE),
            (AFTER, AFTER),
            (AFTER, BEFORE),
            (AFTER, AFTER.replace(b"_JSON:-}", b"_JSON:-[]}")),
            (BEFORE, AFTER.replace(b"_JSON:-}", b"_JSON:-[]}")),
            (BEFORE, AFTER.replace(b": ${VOYAGEPLEX_HUADENG_MAILBOXES_JSON:-}", b": fixture")),
        ]:
            with self.subTest(before=before is AFTER, unchanged=before == after):
                self.assert_rejected(before, after)

    def test_every_additional_change_retains_full_rollout(self):
        mutations = {
            "api image": AFTER.replace(b"fixture-voyageplex", b"fixture-voyageplex-v2"),
            "other service": AFTER.replace(b"fixture-paiji", b"fixture-paiji-v2"),
            "new service": AFTER.replace(b"networks:\n  platform-net:", b"  extra:\n    image: extra\nnetworks:\n  platform-net:"),
            "network": AFTER.replace(b"driver: bridge", b"driver: host"),
            "volume mount": AFTER.replace(b"fixture-data:/app/data", b"fixture-data:/app/new-data"),
            "volume declaration": AFTER.replace(b"  fixture-data:\n", b"  fixture-data:\n    external: true\n"),
            "comment": AFTER + b"# unrelated comment\n",
            "trailing whitespace": AFTER.replace(b"image: fixture-parser\n", b"image: fixture-parser \n"),
            "line endings": AFTER.replace(b"\n", b"\r\n"),
        }
        for name, after in mutations.items():
            with self.subTest(name=name):
                self.assert_rejected(BEFORE, after)

    def test_correct_line_in_other_service_or_wrong_section_is_rejected(self):
        placements = {
            "other service environment": BEFORE.replace(b"      TZ: UTC\n", b"      TZ: UTC\n" + ADDED_LINE),
            "api volumes": BEFORE.replace(b"    volumes:\n", b"    volumes:\n" + ADDED_LINE),
            "service property": BEFORE.replace(b"    image: fixture-parser\n", ADDED_LINE + b"    image: fixture-parser\n"),
            "quoted other service": BEFORE.replace(b"  voyageplex-parser:\n", b"  'voyageplex-parser':\n" + ADDED_LINE),
            "outside services": BEFORE + ADDED_LINE,
            "duplicate": AFTER.replace(ADDED_LINE, ADDED_LINE * 2),
        }
        for name, after in placements.items():
            with self.subTest(name=name):
                self.assert_rejected(BEFORE, after)

    def test_unrecognized_or_ambiguous_yaml_layout_fails_closed(self):
        variants = {
            "block scalar": BEFORE.replace(b"      ASPNETCORE_ENVIRONMENT: Production\n", b"      DESCRIPTION: |\n"),
            "anchor": BEFORE.replace(b"    environment:\n      ASPNETCORE_ENVIRONMENT:", b"    environment: &api_environment\n      ASPNETCORE_ENVIRONMENT:"),
            "duplicate api": BEFORE.replace(b"  voyageplex-parser:\n", b"  voyageplex-api:\n"),
            "duplicate environment": BEFORE.replace(b"    volumes:\n", b"    environment:\n      EXTRA: fixture\n    volumes:\n"),
            "duplicate services": BEFORE + b"services:\n  extra:\n    image: fixture\n",
            "quoted api": BEFORE.replace(b"  voyageplex-api:\n", b"  'voyageplex-api':\n"),
        }
        for name, before in variants.items():
            after = before.replace(b"      SSO_SECRET:", ADDED_LINE + b"      SSO_SECRET:")
            with self.subTest(name=name):
                self.assert_rejected(before, after)

    def test_git_cli_reads_versions_silently_and_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            compose = repo / "docker-compose.cloud.yml"
            hashes = []
            for blob in [BEFORE, AFTER, AFTER + b"# extra change\n"]:
                compose.write_bytes(blob)
                subprocess.run(["git", "add", "docker-compose.cloud.yml"], cwd=repo, check=True)
                subprocess.run([
                    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture",
                ], cwd=repo, check=True)
                hashes.append(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip())
            for before, after, expected in [
                (hashes[0], hashes[1], 0),
                (hashes[0], hashes[2], 1),
                (hashes[1], hashes[1], 1),
                (hashes[1], hashes[0], 1),
                ("0" * 40, hashes[1], 1),
                ("--help", hashes[1], 1),
            ]:
                with self.subTest(expected=expected, before=before, after=after):
                    result = subprocess.run(["python3", str(HELPER), before, after], cwd=repo,
                                            capture_output=True)
                    self.assertEqual(result.returncode, expected)
                    self.assertEqual(result.stdout, b"")
                    self.assertEqual(result.stderr, b"")
                    if expected == 0:
                        named = subprocess.run(["python3", str(HELPER), "--service", before, after],
                                               cwd=repo, capture_output=True)
                        self.assertEqual(named.returncode, 0)
                        self.assertEqual(named.stdout, b"voyageplex-api\n")
                        self.assertEqual(named.stderr, b"")


class ComposeStationOnlyTests(unittest.TestCase):
    def assert_rejected(self, before, after):
        self.assertFalse(compose_change.is_station_only_addition(before, after))
        self.assertIsNone(compose_change.incremental_service(before, after))

    def test_only_printlink_station_addition_and_voyageplex_compatibility(self):
        self.assertTrue(compose_change.is_station_only_addition(STATION_BEFORE, STATION_AFTER))
        self.assertEqual(compose_change.incremental_service(STATION_BEFORE, STATION_AFTER), "printlink")
        self.assertEqual(compose_change.incremental_service(BEFORE, AFTER), "voyageplex-api")
        self.assertFalse(compose_change.is_mailbox_only_addition(STATION_BEFORE, STATION_AFTER))

    def test_real_compose_has_single_station_addition_candidate(self):
        after = (ROOT / "docker-compose.cloud.yml").read_bytes()
        self.assertEqual(after.count(STATION_LINE), 1)
        before = after.replace(STATION_LINE, b"", 1)
        self.assertEqual(compose_change.incremental_service(before, after), "printlink")

    def test_unchanged_removal_existing_variable_and_literal_value_are_rejected(self):
        for before, after in [
            (STATION_BEFORE, STATION_BEFORE),
            (STATION_AFTER, STATION_AFTER),
            (STATION_AFTER, STATION_BEFORE),
            (STATION_BEFORE, STATION_AFTER.replace(b"_STATION:-}", b"_STATION:-fixture}")),
            (STATION_BEFORE, STATION_AFTER.replace(b": ${BUSINESS_SYNC_STATION:-}", b": fixture")),
        ]:
            with self.subTest(unchanged=before == after):
                self.assert_rejected(before, after)

    def test_other_service_network_volume_comment_or_second_addition_is_rejected(self):
        changes = {
            "printlink image": STATION_AFTER.replace(b"fixture-printlink", b"fixture-printlink-v2"),
            "other service": STATION_AFTER.replace(b"fixture-paiji", b"fixture-paiji-v2"),
            "network": STATION_AFTER.replace(b"driver: bridge", b"driver: host"),
            "volume mount": STATION_AFTER.replace(b"fixture-data:/app/runtime", b"fixture-data:/app/new"),
            "volume declaration": STATION_AFTER + b"  second-data:\n",
            "comment": STATION_AFTER + b"# unrelated change\n",
            "line ending": STATION_AFTER.replace(b"\n", b"\r\n"),
        }
        for name, after in changes.items():
            with self.subTest(name=name):
                self.assert_rejected(STATION_BEFORE, after)
        # Two whitelisted additions together are still a general Compose change.
        self.assert_rejected(STATION_BEFORE.replace(ADDED_LINE, b""), STATION_AFTER)

    def test_correct_line_in_wrong_service_or_section_is_rejected(self):
        placements = {
            "other environment": STATION_BEFORE.replace(b"      TZ: UTC\n", b"      TZ: UTC\n" + STATION_LINE),
            "voyageplex environment": STATION_BEFORE.replace(ADDED_LINE, ADDED_LINE + STATION_LINE),
            "printlink volume": STATION_BEFORE.replace(b"      - fixture-data:/app/runtime\n", STATION_LINE + b"      - fixture-data:/app/runtime\n"),
            "outside services": STATION_BEFORE + STATION_LINE,
            "duplicate line": STATION_AFTER.replace(STATION_LINE, STATION_LINE * 2),
        }
        for name, after in placements.items():
            with self.subTest(name=name):
                self.assert_rejected(STATION_BEFORE, after)

    def test_ambiguous_yaml_fails_closed_for_station_as_for_mailbox(self):
        for before in [
            STATION_BEFORE.replace(b'      COOKIE_SECURE: "false"\n', b"      DESCRIPTION: |\n"),
            STATION_BEFORE.replace(b'    environment:\n      COOKIE_SECURE:', b'    environment: &printlink_environment\n      COOKIE_SECURE:'),
            STATION_BEFORE.replace(b"  printlink:\n", b"  'printlink':\n"),
            STATION_BEFORE.replace(b"networks:\n  platform-net:", b"  printlink:\n    image: duplicate\nnetworks:\n  platform-net:"),
        ]:
            anchor = b"    volumes:\n      - fixture-data:/app/runtime\n"
            after = before.replace(anchor, STATION_LINE + anchor)
            self.assert_rejected(before, after)

    def test_git_cli_returns_only_whitelisted_service_when_requested(self):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            hashes = []
            for blob in [STATION_BEFORE, STATION_AFTER, STATION_AFTER + b"# extra change\n"]:
                (repo / "docker-compose.cloud.yml").write_bytes(blob)
                subprocess.run(["git", "add", "docker-compose.cloud.yml"], cwd=repo, check=True)
                subprocess.run([
                    "git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                    "-c", "commit.gpgsign=false", "commit", "-qm", "fixture",
                ], cwd=repo, check=True)
                hashes.append(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip())
            for options, after, code, output in [
                ([], hashes[1], 1, b""),
                (["--service"], hashes[1], 0, b"printlink\n"),
                (["--service"], hashes[2], 1, b""),
                (["--service"], hashes[0], 1, b""),
                (["--service"], "0" * 40, 1, b""),
            ]:
                with self.subTest(options=options, code=code):
                    result = subprocess.run(["python3", str(HELPER), *options, hashes[0], after],
                                            cwd=repo, capture_output=True)
                    self.assertEqual(result.returncode, code)
                    self.assertEqual(result.stdout, output)
                    self.assertEqual(result.stderr, b"")


if __name__ == "__main__":
    unittest.main()
