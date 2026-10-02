import { MAX_CACHE_TASK_URLS, type Site } from "@edgeweir/contract";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import {
  CacheTaskList,
  cacheTaskTypeLabel,
  followTasks,
  useExpandedTasks,
} from "@/components/cache-tasks";
import { SafetyNote } from "@/components/safety-note";
import { QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { formatNumber, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { expandPurgeTargets, purgeLines } from "@/lib/purge";
import { cn } from "@/lib/utils";

const TYPES = ["url", "prefix", "site"] as const;
type PurgeType = (typeof TYPES)[number];
/** Tasks of the site shown under the form; the purge page lists them all. */
const HISTORY = 5;

const placeholders: Record<Exclude<PurgeType, "site">, string> = {
  url: "/index.html\n/static/app.js?v=2",
  prefix: "/static/\n/images/",
};

/**
 * Purges of the site from its cache tab: paths (on each of its domains that is not a wildcard) or
 * URLs, path prefixes, or everything; then its latest tasks, followed while nodes work on them.
 */
export function CachePurgeCard({ site }: { site: Site }) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [type, setType] = React.useState<PurgeType>("url");
  const [text, setText] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const { expanded, toggle } = useExpandedTasks();
  const listInput = { siteId: site.id, page: 1, pageSize: HISTORY };
  const tasks = useQuery({
    ...orpc.cacheTasks.list.queryOptions({ input: listInput }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => followTasks(query.state.data),
    meta: { background: true },
  });
  const entries = purgeLines(text);
  const { urls, invalid } = expandPurgeTargets(entries, site.domains);
  const problem = invalid.length
    ? m.cache_purge_invalid({ entries: invalid.slice(0, 3).join(", ") })
    : urls.length > MAX_CACHE_TASK_URLS
      ? m.cache_purge_too_many({ max: formatNumber(MAX_CACHE_TASK_URLS) })
      : entries.length > 0 && urls.length === 0
        ? m.cache_purge_no_domains()
        : null;
  const blocked = type !== "site" && (urls.length === 0 || problem !== null);

  const submit = async () => {
    setError(null);
    try {
      const task = await action.run(() =>
        type === "site"
          ? client.sites.purgeAll({ id: site.id })
          : client.cacheTasks.create({ type, urls }),
      );
      toast.success(type === "site" ? m.sites_purged() : m.purge_submitted());
      if (type !== "site") setText("");
      toggle(task.id, true);
      await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Card className="animate-enter" data-testid="cache-purge-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <CardHeader>
          <CardTitle>{m.cache_purge_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Tabs
            value={type}
            onValueChange={(value) => {
              setError(null);
              setType(value as PurgeType);
            }}
          >
            <TabsList>
              {TYPES.map((t) => (
                <TabsTrigger key={t} value={t} data-testid={`cache-purge-type-${t}`}>
                  {cacheTaskTypeLabel[t]()}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          {type === "site" ? (
            <SafetyNote className="break-all font-mono" data-testid="cache-purge-site">
              {site.domains.join(", ")}
            </SafetyNote>
          ) : (
            <Field data-invalid={problem ? true : undefined}>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="cache-purge-entries">{m.cache_purge_entries()}</FieldLabel>
                <span
                  className={cn(
                    "text-xs tabular-nums text-muted-foreground",
                    urls.length > MAX_CACHE_TASK_URLS && "font-medium text-destructive",
                  )}
                  data-testid="cache-purge-count"
                >
                  {formatNumber(urls.length)} / {formatNumber(MAX_CACHE_TASK_URLS)}
                </span>
              </div>
              <Textarea
                id="cache-purge-entries"
                value={text}
                rows={4}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                placeholder={placeholders[type]}
                aria-invalid={problem ? true : undefined}
                className="max-h-72 min-h-24 font-mono text-sm break-all"
                onChange={(event) => setText(event.target.value)}
                data-testid="cache-purge-entries"
              />
              {problem ? (
                <FieldError className="animate-in fade-in" data-testid="cache-purge-problem">
                  {problem}
                </FieldError>
              ) : null}
            </Field>
          )}
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-3">
          {error ? (
            <FieldError className="mr-auto animate-in fade-in" data-testid="cache-purge-error">
              {error}
            </FieldError>
          ) : null}
          <Button
            type="submit"
            disabled={action.pending || blocked}
            data-testid="cache-purge-submit"
          >
            {action.pending ? <Spinner /> : null}
            {m.purge_submit()}
          </Button>
        </CardFooter>
      </form>
      <CardContent className="flex flex-col gap-3 border-t pt-(--card-spacing)">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">{m.purge_tasks()}</h3>
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={<Link to="/purge" search={{ site: site.id }} />}
            data-testid="cache-purge-all-tasks"
          >
            {m.purge_view_tasks()}
          </Button>
        </div>
        <QueryView
          query={tasks}
          loadingClassName="min-h-24"
          isEmpty={(data) => data.items.length === 0}
          empty={<p className="text-sm text-muted-foreground">{m.purge_tasks_empty()}</p>}
        >
          {({ items }) => <CacheTaskList tasks={items} expanded={expanded} onToggle={toggle} />}
        </QueryView>
      </CardContent>
    </Card>
  );
}
