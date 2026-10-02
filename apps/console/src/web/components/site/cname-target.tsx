import type { SiteLaunch } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { CopyButton } from "@/components/copy-button";
import { PointingStatus, useSiteLaunch } from "@/components/site/launch-check";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { coversDomain, curlCheck } from "@/lib/launch";
import { orpc } from "@/lib/orpc";

/**
 * How the site's domains reach the cluster: with platform DNS the CNAME
 * target, otherwise the edge addresses for A/AAAA records and a request
 * per domain that bypasses DNS; with each domain's pointing state.
 */
export function DnsSetupCard({ siteId }: { siteId: string }) {
  const target = useQuery(
    orpc.dns.siteTarget.queryOptions({
      input: { siteId },
      refetchInterval: 15000,
      meta: { background: true },
    }),
  );
  // The lookups take seconds: the CNAME target does not wait for them.
  const launch = useSiteLaunch(siteId);
  if (target.isPending) return <LoadingState className="min-h-24" />;
  if (target.isLoadingError)
    return <ErrorState error={target.error} onRetry={() => void target.refetch()} />;
  const cname = target.data.target;
  return (
    <Card data-testid={cname ? "cname-target" : "edge-addresses"}>
      <CardHeader>
        <CardTitle>{cname ? m.dns_cname_target() : m.dns_edge_addresses()}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {cname ? (
          <>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 break-all text-sm" data-testid="cname-target-value">
                {cname}
              </code>
              <CopyButton iconOnly value={cname} />
              <Badge variant="outline" data-testid="cname-target-status">
                {target.data.mode === "manual"
                  ? m.dns_mode_manual()
                  : target.data.published
                    ? target.data.healthy
                      ? m.dns_applied()
                      : m.dns_no_healthy_nodes()
                    : m.dns_pending()}
              </Badge>
            </div>
            {target.data.lines.map((line) => (
              <div key={line.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{line.name}</span>
                <code className="min-w-0 flex-1 break-all">{line.target}</code>
                <CopyButton iconOnly value={line.target} />
              </div>
            ))}
          </>
        ) : null}
        {launch.isPending ? (
          <LoadingState className="min-h-20" />
        ) : launch.isLoadingError ? (
          <ErrorState error={launch.error} onRetry={() => void launch.refetch()} />
        ) : (
          <>
            {cname ? null : <EdgeAddresses addresses={launch.data.addresses} />}
            <DomainPointing launch={launch.data} checks={!cname} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function EdgeAddresses({ addresses }: { addresses: string[] }) {
  if (!addresses.length)
    return <p className="text-sm text-muted-foreground">{m.site_delivery_no_nodes()}</p>;
  return (
    <ul className="grid gap-1.5" data-testid="edge-address-list">
      {addresses.map((address) => (
        <li key={address} className="flex items-center gap-2">
          <Badge variant="secondary" className="w-12 justify-center font-mono">
            {address.includes(":") ? "AAAA" : "A"}
          </Badge>
          <code className="min-w-0 flex-1 break-all text-sm" data-testid="edge-address">
            {address}
          </code>
          <CopyButton iconOnly value={address} />
        </li>
      ))}
    </ul>
  );
}

/** Each domain's pointing state; `checks` adds a request that bypasses DNS. */
function DomainPointing({ launch, checks }: { launch: SiteLaunch; checks: boolean }) {
  const address = launch.addresses[0];
  return (
    <ul className="divide-y rounded-2xl border" data-testid="domain-pointing">
      {launch.domains.map((domain, index) => {
        const command =
          checks && address
            ? curlCheck(domain.probe, address, coversDomain(launch.certificate, domain.name))
            : null;
        return (
          <li
            key={domain.name}
            className="flex flex-col gap-1.5 px-3 py-2 animate-enter"
            style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
            data-testid="domain-pointing-row"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 font-mono text-sm break-all">{domain.name}</span>
              <PointingStatus pointing={domain.pointing} />
            </div>
            {command ? (
              <div className="flex items-center gap-2">
                <code
                  className="min-w-0 flex-1 break-all text-xs text-muted-foreground"
                  data-testid="domain-check-command"
                >
                  {command}
                </code>
                <CopyButton iconOnly value={command} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
