import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError, FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { errorMessage } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/**
 * A dialog around one form: title, fields, then a footer row (hairline above, submit on the right)
 * that stays in view while a long form scrolls. `onSubmit` receives the form data; while it runs
 * the submit button shows a spinner, and a thrown error is shown localized under the fields. The
 * caller controls closing with `onOpenChange(false)`, so a form can also show its result inside
 * the dialog.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  submitLabel,
  onSubmit,
  children,
  submitTestId,
  submitDisabled,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  submitLabel: string;
  onSubmit: (data: FormData) => Promise<void>;
  children: React.ReactNode;
  submitTestId?: string;
  /** Keeps the submit button disabled (e.g. while the fields say why it cannot go ahead). */
  submitDisabled?: boolean;
  className?: string;
}) {
  const action = useAction();
  const [error, setError] = React.useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className={cn("max-h-[calc(100svh-2rem)] overflow-y-auto", className)}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            // React passes events from the portal to the components around the dialog: a dialog
            // opened inside another form would submit that form too.
            event.stopPropagation();
            const data = new FormData(event.currentTarget);
            setError(null);
            try {
              await action.run(() => onSubmit(data));
            } catch (err) {
              setError(errorMessage(err));
            }
          }}
        >
          <FieldGroup>
            {children}
            {error ? (
              <FieldError data-testid="form-error" className="animate-in fade-in">
                {error}
              </FieldError>
            ) : null}
            {/* A hairline footer row that stays in view while a long form scrolls (-bottom-6: sticky
                insets count from inside the dialog's padding). */}
            <DialogFooter className="sticky -bottom-6 z-1 -mx-6 -mb-6 border-t border-edge bg-popover px-6 py-4">
              <Button
                type="submit"
                disabled={action.pending || submitDisabled}
                data-testid={submitTestId}
              >
                {action.pending ? <Spinner /> : null}
                {submitLabel}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
