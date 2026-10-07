import { displaySiteDomain, siteDomainKind } from "@edgeweir/contract";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/lib/i18n";

/**
 * A site domain as stored (Punycode): shown with Unicode labels, the
 * Punycode form on hover.
 */
export function DomainName({ domain, className }: { domain: string; className?: string }) {
  const shown = displaySiteDomain(domain);
  if (shown === domain) return <span className={className}>{domain}</span>;
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className={cn("cursor-help", className)} data-testid="domain-unicode" />}
      >
        {shown}
      </TooltipTrigger>
      <TooltipContent>
        <span className="font-mono" data-testid="domain-punycode">
          {domain}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The form of a domain other than an exact name: `*.`, `.` or a pattern. */
export function DomainKindBadge({ domain }: { domain: string }) {
  const kind = siteDomainKind(domain);
  if (kind === "exact") return null;
  return (
    <Badge variant="secondary" data-testid={`domain-kind-${kind}`}>
      {kind === "wildcard"
        ? m.site_domain_wildcard()
        : kind === "suffix"
          ? m.site_domain_suffix()
          : m.site_domain_regex()}
    </Badge>
  );
}
