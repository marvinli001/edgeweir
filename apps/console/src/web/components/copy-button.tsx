import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/lib/i18n";

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      }}
    >
      <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} strokeWidth={2} />
      {copied ? m.common_copied() : (label ?? m.common_copy())}
    </Button>
  );
}

/** A monospace block with a copy button, for commands and fingerprints. */
export function CodeBlock({ value, testId }: { value: string; testId?: string }) {
  return (
    <div className="flex flex-col gap-2">
      <pre
        data-testid={testId}
        className="max-h-48 overflow-auto rounded-2xl bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap"
      >
        {value}
      </pre>
      <div>
        <CopyButton value={value} />
      </div>
    </div>
  );
}
