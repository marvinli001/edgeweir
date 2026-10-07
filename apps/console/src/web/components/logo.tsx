import { cn } from "@/lib/utils";

/**
 * Edgeweir mark: a weir crest letting the flow over while holding back the rest. Drawn in the
 * action blue's ink (the dark preset blue alone sits near 2:1 on the dark sidebar).
 */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-5 text-primary-ink", className)}
      aria-hidden="true"
    >
      <path d="M3 17c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 3 2" />
      <path d="M3 21c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 3 2" />
      <path d="M4 12 12 4l8 8" />
    </svg>
  );
}
