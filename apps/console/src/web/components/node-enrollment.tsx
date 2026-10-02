import {
  type ConsoleUrlWarning,
  type EnrollmentTokenResult,
  type EnrollmentTokenStatus,
  isPlainHttp,
  type NodeChannelCheck,
  urlHostScope,
} from "@edgeweir/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { SafetyNote } from "@/components/safety-note";
import { Dot, type StatusTone } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const urlWarningText = (warning: ConsoleUrlWarning) =>
  ({
    console_url_local: m.url_warning_console_url_local,
    console_url_private: m.url_warning_console_url_private,
    console_url_http: m.url_warning_console_url_http,
    node_api_url_local: m.url_warning_node_api_url_local,
    node_api_url_private: m.url_warning_node_api_url_private,
  })[warning]();

/** One line per URL that nodes on other networks may not reach. */
export function ConsoleUrlWarnings({ warnings }: { warnings: readonly ConsoleUrlWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <SafetyNote
          key={warning}
          className="flex items-center gap-1.5"
          data-testid="enroll-url-warning"
          data-warning={warning}
        >
          <Dot tone="warn" small />
          {urlWarningText(warning)}
        </SafetyNote>
      ))}
    </div>
  );
}

/**
 * A badge beside a URL that only this machine, or only its private network,
 * reaches, or a public one without TLS.
 */
export function UrlScopeBadge({ url, testId }: { url: string; testId: string }) {
  const scope = urlHostScope(url) ?? (isPlainHttp(url) ? "http" : null);
  if (!scope) return null;
  return (
    <Badge variant="outline" data-testid={testId} data-scope={scope}>
      <Dot tone="warn" small />
      {{ local: m.url_scope_local, private: m.url_scope_private, http: m.url_scope_http }[scope]()}
    </Badge>
  );
}

const CHECK_TONE: Record<NodeChannelCheck["result"], StatusTone> = {
  ok: "good",
  unreachable: "warn",
  mismatch: "warn",
};

const checkText = (result: NodeChannelCheck["result"]) =>
  ({
    ok: m.node_channel_check_ok,
    unreachable: m.node_channel_check_unreachable,
    mismatch: m.node_channel_check_mismatch,
  })[result]();

/**
 * The console's own TLS handshake with the node channel URL, as one line:
 * a pulsing dot while it runs, nothing when it cannot be asked. `line`
 * prefixes the result with what was checked (the add-node dialog).
 */
export function NodeChannelCheckStatus({ line = false }: { line?: boolean }) {
  const check = useQuery({
    ...orpc.settings.nodeChannelCheck.queryOptions(),
    meta: { background: true },
  });
  if (check.isPending) return <Dot tone="idle" pulse small />;
  if (!check.data) return null;
  const text = checkText(check.data.result);
  return (
    <span
      className="flex items-center gap-1.5 text-sm text-muted-foreground"
      title={line ? undefined : m.node_channel_check_title()}
      data-testid="node-channel-check"
      data-result={check.data.result}
    >
      <Dot tone={CHECK_TONE[check.data.result]} small />
      {line ? m.node_channel_check_line({ result: text }) : text}
    </span>
  );
}

type Step = { id: string; label: React.ReactNode; tone: StatusTone; pulse?: boolean };

/** Every step reached: polling can stop. */
function finished(status: EnrollmentTokenStatus | undefined, expired: boolean) {
  if (!status) return false;
  if (!status.usedAt) return expired;
  const node = status.node;
  return (
    !node ||
    (node.online &&
      node.applyState === "applied" &&
      node.dataPlaneHealthy &&
      node.schedulingAddresses.length > 0)
  );
}

/** True once `iso` has passed (re-renders at that moment). */
function usePassed(iso: string): boolean {
  const [passed, setPassed] = React.useState(() => Date.parse(iso) <= Date.now());
  React.useEffect(() => {
    const wait = Date.parse(iso) - Date.now();
    if (wait <= 0) {
      setPassed(true);
      return;
    }
    setPassed(false);
    const timer = setTimeout(() => setPassed(true), Math.min(wait, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [iso]);
  return passed;
}

/**
 * What became of a generated install command: waiting for the node, the
 * token expired, or the enrolled node coming online, applying its
 * configuration, serving and having an address DNS can use.
 */
export function EnrollProgress({ result }: { result: EnrollmentTokenResult }) {
  const expired = usePassed(result.expiresAt);
  const status = useQuery({
    ...orpc.clusters.getEnrollmentToken.queryOptions({ input: { id: result.tokenId } }),
    refetchInterval: (query) => (finished(query.state.data, expired) ? false : 3000),
    meta: { background: true },
  });
  const data = status.data;
  const node = data?.node ?? null;
  const used = !!data?.usedAt;
  // The first node changes the sidebar's primary action and the node lists.
  const queryClient = useQueryClient();
  React.useEffect(() => {
    if (used) void queryClient.invalidateQueries({ queryKey: orpc.overview.key() });
  }, [used, queryClient]);
  const reached = (done: boolean, previous: boolean): Pick<Step, "tone" | "pulse"> =>
    done ? { tone: "good" } : previous ? { tone: "idle", pulse: true } : { tone: "idle" };
  const online = !!node?.online;
  const applied = !!node && node.applyState === "applied" && node.appliedRevision > 0;
  const healthy = !!node?.dataPlaneHealthy;
  const addressed = !!node && node.schedulingAddresses.length > 0;
  const steps: Step[] = [
    used
      ? {
          id: "enrolled",
          tone: "good",
          label: (
            <>
              {m.enroll_step_enrolled()}
              {node ? (
                <Link
                  to="/clusters"
                  search={{ cluster: node.clusterId, node: node.id }}
                  className="font-medium underline-offset-4 hover:underline"
                  data-testid="enroll-node-link"
                >
                  {node.name}
                </Link>
              ) : null}
            </>
          ),
        }
      : expired
        ? { id: "expired", tone: "bad", label: m.enroll_step_expired() }
        : { id: "waiting", tone: "idle", pulse: true, label: m.enroll_step_waiting() },
    { id: "online", label: m.nodes_online(), ...reached(online, !!node) },
    { id: "applied", label: m.enroll_step_applied(), ...reached(applied, online) },
    { id: "healthy", label: m.enroll_step_healthy(), ...reached(healthy, applied) },
    node?.dnsIssue === "no_public_address" && online
      ? { id: "address", tone: "warn", label: m.node_dns_no_public_address() }
      : { id: "address", label: m.enroll_step_address(), ...reached(addressed, healthy) },
  ];
  return (
    <ol className="flex flex-col gap-2 rounded-xl border p-3 text-sm" data-testid="enroll-progress">
      {steps.map((step, index) => (
        <li
          key={step.id}
          className="flex items-center gap-2 animate-enter"
          style={{ animationDelay: `${index * 40}ms` }}
          data-testid="enroll-step"
          data-step={step.id}
          data-tone={step.tone}
        >
          <Dot tone={step.tone} pulse={step.pulse} />
          <span
            className={
              step.tone === "idle" && !step.pulse
                ? "text-muted-foreground"
                : "flex items-center gap-1.5"
            }
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
