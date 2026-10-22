import { FormSelect } from "@/components/form-select";
import { m } from "@/lib/i18n";

export function StatusSelect({
  id,
  value,
  codes,
  onChange,
}: {
  id: string;
  value: number;
  codes: number[];
  onChange: (code: number) => void;
}) {
  return (
    <FormSelect
      id={`status-${id}`}
      label={m.rules_status()}
      value={String(value)}
      options={codes.map((code) => ({ value: String(code), label: String(code) }))}
      onChange={(code) => onChange(Number(code))}
    />
  );
}

/** The text of a value expression that is just a string literal, else "". */
export function literalText(source: string): string {
  try {
    const value: unknown = JSON.parse(source);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}
