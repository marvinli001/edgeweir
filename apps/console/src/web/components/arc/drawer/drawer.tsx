/*
 * Drawer: ported from Arc's `drawer` (Copyright (c) 2026 Elia Kuratli, MIT License;
 * THIRD-PARTY-NOTICES.md), the primitive switched from Radix to Base UI. Changes: Base UI's
 * Dialog with CSS transitions on data-starting-style / data-ending-style instead of Motion springs
 * (no drag to dismiss: the console's Motion has no gesture features), no description slot,
 * Hugeicons instead of Lucide, Paraglide text, `--arc-` tokens (foundation.css), and the module
 * sits in Tailwind's components layer.
 */
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { ReactNode } from "react";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import styles from "./drawer.module.css";

export function Drawer(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />;
}

export interface DrawerContentProps extends Omit<DialogPrimitive.Popup.Props, "title"> {
  title: ReactNode;
  children: ReactNode;
  side?: "left" | "right" | "top" | "bottom";
  /** Actions under the body (save, cancel), on a hairline. */
  footer?: ReactNode;
  className?: string;
}

export function DrawerContent({
  title,
  children,
  side = "right",
  footer,
  className,
  ...props
}: DrawerContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop className={styles.overlay} />
      <DialogPrimitive.Popup
        data-slot="drawer-content"
        data-side={side}
        className={cn(styles.content, className)}
        {...props}
      >
        <div className={styles.header}>
          <DialogPrimitive.Title className={styles.title}>{title}</DialogPrimitive.Title>
          <DialogPrimitive.Close className={styles.close} aria-label={m.common_close()}>
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.75} aria-hidden="true" />
          </DialogPrimitive.Close>
        </div>
        <div className={styles.body}>{children}</div>
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}
