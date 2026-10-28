import { Delete02Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { m } from "@/lib/i18n";

/**
 * A row's or card's secondary actions behind one "…" button: `children` (DropdownMenuItems),
 * then Delete after a separator, confirmed in a dialog. The row's primary action is the row
 * itself (`rowLink`), so lists show no Edit / Delete button pairs.
 */
export function RowMenu({
  children,
  remove,
  testId,
}: {
  children?: React.ReactNode;
  remove?: {
    /** The item's label, when the action is not a plain delete (unsubscribe). */
    label?: string;
    title: string;
    note?: string;
    onConfirm: () => Promise<unknown>;
    testId?: string;
  };
  testId?: string;
}) {
  const [confirming, setConfirming] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              className="icon-button"
              size="sm"
              variant="ghost"
              aria-label={m.common_actions()}
              data-testid={testId}
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {children}
          {children && remove ? <DropdownMenuSeparator /> : null}
          {remove ? (
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setConfirming(true)}
              data-testid={remove.testId}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              {remove.label ?? m.common_delete()}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {remove ? (
        <ControlledConfirmDialog
          open={confirming}
          onOpenChange={setConfirming}
          title={remove.title}
          note={remove.note}
          confirmLabel={remove.label}
          onConfirm={remove.onConfirm}
        />
      ) : null}
    </>
  );
}
