import type { L4App } from "@edgeweir/contract";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { CopyButton } from "@/components/copy-button";
import { L4OverviewTraffic } from "@/components/l4/app-overview-traffic";
import { DnsTarget, L4NodesWarning, ProtocolBadge } from "@/components/l4/common";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { WorkspaceOverview } from "@/components/layout/workspace-overview";
import { CnamePrefixActions } from "@/components/site/cname-prefix";
import { StatusDot } from "@/components/status-dot";
import { TimeAgo } from "@/components/time-ago";
import { formatNumber, m } from "@/lib/i18n";
import { type L4StatsRange, listChips, originLabel, portsLabel, proxyVersionLabel } from "@/lib/l4";
import { orpc } from "@/lib/orpc";

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

export function L4AppOverview({
  app,
  range,
  setRange,
  statsHref,
}: {
  app: L4App;
  range: L4StatsRange;
  setRange: (range: L4StatsRange) => void;
  statsHref: string;
}) {
  const pools = useQuery(
    orpc.clusters.portPools.queryOptions({ input: { clusterId: app.clusterId } }),
  );
  const lists = useQuery(orpc.ipLists.list.queryOptions());
  const proxy: string[] = [];
  if (app.acceptProxyProtocol) proxy.push(m.l4_proxy_accepts());
  if (app.proxyProtocolVersion > 0)
    proxy.push(m.l4_proxy_sends({ version: proxyVersionLabel(app.proxyProtocolVersion) }));
  return (
    <>
      {pools.data ? (
        <L4NodesWarning cluster={app.clusterName} nodes={pools.data.nodesWithoutL4} />
      ) : null}
      <WorkspaceOverview
        status={
          <Panel data-testid="l4-app-overview">
            <PanelHeader>
              <PanelTitle>{m.scope_l4_status()}</PanelTitle>
            </PanelHeader>
            <PanelContent>
              <dl className="grid gap-4 text-[13px] [&>div]:flex [&>div]:flex-wrap [&>div]:items-center [&>div]:justify-between [&>div]:gap-2 [&_dt]:text-muted-foreground">
                <div>
                  <dt>{m.sites_col_status()}</dt>
                  <dd data-testid="l4-app-state">
                    <StatusDot tone={app.enabled ? "good" : "idle"}>
                      {app.enabled ? m.l4_state_enabled() : m.l4_state_disabled()}
                    </StatusDot>
                  </dd>
                </div>
                <div>
                  <dt>{m.l4_port()}</dt>
                  <dd className="flex items-center gap-2 font-mono" data-testid="l4-app-listen">
                    <ProtocolBadge protocol={app.protocol} />
                    {portsLabel(app)}
                  </dd>
                </div>
                <div>
                  <dt>{m.l4_origin_port_mode()}</dt>
                  <dd>
                    {app.originPortMode === "same"
                      ? m.l4_origin_port_same()
                      : m.l4_origin_port_fixed()}
                  </dd>
                </div>
                <div>
                  <dt>{m.sites_col_cluster()}</dt>
                  <dd>
                    <Link
                      to="/clusters"
                      search={{ cluster: app.clusterId, tab: "ports" }}
                      className="flex items-center gap-1 rounded-sm text-primary-ink focus-ring hover:underline"
                    >
                      {app.clusterName}
                      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
                    </Link>
                  </dd>
                </div>
              </dl>
            </PanelContent>
          </Panel>
        }
        main={
          <>
            <L4OverviewTraffic
              appId={app.id}
              range={range}
              setRange={setRange}
              statsHref={statsHref}
            />
            <Panel>
              <PanelHeader>
                <PanelTitle>{m.scope_l4_settings()}</PanelTitle>
              </PanelHeader>
              <PanelContent>
                <dl className="divide-y divide-edge">
                  {app.certificateName ? (
                    <InfoRow label={m.l4_tls_certificate()} testId="l4-app-tls">
                      {app.certificateName}
                      <Badge size="sm" tone="neutral">{`TLS ${app.tlsMinimumVersion}+`}</Badge>
                    </InfoRow>
                  ) : null}
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
                    <ListNames
                      label={m.l4_allow_lists()}
                      chips={listChips(app.allowListIds, lists.data)}
                    />
                    <ListNames
                      label={m.l4_block_lists()}
                      chips={listChips(app.blockListIds, lists.data)}
                    />
                  </InfoRow>
                  <InfoRow label={m.l4_limits()}>
                    {m.l4_limits_value({
                      connections: limitText(app.maxConnections),
                      rate: limitText(app.newConnectionsPerSecond),
                    })}
                  </InfoRow>
                  <InfoRow label={m.site_updated_at()}>
                    <TimeAgo at={app.updatedAt} />
                  </InfoRow>
                </dl>
              </PanelContent>
            </Panel>
          </>
        }
        aside={
          <>
            <Panel>
              <PanelHeader>
                <PanelTitle>{m.scope_connection_method()}</PanelTitle>
              </PanelHeader>
              <PanelContent>
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <DnsTarget target={app.dnsTarget} testId="l4-app-dns" well />
                  {app.dnsLines.map((line) => (
                    <div
                      key={line.name}
                      className="flex min-w-0 items-center gap-2"
                      data-testid="l4-app-dns-line"
                    >
                      <span className="w-10 shrink-0 truncate text-xs text-muted-foreground">
                        {line.name}
                      </span>
                      <span className="flex w-fit max-w-full min-w-0 items-center gap-1.5 rounded-lg bg-well py-0.5 pr-0.5 pl-2">
                        <code className="min-w-0 font-mono text-xs break-all">{line.target}</code>
                        <CopyButton iconOnly value={line.target} />
                      </span>
                    </div>
                  ))}
                  {app.dnsTarget ? <L4CnamePrefix app={app} /> : null}
                </div>
              </PanelContent>
            </Panel>
            <Panel>
              <PanelHeader>
                <PanelTitle>{m.sites_col_origins()}</PanelTitle>
              </PanelHeader>
              <PanelContent>
                <ul className="flex min-w-0 flex-col gap-1">
                  {app.origins.map((origin) => (
                    <li
                      key={origin.id}
                      className="flex min-w-0 flex-wrap items-center gap-2"
                      data-testid="l4-app-origin"
                    >
                      <span className="font-mono text-xs break-all">{originLabel(origin)}</span>
                      <CopyButton iconOnly value={originLabel(origin)} />
                      <Badge size="sm" tone="neutral">
                        {m.l4_origin_weight({ weight: origin.weight })}
                      </Badge>
                      {origin.backup ? (
                        <Badge size="sm" tone="neutral">
                          {m.site_origin_backup()}
                        </Badge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </PanelContent>
            </Panel>
          </>
        }
      />
    </>
  );
}

function ListNames({ label, chips }: { label: string; chips: { id: string; name: string }[] }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      {chips.length === 0 ? (
        <span>{m.l4_lists_none()}</span>
      ) : (
        chips.map((chip) => (
          <Badge size="sm" key={chip.id} tone="neutral" className="font-mono">
            {chip.name}
          </Badge>
        ))
      )}
    </span>
  );
}

/** Regenerates or sets the application's CNAME prefix (its old name resolves for 24 hours). */
function L4CnamePrefix({ app }: { app: L4App }) {
  const setPrefix = useMutation({
    ...orpc.l4Apps.setCnamePrefix.mutationOptions(),
    meta: { invalidates: [orpc.l4Apps.key()] },
  });
  return (
    <CnamePrefixActions
      prefix={app.cnamePrefix}
      retired={app.dnsRetired}
      testId="l4-cname-prefix"
      change={(prefix) => setPrefix.mutateAsync({ id: app.id, prefix })}
    />
  );
}
