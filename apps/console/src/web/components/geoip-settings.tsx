import { nodeSupportsFeature } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { enterDelay } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

// Country and ASN come from the IPinfo Lite database bundled into node images
// (or operator MMDBs); subdivisions need an operator-provided City MMDB.
const features = [
  ["geoip-city-v1", () => m.geo_country()],
  ["geoip-subdivision-v1", () => m.geo_subdivision()],
  ["geoip-asn-v1", () => m.geo_asn()],
] as const;

/** Edge cells line up with the card title. */
const EDGE = "first:pl-(--card-spacing) last:pr-(--card-spacing)";

/** Which GeoIP databases each node has: a node per row, a light and a word per database. */
export function GeoIpSettings({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const nodes = useQuery(
    orpc.nodes.list.queryOptions({
      input: {},
      refetchInterval: 30_000,
      meta: { background: true },
    }),
  );
  return (
    <Card className={className} style={style}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.geo_title()}</CardTitle>
        <a
          className="rounded-md text-sm text-primary-ink underline-offset-4 outline-none focus-lit hover:underline"
          href="https://github.com/marvinli001/edgeweir/blob/master/docs/guide/rules.md"
          target="_blank"
          rel="noreferrer"
        >
          {m.geo_guide()}
        </a>
      </CardHeader>
      <QueryView
        query={nodes}
        frame={CardContent}
        empty={
          <CardContent>
            <EmptyState art="checkpoint" title={m.geo_empty()} />
          </CardContent>
        }
      >
        {(list) => (
          <Table data-testid="geoip-nodes">
            <TableHeader>
              <TableRow>
                <TableHead className={EDGE}>{m.nodes_col_name()}</TableHead>
                {features.map(([feature, label]) => (
                  <TableHead key={feature} className={EDGE}>
                    {label()}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((node, index) => (
                <TableRow key={node.id} className="animate-enter" style={enterDelay(index)}>
                  <TableCell className={cn("font-medium", EDGE)}>{node.name}</TableCell>
                  {features.map(([feature]) => {
                    const ready = nodeSupportsFeature(node.supportedFeatures, feature);
                    return (
                      <TableCell key={feature} className={EDGE}>
                        <StatusDot tone={ready ? "good" : "idle"}>
                          <span className={ready ? undefined : "text-muted-foreground"}>
                            {ready ? m.geo_available() : m.geo_unavailable()}
                          </span>
                        </StatusDot>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryView>
      <CardContent>
        <a
          className="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none focus-lit hover:text-foreground hover:underline"
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
