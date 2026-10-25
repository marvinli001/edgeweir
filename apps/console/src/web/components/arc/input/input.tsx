/*
 * Input: ported from Arc's `input` (MIT, Elia Kuratli; THIRD-PARTY-NOTICES.md), the primitive
 * switched to Base UI's Input. Changes: the control only. The label, helper and error rows stay
 * with Field (FieldLabel, FieldError), since the console composes inputs with InputGroup addons
 * and labels some by aria-label alone; `--arc-` tokens (foundation.css), the console's focus ring,
 * and the module sits in Tailwind's components layer.
 */
import { Input as InputPrimitive } from "@base-ui/react/input";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import styles from "./input.module.css";

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(styles.input, className)}
      {...props}
    />
  );
}
