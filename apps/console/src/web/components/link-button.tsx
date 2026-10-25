/*
 * A router link drawn as an Arc Button. Navigation stays an anchor (href, middle-click, open in a
 * new tab), so it borrows Button's styles instead of rendering a <button>; there is no press scale.
 */
import { createLink } from "@tanstack/react-router";
import type * as React from "react";
import type { ButtonSize, ButtonVariant } from "@/components/arc/button/button";
import styles from "@/components/arc/button/button.module.css";
import { cn } from "@/lib/utils";

function ButtonAnchor({
  variant = "primary",
  size = "md",
  className,
  children,
  ...props
}: React.ComponentProps<"a"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <a className={cn(styles.button, styles[variant], styles[size], className)} {...props}>
      <span className={cn(styles.labelPhase, "min-w-0")}>{children}</span>
    </a>
  );
}

export const LinkButton = createLink(ButtonAnchor);
