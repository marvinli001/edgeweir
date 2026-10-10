import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The console models behind the v0.31.0 vector: site a converts JPEG to
 * WebP (quality 80) and AVIF (quality 50) for originals of 1 KiB to 10 MiB
 * and up to 16 megapixels; site b converts nothing.
 */
export const v0310Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      tls: tls(),
      imageConvert: {
        webp: true,
        avif: true,
        webpQuality: 80,
        avifQuality: 50,
        jpeg: true,
        png: false,
        minSize: 1024,
        maxSize: 10_485_760,
        maxPixels: 16_000_000,
      },
    }),
    site("b", { tls: tls() }),
  ],
});
