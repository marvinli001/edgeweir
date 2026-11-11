# SPDX-License-Identifier: MIT
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class CandidateWaitTests(unittest.TestCase):
    def wait(self, responses):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            (directory / "responses.json").write_text(json.dumps(responses))
            gh = directory / "gh"
            gh.write_text("""#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
directory = Path(os.environ['WAIT_FIXTURE'])
path = directory / 'responses.json'
responses = json.loads(path.read_text())
code, output = responses.pop(0)
path.write_text(json.dumps(responses))
print(output, file=sys.stderr if code else sys.stdout)
sys.exit(code)
""")
            gh.chmod(0o755)
            sleep = directory / "sleep"
            sleep.write_text("#!/usr/bin/env bash\nexit 0\n")
            sleep.chmod(0o755)
            result = subprocess.run(
                ["bash", "scripts/ci-wait-image.sh"],
                env={**os.environ, "PATH": f"{directory}:{os.environ['PATH']}",
                     "WAIT_FIXTURE": str(directory), "GITHUB_REPOSITORY": "owner/repo",
                     "GITHUB_RUN_ID": "123"},
                text=True, capture_output=True, timeout=5,
            )
            self.assertEqual(json.loads((directory / "responses.json").read_text()), [])
            return result

    def test_waits_for_the_candidate_then_exits_successfully(self):
        result = self.wait([[0, "waiting (queued)"], [0, "waiting (in_progress)"], [0, "ready"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("candidate image ready", result.stdout)

    def test_failed_cancelled_or_skipped_build_stops_the_wait(self):
        for conclusion in ["failure", "cancelled", "skipped"]:
            with self.subTest(conclusion=conclusion):
                result = self.wait([[0, f"failed: {conclusion}"]])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"failed: {conclusion}", result.stderr)

    def test_transient_api_failure_is_retried(self):
        result = self.wait([[1, "temporary API failure"], [0, "ready"]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("waiting (API: temporary API failure)", result.stdout)
