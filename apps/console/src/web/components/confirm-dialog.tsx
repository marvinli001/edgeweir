import * as React from "react";
import { SafetyNote } from "@/components/safety-note";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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

/** Confirmation for irreversible or publishing actions. */
export function ConfirmDialog({
  trigger,
  title,
  note,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  trigger: React.ReactElement;
  title: string;
  /** One line on what exactly the action touches (a safety note, not an explanation). */
  note?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = React.useState(false);
  const action = useAction();
  const noteId = React.useId();
  return (
    <>
      {React.cloneElement(trigger as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => setOpen(true),
      })}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={note ? noteId : undefined}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {note ? <SafetyNote id={noteId}>{note}</SafetyNote> : null}
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>{m.common_cancel()}</DialogClose>
            <Button
              variant={destructive ? "destructive" : "default"}
              disabled={action.pending}
              data-testid="confirm-action"
              onClick={async () => {
                await action.run(onConfirm);
                setOpen(false);
              }}
            >
              {action.pending ? <Spinner /> : null}
              {confirmLabel ?? m.common_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  confirmLabel,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** One line on what exactly the action touches (a safety note, not an explanation). */
  note?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
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
            disabled={action.pending}
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
