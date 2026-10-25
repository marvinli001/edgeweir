/*
 * Checkbox: ported from Arc's `checkbox` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the
 * primitive switched from Radix to Base UI (Checkbox.Root, and an always-mounted
 * Checkbox.Indicator that reports checked and indeterminate). Changes: Motion's light components
 * through components/effects/motion, the console's reduced-motion hook, `--arc-` tokens
 * (foundation.css), the box is the 18px square with a wider hit area (labels come from Field, so
 * `label` and `description` are left out), the console's focus ring and control edge, and the
 * module sits in Tailwind's components layer.
 */
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { motion, type Transition } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./checkbox.module.css";

/** Both marks share three points, so the check morphs into the dash and back instead of swapping. */
const checkPath = "M4.25 9.25 L7.25 12.25 L13.75 5.75";
const dashPath = "M4.75 9 L9 9 L13.25 9";

export function Checkbox({
  className,
  ...props
}: Omit<CheckboxPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <CheckboxPrimitive.Root data-slot="checkbox" className={cn(styles.box, className)} {...props}>
      <CheckboxPrimitive.Indicator
        keepMounted
        data-slot="checkbox-indicator"
        className={styles.visual}
        render={(indicatorProps, state) => (
          <span {...indicatorProps} aria-hidden="true">
            <Mark on={state.checked || state.indeterminate} dash={state.indeterminate} />
          </span>
        )}
      />
    </CheckboxPrimitive.Root>
  );
}

function Mark({ on, dash }: { on: boolean; dash: boolean }) {
  const reduced = useReducedMotion();
  const fade: Transition = {
    duration: on ? motionTokens.duration.instant : motionTokens.duration.fast,
    ease: [...motionTokens.ease.standard],
  };
  return (
    <>
      <motion.span
        className={styles.fill}
        initial={false}
        animate={{ opacity: on ? 1 : 0, scale: on ? 1 : 0.6 }}
        transition={
          reduced ? { duration: 0 } : { scale: motionTokens.spring.snappy, opacity: fade }
        }
      />
      <svg
        className={styles.mark}
        viewBox="0 0 18 18"
        fill="none"
        focusable="false"
        aria-hidden="true"
      >
        <motion.path
          initial={false}
          animate={{ d: dash ? dashPath : checkPath, pathLength: on ? 1 : 0, opacity: on ? 1 : 0 }}
          transition={
            reduced
              ? { duration: 0 }
              : {
                  d: motionTokens.spring.morph,
                  pathLength: motionTokens.spring.snappy,
                  opacity: fade,
                }
          }
          stroke="currentColor"
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </>
  );
}
