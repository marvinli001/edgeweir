import { ipListInput, tlsSettings } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { localizeError } from "../../src/web/lib/errors";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

describe("localizeError", () => {
  overwriteGetLocale(() => "en");

  it("never shows a schema's issues as JSON", () => {
    const error = ipListInput.safeParse({ name: "x", entries: ["10.0.0.300"] }).error;
    expect(error?.message).toContain('"code"');
    expect(localizeError(error)).toBe("Invalid input");
    expect(localizeError(tlsSettings.safeParse({ gzipTypes: ["text/html;"] }).error)).toBe(
      "Invalid input",
    );
  });

  it("keeps a plain error's own message", () => {
    expect(localizeError(new Error("Invalid IP address or CIDR: 10.0.0.300"))).toBe(
      "Invalid IP address or CIDR: 10.0.0.300",
    );
  });
});
