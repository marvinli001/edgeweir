import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ADR-0017: tags can be moved, so third-party images are pinned by digest and
// GitHub Actions by full commit SHA. Only images built from this repository or
// edgeweir-node are referenced by tag.
const repo = resolve(import.meta.dirname, "../../../..");
const read = (file: string) => readFileSync(resolve(repo, file), "utf8");
const DIGEST = /@sha256:[0-9a-f]{64}$/;
const OWN_IMAGE = /^(?:ghcr\.io\/marvinli001\/)?edgeweir(?:-node|-geoip-fixture)?:/;

describe("supply-chain pins", () => {
  it("pins every GitHub Action to a commit SHA and names its release", () => {
    const files = readdirSync(resolve(repo, ".github/workflows"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = read(`.github/workflows/${file}`);
      for (const [, ref] of text.matchAll(/^\s*(?:-\s*)?uses:\s*(.+)$/gm)) {
        expect(ref, file).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    }
  });

  it("pins third-party images in the compose files by digest", () => {
    for (const file of ["compose.yml", "compose.dev.yml", "compose.baota.yml", "compose.e2e.yml"]) {
      const images = [...read(file).matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((m) => m[1] ?? "");
      expect(images.length, file).toBeGreaterThan(0);
      for (const image of images) {
        if (!OWN_IMAGE.test(image)) expect(image, file).toMatch(DIGEST);
      }
    }
  });

  it("pins the Dockerfile frontend and base images by digest", () => {
    const text = read("Dockerfile");
    expect(text.split("\n")[0]).toMatch(
      /^# syntax=docker\/dockerfile:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/,
    );
    const args = [...text.matchAll(/^ARG (\w+_IMAGE)=(\S+)$/gm)];
    expect(args.length).toBeGreaterThan(0);
    for (const [, name, image] of args) expect(image, name).toMatch(DIGEST);
    // FROM names a pinned *_IMAGE argument, an earlier stage or scratch.
    const stages = new Set(["scratch"]);
    for (const [, from = "", stage] of text.matchAll(
      /^FROM (?:--platform=\S+ )?(\S+)(?: AS (\S+))?/gim,
    )) {
      if (!stages.has(from) && !/^\$\{\w+_IMAGE\}$/.test(from)) expect(from).toMatch(DIGEST);
      if (stage) stages.add(stage);
    }
  });

  it("pins the clean machine of the install.sh end-to-end step", () => {
    expect(read("scripts/e2e.sh").match(/E2E_INSTALL_IMAGE:-([^}]+)\}/)?.[1]).toMatch(DIGEST);
  });
});
