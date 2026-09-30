import type { SiteDnsRecord } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { revisionError } from "@/components/dns/labels";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

const statusLabel = (status: SiteDnsRecord["status"]) =>
  ({
    pending: m.dns_pending,
    written: m.dns_record_written,
    conflict: m.dns_record_conflict,
    failed: m.dns_failed,
    deleting: m.dns_record_deleting,
    unsupported: m.dns_record_apex_unsupported,
  })[status]();

/**
 * Records written into the organization's own zone for this site (ownership
 * TXT, CNAME to the target). Shown when an automatic-records credential covers
 * one of the site's domains; conflicts are replaced only on confirmation.
 */
export function SiteDnsRecords({ siteId }: { siteId: string }) {
  const queries = useQueryClient();
  const records = useQuery(
    orpc.siteDns.records.queryOptions({
      input: { siteId },
      refetchInterval: 15_000,
      meta: { background: true },
    }),
  );
  const sync = useMutation(orpc.siteDns.sync.mutationOptions());
  if (records.isPending) return <LoadingState />;
  if (records.isError)
    return <ErrorState error={records.error} onRetry={() => void records.refetch()} />;
  if (!records.data.managed && !records.data.items.length) return null;
  const refresh = () => queries.invalidateQueries({ queryKey: orpc.siteDns.key() });
  return (
    <Card data-testid="site-dns-records">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="flex-1">{m.dns_auto_records()}</CardTitle>
        <Button
          size="sm"
          variant="outline"
          disabled={sync.isPending}
          data-testid="site-dns-sync"
          onClick={async () => {
            try {
              await sync.mutateAsync({ siteId });
              await refresh();
            } catch (e) {
              toast.error(errorMessage(e));
            }
          }}
        >
          {sync.isPending ? <Spinner /> : null}
          {m.dns_sync_records()}
        </Button>
      </CardHeader>
      <CardContent>
        {!records.data.items.length ? (
          <p className="text-sm text-muted-foreground">{m.dns_pending()}</p>
        ) : (
          <ul className="divide-y rounded-2xl border">
            {records.data.items.map((record, index) => (
              <li
                key={record.id}
                className="flex flex-wrap items-center gap-2 px-3 py-2 animate-enter"
                style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                data-testid="site-dns-record"
              >
                <span className="min-w-0 flex-1 font-mono text-xs break-all">
                  {record.name} {record.type} {record.data}
                </span>
                <Badge
                  variant={
                    record.status === "conflict" || record.status === "failed"
                      ? "destructive"
                      : "outline"
                  }
                  data-status={record.status}
                >
                  {statusLabel(record.status)}
                </Badge>
                {record.lastError ? (
                  <span className="text-xs text-muted-foreground">
                    {revisionError(record.lastError)}
                  </span>
                ) : null}
                {record.status === "conflict" ? (
                  <ConfirmDialog
                    title={m.dns_record_replace_confirm({ name: record.name })}
                    note={record.conflicts.map((c) => `${c.type} ${c.data}`).join(", ")}
                    destructive
                    confirmLabel={m.dns_record_replace()}
                    trigger={
                      <Button size="sm" variant="outline" data-testid="site-dns-confirm">
                        {m.dns_record_replace()}
                      </Button>
                    }
                    onConfirm={async () => {
                      try {
                        await client.siteDns.confirm({ siteId, id: record.id });
                        await refresh();
                      } catch (e) {
                        toast.error(errorMessage(e));
                      }
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
