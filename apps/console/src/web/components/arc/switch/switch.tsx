/*
 * Switch: ported from Arc's `switch` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the primitive
 * switched from Radix to Base UI (Switch.Root and Switch.Thumb, which reports the checked state).
 * Changes: Motion's light components through components/effects/motion, the console's
 * reduced-motion hook, `--arc-` tokens (foundation.css), the root is the track (labels come from
 * Field, so the `label` prop is left out), a small size, the console's focus ring and a wider hit
 * area, and the module sits in Tailwind's components layer.
 */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { type RefObject, useEffect, useRef, useState } from "react";
import { animate, motion, type Transition, useMotionValue } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./switch.module.css";

type Size = "sm" | "default";

/** The thumb, its travel (the track's inner width minus the thumb) and how far it widens while pressed. Keep in sync with switch.module.css. */
const SIZES: Record<Size, { thumb: number; travel: number; stretch: number }> = {
  default: { thumb: 18, travel: 18, stretch: 5 },
  sm: { thumb: 14, travel: 14, stretch: 4 },
};
/** Critically damped: the thumb lands on its end without overshooting the state it reports. */
const glide: Transition = { type: "spring", visualDuration: 0.3, bounce: 0 };

export function Switch({
  className,
  size = "default",
  onPointerDown,
  onPointerUp,
  onPointerLeave,
  onPointerCancel,
  onKeyDown,
  onKeyUp,
  onBlur,
  ...props
}: Omit<SwitchPrimitive.Root.Props, "className"> & { className?: string; size?: Size }) {
  const [pressed, setPressed] = useState(false);
  // A pointer or Space press already stretched the thumb, so its release adds no second stretch.
  const releasedAt = useRef(-Infinity);
  const release = () => {
    if (pressed && !props.disabled) releasedAt.current = performance.now();
    setPressed(false);
  };
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(styles.switch, className)}
      {...props}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        if (event.button === 0) setPressed(true);
      }}
      onPointerUp={(event) => {
        onPointerUp?.(event);
        release();
      }}
      onPointerLeave={(event) => {
        onPointerLeave?.(event);
        setPressed(false);
      }}
      onPointerCancel={(event) => {
        onPointerCancel?.(event);
        setPressed(false);
      }}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.key === " ") setPressed(true);
      }}
      onKeyUp={(event) => {
        onKeyUp?.(event);
        release();
      }}
      onBlur={(event) => {
        onBlur?.(event);
        setPressed(false);
      }}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={styles.thumbSlot}
        render={(thumbProps, state) => (
          <span {...thumbProps}>
            <Thumb
              on={state.checked}
              pressed={pressed && !state.disabled}
              size={size}
              releasedAt={releasedAt}
            />
          </span>
        )}
      />
    </SwitchPrimitive.Root>
  );
}

/** The thumb stretches like a held finger and keeps its far edge anchored, then travels on a spring. */
function Thumb({
  on,
  pressed,
  size,
  releasedAt,
}: {
  on: boolean;
  pressed: boolean;
  size: Size;
  releasedAt: RefObject<number>;
}) {
  const reduced = useReducedMotion();
  const { thumb, travel, stretch } = SIZES[size];
  // A brief stretch along the travel, so the thumb reads as moving mass rather than a sliding dot.
  const scaleX = useMotionValue(1);
  const shown = useRef(on);
  useEffect(() => {
    if (shown.current === on) return;
    shown.current = on;
    const fromPress = performance.now() - releasedAt.current < 250;
    if (reduced || fromPress) return;
    const controls = animate(scaleX, [1, 1.16, 1], {
      duration: 0.34,
      times: [0, 0.4, 1],
      ease: ["easeOut", "easeInOut"],
    });
    return () => controls.stop();
  }, [on, reduced, scaleX, releasedAt]);
  const extra = pressed && !reduced ? stretch : 0;
  return (
    <motion.span
      className={styles.thumb}
      style={{ scaleX }}
      initial={false}
      animate={{ x: on ? travel - extra : 0, width: thumb + extra }}
      transition={reduced ? { duration: 0 } : { x: glide, width: motionTokens.spring.snappy }}
    />
  );
}
