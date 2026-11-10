#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Edgeweir contributors
"""Build, inspect, test and promote one immutable multi-platform OCI candidate."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys


def capture(*args):
    return subprocess.check_output(args, text=True).strip()


def execute(*args):
    subprocess.run(args, check=True)


def inspect_image(reference, config, revision, version):
    raw = subprocess.check_output(["skopeo", "inspect", "--raw", reference])
    manifest = json.loads(raw)
    platforms = sorted({f"{m['platform']['os']}/{m['platform']['architecture']}"
                        for m in manifest.get("manifests", []) if m.get("platform", {}).get("os") == "linux"})
    if platforms != ["linux/amd64", "linux/arm64"]:
        raise ValueError("A release candidate must contain linux/amd64 and linux/arm64.")
    for arch in ["amd64", "arm64"]:
        image = json.loads(capture("skopeo", "inspect", "--override-os", "linux", "--override-arch", arch, "--config", reference))
        if image.get("architecture") != arch or image.get("os") != "linux":
            raise ValueError(f"The {arch} descriptor does not contain a matching Linux runtime.")
        labels = image.get("config", {}).get("Labels", {})
        if labels.get("org.opencontainers.image.revision") != revision or labels.get("org.opencontainers.image.version") != version:
            raise ValueError(f"The {arch} candidate has different source/version labels.")
    return {"image": config["image"], "digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "revision": revision, "version": version, "platforms": platforms}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["build", "inspect", "load", "smoke", "push-candidate", "promote"])
    parser.add_argument("--directory", type=Path, default=Path(".local/ci-candidate"))
    parser.add_argument("--digest")
    args = parser.parse_args()
    config = json.loads(Path(".github/acceptance.json").read_text())
    if config["image"] != f"ghcr.io/{config['repository']}":
        raise ValueError("Candidates may only use this repository's GHCR package.")
    local_image = os.environ.get("CI_LOCAL_IMAGE", config["local_image"])
    revision = capture("git", "rev-parse", "HEAD")
    version = capture("bash", "scripts/image-version.sh")
    if args.digest and not re.fullmatch(r"sha256:[0-9a-f]{64}", args.digest):
        raise ValueError("Expected an immutable image digest.")
    directory = args.directory
    archive = directory / "image.tar"
    metadata = directory / "candidate.json"
    if args.action == "build" and not archive.exists():
        directory.mkdir(parents=True, exist_ok=True)
        cmd = ["docker", "buildx", "build", "--platform", "linux/amd64,linux/arm64",
               "--output", f"type=oci,dest={archive}", "--provenance=mode=max", "--sbom=true",
               "--build-arg", f"VERSION={version}", "--build-arg", f"REVISION={revision}",
               "--label", f"org.opencontainers.image.created={capture('git', 'log', '-1', '--format=%cI')}"]
        if Path("control-component.json").exists():
            control = json.loads(Path("control-component.json").read_text())
            cmd += ["--build-arg", f"BUNDLED_CONTROL_IMAGE={control['image']}"]
        os.environ["SOURCE_DATE_EPOCH"] = capture("git", "log", "-1", "--format=%ct")
        execute(*cmd, ".")
    reference = f"docker://{config['image']}@{args.digest}" if args.digest else f"oci-archive:{archive.resolve()}"
    candidate = inspect_image(reference, config, revision, version)
    if args.digest and candidate["digest"] != args.digest:
        raise ValueError("The registry returned a different candidate digest.")
    if not args.digest:
        with archive.open("rb") as image_file:
            candidate["archive_sha256"] = hashlib.file_digest(image_file, "sha256").hexdigest()
        if metadata.exists() and json.loads(metadata.read_text()) != candidate:
            raise ValueError("The candidate archive or metadata changed after acceptance.")
        metadata.write_text(json.dumps(candidate, indent=2) + "\n")
    if args.action in ["load", "smoke"]:
        if args.digest:
            execute("docker", "pull", f"{config['image']}@{args.digest}")
            execute("docker", "tag", f"{config['image']}@{args.digest}", local_image)
        else:
            arch = capture("docker", "version", "--format", "{{.Server.Arch}}")
            execute("skopeo", "copy", "--override-os", "linux", "--override-arch", arch,
                    reference, f"docker-daemon:{local_image}")
        if args.action == "smoke":
            execute("docker", "run", "--rm", "--network", "none", "--entrypoint", "node", local_image,
                    "-e", "const fs=require('node:fs'); fs.accessSync(process.argv[1]); if(process.getuid()===0 || (process.argv[2] && process.versions.node!==process.argv[2]))process.exit(1); console.log(process.version,process.arch)",
                    config["entrypoint"], config.get("node_version", ""))
    if args.action == "push-candidate":
        if config.get("private"):
            visibility = capture("gh", "api", f"users/{config['repository'].split('/')[0]}/packages/container/{config['repository'].split('/')[1]}", "--jq", ".visibility")
            if visibility != "private":
                raise ValueError("The commercial GHCR package must remain private.")
        execute("skopeo", "copy", "--all", "--preserve-digests", reference,
                f"docker://{config['image']}:candidate-{revision}")
        remote = inspect_image(f"docker://{config['image']}@{candidate['digest']}", config, revision, version)
        if remote["digest"] != candidate["digest"]:
            raise ValueError("The pushed candidate digest differs.")
    if args.action == "promote":
        if config.get("private"):
            visibility = capture("gh", "api", f"users/{config['repository'].split('/')[0]}/packages/container/{config['repository'].split('/')[1]}", "--jq", ".visibility")
            if visibility != "private":
                raise ValueError("The commercial GHCR package must remain private.")
        tag = f"{config['image']}:{version}"
        if args.digest:
            execute("docker", "buildx", "imagetools", "create", "--tag", tag, f"{config['image']}@{args.digest}")
        else:
            execute("skopeo", "copy", "--all", "--preserve-digests", reference, f"docker://{tag}")
        actual = json.loads(capture("docker", "buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"))["digest"]
        if actual != candidate["digest"]:
            raise ValueError("Published image does not match the tested candidate.")
        tip = capture("gh", "api", f"repos/{config['repository']}/commits/{config['branch']}", "--jq", ".sha")
        if tip == revision:
            execute("docker", "buildx", "imagetools", "create", "--tag", f"{config['image']}:latest", f"{config['image']}@{actual}")
        if os.environ.get("GITHUB_OUTPUT"):
            with open(os.environ["GITHUB_OUTPUT"], "a") as output:
                output.write(f"is_tip={str(tip == revision).lower()}\n")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"digest={candidate['digest']}\nversion={version}\nrevision={revision}\n")
    print(json.dumps(candidate))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
