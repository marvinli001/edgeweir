/*
 * Progress: adapted from Arc's `progress` (Copyright (c) 2026 Elia Kuratli, MIT License;
 * THIRD-PARTY-NOTICES.md). Changes: Motion's light components through components/effects/motion,
 * the console's reduced-motion hook, `--arc-` tokens (foundation.css), Hugeicons instead of Lucide,
 * Paraglide text, a caller's aria-label is kept, data-slot names on the track and fill for callers'
 * styles, a well for the track, and the module sits in Tailwind's components layer.
 */

import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type HTMLAttributes, useEffect } from "react";
import {
  AnimatePresence,
  animate,
  type HTMLMotionProps,
  motion,
  type TargetAndTransition,
  type Transition,
  useIsPresent,
  useMotionValue,
  useTransform,
} from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { m } from "@/lib/i18n";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./progress.module.css";

export interface ProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  value?: number;
  max?: number;
  label?: string;
  showValue?: boolean;
}

const exitFast: Transition = {
  duration: motionTokens.duration.fast,
  ease: [...motionTokens.ease.standard],
};
const textIn: TargetAndTransition = {
  opacity: 0,
  y: "0.3em",
  filter: `blur(${motionTokens.blur.soft}px)`,
};
const textOut: TargetAndTransition = {
  opacity: 0,
  y: "-0.3em",
  filter: `blur(${motionTokens.blur.subtle}px)`,
  transition: exitFast,
};
const iconIn: TargetAndTransition = {
  opacity: 0,
  scale: 0.6,
  filter: `blur(${motionTokens.blur.subtle}px)`,
};
const shown: TargetAndTransition = { opacity: 1, y: "0em", scale: 1, filter: "blur(0px)" };
const fadeOut: TargetAndTransition = {
  opacity: 0,
  transition: { duration: motionTokens.duration.instant },
};

/** Outgoing copies are hidden from assistive tech while they fade. */
function Swap(props: HTMLMotionProps<"span">) {
  const present = useIsPresent();
  return <motion.span {...props} aria-hidden={present ? props["aria-hidden"] : true} />;
}

export function Progress({
  value = 0,
  max = 100,
  label,
  showValue = false,
  className,
  ...props
}: ProgressProps) {
  const reduce = useReducedMotion();
  const safeMax = max > 0 ? max : 100;
  const safeValue = Math.min(Math.max(value, 0), safeMax);
  const percentage = Math.round((safeValue / safeMax) * 100);
  const complete = percentage >= 100;
  // One spring drives both the fill and the counted label, so the number always matches the bar.
  const progress = useMotionValue(percentage);
  // The fill slides in from the left instead of scaling, so its rounded end keeps its shape at every value.
  const x = useTransform(progress, (latest) => `${Math.min(Math.max(latest, 0), 100) - 100}%`);
  const counted = useTransform(
    progress,
    (latest) => `${Math.round(Math.min(Math.max(latest, 0), 100))}%`,
  );
  useEffect(() => {
    if (reduce) {
      progress.jump(percentage);
      return;
    }
    const controls = animate(progress, percentage, motionTokens.spring.smooth);
    return () => controls.stop();
  }, [percentage, progress, reduce]);
  const enter: Transition = reduce
    ? { duration: motionTokens.duration.instant }
    : { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] };
  const classes = [styles.progress, className].filter(Boolean).join(" ");
  return (
    <div
      {...props}
      className={classes}
      data-complete={complete ? "" : undefined}
      role="progressbar"
      aria-label={label ?? props["aria-label"] ?? m.arc_progress()}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={safeValue}
      aria-valuetext={`${percentage}%`}
    >
      {label || showValue ? (
        <div className={styles.meta}>
          {label ? (
            <span className={styles.label}>
              <AnimatePresence mode="popLayout" initial={false}>
                <Swap
                  key={label}
                  className={styles.line}
                  initial={reduce ? { opacity: 0 } : textIn}
                  animate={shown}
                  exit={reduce ? fadeOut : textOut}
                  transition={enter}
                >
                  {label}
                </Swap>
              </AnimatePresence>
            </span>
          ) : (
            <span />
          )}
          {showValue ? (
            <span className={styles.value}>
              {/* Completion lands as the fill arrives: a check settles in beside the final count. */}
              <AnimatePresence initial={false}>
                {complete && (
                  <motion.span
                    key="done"
                    className={styles.done}
                    initial={reduce ? { opacity: 0 } : iconIn}
                    animate={shown}
                    exit={reduce ? fadeOut : { ...iconIn, transition: exitFast }}
                    transition={reduce ? enter : { ...motionTokens.spring.snappy, delay: 0.24 }}
                  >
                    <HugeiconsIcon icon={Tick02Icon} size={14} strokeWidth={2} aria-hidden="true" />
                  </motion.span>
                )}
              </AnimatePresence>
              <motion.span className={styles.count}>{counted}</motion.span>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={styles.track} data-slot="progress-track">
        <motion.span className={styles.fill} data-slot="progress-indicator" style={{ x }} />
      </div>
    </div>
  );
}
