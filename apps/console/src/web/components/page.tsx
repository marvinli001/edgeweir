import type * as React from "react";
import { SiteHeader } from "@/components/site-header";

/** Standard page frame inside the sidebar inset: header + padded content that fades in on mount. */
export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader title={title} actions={actions} />
      <div className="@container/main flex flex-1 flex-col gap-6 p-4 animate-enter lg:p-6">
        {children}
      </div>
    </>
  );
}
