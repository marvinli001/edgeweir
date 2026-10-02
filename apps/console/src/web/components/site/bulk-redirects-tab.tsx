import {
  BULK_REDIRECT_LIMIT,
  type BulkRedirect,
  bulkRedirect,
  type FeatureAvailability,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, FileImportIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormDialog } from "@/components/form-dialog";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { nextDraftKey, SaveBar, serializeDrafts } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

type StatusCode = BulkRedirect["statusCode"];
const STATUS_CODES: StatusCode[] = [301, 302, 307, 308];
const PAGE_SIZE = 50;

interface Draft extends BulkRedirect {
  key: number;
}
const toDraft = (redirect: BulkRedirect): Draft => ({ key: nextDraftKey(), ...redirect });

/**
 * Bulk redirects tab: a site's exact-match redirect table ("/path" on every domain or
 * "host/path"), at most 5000 entries.
 */
export function BulkRedirectsTab({ siteId }: { siteId: string }) {
  const redirects = useQuery(orpc.bulkRedirects.get.queryOptions({ input: { id: siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <Card className="animate-enter" data-testid="bulk-redirects-card">
      <CardHeader>
        <CardTitle>{m.bulk_redirects_title()}</CardTitle>
      </CardHeader>
      {redirects.isPending || features.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : redirects.isError ? (
        <CardContent>
          <ErrorState error={redirects.error} onRetry={() => void redirects.refetch()} />
        </CardContent>
      ) : features.isError ? (
        <CardContent>
          <ErrorState error={features.error} onRetry={() => void features.refetch()} />
        </CardContent>
      ) : (
        <BulkRedirectsForm
          key={redirects.dataUpdatedAt}
          siteId={siteId}
          initial={redirects.data}
          availability={features.data.rulesV2}
        />
      )}
    </Card>
  );
}

/** Keys of the entries the server would refuse: a bad source or target, or a repeated source. */
function invalidKeys(rows: Draft[]): Set<number> {
  const seen = new Map<string, number>();
  for (const row of rows) seen.set(row.source, (seen.get(row.source) ?? 0) + 1);
  return new Set(
    rows
      .filter((row) => (seen.get(row.source) ?? 0) > 1 || !bulkRedirect.safeParse(row).success)
      .map((row) => row.key),
  );
}

/**
 * Lines "source target [status]" separated by whitespace (or commas when a line has no
 * whitespace); empty lines and "#" comments are skipped. Returns the entries or the first bad
 * line (1-based).
 */
function parseLines(text: string): BulkRedirect[] | number {
  const out: BulkRedirect[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = (/\s/.test(line) ? line.split(/\s+/) : line.split(",")).map((p) => p.trim());
    const [source, target, status, ...rest] = parts;
    const statusCode = status ? Number(status) : 301;
    const parsed = bulkRedirect.safeParse({ source, target, statusCode });
    if (rest.length || !parsed.success) return index + 1;
    out.push(parsed.data);
  }
  return out;
}

function BulkRedirectsForm({
  siteId,
  initial,
  availability,
}: {
  siteId: string;
  initial: BulkRedirect[];
  availability: FeatureAvailability;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(orpc.bulkRedirects.save.mutationOptions());
  const saved = React.useMemo(() => initial.map(toDraft), [initial]);
  const savedJson = React.useMemo(() => serializeDrafts(saved), [saved]);
  const [rows, setRows] = React.useState(saved);
  const [filter, setFilter] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [importing, setImporting] = React.useState(false);
  const importKey = useOpenKey(importing);
  const [error, setError] = React.useState<string | null>(null);
  // The table waits until the cluster's nodes run it.
  const editable = availability.available;
  const dirty = serializeDrafts(rows) !== savedJson;
  const invalid = React.useMemo(() => invalidKeys(rows), [rows]);
  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? rows.filter(
        (row) =>
          row.source.toLowerCase().includes(needle) || row.target.toLowerCase().includes(needle),
      )
    : rows;
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const shown = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const patch = (key: number, change: Partial<BulkRedirect>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const add = () => {
    setFilter("");
    setPage(1);
    setRows([
      { key: nextDraftKey(), source: "/", target: "/", statusCode: 301, preserveQuery: false },
      ...rows,
    ]);
  };
  const actions = editable ? (
    <>
      <Button
        type="button"
        variant="outline"
        onClick={() => setImporting(true)}
        data-testid="bulk-redirects-import"
      >
        <HugeiconsIcon icon={FileImportIcon} strokeWidth={2} />
        {m.bulk_redirects_import()}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={rows.length >= BULK_REDIRECT_LIMIT}
        onClick={add}
        data-testid="bulk-redirects-add"
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
        {m.bulk_redirects_add()}
      </Button>
    </>
  ) : null;

  return (
    <>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          if (invalid.size) {
            // Show the first entry to fix.
            setFilter("");
            setPage(Math.floor(rows.findIndex((row) => invalid.has(row.key)) / PAGE_SIZE) + 1);
            setError(m.bulk_redirects_invalid({ count: formatNumber(invalid.size) }));
            return;
          }
          try {
            const result = await mutation.mutateAsync({
              id: siteId,
              redirects: rows.map(({ key: _key, ...redirect }) => redirect),
            });
            queryClient.setQueryData(
              orpc.bulkRedirects.get.queryKey({ input: { id: siteId } }),
              result,
            );
            toast.success(m.common_saved());
          } catch (err) {
            setError(errorMessage(err));
          }
        }}
      >
        <CardContent className="flex flex-col gap-4">
          {availability.available ? null : (
            <SafetyNote className="animate-in fade-in" data-testid="bulk-redirects-unavailable">
              {m.rules_v2_unavailable()}
            </SafetyNote>
          )}
          {rows.length === 0 ? (
            <EmptyState title={m.bulk_redirects_empty()}>
              {actions ? (
                <div className="flex flex-wrap justify-center gap-2">{actions}</div>
              ) : null}
            </EmptyState>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <InputGroup className="w-full sm:w-64">
                  <InputGroupAddon>
                    <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={filter}
                    onChange={(event) => {
                      setFilter(event.target.value);
                      setPage(1);
                    }}
                    placeholder={m.bulk_redirects_filter()}
                    aria-label={m.bulk_redirects_filter()}
                    data-testid="bulk-redirects-filter"
                  />
                </InputGroup>
                <span
                  className="text-sm text-muted-foreground tabular-nums sm:mr-auto"
                  data-testid="bulk-redirects-count"
                >
                  {formatNumber(rows.length)} / {formatNumber(BULK_REDIRECT_LIMIT)}
                </span>
                {actions}
              </div>
              {shown.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  {m.bulk_redirects_no_match()}
                </p>
              ) : (
                <div className="flex flex-col rounded-2xl border">
                  <div
                    aria-hidden
                    className="hidden gap-2 border-b px-3 py-2 text-xs font-medium text-muted-foreground sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_5.5rem_2rem]"
                  >
                    <span>{m.bulk_redirects_source()}</span>
                    <span>{m.rules_target()}</span>
                    <span>{m.rules_status()}</span>
                    <span>{m.rules_preserve_query()}</span>
                  </div>
                  <ul className="divide-y" data-testid="bulk-redirect-list">
                    {shown.map((row, index) => (
                      <RedirectRow
                        key={row.key}
                        row={row}
                        index={index}
                        invalid={invalid.has(row.key)}
                        editable={editable}
                        onChange={(change) => patch(row.key, change)}
                        onRemove={() => setRows(rows.filter((r) => r.key !== row.key))}
                      />
                    ))}
                  </ul>
                </div>
              )}
              <Pager
                page={current}
                pageSize={PAGE_SIZE}
                total={visible.length}
                onPageChange={setPage}
              />
            </>
          )}
        </CardContent>
        <SaveBar
          dirty={dirty && editable}
          pending={mutation.isPending}
          error={error}
          testId="bulk-redirects-save"
        />
      </form>
      {/* Outside the form: React bubbles the dialog's submit through the portal. */}
      <ImportDialog
        key={importKey}
        open={importing}
        onOpenChange={setImporting}
        onImport={(redirects, replace) => {
          const sources = new Set(redirects.map((redirect) => redirect.source));
          const merged = [
            ...redirects.map(toDraft),
            ...(replace ? [] : rows.filter((row) => !sources.has(row.source))),
          ];
          if (merged.length > BULK_REDIRECT_LIMIT)
            throw new Error(m.bulk_redirects_limit({ limit: formatNumber(BULK_REDIRECT_LIMIT) }));
          setRows(merged);
          setFilter("");
          setPage(1);
          setImporting(false);
          toast.success(m.bulk_redirects_imported({ count: formatNumber(redirects.length) }));
        }}
      />
    </>
  );
}

function RedirectRow({
  row,
  index,
  invalid,
  editable,
  onChange,
  onRemove,
}: {
  row: Draft;
  index: number;
  invalid: boolean;
  editable: boolean;
  onChange: (change: Partial<BulkRedirect>) => void;
  onRemove: () => void;
}) {
  const id = (name: string) => `bulk-redirect-${name}-${row.key}`;
  const statuses = STATUS_CODES.map((code) => ({ value: String(code), label: String(code) }));
  return (
    <li
      className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 p-3 animate-enter sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem_5.5rem_2rem]"
      style={{ animationDelay: `${Math.min(index, 12) * 20}ms` }}
      data-testid="bulk-redirect-row"
      data-source={row.source}
    >
      <Input
        id={id("source")}
        aria-label={m.bulk_redirects_source()}
        value={row.source}
        maxLength={512}
        disabled={!editable}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange({ source: event.target.value })}
        className="col-span-3 font-mono sm:col-span-1"
        data-testid="bulk-redirect-source"
      />
      <Input
        id={id("target")}
        aria-label={m.rules_target()}
        value={row.target}
        maxLength={1024}
        disabled={!editable}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange({ target: event.target.value })}
        className="col-span-3 font-mono sm:col-span-1"
        data-testid="bulk-redirect-target"
      />
      <Select
        value={String(row.statusCode)}
        onValueChange={(code) => {
          if (code) onChange({ statusCode: Number(code) as StatusCode });
        }}
        items={statuses}
        disabled={!editable}
      >
        <SelectTrigger
          className="w-full"
          aria-label={m.rules_status()}
          data-testid="bulk-redirect-status"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {statuses.map((status) => (
            <SelectItem key={status.value} value={status.value}>
              {status.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Field orientation="horizontal" className="w-auto gap-2">
        <Switch
          id={id("query")}
          checked={row.preserveQuery}
          disabled={!editable}
          onCheckedChange={(preserveQuery) => onChange({ preserveQuery })}
          data-testid="bulk-redirect-preserve-query"
        />
        <FieldLabel htmlFor={id("query")} className="text-xs text-muted-foreground sm:sr-only">
          {m.rules_preserve_query()}
        </FieldLabel>
      </Field>
      {editable ? (
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={m.common_remove()}
          onClick={onRemove}
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        </Button>
      ) : (
        <span />
      )}
    </li>
  );
}

/** Pasted lines merged into the table (same sources replaced) or replacing it. */
function ImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (redirects: BulkRedirect[], replace: boolean) => void;
}) {
  const [replace, setReplace] = React.useState(false);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReplace(false);
        onOpenChange(next);
      }}
      title={m.bulk_redirects_import_title()}
      submitLabel={m.bulk_redirects_import()}
      submitTestId="bulk-redirects-import-submit"
      onSubmit={async (data) => {
        const result = parseLines(String(data.get("lines") ?? ""));
        if (typeof result === "number")
          throw new Error(m.bulk_redirects_import_invalid({ line: formatNumber(result) }));
        onImport(result, replace);
      }}
    >
      <Field>
        <FieldLabel htmlFor="bulk-redirects-lines">{m.bulk_redirects_import_lines()}</FieldLabel>
        <Textarea
          id="bulk-redirects-lines"
          name="lines"
          required
          rows={8}
          spellCheck={false}
          placeholder={"/old /new 301\nexample.com/a https://example.com/b 302"}
          className="max-h-80 min-h-40 font-mono"
          data-testid="bulk-redirects-lines"
        />
      </Field>
      <SwitchField
        id="bulk-redirects-replace"
        label={m.bulk_redirects_import_replace()}
        checked={replace}
        onCheckedChange={setReplace}
        className="self-start"
        testId="bulk-redirects-replace"
      />
    </FormDialog>
  );
}
