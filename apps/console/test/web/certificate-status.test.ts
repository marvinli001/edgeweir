import { describe, expect, it } from "vitest";
import {
  certificateDaysLeft,
  certificateExpired,
  certificateState,
} from "../../src/web/lib/certificate-status";

const now = Date.parse("2026-10-07T12:00:00Z");
const past = "2026-10-01T00:00:00Z";
const future = "2026-10-20T00:00:00Z";

describe("certificate state", () => {
  it("shows an uploaded or issued certificate past its notAfter as expired", () => {
    expect(certificateState({ status: "ready", notAfter: past }, now)).toBe("expired");
    expect(certificateState({ status: "ready", notAfter: new Date(now).toISOString() }, now)).toBe(
      "expired",
    );
    expect(certificateState({ status: "ready", notAfter: future }, now)).toBe("ready");
  });

  it("shows a failed renewal of an expired certificate as expired", () => {
    expect(certificateState({ status: "error", notAfter: past }, now)).toBe("expired");
    expect(certificateState({ status: "error", notAfter: future }, now)).toBe("error");
    expect(certificateState({ status: "error", notAfter: null }, now)).toBe("error");
  });

  it("shows an upload nodes cannot load as unloadable, expired or not", () => {
    for (const notAfter of [past, future])
      expect(
        certificateState(
          { status: "error", notAfter, lastError: "certificate_key_explicit_curve" },
          now,
        ),
      ).toBe("unloadable");
    expect(
      certificateState({ status: "error", notAfter: future, lastError: "acme_caa" }, now),
    ).toBe("error");
  });

  it("keeps a renewal in progress and a certificate not issued yet", () => {
    expect(certificateState({ status: "issuing", notAfter: past }, now)).toBe("issuing");
    expect(certificateState({ status: "pending", notAfter: past }, now)).toBe("pending");
    expect(certificateState({ status: "pending", notAfter: null }, now)).toBe("pending");
  });

  it("tells expiry from notAfter alone, so a renewal in progress still reads as expired", () => {
    // The card says "expired on …" instead of "0 days left" whatever the badge shows.
    expect(certificateExpired(past, now)).toBe(true);
    expect(certificateExpired(new Date(now).toISOString(), now)).toBe(true);
    expect(certificateExpired(future, now)).toBe(false);
    expect(certificateExpired(null, now)).toBe(false);
  });

  it("counts whole days left, rounded up, and none once expired", () => {
    expect(certificateDaysLeft(future, now)).toBe(13);
    expect(certificateDaysLeft("2026-10-07T13:00:00Z", now)).toBe(1);
    expect(certificateDaysLeft(past, now)).toBe(0);
  });
});
