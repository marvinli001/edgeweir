/*
 * App-wide Motion settings: motion components follow the OS "reduce motion" setting (transforms
 * and layout animations off). The only place outside the effects that needs Motion is the root.
 */
import { MotionConfig } from "motion/react";
import type * as React from "react";

export function MotionSettings({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
