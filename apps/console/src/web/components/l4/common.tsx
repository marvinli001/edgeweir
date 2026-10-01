import type { L4Protocol } from "@edgeweir/contract";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CopyButton } from "@/components/copy-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { m } from "@/lib/i18n";
import { protocolLabel } from "@/lib/l4";
import { cn } from "@/lib/utils";

export function ProtocolBadge({ protocol }: { protocol: L4Protocol }) {
  return (
    <Badge
      variant={protocol === "tcp" ? "secondary" : "outline"}
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
      variant="destructive"
      className={cn("animate-enter", className)}
      data-testid="l4-nodes-without-l4"
    >
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={2} />
      <AlertTitle className="break-words">
        {m.l4_nodes_without_l4({ cluster, nodes: nodes.map((n) => n.name).join(", ") })}
      </AlertTitle>
    </Alert>
  );
}

/** The CNAME clients connect to, with a copy button; a muted note while the cluster's DNS is off. */
export function DnsTarget({ target, testId }: { target: string | null; testId?: string }) {
  if (!target)
    return (
      <span className="text-sm text-muted-foreground" data-testid={testId} data-dns="off">
        {m.l4_dns_off()}
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <code className="min-w-0 truncate font-mono text-xs" title={target} data-testid={testId}>
        {target}
      </code>
      <CopyButton iconOnly value={target} />
    </span>
  );
}
