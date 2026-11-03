"""Exercise the workflow's real Git asset guard with local synthetic branches."""

from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = "apps/船务部/VoyagePlex船务协同系统/components/app-shell.tsx"
SOURCE_PATHS = [SOURCE_PATH, "apps/船务部/VoyagePlex船务协同系统/server/VoyagePlex.Api/Program.cs"]
SNAPSHOT_FIXTURE = b"const " + b"SNAPSHOT = {fixture: true};\n"
WORKFLOW = ROOT / ".github/workflows/factory-review-restore-contract.yml"
GUARD = textwrap.dedent(WORKFLOW.read_text().split(
    "      - name: Check diff and branch-only assets\n        shell: bash\n        run: |\n", 1
)[1])


class BranchAssetGuardTests(unittest.TestCase):
    def run_guard(self, filename, content):
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            subprocess.run(["git", "init", "-q", tmp], check=True)
            commit = ["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]
            (repo / "base.txt").write_text("fixture\n")
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(commit, cwd=repo, check=True)
            subprocess.run(["git", "update-ref", "refs/remotes/origin/main", "HEAD"], cwd=repo, check=True)
            asset = repo / filename
            asset.parent.mkdir(parents=True, exist_ok=True)
            asset.write_bytes(content)
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(commit, cwd=repo, check=True)
            return subprocess.run(["bash", "-c", GUARD], cwd=repo, capture_output=True, text=True)

    def test_exact_source_path_may_exceed_size_threshold(self):
        for path in SOURCE_PATHS:
            with self.subTest(path=path):
                result = self.run_guard(path, b"// fixture source\n" * 4000)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_other_source_path_still_fails_size_guard(self):
        result = self.run_guard(SOURCE_PATH.replace("app-shell.tsx", "app-shell-copy.tsx"), b"// fixture\n" * 5001)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("larger than 50000 bytes", result.stderr)

    def test_generic_large_export_still_fails_size_guard(self):
        result = self.run_guard("fixture-export.json", b'{"fixture":"' + b"a" * 50001 + b'"}\n')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("larger than 50000 bytes", result.stderr)

    def test_snapshot_in_exempt_source_is_still_rejected(self):
        for path in SOURCE_PATHS:
            with self.subTest(path=path):
                result = self.run_guard(path, SNAPSHOT_FIXTURE + b"// fixture\n" * 5001)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Plaintext non-empty private snapshot", result.stderr)

    def test_small_snapshot_and_database_assets_are_still_rejected(self):
        for path, content, message in [
            ("fixture-snapshot.js", SNAPSHOT_FIXTURE, "Plaintext non-empty private snapshot"),
            ("fixture.db", b"fixture database asset\n", "Private restore asset detected"),
        ]:
            with self.subTest(path=path):
                result = self.run_guard(path, content)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
