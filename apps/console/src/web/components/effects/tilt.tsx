/*
 * Tilt: adapted from Motion Primitives (MIT, ibelick; THIRD-PARTY-NOTICES.md). Changes: at most a
 * few degrees, still for touch screens and reduced motion, and the pointer resets on leave with a
 * spring.
 */
import {
  type MotionStyle,
  motion,
  type SpringOptions,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
} from "motion/react";
import * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { useFinePointer } from "./use-live";

export function Tilt({
  children,
  className,
  style,
  rotationFactor = 4,
  springOptions = { stiffness: 260, damping: 26 },
}: {
  children: React.ReactNode;
  className?: string;
  style?: MotionStyle;
  /** Largest rotation in degrees. */
  rotationFactor?: number;
  springOptions?: SpringOptions;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const xSpring = useSpring(x, springOptions);
  const ySpring = useSpring(y, springOptions);
  const rotateX = useTransform(ySpring, [-0.5, 0.5], [rotationFactor, -rotationFactor]);
  const rotateY = useTransform(xSpring, [-0.5, 0.5], [-rotationFactor, rotationFactor]);
  const transform = useMotionTemplate`perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;

  return (
    <motion.div
      ref={ref}
      className={className}
      style={enabled ? { transformStyle: "preserve-3d", ...style, transform } : style}
      onPointerMove={
        enabled
          ? (event) => {
              const bounds = ref.current?.getBoundingClientRect();
              if (!bounds) return;
              x.set((event.clientX - bounds.left) / bounds.width - 0.5);
              y.set((event.clientY - bounds.top) / bounds.height - 0.5);
            }
          : undefined
      }
      onPointerLeave={
        enabled
          ? () => {
              x.set(0);
              y.set(0);
            }
          : undefined
      }
    >
      {children}
    </motion.div>
  );
}
