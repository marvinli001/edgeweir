import type { IpCheckResult, IpListDto } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import {
  BAN_REASON_LABELS,
  BAN_SCOPE_LABELS,
  type SiteChoice,
  SiteSelect,
} from "@/components/ban-dialog";
import { timeLeft } from "@/components/bans";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { QueryView } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { DialogProps } from "@/hooks/use-dialog-state";
import { formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const KIND_LABELS: Record<IpListDto["kind"], () => string> = {
  block: () => m.rules_block(),
  allow: () => m.rules_allow(),
  collection: () => m.ip_lists_collection(),
};

/** What an IP list does on its own: block or allow on every site, or a set rules refer to. */
export function IpListKind({ kind }: { kind: IpListDto["kind"] }) {
  return (
    <Badge
      variant={kind === "block" ? "destructive" : kind === "allow" ? "secondary" : "outline"}
      data-testid="ip-list-kind"
    >
      {KIND_LABELS[kind]()}
    </Badge>
  );
}

type Outcome = NonNullable<IpCheckResult["verdict"]>["outcome"];

const OUTCOMES: Record<Outcome, { label: () => string; tone: StatusTone }> = {
  platform_banned: { label: () => m.ip_check_outcome_platform_banned(), tone: "bad" },
  site_banned: { label: () => m.ip_check_outcome_site_banned(), tone: "bad" },
  platform_blocked: { label: () => m.ip_check_outcome_platform_blocked(), tone: "bad" },
  site_blocked: { label: () => m.ip_check_outcome_site_blocked(), tone: "bad" },
  allowed: { label: () => m.ip_check_outcome_allowed(), tone: "good" },
  none: { label: () => m.ip_check_outcome_none(), tone: "idle" },
};

const CLIENT_IP_MODES: Record<IpCheckResult["clusters"][number]["clientIp"], () => string> = {
  direct: () => m.client_ip_mode_direct(),
  proxy_protocol: () => m.client_ip_mode_proxy_protocol(),
  header: () => m.client_ip_mode_header(),
};

/** A titled well of rows; "None" in it when there are none. */
function Section({
  title,
  count,
  testId,
  children,
}: {
  title: string;
  count?: number;
  testId: string;
  children: React.ReactNode[];
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {title}
        {count === undefined ? null : (
          <span className="text-xs font-normal tabular-nums text-muted-foreground">
            {formatNumber(count)}
          </span>
        )}
      </h3>
      <ul className="min-w-0 divide-y divide-border/70 rounded-2xl sunk-well">
        {children.length ? (
          children
        ) : (
          <li className="px-3 py-2.5 text-sm text-muted-foreground">{m.ip_check_none()}</li>
        )}
      </ul>
    </section>
  );
}

/**
 * What the console knows about an address: for a site, how the edge's list and ban steps decide;
 * the IP lists that contain it (with the entries), the active bans that cover it and how each
 * cluster's client address setting sees it. GeoIP is not looked up.
 */
export function IpCheckResultView({ result }: { result: IpCheckResult }) {
  const verdict = result.verdict;
  const outcome = verdict ? OUTCOMES[verdict.outcome] : null;
  return (
    <div className="flex min-w-0 flex-col gap-4 animate-in fade-in" data-testid="ip-check-result">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <span className="font-mono text-sm font-medium break-all" data-testid="ip-check-address">
          {result.ip}
        </span>
        {verdict && outcome ? (
          <>
            <StatusDot tone={outcome.tone} data-testid="ip-check-verdict">
              {outcome.label()}
            </StatusDot>
            {verdict.platformAllowed ? (
              <Badge variant="secondary">{m.ip_check_platform_allowed()}</Badge>
            ) : null}
            {verdict.siteAllowed ? (
              <Badge variant="secondary">{m.access_site_allow_lists()}</Badge>
            ) : null}
          </>
        ) : null}
      </div>
      <Section title={m.ip_check_lists()} count={result.lists.length} testId="ip-check-lists">
        {result.lists.map((list, index) => (
          <li
            key={list.id}
            className="flex min-w-0 flex-col gap-1 px-3 py-2.5 animate-enter"
            style={enterDelay(index)}
            data-testid="ip-check-list"
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 truncate font-mono text-sm">{`$${list.name}`}</span>
              <IpListKind kind={list.kind} />
              {list.siteRole ? (
                <Badge
                  variant={list.siteRole === "block" ? "destructive" : "default"}
                  data-testid="ip-check-site-role"
                >
                  {list.siteRole === "block"
                    ? m.ip_check_site_role_block()
                    : m.ip_check_site_role_allow()}
                </Badge>
              ) : null}
            </div>
            <span className="font-mono text-xs break-all text-muted-foreground">
              {list.entries.join(", ")}
            </span>
          </li>
        ))}
      </Section>
      <Section title={m.ip_check_bans()} count={result.bans.length} testId="ip-check-bans">
        {result.bans.map((ban, index) => (
          <li
            key={ban.id}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-sm animate-enter"
            style={enterDelay(index)}
            data-testid="ip-check-ban"
          >
            <span className="font-mono break-all">{ban.cidr}</span>
            <Badge variant={ban.scope === "platform" ? "destructive" : "outline"}>
              {BAN_SCOPE_LABELS[ban.scope]()}
            </Badge>
            {ban.siteName ? <span className="min-w-0 truncate">{ban.siteName}</span> : null}
            <span className="text-muted-foreground">
              {`${BAN_REASON_LABELS[ban.reason]()} · ${timeLeft(ban.expiresAt)}`}
            </span>
          </li>
        ))}
      </Section>
      <Section title={m.client_ip_title()} testId="ip-check-clusters">
        {result.clusters.map((cluster, index) => (
          <li
            key={cluster.id}
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2.5 text-sm animate-enter"
            style={enterDelay(index)}
            data-testid="ip-check-cluster"
          >
            <span className="min-w-0 truncate font-medium">{cluster.name}</span>
            <span className="text-muted-foreground">{CLIENT_IP_MODES[cluster.clientIp]()}</span>
            {cluster.trustedProxy ? (
              <Badge variant="default">{m.ip_check_trusted_proxy()}</Badge>
            ) : null}
            {cluster.nodeAddress ? (
              <Badge variant="secondary">{m.ip_check_node_address()}</Badge>
            ) : null}
          </li>
        ))}
      </Section>
      <SafetyNote data-testid="ip-check-geoip">{m.ip_check_geoip_note()}</SafetyNote>
    </div>
  );
}

/**
 * An address (and a site, fixed by `siteId` or picked when `pickSite`) to check, then the result.
 * The result is a query, so it follows changes of the lists and the site's settings.
 */
export function IpCheckPanel({ siteId, pickSite }: { siteId?: string; pickSite?: boolean }) {
  const [ip, setIp] = React.useState("");
  const [site, setSite] = React.useState<SiteChoice | null>(null);
  const [checked, setChecked] = React.useState<{ ip: string; siteId?: string } | null>(null);
  const input = checked ?? { ip: "" };
  const result = useQuery({
    ...orpc.ipCheck.check.queryOptions({ input }),
    enabled: checked !== null,
    retry: false,
  });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <form
        className="flex min-w-0 flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const forSite = siteId ?? site?.id;
          const next = forSite ? { ip: ip.trim(), siteId: forSite } : { ip: ip.trim() };
          if (JSON.stringify(next) === JSON.stringify(checked)) void result.refetch();
          else setChecked(next);
        }}
      >
        {pickSite ? (
          <SiteSelect
            id="ip-check-site"
            label={m.ip_check_site()}
            value={site}
            onChange={setSite}
            noneLabel={m.ip_check_any_site()}
            testId="ip-check-site"
          />
        ) : null}
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <Field className="min-w-0 flex-1 basis-56 sm:max-w-md">
            <FieldLabel htmlFor="ip-check-ip">{m.ip_check_ip()}</FieldLabel>
            <Input
              id="ip-check-ip"
              value={ip}
              required
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              placeholder="203.0.113.7"
              onChange={(event) => setIp(event.target.value)}
              className="font-mono"
              data-testid="ip-check-input"
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={!ip.trim() || result.isFetching}
            data-testid="ip-check-submit"
          >
            {result.isFetching ? <Spinner /> : null}
            {m.ip_check_submit()}
          </Button>
        </div>
      </form>
      {checked ? (
        <QueryView
          query={result}
          loadingClassName="min-h-32"
          error={(error) => (
            <FieldError className="animate-in fade-in" data-testid="ip-check-error">
              {errorMessage(error)}
            </FieldError>
          )}
        >
          {(data) => <IpCheckResultView result={data} />}
        </QueryView>
      ) : null}
    </div>
  );
}

/** The site's IP check (access control tab). */
export function IpCheckCard({ siteId, index }: { siteId: string; index: number }) {
  return (
    <Card className="animate-enter" style={enterDelay(index + 1)} data-testid="ip-check-card">
      <CardHeader>
        <CardTitle>{m.ip_check_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <IpCheckPanel siteId={siteId} />
      </CardContent>
    </Card>
  );
}

/** The IP check of the IP lists page: any address, for one site or none. */
export function IpCheckDialog({ open, onOpenChange }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="ip-check-dialog"
      >
        <DialogHeader>
          <DialogTitle>{m.ip_check_title()}</DialogTitle>
        </DialogHeader>
        <IpCheckPanel pickSite />
      </DialogContent>
    </Dialog>
  );
}
