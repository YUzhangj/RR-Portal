"""Run the incoming workflow's actual stations guard against a local fake Docker."""

import json
import os
from pathlib import Path
import subprocess
import tempfile
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = (ROOT / ".github/workflows/deploy.yml").read_text()
START = WORKFLOW.index("            sync_printlink_stations() (\n")
END = WORKFLOW.index("\n            PRINTLINK_STATIONS=", START)
GUARD = textwrap.dedent(WORKFLOW[START:END])
FIXTURE_TOKEN = "fixture-private-station-token"
OLD = json.dumps([{"id": "fixture", "token": FIXTURE_TOKEN, "name": "old"}])
NEW = json.dumps([{"id": "fixture", "token": FIXTURE_TOKEN, "name": "new"}])


class PrintlinkStationsGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name)
        self.bin = self.path / "bin"
        self.bin.mkdir()
        self.private_tmp = self.path / "private-tmp"
        self.private_tmp.mkdir()
        self.stations = self.path / "stations.json"
        self.stations.write_text(OLD)
        self.stations.chmod(0o644)
        docker = self.bin / "docker"
        docker.write_text('''#!/usr/bin/env python3
import json, os, pathlib, stat, sys
p = pathlib.Path(os.environ['FIXTURE_DIR'])
args = sys.argv[1:]
assert args[:5] == ['compose', '-f', 'docker-compose.cloud.yml', '--env-file', '.env.cloud.production']
if 'exec' in args:
    i = args.index('exec')
    assert args[i:i + 5] == ['exec', '-T', 'printlink', 'sh', '-c']
    command = args[-1]
    action = 'read' if command.startswith('if [ -f ') else 'write' if command.startswith('cat > ') else 'verify'
elif 'up' in args:
    action = 'up'
    assert args[-1] == 'printlink' and '--no-deps' in args and '--force-recreate' in args
else:
    raise AssertionError('unexpected Docker command')
modes = [stat.S_IMODE(f.stat().st_mode) for f in (p / 'private-tmp').rglob('*') if f.is_file()]
assert modes and all(mode == 0o600 for mode in modes), 'private temporary files must be 600'
with (p / 'calls').open('a') as f:
    f.write(json.dumps({'action': action, 'args': args, 'modes': modes}) + '\\n')
if os.environ.get('FAIL_STAGE') == action:
    print(os.environ['FIXTURE_TOKEN'])
    print(os.environ['FIXTURE_TOKEN'], file=sys.stderr)
    sys.exit(7)
stations = p / 'stations.json'
if action == 'read':
    if not stations.exists(): sys.exit(3)
    sys.stdout.buffer.write(stations.read_bytes())
elif action == 'write':
    assert 'chmod 600 /app/runtime/stations.json' in command
    stations.write_bytes(sys.stdin.buffer.read())
    stations.chmod(0o600)
elif action == 'verify':
    assert command == 'test -s /app/runtime/stations.json'
    sys.exit(0 if stations.exists() and stations.stat().st_size else 1)
''')
        docker.chmod(0o755)
        sleep = self.bin / "sleep"
        sleep.write_text('''#!/usr/bin/env python3
import json, os, pathlib, sys
assert sys.argv[1:] == ['8']
with (pathlib.Path(os.environ['FIXTURE_DIR']) / 'calls').open('a') as f:
    f.write(json.dumps({'action': 'sleep'}) + '\\n')
''')
        sleep.chmod(0o755)
        compare = self.bin / "cmp"
        compare.write_text('''#!/usr/bin/env python3
import os, sys
if os.environ.get('FAIL_STAGE') == 'compare':
    print(os.environ['FIXTURE_TOKEN'])
    print(os.environ['FIXTURE_TOKEN'], file=sys.stderr)
    sys.exit(2)
os.execv('/usr/bin/cmp', ['cmp', *sys.argv[1:]])
''')
        compare.chmod(0o755)

    def run_guard(self, secret=NEW, fail_stage=""):
        calls = self.path / "calls"
        calls.unlink(missing_ok=True)
        env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
               "TMPDIR": str(self.private_tmp), "FIXTURE_DIR": str(self.path),
               "FIXTURE_TOKEN": FIXTURE_TOKEN, "FAIL_STAGE": fail_stage}
        env.pop("PRINTLINK_STATIONS", None)
        if secret is not None:
            env["PRINTLINK_STATIONS"] = secret
        script = ('set -euo pipefail\n'
                  'trap \'touch "$FIXTURE_DIR/parent-exit-marker"\' EXIT\n'
                  + GUARD + '\nsync_printlink_stations\n')
        result = subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True)
        self.assertNotIn(FIXTURE_TOKEN, result.stdout + result.stderr)
        self.assertEqual(list(self.private_tmp.iterdir()), [], "private temporaries were not removed")
        self.assertTrue((self.path / "parent-exit-marker").exists(), "guard replaced the caller's EXIT trap")
        return result, [json.loads(line) for line in calls.read_text().splitlines()] if calls.exists() else []

    def test_identical_content_has_zero_mutations_and_preserves_permissions(self):
        result, calls = self.run_guard(OLD)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["action"] for call in calls], ["read"])
        self.assertEqual(self.stations.read_text(), OLD)
        self.assertEqual(self.stations.stat().st_mode & 0o777, 0o644)

    def test_changed_content_writes_600_and_recreates_only_printlink_then_verifies(self):
        result, calls = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["action"] for call in calls], ["read", "write", "up", "sleep", "verify"])
        self.assertEqual(self.stations.read_text(), NEW)
        self.assertEqual(self.stations.stat().st_mode & 0o777, 0o600)

    def test_missing_current_file_is_initial_configuration(self):
        self.stations.unlink()
        result, calls = self.run_guard()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual([call["action"] for call in calls], ["read", "write", "up", "sleep", "verify"])
        self.assertEqual(self.stations.read_text(), NEW)

    def test_empty_or_unset_secret_preserves_config_without_even_reading_docker(self):
        for secret in ["", None]:
            with self.subTest(secret=secret):
                result, calls = self.run_guard(secret)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(calls, [])
                self.assertEqual(self.stations.read_text(), OLD)

    def test_read_failure_is_not_unchanged_or_permission_to_overwrite(self):
        result, calls = self.run_guard(OLD, "read")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call["action"] for call in calls], ["read"])
        self.assertEqual(self.stations.read_text(), OLD)
        self.assertIn("读取 stations.json 失败", result.stdout)

    def test_comparison_failure_stops_before_any_mutation(self):
        result, calls = self.run_guard(OLD, "compare")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual([call["action"] for call in calls], ["read"])
        self.assertEqual(self.stations.read_text(), OLD)

    def test_failures_do_not_leak_tokens_and_stop_at_the_failed_stage(self):
        expected = {"write": ["read", "write"], "up": ["read", "write", "up"],
                    "verify": ["read", "write", "up", "sleep", "verify"]}
        for stage, actions in expected.items():
            with self.subTest(stage=stage):
                self.stations.write_text(OLD)
                result, calls = self.run_guard(fail_stage=stage)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([call["action"] for call in calls], actions)
                self.assertNotIn(FIXTURE_TOKEN, json.dumps(calls))
                if stage == "write":
                    self.assertEqual(self.stations.read_text(), OLD)

    def test_comparison_is_byte_exact_and_does_not_strip_trailing_newline(self):
        self.stations.write_text(OLD + "\n")
        result, calls = self.run_guard(OLD)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("up", [call["action"] for call in calls])
        self.assertEqual(self.stations.read_text(), OLD)


if __name__ == "__main__":
    unittest.main()
