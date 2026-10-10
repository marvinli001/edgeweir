/**
 * WebP / AVIF conversion of a site's cached JPEG and PNG responses (proto
 * v0.31.0, feature image-convert-v1, ADR-0043). Nodes pick avif, webp or the
 * original from the request's Accept, key their cache by that class, convert
 * on a miss and keep the original whenever a conversion fails, is over a
 * limit or would not be smaller. Only requests a cache rule caches are
 * converted.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { analyticsRange, uuid } from "./schemas";

/** Largest original converted, in bytes (64 MiB). */
export const MAX_IMAGE_SIZE = 64 * 1024 * 1024;
/** Largest image converted, in pixels. */
export const MAX_IMAGE_PIXELS = 50_000_000;
export const IMAGE_QUALITY_RANGE = { min: 1, max: 100 } as const;

/** What a site starts with (off). */
export const IMAGE_CONVERT_DEFAULTS = {
  enabled: false,
  webp: true,
  avif: false,
  webpQuality: 80,
  avifQuality: 50,
  jpeg: true,
  png: true,
  minSize: 1024,
  maxSize: 10 * 1024 * 1024,
  maxPixels: 16_000_000,
} as const;

const quality = z.int().min(IMAGE_QUALITY_RANGE.min).max(IMAGE_QUALITY_RANGE.max);

const imageConvertFields = z.object({
  enabled: z.boolean(),
  /** Formats offered: at least one. */
  webp: z.boolean(),
  avif: z.boolean(),
  webpQuality: quality,
  avifQuality: quality,
  /** Source types converted: image/jpeg and image/png, at least one. */
  jpeg: z.boolean(),
  png: z.boolean(),
  /** Originals of minSize to maxSize bytes are converted. */
  minSize: z.int().min(0).max(MAX_IMAGE_SIZE),
  maxSize: z.int().min(1).max(MAX_IMAGE_SIZE),
  maxPixels: z.int().min(1).max(MAX_IMAGE_PIXELS),
});

/** The settings are checked as a whole, also while conversion is off. */
function checkSettings(
  value: {
    webp: boolean;
    avif: boolean;
    jpeg: boolean;
    png: boolean;
    minSize: number;
    maxSize: number;
  },
  ctx: z.RefinementCtx,
) {
  if (!value.webp && !value.avif)
    ctx.addIssue({ code: "custom", path: ["webp"], message: "choose WebP, AVIF or both" });
  if (!value.jpeg && !value.png)
    ctx.addIssue({ code: "custom", path: ["jpeg"], message: "choose JPEG, PNG or both" });
  if (value.minSize > value.maxSize)
    ctx.addIssue({
      code: "custom",
      path: ["minSize"],
      message: "the lower bound is above the upper bound",
    });
}

export const imageConvertSettings = imageConvertFields.superRefine(checkSettings);
export const imageConvertInput = imageConvertFields.extend({ id: uuid }).superRefine(checkSettings);

/** Bytes WebP / AVIF responses saved over a range. */
export const imageSavingsInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
});
export const imageSavings = z.object({
  /** For each complete 200 response to a GET served as a variant (cache hits included): the original's length minus the variant's. */
  bytesSaved: z.number(),
  /** Active nodes of the site's cluster that do not convert (no image-convert-v1). */
  unsupportedNodes: z.number().int(),
});

const idParam = z.object({ id: uuid });

/** A site's WebP / AVIF conversion. */
export const imageConvertContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/image-convert", tags: ["sites"] })
    .input(idParam)
    .output(imageConvertSettings),
  /** Replaces the settings; publishes the site's cluster when nodes see a change (hot update). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/image-convert", tags: ["sites"] })
    .input(imageConvertInput)
    .output(imageConvertSettings),
  savings: oc
    .route({ method: "GET", path: "/sites/{id}/image-convert/savings", tags: ["sites"] })
    .input(imageSavingsInput)
    .output(imageSavings),
};

export type ImageConvertSettings = z.infer<typeof imageConvertSettings>;
export type ImageSavings = z.infer<typeof imageSavings>;
