/*
 * ArcImage: adapted from Arc's `arc-provider` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md). Changes:
 * only the image Avatar renders is kept, always the plain <img> (the console has no image
 * component to swap in, so the provider, its context and the link half are left out).
 */
import type { ImgHTMLAttributes, Ref } from "react";

/**
 * The props Arc passes to an image: either `fill` (cover the positioned parent) or `width` and
 * `height`, plus `sizes` and `priority` as hints.
 */
interface ArcImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    "src" | "alt" | "width" | "height" | "loading" | "srcSet"
  > {
  src: string;
  alt: string;
  width?: number;
  height?: number;
  /** Fills the nearest positioned parent. */
  fill?: boolean;
  /** Loads the image eagerly with high priority. */
  priority?: boolean;
  loading?: "eager" | "lazy";
  ref?: Ref<HTMLImageElement>;
}

const fillStyle = { position: "absolute", inset: 0, width: "100%", height: "100%" } as const;

/** A plain, lazily decoded `<img>` that understands `fill` and `priority`. */
export function ArcImage({ alt, fill, priority, loading, style, ...props }: ArcImageProps) {
  return (
    <img
      alt={alt}
      decoding="async"
      {...props}
      loading={loading ?? (priority ? "eager" : "lazy")}
      fetchPriority={priority ? "high" : props.fetchPriority}
      style={fill ? { ...fillStyle, ...style } : style}
    />
  );
}
