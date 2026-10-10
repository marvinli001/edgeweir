import type { ImageConvertModel } from "@edgeweir/config-compiler";
import {
  IMAGE_CONVERT_DEFAULTS,
  type ImageConvertSettings,
  imageConvertSettings,
} from "@edgeweir/contract";

/**
 * A site's stored WebP / AVIF settings (site.image_convert) with the
 * defaults filled in; `{}` (never saved) is the defaults, off.
 */
export function readImageConvert(value: unknown): ImageConvertSettings {
  const stored = value && typeof value === "object" ? value : {};
  const parsed = imageConvertSettings.safeParse({ ...IMAGE_CONVERT_DEFAULTS, ...stored });
  return parsed.success ? parsed.data : { ...IMAGE_CONVERT_DEFAULTS };
}

/** What nodes get (config.proto ImageConvert): nothing while conversion is off. */
export function imageConvertModel(value: unknown): ImageConvertModel | undefined {
  const { enabled, ...model } = readImageConvert(value);
  return enabled ? model : undefined;
}
