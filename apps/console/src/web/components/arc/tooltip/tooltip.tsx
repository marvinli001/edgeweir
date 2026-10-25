/*
 * Tooltip: ported from Arc's `tooltip` (Copyright (c) 2026 Elia Kuratli, MIT License;
 * THIRD-PARTY-NOTICES.md), the primitive switched from Radix to Base UI. Changes: the console's
 * compound parts (provider, root, trigger, content) instead of a `content` prop; Arc's shared
 * warm-up becomes Base UI's provider delay and timeout, and its instant flag Base UI's
 * data-instant; transitions key off Base UI's data-starting-style / data-ending-style; Motion's
 * light components through components/effects/motion, the console's reduced-motion hook, `--arc-`
 * tokens (foundation.css), and the module sits in Tailwind's components layer.
 */
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./tooltip.module.css";

/** The first tooltip waits 250 ms; within 300 ms of the last one closing, the next opens at once. */
export function TooltipProvider({
  delay = 250,
  timeout = 300,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      timeout={timeout}
      {...props}
    />
  );
}

export function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

export function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

export function TooltipContent({
  className,
  side = "top",
  sideOffset = 8,
  align = "center",
  alignOffset = 0,
  children,
  ...props
}: Omit<TooltipPrimitive.Popup.Props, "className"> & { className?: string } & Pick<
    TooltipPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        collisionPadding={12}
        className={styles.positioner}
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(styles.tooltip, className)}
          {...props}
        >
          {typeof children === "string" || typeof children === "number" ? (
            <TooltipText text={String(children)} />
          ) : (
            children
          )}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

/** String content crossfades when it changes while open, and the bubble springs to the new text size. */
function TooltipText({ text }: { text: string }) {
  const reduced = useReducedMotion();
  const measure = useRef<HTMLSpanElement>(null);
  const measured = useRef<string | null>(null);
  const [size, setSize] = useState<{ width: number; height: number; animate: boolean } | null>(
    null,
  );
  useLayoutEffect(() => {
    const node = measure.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const box = entry.borderBoxSize?.[0];
      const current = node.textContent;
      const animate = measured.current !== null && measured.current !== current;
      measured.current = current;
      setSize({
        width: Math.ceil(box?.inlineSize ?? node.offsetWidth),
        height: Math.ceil(box?.blockSize ?? node.offsetHeight),
        animate,
      });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <motion.span
      className={styles.text}
      initial={false}
      animate={size ? { width: size.width, height: size.height } : undefined}
      transition={size?.animate && !reduced ? motionTokens.spring.morph : { duration: 0 }}
    >
      <span ref={measure} className={styles.measure} aria-hidden="true">
        {text}
      </span>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          className={styles.line}
          initial={
            reduced
              ? false
              : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }
          }
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={
            reduced
              ? { opacity: 0, transition: { duration: 0 } }
              : {
                  opacity: 0,
                  y: "-0.3em",
                  filter: `blur(${motionTokens.blur.subtle}px)`,
                  transition: {
                    duration: motionTokens.duration.instant,
                    ease: [...motionTokens.ease.standard],
                  },
                }
          }
          transition={{
            duration: motionTokens.duration.standard,
            ease: [...motionTokens.ease.enter],
          }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}
