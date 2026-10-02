import { nodeSupportsFeature } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

// Country and ASN come from the IPinfo Lite database bundled into node images
// (or operator MMDBs); subdivisions need an operator-provided City MMDB.
const features = [
  ["geoip-city-v1", () => m.geo_country()],
  ["geoip-subdivision-v1", () => m.geo_subdivision()],
  ["geoip-asn-v1", () => m.geo_asn()],
] as const;

export function GeoIpSettings() {
  const nodes = useQuery(
    orpc.nodes.list.queryOptions({
      input: {},
      refetchInterval: 30_000,
      meta: { background: true },
    }),
  );
  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.geo_title()}</CardTitle>
        <a
          className="text-sm text-primary hover:underline"
          href="https://github.com/marvinli001/edgeweir/blob/master/docs/guide/rules.md"
          target="_blank"
          rel="noreferrer"
        >
          {m.geo_guide()}
        </a>
      </CardHeader>
      <CardContent>
        {nodes.isPending ? (
          <LoadingState />
        ) : nodes.isLoadingError ? (
          <ErrorState error={nodes.error} onRetry={() => void nodes.refetch()} />
        ) : !nodes.data.length ? (
          <EmptyState title={m.geo_empty()} />
        ) : (
          <ul className="divide-y">
            {nodes.data.map((node) => (
              <li key={node.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="min-w-0 flex-1 break-all text-sm">{node.name}</span>
                {features.map(([feature, label]) => (
                  <Badge key={feature} variant="outline">
                    {label()}
                    {m.geo_state({
                      state: nodeSupportsFeature(node.supportedFeatures, feature)
                        ? m.geo_available()
                        : m.geo_unavailable(),
                    })}
                  </Badge>
                ))}
              </li>
            ))}
          </ul>
        )}
        <a
          className="mt-3 inline-block text-xs text-muted-foreground hover:underline"
          href="https://ipinfo.io"
          target="_blank"
          rel="noreferrer"
        >
          {m.geo_attribution()}
        </a>
      </CardContent>
    </Card>
  );
}
