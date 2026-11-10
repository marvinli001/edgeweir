#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Edgeweir contributors
"""Select acceptance conservatively; only a complete result authorizes publication."""

import fnmatch
import json
import os
from pathlib import Path
import runpy
import subprocess


def matches(path, patterns):
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def select(repo, files, force_full=False, default_branch=False):
    result = {key: False for key in ["product", "full", "checks", "tests", "certd", "integration", "browser", "containers", "proto", "lua", "snapshot", "image", "reuse"]}
    result["e2e_sections"] = ""
    docs = ["docs/**", "doc/**", ".github/assets/**"]
    runtime_docs = ["docs/site/operations/upgrade*.md", "docs/deploy/managed-control*.md", "docs/integration-gaps.md"] if repo == "edgeweir-business" else []
    files = [p for p in files if matches(p, runtime_docs) or not (matches(p, docs) or ("/" not in p and p.endswith(".md")))]
    if not files and not force_full:
        return result
    result["product"] = result["checks"] = True
    full = force_full or default_branch
    if repo == "edgeweir":
        sections = set()
        mapping = {
            "apps/console/src/web/routes/_app/purge.tsx": ["m2"],
            "apps/console/src/web/routes/_app/l4/*": ["g9"],
            "apps/console/src/web/routes/_app/certificates.tsx": ["m3", "g11"],
            "apps/console/src/web/routes/_app/bans.tsx": ["g1"],
            "apps/console/src/web/routes/_app/dns.tsx": ["dns", "g6"],
        }
        for path in files:
            found = [suite for pattern, suites in mapping.items() if matches(path, [pattern]) for suite in suites]
            if not found:
                full = True
            sections.update(found)
        result.update(tests=True, certd=True, containers=True, image=True)
        result["e2e_sections"] = "" if full else ",".join(sorted(sections))
    elif repo == "edgeweir-node":
        result.update(proto=True, lua=True, snapshot=True, containers=True)
        if not full:
            go = any(matches(p, ["cmd/**", "internal/**", "go.mod", "go.sum", "test/**/*.go"]) for p in files)
            lua = any(matches(p, ["lua/**", "test/lua/**"]) for p in files)
            packaging = any(matches(p, ["packaging/**", "Dockerfile", "Makefile", ".goreleaser.yaml", "scripts/**", ".github/**"]) for p in files)
            if not go and not lua and not packaging:
                full = True
            elif not packaging:
                result["checks"] = go
                result["lua"] = lua
                result["snapshot"] = go
    else:
        ui = ["src/web/**", "src/components/**", "public/**", "index.html", "vite.config.ts", "tests/browser/**", "tests/e2e/**", "playwright.config.ts"]
        pure_tests = ["tests/openship-deploy.test.mjs", "tests/arc-installer.test.mjs", "tests/cli-unit.test.mjs", "tests/ui-rules.test.ts", "tests/unit/**"]
        if all(matches(p, pure_tests) for p in files) and not full:
            pass
        elif all(matches(p, ui) for p in files) and not full:
            result.update(browser=True, containers=True)
        else:
            full = True
        if full:
            result.update(integration=True, browser=True, containers=True)
    result["full"] = full
    return result


def main():
    verification = runpy.run_path("scripts/ci-verify.py")
    config = verification["policy"]()
    repo = config["repository"].split("/")[1]
    force = os.environ.get("CI_SCOPE", "auto") == "full"
    force_requested = force
    base = os.environ.get("CI_BASE_SHA", "")
    head = os.environ.get("GITHUB_SHA") or subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    try:
        if not verification["HEX40"].fullmatch(base) or set(base) == {"0"}:
            raise ValueError("No comparison base")
        if subprocess.run(["git", "cat-file", "-e", base], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode:
            subprocess.run(["git", "fetch", "--no-tags", "--depth=1", "origin", base], check=True)
        files = subprocess.check_output(["git", "diff", "--no-renames", "--name-only", "-z", base, head]).decode().split("\0")
        files = [p for p in files if p]
    except (ValueError, subprocess.CalledProcessError):
        files, force = [], True
    is_default = repo in ["edgeweir", "edgeweir-node"] and os.environ.get("GITHUB_REF") == f"refs/heads/{config['branch']}"
    result = select(repo, files, force, is_default)
    if result["product"] and not force_requested and os.environ.get("CI_ALLOW_REUSE", "true") == "true":
        try:
            proof = verification["lookup"](config, head)
        except (KeyError, ValueError, subprocess.CalledProcessError) as error:
            print(f"No reusable acceptance: {error}")
            proof = None
        if proof:
            for key in result:
                if key not in ["checks", "product", "e2e_sections"]:
                    result[key] = False
            result.update(full=True, reuse=True)
            result["e2e_sections"] = ""
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            for key, value in result.items():
                output.write(f"{key}={str(value).lower() if isinstance(value, bool) else value}\n")
    print(json.dumps(result))


if __name__ == "__main__":
    main()
