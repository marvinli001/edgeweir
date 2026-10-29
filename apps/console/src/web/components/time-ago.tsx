import type * as React from "react";
import { formatDateTime, timeAgo } from "@/lib/i18n";

/**
 * A moment as relative time ("4 minutes ago") with the exact date and time on hover; "never" without
 * one. Wraps nothing: give it the classes its place needs.
 */
export function TimeAgo({
  at,
  ...props
}: { at: string | null | undefined } & Omit<React.ComponentProps<"time">, "children">) {
  if (!at) return <span {...props}>{timeAgo(at)}</span>;
  return (
    <time dateTime={at} title={formatDateTime(at)} {...props}>
      {timeAgo(at)}
    </time>
  );
}
