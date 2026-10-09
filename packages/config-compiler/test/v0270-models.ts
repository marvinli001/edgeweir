import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The console models behind the v0.27.0 vector: site a with four access
 * authentication rules in the site's order (kept, not sorted): Basic on
 * /admin of a.test, forward authentication with headers given out of
 * order, signed URLs of kind A for two extensions and of kind C except
 * /public/; site b without rules.
 */
export const v0270Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      domains: [
        { name: "a.test", wildcard: false },
        { name: "a.test", wildcard: true },
      ],
      tls: tls(),
      authRules: [
        {
          id: "r-basic",
          kind: "basic",
          scope: {
            domains: ["a.test"],
            pathPrefixes: ["/admin"],
            extensions: [],
            excludePathPrefixes: [],
          },
          credential: { id: "r-basic", version: 2 },
          basic: { realm: "Admin area", keepAuthorization: false, userHeader: true },
        },
        {
          id: "r-forward",
          kind: "forward",
          scope: {
            domains: ["*.a.test"],
            pathPrefixes: ["/app/", "/api/"],
            extensions: [],
            excludePathPrefixes: [],
          },
          forward: {
            url: "https://auth.test/verify?from=edge",
            method: "GET",
            timeoutMs: 2000,
            requestHeaders: ["x-token", "cookie", "authorization"],
            responseHeaders: ["x-auth-user", "x-auth-groups"],
            cacheSeconds: 60,
            passRedirects: true,
            allowUnavailable: false,
          },
        },
        {
          id: "r-url-a",
          kind: "url_a",
          scope: {
            domains: [],
            pathPrefixes: [],
            extensions: ["mp4", "jpg"],
            excludePathPrefixes: [],
          },
          credential: { id: "r-url-a", version: 1 },
          url: { validitySeconds: 1800, skewSeconds: 300, signParam: "sign", timeParam: "t" },
        },
        {
          id: "r-url-c",
          kind: "url_c",
          scope: {
            domains: [],
            pathPrefixes: [],
            extensions: [],
            excludePathPrefixes: ["/public/", "/assets/"],
          },
          credential: { id: "r-url-c", version: 3 },
          url: { validitySeconds: 600, skewSeconds: 0, signParam: "sign", timeParam: "t" },
        },
      ],
    }),
    site("b", { tls: tls() }),
  ],
});
