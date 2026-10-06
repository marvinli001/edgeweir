import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ipListInput, ruleInput, tlsSettings } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { localizeError, nodeFeatureLabel } from "../../src/web/lib/errors";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

describe("localizeError", () => {
  overwriteGetLocale(() => "en");

  it("never shows a schema's issues as JSON", () => {
    const error = ipListInput.safeParse({ name: "x", entries: ["10.0.0.300"] }).error;
    expect(error?.message).toContain('"code"');
    expect(localizeError(error)).toBe("Check “IP addresses and CIDRs”");
    expect(localizeError(tlsSettings.safeParse({ gzipTypes: ["text/html;"] }).error)).toBe(
      "Invalid input",
    );
  });

  it("names the field of a server-side validation error", () => {
    const invalid = (path: PropertyKey[]) => ({
      code: "BAD_REQUEST",
      status: 400,
      message: "Input validation failed",
      data: { issues: [{ code: "custom", path, message: "Invalid input" }] },
    });
    expect(localizeError(invalid(["domains", 1]))).toBe("Check “Domains”, item 2");
    expect(localizeError(invalid(["origins", 0, "address"]))).toBe("Check “Origin”");
    expect(localizeError(invalid(["version"]))).toBe("Check “Target version”");
    expect(localizeError(invalid(["unknownField"]))).toBe("Invalid input");
    expect(localizeError(invalid([]))).toBe("Invalid input");
    expect(localizeError({ code: "BAD_REQUEST", status: 400, message: "x" })).toBe("Invalid input");
  });

  it("adds where and why the server's parser refused an expression", () => {
    const rule = (expression: string) =>
      ruleInput.safeParse({ name: "r", phase: "waf-custom", expression, action: { kind: "log" } });
    // As the server sends them: the issues as JSON.
    const refused = (issues: unknown, path?: PropertyKey[]) => {
      const [first] = JSON.parse(JSON.stringify(issues)) as Record<string, unknown>[];
      return {
        code: "BAD_REQUEST",
        status: 400,
        message: "Input validation failed",
        data: { issues: [{ ...first, path: path ?? first?.path }] },
      };
    };
    const unknown = rule('unknown.field eq "x"').error?.issues;
    expect(localizeError(refused(unknown, ["rules", 2, "expression"]))).toBe(
      "“Expression”, character 1: Unknown field",
    );
    expect(localizeError(refused(rule("http.host gt 4").error?.issues))).toBe(
      "“Expression”, character 11: Ordered comparisons need a number field",
    );
    expect(localizeError(refused(unknown, ["paths", 1]))).toBe(
      "“Exact paths”, item 2, character 1: Unknown field",
    );
    // Without a labelled field, the reason alone.
    expect(localizeError(refused(unknown, ["rules", 0, "action", "value"]))).toBe(
      "Character 1: Unknown field",
    );
  });

  it("localizes better-auth and WebAuthn codes the UI meets", () => {
    const failure = (code: string, message: string) => ({ code, message, status: 400 });
    expect(localizeError(failure("PASSWORD_TOO_LONG", "Password too long"))).toBe(
      "Password must be at most 128 characters",
    );
    expect(localizeError(failure("SESSION_NOT_FRESH", "Session is not fresh"))).toBe(
      "Sign in again before changing this",
    );
    expect(localizeError(failure("INVALID_BACKUP_CODE", "Invalid backup code"))).toBe(
      "Invalid code",
    );
    expect(localizeError(failure("ERROR_CEREMONY_ABORTED", "Registration cancelled"))).toBe(
      "Cancelled",
    );
    expect(localizeError(failure("ERROR_INVALID_DOMAIN", "10.0.0.5 is an invalid domain"))).toBe(
      "Passkeys do not work on this address; open the console by its domain",
    );
    expect(localizeError(failure("ERROR_AUTHENTICATOR_GENERAL_ERROR", "The authenticator…"))).toBe(
      "Passkey verification failed",
    );
  });

  it("names the capabilities and the nodes that lack them", () => {
    const error = {
      code: "NODE_CAPABILITY_REQUIRED",
      status: 409,
      message: "cluster nodes cannot run this task",
      data: { features: "purge-tag-v1, future-v9", nodes: "edge-1, edge-2" },
    };
    expect(localizeError(error)).toBe(
      "Some nodes don't support Host and tag purges, future-v9 yet: edge-1, edge-2",
    );
  });

  it("names the Host header nodes would refuse", () => {
    const error = {
      code: "ORIGIN_HOST_HEADER_INVALID",
      status: 400,
      message: 'invalid Host header "[2001:db8::1]"',
      data: { hostHeader: "[2001:db8::1]" },
    };
    expect(localizeError(error)).toBe("Invalid origin Host: [2001:db8::1]");
  });

  it("labels every capability nodes can be asked for", () => {
    const compiler = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/config-compiler/src/index.ts"),
      "utf8",
    );
    const contract = readFileSync(
      resolve(import.meta.dirname, "../../../../packages/contract/src/node-features.ts"),
      "utf8",
    );
    const features = new Set(
      [...`${compiler}\n${contract}`.matchAll(/"([a-z0-9]+(?:-[a-z0-9]+)*-v\d+)"/g)].map(
        (match) => match[1] as string,
      ),
    );
    expect(features.size).toBeGreaterThan(15);
    for (const feature of features) expect(nodeFeatureLabel(feature), feature).not.toBe(feature);
  });

  it("keeps a plain error's own message", () => {
    expect(localizeError(new Error("Invalid IP address or CIDR: 10.0.0.300"))).toBe(
      "Invalid IP address or CIDR: 10.0.0.300",
    );
  });
});
