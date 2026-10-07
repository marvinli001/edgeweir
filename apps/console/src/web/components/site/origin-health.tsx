import type { OriginHealth, OriginHealthSource } from "@edgeweir/contract";
import { Dot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { m, timeAgo } from "@/lib/i18n";
import { originErrorText } from "@/lib/node-errors";

/** Which check reported a node's state: real traffic (passive) or the agent's probes (active). */
const sourceLabel: Record<OriginHealthSource, () => string> = {
  passive: m.site_origin_health_source_passive,
  active: m.site_origin_health_source_active,
};

/** Health of one origin across the online nodes of the site's cluster (passive and active checks). */
export function OriginHealthBadge({ health }: { health: OriginHealth | undefined }) {
  if (!health) return null;
  if (health.onlineNodes === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground" data-testid="origin-health">
        {m.site_origin_health_no_nodes()}
      </Badge>
    );
  }
  if (health.downNodes === 0) {
    return (
      <Badge variant="outline" data-testid="origin-health" data-state="healthy">
        <Dot tone="good" small />
        {m.site_origin_health_ok()}
      </Badge>
    );
  }
  const down = health.nodes.filter((n) => !n.healthy);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="destructive"
            tabIndex={0}
            data-testid="origin-health"
            data-state="down"
            className="cursor-default"
          />
        }
      >
        {/* Still: the health polls, and a failure is a state, not something running. */}
        <span className="inline-flex size-1.5 rounded-full bg-current" />
        {m.site_origin_health_down({ down: health.downNodes, total: health.onlineNodes })}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1">
        {/* One row per node and check that marks the origin down. */}
        {down.map((node) => {
          const error = originErrorText(node.lastErrorCode, node.lastErrorParams, node.lastError);
          return (
            <span
              key={`${node.nodeId}/${node.source}`}
              className="break-all"
              data-testid="origin-health-node"
              data-source={node.source}
            >
              <span className="font-medium">{node.nodeName}</span>{" "}
              <span
                className="inline-flex h-4 items-center rounded-full bg-wash px-1.5 align-[1px] text-[10px] font-medium"
                data-testid={`origin-health-source-${node.source}`}
              >
                {sourceLabel[node.source]()}
              </span>
              {error ? ` · ${error}` : null}
            </span>
          );
        })}
      </TooltipContent>
    </Tooltip>
  );
}

/** The latest failure of a down origin, visible without hovering (phones). */
export function OriginHealthError({ health }: { health: OriginHealth | undefined }) {
  if (!health || health.downNodes === 0) return null;
  const error = originErrorText(health.lastErrorCode, health.lastErrorParams, health.lastError);
  if (!error) return null;
  return (
    <p
      className="line-clamp-2 text-xs break-all text-destructive animate-in fade-in"
      title={health.lastError || error}
      data-testid="origin-health-error"
      data-code={health.lastErrorCode || undefined}
    >
      {health.lastFailureAt ? `${timeAgo(health.lastFailureAt)} · ` : null}
      {error}
    </p>
  );
}
