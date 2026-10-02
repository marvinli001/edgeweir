import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@/components/copy-button";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
export function CnameTarget({ siteId }: { siteId: string }) {
  const query = useQuery(
    orpc.dns.siteTarget.queryOptions({
      input: { siteId },
      refetchInterval: 15000,
      meta: { background: true },
    }),
  );
  if (query.isPending) return <LoadingState />;
  if (query.isLoadingError)
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (!query.data.target) return null;
  return (
    <Card data-testid="cname-target">
      <CardHeader>
        <CardTitle>{m.dns_cname_target()}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-sm" data-testid="cname-target-value">
            {query.data.target}
          </code>
          <CopyButton iconOnly value={query.data.target} />
          <Badge variant="outline" data-testid="cname-target-status">
            {query.data.mode === "manual"
              ? m.dns_mode_manual()
              : query.data.published
                ? query.data.healthy
                  ? m.dns_applied()
                  : m.dns_no_healthy_nodes()
                : m.dns_pending()}
          </Badge>
        </div>
        {query.data.lines.map((line) => (
          <div key={line.name} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted-foreground">{line.name}</span>
            <code className="min-w-0 flex-1 break-all">{line.target}</code>
            <CopyButton iconOnly value={line.target} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
