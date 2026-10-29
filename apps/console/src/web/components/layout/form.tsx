import type * as React from "react";
import { cn } from "@/lib/utils";

/*
 * Form layout (tokens.md "Forms"). A Field is a label, its control and its error. Inside a panel
 * wider than 40rem a vertical Field lays out label-left on the 120px label column (index.css,
 * [data-slot=panel-content]); in dialogs and on phones the label sits on top. A horizontal Field
 * puts a switch or checkbox beside its label.
 */

type Orientation = "vertical" | "horizontal" | "responsive";

function FieldSet({ className, ...props }: React.ComponentProps<"fieldset">) {
  return (
    <fieldset
      data-slot="field-set"
      className={cn(
        "flex min-w-0 flex-col gap-5 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className,
      )}
      {...props}
    />
  );
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: React.ComponentProps<"legend"> & { variant?: "legend" | "label" }) {
  return (
    <legend
      data-slot="field-legend"
      data-variant={variant}
      className={cn(
        "mb-3 font-medium data-[variant=label]:text-sm data-[variant=label]:font-normal data-[variant=legend]:text-section",
        className,
      )}
      {...props}
    />
  );
}

function FieldGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-group"
      className={cn(
        "group/field-group @container/field-group flex w-full min-w-0 flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
        className,
      )}
      {...props}
    />
  );
}

const orientationClass: Record<Orientation, string> = {
  vertical: "flex-col gap-1.5 *:w-full [&>.sr-only]:w-auto",
  horizontal:
    "flex-row items-center gap-3 has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto",
  responsive:
    "flex-col gap-1.5 *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:gap-3 @md/field-group:*:w-auto @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto",
};

function Field({
  className,
  orientation = "vertical",
  ...props
}: React.ComponentProps<"div"> & { orientation?: Orientation }) {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        "group/field flex w-full min-w-0 data-[invalid=true]:text-destructive",
        orientationClass[orientation],
        className,
      )}
      {...props}
    />
  );
}

function FieldLabel({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass htmlFor or nest the control.
    <label
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-1.5 text-sm text-foreground select-none group-data-[disabled=true]/field:opacity-50 peer-disabled:cursor-not-allowed",
        className,
      )}
      {...props}
    />
  );
}

/** A line between groups of fields, optionally with a word on it ("or"). */
function FieldSeparator({ children, className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn("relative h-5 text-xs text-muted-foreground", className)}
      {...props}
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
      {children ? (
        <span
          className="relative mx-auto block w-fit bg-card px-2"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      ) : null}
    </div>
  );
}

function FieldError({
  className,
  children,
  errors,
  ...props
}: React.ComponentProps<"div"> & { errors?: Array<{ message?: string } | undefined> }) {
  const messages = children
    ? []
    : [...new Set((errors ?? []).map((error) => error?.message).filter(Boolean))];
  if (!children && messages.length === 0) return null;
  return (
    <div
      role="alert"
      data-slot="field-error"
      className={cn("text-xs text-destructive", className)}
      {...props}
    >
      {children ??
        (messages.length === 1 ? (
          messages[0]
        ) : (
          <ul className="ml-4 flex list-disc flex-col gap-1">
            {messages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ))}
    </div>
  );
}

export { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet };
