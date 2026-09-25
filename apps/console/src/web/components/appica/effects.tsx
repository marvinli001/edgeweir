/**
 * appica effect wrappers. They read no appica tokens (colors are passed from shadcn tokens), so
 * they may wrap shadcn content without an AppicaScope.
 */
import { BackgroundPattern as AppicaBackgroundPattern } from "@appica/ui-react/background-pattern";
import { BorderBeam as AppicaBorderBeam } from "@appica/ui-react/border-beam";
import { GradientGlow as AppicaGradientGlow } from "@appica/ui-react/gradient-glow";
import { TextAnimate } from "@appica/ui-react/text-animate";
import type * as React from "react";
import { cn } from "@/lib/utils";

/** A comet of light running around the border; `tone` picks the shadcn color. */
export function BorderBeam({
  tone = "primary",
  className,
  ...props
}: Omit<React.ComponentProps<typeof AppicaBorderBeam>, "color"> & {
  tone?: "primary" | "success" | "destructive";
}) {
  const color =
    tone === "destructive"
      ? "var(--destructive)"
      : tone === "success"
        ? "var(--chart-2)"
        : "var(--primary)";
  return (
    <AppicaBorderBeam
      color={color}
      length={14}
      className={cn("rounded-4xl", className)}
      {...props}
    />
  );
}

/** Soft animated brand halo behind its children. */
export function GradientGlow({
  className,
  ...props
}: Omit<React.ComponentProps<typeof AppicaGradientGlow>, "from" | "via" | "to">) {
  return (
    <AppicaGradientGlow
      from="var(--primary)"
      via="var(--chart-2)"
      to="var(--chart-1)"
      blur="3xl"
      speed={12}
      className={cn(
        "rounded-4xl [--gradient-glow-opacity:0.28] dark:[--gradient-glow-opacity:0.2]",
        className,
      )}
      {...props}
    />
  );
}

/** Dot/grid backdrop tinted with the shadcn muted foreground. */
export function BackgroundPattern({
  className,
  ...props
}: React.ComponentProps<typeof AppicaBackgroundPattern>) {
  return (
    <AppicaBackgroundPattern
      className={cn("[--pattern-color:var(--muted-foreground)]", className)}
      {...props}
    />
  );
}

/** Re-plays a short rise animation whenever the value changes. */
export function AnimatedValue({ value, className }: { value: string; className?: string }) {
  return (
    <TextAnimate key={value} effect="rise" by="char" duration={0.5} className={className}>
      {value}
    </TextAnimate>
  );
}
