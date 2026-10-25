/*
 * Select: ported from Arc's `select` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the primitive
 * switched from Radix to Base UI. Changes: the console's compound parts (trigger, value, content,
 * item) instead of an `options` prop, and no built-in label (labels come from Field or the
 * trigger's aria-label); the shown value rolls up when it changes (Arc rolls by list direction,
 * which the value part does not know); transitions key off Base UI's data-starting-style /
 * data-ending-style and its --transform-origin, --anchor-width and --available-height; a small
 * trigger size; Motion's light components through components/effects/motion, the console's
 * reduced-motion hook, Hugeicons instead of Lucide, `--arc-` tokens (foundation.css), the
 * console's focus ring, and the module sits in Tailwind's components layer.
 */
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ArrowDown01Icon, ArrowUp01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { AnimatePresence, motion, type Variants } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./select.module.css";

type ClassName = { className?: string };

export const Select = SelectPrimitive.Root;

/** The new value rises in from below while the old one leaves upward. */
const valueRoll: Variants = {
  enter: { opacity: 0, y: "0.35em", filter: `blur(${motionTokens.blur.soft}px)` },
  center: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: motionTokens.duration.standard, ease: [...motionTokens.ease.enter] },
  },
  exit: {
    opacity: 0,
    y: "-0.3em",
    filter: `blur(${motionTokens.blur.subtle}px)`,
    transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] },
  },
};
/** Reduced motion keeps a short crossfade. */
const valueFade: Variants = {
  enter: { opacity: 0 },
  center: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: motionTokens.duration.instant },
  },
  exit: { opacity: 0, transition: { duration: motionTokens.duration.instant } },
};

function ValueText({ text }: { text: string }) {
  const reduced = useReducedMotion();
  return (
    <span className={styles.valueText}>
      <AnimatePresence initial={false}>
        <motion.span
          key={text}
          variants={reduced ? valueFade : valueRoll}
          initial="enter"
          animate="center"
          exit="exit"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function SelectValue({
  className,
  children,
  ...props
}: Omit<SelectPrimitive.Value.Props, "className"> & ClassName) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(styles.value, className)}
      {...props}
    >
      {typeof children === "string" ? <ValueText text={children} /> : children}
    </SelectPrimitive.Value>
  );
}

export function SelectTrigger({
  className,
  size = "default",
  children,
  ...props
}: Omit<SelectPrimitive.Trigger.Props, "className"> & ClassName & { size?: "sm" | "default" }) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(styles.trigger, className)}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        className={styles.chevron}
        render={<HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />}
      />
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "start",
  alignOffset = 0,
  alignItemWithTrigger = false,
  ...props
}: Omit<SelectPrimitive.Popup.Props, "className"> &
  ClassName &
  Pick<
    SelectPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        collisionPadding={12}
        className={styles.positioner}
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          className={cn(styles.content, className)}
          {...props}
        >
          <SelectPrimitive.ScrollUpArrow className={styles.scrollButton}>
            <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
          </SelectPrimitive.ScrollUpArrow>
          <SelectPrimitive.List className={styles.list}>{children}</SelectPrimitive.List>
          <SelectPrimitive.ScrollDownArrow className={styles.scrollButton}>
            <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
          </SelectPrimitive.ScrollDownArrow>
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  ...props
}: Omit<SelectPrimitive.Item.Props, "className"> & ClassName) {
  return (
    <SelectPrimitive.Item data-slot="select-item" className={cn(styles.item, className)} {...props}>
      <SelectPrimitive.ItemText className={styles.itemText}>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className={styles.indicator}>
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}
