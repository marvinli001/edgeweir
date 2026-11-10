# SPDX-License-Identifier: MIT
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import json
import re
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


verify = load("ci_verify", "scripts/ci-verify.py")
plan = load("ci_plan", "scripts/ci-plan.py")
SHA, TREE = "a" * 40, "b" * 40


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.at = verify.now()
        self.config = {"repository": "owner/repo", "branch": "main", "hash": "policy",
                       "stages": {"checks": "printf checks", "containers": "printf containers"}, "cleanup": "true"}
        self.receipt = {"format": 1, "repository": "owner/repo", "source": {"sha": SHA, "tree": TREE},
                        "policy": "policy", "origin": "instabox", "complete": True,
                        "started": (self.at - dt.timedelta(minutes=2)).isoformat(),
                        "finished": (self.at - dt.timedelta(minutes=1)).isoformat(),
                        "stages": [{"name": name, "exit_code": 0, "log_sha256": "c" * 64,
                                    "command_sha256": verify.sha256(cmd.encode())}
                                   for name, cmd in self.config["stages"].items()]}

    def validate(self):
        return verify.validate(self.receipt, self.config, SHA, TREE, self.at)

    def test_accepts_complete_exact_source(self):
        self.assertIs(self.validate(), self.receipt)

    def test_rejects_other_source_repository_policy_and_partial_completion(self):
        for path, value in [("repository", "attacker/repo"), ("policy", "old"), ("complete", False), ("origin", "laptop")]:
            with self.subTest(path=path):
                saved = self.receipt[path]
                self.receipt[path] = value
                with self.assertRaises(ValueError): self.validate()
                self.receipt[path] = saved
        for key in ["sha", "tree"]:
            saved = self.receipt["source"][key]
            self.receipt["source"][key] = "d" * 40
            with self.assertRaises(ValueError): self.validate()
            self.receipt["source"][key] = saved

    def test_rejects_failed_missing_reordered_or_changed_stages(self):
        original = copy.deepcopy(self.receipt["stages"])
        for stages in [original[:-1], list(reversed(original)),
                       [{**original[0], "exit_code": 1}, original[1]],
                       [{**original[0], "command_sha256": "other"}, original[1]]]:
            self.receipt["stages"] = stages
            with self.assertRaises(ValueError): self.validate()

    def test_rejects_stale_future_and_reversed_timestamps(self):
        for start, finish in [(self.at - dt.timedelta(days=9), self.at - dt.timedelta(days=8)),
                              (self.at, self.at + dt.timedelta(days=1)),
                              (self.at, self.at - dt.timedelta(minutes=1))]:
            self.receipt.update(started=start.isoformat(), finished=finish.isoformat())
            with self.assertRaises(ValueError): self.validate()

    def test_malformed_records_cannot_grant_reuse(self):
        for bad in [None, [], "passed"]:
            with self.assertRaises(ValueError): verify.validate(bad, self.config, SHA, TREE, self.at)
        for field, value in [("stages", [None]), ("stages", {}), ("started", None),
                             ("started", "2026-11-10T00:00:00"), ("candidate", "latest")]:
            receipt = {**self.receipt, field: value}
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                verify.validate(receipt, self.config, SHA, TREE, self.at)

    def test_rejects_other_candidate_repository_revision_and_architecture(self):
        self.config["image"] = "ghcr.io/owner/repo"
        candidate = {"image": self.config["image"], "digest": "sha256:" + "d" * 64,
                     "revision": SHA, "platforms": ["linux/amd64", "linux/arm64"]}
        self.receipt["candidate"] = candidate
        self.validate()
        for key, bad in [("image", "ghcr.io/attacker/repo"), ("digest", "latest"),
                         ("revision", "d" * 40), ("platforms", ["linux/amd64"])]:
            with self.subTest(key=key):
                self.receipt["candidate"] = {**candidate, key: bad}
                with self.assertRaises(ValueError): self.validate()

    def test_node_revision_is_part_of_acceptance(self):
        with tempfile.TemporaryDirectory() as tmp:
            pin = Path(tmp) / "node"
            pin.write_text("d" * 40 + "\n")
            self.config["node_revision"] = str(pin)
            self.receipt["node_revision"] = "e" * 40
            with self.assertRaises(ValueError): self.validate()
            self.receipt["node_revision"] = "d" * 40
            self.validate()

    def mock_evidence(self, creator="owner", state="success", newer_failure=False):
        raw = json.dumps(self.receipt).encode()
        blob_sha = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
        status = {"context": verify.CONTEXT, "state": state, "creator": {"login": creator},
                  "created_at": self.receipt["finished"],
                  "target_url": f"https://api.github.com/repos/owner/repo/git/blobs/{blob_sha}"}
        def fake_api(path, **kwargs):
            if "/statuses?" in path: return [[status]]
            if "/git/blobs/" in path: return {"content": base64.b64encode(raw).decode()}
            if "/git/commits/" in path: return {"tree": {"sha": TREE}}
            if "/actions/workflows/" in path:
                return {"workflow_runs": [{"conclusion": "failure", "updated_at": self.at.isoformat()}] if newer_failure else []}
            raise AssertionError(path)
        return fake_api

    def test_authenticates_immutable_evidence_from_owner(self):
        with patch.object(verify, "api", side_effect=self.mock_evidence()):
            self.assertEqual(verify.lookup(self.config, SHA), self.receipt)

    def test_rejects_impostor_pending_and_failed_status(self):
        for creator, state in [("attacker", "success"), ("owner", "pending"), ("owner", "failure")]:
            with patch.object(verify, "api", side_effect=self.mock_evidence(creator, state)):
                self.assertIsNone(verify.lookup(self.config, SHA))

    def test_new_failure_invalidates_older_success(self):
        with patch.object(verify, "api", side_effect=self.mock_evidence(newer_failure=True)):
            with self.assertRaises(ValueError): verify.lookup(self.config, SHA)

    def test_log_hash_change_prevents_publication_before_any_api_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "receipt.json"
            path.write_text(json.dumps(self.receipt))
            for stage in self.receipt["stages"]:
                (directory / f"{stage['name']}.log").write_text("changed output")
            with patch.object(verify, "source", return_value={"sha": SHA, "tree": TREE}), patch.object(verify, "api") as api:
                with self.assertRaises(ValueError): verify.publish(path, self.config)
                api.assert_not_called()

    def test_expired_candidate_artifacts_are_not_reused(self):
        run = {"id": 7, "head_branch": "main", "updated_at": self.at.isoformat()}
        def fake(path, **kwargs):
            if "/workflows/" in path: return {"workflow_runs": [run]}
            return {"artifacts": [{"name": "candidate-image", "expired": True}]}
        with patch.object(verify, "api", side_effect=fake):
            self.assertIsNone(verify.candidate_run(self.config, SHA, 7))

    def test_partial_ci_is_not_complete_acceptance(self):
        run = {"id": 7, "head_branch": "main", "event": "workflow_dispatch", "conclusion": "success", "updated_at": self.at.isoformat()}
        for conclusion in ["skipped", "failure", "success"]:
            def fake(path, **kwargs):
                return {"workflow_runs": [run]} if "/workflows/" in path else [{"jobs": [{"name": "full-acceptance", "run_attempt": 1, "conclusion": conclusion}]}]
            with patch.object(verify, "api", side_effect=fake):
                self.assertEqual(verify.ci_run(self.config, SHA), 7 if conclusion == "success" else None)

    def test_new_failed_ci_does_not_reuse_older_full_run(self):
        runs = [{"id": n, "head_branch": "main", "event": "workflow_dispatch", "conclusion": c, "updated_at": self.at.isoformat()}
                for n, c in [(8, "failure"), (7, "success")]]
        with patch.object(verify, "api", return_value={"workflow_runs": runs}):
            self.assertIsNone(verify.ci_run(self.config, SHA))

    def test_failed_command_or_cleanup_never_records_completion(self):
        for stages, cleanup in [({"checks": "exit 3"}, "true"), ({"checks": "printf ok"}, "exit 4")]:
            with self.subTest(stages=stages, cleanup=cleanup), tempfile.TemporaryDirectory() as tmp:
                cfg = {**self.config, "stages": stages, "cleanup": cleanup}
                directory = Path(tmp) / "result"
                exists = Path.exists
                with patch.object(verify, "source", return_value={"sha": SHA, "tree": TREE}), \
                     patch.object(verify, "runtime_versions", return_value={}), \
                     patch.object(Path, "exists", lambda p: True if str(p) == "/data/locks/heavy.lock" else exists(p)):
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        verify.run(cfg, directory)
                self.assertFalse(json.loads((directory / "receipt.json").read_text())["complete"])

    def test_successful_run_can_be_published_and_authenticated(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'result'
            exists = Path.exists
            with patch.object(verify, 'source', return_value={'sha': SHA, 'tree': TREE}), \
                 patch.object(verify, 'runtime_versions', return_value={}), \
                 patch.object(Path, 'exists', lambda p: True if str(p) == '/data/locks/heavy.lock' else exists(p)):
                verify.run(self.config, directory)
            receipt = json.loads((directory / 'receipt.json').read_text())
            self.assertTrue(receipt['complete'])
            writes = []
            def fake(path, data=None, **kwargs):
                if path == 'user': return {'login': 'owner'}
                if path == 'repos/owner/repo': return {'private': False}
                if '/commits/main' in path: return {'sha': SHA}
                if path.endswith('/git/blobs'):
                    writes.append(('blob', json.loads(data['content'])))
                    return {'sha': 'd' * 40}
                if '/statuses/' in path:
                    writes.append(('status', data))
                    return {}
                raise AssertionError(path)
            with patch.object(verify, 'source', return_value={'sha': SHA, 'tree': TREE}), patch.object(verify, 'api', side_effect=fake):
                verify.publish(directory / 'receipt.json', self.config)
            self.assertEqual([kind for kind, value in writes], ['blob', 'status'])
            self.assertEqual(writes[1][1]['state'], 'success')
            self.receipt = writes[0][1]
            with patch.object(verify, 'api', side_effect=self.mock_evidence()):
                self.assertEqual(verify.lookup(self.config, SHA)['source']['sha'], SHA)

    def test_runtime_mismatch_is_not_a_reusable_result(self):
        self.config['node_version'] = '24.22.1'
        self.receipt['tools'] = {'node': '22.18.0'}
        with self.assertRaises(ValueError): self.validate()
        self.receipt['tools']['node'] = '24.22.1'
        self.validate()


class SelectionTests(unittest.TestCase):
    def test_documentation_does_not_start_product_acceptance(self):
        for repo in ["edgeweir", "edgeweir-node", "edgeweir-business", "edgeweir-cloud"]:
            result = plan.select(repo, ["README.md", "docs/中文.md", ".github/assets/screenshot.png"])
            self.assertFalse(result["product"], repo)

    def test_embedded_installation_docs_remain_build_inputs(self):
        self.assertTrue(plan.select("edgeweir-business", ["docs/site/operations/upgrade.md"])["containers"])

    def test_scoped_core_ui_preserves_dependency_selection_and_main_is_full(self):
        files = ["apps/console/src/web/routes/_app/purge.tsx"]
        partial = plan.select("edgeweir", files)
        self.assertEqual(partial["e2e_sections"], "m2")
        self.assertFalse(partial["full"])
        full = plan.select("edgeweir", files, default_branch=True)
        self.assertTrue(full["full"])
        self.assertEqual(full["e2e_sections"], "")

    def test_unknown_shared_and_server_changes_require_full_acceptance(self):
        for repo, path in [("edgeweir", "packages/db/migrations/new.sql"), ("edgeweir-cloud", "src/server/auth.ts"),
                           ("edgeweir-business", "src/server/payments.ts")]:
            self.assertTrue(plan.select(repo, [path])["full"])

    def test_private_ui_does_not_restart_backend_acceptance(self):
        for repo in ["edgeweir-business", "edgeweir-cloud"]:
            selected = plan.select(repo, ["src/web/pages/example.tsx"])
            self.assertTrue(selected["browser"])
            self.assertTrue(selected["containers"])
            self.assertFalse(selected["integration"])
            self.assertFalse(selected["full"])

    def test_lua_changes_still_run_real_node_containers(self):
        selected = plan.select("edgeweir-node", ["lua/edgeweir/cache.lua"])
        self.assertTrue(selected["lua"])
        self.assertTrue(selected["containers"])
        self.assertFalse(selected["checks"])

    def test_force_full_is_available_even_for_docs(self):
        for repo in ["edgeweir", "edgeweir-node", "edgeweir-business", "edgeweir-cloud"]:
            self.assertTrue(plan.select(repo, ["README.md"], force_full=True)["full"])


class ImageTests(unittest.TestCase):
    @unittest.skipUnless(Path("scripts/ci-image.py").exists(), "Node publishes architecture-native release artifacts")
    def test_verifies_both_platforms_labels_and_the_exact_raw_digest(self):
        image = load("ci_image", "scripts/ci-image.py")
        config = {"image": "ghcr.io/owner/repo"}
        raw = json.dumps({"manifests": [{"platform": {"os": "linux", "architecture": arch}} for arch in ["amd64", "arm64"]]}).encode() + b"\n"
        labels = {"org.opencontainers.image.revision": SHA, "org.opencontainers.image.version": "20261110-aaaaaaa"}
        def output(args, **kwargs):
            return raw if "--raw" in args else json.dumps({"architecture": args[args.index('--override-arch') + 1], "os": "linux", "config": {"Labels": labels}})
        with patch.object(image.subprocess, "check_output", side_effect=output):
            accepted = image.inspect_image("oci-archive:test", config, SHA, "20261110-aaaaaaa")
            self.assertEqual(accepted["digest"], "sha256:" + hashlib.sha256(raw).hexdigest())
            with self.assertRaises(ValueError): image.inspect_image("oci-archive:test", config, "d" * 40, "20261110-aaaaaaa")


class SuiteInventoryTests(unittest.TestCase):
    @unittest.skipUnless(Path("scripts/test-suites.ts").exists(), "Cloud splits service-free tests")
    def test_cloud_split_keeps_every_test_file_exactly_once(self):
        scripts = Path("scripts/test-local.ts").read_text() + Path("scripts/test-suites.ts").read_text() + Path("scripts/ci-accept.sh").read_text()
        selected = re.findall(r"\b(tests/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]s)\b", scripts)
        discovered = {str(p) for pattern in ["*.test.ts", "*.test.mjs"] for p in Path("tests").glob(pattern)}
        self.assertEqual(set(selected), discovered)
        self.assertEqual(len(selected), len(set(selected)))


if __name__ == "__main__":
    unittest.main()
