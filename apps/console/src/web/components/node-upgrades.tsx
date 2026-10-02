import type { UpgradeJob } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { taskErrorText } from "@/lib/node-errors";
import { orpc } from "@/lib/orpc";

const stateLabel = (state: UpgradeJob["state"] | UpgradeJob["deliveries"][number]["state"]) =>
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
export function NodeUpgrades({ clusterId }: { clusterId: string }) {
  const cache = useQueryClient();
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
  const create = useMutation(orpc.upgrades.create.mutationOptions());
  const promote = useMutation(orpc.upgrades.promote.mutationOptions());
  const cancel = useMutation(orpc.upgrades.cancel.mutationOptions());
  const [open, setOpen] = React.useState(false),
    [chosenGroup, setChosenGroup] = React.useState("");
  const groupId =
    chosenGroup ||
    groups.data?.find((g) => nodes.data?.some((n) => n.nodeGroupId === g.id))?.id ||
    "";
  const refreshed = async () => {
    await cache.invalidateQueries();
  };
  return (
    <section className="min-w-0 space-y-3" data-testid="node-upgrades">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-sm font-medium">{m.upgrade_title()}</h2>
        <Button
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={!groups.data?.length || !nodes.data?.length}
          data-testid="upgrade-create"
        >
          {m.upgrade_create()}
        </Button>
      </div>
      {jobs.isPending ? (
        <LoadingState />
      ) : jobs.isLoadingError ? (
        <ErrorState error={jobs.error} onRetry={() => void jobs.refetch()} />
      ) : jobs.data.length === 0 ? (
        <EmptyState title={m.upgrade_empty()} />
      ) : (
        jobs.data.map((job) => (
          <Card key={job.id} data-testid={`upgrade-${job.version}`}>
            <CardHeader className="flex flex-row flex-wrap items-center gap-3">
              <CardTitle className="min-w-0 flex-1 break-all font-mono">{job.version}</CardTitle>
              <Badge variant="outline">{stateLabel(job.state)}</Badge>
              <span className="text-xs text-muted-foreground">{timeAgo(job.createdAt)}</span>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 text-sm">
                <span className="min-w-0 flex-1 break-all">
                  {m.upgrade_group_label({ name: job.groupName })}
                </span>
                <span className="tabular-nums">
                  {m.upgrade_progress({
                    done: job.deliveries.filter((d) => d.state === "succeeded").length,
                    total: job.deliveries.length,
                  })}
                </span>
              </div>
              <div className="divide-y rounded-xl border">
                {job.deliveries.map((d) => (
                  <Delivery key={d.id} delivery={d} version={job.version} jobState={job.state} />
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
                      await refreshed();
                    }}
                  />
                </div>
              ) : null}
              {["canary", "rollout"].includes(job.state) ? (
                <ConfirmDialog
                  title={m.upgrade_cancel()}
                  note={m.upgrade_cancel_note()}
                  destructive
                  trigger={
                    <Button
                      variant="outline"
                      disabled={
                        cancel.isPending || job.deliveries.some((d) => d.state === "running")
                      }
                    >
                      {m.upgrade_cancel()}
                    </Button>
                  }
                  onConfirm={async () => {
                    await cancel.mutateAsync({ id: job.id });
                    await refreshed();
                  }}
                />
              ) : null}
            </CardContent>
          </Card>
        ))
      )}
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={m.upgrade_create()}
        submitLabel={m.upgrade_start()}
        submitTestId="upgrade-submit"
        onSubmit={async (data) => {
          await create.mutateAsync({
            nodeGroupId: groupId,
            version: String(data.get("version") ?? ""),
          });
          setOpen(false);
          await refreshed();
        }}
      >
        <Field>
          <FieldLabel htmlFor="upgrade-version">{m.upgrade_version()}</FieldLabel>
          <Input
            id="upgrade-version"
            name="version"
            required
            maxLength={64}
            placeholder={m.upgrade_version_placeholder()}
          />
        </Field>
        <FormSelect
          id="upgrade-group"
          label={m.upgrade_group()}
          value={groupId}
          onChange={setChosenGroup}
          options={(groups.data ?? []).map((g) => ({
            value: g.id,
            label: m.upgrade_group_nodes({
              name: g.name,
              count: (nodes.data ?? []).filter((n) => n.nodeGroupId === g.id).length,
            }),
          }))}
        />
        <SafetyNote>{m.upgrade_start_note()}</SafetyNote>
      </FormDialog>
    </section>
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
    <div className="space-y-2 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 break-all font-medium">{d.nodeName}</span>
        <span className="text-xs text-muted-foreground">
          {d.phase === "canary" ? m.upgrade_canary() : m.upgrade_rollout()}
        </span>
        <Badge variant="outline">
          {/* After promotion the rest follows in batches. */}
          {d.state === "held" && jobState === "rollout" ? m.upgrade_queued() : stateLabel(d.state)}
        </Badge>
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
          <pre className="mt-2 whitespace-pre-wrap break-all font-mono">{d.message}</pre>
        </details>
      ) : null}
    </div>
  );
}
