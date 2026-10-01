import { describe, expect, it } from "vitest";
import { originErrorText, taskErrorText } from "../../src/web/lib/node-errors";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

describe("node error texts", () => {
  overwriteGetLocale(() => "en");

  it("localizes known origin failure codes with their parameters", () => {
    expect(originErrorText("upstream_status", { status: "503" }, "HTTP 503")).toBe(
      "The origin answered HTTP 503",
    );
    expect(originErrorText("dns_failed", { host: "origin.test" }, "dns origin.test: x")).toBe(
      "Cannot resolve origin.test",
    );
    expect(originErrorText("tls_failed", {}, "TLS handshake failed")).toBe(
      "TLS handshake or certificate verification failed",
    );
  });

  it("falls back to the node's text for unknown and empty codes", () => {
    expect(originErrorText("", {}, "connection failed or HTTP 502")).toBe(
      "connection failed or HTTP 502",
    );
    expect(originErrorText("quantum_foam", {}, "something new")).toBe("something new");
    expect(taskErrorText("", {}, "")).toBe("");
    expect(taskErrorText("", {}, "legacy text")).toBe("legacy text");
    expect(taskErrorText("toString", {}, "raw")).toBe("raw");
  });

  it("localizes task outcomes, including the prefetch failure reason", () => {
    expect(
      taskErrorText(
        "prefetch_failed",
        { failed: "2", total: "3", url: "http://a.test/x", reason: "status", status: "404" },
        "http://a.test/x: HTTP 404",
      ),
    ).toBe("2 of 3 URLs failed, first http://a.test/x (HTTP 404)");
    expect(
      taskErrorText(
        "prefetch_failed",
        { failed: "1", total: "1", url: "https://a.test/", reason: "https_unsupported" },
        "",
      ),
    ).toBe("1 of 1 URL failed, first https://a.test/ (the node has no HTTPS listener yet)");
    // An unknown reason reads as "other".
    expect(
      taskErrorText(
        "prefetch_failed",
        { failed: "1", total: "1", url: "u", reason: "gremlins" },
        "",
      ),
    ).toBe("1 of 1 URL failed, first u (other error)");
    expect(taskErrorText("prefetch_timeout", { done: "4", total: "9" }, "")).toBe(
      "Ran out of time after 4 of 9 URLs",
    );
    expect(taskErrorText("prefetch_timeout", { done: "0", total: "1" }, "")).toBe(
      "Ran out of time after 0 of 1 URL",
    );
    expect(taskErrorText("task_expired", {}, "expired: …")).toBe(
      "Not executed by the node within 7 days",
    );
    // Missing parameters render empty, never "undefined".
    expect(taskErrorText("task_unsupported", {}, "")).not.toContain("undefined");
  });
});
