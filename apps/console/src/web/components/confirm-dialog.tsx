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
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";

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
  const [pending, setPending] = React.useState(false);
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
              disabled={pending}
              data-testid="confirm-action"
              onClick={async () => {
                setPending(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? <Spinner /> : null}
              {confirmLabel ?? m.common_confirm()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
