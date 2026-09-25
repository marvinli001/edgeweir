import type { Cluster, EnrollmentTokenResult, Node, Revision } from "@edgeweir/contract";
import { Add01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/clusters")({
  validateSearch: z.object({
    cluster: z.string().optional(),
    enroll: z.boolean().optional(),
  }),
  component: ClustersPage,
});

function ClustersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const clusters = useQuery({ ...orpc.clusters.list.queryOptions(), refetchInterval: 5_000 });
  const selected = clusters.data?.find((c) => c.id === search.cluster) ?? clusters.data?.[0];

  const setEnrollOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, enroll: open || undefined }), replace: true });

  return (
    <Page
      title={m.clusters_title()}
      description={m.clusters_description()}
      actions={
        selected ? (
          <Button size="sm" onClick={() => setEnrollOpen(true)} data-testid="add-node">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_add_node()}
          </Button>
        ) : null
      }
    >
      {clusters.isPending ? (
        <LoadingState />
      ) : clusters.isError ? (
        <ErrorState error={clusters.error} onRetry={() => clusters.refetch()} />
      ) : !selected ? (
        <EmptyState
          icon={ServerStack01Icon}
          title={m.clusters_empty_title()}
          description={m.clusters_empty_description()}
        />
      ) : (
        <>
          <ClusterSummary
            clusters={clusters.data}
            selected={selected}
            onSelect={(id) => navigate({ search: (prev) => ({ ...prev, cluster: id }) })}
          />
          <NodesSection cluster={selected} onEnroll={() => setEnrollOpen(true)} />
          <RevisionsSection cluster={selected} />
          <EnrollDialog
            cluster={selected}
            open={search.enroll === true}
            onOpenChange={setEnrollOpen}
          />
        </>
      )}
    </Page>
  );
}

function ClusterSummary({
  clusters,
  selected,
  onSelect,
}: {
  clusters: Cluster[];
  selected: Cluster;
  onSelect: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <CardTitle data-testid="cluster-name">{selected.name}</CardTitle>
          <CardDescription className="flex flex-wrap gap-2">
            <Badge variant="outline" data-testid="cluster-nodes-online">
              {m.clusters_nodes_count({
                online: selected.onlineNodeCount,
                total: selected.nodeCount,
              })}
            </Badge>
            <Badge variant="outline">{m.clusters_sites_count({ count: selected.siteCount })}</Badge>
            <Badge variant="secondary" data-testid="cluster-latest-revision">
              {selected.latestRevision
                ? m.clusters_latest_revision({ revision: selected.latestRevision.revision })
                : m.clusters_no_revision()}
            </Badge>
          </CardDescription>
        </div>
        {clusters.length > 1 ? (
          <Select
            value={selected.id}
            onValueChange={(value) => value && onSelect(String(value))}
            items={clusters.map((c) => ({ label: c.name, value: c.id }))}
          >
            <SelectTrigger className="w-48" aria-label={m.clusters_select()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {clusters.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </CardHeader>
    </Card>
  );
}

function RevisionBadge({ node, latest }: { node: Node; latest: number }) {
  if (node.applyState === "failed") {
    return (
      <Badge variant="destructive" title={node.applyMessage}>
        {m.nodes_apply_failed()}
      </Badge>
    );
  }
  if (node.appliedRevision === 0) return null;
  return node.appliedRevision >= latest ? (
    <Badge variant="secondary">{m.nodes_up_to_date()}</Badge>
  ) : (
    <Badge variant="outline">{m.nodes_behind()}</Badge>
  );
}

function NodesSection({ cluster, onEnroll }: { cluster: Cluster; onEnroll: () => void }) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    refetchInterval: 5_000,
  });
  const latest = cluster.latestRevision?.revision ?? 0;
  const columns = React.useMemo<Columns<Node>>(
    () => [
      {
        id: "name",
        header: () => m.nodes_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">{row.original.hostname}</span>
          </div>
        ),
      },
      {
        id: "status",
        header: () => m.nodes_col_status(),
        cell: ({ row }) =>
          row.original.status === "disabled" ? (
            <Badge variant="outline">{m.nodes_disabled()}</Badge>
          ) : row.original.online ? (
            <Badge data-testid="node-online">
              <span className="size-1.5 rounded-full bg-current" />
              {m.nodes_online()}
            </Badge>
          ) : (
            <Badge variant="destructive" data-testid="node-offline">
              {m.nodes_offline()}
            </Badge>
          ),
      },
      {
        id: "ips",
        header: () => m.nodes_col_ips(),
        cell: ({ row }) => (
          <div className="flex flex-col font-mono text-xs">
            {row.original.ipAddresses.length
              ? row.original.ipAddresses.map((ip) => <span key={ip}>{ip}</span>)
              : "—"}
          </div>
        ),
      },
      {
        id: "revision",
        header: () => m.nodes_col_revision(),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono" data-testid="node-applied-revision">
              #{row.original.appliedRevision}
            </span>
            <RevisionBadge node={row.original} latest={latest} />
          </div>
        ),
      },
      {
        id: "agent",
        header: () => m.nodes_col_agent(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs text-muted-foreground">
            <span>{row.original.agentVersion || "—"}</span>
            <span>
              {row.original.engine} {row.original.engineVersion}
            </span>
          </div>
        ),
      },
      {
        id: "lastSeen",
        header: () => m.nodes_col_last_seen(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.lastSeenAt)}</span>
        ),
      },
    ],
    [latest],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.nodes_title()}</h2>
      {nodes.isPending ? (
        <LoadingState rows={2} />
      ) : nodes.isError ? (
        <ErrorState error={nodes.error} onRetry={() => nodes.refetch()} />
      ) : nodes.data.length === 0 ? (
        <EmptyState
          icon={ServerStack01Icon}
          title={m.nodes_empty_title()}
          description={m.nodes_empty_description()}
        >
          <Button onClick={onEnroll}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_add_node()}
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          data={nodes.data}
          columns={columns}
          getRowId={(n) => n.id}
          testId="nodes-table"
        />
      )}
    </section>
  );
}

function RevisionsSection({ cluster }: { cluster: Cluster }) {
  const queryClient = useQueryClient();
  const revisions = useQuery(orpc.clusters.revisions.queryOptions({ input: { id: cluster.id } }));
  const rollback = useMutation(orpc.clusters.rollback.mutationOptions());
  const latest = cluster.latestRevision?.revision ?? 0;
  const columns = React.useMemo<Columns<Revision>>(
    () => [
      {
        id: "revision",
        header: () => m.revisions_col_revision(),
        cell: ({ row }) => <span className="font-mono">#{row.original.revision}</span>,
      },
      {
        id: "hash",
        header: () => m.revisions_col_hash(),
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.contentHash.slice(0, 16)}
          </code>
        ),
      },
      {
        id: "sites",
        header: () => m.revisions_col_sites(),
        cell: ({ row }) => row.original.siteCount,
      },
      {
        id: "reason",
        header: () => m.revisions_col_reason(),
        cell: ({ row }) => <span className="text-sm">{row.original.reason}</span>,
      },
      {
        id: "time",
        header: () => m.revisions_col_time(),
        cell: ({ row }) => (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(row.original.createdAt)}
          >
            {timeAgo(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.revision === latest ? null : (
            <ConfirmDialog
              trigger={
                <Button size="sm" variant="ghost">
                  {m.revisions_rollback()}
                </Button>
              }
              title={m.revisions_rollback()}
              description={m.revisions_rollback_confirm({ revision: row.original.revision })}
              onConfirm={async () => {
                try {
                  const result = await rollback.mutateAsync({
                    id: cluster.id,
                    revision: row.original.revision,
                  });
                  toast.success(m.revisions_rolled_back({ revision: result.revision }));
                  await queryClient.invalidateQueries();
                } catch (error) {
                  toast.error(errorMessage(error, m.common_unknown_error()));
                }
              }}
            />
          ),
      },
    ],
    [cluster.id, latest, rollback, queryClient],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.revisions_title()}</h2>
      {revisions.isPending ? (
        <LoadingState rows={2} />
      ) : revisions.isError ? (
        <ErrorState error={revisions.error} onRetry={() => revisions.refetch()} />
      ) : revisions.data.length === 0 ? (
        <EmptyState title={m.overview_revisions_empty()} />
      ) : (
        <DataTable
          data={revisions.data.slice(0, 20)}
          columns={columns}
          getRowId={(r) => String(r.revision)}
          testId="revisions-table"
        />
      )}
    </section>
  );
}

const TTL_OPTIONS = [15, 60, 24 * 60];

function EnrollDialog({
  cluster,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [ttl, setTtl] = React.useState(60);
  const [result, setResult] = React.useState<EnrollmentTokenResult | null>(null);
  const create = useMutation(orpc.clusters.createEnrollmentToken.mutationOptions());
  const ttlLabel = (minutes: number) =>
    minutes < 60
      ? m.enroll_ttl_minutes({ count: minutes })
      : m.enroll_ttl_hours({ count: minutes / 60 });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setResult(null);
          create.reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.enroll_title()}</DialogTitle>
          <DialogDescription>{m.enroll_description()}</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel>{m.enroll_command()}</FieldLabel>
                <CodeBlock value={result.installCommand} testId="install-command" />
                <FieldDescription>
                  {m.enroll_expires({ time: formatDateTime(result.expiresAt) })} ·{" "}
                  {m.enroll_shown_once()}
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel>{m.enroll_ca_fingerprint()}</FieldLabel>
                <code className="rounded-xl bg-muted p-2 font-mono text-xs break-all">
                  {result.caSha256}
                </code>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{m.common_close()}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                setResult(
                  await create.mutateAsync({
                    clusterId: cluster.id,
                    nodeName: String(data.get("nodeName") ?? ""),
                    ttlMinutes: ttl,
                  }),
                );
              } catch {
                // rendered below via create.error
              }
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="nodeName">{m.enroll_node_name()}</FieldLabel>
                <Input id="nodeName" name="nodeName" maxLength={64} placeholder="edge-sh-01" />
              </Field>
              <Field>
                <FieldLabel>{m.enroll_ttl()}</FieldLabel>
                <Select
                  value={String(ttl)}
                  onValueChange={(value) => value && setTtl(Number(value))}
                  items={TTL_OPTIONS.map((v) => ({ label: ttlLabel(v), value: String(v) }))}
                >
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TTL_OPTIONS.map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        {ttlLabel(v)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {create.isError ? (
                <FieldError>{errorMessage(create.error, m.common_unknown_error())}</FieldError>
              ) : null}
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={create.isPending}
                  data-testid="generate-install-command"
                >
                  {create.isPending ? <Spinner /> : null}
                  {m.enroll_generate()}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
