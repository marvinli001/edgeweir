/*
 * Textarea: ported from Arc's `textarea` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the control
 * a plain <textarea> as before. Changes: the control only (label and messages stay with Field), it
 * grows with its content (field-sizing) from the console's shorter minimum, `--arc-` tokens
 * (foundation.css), and the module sits in Tailwind's components layer.
 */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import styles from "./textarea.module.css";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(styles.control, className)} {...props} />;
}
