import { Field, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface Option<T extends string = string> {
  value: T;
  label: string;
}

/**
 * A select over `{ value, label }` options. The trigger shows the chosen option's label (the value
 * itself when no option has it), or `placeholder` while `value` is null (a picker that adds what
 * is picked keeps it null). `label` names the trigger when no FieldLabel does.
 */
export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  placeholder,
  label,
  id,
  className = "w-full",
  size,
  disabled,
  testId,
}: {
  value: T | null;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  label?: string;
  id?: string;
  className?: string;
  size?: "sm" | "default";
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next as T);
      }}
      items={options}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size={size}
        className={className}
        aria-label={label}
        data-testid={testId}
      >
        <SelectValue placeholder={placeholder}>
          {value === null ? undefined : (options.find((o) => o.value === value)?.label ?? value)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** An OptionSelect under its FieldLabel. */
export function FormSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <OptionSelect
        id={id}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        testId={testId}
      />
    </Field>
  );
}

const ALL = "__all__";

/** A list filter: every value (`undefined`), or one of the options. */
export function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  label,
  testId,
  className = "w-full sm:w-48",
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allLabel: string;
  options: readonly Option[];
  label: string;
  testId: string;
  className?: string;
}) {
  return (
    <OptionSelect
      value={value ?? ALL}
      onChange={(next) => onChange(next === ALL ? undefined : next)}
      options={[{ label: allLabel, value: ALL }, ...options]}
      label={label}
      testId={testId}
      className={className}
    />
  );
}
