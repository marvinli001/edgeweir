import type { OriginHealth } from "@edgeweir/contract";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { m, timeAgo } from "@/lib/i18n";
import { originErrorText } from "@/lib/node-errors";

/** Passive health of one origin across the online nodes of the site's cluster. */
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
        <span className="size-1.5 rounded-full bg-chart-2" />
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
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60 motion-reduce:hidden" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
        {m.site_origin_health_down({ down: health.downNodes, total: health.onlineNodes })}
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-1">
        {down.map((node) => {
          const error = originErrorText(node.lastErrorCode, node.lastErrorParams, node.lastError);
          return (
            <span key={node.nodeId} className="break-all" data-testid="origin-health-node">
              <span className="font-medium">{node.nodeName}</span>
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
