import type { L4Protocol } from "@edgeweir/contract";
import { Alert } from "@/components/arc/alert/alert";
import { Badge } from "@/components/arc/badge/badge";
import { CopyButton } from "@/components/copy-button";
import { m } from "@/lib/i18n";
import { protocolLabel } from "@/lib/l4";
import { cn } from "@/lib/utils";

export function ProtocolBadge({ protocol }: { protocol: L4Protocol }) {
  return (
    <Badge
      size="sm"
      tone={protocol === "tcp" ? "neutral" : "neutral"}
      className="font-mono"
      data-testid="l4-app-protocol"
    >
      {protocolLabel(protocol)}
    </Badge>
  );
}

/**
 * Active nodes of a cluster without layer-4 forwarding refuse its configurations once it has
 * applications, so the console says which ones need an upgrade.
 */
export function L4NodesWarning({
  cluster,
  nodes,
  className,
}: {
  cluster: string;
  nodes: { id: string; name: string }[];
  className?: string;
}) {
  if (nodes.length === 0) return null;
  return (
    <Alert
      tone="danger"
      title={m.l4_nodes_without_l4({ cluster, nodes: nodes.map((n) => n.name).join(", ") })}
      className={cn("animate-enter", className)}
      data-testid="l4-nodes-without-l4"
    />
  );
}

/**
 * The CNAME clients connect to, with a copy button (with `well`: in a small well, in full, wrapping;
 * otherwise on one line, truncated); a muted note while the cluster's DNS is off.
 */
export function DnsTarget({
  target,
  testId,
  well = false,
}: {
  target: string | null;
  testId?: string;
  well?: boolean;
}) {
  if (!target)
    return (
      <span className="text-sm text-muted-foreground" data-testid={testId} data-dns="off">
        {m.l4_dns_off()}
      </span>
    );
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5",
        well && "w-fit max-w-full rounded-lg bg-well py-0.5 pr-0.5 pl-2",
      )}
    >
      {/* In the well (the app's page) the whole target wraps, as on a site's Domains tab. */}
      <code
        className={cn("min-w-0 font-mono text-xs", well ? "break-all" : "truncate")}
        title={well ? undefined : target}
        data-testid={testId}
      >
        {target}
      </code>
      <CopyButton iconOnly value={target} />
    </span>
  );
}
