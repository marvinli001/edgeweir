/*
 * Emboss Surface: adapted from Smooth UI (MIT, Eduardo Calvo; THIRD-PARTY-NOTICES.md). Changes:
 * only the emboss and deboss recipes (no SVG lighting filter), the material defaults to the
 * raised surface token, and the light stays fixed (no pointer tracking).
 */
import type * as React from "react";
import { cn } from "@/lib/utils";

type Variant = "emboss" | "deboss";

const RECIPES: Record<Variant, { inset: boolean; invert: boolean }> = {
  emboss: { inset: false, invert: false },
  deboss: { inset: true, invert: true },
};

const HIGHLIGHT_MIX = 46;
const SHADE_MIX = 34;

/**
 * A material plate whose content looks pressed out of (emboss) or into (deboss) it, lit from
 * `lightAngle` (degrees, 90 is straight above).
 */
export function EmbossSurface({
  children,
  className,
  color = "var(--raised)",
  depth = 1.5,
  lightAngle = 110,
  softness = 0.5,
  variant = "emboss",
  style,
  ...props
}: React.ComponentProps<"div"> & {
  color?: string;
  depth?: number;
  lightAngle?: number;
  softness?: number;
  variant?: Variant;
}) {
  const recipe = RECIPES[variant];
  const radians = (lightAngle * Math.PI) / 180;
  const dx = Math.cos(radians) * depth;
  const dy = -Math.sin(radians) * depth;
  const blur = Math.max(0.25, depth * softness * 2.4);
  const highlight = `color-mix(in oklab, ${color}, white ${HIGHLIGHT_MIX}%)`;
  const shade = `color-mix(in oklab, ${color}, black ${SHADE_MIX}%)`;
  const sign = recipe.invert ? -1 : 1;
  const layer = (scale: number, tint: string, prefix: string) =>
    `${prefix}${dx * scale}px ${dy * scale}px ${blur}px ${tint}`;
  const shadow = (prefix: string) =>
    [layer(sign, highlight, prefix), layer(-sign, shade, prefix)].join(", ");
  return (
    <div
      className={cn("text-foreground", className)}
      style={{
        backgroundColor: color,
        boxShadow: shadow(recipe.inset ? "inset " : ""),
        textShadow: shadow(""),
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}
