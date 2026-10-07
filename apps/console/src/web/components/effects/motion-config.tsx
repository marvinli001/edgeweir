/*
 * App-wide Motion settings: motion components follow the OS "reduce motion" setting (transforms
 * and layout animations off), and only the DOM animation features load (no drag, pan or layout
 * projection). Effects use the light `motion/react-m` components; `strict` throws on a full
 * `motion.*` component, which would pull those features back into the entry (ADR-0034 budget).
 */
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import type * as React from "react";

export function MotionSettings({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
