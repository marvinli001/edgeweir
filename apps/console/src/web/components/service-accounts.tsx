import {
  type ServiceAccount,
  type ServiceAccountScope,
  serviceAccountScope,
} from "@edgeweir/contract";
import { Add01Icon, Delete02Icon, Key01Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const SCOPES = serviceAccountScope.options;

function AccountDialog({
  account,
  open,
  onOpenChange,
}: {
  account?: ServiceAccount;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.serviceAccounts.create.mutationOptions());
  const update = useMutation(orpc.serviceAccounts.update.mutationOptions());
  const [scopes, setScopes] = React.useState<ServiceAccountScope[]>(account?.scopes ?? []);
  const [enabled, setEnabled] = React.useState(account?.enabled ?? true);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={account ? m.service_accounts_edit() : m.service_accounts_create()}
      submitLabel={account ? m.common_save() : m.common_create()}
      submitTestId="service-account-submit"
      onSubmit={async (data) => {
        const name = String(data.get("accountName") ?? "").trim();
        if (account) await update.mutateAsync({ id: account.id, name, scopes, enabled });
        else await create.mutateAsync({ name, scopes, enabled });
        await queryClient.invalidateQueries({ queryKey: orpc.serviceAccounts.key() });
        toast.success(m.service_accounts_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="accountName">{m.service_accounts_name()}</FieldLabel>
        <Input
          id="accountName"
          name="accountName"
          required
          maxLength={64}
          defaultValue={account?.name}
          placeholder="billing"
          data-testid="service-account-name"
        />
      </Field>
      <FieldSet>
        <FieldLegend variant="label">{m.service_accounts_scopes()}</FieldLegend>
        <div className="grid gap-2.5 rounded-2xl p-3 sm:grid-cols-2 sunk-well">
          {SCOPES.map((scope) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
            <label
              key={scope}
              className="flex items-center gap-2 font-mono text-xs"
              data-testid="service-account-scope"
            >
              <Checkbox
                checked={scopes.includes(scope)}
                onCheckedChange={(checked) =>
                  setScopes(checked ? [...scopes, scope] : scopes.filter((s) => s !== scope))
                }
              />
              {scope}
            </label>
          ))}
        </div>
      </FieldSet>
      <SwitchField
        id="accountEnabled"
        label={m.service_accounts_enabled()}
        checked={enabled}
        onCheckedChange={setEnabled}
        className="self-start"
      />
    </FormDialog>
  );
}

function KeysDialog({ account, open, onOpenChange }: { account: ServiceAccount } & DialogProps) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.serviceAccounts.createKey.mutationOptions());
  const revoke = useMutation(orpc.serviceAccounts.revokeKey.mutationOptions());
  const [name, setName] = React.useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.serviceAccounts.key() });
  // Closing forgets the new key's secret: it is shown once.
  const setOpen = (next: boolean) => {
    if (!next) create.reset();
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {m.service_accounts_keys()} · {account.name}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await create.mutateAsync({ id: account.id, name: name.trim() });
              setName("");
              await refresh();
              toast.success(m.service_accounts_key_created());
            } catch (err) {
              toast.error(errorMessage(err));
            }
          }}
        >
          <Field className="w-full sm:w-56">
            <FieldLabel htmlFor="keyName">{m.service_accounts_key_name()}</FieldLabel>
            <Input
              id="keyName"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              placeholder="primary"
            />
          </Field>
          <Button
            type="submit"
            disabled={create.isPending}
            data-testid="service-account-key-create"
          >
            {create.isPending ? <Spinner /> : <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />}
            {m.service_accounts_key_create()}
          </Button>
        </form>
        {create.data?.secret ? (
          <Field className="animate-enter">
            <CodeBlock value={create.data.secret} testId="service-account-secret" />
            <SafetyNote>{m.service_accounts_key_shown_once()}</SafetyNote>
          </Field>
        ) : null}
        {account.keys.length === 0 ? (
          <EmptyState icon={Key01Icon} title={m.service_accounts_no_keys()} />
        ) : (
          <ul
            className="divide-y divide-edge rounded-2xl text-sm sunk-well"
            data-testid="service-account-keys"
          >
            {account.keys.map((k, index) => (
              <li
                key={k.id}
                className="flex min-h-12 items-center gap-3 px-3 py-2 animate-enter"
                style={enterDelay(index)}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <span className="font-medium">{k.name || "—"}</span>
                    <code className="font-mono text-xs text-muted-foreground">{k.prefix}…</code>
                    {k.revokedAt ? (
                      <Badge variant="secondary">{m.service_accounts_key_revoked()}</Badge>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {m.service_accounts_key_last_used()}{" "}
                    {k.lastUsedAt ? (
                      <span title={formatDateTime(k.lastUsedAt)}>{timeAgo(k.lastUsedAt)}</span>
                    ) : (
                      m.service_accounts_key_never_used()
                    )}
                  </span>
                </div>
                {k.revokedAt ? null : (
                  <ConfirmDialog
                    trigger={
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0"
                        data-testid="service-account-key-revoke"
                      >
                        {m.service_accounts_key_revoke()}
                      </Button>
                    }
                    destructive
                    title={m.service_accounts_key_revoke_confirm({ prefix: k.prefix })}
                    confirmLabel={m.service_accounts_key_revoke()}
                    onConfirm={async () => {
                      await revoke.mutateAsync({ id: account.id, keyId: k.id });
                      await refresh();
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            {m.common_close()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Delete with confirmation. A component of its own: column templates are plain
 * functions (DataTable) and hold no hooks.
 */
function DeleteAccountAction({ account }: { account: ServiceAccount }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.serviceAccounts.delete.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={m.common_delete()}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.service_accounts_delete_confirm({ name: account.name })}
      note={m.service_accounts_delete_note()}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        await remove.mutateAsync({ id: account.id });
        await queryClient.invalidateQueries({ queryKey: orpc.serviceAccounts.key() });
        toast.success(m.service_accounts_deleted());
      }}
    />
  );
}

/**
 * Service accounts and their API keys for /api/v1 (a tab of the system
 * settings). `createOpen` is the page's "new service account" dialog.
 */
export function ServiceAccountsPanel({
  createOpen,
  onCreateOpenChange: setCreateOpen,
}: {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const accounts = useQuery(orpc.serviceAccounts.list.queryOptions());
  const createKey = useOpenKey(createOpen);
  const edit = useDialogState<ServiceAccount>();
  // The account whose keys are open, from the list so they stay current.
  const keys = useDialogState<string>();
  const keysAccount = accounts.data?.find((a) => a.id === keys.value);
  const columns = React.useMemo<Columns<ServiceAccount>>(
    () => [
      {
        id: "name",
        header: () => m.service_accounts_name(),
        cell: ({ row }) => (
          <span className="font-medium" data-testid="service-account-row-name">
            {row.original.name}
          </span>
        ),
      },
      {
        id: "status",
        header: () => m.sites_col_status(),
        cell: ({ row }) =>
          row.original.enabled ? (
            <StatusDot tone="good">{m.service_accounts_active()}</StatusDot>
          ) : (
            <StatusDot tone="idle">{m.service_accounts_disabled()}</StatusDot>
          ),
      },
      {
        id: "scopes",
        header: () => m.service_accounts_scopes(),
        cell: ({ row }) => (
          <div className="flex max-w-md flex-wrap gap-1">
            {row.original.scopes.map((scope) => (
              <Badge key={scope} variant="outline" className="font-mono">
                {scope}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "keys",
        header: () => m.service_accounts_keys(),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.keys.filter((k) => !k.revokedAt).length}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => keys.show(row.original.id)}
              data-testid="service-account-keys-open"
            >
              {m.service_accounts_keys()}
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.service_accounts_edit()}
              onClick={() => edit.show(row.original)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            <DeleteAccountAction account={row.original} />
          </div>
        ),
      },
    ],
    [keys.show, edit.show],
  );
  return (
    <>
      <QueryView
        query={accounts}
        empty={
          <EmptyState icon={Key01Icon} title={m.service_accounts_empty()}>
            <Button onClick={() => setCreateOpen(true)}>{m.service_accounts_create()}</Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(a) => a.id}
            testId="service-accounts-table"
            pinFirstColumn
          />
        )}
      </QueryView>
      <AccountDialog key={`create-${createKey}`} open={createOpen} onOpenChange={setCreateOpen} />
      {edit.value ? (
        <AccountDialog
          key={`edit-${edit.key}`}
          account={edit.value}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
        />
      ) : null}
      {keysAccount ? (
        <KeysDialog
          key={`keys-${keys.key}`}
          account={keysAccount}
          open={keys.open}
          onOpenChange={keys.onOpenChange}
        />
      ) : null}
    </>
  );
}
