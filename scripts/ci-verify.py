#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Edgeweir contributors
"""Run acceptance and authenticate external results through GitHub commit statuses."""

import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

CONTEXT = "edgeweir/instabox-acceptance-v1"
MAX_AGE = dt.timedelta(days=7)
HEX40 = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")


def command(*args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs).strip()


def api(path, data=None, paginate=False):
    args = ["gh", "api", path]
    if paginate:
        args += ["--paginate", "--slurp"]
    if data is not None:
        args += ["--method", "POST", "--input", "-"]
    raw = command(*args, input=json.dumps(data) if data is not None else None)
    return json.loads(raw) if raw else {}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def now():
    return dt.datetime.now(dt.timezone.utc)


def instant(value):
    if not isinstance(value, str):
        raise ValueError("Invalid acceptance timestamp.")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Acceptance timestamps require a timezone.")
    return parsed


def policy():
    path = Path(".github/acceptance.json")
    value = json.loads(path.read_text())
    if os.environ.get("GITHUB_REPOSITORY", value["repository"]) != value["repository"]:
        raise ValueError("The acceptance policy names another GitHub repository.")
    value["hash"] = sha256(path.read_bytes() + Path(__file__).read_bytes())
    return value


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.replace(path)


def summaries(log):
    clean = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", log)
    records = []
    for line in clean.splitlines():
        if re.search(r"(?:\bTests\s+\d+|\b\d+ (?:passed|failed|skipped)\b|^[#ℹ] (?:tests|pass|fail|skipped) \d+|^Ran \d+ tests?)", line):
            records.append(line.strip()[-250:])
    return records


def source():
    if command("git", "status", "--porcelain", "--untracked-files=all"):
        raise ValueError("Acceptance requires a clean committed checkout.")
    return {"sha": command("git", "rev-parse", "HEAD"),
            "tree": command("git", "rev-parse", "HEAD^{tree}")}


def runtime_versions(config):
    versions = {"docker": command("docker", "version", "--format", "{{.Server.Version}}"),
                "compose": command("docker", "compose", "version", "--short"),
                "buildx": command("docker", "buildx", "version")}
    if config.get("node_version"):
        versions["node"] = command("node", "--version").removeprefix("v")
    if config.get("go_version_file"):
        versions["go"] = command("go", "env", "GOVERSION", cwd=Path(config["go_version_file"]).parent)
    return versions


def validate_runtime(tools, config):
    if not isinstance(tools, dict):
        raise ValueError("Invalid acceptance runtime versions.")
    if config.get("node_version") and tools.get("node") != config["node_version"]:
        raise ValueError("Acceptance used a different Node.js version.")
    if config.get("go_version_file"):
        version = re.search(r"^go ([0-9.]+)$", Path(config["go_version_file"]).read_text(), re.M)[1]
        if tools.get("go") != f"go{version}":
            raise ValueError("Acceptance used a different Go toolchain.")


def validate(receipt, config, revision, tree, at=None):
    at = at or now()
    if not isinstance(receipt, dict) or receipt.get("format") != 1 or receipt.get("repository") != config["repository"]:
        raise ValueError("Wrong acceptance repository or format.")
    if receipt.get("source") != {"sha": revision, "tree": tree}:
        raise ValueError("Acceptance belongs to another source checkout.")
    if receipt.get("policy") != config["hash"] or receipt.get("origin") != "instabox":
        raise ValueError("Acceptance policy or execution origin differs.")
    if receipt.get("complete") is not True:
        raise ValueError("Acceptance did not finish successfully.")
    validate_runtime(receipt.get("tools", {}), config)
    started, finished = instant(receipt["started"]), instant(receipt["finished"])
    if (not started <= finished <= at + dt.timedelta(minutes=5)
            or finished - started > dt.timedelta(days=1) or at - finished > MAX_AGE):
        raise ValueError("Acceptance is expired or has invalid timestamps.")
    expected = config["stages"]
    stages = receipt.get("stages", [])
    if not isinstance(stages, list) or any(not isinstance(s, dict) for s in stages):
        raise ValueError("Invalid acceptance stages.")
    if [s.get("name") for s in stages] != list(expected):
        raise ValueError("Acceptance does not cover every required stage.")
    for stage in stages:
        if (stage.get("exit_code") != 0 or stage.get("command_sha256") != sha256(expected[stage["name"]].encode())
                or not isinstance(stage.get("log_sha256"), str)
                or not re.fullmatch(r"[0-9a-f]{64}", stage["log_sha256"])):
            raise ValueError("Acceptance contains a failed or different command.")
    if config.get("node_revision"):
        expected_node = Path(config["node_revision"]).read_text().strip()
        if receipt.get("node_revision") != expected_node:
            raise ValueError("Acceptance used another node revision.")
    candidate = receipt.get("candidate")
    if candidate is not None and (not isinstance(candidate, dict)
                                  or candidate.get("image") != config.get("image")
                                  or candidate.get("revision") != revision
                                  or candidate.get("platforms") != ["linux/amd64", "linux/arm64"]
                                  or not isinstance(candidate.get("digest"), str)
                                  or not DIGEST.fullmatch(candidate["digest"])):
        raise ValueError("Acceptance names an unexpected candidate image.")
    return receipt


def lookup(config, revision):
    repo = config["repository"]
    statuses = [s for page in api(f"repos/{repo}/commits/{revision}/statuses?per_page=100", paginate=True) for s in page]
    status = next((s for s in statuses if s.get("context") == CONTEXT), None)
    if not status or status.get("state") != "success" or status.get("creator", {}).get("login") != repo.split("/")[0]:
        return None
    match = re.fullmatch(rf"https://api\.github\.com/repos/{re.escape(repo)}/git/blobs/([0-9a-f]{{40}})", status.get("target_url", ""))
    if not match:
        raise ValueError("Acceptance has no immutable evidence blob.")
    blob = api(f"repos/{repo}/git/blobs/{match[1]}")
    raw = base64.b64decode(blob["content"], validate=False)
    if hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() != match[1]:
        raise ValueError("Acceptance evidence blob digest differs.")
    commit = api(f"repos/{repo}/git/commits/{revision}")
    receipt = validate(json.loads(raw), config, revision, commit["tree"]["sha"])
    if config.get("image") and not receipt.get("candidate"):
        raise ValueError("Complete image acceptance must identify the tested candidate.")
    issued, finished = instant(status["created_at"]), instant(receipt["finished"])
    if issued < finished - dt.timedelta(minutes=5) or issued - finished > MAX_AGE:
        raise ValueError("Acceptance publication time differs from its validity period.")
    recent = api(f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={revision}&per_page=100")["workflow_runs"]
    if any(r.get("conclusion") == "failure" and instant(r["updated_at"]) > instant(receipt["finished"]) for r in recent):
        raise ValueError("A newer CI failure invalidated this acceptance.")
    return receipt


def ci_run(config, revision):
    repo = config["repository"]
    runs = api(f"repos/{repo}/actions/workflows/ci.yml/runs?head_sha={revision}&per_page=100")["workflow_runs"]
    for run in runs:
        if run["head_branch"] != config["branch"] or run["event"] not in ["push", "workflow_dispatch"]:
            continue
        if run.get("conclusion") != "success":
            return None
        if now() - instant(run["updated_at"]) > MAX_AGE:
            continue
        jobs = [j for page in api(f"repos/{repo}/actions/runs/{run['id']}/jobs?filter=all&per_page=100", paginate=True) for j in page["jobs"]]
        gates = [j for j in jobs if j["name"] == "full-acceptance"]
        if gates and max(gates, key=lambda j: j["run_attempt"])["conclusion"] == "success":
            return run["id"]
    return None


def candidate_run(config, revision, accepted_run=None):
    repo = config["repository"]
    for workflow in ["ci.yml", "image.yml"]:
        runs = api(f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={revision}&status=success&per_page=30")["workflow_runs"]
        for run in runs:
            if run["head_branch"] != config["branch"] or now() - instant(run["updated_at"]) > MAX_AGE:
                continue
            if workflow == "ci.yml" and run["id"] != accepted_run:
                continue
            artifacts = api(f"repos/{repo}/actions/runs/{run['id']}/artifacts?per_page=100")["artifacts"]
            if any(a["name"] == "candidate-image" and not a["expired"] for a in artifacts):
                return run["id"]
    return None


def publish(receipt_path, config, resume=False):
    if resume and not config.get("resume_image"):
        raise ValueError("This repository does not automatically resume image publication.")
    checkout = source()
    receipt = validate(json.loads(receipt_path.read_text()), config, checkout["sha"], checkout["tree"])
    for stage in receipt["stages"]:
        log = receipt_path.parent / f"{stage['name']}.log"
        if sha256(log.read_bytes()) != stage["log_sha256"]:
            raise ValueError("The original acceptance log is absent or changed.")
    repo = config["repository"]
    if api("user")["login"] != repo.split("/")[0]:
        raise ValueError("Only the repository owner's CI identity may attest acceptance.")
    if api(f"repos/{repo}")["private"] != config.get("private", False):
        raise ValueError("The repository visibility differs from the acceptance policy.")
    if api(f"repos/{repo}/commits/{config['branch']}")["sha"] != checkout["sha"]:
        raise ValueError("Publish acceptance only for the remote default-branch tip.")
    if config.get("image"):
        candidate_dir = receipt_path.parent / "candidate"
        command(sys.executable, "scripts/ci-image.py", "push-candidate", "--directory", str(candidate_dir))
        receipt["candidate"] = json.loads((candidate_dir / "candidate.json").read_text())
        validate(receipt, config, checkout["sha"], checkout["tree"])
    raw = json.dumps(receipt, sort_keys=True, separators=(",", ":"))
    blob = api(f"repos/{repo}/git/blobs", {"content": raw, "encoding": "utf-8"})
    api(f"repos/{repo}/statuses/{checkout['sha']}", {
        "state": "success", "context": CONTEXT,
        "description": "Complete InstaBox acceptance; source, policy and logs recorded",
        "target_url": f"https://api.github.com/repos/{repo}/git/blobs/{blob['sha']}",
    })
    write_json(receipt_path, receipt)
    if resume:
        api(f"repos/{repo}/actions/workflows/image.yml/dispatches", {"ref": config["branch"]})


def run(config, directory):
    if sys.platform != "linux" or not Path("/data/locks/heavy.lock").exists():
        raise ValueError("Run acceptance on InstaBox under /data/locks/heavy.lock.")
    checkout = source()
    receipt = {"format": 1, "repository": config["repository"], "source": checkout,
               "policy": config["hash"], "origin": "instabox", "started": now().isoformat(),
               "run_id": uuid.uuid4().hex, "job_id": os.environ.get("INSTABOX_JOB_ID"),
               "tools": runtime_versions(config),
               "complete": False, "stages": []}
    validate_runtime(receipt["tools"], config)
    if config.get("node_revision"):
        receipt["node_revision"] = Path(config["node_revision"]).read_text().strip()
        node = os.environ.get("EDGEWEIR_NODE_CONTEXT", "../edgeweir-node")
        if command("git", "-C", node, "rev-parse", "HEAD") != receipt["node_revision"] or command("git", "-C", node, "status", "--porcelain"):
            raise ValueError("The node checkout must be clean and match the pinned revision.")
    directory.mkdir(parents=True, exist_ok=False)
    env = {k: v for k, v in os.environ.items() if k not in ["GH_TOKEN", "GITHUB_TOKEN"]}
    for key in ["CI_E2E_SECTIONS", "E2E_SUITE", "E2E_DB_SUFFIX", "CLOUD_BROWSER_RUN_ID", "PROTO_TAG"]:
        env.pop(key, None)
    env["CI_ACCEPTANCE_DIR"] = str(directory.resolve())
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.setdefault("COMPOSE_PROJECT_NAME", f"ci-accept-{checkout['sha'][:8]}-{int(time.time())}")
    try:
        for name, script in config["stages"].items():
            started = time.monotonic()
            path = directory / f"{name}.log"
            if name == "containers" and config.get("resume_image"):
                try:
                    built_run = candidate_run(config, checkout["sha"])
                    if built_run:
                        command("gh", "run", "download", str(built_run), "--repo", config["repository"],
                                "--name", "candidate-image", "--dir", str(directory / "candidate"))
                        receipt["candidate_origin"] = {"repository": config["repository"], "run_id": built_run}
                except (ValueError, subprocess.CalledProcessError) as error:
                    print(f"No existing Cloud candidate; build it locally: {error}", file=sys.stderr)
            with path.open("w") as log:
                result = subprocess.run(["bash", "-euo", "pipefail", "-c", script], env=env, stdout=log, stderr=subprocess.STDOUT)
            receipt["stages"].append({"name": name, "exit_code": result.returncode,
                                      "seconds": round(time.monotonic() - started, 3),
                                      "command_sha256": sha256(script.encode()), "log_sha256": sha256(path.read_bytes()),
                                      "summaries": summaries(path.read_text(errors="replace"))})
            print(f"{name}: exit {result.returncode} ({receipt['stages'][-1]['seconds']}s)", flush=True)
            receipt["finished"] = now().isoformat()
            write_json(directory / "receipt.json", receipt)
            if result.returncode:
                raise ValueError(f"Acceptance failed: {path}")
    finally:
        subprocess.run(["bash", "-euo", "pipefail", "-c", config["cleanup"]], env=env, check=True)
    if source() != checkout:
        raise ValueError("The checkout changed during acceptance.")
    receipt["complete"] = True
    receipt["finished"] = now().isoformat()
    validate(receipt, config, checkout["sha"], checkout["tree"])
    write_json(directory / "receipt.json", receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["run", "publish", "lookup", "resolve"])
    parser.add_argument("--directory", type=Path, default=Path(".local/acceptance"))
    parser.add_argument("--sha", default=os.environ.get("GITHUB_SHA"))
    parser.add_argument("--require", action="store_true")
    parser.add_argument("--resume-image", action="store_true")
    args = parser.parse_args()
    config = policy()
    if args.action == "run":
        run(config, args.directory)
        return
    if args.action == "publish":
        publish(args.directory / "receipt.json", config, args.resume_image)
        return
    revision = args.sha or command("git", "rev-parse", "HEAD")
    if not HEX40.fullmatch(revision):
        raise ValueError("Expected a full source commit SHA.")
    result = {"verified": False, "candidate_run_id": "", "candidate_digest": ""}
    try:
        try:
            receipt = lookup(config, revision)
        except (KeyError, ValueError, subprocess.CalledProcessError) as error:
            print(f"No reusable InstaBox result: {error}", file=sys.stderr)
            receipt = None
        accepted_run = ci_run(config, revision) if args.action == "resolve" and not receipt else None
        result["verified"] = bool(receipt or accepted_run)
        if result["verified"] and args.action == "resolve" and config.get("image"):
            result["candidate_digest"] = (receipt or {}).get("candidate", {}).get("digest", "")
            if not result["candidate_digest"]:
                result["candidate_run_id"] = str(candidate_run(config, revision, accepted_run) or "")
            if not result["candidate_digest"] and not result["candidate_run_id"]:
                result["verified"] = False
                print("Accepted source has no retained tested candidate; publication remains blocked.", file=sys.stderr)
            if result["verified"]:
                evidence = Path(".local/ci-candidate/verification.json")
                evidence.parent.mkdir(parents=True, exist_ok=True)
                evidence.write_text(json.dumps({"repository": config["repository"], "revision": revision,
                                                "ci_run_id": accepted_run, "instabox": receipt}, indent=2) + "\n")
    except (KeyError, ValueError, subprocess.CalledProcessError) as error:
        result = {"verified": False, "candidate_run_id": "", "candidate_digest": ""}
        print(f"No reusable acceptance: {error}", file=sys.stderr)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, value in result.items():
                output.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
    print(json.dumps(result))
    if args.require and not result["verified"]:
        raise ValueError("Complete acceptance for this exact commit is required.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
