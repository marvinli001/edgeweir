import * as React from "react";
import { splitList } from "@/components/site/save-site";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const splitLines = (value: string) =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * A list edited as text in a textarea: one item per line (`lines`), or separated by commas and
 * spaces (`words`, for short tokens). The text survives while it means the same list, so a
 * separator typed at the end stays.
 */
export function ListText({
  id,
  label,
  value,
  onChange,
  mode = "lines",
  placeholder,
  disabled,
  invalid,
  testId,
}: {
  id: string;
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  mode?: "lines" | "words";
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  const split = mode === "lines" ? splitLines : splitList;
  const join = (list: string[]) => list.join(mode === "lines" ? "\n" : ", ");
  const [text, setText] = React.useState(() => join(value));
  const same = split(text).join("\n") === value.join("\n");
  return (
    <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        rows={2}
        value={same ? text : join(value)}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoCapitalize="off"
        onChange={(event) => {
          setText(event.target.value);
          onChange(split(event.target.value));
        }}
        className="max-h-60 overflow-y-auto font-mono text-sm"
        data-testid={testId}
      />
    </Field>
  );
}

/** A one-line text field under its label (a machine value: monospace). */
export function TextField({
  id,
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  disabled,
  invalid,
  testId,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  maxLength?: number;
  disabled?: boolean;
  invalid?: boolean;
  testId?: string;
}) {
  return (
    <Field data-invalid={invalid || undefined} data-disabled={disabled || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        className="font-mono text-sm"
        data-testid={testId}
      />
    </Field>
  );
}
