/*
 * Dialog: ported from Arc's `dialog` (Copyright (c) 2026 Elia Kuratli, MIT License;
 * THIRD-PARTY-NOTICES.md), the primitive switched from Radix to Base UI. Changes: the console's
 * compound parts (header, title, footer, optional close buttons) instead of `title` and
 * `description` props, so there is no description part and the body is the caller's; the overlay is
 * the console's dim without blur (polled content may sit behind it); the panel stays centred with
 * `translate` so the entrance can own `transform`; transitions key off Base UI's
 * data-starting-style / data-ending-style; Motion's light components through
 * components/effects/motion, the console's reduced-motion hook, Hugeicons instead of Lucide,
 * Paraglide text, `--arc-` tokens (foundation.css), and the module sits in Tailwind's components
 * layer.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ComponentProps } from "react";
import { AnimatePresence, motion } from "@/components/effects/motion";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Button } from "../button/button";
import { motionTokens } from "../lib/motion-tokens";
import styles from "./dialog.module.css";

type ClassName = { className?: string };

export function Dialog(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** The overlay fades while the panel rises 8px and scales up on a spring; closing is shorter and quieter. */
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "className"> & ClassName & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className={styles.overlay} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(styles.content, className)}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={styles.close}
            aria-label={m.common_close()}
          >
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...props }: ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn(styles.header, className)} {...props} />;
}

export function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentProps<"div"> & { showCloseButton?: boolean }) {
  return (
    <div data-slot="dialog-footer" className={cn(styles.footer, className)} {...props}>
      {children}
      {showCloseButton ? (
        <DialogPrimitive.Close render={<Button variant="secondary" />}>
          {m.common_close()}
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

export function DialogTitle({
  className,
  children,
  ...props
}: Omit<DialogPrimitive.Title.Props, "className"> & ClassName) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(styles.title, className)}
      {...props}
    >
      {typeof children === "string" ? <SwapText text={children} /> : children}
    </DialogPrimitive.Title>
  );
}

/** When the title changes while open, the new copy rises in and the old copy leaves upward. */
function SwapText({ text }: { text: string }) {
  const reduced = useReducedMotion();
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={text}
        className={styles.swap}
        initial={
          reduced ? false : { opacity: 0, y: "0.3em", filter: `blur(${motionTokens.blur.soft}px)` }
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
                  duration: motionTokens.duration.fast,
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
  );
}
