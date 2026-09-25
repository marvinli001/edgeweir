import { Add01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { SectionCards } from "@/components/section-cards";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { revisionReason } from "@/lib/revisions";

export const Route = createFileRoute("/_app/admin/")({
  component: AdminOverviewPage,
});

function AdminOverviewPage() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 10_000,
    meta: { background: true },
  });

  return (
    <Page title={m.admin_overview_title()}>
      {overview.isPending ? (
        <LoadingState />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <>
          <SectionCards
            cards={[
              {
                label: m.admin_nodes_online(),
                value: `${formatNumber(overview.data.onlineNodes)} / ${formatNumber(overview.data.nodes)}`,
                beam:
                  overview.data.nodes === 0
                    ? undefined
                    : overview.data.onlineNodes < overview.data.nodes
                      ? "destructive"
                      : "success",
                testId: "stat-nodes",
              },
              {
                label: m.admin_latest_revision(),
                value: overview.data.revisions[0] ? `#${overview.data.revisions[0].revision}` : "—",
                footer: overview.data.revisions[0]
                  ? timeAgo(overview.data.revisions[0].createdAt)
                  : undefined,
                testId: "stat-revision",
              },
              {
                label: m.admin_clusters(),
                value: formatNumber(overview.data.clusters),
                testId: "stat-clusters",
              },
              {
                label: m.admin_sites(),
                value: formatNumber(overview.data.sites),
                testId: "stat-sites",
              },
            ]}
          />
          {overview.data.nodes === 0 ? (
            <EmptyState icon={ServerStack01Icon} title={m.nodes_empty_title()}>
              <Link to="/admin/clusters" search={{ enroll: true }} className={buttonVariants()}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.nav_add_node()}
              </Link>
            </EmptyState>
          ) : null}
          <Card className="animate-enter" style={{ animationDelay: "280ms" }}>
            <CardHeader>
              <CardTitle>{m.admin_revisions_title()}</CardTitle>
            </CardHeader>
            <CardContent>
              {overview.data.revisions.length === 0 ? (
                <EmptyState title={m.admin_revisions_empty()} />
              ) : (
                <ul className="divide-y text-sm">
                  {overview.data.revisions.map((r, index) => (
                    <li
                      key={`${r.clusterId}-${r.revision}`}
                      className="flex items-center gap-3 py-2.5 animate-enter"
                      style={{ animationDelay: `${320 + index * 40}ms` }}
                    >
                      <Badge variant="outline" className="font-mono">
                        #{r.revision}
                      </Badge>
                      <span className="flex-1 truncate">{revisionReason(r)}</span>
                      <code className="hidden text-xs text-muted-foreground sm:inline">
                        {r.contentHash.slice(0, 12)}
                      </code>
                      <span className="w-20 text-right text-xs text-muted-foreground">
                        {timeAgo(r.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Page>
  );
}
