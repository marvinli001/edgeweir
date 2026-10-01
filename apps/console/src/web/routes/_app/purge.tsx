import {
  type CacheTask,
  type CacheTaskCreateInput,
  type CacheTaskNodeState,
  type CacheTaskType,
  MAX_CACHE_TASK_HOSTS,
  MAX_CACHE_TASK_TAGS,
  MAX_CACHE_TASK_URLS,
  type PrefetchVariant,
  prefetchVariant,
  SITEMAP_MAX_URLS,
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
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { taskErrorText } from "@/lib/node-errors";
import { errorMessage, orpc } from "@/lib/orpc";
import { unavailableReason } from "@/lib/protection";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
/** The form's types: purges from one URL to whole sites, then prefetches. */
const TYPES = [
  "url",
  "prefix",
  "host",
  "tag",
  "site",
  "prefetch",
  "sitemap",
] as const satisfies readonly CacheTaskType[];

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
  host: m.purge_type_host,
  tag: m.purge_type_tag,
  sitemap: m.purge_type_sitemap,
};

const variantLabel: Record<PrefetchVariant, () => string> = {
  desktop: m.purge_variant_desktop,
  mobile: m.purge_variant_mobile,
};

/** URL-like types share one list of URLs. */
type UrlType = "url" | "prefix" | "prefetch";

const placeholders = {
  url: "https://www.example.com/index.html\nhttps://www.example.com/app.js?v=2",
  prefix: "https://www.example.com/static/\nhttps://www.example.com/images/",
  prefetch: "https://www.example.com/video.mp4\nhttps://www.example.com/app.js",
  host: "www.example.com\nimg.example.com",
  tag: "product-42\ncategory-shoes",
  sitemap: "https://www.example.com/sitemap.xml",
} as const;

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

/** One entry per line (URLs may contain commas and spaces are trimmed). */
const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Host names: one per line, or separated by spaces or commas. */
const hostEntries = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((host) => host.trim())
    .filter(Boolean);

/** Cache tags: one per line or comma separated (as in a Cache-Tag header); tags never hold commas. */
const tagEntries = (text: string) =>
  text
    .split(/[\r\n,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

interface Draft {
  /** URLs or prefixes (url, prefix, prefetch). */
  urls: string;
  hosts: string;
  tags: string;
  tagSite: { id: string; name: string } | null;
  sitemapUrl: string;
  maxUrls: string;
  variants: PrefetchVariant[];
  sites: ReadonlyMap<string, string>;
}

const emptyDraft: Draft = {
  urls: "",
  hosts: "",
  tags: "",
  tagSite: null,
  sitemapUrl: "",
  maxUrls: String(SITEMAP_MAX_URLS.default),
  variants: ["desktop"],
  sites: new Map(),
};

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
  const [draft, setDraft] = React.useState<Draft>(emptyDraft);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (change: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...change }));
  const urls = lines(draft.urls);
  const hosts = hostEntries(draft.hosts);
  const tags = tagEntries(draft.tags);
  // Tag purges need the chosen site's nodes to index Cache-Tag (purge-tag-v1).
  const tagFeatures = useQuery({
    ...orpc.sites.features.queryOptions({ input: { id: draft.tagSite?.id ?? "" } }),
    enabled: type === "tag" && draft.tagSite !== null,
  });
  const tagAvailability = draft.tagSite ? tagFeatures.data?.purgeByTag : undefined;

  const blocked = (() => {
    switch (type) {
      case "site":
        return draft.sites.size === 0;
      case "host":
        return hosts.length > MAX_CACHE_TASK_HOSTS;
      case "tag":
        return (
          !draft.tagSite ||
          tags.length > MAX_CACHE_TASK_TAGS ||
          tagAvailability?.available === false
        );
      case "sitemap":
        return draft.variants.length === 0;
      case "prefetch":
        return urls.length > MAX_CACHE_TASK_URLS || draft.variants.length === 0;
      default:
        return urls.length > MAX_CACHE_TASK_URLS;
    }
  })();

  const input = (): CacheTaskCreateInput => {
    switch (type) {
      case "site":
        return { type, siteIds: [...draft.sites.keys()] };
      case "host":
        return { type, hosts };
      case "tag":
        return { type, siteIds: draft.tagSite ? [draft.tagSite.id] : [], tags };
      case "sitemap":
        return {
          type,
          urls: [draft.sitemapUrl.trim()],
          maxUrls: Number(draft.maxUrls),
          variants: draft.variants,
        };
      case "prefetch":
        return { type, urls, variants: draft.variants };
      default:
        return { type, urls };
    }
  };

  // What a submitted task clears; the site of a tag purge, the variants and the URL limit stay.
  const submitted = (): Partial<Draft> => {
    switch (type) {
      case "site":
        return { sites: new Map() };
      case "host":
        return { hosts: "" };
      case "tag":
        return { tags: "" };
      case "sitemap":
        return { sitemapUrl: "" };
      default:
        return { urls: "" };
    }
  };

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const task = await create.mutateAsync(input());
      toast.success(m.purge_submitted());
      set(submitted());
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

  const urlField = (label: string, t: UrlType) => (
    <ListField
      id={`purge-${t}`}
      label={label}
      value={draft.urls}
      count={urls.length}
      max={MAX_CACHE_TASK_URLS}
      placeholder={placeholders[t]}
      testId="purge-urls"
      onChange={(value) => set({ urls: value })}
    />
  );
  const variantsField = (
    <VariantsField value={draft.variants} onChange={(variants) => set({ variants })} />
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
            {/* Two per row on phones (the last one fills its row), wrapping pills from sm up. */}
            <TabsList className="flex w-full max-w-full flex-wrap justify-start gap-1 rounded-2xl group-data-horizontal/tabs:h-auto sm:w-fit">
              {TYPES.map((t) => (
                <TabsTrigger
                  key={t}
                  value={t}
                  className="h-8 grow basis-[calc(50%-0.125rem)] rounded-xl sm:grow-0 sm:basis-auto sm:rounded-full"
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
            <TabsContent value="host" className="pt-3">
              <ListField
                id="purge-host"
                label={m.purge_hosts()}
                value={draft.hosts}
                count={hosts.length}
                max={MAX_CACHE_TASK_HOSTS}
                placeholder={placeholders.host}
                testId="purge-hosts"
                onChange={(value) => set({ hosts: value })}
              />
            </TabsContent>
            <TabsContent value="tag" className="flex flex-col gap-4 pt-3">
              <TagSiteSelect value={draft.tagSite} onChange={(tagSite) => set({ tagSite })} />
              {tagAvailability && !tagAvailability.available ? (
                <SafetyNote
                  className="animate-in fade-in"
                  data-testid="purge-tag-unavailable"
                  data-reason={tagAvailability.reason ?? undefined}
                >
                  {unavailableReason(tagAvailability)}
                </SafetyNote>
              ) : null}
              <ListField
                id="purge-tag"
                label={m.purge_tags()}
                value={draft.tags}
                count={tags.length}
                max={MAX_CACHE_TASK_TAGS}
                placeholder={placeholders.tag}
                testId="purge-tags"
                onChange={(value) => set({ tags: value })}
              />
            </TabsContent>
            <TabsContent value="site" className="pt-3">
              <SitePicker selected={draft.sites} onChange={(sites) => set({ sites })} />
            </TabsContent>
            <TabsContent value="prefetch" className="flex flex-col gap-4 pt-3">
              {urlField(m.purge_urls(), "prefetch")}
              {variantsField}
            </TabsContent>
            <TabsContent value="sitemap" className="flex flex-col gap-4 pt-3">
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                <Field>
                  <FieldLabel htmlFor="purge-sitemap-url">{m.purge_sitemap_url()}</FieldLabel>
                  <Input
                    id="purge-sitemap-url"
                    type="url"
                    inputMode="url"
                    value={draft.sitemapUrl}
                    required
                    maxLength={2048}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(event) => set({ sitemapUrl: event.target.value })}
                    placeholder={placeholders.sitemap}
                    className="font-mono"
                    data-testid="purge-sitemap-url"
                  />
                </Field>
                <NumberField
                  id="purge-sitemap-max"
                  label={m.purge_sitemap_max()}
                  value={draft.maxUrls}
                  min={SITEMAP_MAX_URLS.min}
                  max={SITEMAP_MAX_URLS.max}
                  step={1}
                  required
                  onChange={(maxUrls) => set({ maxUrls })}
                  testId="purge-sitemap-max"
                />
              </div>
              {variantsField}
            </TabsContent>
          </Tabs>
        </CardContent>
        <CardFooter className="flex-wrap justify-end gap-3 border-t">
          {error ? (
            <FieldError className="mr-auto animate-in fade-in" data-testid="purge-error">
              {error}
            </FieldError>
          ) : null}
          <Button type="submit" disabled={pending || blocked} data-testid="purge-submit">
            {pending ? <Spinner /> : null}
            {m.purge_submit()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

/** A textarea of entries with their count against the per-task limit. */
function ListField({
  id,
  label,
  value,
  count,
  max,
  placeholder,
  testId,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  count: number;
  max: number;
  placeholder: string;
  testId: string;
  onChange: (value: string) => void;
}) {
  const over = count > max;
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <span
          className={cn(
            "text-xs tabular-nums text-muted-foreground",
            over && "font-medium text-destructive",
          )}
          data-testid="purge-count"
        >
          {formatNumber(count)} / {formatNumber(max)}
        </span>
      </div>
      <Textarea
        id={id}
        value={value}
        required
        rows={6}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-invalid={over || undefined}
        className="max-h-96 min-h-36 font-mono text-sm break-all"
        data-testid={testId}
      />
    </Field>
  );
}

/** Device variants of a prefetch; at least one. */
function VariantsField({
  value,
  onChange,
}: {
  value: PrefetchVariant[];
  onChange: (value: PrefetchVariant[]) => void;
}) {
  const none = value.length === 0;
  return (
    <FieldSet className="gap-0" data-invalid={none || undefined}>
      <FieldLegend variant="label">{m.purge_variants()}</FieldLegend>
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {prefetchVariant.options.map((variant) => (
          <Field key={variant} orientation="horizontal" className="w-auto">
            <Checkbox
              id={`purge-variant-${variant}`}
              checked={value.includes(variant)}
              aria-invalid={none || undefined}
              onCheckedChange={(checked) =>
                onChange(
                  prefetchVariant.options.filter((v) =>
                    v === variant ? checked : value.includes(v),
                  ),
                )
              }
              data-testid={`purge-variant-${variant}`}
            />
            <FieldLabel htmlFor={`purge-variant-${variant}`} className="font-normal">
              {variantLabel[variant]()}
            </FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
  );
}

/** The site of a tag purge: one of the caller's sites, searchable once there are many. */
function TagSiteSelect({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (site: { id: string; name: string }) => void;
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

  if (all.isPending) return <LoadingState className="min-h-20" />;
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
  const choices = (list.data?.items ?? []).map((site) => ({ value: site.id, label: site.name }));
  // The chosen site stays selectable while a search hides it.
  if (value && !choices.some((choice) => choice.value === value.id))
    choices.unshift({ value: value.id, label: value.name });
  return (
    <Field>
      <FieldLabel htmlFor="purge-tag-site">{m.purge_tag_site()}</FieldLabel>
      <div className={cn("grid gap-2", searchable && "sm:grid-cols-2")}>
        {searchable ? (
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={m.sites_search_placeholder()}
            aria-label={m.sites_search_placeholder()}
            data-testid="purge-tag-site-search"
          />
        ) : null}
        <Select
          value={value?.id ?? null}
          onValueChange={(id) => {
            const choice = choices.find((c) => c.value === id);
            if (choice) onChange({ id: choice.value, name: choice.label });
          }}
          items={choices}
        >
          <SelectTrigger id="purge-tag-site" className="w-full" data-testid="purge-tag-site">
            <SelectValue placeholder={m.purge_tag_site_placeholder()} />
          </SelectTrigger>
          <SelectContent>
            {choices.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{m.sites_no_match()}</p>
            ) : (
              choices.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {choice.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
      {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : null}
    </Field>
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
  // Whole-site purges list their sites; every other type what was asked for (URLs, hosts, tags).
  const targets = task.type === "site" ? task.sites.map((s) => s.name) : task.targets;
  const more = targets.length - 1;
  // URLs, hosts and tags read best in monospace; site names do not.
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
                {task.variants.map((variant) => variantLabel[variant]()).join(" / ")}
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
          <div className="grid gap-4 border-t bg-muted/30 px-4 py-3 md:grid-cols-2">
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
