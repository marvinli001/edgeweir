import type { L4App } from "@edgeweir/contract";
import { Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { CopyButton } from "@/components/copy-button";
import { DeleteL4AppDialog, L4EnabledSwitch } from "@/components/l4/app-actions";
import { L4AppDialog } from "@/components/l4/app-dialog";
import { L4AppStats } from "@/components/l4/app-stats";
import { DnsTarget, L4NodesWarning, ProtocolBadge } from "@/components/l4/common";
import { Page } from "@/components/page";
import { QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { L4_STATS_RANGES, type L4StatsRange, originLabel, proxyVersionLabel } from "@/lib/l4";
import { orpc } from "@/lib/orpc";

const DEFAULT_RANGE: L4StatsRange = "24h";

export const Route = createFileRoute("/_app/l4/$id")({
  validateSearch: z.object({
    tab: z.enum(["overview", "stats"]).optional(),
    range: z.enum(L4_STATS_RANGES).optional(),
  }),
  component: L4AppPage,
});

function L4AppPage() {
  const { id } = Route.useParams();
  const href = useLocation({ select: (location) => location.href });
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const app = useQuery(orpc.l4Apps.get.queryOptions({ input: { id } }));
  const tab = search.tab ?? "overview";
  return (
    <Page
      title={app.data?.name ?? m.l4_title()}
      actions={
        <Link to="/l4" className="text-sm text-muted-foreground hover:text-foreground">
          {m.l4_back()}
        </Link>
      }
    >
      <QueryView query={app} notFound={<NotFoundPage path={href} surface="inline" />}>
        {(data) => (
          <Tabs
            key={data.id}
            value={tab}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({ ...prev, tab: value === "stats" ? "stats" : undefined }),
                replace: true,
              })
            }
          >
            <TabsList>
              <TabsTrigger value="overview" data-testid="l4-tab-overview">
                {m.site_tab_overview()}
              </TabsTrigger>
              <TabsTrigger value="stats" data-testid="l4-tab-stats">
                {m.analytics_title()}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="animate-enter">
              <Overview app={data} />
            </TabsContent>
            <TabsContent value="stats" className="animate-enter">
              <L4AppStats
                appId={data.id}
                range={search.range ?? DEFAULT_RANGE}
                onRangeChange={(range) =>
                  navigate({
                    search: (prev) => ({
                      ...prev,
                      range: range === DEFAULT_RANGE ? undefined : range,
                    }),
                    replace: true,
                  })
                }
              />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}

function InfoRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

const limitText = (value: number) => (value === 0 ? m.l4_unlimited() : formatNumber(value));

function Overview({ app }: { app: L4App }) {
  const navigate = Route.useNavigate();
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const pools = useQuery(
    orpc.clusters.portPools.queryOptions({ input: { clusterId: app.clusterId } }),
  );
  const lists = useQuery(orpc.ipLists.list.queryOptions());
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const listNames = (ids: string[]) =>
    ids.map((listId) => lists.data?.find((l) => l.id === listId)?.name ?? listId.slice(0, 8));
  const proxy: string[] = [];
  if (app.acceptProxyProtocol) proxy.push(m.l4_proxy_accepts());
  if (app.proxyProtocolVersion > 0)
    proxy.push(m.l4_proxy_sends({ version: proxyVersionLabel(app.proxyProtocolVersion) }));

  return (
    <div className="flex flex-col gap-4">
      {pools.data ? (
        <L4NodesWarning cluster={app.clusterName} nodes={pools.data.nodesWithoutL4} />
      ) : null}
      <Card data-testid="l4-app-overview">
        <CardHeader className="flex flex-row flex-wrap items-center gap-2">
          <CardTitle className="flex-1">{m.site_tab_overview()}</CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setEditOpen(true)}
            data-testid="l4-app-edit-open"
          >
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            {m.common_edit()}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            data-testid="l4-app-delete-open"
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {m.common_delete()}
          </Button>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <InfoRow label={m.sites_col_status()} testId="l4-app-state">
              <L4EnabledSwitch app={app} />
              <span>{app.enabled ? m.l4_state_enabled() : m.l4_state_disabled()}</span>
            </InfoRow>
            <InfoRow label={m.l4_port()} testId="l4-app-listen">
              <ProtocolBadge protocol={app.protocol} />
              <span className="font-mono tabular-nums">{app.port}</span>
            </InfoRow>
            <InfoRow label={m.sites_col_cluster()}>
              <Badge
                variant="secondary"
                render={<Link to="/clusters" search={{ cluster: app.clusterId, tab: "ports" }} />}
              >
                {app.clusterName}
              </Badge>
            </InfoRow>
            <InfoRow label={m.dns_cname_target()}>
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <DnsTarget target={app.dnsTarget} testId="l4-app-dns" />
                {app.dnsLines.map((line) => (
                  <div
                    key={line.name}
                    className="flex min-w-0 items-center gap-2"
                    data-testid="l4-app-dns-line"
                  >
                    <span className="shrink-0 text-muted-foreground">{line.name}</span>
                    <code className="min-w-0 truncate font-mono text-xs" title={line.target}>
                      {line.target}
                    </code>
                    <CopyButton iconOnly value={line.target} />
                  </div>
                ))}
              </div>
            </InfoRow>
            <InfoRow label={m.sites_col_origins()}>
              <ul className="flex min-w-0 flex-col gap-1">
                {app.origins.map((origin) => (
                  <li
                    key={origin.id}
                    className="flex min-w-0 flex-wrap items-center gap-2"
                    data-testid="l4-app-origin"
                  >
                    <span className="font-mono text-xs break-all">{originLabel(origin)}</span>
                    <Badge variant="outline">{m.l4_origin_weight({ weight: origin.weight })}</Badge>
                    {origin.backup ? (
                      <Badge variant="secondary">{m.site_origin_backup()}</Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </InfoRow>
            <InfoRow label={m.l4_proxy()} testId="l4-app-proxy">
              {proxy.length ? proxy.join(" · ") : m.l4_proxy_off()}
            </InfoRow>
            <InfoRow label={m.l4_timeouts()}>
              {m.l4_timeouts_value({
                connect: formatNumber(app.connectTimeoutMs / 1000),
                idle: formatNumber(app.idleTimeoutSeconds),
              })}
            </InfoRow>
            <InfoRow label={m.site_pool_health()}>
              {m.l4_health_value({
                fails: formatNumber(app.maxFails),
                seconds: formatNumber(app.failTimeoutSeconds),
              })}
            </InfoRow>
            <InfoRow label={m.ip_lists_title()} testId="l4-app-lists">
              <ListNames label={m.l4_allow_lists()} names={listNames(app.allowListIds)} />
              <ListNames label={m.l4_block_lists()} names={listNames(app.blockListIds)} />
            </InfoRow>
            <InfoRow label={m.l4_limits()}>
              {m.l4_limits_value({
                connections: limitText(app.maxConnections),
                rate: limitText(app.newConnectionsPerSecond),
              })}
            </InfoRow>
            <InfoRow label={m.site_updated_at()}>
              <span title={formatDateTime(app.updatedAt)}>{timeAgo(app.updatedAt)}</span>
            </InfoRow>
          </dl>
        </CardContent>
      </Card>
      <L4AppDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        app={app}
        clusters={clusters.data ?? []}
      />
      <DeleteL4AppDialog
        app={app}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={() => void navigate({ to: "/l4" })}
      />
    </div>
  );
}

function ListNames({ label, names }: { label: string; names: string[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      {names.length === 0 ? (
        <span>{m.l4_lists_none()}</span>
      ) : (
        names.map((name) => (
          <Badge key={name} variant="outline" className="font-mono">
            {name}
          </Badge>
        ))
      )}
    </span>
  );
}
