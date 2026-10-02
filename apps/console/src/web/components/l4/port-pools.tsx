import type { ClusterPortPools, PortPoolProtocol } from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  PlugSocketIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { L4NodesWarning } from "@/components/l4/common";
import { nextDraftKey, serializeDrafts } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { m } from "@/lib/i18n";
import { apiError, POOL_PROTOCOLS } from "@/lib/l4";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const PORT_MIN = 1024;
const PORT_MAX = 65535;
const MAX_POOLS = 64;

interface PoolDraft {
  key: number;
  protocol: PortPoolProtocol;
  from: string;
  to: string;
}

const toDrafts = (pools: ClusterPortPools["pools"]) =>
  pools.map<PoolDraft>((pool) => ({
    key: nextDraftKey(),
    protocol: pool.protocol,
    from: String(pool.from),
    to: String(pool.to),
  }));

/** The cluster's port pools (the cluster page's port pools tab). */
export function PortPoolsSection({
  clusterId,
  clusterName,
}: {
  clusterId: string;
  clusterName: string;
}) {
  const pools = useQuery(orpc.clusters.portPools.queryOptions({ input: { clusterId } }));
  if (pools.isPending) return <LoadingState />;
  if (pools.isLoadingError)
    return <ErrorState error={pools.error} onRetry={() => pools.refetch()} />;
  return (
    <div className="flex flex-col gap-4">
      <L4NodesWarning cluster={clusterName} nodes={pools.data.nodesWithoutL4} />
      {/* Keyed by the saved pools, so a save resets the drafts to what the server stored. */}
      <PortPoolsCard key={JSON.stringify(pools.data.pools)} data={pools.data} />
    </div>
  );
}

/**
 * Pools a refusal names: overlapping pairs ("20000-20010/tcp, 20005-20020/both") or the pools
 * holding a reserved port.
 */
function refusedPools(error: unknown, rows: PoolDraft[]): Set<number> {
  const { code, data } = apiError(error);
  const keys = new Set<number>();
  if (code === "L4_PORT_POOL_OVERLAP" && typeof data.pools === "string") {
    for (const label of data.pools.split(/,\s*/)) {
      const match = /^(\d+)-(\d+)\/(tcp|udp|both)$/.exec(label.trim());
      if (!match) continue;
      for (const row of rows)
        if (row.from === match[1] && row.to === match[2] && row.protocol === match[3])
          keys.add(row.key);
    }
  }
  if (code === "L4_PORT_RESERVED" && typeof data.port === "number") {
    for (const row of rows)
      if (Number(row.from) <= data.port && data.port <= Number(row.to)) keys.add(row.key);
  }
  return keys;
}

function PortPoolsCard({ data }: { data: ClusterPortPools }) {
  const queryClient = useQueryClient();
  const initial = React.useMemo(() => toDrafts(data.pools), [data.pools]);
  const [rows, setRows] = React.useState(initial);
  // The last refusal and the rows it named; any edit clears it.
  const [refusal, setRefusal] = React.useState<{ message: string; keys: Set<number> } | null>(null);
  const save = useMutation(orpc.clusters.setPortPools.mutationOptions());
  const dirty = serializeDrafts(rows) !== serializeDrafts(initial);
  const reversed = rows.filter((r) => r.from && r.to && Number(r.from) > Number(r.to));
  const edit = (next: PoolDraft[]) => {
    setRows(next);
    setRefusal(null);
  };
  const patch = (key: number, change: Partial<PoolDraft>) =>
    edit(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const add = () => edit([...rows, { key: nextDraftKey(), protocol: "tcp", from: "", to: "" }]);

  return (
    <Card data-testid="port-pools">
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={async (event) => {
          event.preventDefault();
          setRefusal(null);
          try {
            const result = await save.mutateAsync({
              clusterId: data.clusterId,
              pools: rows.map((r) => ({
                protocol: r.protocol,
                from: Number(r.from),
                to: Number(r.to),
              })),
            });
            queryClient.setQueryData(
              orpc.clusters.portPools.queryKey({ input: { clusterId: data.clusterId } }),
              result,
            );
            toast.success(m.common_saved());
          } catch (error) {
            setRefusal({ message: errorMessage(error), keys: refusedPools(error, rows) });
          }
        }}
      >
        <CardHeader className="flex flex-row flex-wrap items-center gap-2">
          <CardTitle className="flex-1">{m.l4_pools_title()}</CardTitle>
          <Button
            size="sm"
            variant="ghost"
            nativeButton={false}
            render={<Link to="/l4" search={{ cluster: data.clusterId }} />}
            data-testid="port-pools-apps"
          >
            {m.l4_title()}
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div
            className="flex flex-wrap items-center gap-2 text-sm"
            data-testid="port-pools-reserved"
          >
            <span className="text-muted-foreground">{m.l4_reserved_ports()}</span>
            {data.reservedPorts.map((port) => (
              <Badge key={port} variant="outline" className="font-mono" data-port={port}>
                {port}
              </Badge>
            ))}
          </div>
          {rows.length === 0 ? (
            <EmptyState icon={PlugSocketIcon} title={m.l4_pools_empty()}>
              <Button type="button" onClick={add} data-testid="port-pool-add">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.l4_pool_add()}
              </Button>
            </EmptyState>
          ) : (
            <>
              <ol className="flex flex-col gap-3">
                {rows.map((row, index) => (
                  <PoolRow
                    key={row.key}
                    row={row}
                    index={index}
                    invalid={refusal?.keys.has(row.key) === true || reversed.includes(row)}
                    onChange={(change) => patch(row.key, change)}
                    onRemove={() => edit(rows.filter((r) => r.key !== row.key))}
                  />
                ))}
              </ol>
              <Button
                type="button"
                variant="outline"
                className="self-start"
                disabled={rows.length >= MAX_POOLS}
                onClick={add}
                data-testid="port-pool-add"
              >
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.l4_pool_add()}
              </Button>
            </>
          )}
          {reversed.length ? (
            <FieldError className="animate-in fade-in" data-testid="port-pools-reversed">
              {m.l4_pool_range_reversed()}
            </FieldError>
          ) : null}
          {refusal ? (
            <FieldError className="animate-in fade-in" data-testid="port-pools-error">
              {refusal.message}
            </FieldError>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end border-t">
          <Button
            type="submit"
            disabled={!dirty || reversed.length > 0 || save.isPending}
            data-testid="port-pools-save"
          >
            {save.isPending ? <Spinner /> : null}
            {m.common_save()}
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function PoolRow({
  row,
  index,
  invalid,
  onChange,
  onRemove,
}: {
  row: PoolDraft;
  index: number;
  invalid: boolean;
  onChange: (change: Partial<PoolDraft>) => void;
  onRemove: () => void;
}) {
  const id = (name: string) => `port-pool-${name}-${row.key}`;
  return (
    <li
      className={cn(
        "flex flex-wrap items-end gap-3 rounded-2xl border p-3 transition-colors animate-enter",
        invalid && "border-destructive/60",
      )}
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
      aria-label={m.l4_pool_number({ index: index + 1 })}
      data-testid="port-pool-row"
      data-invalid={invalid || undefined}
    >
      <Field className="w-full sm:w-40">
        <FieldLabel htmlFor={id("protocol")}>{m.l4_protocol()}</FieldLabel>
        <Select
          value={row.protocol}
          onValueChange={(value) => value && onChange({ protocol: value as PortPoolProtocol })}
          items={POOL_PROTOCOLS.map((p) => ({ label: p.label, value: p.value }))}
        >
          <SelectTrigger id={id("protocol")} className="w-full" data-testid="port-pool-protocol">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {POOL_PROTOCOLS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field className="min-w-24 flex-1 sm:w-36 sm:flex-none">
        <FieldLabel htmlFor={id("from")}>{m.l4_pool_from()}</FieldLabel>
        <Input
          id={id("from")}
          type="number"
          inputMode="numeric"
          min={PORT_MIN}
          max={PORT_MAX}
          step={1}
          required
          value={row.from}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange({ from: event.target.value })}
          className="font-mono"
          data-testid="port-pool-from"
        />
      </Field>
      <Field className="min-w-24 flex-1 sm:w-36 sm:flex-none">
        <FieldLabel htmlFor={id("to")}>{m.l4_pool_to()}</FieldLabel>
        <Input
          id={id("to")}
          type="number"
          inputMode="numeric"
          min={PORT_MIN}
          max={PORT_MAX}
          step={1}
          required
          value={row.to}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange({ to: event.target.value })}
          className="font-mono"
          data-testid="port-pool-to"
        />
      </Field>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        aria-label={m.common_remove()}
        onClick={onRemove}
        data-testid="port-pool-remove"
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
      </Button>
    </li>
  );
}
