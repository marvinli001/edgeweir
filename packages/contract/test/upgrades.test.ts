import { describe, expect, it } from "vitest";
import { compareReleaseVersions } from "../src/index";

describe("release versions", () => {
  it("orders versions by semantic version precedence", () => {
    const ordered = [
      "0.1.9",
      "0.2.0-alpha",
      "0.2.0-alpha.1",
      "0.2.0-alpha.beta",
      "0.2.0-beta.2",
      "0.2.0-beta.11",
      "0.2.0-rc.1",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ];
    for (const [i, a] of ordered.entries())
      for (const [j, b] of ordered.entries())
        expect(compareReleaseVersions(a, b), `${a} vs ${b}`).toBe(Math.sign(i - j));
  });

  it("ignores a leading v and build metadata, and knows no other versions", () => {
    expect(compareReleaseVersions("v0.2.0", "0.2.0")).toBe(0);
    expect(compareReleaseVersions("0.2.1-snapshot+abc1234", "0.2.1-snapshot")).toBe(0);
    expect(compareReleaseVersions("dev", "0.2.0")).toBeNull();
    expect(compareReleaseVersions("", "0.2.0")).toBeNull();
    expect(compareReleaseVersions("0.2", "0.2.0")).toBeNull();
  });
});
