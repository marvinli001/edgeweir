import { ERROR_PAGE_MAX_BYTES, ERROR_PAGE_PLACEHOLDERS, utf8Bytes } from "@edgeweir/contract";
import { SafetyNote } from "@/components/safety-note";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Whether a template is over the nodes' limit (64 KiB of UTF-8). */
export const templateTooLarge = (template: string) => utf8Bytes(template) > ERROR_PAGE_MAX_BYTES;

/**
 * An error page template: empty means the nodes' built-in page. Its size in
 * UTF-8 bytes shows once there is text, and a template over the limit says so.
 */
export function TemplateField({
  id,
  status,
  name,
  value,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  /** The status the page answers with, shown before its name and in the size error. */
  status: number;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  testId: string;
}) {
  const bytes = utf8Bytes(value);
  const over = bytes > ERROR_PAGE_MAX_BYTES;
  return (
    <Field data-invalid={over || undefined} data-disabled={disabled || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <FieldLabel htmlFor={id}>
          <span className="font-mono tabular-nums">{status}</span>
          {name}
        </FieldLabel>
        {value ? (
          <span
            className={cn(
              "text-xs tabular-nums text-muted-foreground",
              over && "font-medium text-destructive",
            )}
            data-testid={`${testId}-bytes`}
          >
            {m.error_pages_bytes({
              bytes: formatNumber(bytes),
              limit: formatNumber(ERROR_PAGE_MAX_BYTES),
            })}
          </span>
        ) : null}
      </div>
      <Textarea
        id={id}
        value={value}
        rows={4}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder={m.error_pages_placeholder()}
        aria-invalid={over || undefined}
        className="max-h-72 min-h-24 font-mono text-sm break-all"
        data-testid={testId}
      />
      {over ? (
        <FieldError className="animate-in fade-in" data-testid={`${testId}-too-large`}>
          {m.error_error_page_too_large({
            status: String(status),
            limit: formatNumber(ERROR_PAGE_MAX_BYTES),
          })}
        </FieldError>
      ) : null}
    </Field>
  );
}

/** The one line on what nodes fill in: each placeholder, replaced with an HTML-escaped value. */
export function TemplateVariables({ className }: { className?: string }) {
  return (
    <SafetyNote className={cn("leading-relaxed", className)} data-testid="error-page-variables">
      {m.error_pages_variables()}{" "}
      {ERROR_PAGE_PLACEHOLDERS.map((placeholder) => (
        <code
          key={placeholder}
          className="mr-1 inline-block rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
        >
          {placeholder}
        </code>
      ))}
    </SafetyNote>
  );
}
