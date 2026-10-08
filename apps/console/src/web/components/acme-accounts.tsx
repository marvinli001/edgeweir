import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { caLabel } from "@/components/acme-ca";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { enterDelay } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * The console's ACME accounts: directory (its CA), email, EAB key ID,
 * creation time and the certificates issued with each. An account no
 * certificate uses can be deleted.
 */
export function AcmeAccountsCard() {
  const client = useQueryClient();
  const accounts = useQuery(orpc.acmeAccounts.list.queryOptions());
  const remove = useMutation(orpc.acmeAccounts.delete.mutationOptions());
  return (
    <Card data-testid="acme-accounts">
      <CardHeader>
        <CardTitle>{m.cert_accounts_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView query={accounts} empty={<EmptyState title={m.cert_accounts_empty()} />}>
          {(list) =>
            list.map((account, index) => (
              <div
                key={account.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-3 animate-enter first:pt-0 last:border-0 last:pb-0"
                style={enterDelay(index)}
                data-testid="acme-account"
              >
                <div className="flex min-w-48 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium break-all">{account.email}</span>
                    {account.ca ? <Badge variant="secondary">{caLabel(account.ca)}</Badge> : null}
                  </div>
                  <p className="font-mono text-xs break-all text-muted-foreground">
                    {account.directoryUrl}
                  </p>
                  {account.eabKid ? (
                    <p className="text-xs break-all text-muted-foreground">
                      {m.cert_eab_kid()}: <span className="font-mono">{account.eabKid}</span>
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col gap-1 text-sm text-muted-foreground">
                  <span>{m.cert_account_created({ date: formatDateTime(account.createdAt) })}</span>
                  <span data-testid="acme-account-certificates">
                    {m.cert_account_certificates({ count: account.certificates })}
                  </span>
                </div>
                <ConfirmDialog
                  title={m.cert_account_delete_confirm({ email: account.email })}
                  destructive
                  trigger={
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={account.certificates > 0}
                      data-testid="acme-account-delete"
                    >
                      {m.common_delete()}
                    </Button>
                  }
                  onConfirm={async () => {
                    await remove.mutateAsync({ id: account.id });
                    await client.invalidateQueries();
                  }}
                />
              </div>
            ))
          }
        </QueryView>
      </CardContent>
    </Card>
  );
}
