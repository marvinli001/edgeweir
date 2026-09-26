import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

export function DomainOwnershipPanel({ siteId, isAdmin }: { siteId: string; isAdmin: boolean }) {
  const query = useQuery(orpc.domainOwnership.get.queryOptions({ input: { siteId } }));
  const queries = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (input: {
      kind: "prepare" | "verify" | "revoke" | "approve";
      domain?: string;
    }) => {
      if (input.kind === "approve")
        await client.domainOwnership.approve({ siteId, domain: input.domain ?? "" });
      else if (input.kind === "prepare") await client.domainOwnership.prepare({ siteId });
      else if (input.kind === "verify")
        await client.domainOwnership.verify({ siteId, domain: input.domain ?? "" });
      else await client.domainOwnership.revoke({ siteId, domain: input.domain ?? "" });
      await queries.invalidateQueries();
      toast.success(m.common_saved());
    },
  });
  const run = async (kind: "prepare" | "verify" | "revoke" | "approve", domain?: string) => {
    try {
      await mutation.mutateAsync({ kind, domain });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <Card data-testid="domain-ownership">
      <CardHeader>
        <CardTitle>{m.ownership_title()}</CardTitle>
        <SafetyNote>{m.ownership_note()}</SafetyNote>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data.length === 0 ? (
          <EmptyState title={m.ownership_empty()} />
        ) : (
          query.data.map((proof) => (
            <div key={proof.domain} className="flex flex-col gap-3 border-b pb-4 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-all font-mono text-sm">{proof.domain}</span>
                <Badge variant={proof.verified ? "secondary" : "outline"}>
                  {proof.verified
                    ? proof.method === "admin"
                      ? m.ownership_exempt()
                      : m.ownership_verified()
                    : m.ownership_pending()}
                </Badge>
              </div>
              {!proof.verified && proof.txtValue ? (
                <dl className="grid gap-3 text-sm">
                  <div>
                    <dt className="text-xs text-muted-foreground">{m.ownership_record_name()}</dt>
                    <dd className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all">{proof.txtName}</code>
                      <CopyButton iconOnly value={proof.txtName} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">{m.ownership_record_value()}</dt>
                    <dd className="flex items-start gap-2">
                      <code className="min-w-0 flex-1 break-all" data-testid="ownership-token">
                        {proof.txtValue}
                      </code>
                      <CopyButton iconOnly value={proof.txtValue} />
                    </dd>
                  </div>
                </dl>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {proof.verified ? (
                  <ConfirmDialog
                    title={m.ownership_revoke()}
                    note={m.ownership_revoke_note({ domain: proof.domain })}
                    destructive
                    trigger={
                      <Button variant="outline" disabled={mutation.isPending}>
                        {m.ownership_revoke()}
                      </Button>
                    }
                    onConfirm={() => run("revoke", proof.domain)}
                  />
                ) : (
                  <>
                    {proof.txtValue ? (
                      <Button
                        onClick={() => void run("verify", proof.domain)}
                        disabled={mutation.isPending}
                        data-testid="ownership-verify"
                      >
                        {mutation.isPending ? <Spinner /> : null}
                        {m.ownership_verify()}
                      </Button>
                    ) : (
                      <Button onClick={() => void run("prepare")} disabled={mutation.isPending}>
                        {m.ownership_prepare()}
                      </Button>
                    )}
                    {isAdmin ? (
                      <ConfirmDialog
                        title={m.ownership_approve()}
                        note={proof.domain}
                        trigger={
                          <Button variant="outline" disabled={mutation.isPending}>
                            {m.ownership_approve()}
                          </Button>
                        }
                        onConfirm={() => run("approve", proof.domain)}
                      />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
