import type { Cluster } from "@edgeweir/contract";
import { Add01Icon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { ClusterRolloutCard } from "@/components/cluster-rollout";
import { ClusterCacheCard } from "@/components/clusters/cache-zone";
import { ClusterDialog } from "@/components/clusters/cluster-dialog";
import { ClusterSummary } from "@/components/clusters/cluster-summary";
import { EnrollDialogHost } from "@/components/clusters/enroll-dialog";
import { NodeGroupsSection } from "@/components/clusters/node-groups";
import { NodesSection } from "@/components/clusters/nodes";
import { RevisionsSection } from "@/components/clusters/revisions";
import { ClusterDns } from "@/components/dns/cluster-dns";
import { PortPoolsSection } from "@/components/l4/port-pools";
import { NodeUpgrades } from "@/components/node-upgrades";
import { Page } from "@/components/page";
import { RegionsPanel } from "@/components/regions";
import { ClusterScheduling } from "@/components/scheduling";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/clusters")({
  validateSearch: z.object({
    /** The regions view of the page (regions are shared by every cluster). */
    view: z.enum(["regions"]).optional(),
    cluster: z.string().optional(),
    enroll: z.boolean().optional(),
    tab: z.enum(["overview", "dns", "scheduling", "ports"]).optional(),
    node: z.string().optional(),
  }),
  component: ClustersPage,
});

/** Clusters and their nodes, and the regions view. */
function ClustersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createRegion, setCreateRegion] = React.useState(false);
  const clusters = useQuery({
    ...orpc.clusters.list.queryOptions(),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const selected = clusters.data?.find((c) => c.id === search.cluster) ?? clusters.data?.[0];
  const regions = search.view === "regions";

  const setEnrollOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, enroll: open || undefined }), replace: true });

  return (
    <Page
      title={m.clusters_title()}
      actions={
        regions ? (
          <Button size="sm" onClick={() => setCreateRegion(true)} data-testid="create-region">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.regions_create()}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setCreateOpen(true)}
              data-testid="create-cluster"
            >
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.clusters_create()}
            </Button>
            {selected ? (
              <Button size="sm" onClick={() => setEnrollOpen(true)} data-testid="add-node">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.nav_add_node()}
              </Button>
            ) : null}
          </>
        )
      }
    >
      <Tabs
        value={regions ? "regions" : "clusters"}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({ ...prev, view: value === "regions" ? "regions" : undefined }),
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="clusters" data-testid="clusters-view-clusters">
            {m.clusters_view_clusters()}
          </TabsTrigger>
          <TabsTrigger value="regions" data-testid="clusters-view-regions">
            {m.regions_tab_regions()}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {regions ? (
        <div className="flex flex-col gap-4 animate-enter">
          <RegionsPanel createOpen={createRegion} onCreateOpenChange={setCreateRegion} />
        </div>
      ) : (
        <QueryView
          query={clusters}
          empty={
            <EmptyState icon={ServerStack01Icon} title={m.clusters_empty_title()}>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.clusters_create()}
              </Button>
            </EmptyState>
          }
        >
          {(list) =>
            selected ? (
              <ClusterView
                clusters={list}
                selected={selected}
                onEnroll={() => setEnrollOpen(true)}
              />
            ) : null
          }
        </QueryView>
      )}
      {selected ? (
        <EnrollDialogHost
          cluster={selected}
          open={search.enroll === true}
          onOpenChange={setEnrollOpen}
        />
      ) : null}
      <ClusterDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(cluster) =>
          navigate({ search: (prev) => ({ ...prev, view: undefined, cluster: cluster.id }) })
        }
      />
    </Page>
  );
}

/**
 * One cluster: its summary, then its tabs. A cluster without nodes shows
 * only the node section, whose first step is adding one.
 */
function ClusterView({
  clusters,
  selected,
  onEnroll,
}: {
  clusters: Cluster[];
  selected: Cluster;
  onEnroll: () => void;
}) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The node whose details are open (?node=).
  const showDetail = React.useCallback(
    (id: string | null) =>
      navigate({ search: (prev) => ({ ...prev, node: id ?? undefined }), replace: true }),
    [navigate],
  );
  const nodes = (
    <NodesSection
      cluster={selected}
      onEnroll={onEnroll}
      detailId={search.node}
      onDetail={showDetail}
    />
  );
  return (
    <>
      <ClusterSummary
        clusters={clusters}
        selected={selected}
        onSelect={(id) => navigate({ search: (prev) => ({ ...prev, cluster: id }) })}
      />
      {selected.nodeCount === 0 ? (
        <div className="animate-enter">{nodes}</div>
      ) : (
        <Tabs
          value={search.tab ?? "overview"}
          onValueChange={(value) =>
            navigate({
              search: (prev) => ({
                ...prev,
                tab:
                  value === "dns" || value === "scheduling" || value === "ports"
                    ? value
                    : undefined,
              }),
              replace: true,
            })
          }
        >
          <TabsList className="max-w-full justify-start overflow-x-auto">
            <TabsTrigger value="overview" data-testid="cluster-tab-overview">
              {m.dns_tab_overview()}
            </TabsTrigger>
            <TabsTrigger value="dns" data-testid="cluster-tab-dns">
              {m.dns_tab_dns()}
            </TabsTrigger>
            <TabsTrigger value="scheduling" data-testid="cluster-tab-scheduling">
              {m.scheduling_tab()}
            </TabsTrigger>
            <TabsTrigger value="ports" data-testid="cluster-tab-ports">
              {m.l4_pools_title()}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="flex flex-col gap-4 animate-enter">
            <NodeGroupsSection cluster={selected} />
            {nodes}
            <ClusterRolloutCard key={`rollout-${selected.id}`} clusterId={selected.id} />
            <ClusterCacheCard
              key={`cache-${selected.id}-${JSON.stringify(selected.cache)}`}
              cluster={selected}
            />
            <NodeUpgrades key={selected.id} clusterId={selected.id} />
            <RevisionsSection cluster={selected} />
          </TabsContent>
          <TabsContent value="dns" className="animate-enter">
            <ClusterDns key={selected.id} clusterId={selected.id} />
          </TabsContent>
          <TabsContent value="scheduling" className="animate-enter">
            <ClusterScheduling key={selected.id} clusterId={selected.id} />
          </TabsContent>
          <TabsContent value="ports" className="animate-enter">
            <PortPoolsSection
              key={selected.id}
              clusterId={selected.id}
              clusterName={selected.name}
            />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
