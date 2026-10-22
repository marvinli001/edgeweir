"use client";

import { cn } from "cn";
import type * as React from "react";

/*
 * Lit tables: the header is a well strip with label typography; rows stay flat (no shadows), with
 * hairline separators, a hover wash and a primary tint when selected; figures are tabular (base
 * styles in index.css). Elevation belongs to the container (a card), never to rows.
 */

function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  );
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-well [&_tr]:border-b [&_tr]:hover:bg-transparent", className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-wash has-aria-expanded:bg-wash data-[state=selected]:bg-primary/6",
        className,
      )}
      {...props}
    />
  );
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3 py-2.5 align-middle whitespace-nowrap first:pl-4 last:pr-4 [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
