"""Fail-closed checks for the one permitted Compose environment addition."""

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


if __name__ == "__main__":
    unittest.main()
