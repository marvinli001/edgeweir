import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function CopyButton({ value, iconOnly }: { value: string; iconOnly?: boolean }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const label = copied ? m.common_copied() : m.common_copy();
  return (
    <Button
      type="button"
      size={iconOnly ? "icon-sm" : "sm"}
      variant="outline"
      aria-label={iconOnly ? label : undefined}
      title={iconOnly ? label : undefined}
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      <HugeiconsIcon
        key={copied ? "copied" : "copy"}
        icon={copied ? Tick02Icon : Copy01Icon}
        strokeWidth={2}
        className="animate-in zoom-in-50 fade-in duration-200"
      />
      {iconOnly ? null : label}
    </Button>
  );
}

/** A monospace block with a copy button, for commands and fingerprints. */
/** `wrap={false}` keeps columns (zone files) and scrolls sideways instead. */
export function CodeBlock({
  value,
  testId,
  wrap = true,
}: {
  value: string;
  testId?: string;
  wrap?: boolean;
}) {
  return (
    <div className="relative">
      <pre
        data-testid={testId}
        className={cn(
          "max-h-48 overflow-auto rounded-2xl bg-muted p-3 pr-12 font-mono text-xs leading-relaxed shadow-inner",
          wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre",
        )}
      >
        {value}
      </pre>
      <div className="absolute top-2 right-2">
        <CopyButton value={value} iconOnly />
      </div>
    </div>
  );
}
