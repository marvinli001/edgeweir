import {
  compareReleaseVersions,
  type Node,
  type NodeGroup,
  releaseVersion,
  type UpgradeJob,
} from "@edgeweir/contract";
import { Add01Icon, ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Progress } from "@/components/arc/progress/progress";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/layout/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { taskErrorText } from "@/lib/node-errors";
import { upgradeBlocker } from "@/lib/node-upgrades";
import { orpc } from "@/lib/orpc";

type JobState = UpgradeJob["state"] | UpgradeJob["deliveries"][number]["state"];

const stateLabel = (state: JobState) =>
  ({
    canary: m.upgrade_canary,
    rollout: m.upgrade_rollout,
    succeeded: m.upgrade_succeeded,
    failed: m.upgrade_failed,
    cancelled: m.upgrade_cancelled,
    held: m.upgrade_held,
    pending: m.upgrade_pending,
    running: m.upgrade_running,
  })[state]?.() ?? state;

/** A state's light: running work pulses until it ends, results hold still. */
const stateTone = (state: JobState): { tone: StatusTone; pulse?: boolean } =>
  state === "succeeded"
    ? { tone: "good" }
    : state === "failed"
      ? { tone: "bad" }
      : state === "canary" || state === "rollout" || state === "running"
        ? { tone: "warn", pulse: true }
        : { tone: "idle" };

const ACTIVE_DELIVERY = ["held", "pending", "running"];

/**
 * The group to upgrade first: a canary group with active nodes, else the
 * smallest other non-default group with active nodes, else any with nodes.
 */
function defaultUpgradeGroup(groups: NodeGroup[], count: (group: NodeGroup) => number) {
  const withNodes = groups.filter((g) => count(g) > 0);
  return (
    withNodes.find((g) => g.isCanary) ??
    withNodes.filter((g) => !g.isDefault).sort((a, b) => count(a) - count(b))[0] ??
    withNodes[0]
  );
}

// Jobs, nodes and the cluster all change with an upgrade.
const UPGRADE_META = { invalidates: "all" } as const;

export function NodeUpgrades({ clusterId }: { clusterId: string }) {
  const jobs = useQuery({
    ...orpc.upgrades.list.queryOptions({ input: { clusterId } }),
    refetchInterval: 3000,
    meta: { background: true },
  });
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId } }));
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId } }),
    refetchInterval: 5000,
    meta: { background: true },
  });
  const promote = useMutation({ ...orpc.upgrades.promote.mutationOptions(), meta: UPGRADE_META });
  const cancel = useMutation({ ...orpc.upgrades.cancel.mutationOptions(), meta: UPGRADE_META });
  const dialog = useDialogState();
  return (
    <section className="min-w-0 space-y-3" data-testid="node-upgrades">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-sm font-medium">{m.upgrade_title()}</h2>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => dialog.show()}
          disabled={!groups.data?.length || !nodes.data?.length}
          data-testid="upgrade-create"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.upgrade_create()}
        </Button>
      </div>
      <QueryView query={jobs} empty={<EmptyState compact title={m.upgrade_empty()} />}>
        {(list) =>
          list.map((job, index) => {
            const active = ["canary", "rollout"].includes(job.state);
            // Earlier jobs that have finished fold to a line (version, outcome, time); their nodes
            // and errors open under it.
            const folded = index > 0 && !active;
            return (
              <Panel key={job.id} data-testid={`upgrade-${job.version}`}>
                <Collapsible defaultOpen={!folded} className="contents">
                  <PanelHeader className="flex flex-row flex-wrap items-center gap-3">
                    <PanelTitle className="min-w-0 flex-1 break-all font-mono">
                      {job.version}
                    </PanelTitle>
                    <StatusDot {...stateTone(job.state)}>{stateLabel(job.state)}</StatusDot>
                    <span
                      className="text-xs text-muted-foreground"
                      title={formatDateTime(job.createdAt)}
                    >
                      {timeAgo(job.createdAt)}
                    </span>
                    {folded ? (
                      <CollapsibleTrigger
                        render={
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="icon-button -my-1 group"
                            aria-label={m.upgrade_nodes()}
                            data-testid="upgrade-toggle"
                          />
                        }
                      >
                        <HugeiconsIcon
                          icon={ArrowDown01Icon}
                          strokeWidth={2}
                          className="transition-transform group-data-[panel-open]:rotate-180 motion-reduce:transition-none"
                        />
                      </CollapsibleTrigger>
                    ) : null}
                  </PanelHeader>
                  <CollapsibleContent render={<PanelContent className="space-y-4" />}>
                    <UpgradeProgress job={job} />
                    <div className="divide-y divide-edge overflow-hidden rounded-md faint-well">
                      {job.deliveries.map((d) => (
                        <Delivery
                          key={d.id}
                          delivery={d}
                          version={job.version}
                          jobState={job.state}
                        />
                      ))}
                    </div>
                    {job.state === "canary" && job.deliveries.some((d) => d.state === "held") ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <SafetyNote>{m.upgrade_observe()}</SafetyNote>
                        <ConfirmDialog
                          title={m.upgrade_promote()}
                          note={job.version}
                          trigger={
                            <Button
                              disabled={!job.canPromote || promote.isPending}
                              data-testid="upgrade-promote"
                            >
                              {m.upgrade_promote()}
                            </Button>
                          }
                          onConfirm={async () => {
                            await promote.mutateAsync({ id: job.id });
                          }}
                        />
                      </div>
                    ) : null}
                    {active ? (
                      <ConfirmDialog
                        title={m.upgrade_cancel()}
                        note={m.upgrade_cancel_note()}
                        destructive
                        trigger={
                          <Button
                            variant="secondary"
                            disabled={
                              cancel.isPending || job.deliveries.some((d) => d.state === "running")
                            }
                          >
                            {m.upgrade_cancel()}
                          </Button>
                        }
                        onConfirm={async () => {
                          await cancel.mutateAsync({ id: job.id });
                        }}
                      />
                    ) : null}
                  </CollapsibleContent>
                </Collapsible>
              </Panel>
            );
          })
        }
      </QueryView>
      <UpgradeDialog
        key={dialog.key}
        open={dialog.open}
        onOpenChange={dialog.onOpenChange}
        groups={groups.data ?? []}
        nodes={nodes.data ?? []}
        jobs={jobs.data ?? []}
      />
    </section>
  );
}
function UpgradeDialog({
  open,
  onOpenChange,
  groups,
  nodes,
  jobs,
}: {
  groups: NodeGroup[];
  nodes: Node[];
  jobs: UpgradeJob[];
} & DialogProps) {
  const create = useMutation({ ...orpc.upgrades.create.mutationOptions(), meta: UPGRADE_META });
  const latest = useQuery({
    ...orpc.upgrades.latestVersion.queryOptions(),
    enabled: open,
    staleTime: 10 * 60_000,
    meta: { background: true },
  });
  const [typed, setTyped] = React.useState<string | null>(null);
  const [chosenGroup, setChosenGroup] = React.useState("");
  // The latest release until the operator types another version.
  const version = typed ?? latest.data?.version ?? "";
  const active = nodes.filter((n) => n.status === "active");
  const count = (group: NodeGroup) => active.filter((n) => n.nodeGroupId === group.id).length;
  const groupId = chosenGroup || defaultUpgradeGroup(groups, count)?.id || "";
  const group = groups.find((g) => g.id === groupId);
  const busy = new Set(
    jobs.flatMap((job) =>
      job.deliveries.filter((d) => ACTIVE_DELIVERY.includes(d.state)).map((d) => d.nodeId),
    ),
  );
  const blocked = active.flatMap((node) => {
    const reason = upgradeBlocker(node, busy);
    return reason ? [{ node, reason }] : [];
  });
  const parsed = releaseVersion.safeParse(version);
  // Nodes refuse downgrades: nothing to do when every node runs this version or a newer one.
  const current =
    parsed.success &&
    active.length > 0 &&
    active.every((n) => (compareReleaseVersions(n.agentVersion, parsed.data) ?? -1) >= 0);
  const canaryEmpty = !!group && count(group) === 0;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.upgrade_create()}
      submitLabel={m.upgrade_start()}
      submitTestId="upgrade-submit"
      submitDisabled={!parsed.success || blocked.length > 0 || current || canaryEmpty || !groupId}
      onSubmit={async () => {
        await create.mutateAsync({ nodeGroupId: groupId, version: parsed.data ?? version });
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="upgrade-version">{m.upgrade_version()}</FieldLabel>
        <Input
          id="upgrade-version"
          name="version"
          required
          maxLength={64}
          value={version}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={m.upgrade_version_placeholder()}
          className="font-mono"
          aria-invalid={!!version.trim() && !parsed.success}
        />
        {version.trim() && !parsed.success ? (
          <FieldError data-testid="upgrade-version-invalid">
            {m.upgrade_version_invalid()}
          </FieldError>
        ) : null}
        {current ? (
          <SafetyNote data-testid="upgrade-current">
            {m.upgrade_nodes_current({ version: parsed.data ?? version })}
          </SafetyNote>
        ) : null}
      </Field>
      <FormSelect
        id="upgrade-group"
        label={m.upgrade_group()}
        value={groupId}
        onChange={setChosenGroup}
        options={groups.map((g) => ({
          value: g.id,
          label: m.upgrade_group_nodes({ name: g.name, count: count(g) }),
        }))}
      />
      {group && count(group) === active.length && active.length > 1 ? (
        <SafetyNote data-testid="upgrade-group-all">
          {m.upgrade_group_all({ count: active.length })}
        </SafetyNote>
      ) : null}
      {blocked.length ? (
        <Field data-testid="upgrade-blocked">
          <FieldLabel>{m.upgrade_blocked()}</FieldLabel>
          <ul className="divide-y divide-edge overflow-hidden rounded-md text-sm faint-well">
            {blocked.map(({ node, reason }) => (
              <li
                key={node.id}
                className="flex items-center gap-2 px-3 py-2"
                data-testid="upgrade-blocked-node"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{reason}</span>
              </li>
            ))}
          </ul>
        </Field>
      ) : null}
      <SafetyNote>{m.upgrade_start_note()}</SafetyNote>
    </FormDialog>
  );
}

/** The job's group and how many of its deliveries succeeded, as words and a bar. */
function UpgradeProgress({ job }: { job: UpgradeJob }) {
  const done = job.deliveries.filter((d) => d.state === "succeeded").length;
  const total = job.deliveries.length;
  const progress = m.upgrade_progress({ done, total });
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="min-w-0 flex-1 break-all">
          {m.upgrade_group_label({ name: job.groupName })}
        </span>
        <span className="font-medium tabular-nums">{progress}</span>
      </div>
      <Progress value={done} max={total} aria-label={progress} />
    </div>
  );
}

function Delivery({
  delivery: d,
  version,
  jobState,
}: {
  delivery: UpgradeJob["deliveries"][number];
  version: string;
  jobState: UpgradeJob["state"];
}) {
  return (
    <div className="space-y-2 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-medium">{d.nodeName}</span>
        <span className="text-xs text-muted-foreground">
          {d.phase === "canary" ? m.upgrade_canary() : m.upgrade_rollout()}
        </span>
        {/* After promotion the rest follows in batches. */}
        <StatusDot {...stateTone(d.state)}>
          {d.state === "held" && jobState === "rollout" ? m.upgrade_queued() : stateLabel(d.state)}
        </StatusDot>
      </div>
      {d.deadlineAt ? (
        <p className="text-xs text-muted-foreground">
          {m.upgrade_deadline({ time: formatDateTime(d.deadlineAt) })}
        </p>
      ) : null}
      {d.errorCode ? (
        <p className="break-words text-xs text-muted-foreground">
          {taskErrorText(d.errorCode, { version }, d.message)}
        </p>
      ) : null}
      {d.message && d.state === "failed" ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{m.upgrade_details()}</summary>
          <pre className="mt-2 rounded-lg bg-card p-2 whitespace-pre-wrap break-all font-mono">
            {d.message}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
