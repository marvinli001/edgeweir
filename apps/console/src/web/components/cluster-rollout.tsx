import type {
  ClusterRollout,
  RolloutOutcome,
  RolloutPolicy,
  RolloutState,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const STATES: Record<RolloutState, { tone: StatusTone; label: () => string; pulse?: boolean }> = {
  idle: { tone: "idle", label: () => m.rollout_state_idle() },
  canary: { tone: "warn", label: () => m.rollout_state_canary(), pulse: true },
  awaiting_promotion: { tone: "warn", label: () => m.rollout_state_awaiting_promotion() },
  promoted: { tone: "good", label: () => m.rollout_state_promoted() },
  rolled_back: { tone: "bad", label: () => m.rollout_state_rolled_back() },
  direct: { tone: "warn", label: () => m.rollout_state_direct() },
};

const OUTCOMES: Record<Exclude<RolloutOutcome, "">, () => string> = {
  auto_promote: () => m.rollout_outcome_auto_promote(),
  manual_promote: () => m.rollout_outcome_manual_promote(),
  apply_failed: () => m.rollout_outcome_apply_failed(),
  apply_timeout: () => m.rollout_outcome_apply_timeout(),
  unhealthy: () => m.rollout_outcome_unhealthy(),
  error_ratio: () => m.rollout_outcome_error_ratio(),
  manual_abort: () => m.rollout_outcome_manual_abort(),
  no_canary: () => m.rollout_outcome_no_canary(),
  policy_disabled: () => m.rollout_outcome_policy_disabled(),
  manual_rollback: () => m.rollout_outcome_manual_rollback(),
  withdrawn: () => m.rollout_outcome_withdrawn(),
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

/** Admin cluster page: canary state, promote / abort, and the canary policy. */
export function ClusterRolloutCard({ clusterId }: { clusterId: string }) {
  const query = useQuery({
    ...orpc.clusters.rollout.queryOptions({ input: { id: clusterId } }),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  return (
    <Card className="animate-enter" data-testid="cluster-rollout">
      <CardHeader>
        <CardTitle>{m.rollout_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : query.isError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </CardContent>
      ) : (
        <>
          <RolloutStatus rollout={query.data} />
          <PolicyForm key={query.data.updatedAt} rollout={query.data} />
        </>
      )}
    </Card>
  );
}

function RolloutStatus({ rollout }: { rollout: ClusterRollout }) {
  const queryClient = useQueryClient();
  const promote = useMutation(orpc.clusters.promoteRollout.mutationOptions());
  const abort = useMutation(orpc.clusters.abortRollout.mutationOptions());
  const state = STATES[rollout.state];
  const running = rollout.state === "canary" || rollout.state === "awaiting_promotion";
  const refresh = () => queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
  return (
    <CardContent className="flex flex-col gap-3">
      <dl className="divide-y">
        <Row label={m.sites_col_status()}>
          <StatusDot
            tone={state.tone}
            pulse={state.pulse}
            data-testid="rollout-state"
            data-state={rollout.state}
          >
            {state.label()}
          </StatusDot>
          {rollout.outcome ? (
            <span className="text-xs text-muted-foreground" data-testid="rollout-outcome">
              {OUTCOMES[rollout.outcome]()}
            </span>
          ) : null}
        </Row>
        <Row label={m.rollout_stable()}>
          <span className="font-mono" data-testid="rollout-stable">
            {rollout.stableRevision === null ? "—" : `#${rollout.stableRevision}`}
          </span>
        </Row>
        {rollout.candidateRevision !== null ? (
          <Row label={m.rollout_candidate()}>
            <span className="font-mono" data-testid="rollout-candidate">
              #{rollout.candidateRevision}
            </span>
          </Row>
        ) : rollout.lastCandidateRevision !== null ? (
          <Row label={m.rollout_last_candidate()}>
            <span className="font-mono">#{rollout.lastCandidateRevision}</span>
            {rollout.finishedAt ? (
              <span
                className="text-xs text-muted-foreground"
                title={formatDateTime(rollout.finishedAt)}
              >
                {timeAgo(rollout.finishedAt)}
              </span>
            ) : null}
          </Row>
        ) : null}
        {rollout.windowEndsAt ? (
          <Row label={m.rollout_window_ends()}>
            <span title={formatDateTime(rollout.windowEndsAt)}>
              {formatDateTime(rollout.windowEndsAt)}
            </span>
          </Row>
        ) : null}
        {rollout.window ? (
          <>
            <Row label={m.rollout_traffic_canary()}>
              <span className="tabular-nums" data-testid="rollout-canary-traffic">
                {m.rollout_traffic_value({
                  requests: formatNumber(rollout.window.canaryRequests),
                  errors: formatNumber(rollout.window.canary5xx),
                })}
              </span>
            </Row>
            <Row label={m.rollout_traffic_baseline()}>
              <span className="tabular-nums">
                {m.rollout_traffic_value({
                  requests: formatNumber(rollout.window.baselineRequests),
                  errors: formatNumber(rollout.window.baseline5xx),
                })}
              </span>
            </Row>
          </>
        ) : null}
        <Row label={m.rollout_canary_nodes()}>
          {rollout.canaryNodes.length === 0 ? (
            <span className="text-muted-foreground">{m.rollout_no_canary_nodes()}</span>
          ) : (
            rollout.canaryNodes.map((node) => (
              <span
                key={node.id}
                className="inline-flex items-center gap-1.5"
                data-testid="rollout-canary-node"
              >
                <StatusDot tone={node.online ? "good" : "idle"}>{node.name}</StatusDot>
                <Badge variant="outline" className="font-mono">
                  #{node.appliedRevision}
                </Badge>
                {node.participating ? (
                  <Badge variant="secondary">{m.rollout_participating()}</Badge>
                ) : null}
              </span>
            ))
          )}
        </Row>
      </dl>
      {running && rollout.candidateRevision !== null ? (
        <div className="flex flex-wrap gap-2">
          <ConfirmDialog
            trigger={<Button data-testid="rollout-promote">{m.rollout_promote()}</Button>}
            title={m.rollout_promote_confirm({ revision: rollout.candidateRevision })}
            confirmLabel={m.rollout_promote()}
            onConfirm={async () => {
              try {
                await promote.mutateAsync({ id: rollout.clusterId });
                await refresh();
                toast.success(m.rollout_promoted_toast());
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
          <ConfirmDialog
            trigger={
              <Button variant="destructive" data-testid="rollout-abort">
                {m.rollout_abort()}
              </Button>
            }
            destructive
            title={m.rollout_abort_confirm({ revision: rollout.candidateRevision })}
            confirmLabel={m.rollout_abort()}
            onConfirm={async () => {
              try {
                await abort.mutateAsync({ id: rollout.clusterId });
                await refresh();
                toast.success(m.rollout_aborted_toast());
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
        </div>
      ) : null}
    </CardContent>
  );
}

type Draft = Record<Exclude<keyof RolloutPolicy, "enabled" | "autoPromote">, string> & {
  enabled: boolean;
  autoPromote: boolean;
};

function toDraft(policy: RolloutPolicy): Draft {
  return {
    enabled: policy.enabled,
    autoPromote: policy.autoPromote,
    windowSeconds: String(policy.windowSeconds / 60),
    errorRatioMultiplier: String(policy.errorRatioMultiplier),
    errorRatioFloor: String(Math.round(policy.errorRatioFloor * 1000) / 10),
    minRequests: String(policy.minRequests),
  };
}

function PolicyForm({ rollout }: { rollout: ClusterRollout }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.clusters.setRolloutPolicy.mutationOptions());
  const initial = React.useMemo(() => toDraft(rollout.policy), [rollout.policy]);
  const [draft, setDraft] = React.useState(initial);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await save.mutateAsync({
            id: rollout.clusterId,
            enabled: draft.enabled,
            autoPromote: draft.autoPromote,
            windowSeconds: Math.round(Number(draft.windowSeconds) * 60),
            errorRatioMultiplier: Number(draft.errorRatioMultiplier),
            errorRatioFloor: Number(draft.errorRatioFloor) / 100,
            minRequests: Number(draft.minRequests),
            expectedUpdatedAt: rollout.updatedAt,
          });
          await queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="grid gap-4 border-t pt-4 sm:grid-cols-3">
        <SwitchField
          id="rollout-enabled"
          label={m.rollout_enabled()}
          checked={draft.enabled}
          onCheckedChange={(enabled) => set({ enabled })}
          className="self-start sm:col-span-3"
          testId="rollout-enabled"
        />
        <NumberField
          id="rollout-window"
          label={m.rollout_window_minutes()}
          value={draft.windowSeconds}
          onChange={(windowSeconds) => set({ windowSeconds })}
          min={1}
          max={60}
          step={1}
          required
          testId="rollout-window"
        />
        <NumberField
          id="rollout-multiplier"
          label={m.rollout_error_multiplier()}
          value={draft.errorRatioMultiplier}
          onChange={(errorRatioMultiplier) => set({ errorRatioMultiplier })}
          min={1}
          max={100}
          step="any"
          required
        />
        <NumberField
          id="rollout-floor"
          label={m.rollout_error_floor()}
          value={draft.errorRatioFloor}
          onChange={(errorRatioFloor) => set({ errorRatioFloor })}
          min={0.1}
          max={100}
          step="any"
          required
        />
        <NumberField
          id="rollout-min-requests"
          label={m.rollout_min_requests()}
          value={draft.minRequests}
          onChange={(minRequests) => set({ minRequests })}
          min={1}
          max={1_000_000}
          step={1}
          required
        />
        <SwitchField
          id="rollout-auto-promote"
          label={m.rollout_auto_promote()}
          checked={draft.autoPromote}
          onCheckedChange={(autoPromote) => set({ autoPromote })}
        />
      </CardContent>
      <SaveBar dirty={dirty} pending={save.isPending} error={error} testId="rollout-policy-save" />
    </form>
  );
}
