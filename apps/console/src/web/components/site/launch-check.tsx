import type { DnsPointing, Site, SiteLaunch } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import type { LinkProps } from "@tanstack/react-router";
import { ResourceRow } from "@/components/resource-list";
import { canaryLabel } from "@/components/site-status";
import { ErrorState, LoadingState } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { certificateErrorText } from "@/lib/certificate-errors";
import { formatClockTime, m } from "@/lib/i18n";
import { notPointing } from "@/lib/launch";
import { orpc } from "@/lib/orpc";

/**
 * The site's launch check (sites.launch). DNS lookups take seconds, so it is
 * polled on its own every 30 seconds rather than with the site.
 */
export const useSiteLaunch = (siteId: string) =>
  useQuery(
    orpc.sites.launch.queryOptions({
      input: { id: siteId },
      refetchInterval: 30_000,
      meta: { background: true },
    }),
  );

const POINTING_TONE: Record<DnsPointing, StatusTone> = {
  ok: "good",
  elsewhere: "bad",
  unresolved: "warn",
  unknown: "idle",
};

export const pointingLabel = (pointing: DnsPointing) =>
  ({
    ok: m.dns_pointing_ok,
    elsewhere: m.dns_pointing_elsewhere,
    unresolved: m.dns_pointing_unresolved,
    unknown: m.dns_pointing_unknown,
  })[pointing]();

/** A domain's pointing state: dot and label. */
export function PointingStatus({ pointing }: { pointing: DnsPointing }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
      data-testid="dns-pointing"
      data-pointing={pointing}
    >
      <Dot tone={POINTING_TONE[pointing]} small />
      {pointingLabel(pointing)}
    </span>
  );
}

function dnsItem(launch: SiteLaunch) {
  const total = launch.domains.length;
  const ok = launch.domains.filter((d) => d.pointing === "ok").length;
  const failing = notPointing(launch).map((d) => d.name);
  const tone: StatusTone = ok === total ? "good" : failing.length ? "warn" : "idle";
  return { tone, label: m.site_launch_dns({ ok, total }), detail: failing.join(", ") };
}

function certificateItem({ certificate }: SiteLaunch) {
  const uncovered = certificate.uncovered.join(", ");
  switch (certificate.state) {
    case "none":
      return { tone: "idle" as const, label: m.site_launch_cert_none(), detail: "" };
    case "covered":
      return { tone: "good" as const, label: m.site_launch_cert_covered(), detail: "" };
    case "uncovered":
      return { tone: "warn" as const, label: m.site_launch_cert_uncovered(), detail: uncovered };
    case "issuing":
      return { tone: "warn" as const, label: m.site_launch_cert_issuing(), detail: "" };
    case "failed":
      return {
        tone: "bad" as const,
        label: m.site_launch_cert_failed(),
        detail: certificateErrorText(certificate.error),
      };
    case "expired":
      return { tone: "bad" as const, label: m.site_launch_cert_expired(), detail: "" };
  }
}

function nodesItem(site: Site) {
  const { delivery } = site;
  const { currentNodes: current, totalNodes: total } = delivery;
  if (!site.enabled || delivery.state === "disabled")
    return { tone: "idle" as const, label: m.site_state_disabled(), detail: "" };
  if (total === 0) return { tone: "bad" as const, label: m.site_delivery_no_nodes(), detail: "" };
  const label = m.site_launch_nodes({ current, total });
  if (delivery.state === "live") return { tone: "good" as const, label, detail: "" };
  const canary = canaryLabel(delivery) && delivery.canary;
  return {
    tone: "warn" as const,
    label,
    detail: !canary
      ? ""
      : canary.autoPromote
        ? m.site_launch_canary({ time: formatClockTime(canary.endsAt) })
        : m.site_launch_canary_waiting(),
  };
}

function LaunchRow({
  item,
  link,
  testId,
  pulse,
}: {
  item: { tone: StatusTone; label: string; detail: string };
  link: LinkProps;
  testId: string;
  pulse?: boolean;
}) {
  return (
    <ResourceRow
      icon={<Dot tone={item.tone} pulse={pulse && item.tone === "warn"} />}
      link={link}
      testId={testId}
    >
      <span className="shrink-0">{item.label}</span>
      {item.detail ? (
        <span
          className="ml-auto min-w-0 truncate text-xs text-muted-foreground"
          title={item.detail}
        >
          {item.detail}
        </span>
      ) : null}
    </ResourceRow>
  );
}

/** "Launch check" on the site overview: DNS, certificate and nodes, each linking to its fix. */
export function LaunchCheck({ site }: { site: Site }) {
  const launch = useSiteLaunch(site.id);
  return (
    <Card data-testid="launch-check">
      <CardHeader>
        <CardTitle>{m.site_launch_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        {launch.isPending ? (
          <LoadingState className="min-h-33" />
        ) : launch.isLoadingError ? (
          <ErrorState error={launch.error} onRetry={() => void launch.refetch()} />
        ) : (
          <ul className="flex flex-col animate-enter [&>li:last-child>a]:border-b-0">
            <LaunchRow
              item={dnsItem(launch.data)}
              link={{ to: "/sites/$id", params: { id: site.id }, search: { tab: "domains" } }}
              testId="launch-dns"
            />
            <LaunchRow
              item={certificateItem(launch.data)}
              link={{ to: "/sites/$id", params: { id: site.id }, search: { tab: "https" } }}
              testId="launch-certificate"
            />
            <LaunchRow
              item={nodesItem(site)}
              link={{ to: "/clusters", search: { cluster: site.clusterId } }}
              testId="launch-nodes"
              pulse
            />
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
