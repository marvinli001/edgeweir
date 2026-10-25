/*
 * Motion for the Arc primitives (components/arc): the light `motion/react-m` components, which
 * render under the app's LazyMotion (motion-config.tsx), and the helpers those primitives use.
 * Motion comes into the UI only through components/effects (ui-rules.test.ts).
 */
export type {
  AnimationPlaybackControls,
  HTMLMotionProps,
  MotionProps,
  TargetAndTransition,
  Transition,
  Variants,
} from "motion/react";
export {
  AnimatePresence,
  animate,
  useIsPresent,
  useMotionValue,
  useTransform,
} from "motion/react";
export * as motion from "motion/react-m";
