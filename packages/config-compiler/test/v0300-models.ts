import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The console models behind the v0.30.0 vector: site a samples 10% and has
 * every access log option (blocked requests, the query string, two request
 * headers, the peer address); site b has none.
 */
export const v0300Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      tls: tls(),
      logSampleRate: 1000,
      logBlocked: true,
      logQuery: true,
      logHeaders: ["x-trace-id", "accept-language"],
      logPeer: true,
    }),
    site("b", { tls: tls() }),
  ],
});
