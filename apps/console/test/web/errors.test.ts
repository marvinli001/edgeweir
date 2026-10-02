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

  it("keeps a plain error's own message", () => {
    expect(localizeError(new Error("Invalid IP address or CIDR: 10.0.0.300"))).toBe(
      "Invalid IP address or CIDR: 10.0.0.300",
    );
  });
});
