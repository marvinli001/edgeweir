import type { LogQuery } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

const localTime = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export function LogsTab({ siteId }: { siteId: string }) {
  const settings = useQuery(orpc.logs.settings.queryOptions({ input: { siteId } }));
  const cache = useQueryClient();
  const save = useMutation(
    orpc.logs.configure.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries();
        toast.success(m.common_saved());
      },
    }),
  );
  const [filters, setFilters] = React.useState(() => ({
    from: localTime(new Date(Date.now() - 3600000)),
    to: localTime(new Date(Date.now() + 60000)),
    status: "",
    ip: "",
    path: "",
  }));
  const [query, setQuery] = React.useState<LogQuery>(() => ({
    siteId,
    from: new Date(Date.now() - 3600000).toISOString(),
    to: new Date(Date.now() + 60000).toISOString(),
    ip: "",
    path: "",
    limit: 100,
  }));
  const logs = useQuery(orpc.logs.query.queryOptions({ input: query }));
  // The JA4 column appears when an entry carries a fingerprint (the site records it).
  const withJa4 = !!logs.data?.entries.some((entry) => entry.ja4);
  // The CRS column appears when an entry matched CRS rules.
  const withWaf = !!logs.data?.entries.some(
    (entry) => entry.wafRuleIds.length > 0 || entry.wafBlocked,
  );
  const exporter = useAction();
  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardContent className="space-y-4 pt-6">
          {settings.isPending ? (
            <LoadingState />
          ) : settings.isError ? (
            <ErrorState error={settings.error} onRetry={() => void settings.refetch()} />
          ) : (
            <FormSelect
              id="logSampleRate"
              label={m.logs_sampling()}
              value={String(settings.data.sampleRate)}
              disabled={save.isPending}
              options={[0, 100, 1000, 10000].map((rate) => ({
                value: String(rate),
                label: rate === 0 ? m.logs_disabled() : m.logs_percent({ value: rate / 100 }),
              }))}
              onChange={(sampleRate) => save.mutate({ siteId, sampleRate: Number(sampleRate) })}
            />
          )}
          {save.isError && <ErrorState error={save.error} />}
          <SafetyNote>{m.logs_privacy()}</SafetyNote>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-5 pt-6">
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              const from = new Date(filters.from),
                to = new Date(filters.to);
              if (
                !Number.isFinite(from.getTime()) ||
                !Number.isFinite(to.getTime()) ||
                from >= to
              ) {
                toast.error(m.logs_invalid_time());
                return;
              }
              setQuery({
                siteId,
                from: from.toISOString(),
                to: to.toISOString(),
                status: filters.status ? Number(filters.status) : undefined,
                ip: filters.ip,
                path: filters.path,
                limit: 100,
              });
            }}
          >
            {(
              [
                ["from", m.logs_from(), "datetime-local"],
                ["to", m.logs_to(), "datetime-local"],
                ["status", m.logs_status(), "number"],
                ["ip", m.logs_ip(), "text"],
                ["path", m.logs_path(), "text"],
              ] as const
            ).map(([key, label, type]) => (
              <Field key={key}>
                <FieldLabel htmlFor={`log-${key}`}>{label}</FieldLabel>
                <Input
                  id={`log-${key}`}
                  type={type}
                  value={filters[key]}
                  min={key === "status" ? 100 : undefined}
                  max={key === "status" ? 599 : undefined}
                  maxLength={key === "path" ? 2048 : 64}
                  required={key === "from" || key === "to"}
                  onChange={(event) => setFilters({ ...filters, [key]: event.target.value })}
                />
              </Field>
            ))}
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={logs.isFetching}>
                {logs.isFetching && <Spinner />}
                {m.logs_search()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={exporter.pending}
                onClick={async () => {
                  try {
                    const output = await exporter.run(() =>
                      client.logs.export({ ...query, limit: 1000 }),
                    );
                    const url = URL.createObjectURL(
                      new Blob(["\uFEFF", output.csv], { type: "text/csv;charset=utf-8" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `edgeweir-logs-${siteId}.csv`;
                    link.click();
                    URL.revokeObjectURL(url);
                    if (output.truncated) toast.info(m.logs_export_limit());
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                {exporter.pending && <Spinner />}
                {m.logs_export()}
              </Button>
            </div>
          </form>
          {logs.isPending ? (
            <LoadingState />
          ) : logs.isError ? (
            <ErrorState error={logs.error} onRetry={() => void logs.refetch()} />
          ) : logs.data.entries.length === 0 ? (
            <EmptyState title={m.logs_empty()} />
          ) : (
            <>
              {logs.data.truncated && <SafetyNote>{m.logs_query_limit()}</SafetyNote>}
              <div className="max-w-full overflow-x-auto" data-testid="logs-table">
                <table className="w-full min-w-[60rem] text-left text-sm">
                  <thead>
                    <tr className="border-b text-muted-foreground">
                      {[
                        m.logs_time(),
                        m.logs_ip(),
                        m.logs_request(),
                        m.logs_status(),
                        m.logs_bytes(),
                        m.logs_duration(),
                        m.logs_cache(),
                        ...(withJa4 ? [m.logs_ja4()] : []),
                        ...(withWaf ? [m.logs_waf()] : []),
                      ].map((label) => (
                        <th key={label} className="whitespace-nowrap p-3 font-medium">
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logs.data.entries.map((row) => (
                      <tr key={row.id} className="border-b last:border-0">
                        <td className="whitespace-nowrap p-3 tabular-nums">
                          {new Date(row.time).toLocaleString()}
                        </td>
                        <td className="whitespace-nowrap p-3 font-mono text-xs">{row.clientIp}</td>
                        <td className="min-w-64 max-w-96 p-3">
                          <div className="break-all font-mono text-xs">
                            {row.method} {row.host}
                            {row.path}
                          </div>
                        </td>
                        <td className="p-3 tabular-nums">{row.status}</td>
                        <td className="p-3 tabular-nums">{row.bytesSent}</td>
                        <td className="p-3 tabular-nums">{row.durationMs}</td>
                        <td className="p-3">{row.cacheStatus}</td>
                        {withJa4 ? (
                          <td
                            className="whitespace-nowrap p-3 font-mono text-xs"
                            data-testid="log-ja4"
                          >
                            {row.ja4}
                          </td>
                        ) : null}
                        {withWaf ? (
                          <td className="min-w-40 p-3" data-testid="log-waf">
                            <div className="flex flex-wrap items-center gap-1">
                              {row.wafBlocked ? (
                                <Badge variant="destructive" data-testid="log-waf-blocked">
                                  {m.logs_waf_blocked()}
                                </Badge>
                              ) : null}
                              {row.wafRuleIds.map((id) => (
                                <span
                                  key={id}
                                  className="font-mono text-xs tabular-nums"
                                  data-testid="log-waf-rule"
                                >
                                  {id}
                                </span>
                              ))}
                            </div>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
