import {
  ERROR_PAGE_MAX_BYTES,
  ERROR_PAGE_PLACEHOLDERS,
  RULES_V3_PLACEHOLDERS,
  utf8Bytes,
} from "@edgeweir/contract";
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
  /** The status (or class, "4xx") the page answers, shown before its name and in the size error. */
  status: number | string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  testId: string;
}) {
  return (
    <Field
      data-invalid={templateTooLarge(value) || undefined}
      data-disabled={disabled || undefined}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <TemplateLabel htmlFor={id} status={status} name={name} />
        <TemplateBytes value={value} testId={testId} />
      </div>
      <TemplateInput
        id={id}
        status={status}
        value={value}
        onChange={onChange}
        disabled={disabled}
        testId={testId}
      />
    </Field>
  );
}

/** The label of a page: its status (or class) in figures, then its name. */
export function TemplateLabel({
  id,
  htmlFor,
  status,
  name,
}: {
  /** Lets the page's other controls name themselves after it (`aria-labelledby`). */
  id?: string;
  htmlFor: string;
  status: number | string;
  name: string;
}) {
  return (
    <FieldLabel id={id} htmlFor={htmlFor}>
      <span className="font-mono tabular-nums">{status}</span>
      {name}
    </FieldLabel>
  );
}

/** A template's size in UTF-8 bytes against the limit, once there is text. */
export function TemplateBytes({ value, testId }: { value: string; testId: string }) {
  if (!value) return null;
  const bytes = utf8Bytes(value);
  return (
    <span
      className={cn(
        "text-xs tabular-nums text-muted-foreground",
        bytes > ERROR_PAGE_MAX_BYTES && "font-medium text-destructive",
      )}
      data-testid={`${testId}-bytes`}
    >
      {m.error_pages_bytes({
        bytes: formatNumber(bytes),
        limit: formatNumber(ERROR_PAGE_MAX_BYTES),
      })}
    </span>
  );
}

/** The template's text area, and the error of a template over the limit. */
export function TemplateInput({
  id,
  status,
  value,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  status: number | string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  testId: string;
}) {
  const over = templateTooLarge(value);
  return (
    <>
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
    </>
  );
}

/**
 * The one line on what nodes fill in: each placeholder, replaced with an HTML-escaped value;
 * without {{time}} and {{path}} while the nodes lack rules-v3 (hideRulesV3).
 */
export function TemplateVariables({
  className,
  hideRulesV3 = false,
}: {
  className?: string;
  hideRulesV3?: boolean;
}) {
  const v3: readonly string[] = RULES_V3_PLACEHOLDERS;
  return (
    <SafetyNote className={cn("leading-relaxed", className)} data-testid="error-page-variables">
      {m.error_pages_variables()}{" "}
      {ERROR_PAGE_PLACEHOLDERS.filter((p) => !(hideRulesV3 && v3.includes(p))).map(
        (placeholder) => (
          <code
            key={placeholder}
            className="mr-1 inline-block rounded-md bg-wash px-1.5 py-0.5 font-mono text-xs text-foreground"
          >
            {placeholder}
          </code>
        ),
      )}
    </SafetyNote>
  );
}
