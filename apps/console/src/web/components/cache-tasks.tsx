import type {
  CacheTask,
  CacheTaskNodeState,
  CacheTaskType,
  PrefetchVariant,
} from "@edgeweir/contract";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { BorderBeam } from "@/components/appica/effects";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { taskErrorText } from "@/lib/node-errors";
import { cn } from "@/lib/utils";

export const cacheTaskTypeLabel: Record<CacheTaskType, () => string> = {
  url: m.purge_type_url,
  prefix: m.purge_type_prefix,
  site: m.purge_type_site,
  prefetch: m.purge_type_prefetch,
  host: m.purge_type_host,
  tag: m.purge_type_tag,
  sitemap: m.purge_type_sitemap,
};

export const prefetchVariantLabel: Record<PrefetchVariant, () => string> = {
  desktop: m.purge_variant_desktop,
  mobile: m.purge_variant_mobile,
};

const finished = (state: CacheTaskNodeState) => state === "succeeded" || state === "failed";

/** Poll a task list every 2 s while one of its tasks waits for nodes. */
export const followTasks = (tasks: { items: CacheTask[] } | undefined) =>
  tasks?.items.some((t) => !finished(t.state)) ? 2_000 : false;

/** Which tasks of a list show their details. */
export function useExpandedTasks() {
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = React.useCallback(
    (id: string, open: boolean) =>
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  return { expanded, toggle };
}

/**
 * Purge and prefetch tasks, newest first, each with its nodes' progress and details: flat rows in
 * a card of their own, or (`inset`) in a hairline group inside another card.
 */
export function CacheTaskList({
  tasks,
  expanded,
  onToggle,
  inset = false,
}: {
  tasks: CacheTask[];
  expanded: ReadonlySet<string>;
  onToggle: (id: string, open: boolean) => void;
  inset?: boolean;
}) {
  return (
    <ul
      className={cn(
        "divide-y overflow-hidden rounded-2xl",
        inset ? "border" : "bg-card shadow-elev-1 edge-lit",
      )}
      data-testid="cache-tasks"
    >
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          index={index}
          open={expanded.has(task.id)}
          onOpenChange={(open) => onToggle(task.id, open)}
        />
      ))}
    </ul>
  );
}

function StateBadge({ state, testId }: { state: CacheTaskNodeState; testId: string }) {
  switch (state) {
    case "skipped":
      return (
        <Badge variant="outline" className="text-muted-foreground" data-testid={testId}>
          {m.purge_state_skipped()}
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="text-muted-foreground" data-testid={testId}>
          {m.purge_state_pending()}
        </Badge>
      );
    case "running":
      return (
        <Badge variant="secondary" data-testid={testId}>
          <Spinner className="size-3 motion-reduce:animate-none" aria-hidden="true" />
          {m.purge_state_running()}
        </Badge>
      );
    case "succeeded":
      return (
        <Badge variant="outline" data-testid={testId}>
          <span className="size-1.5 rounded-full bg-chart-2" />
          {m.purge_state_succeeded()}
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive" data-testid={testId}>
          {m.purge_state_failed()}
        </Badge>
      );
  }
}

function NodeProgress({ task }: { task: CacheTask }) {
  // Disabled (skipped) nodes are listed in the details but not counted.
  const nodes = task.nodes.filter((n) => n.state !== "skipped");
  const total = nodes.length;
  if (total === 0) return <span data-testid="cache-task-progress">{m.purge_no_nodes()}</span>;
  const done = nodes.filter((n) => finished(n.state)).length;
  const failed = nodes.some((n) => n.state === "failed");
  return (
    <div className="inline-flex items-center gap-2">
      <Progress
        value={Math.round((done / total) * 100)}
        aria-label={m.purge_nodes()}
        className={cn(
          "w-16 gap-0 **:data-[slot=progress-track]:h-1.5",
          failed && "**:data-[slot=progress-indicator]:bg-destructive",
        )}
      />
      <span className="tabular-nums" data-testid="cache-task-progress">
        {m.purge_nodes_progress({ done, total })}
      </span>
    </div>
  );
}

function TaskRow({
  task,
  index,
  open,
  onOpenChange,
}: {
  task: CacheTask;
  index: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Whole-site purges list their sites; every other type what was asked for (URLs, hosts, tags).
  const targets = task.type === "site" ? task.sites.map((s) => s.name) : task.targets;
  const more = targets.length - 1;
  // URLs, hosts and tags read best in monospace; site names do not.
  const mono = task.type !== "site";
  // Waiting for nodes: a signal beam runs around the row until the task ends (a still signal
  // hairline under reduced motion).
  const active = !finished(task.state);
  return (
    <li
      className="animate-enter"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      data-testid="cache-task"
      data-state={task.state}
      data-type={task.type}
    >
      <Collapsible
        open={open}
        onOpenChange={onOpenChange}
        className={cn(
          "relative",
          active &&
            "m-1 rounded-xl shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--signal)_40%,transparent)]",
        )}
      >
        {active ? (
          <BorderBeam
            tone="signal"
            speed={4}
            className="pointer-events-none absolute inset-0 rounded-[inherit]"
            data-testid="cache-task-beam"
          />
        ) : null}
        {/*
          One wrapping row, reordered by width: on phones the state and the toggle share the first
          line with the type so the target gets a full line; from sm up the target sits in between.
        */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-2 gap-y-1.5",
            active ? "px-3 py-2" : "px-4 py-3",
          )}
        >
          <Badge variant="secondary" className="order-1" data-testid="cache-task-type">
            {cacheTaskTypeLabel[task.type]()}
          </Badge>
          <div className="order-4 flex min-w-0 basis-full items-center gap-2 sm:order-2 sm:flex-1 sm:basis-0">
            <span
              className={cn("min-w-0 truncate text-sm", mono && "font-mono")}
              title={targets.join("\n")}
              data-testid="cache-task-target"
            >
              {targets[0] ?? "—"}
            </span>
            {more > 0 ? (
              <Badge variant="outline" className="tabular-nums">
                +{formatNumber(more)}
              </Badge>
            ) : null}
          </div>
          <div className="order-2 ml-auto sm:order-3">
            <StateBadge state={task.state} testId="cache-task-state" />
          </div>
          <CollapsibleTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="order-3 -my-1 sm:order-4"
                aria-label={m.purge_details()}
                data-testid="cache-task-toggle"
              />
            }
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              strokeWidth={2}
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-180",
              )}
            />
          </CollapsibleTrigger>
          <div className="order-5 flex basis-full flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="cache-task-creator">
              {task.source === "recovery" ? m.purge_source_recovery() : task.createdByName || "—"}
            </span>
            <span title={formatDateTime(task.createdAt)}>{timeAgo(task.createdAt)}</span>
            {task.type === "tag" ? (
              <span className="min-w-0 break-all" data-testid="cache-task-sites">
                {task.sites.map((s) => s.name).join(", ")}
              </span>
            ) : null}
            {task.variants.length ? (
              <span data-testid="cache-task-variants">
                {task.variants.map((variant) => prefetchVariantLabel[variant]()).join(" / ")}
              </span>
            ) : null}
            {task.maxUrls !== null ? (
              <span className="tabular-nums" data-testid="cache-task-max-urls">
                {m.purge_sitemap_limit({ count: formatNumber(task.maxUrls) })}
              </span>
            ) : null}
            <NodeProgress task={task} />
          </div>
        </div>
        <CollapsibleContent className="animate-in fade-in duration-300 motion-reduce:animate-none">
          <div
            className={cn(
              "grid gap-4 border-t bg-well px-4 py-3 md:grid-cols-2",
              active && "rounded-b-xl px-3",
            )}
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{m.purge_targets()}</h3>
              <ul
                className={cn(
                  "flex max-h-48 flex-col gap-1 overflow-y-auto text-xs",
                  mono && "font-mono",
                )}
                data-testid="cache-task-targets"
              >
                {targets.map((target) => (
                  <li key={target} className="break-all">
                    {target}
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{m.purge_nodes()}</h3>
              {task.nodes.length === 0 ? (
                <p className="text-sm text-muted-foreground">{m.purge_no_nodes()}</p>
              ) : (
                <ul className="flex flex-col divide-y">
                  {task.nodes.map((node) => {
                    const outcome = taskErrorText(node.errorCode, node.errorParams, node.message);
                    return (
                      <li
                        key={node.nodeId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm first:pt-0 last:pb-0"
                        data-testid="cache-task-node"
                        data-state={node.state}
                      >
                        <span className="font-medium" data-testid="cache-task-node-name">
                          {node.nodeName}
                        </span>
                        <StateBadge state={node.state} testId="cache-task-node-state" />
                        {finished(node.state) ? (
                          <span
                            className="text-xs tabular-nums text-muted-foreground"
                            data-testid="cache-task-node-counts"
                          >
                            {m.purge_node_counts({
                              succeeded: formatNumber(node.succeeded),
                              failed: formatNumber(node.failed),
                            })}
                          </span>
                        ) : null}
                        {node.finishedAt ? (
                          <span
                            className="ml-auto text-xs text-muted-foreground"
                            title={formatDateTime(node.finishedAt)}
                          >
                            {timeAgo(node.finishedAt)}
                          </span>
                        ) : null}
                        {outcome ? (
                          <p
                            className="basis-full text-xs break-all text-muted-foreground"
                            title={node.message || undefined}
                            data-testid="cache-task-node-message"
                            data-code={node.errorCode || undefined}
                          >
                            {outcome}
                          </p>
                        ) : null}
                        {node.recoveredAt ? (
                          <p
                            className="basis-full text-xs text-muted-foreground"
                            title={formatDateTime(node.recoveredAt)}
                            data-testid="cache-task-node-recovered"
                          >
                            {m.purge_node_recovered()}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
