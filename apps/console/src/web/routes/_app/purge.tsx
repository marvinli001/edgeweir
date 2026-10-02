import {
  type CacheTask,
  type CacheTaskCreateInput,
  type CacheTaskType,
  MAX_CACHE_TASK_HOSTS,
  MAX_CACHE_TASK_TAGS,
  MAX_CACHE_TASK_URLS,
  type PrefetchVariant,
  prefetchVariant,
  SITEMAP_MAX_URLS,
  type Site,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, DatabaseSync01Icon, GlobeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import {
  CacheTaskList,
  cacheTaskTypeLabel,
  followTasks,
  prefetchVariantLabel,
  useExpandedTasks,
} from "@/components/cache-tasks";
import { OptionSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { EmptyState, ErrorState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
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
    /** One site's tasks, and the site preselected in the form. */
    site: z.string().optional(),
    /** URLs (or prefixes) the form starts with: one, or a list. */
    urls: z.union([z.string(), z.array(z.string())]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: PurgePage,
});

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

function PurgePage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = search.page ?? 1;
  const { expanded, toggle } = useExpandedTasks();
  const site = useQuery({
    ...orpc.sites.get.queryOptions({ input: { id: search.site ?? "" } }),
    enabled: !!search.site,
  });
  const listInput = { page, pageSize: PAGE_SIZE, siteId: search.site };
  const tasks = useQuery({
    ...orpc.cacheTasks.list.queryOptions({ input: listInput }),
    placeholderData: keepPreviousData,
    // Follow tasks until every node reported.
    refetchInterval: (query) => followTasks(query.state.data),
    meta: { background: true },
  });

  return (
    <Page title={m.purge_title()}>
      <PurgeForm
        key={search.site ?? ""}
        site={site.data ? { id: site.data.id, name: site.data.name } : undefined}
        initialUrls={typeof search.urls === "string" ? [search.urls] : (search.urls ?? [])}
        listInput={{ ...listInput, page: 1 }}
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
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="purge-tasks-title" className="text-sm font-medium text-muted-foreground">
            {m.purge_tasks()}
          </h2>
          {search.site ? (
            <Badge variant="secondary" className="gap-1 pr-1" data-testid="purge-site-filter">
              {site.data?.name ?? "…"}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={m.purge_site_filter_clear()}
                onClick={() =>
                  navigate({ search: (prev) => ({ ...prev, site: undefined, page: undefined }) })
                }
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </Badge>
          ) : null}
        </div>
        <QueryView
          query={tasks}
          isEmpty={(data) => data.total === 0}
          empty={<EmptyState icon={DatabaseSync01Icon} title={m.purge_tasks_empty()} />}
        >
          {({ items, total }) => (
            <>
              <CacheTaskList tasks={items} expanded={expanded} onToggle={toggle} />
              <Pager
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
              />
            </>
          )}
        </QueryView>
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
  site,
  initialUrls,
  listInput,
  type,
  onTypeChange,
  onCreated,
}: {
  /** Preselected for whole-site and tag purges once known. */
  site?: { id: string; name: string };
  /** What the URL list starts with (read once). */
  initialUrls: string[];
  /** The first page of the task list as the page shows it. */
  listInput: { page: number; pageSize: number; siteId?: string };
  type: CacheTaskType;
  onTypeChange: (type: CacheTaskType) => void;
  onCreated: (task: CacheTask) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.cacheTasks.create.mutationOptions());
  const [draft, setDraft] = React.useState<Draft>(() => ({
    ...emptyDraft,
    urls: initialUrls.join("\n"),
  }));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const set = (change: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...change }));
  const preselected = React.useRef(false);
  React.useEffect(() => {
    if (!site || preselected.current) return;
    preselected.current = true;
    setDraft((prev) => ({ ...prev, sites: new Map([[site.id, site.name]]), tagSite: site }));
  }, [site]);
  const urls = lines(draft.urls);
  const hosts = hostEntries(draft.hosts);
  const tags = tagEntries(draft.tags);
  // Tag purges need the chosen site's nodes to index Cache-Tag (purge-tag-v1).
  const tagFeatures = useQuery({
    ...orpc.sites.features.queryOptions({ input: { id: draft.tagSite?.id ?? "" } }),
    enabled: type === "tag" && draft.tagSite !== null,
  });
  const tagAvailability = draft.tagSite ? tagFeatures.data?.purgeByTag : undefined;

  // Lists of blank lines are empty: nothing to submit.
  const blocked = (() => {
    switch (type) {
      case "site":
        return draft.sites.size === 0;
      case "host":
        return hosts.length === 0 || hosts.length > MAX_CACHE_TASK_HOSTS;
      case "tag":
        return (
          !draft.tagSite ||
          tags.length === 0 ||
          tags.length > MAX_CACHE_TASK_TAGS ||
          tagAvailability?.available === false
        );
      case "sitemap":
        return !draft.sitemapUrl.trim() || draft.variants.length === 0;
      case "prefetch":
        return (
          urls.length === 0 || urls.length > MAX_CACHE_TASK_URLS || draft.variants.length === 0
        );
      default:
        return urls.length === 0 || urls.length > MAX_CACHE_TASK_URLS;
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
      queryClient.setQueryData(orpc.cacheTasks.list.queryKey({ input: listInput }), (old) =>
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
      testId={`purge-urls-${t}`}
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
                  {cacheTaskTypeLabel[t]()}
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
                  {m.purge_tag_unavailable()}
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
              {prefetchVariantLabel[variant]()}
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

  const choices = (list.data?.items ?? []).map((site) => ({ value: site.id, label: site.name }));
  // The chosen site stays selectable while a search hides it.
  if (value && !choices.some((choice) => choice.value === value.id))
    choices.unshift({ value: value.id, label: value.name });
  return (
    <QueryView
      query={all}
      loadingClassName="min-h-20"
      isEmpty={(data) => data.total === 0}
      empty={<NoSites />}
    >
      {() => (
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
            <OptionSelect
              id="purge-tag-site"
              value={value?.id ?? null}
              options={choices}
              onChange={(id) => {
                const choice = choices.find((c) => c.value === id);
                if (choice) onChange({ id: choice.value, name: choice.label });
              }}
              placeholder={m.purge_tag_site_placeholder()}
              testId="purge-tag-site"
              empty={
                <p className="px-3 py-2 text-sm text-muted-foreground">{m.sites_no_match()}</p>
              }
            />
          </div>
          {list.isLoadingError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : null}
        </Field>
      )}
    </QueryView>
  );
}

/** Without sites there is nothing to purge: the way to create one. */
function NoSites() {
  return (
    <EmptyState icon={GlobeIcon} title={m.sites_empty_title()}>
      <Button nativeButton={false} render={<Link to="/sites" search={{ create: true }} />}>
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {m.nav_new_site()}
      </Button>
    </EmptyState>
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

  return (
    <QueryView
      query={all}
      loadingClassName="min-h-36"
      isEmpty={(data) => data.total === 0}
      empty={<NoSites />}
    >
      {() => (
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel id="purge-sites-label">{m.purge_sites()}</FieldLabel>
            <span
              className="text-xs tabular-nums text-muted-foreground"
              data-testid="purge-selected"
            >
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
            {list.isLoadingError ? (
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
      )}
    </QueryView>
  );
}
