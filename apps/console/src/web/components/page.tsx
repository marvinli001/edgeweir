import type * as React from "react";
import { SiteHeader } from "@/components/site-header";

/** Standard page frame inside the sidebar inset: header + padded content. */
export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader title={title} actions={actions} />
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 lg:p-6">
        {description ? (
          <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>
        ) : null}
        {children}
      </div>
    </>
  );
}
