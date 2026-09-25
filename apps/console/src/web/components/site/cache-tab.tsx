import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  type UniqueIdentifier,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CacheRule, CacheSettings, Site } from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowDown01Icon,
  Delete02Icon,
  DragDropVerticalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { NumberField, SwitchField } from "@/components/site/fields";
import {
  nextDraftKey,
  SaveBar,
  serializeDrafts,
  splitList,
  useSaveSite,
} from "@/components/site/save-site";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Cache tab: ordered cache rules, and how cache keys are built. Each card saves on its own. */
export function CacheTab({ site }: { site: Site }) {
  return (
    <div className="flex flex-col gap-4">
      {/* Keyed by their own data, so saving one card keeps unsaved edits in the other. */}
      <CacheRulesCard key={JSON.stringify(site.cacheRules)} site={site} />
      <CacheKeyCard key={JSON.stringify(site.cacheSettings)} site={site} />
    </div>
  );
}

type Action = CacheRule["action"];

interface RuleDraft {
  key: number;
  prefixes: string;
  paths: string;
  extensions: string;
  statusCodes: string;
  /** Size bounds are edited in KB (1024 bytes); empty means unbounded. */
  minSizeKb: string;
  maxSizeKb: string;
  action: Action;
  ttl: string;
  respect: boolean;
  staleWhileRevalidate: string;
  staleIfError: string;
  cacheAuthorized: boolean;
}

const bytesToKb = (bytes: number) => (bytes > 0 ? String(bytes / 1024) : "");
const kbToBytes = (kb: string) => {
  const value = Number(kb);
  return kb.trim() && Number.isFinite(value) && value > 0 ? Math.round(value * 1024) : 0;
};
const secondsOrEmpty = (seconds: number) => (seconds > 0 ? String(seconds) : "");
const toSeconds = (value: string) => {
  const n = Number(value);
  return value.trim() && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** How many of the conditions behind "more" are set, shown on its toggle. */
const moreCount = (r: RuleDraft) =>
  [r.paths, r.statusCodes, r.minSizeKb, r.maxSizeKb, r.staleWhileRevalidate, r.staleIfError].filter(
    (v) => v.trim() !== "",
  ).length + (r.cacheAuthorized ? 1 : 0);

const toDraft = (r: CacheRule): RuleDraft => ({
  key: nextDraftKey(),
  prefixes: r.pathPrefixes.join(", "),
  paths: r.paths.join(", "),
  extensions: r.extensions.join(", "),
  statusCodes: r.statusCodes.join(", "),
  minSizeKb: bytesToKb(r.minSizeBytes),
  maxSizeKb: bytesToKb(r.maxSizeBytes),
  action: r.action,
  ttl: String(r.edgeTtlSeconds),
  respect: r.originCacheControl === "respect",
  staleWhileRevalidate: secondsOrEmpty(r.staleWhileRevalidateSeconds),
  staleIfError: secondsOrEmpty(r.staleIfErrorSeconds),
  cacheAuthorized: r.cacheAuthorized,
});

const newRule = (): RuleDraft => ({
  key: nextDraftKey(),
  prefixes: "/",
  paths: "",
  extensions: "",
  statusCodes: "",
  minSizeKb: "",
  maxSizeKb: "",
  action: "cache",
  ttl: "3600",
  respect: false,
  staleWhileRevalidate: "",
  staleIfError: "",
  cacheAuthorized: false,
});

/** Rows only move up and down. */
const restrictToVerticalAxis: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function CacheRulesCard({ site }: { site: Site }) {
  const initial = React.useMemo(() => site.cacheRules.map(toDraft), [site.cacheRules]);
  const [rows, setRows] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const dirty = serializeDrafts(rows) !== serializeDrafts(initial);
  const patch = (key: number, change: Partial<RuleDraft>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const reducedMotion = useReducedMotion();
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Keyboard moves scroll the page along; smoothly unless motion is reduced.
      scrollBehavior: reducedMotion ? "auto" : "smooth",
    }),
  );
  const position = (id: UniqueIdentifier) => rows.findIndex((r) => r.key === id) + 1;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setRows((current) => {
      const from = current.findIndex((r) => r.key === active.id);
      const to = current.findIndex((r) => r.key === over.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  };

  return (
    <Card data-testid="cache-rules-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            cacheRules: rows.map((r, index) => ({
              // Rules match in list order.
              priority: (index + 1) * 10,
              pathPrefixes: splitList(r.prefixes),
              paths: splitList(r.paths),
              extensions: splitList(r.extensions),
              statusCodes: splitList(r.statusCodes).map(Number),
              minSizeBytes: kbToBytes(r.minSizeKb),
              maxSizeBytes: kbToBytes(r.maxSizeKb),
              action: r.action,
              edgeTtlSeconds: Number(r.ttl) || 0,
              originCacheControl: r.respect ? "respect" : "override",
              staleWhileRevalidateSeconds: toSeconds(r.staleWhileRevalidate),
              staleIfErrorSeconds: toSeconds(r.staleIfError),
              cacheAuthorized: r.cacheAuthorized,
            })),
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_rules_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.sites_no_cache_rules()}</p>
          ) : null}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={onDragEnd}
            accessibility={{
              screenReaderInstructions: { draggable: m.site_rule_drag_instructions() },
              announcements: {
                onDragStart: ({ active }) => m.site_rule_drag_start({ index: position(active.id) }),
                onDragOver: ({ active, over }) =>
                  over
                    ? m.site_rule_drag_over({
                        index: position(active.id),
                        position: position(over.id),
                      })
                    : undefined,
                onDragEnd: ({ active, over }) =>
                  over
                    ? m.site_rule_drag_end({
                        index: position(active.id),
                        position: position(over.id),
                      })
                    : m.site_rule_drag_cancel({ index: position(active.id) }),
                onDragCancel: ({ active }) =>
                  m.site_rule_drag_cancel({ index: position(active.id) }),
              },
            }}
          >
            <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
              <ol className="flex flex-col gap-3" data-testid="cache-rule-list">
                {rows.map((row, index) => (
                  <SortableRule
                    key={row.key}
                    row={row}
                    index={index}
                    onChange={(change) => patch(row.key, change)}
                    onRemove={() => setRows(rows.filter((r) => r.key !== row.key))}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() => setRows([...rows, newRule()])}
            data-testid="cache-rule-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.site_rule_add()}
          </Button>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="cache-save" />
      </form>
    </Card>
  );
}

function SortableRule({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: RuleDraft;
  index: number;
  onChange: (change: Partial<RuleDraft>) => void;
  onRemove: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.key,
    attributes: { roleDescription: m.site_rule_role() },
    transition: reducedMotion ? null : undefined,
  });
  const [open, setOpen] = React.useState(() => moreCount(row) > 0);
  const hidden = moreCount(row);
  const bypass = row.action === "bypass";
  const id = (name: string) => `rule-${name}-${row.key}`;
  const actions = [
    { label: m.site_rule_cache(), value: "cache" },
    { label: m.site_rule_bypass(), value: "bypass" },
  ];

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative", isDragging && "z-10")}
      data-testid="cache-rule-row"
    >
      <div className="animate-enter" style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}>
        <Collapsible
          open={open}
          onOpenChange={setOpen}
          className={cn(
            "flex flex-col gap-3 rounded-2xl border bg-card p-3 transition-shadow",
            isDragging && "shadow-lg ring-2 ring-ring/40",
          )}
        >
          <div className="-mt-1 -ml-1 flex min-h-8 items-center gap-1">
            <Button
              ref={setActivatorNodeRef}
              type="button"
              size="icon-sm"
              variant="ghost"
              className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
              aria-label={m.site_rule_drag({ index: index + 1 })}
              data-testid="cache-rule-handle"
              {...attributes}
              {...listeners}
            >
              <HugeiconsIcon icon={DragDropVerticalIcon} strokeWidth={2} />
            </Button>
            <span className="text-xs font-medium text-muted-foreground">
              {m.site_rule_number({ index: index + 1 })}
            </span>
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="ml-auto text-muted-foreground"
                  data-testid="cache-rule-more"
                />
              }
            >
              {m.site_rule_more()}
              {hidden > 0 ? (
                <Badge variant="secondary" className="tabular-nums">
                  {hidden}
                </Badge>
              ) : null}
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className={cn(
                  "transition-transform motion-reduce:transition-none",
                  open && "rotate-180",
                )}
              />
            </CollapsibleTrigger>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label={m.common_remove()}
              onClick={onRemove}
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-[1fr_1fr_8rem_7rem_auto]">
            <Field>
              <FieldLabel htmlFor={id("prefix")}>{m.site_form_cache_prefix()}</FieldLabel>
              <Input
                id={id("prefix")}
                value={row.prefixes}
                onChange={(event) => onChange({ prefixes: event.target.value })}
                placeholder="/static/, /img/"
                data-testid="cache-rule-prefixes"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={id("ext")}>{m.site_rule_extensions()}</FieldLabel>
              <Input
                id={id("ext")}
                value={row.extensions}
                onChange={(event) => onChange({ extensions: event.target.value })}
                placeholder="css, js, png"
              />
            </Field>
            <Field>
              <FieldLabel>{m.site_rule_action()}</FieldLabel>
              <Select
                value={row.action}
                onValueChange={(v) => v && onChange({ action: v as Action })}
                items={actions}
              >
                <SelectTrigger className="w-full" data-testid="cache-rule-action">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {actions.map((a) => (
                    <SelectItem key={a.value} value={a.value}>
                      {a.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <NumberField
              id={id("ttl")}
              label={m.site_form_cache_ttl()}
              value={row.ttl}
              min={0}
              max={31536000}
              disabled={bypass}
              onChange={(ttl) => onChange({ ttl })}
            />
            <SwitchField
              className="col-span-2 lg:col-span-1"
              id={id("respect")}
              label={m.site_rule_respect()}
              checked={row.respect}
              disabled={bypass}
              onCheckedChange={(respect) => onChange({ respect })}
            />
          </div>
          <CollapsibleContent className="animate-in fade-in duration-300 motion-reduce:animate-none">
            <div className="grid gap-3 border-t pt-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field>
                <FieldLabel htmlFor={id("paths")}>{m.site_rule_paths()}</FieldLabel>
                <Input
                  id={id("paths")}
                  value={row.paths}
                  onChange={(event) => onChange({ paths: event.target.value })}
                  placeholder="/index.html, /robots.txt"
                  data-testid="cache-rule-paths"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("status")}>{m.site_rule_status_codes()}</FieldLabel>
                <Input
                  id={id("status")}
                  value={row.statusCodes}
                  inputMode="numeric"
                  pattern="[0-9,\s]*"
                  onChange={(event) => onChange({ statusCodes: event.target.value })}
                  placeholder="200, 206, 301"
                  data-testid="cache-rule-status"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <NumberField
                  id={id("min-size")}
                  label={m.site_rule_min_size()}
                  value={row.minSizeKb}
                  min={0}
                  step="any"
                  placeholder={m.site_rule_no_limit()}
                  onChange={(minSizeKb) => onChange({ minSizeKb })}
                />
                <NumberField
                  id={id("max-size")}
                  label={m.site_rule_max_size()}
                  value={row.maxSizeKb}
                  min={0}
                  step="any"
                  placeholder={m.site_rule_no_limit()}
                  onChange={(maxSizeKb) => onChange({ maxSizeKb })}
                />
              </div>
              <NumberField
                id={id("swr")}
                label={m.site_rule_stale_while_revalidate()}
                value={row.staleWhileRevalidate}
                min={0}
                max={2592000}
                placeholder={m.site_rule_off()}
                disabled={bypass}
                onChange={(staleWhileRevalidate) => onChange({ staleWhileRevalidate })}
              />
              <NumberField
                id={id("sie")}
                label={m.site_rule_stale_if_error()}
                value={row.staleIfError}
                min={0}
                max={2592000}
                placeholder={m.site_rule_off()}
                disabled={bypass}
                onChange={(staleIfError) => onChange({ staleIfError })}
              />
              <SwitchField
                className="sm:col-span-2 lg:col-span-3"
                id={id("authorized")}
                label={m.site_rule_cache_authorized()}
                checked={row.cacheAuthorized}
                disabled={bypass}
                onCheckedChange={(cacheAuthorized) => onChange({ cacheAuthorized })}
                testId="cache-rule-authorized"
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </li>
  );
}

type QueryMode = CacheSettings["cacheKey"]["query"];

interface KeyDraft {
  query: QueryMode;
  queryParams: string;
  sortQuery: boolean;
  headers: string;
  cookies: string;
  deviceType: boolean;
  includeHost: boolean;
  rangeSlice: boolean;
}

function CacheKeyCard({ site }: { site: Site }) {
  const { cacheKey, rangeSlice } = site.cacheSettings;
  const initial = React.useMemo<KeyDraft>(
    () => ({
      query: cacheKey.query,
      queryParams: cacheKey.queryParams.join(", "),
      sortQuery: cacheKey.sortQuery,
      headers: cacheKey.headers.join(", "),
      cookies: cacheKey.cookies.join(", "),
      deviceType: cacheKey.deviceType,
      includeHost: cacheKey.includeHost,
      rangeSlice,
    }),
    [cacheKey, rangeSlice],
  );
  const [draft, setDraft] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (change: Partial<KeyDraft>) => setDraft({ ...draft, ...change });
  const modes: { label: string; value: QueryMode }[] = [
    { label: m.site_cache_key_query_all(), value: "all" },
    { label: m.site_cache_key_query_ignore(), value: "ignore" },
    { label: m.site_cache_key_query_include(), value: "include" },
  ];

  return (
    <Card className="animate-enter" style={{ animationDelay: "80ms" }} data-testid="cache-key-card">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            cacheSettings: {
              cacheKey: {
                query: draft.query,
                queryParams: splitList(draft.queryParams),
                sortQuery: draft.sortQuery,
                headers: splitList(draft.headers),
                cookies: splitList(draft.cookies),
                deviceType: draft.deviceType,
                includeHost: draft.includeHost,
              },
              rangeSlice: draft.rangeSlice,
            },
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_cache_key_title()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[12rem_1fr_auto]">
            <Field>
              <FieldLabel>{m.site_cache_key_query()}</FieldLabel>
              <Select
                value={draft.query}
                onValueChange={(v) => v && set({ query: v as QueryMode })}
                items={modes}
              >
                <SelectTrigger className="w-full" data-testid="cache-key-query">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modes.map((mode) => (
                    <SelectItem key={mode.value} value={mode.value}>
                      {mode.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field data-disabled={draft.query !== "include" || undefined}>
              <FieldLabel htmlFor="cache-key-params">{m.site_cache_key_params()}</FieldLabel>
              <Input
                id="cache-key-params"
                value={draft.queryParams}
                disabled={draft.query !== "include"}
                required={draft.query === "include"}
                onChange={(event) => set({ queryParams: event.target.value })}
                placeholder="id, page, lang"
                data-testid="cache-key-params"
              />
            </Field>
            <SwitchField
              id="cache-key-sort"
              label={m.site_cache_key_sort()}
              checked={draft.sortQuery}
              disabled={draft.query === "ignore"}
              onCheckedChange={(sortQuery) => set({ sortQuery })}
              testId="cache-key-sort"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="cache-key-headers">{m.site_cache_key_headers()}</FieldLabel>
              <Input
                id="cache-key-headers"
                value={draft.headers}
                onChange={(event) => set({ headers: event.target.value })}
                placeholder="Accept-Language, X-Version"
                data-testid="cache-key-headers"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="cache-key-cookies">{m.site_cache_key_cookies()}</FieldLabel>
              <Input
                id="cache-key-cookies"
                value={draft.cookies}
                onChange={(event) => set({ cookies: event.target.value })}
                placeholder="lang, currency"
                data-testid="cache-key-cookies"
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-3 pt-1">
            <SwitchField
              id="cache-key-device"
              label={m.site_cache_key_device()}
              checked={draft.deviceType}
              onCheckedChange={(deviceType) => set({ deviceType })}
              testId="cache-key-device"
            />
            <SwitchField
              id="cache-key-host"
              label={m.site_cache_key_host()}
              checked={draft.includeHost}
              onCheckedChange={(includeHost) => set({ includeHost })}
              testId="cache-key-host"
            />
            <SwitchField
              id="cache-range-slice"
              label={m.site_cache_range_slice()}
              checked={draft.rangeSlice}
              onCheckedChange={(rangeSlice) => set({ rangeSlice })}
              testId="cache-range-slice"
            />
          </div>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="cache-key-save" />
      </form>
    </Card>
  );
}
