import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { SectionCards } from "@/components/section-cards";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { TrafficChart } from "@/components/traffic-chart";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/")({
  component: OverviewPage,
});

function OverviewPage() {
  const { isAdmin } = Route.useRouteContext();
  const overview = useQuery({ ...orpc.overview.get.queryOptions(), refetchInterval: 10_000 });

  return (
    <Page title={m.overview_title()}>
      {overview.isPending ? (
        <LoadingState rows={3} />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : (
        <>
          <SectionCards
            cards={[
              {
                label: m.overview_sites(),
                value: formatNumber(overview.data.sites),
                testId: "stat-sites",
              },
              ...(isAdmin
                ? [
                    {
                      label: m.overview_clusters(),
                      value: formatNumber(overview.data.clusters),
                      testId: "stat-clusters",
                    },
                    {
                      label: m.overview_nodes_online(),
                      value: formatNumber(overview.data.onlineNodes),
                      footer: m.overview_nodes_of_total({ total: overview.data.nodes }),
                      testId: "stat-nodes",
                    },
                    {
                      label: m.overview_latest_revision(),
                      value: overview.data.revisions[0]
                        ? `#${overview.data.revisions[0].revision}`
                        : "—",
                      footer: overview.data.revisions[0]
                        ? timeAgo(overview.data.revisions[0].createdAt)
                        : undefined,
                      testId: "stat-revision",
                    },
                  ]
                : []),
            ]}
          />
          {overview.data.sites === 0 || (isAdmin && overview.data.nodes === 0) ? (
            <Card>
              <CardHeader>
                <CardTitle>{m.overview_getting_started()}</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="list-decimal space-y-2 pl-5 text-sm">
                  {isAdmin ? (
                    <li>
                      <Link
                        to="/clusters"
                        search={{ enroll: true }}
                        className="underline-offset-4 hover:underline"
                      >
                        {m.overview_step_node()}
                      </Link>
                    </li>
                  ) : null}
                  <li>
                    <Link
                      to="/sites"
                      search={{ create: true }}
                      className="underline-offset-4 hover:underline"
                    >
                      {m.overview_step_site()}
                    </Link>
                  </li>
                  <li>{m.overview_step_dns()}</li>
                </ol>
              </CardContent>
            </Card>
          ) : null}
          <TrafficChart data={overview.data.traffic} />
          {isAdmin ? (
            <Card>
              <CardHeader>
                <CardTitle>{m.overview_revisions_title()}</CardTitle>
              </CardHeader>
              <CardContent>
                {overview.data.revisions.length === 0 ? (
                  <EmptyState title={m.overview_revisions_empty()} />
                ) : (
                  <ul className="divide-y text-sm">
                    {overview.data.revisions.map((r) => (
                      <li
                        key={`${r.clusterId}-${r.revision}`}
                        className="flex items-center gap-3 py-2"
                      >
                        <Badge variant="outline">#{r.revision}</Badge>
                        <span className="flex-1 truncate">{r.reason}</span>
                        <code className="hidden text-xs text-muted-foreground sm:inline">
                          {r.contentHash.slice(0, 12)}
                        </code>
                        <span className="text-xs text-muted-foreground">
                          {timeAgo(r.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
        </>
      )}
    </Page>
  );
}
