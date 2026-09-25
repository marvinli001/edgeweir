import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A column of resources on an overview page: a linked heading with a count, then rows split by
 * hairlines. Rows are whole-row links; the chevron marks them as such.
 */
export function ResourceList({
  title,
  count,
  link,
  children,
  testId,
  className,
  style,
}: {
  title: string;
  count?: React.ReactNode;
  /** Where the heading leads (the full list). */
  link?: LinkProps;
  children: React.ReactNode;
  testId?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const heading = (
    <>
      <span>{title}</span>
      {count !== undefined ? (
        <span className="inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-full bg-muted px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      ) : null}
      {link ? <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" /> : null}
    </>
  );
  return (
    <section className={cn("flex min-w-0 flex-col", className)} style={style} data-testid={testId}>
      <h2 className="flex h-8 items-center text-sm text-muted-foreground">
        {link ? (
          <Link
            {...link}
            className="inline-flex items-center gap-1.5 rounded-md outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {heading}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5">{heading}</span>
        )}
      </h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

const rowClass =
  "group/row flex h-11 min-w-0 items-center gap-3 border-b px-1 text-sm transition-colors outline-none";

/** One linked row: leading icon, label, optional trailing marks, chevron. */
export function ResourceRow({
  icon,
  children,
  trailing,
  link,
  testId,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  trailing?: React.ReactNode;
  link: LinkProps;
  testId?: string;
}) {
  return (
    <li>
      <Link
        {...link}
        className={cn(rowClass, "hover:bg-muted/50 focus-visible:bg-muted/60")}
        data-testid={testId}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">{children}</span>
        {trailing}
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          strokeWidth={2}
          className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/row:translate-x-0.5 motion-reduce:transition-none"
        />
      </Link>
    </li>
  );
}

/** A non-link row for empty columns: a muted line and an optional action. */
export function ResourceEmpty({ children }: { children: React.ReactNode }) {
  return <li className={cn(rowClass, "justify-between text-muted-foreground")}>{children}</li>;
}
