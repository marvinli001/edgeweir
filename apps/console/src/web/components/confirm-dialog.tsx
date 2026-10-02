import * as React from "react";
import { SafetyNote } from "@/components/safety-note";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

/**
 * Confirmation for irreversible or publishing actions, opened by `trigger`. A failure stays in the
 * dialog with its message, and the dialog stays open.
 */
export function ConfirmDialog({
  trigger,
  ...props
}: {
  trigger: React.ReactElement;
  title: string;
  /** One line on what exactly the action touches (a safety note, not an explanation). */
  note?: string;
  /** What the action changes, e.g. a list of the sites it touches. */
  children?: React.ReactNode;
  confirmLabel?: string;
  /** While what the action changes is not known, or it cannot be done. */
  confirmDisabled?: boolean;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
  /** Follows the dialog opening and closing (e.g. to load what `children` show). */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const { onOpenChange } = props;
  const change = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      {React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => change(true),
      })}
      <ControlledConfirmDialog
        {...props}
        open={open}
        onOpenChange={change}
        destructive={props.destructive ?? false}
      />
    </>
  );
}

/**
 * A confirmation opened from a menu item, a switch or a parent's state (destructive unless
 * `destructive` is false); a failure stays in the dialog with its message.
 */
export function ControlledConfirmDialog({
  open,
  onOpenChange,
  title,
  note,
  children,
  confirmLabel,
  confirmDisabled = false,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line on what exactly the action touches (a safety note, not an explanation). */
  note?: string;
  /** What the action changes, e.g. a list of the sites it touches. */
  children?: React.ReactNode;
  confirmLabel?: string;
  /** While what the action changes is not known, or it cannot be done. */
  confirmDisabled?: boolean;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const action = useAction();
  const [error, setError] = React.useState<string | null>(null);
  const noteId = React.useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent aria-describedby={note ? noteId : undefined}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {note ? <SafetyNote id={noteId}>{note}</SafetyNote> : null}
        </DialogHeader>
        {children}
        {error ? (
          <FieldError data-testid="confirm-error" className="animate-in fade-in">
            {error}
          </FieldError>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {m.common_cancel()}
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={action.pending || confirmDisabled}
            data-testid="confirm-action"
            onClick={async () => {
              setError(null);
              try {
                await action.run(onConfirm);
                onOpenChange(false);
              } catch (err) {
                setError(errorMessage(err));
              }
            }}
          >
            {action.pending ? <Spinner /> : null}
            {confirmLabel ?? m.common_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
