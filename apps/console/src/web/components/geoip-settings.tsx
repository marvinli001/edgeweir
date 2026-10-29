import { nodeSupportsFeature } from "@edgeweir/contract";
import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { enterDelay } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
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
const EDGE = "first:pl-(--panel-pad) last:pr-(--panel-pad)";

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
    <Panel className={className} style={style}>
      <PanelHeader className="flex flex-wrap items-center justify-between gap-3">
        <PanelTitle>{m.geo_title()}</PanelTitle>
        <a
          className="rounded-md text-sm text-primary-ink underline-offset-4 outline-none focus-ring hover:underline"
          href="https://github.com/marvinli001/edgeweir/blob/master/docs/guide/rules.md"
          target="_blank"
          rel="noreferrer"
        >
          {m.geo_guide()}
        </a>
      </PanelHeader>
      <QueryView
        query={nodes}
        frame={PanelContent}
        empty={
          <PanelContent>
            <EmptyState title={m.geo_empty()} />
          </PanelContent>
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
                    const word = ready ? m.geo_available() : m.geo_unavailable();
                    return (
                      <TableCell key={feature} className={EDGE}>
                        {/* Narrow, the light alone keeps the table inside its card. */}
                        <StatusDot tone={ready ? "good" : "idle"} title={word}>
                          <span
                            className={cn(
                              "@max-lg/main:sr-only",
                              !ready && "text-muted-foreground",
                            )}
                          >
                            {word}
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
      <PanelContent>
        <a
          className="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none focus-ring hover:text-foreground hover:underline"
          href="https://ipinfo.io"
          target="_blank"
          rel="noreferrer"
        >
          {m.geo_attribution()}
        </a>
      </PanelContent>
    </Panel>
  );
}
