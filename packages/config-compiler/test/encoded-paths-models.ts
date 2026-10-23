import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The console models behind the encoded path vector: site a lets "%2F"
 * through under /files/ and ";" parameters under /api/ (given out of
 * order), site b has no exemptions.
 */
export const encodedPathModels = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      tls: tls(),
      encodedPathExemptions: [
        { prefix: "/files/", encodedSlash: true, semicolon: false },
        { prefix: "/api/", encodedSlash: false, semicolon: true },
        { prefix: "/data/", encodedSlash: true, semicolon: true },
      ],
    }),
    site("b", { tls: tls() }),
  ],
});
