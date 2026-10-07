import * as React from "react";
import { splitList } from "@/components/site/save-site";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/** A switch with its label on the right, aligned with the inputs of the same grid row. */
export function SwitchField({
  id,
  label,
  checked,
  onCheckedChange,
  disabled,
  className,
  testId,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  return (
    <Field
      orientation="horizontal"
      data-disabled={disabled || undefined}
      className={cn("min-h-9 w-auto self-end", className)}
    >
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        data-testid={testId}
      />
      <FieldLabel htmlFor={id} className="whitespace-nowrap">
        {label}
      </FieldLabel>
    </Field>
  );
}

/** Numeric input kept as text while editing, so it can be empty or mid-edit. */
export function NumberField({
  id,
  label,
  value,
  onChange,
  min,
  max,
  step,
  placeholder,
  disabled,
  required,
  mono,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: number;
  max?: number;
  step?: number | "any";
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  /** A machine value (a port): set in monospace. */
  mono?: boolean;
  testId?: string;
}) {
  return (
    <Field data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        required={required}
        onChange={(event) => onChange(event.target.value)}
        className={mono ? "font-mono" : undefined}
        data-testid={testId}
      />
    </Field>
  );
}

/** A labelled group of settings laid out on a responsive grid. */
export function SettingsGroup({
  legend,
  className,
  children,
}: {
  legend: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <FieldSet className="gap-0">
      <FieldLegend variant="label" className="text-muted-foreground">
        {legend}
      </FieldLegend>
      <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-3", className)}>{children}</div>
    </FieldSet>
  );
}

/**
 * "a, b c" edited as text, reported as a list. The text survives while it means the same list, so
 * a separator typed at the end stays.
 */
export function ListInput({
  id,
  value,
  onChange,
  placeholder,
  disabled,
  invalid,
  testId,
}: {
  id: string;
  value: string[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  const [text, setText] = React.useState(() => value.join(", "));
  const same = splitList(text).join("\n") === value.join("\n");
  return (
    <Input
      id={id}
      value={same ? text : value.join(", ")}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitList(e.target.value));
      }}
      className="font-mono"
      data-testid={testId}
    />
  );
}
