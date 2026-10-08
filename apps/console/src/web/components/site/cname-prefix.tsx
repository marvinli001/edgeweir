import { CNAME_PREFIX_RE, type CnamePrefixState } from "@edgeweir/contract";
import { PencilEdit01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

/**
 * Regenerates or sets the first label of a CNAME target (sites and layer-4
 * applications), and lists replaced names still resolving with a way to
 * take one back (also an id prefix from before CNAME prefixes).
 * `change(undefined)` asks for a new random prefix.
 */
export function CnamePrefixActions({
  prefix,
  retired = [],
  change,
  testId = "cname-prefix",
}: {
  prefix: string;
  /** Replaced names that still resolve (`<prefix>.<cluster domain>`). */
  retired?: { name: string; expiresAt: string }[];
  change: (prefix?: string) => Promise<CnamePrefixState>;
  testId?: string;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const valid = CNAME_PREFIX_RE.test(value.trim().toLowerCase());
  const done = () => toast.success(m.cname_prefix_saved());
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <RetiredNames
        names={retired}
        onRestore={async (name) => {
          await change(name.split(".")[0] ?? "");
          done();
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <ConfirmDialog
          title={m.cname_prefix_regenerate_title()}
          note={m.cname_prefix_grace()}
          confirmLabel={m.cname_prefix_regenerate()}
          onConfirm={async () => {
            await change();
            done();
          }}
          trigger={
            <Button type="button" variant="outline" size="sm" data-testid={`${testId}-regenerate`}>
              <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
              {m.cname_prefix_regenerate()}
            </Button>
          }
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={editing}
          onClick={() => {
            setEditing(!editing);
            setValue(prefix.length <= 30 ? prefix : "");
            setError(null);
          }}
          data-testid={`${testId}-customize`}
        >
          <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
          {m.cname_prefix_customize()}
        </Button>
      </div>
      {editing ? (
        <form
          className="flex flex-col gap-2 animate-enter"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!valid) return;
            setPending(true);
            setError(null);
            try {
              await change(value.trim().toLowerCase());
              setEditing(false);
              done();
            } catch (failure) {
              setError(errorMessage(failure));
            } finally {
              setPending(false);
            }
          }}
        >
          <Field data-invalid={value && !valid ? true : undefined}>
            <FieldLabel htmlFor={`${testId}-input`}>{m.cname_prefix()}</FieldLabel>
            <div className="flex gap-2">
              <Input
                id={`${testId}-input`}
                value={value}
                maxLength={30}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                onChange={(event) => {
                  setValue(event.target.value);
                  setError(null);
                }}
                data-testid={`${testId}-input`}
              />
              <Button type="submit" disabled={!valid || pending} data-testid={`${testId}-save`}>
                {pending ? <Spinner /> : null}
                {m.common_save()}
              </Button>
            </div>
            {value && !valid ? <FieldError>{m.cname_prefix_invalid()}</FieldError> : null}
            {error ? <FieldError data-testid={`${testId}-error`}>{error}</FieldError> : null}
          </Field>
        </form>
      ) : null}
    </div>
  );
}

/** Names of replaced prefixes that still resolve, with the time they stop and a way back. */
function RetiredNames({
  names,
  onRestore,
}: {
  names: { name: string; expiresAt: string }[];
  onRestore: (name: string) => Promise<void>;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  if (!names.length) return null;
  return (
    <ul className="grid gap-1" data-testid="cname-retired">
      {names.map((retired) => (
        <li key={retired.name} className="flex flex-wrap items-center gap-2 text-xs">
          <code className="min-w-0 break-all text-muted-foreground line-through decoration-1">
            {retired.name}
          </code>
          <span className="text-muted-foreground" data-testid="cname-retired-until">
            {m.cname_retired_until({ time: formatDateTime(retired.expiresAt) })}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={pending !== null}
            onClick={async () => {
              setPending(retired.name);
              try {
                await onRestore(retired.name);
              } catch (failure) {
                toast.error(errorMessage(failure));
              } finally {
                setPending(null);
              }
            }}
            data-testid="cname-retired-restore"
          >
            {pending === retired.name ? <Spinner /> : null}
            {m.cname_prefix_restore()}
          </Button>
        </li>
      ))}
    </ul>
  );
}
