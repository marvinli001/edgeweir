import type { CompileInput } from "../src/index";
import { certificate, site, tls } from "./v0230-models";

/** 2026-10-08T00:00:00Z in Unix milliseconds: the regex order keys below. */
const T0 = 1_791_417_600_000;

/**
 * The console models behind the v0.25.0 vector: a site with every domain
 * form (exact, `*.`, `.` and two patterns, given out of order), a second
 * site with a pattern created later, a disabled site whose `.` and pattern
 * domains are offline hosts, and unknown host handling that hands unknown
 * hosts to site a (with its certificate), closes node IP access and turns
 * scan protection on.
 */
export const v0250Models = (): CompileInput => ({
  clusterId: "c1",
  certificates: [{ ...certificate } as never],
  sites: [
    site("a", {
      domains: [
        { name: "z.test", wildcard: false },
        { name: "api\\d+\\.test", wildcard: false, match: "regex", order: T0 * 16 + 1 },
        { name: "deep.test", wildcard: false, match: "suffix" },
        { name: "a.test", wildcard: true },
        { name: "a.test", wildcard: false },
        { name: "(www|m)\\.a\\.test", wildcard: false, match: "regex", order: T0 * 16 },
      ],
      certificateId: "cert",
      tls: tls(),
    }),
    site("b", {
      domains: [
        { name: "b.test", wildcard: false },
        { name: ".*\\.b\\.test", wildcard: false, match: "regex", order: (T0 + 1000) * 16 },
      ],
    }),
    site("off", { enabled: false }),
  ],
  offlineHosts: [
    { name: "off.test", wildcard: false, reason: "disabled" },
    { name: "off-[0-9]+\\.test", wildcard: false, match: "regex", reason: "disabled" },
    { name: "off.test", wildcard: false, match: "suffix", reason: "disabled" },
  ],
  edge: {
    httpPorts: [],
    httpsPorts: [],
    clientIp: null,
    unknownHosts: {
      unknownHost: "site",
      ipAccess: "close",
      defaultSiteId: "a",
      defaultCertificate: true,
      scanThreshold: 100,
      scanBanSeconds: 3600,
    },
  },
});
