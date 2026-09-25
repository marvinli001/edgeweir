import {
  type CacheTask,
  type CacheTaskNodeState,
  type CacheTaskType,
  MAX_CACHE_TASK_URLS,
  type Site,
} from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowDown01Icon,
  DatabaseSync01Icon,
  GlobeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { taskErrorText } from "@/lib/node-errors";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const TYPES = ["url", "prefix", "site", "prefetch"] as const satisfies readonly CacheTaskType[];

export const Route = createFileRoute("/_app/purge")({
  validateSearch: z.object({
    type: z.enum(TYPES).optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: PurgePage,
});

const typeLabel: Record<CacheTaskType, () => string> = {
  url: m.purge_type_url,
  prefix: m.purge_type_prefix,
  site: m.purge_type_site,
  prefetch: m.purge_type_prefetch,
};

const placeholders: Record<Exclude<CacheTaskType, "site">, string> = {
  url: "https://www.example.com/index.html\nhttps://www.example.com/app.js?v=2",
  prefix: "https://www.example.com/static/\nhttps://www.example.com/images/",
  prefetch: "https://www.example.com/video.mp4\nhttps://www.example.com/app.js",
};

const finished = (state: CacheTaskNodeState) => state === "succeeded" || state === "failed";

function PurgePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = search.page ?? 1;
  const [expanded, setExpanded] = React.useState<ReadonlySet<string>>(new Set());
  const tasks = useQuery({
    ...orpc.cacheTasks.list.queryOptions({ input: { page, pageSize: PAGE_SIZE } }),
    placeholderData: keepPreviousData,
    // Follow tasks until every node reported.
    refetchInterval: (query) =>
      query.state.data?.items.some((t) => !finished(t.state)) ? 2_000 : false,
    meta: { background: true },
  });
  const toggle = (id: string, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Page title={m.purge_title()}>
      <PurgeForm
        type={search.type ?? "url"}
        onTypeChange={(type) =>
          navigate({
            search: (prev) => ({ ...prev, type: type === "url" ? undefined : type }),
            replace: true,
          })
        }
        onCreated={async (task) => {
          toggle(task.id, true);
          if (page !== 1) await navigate({ search: (prev) => ({ ...prev, page: undefined }) });
        }}
      />
      <section className="flex flex-col gap-3" aria-labelledby="purge-tasks-title">
        <h2 id="purge-tasks-title" className="text-sm font-medium text-muted-foreground">
          {m.purge_tasks()}
        </h2>
        {tasks.isPending ? (
          <LoadingState />
        ) : tasks.isError ? (
          <ErrorState error={tasks.error} onRetry={() => tasks.refetch()} />
        ) : tasks.data.total === 0 ? (
          <EmptyState icon={DatabaseSync01Icon} title={m.purge_tasks_empty()} />
        ) : (
          <>
            <ul
              className="divide-y overflow-hidden rounded-2xl border bg-card shadow-xs"
              data-testid="cache-tasks"
            >
              {tasks.data.items.map((task, index) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  index={index}
                  open={expanded.has(task.id)}
                  onOpenChange={(open) => toggle(task.id, open)}
                />
              ))}
            </ul>
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={tasks.data.total}
              onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
            />
          </>
        )}
      </section>
    </Page>
  );
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

function PurgeForm({
  type,
  onTypeChange,
  onCreated,
}: {
  type: CacheTaskType;
  onTypeChange: (type: CacheTaskType) => void;
  onCreated: (task: CacheTask) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.cacheTasks.create.mutationOptions());
  const [text, setText] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlyMap<string, string>>(new Map());
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const urls = lines(text);
  const tooMany = urls.length > MAX_CACHE_TASK_URLS;
  const isSite = type === "site";

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const task = await create.mutateAsync({
        type,
        urls: isSite ? [] : urls,
        siteIds: isSite ? [...selected.keys()] : [],
      });
      toast.success(m.purge_submitted());
      if (isSite) setSelected(new Map());
      else setText("");
      await onCreated(task);
      // Show it right away at the top, then load the list as the server has it.
      queryClient.setQueryData(
        orpc.cacheTasks.list.queryKey({ input: { page: 1, pageSize: PAGE_SIZE } }),
        (old) =>
          old
            ? {
                items: [task, ...old.items.filter((t) => t.id !== task.id)].slice(0, PAGE_SIZE),
                total: old.total + 1,
              }
            : old,
      );
      await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  const urlField = (label: string, t: Exclude<CacheTaskType, "site">) => (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={`purge-${t}`}>{label}</FieldLabel>
        <span
          className={cn(
            "text-xs tabular-nums text-muted-foreground",
            tooMany && "font-medium text-destructive",
          )}
          data-testid="purge-count"
        >
          {formatNumber(urls.length)} / {formatNumber(MAX_CACHE_TASK_URLS)}
        </span>
      </div>
      <Textarea
        id={`purge-${t}`}
        value={text}
        required
        rows={6}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => setText(event.target.value)}
        placeholder={placeholders[t]}
        aria-invalid={tooMany || undefined}
        className="min-h-36 font-mono text-sm break-all"
        data-testid="purge-urls"
      />
    </Field>
  );

  return (
    <Card className="animate-enter" data-testid="purge-form">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <CardContent>
          <Tabs
            value={type}
            onValueChange={(value) => {
              setError(null);
              onTypeChange(value as CacheTaskType);
            }}
          >
            {/* Two by two on phones, one pill row from sm up. */}
            <TabsList className="grid w-full grid-cols-2 gap-1 rounded-2xl group-data-horizontal/tabs:h-auto sm:inline-flex sm:w-fit sm:gap-0 sm:rounded-full sm:group-data-horizontal/tabs:h-9">
              {TYPES.map((t) => (
                <TabsTrigger
                  key={t}
                  value={t}
                  className="h-8 rounded-xl sm:h-[calc(100%-1px)] sm:rounded-full"
                  data-testid={`purge-type-${t}`}
                >
                  {typeLabel[t]()}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="url" className="pt-3">
              {urlField(m.purge_urls(), "url")}
            </TabsContent>
            <TabsContent value="prefix" className="pt-3">
              {urlField(m.purge_prefixes(), "prefix")}
            </TabsContent>
            <TabsContent value="site" className="pt-3">
              <SitePicker selected={selected} onChange={setSelected} />
            </TabsContent>
            <TabsContent value="prefetch" className="pt-3">
              {urlField(m.purge_urls(), "prefetch")}
            </TabsContent>
          </Tabs>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-3 border-t">
          {error ? (
            <FieldError className="mr-auto animate-in fade-in" data-testid="purge-error">
              {error}
            </FieldError>
          ) : null}
          <Button
            type="submit"
            disabled={pending || (isSite ? selected.size === 0 : tooMany)}
            data-testid="purge-submit"
          >
            {pending ? <Spinner /> : null}
            {m.purge_submit()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** Checkbox list of the sites in scope; a search box appears once there are many. */
function SitePicker({
  selected,
  onChange,
}: {
  selected: ReadonlyMap<string, string>;
  onChange: (selected: ReadonlyMap<string, string>) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const all = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const filtered = useQuery({
    ...orpc.sites.list.queryOptions({ input: { search: query, page: 1, pageSize: 100 } }),
    enabled: query !== "",
    placeholderData: keepPreviousData,
  });
  const list = query ? filtered : all;
  const searchable = (all.data?.total ?? 0) > 8;
  const toggle = (site: Site, checked: boolean) => {
    const next = new Map(selected);
    if (checked) next.set(site.id, site.name);
    else next.delete(site.id);
    onChange(next);
  };

  if (all.isPending) return <LoadingState className="min-h-36" />;
  if (all.isError) return <ErrorState error={all.error} onRetry={() => all.refetch()} />;
  if (all.data.total === 0) {
    return (
      <EmptyState icon={GlobeIcon} title={m.sites_empty_title()}>
        <Button render={<Link to="/sites" search={{ create: true }} />}>
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.nav_new_site()}
        </Button>
      </EmptyState>
    );
  }
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel id="purge-sites-label">{m.purge_sites()}</FieldLabel>
        <span className="text-xs tabular-nums text-muted-foreground" data-testid="purge-selected">
          {m.purge_sites_selected({ count: selected.size })}
        </span>
      </div>
      {searchable ? (
        <Input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={m.sites_search_placeholder()}
          aria-label={m.sites_search_placeholder()}
        />
      ) : null}
      <fieldset
        aria-labelledby="purge-sites-label"
        className="max-h-72 min-w-0 divide-y overflow-y-auto rounded-2xl border"
      >
        {list.isError ? (
          <div className="p-3">
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          </div>
        ) : list.data?.items.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            {m.sites_no_match()}
          </p>
        ) : (
          list.data?.items.map((site, index) => (
            // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
            <label
              key={site.id}
              className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors animate-enter hover:bg-muted/50 has-data-checked:bg-primary/5"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              data-testid="purge-site-option"
            >
              <Checkbox
                checked={selected.has(site.id)}
                onCheckedChange={(checked) => toggle(site, checked)}
              />
              <span className="shrink-0 text-sm font-medium">{site.name}</span>
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {site.domains.join(", ")}
              </span>
            </label>
          ))
        )}
      </fieldset>
    </Field>
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
  const targets = task.type === "site" ? task.sites.map((s) => s.name) : task.targets;
  const more = targets.length - 1;
  // URLs read best in monospace; site names do not.
  const mono = task.type !== "site";
  return (
    <li
      className="animate-enter"
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      data-testid="cache-task"
      data-state={task.state}
      data-type={task.type}
    >
      <Collapsible open={open} onOpenChange={onOpenChange}>
        {/*
          One wrapping row, reordered by width: on phones the state and the toggle share the first
          line with the type so the target gets a full line; from sm up the target sits in between.
        */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-3">
          <Badge variant="secondary" className="order-1" data-testid="cache-task-type">
            {typeLabel[task.type]()}
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
            <span>{task.createdByName || "—"}</span>
            <span title={formatDateTime(task.createdAt)}>{timeAgo(task.createdAt)}</span>
            <NodeProgress task={task} />
          </div>
        </div>
        <CollapsibleContent className="animate-in fade-in duration-300 motion-reduce:animate-none">
          <div className="grid gap-4 border-t bg-muted/30 px-4 py-3 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h3 className="text-xs font-medium text-muted-foreground">{m.purge_targets()}</h3>
              <ul
                className={cn(
                  "flex max-h-48 flex-col gap-1 overflow-y-auto text-xs",
                  mono && "font-mono",
                )}
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
                <ul className="flex flex-col gap-2">
                  {task.nodes.map((node) => {
                    const outcome = taskErrorText(node.errorCode, node.errorParams, node.message);
                    return (
                      <li
                        key={node.nodeId}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-background px-3 py-2 text-sm"
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
