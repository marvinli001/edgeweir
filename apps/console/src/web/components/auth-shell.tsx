import type * as React from "react";
import { LanguageToggle } from "@/components/language-toggle";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Full-screen frame for sign-in and first-run setup: the atmosphere mesh behind a centred column
 * with the brand above the card. Put the card in an `AuthFrame`, or several cards that take turns
 * in `AuthViews`.
 */
export function AuthShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center bg-mesh p-4 md:p-10">
      <div className="fixed top-4 right-4 z-10 flex items-center gap-1 md:top-6 md:right-6">
        <LanguageToggle />
        <ThemeToggle />
      </div>
      <div className={cn("relative flex w-full max-w-sm flex-col gap-6 animate-enter", className)}>
        <div className="flex items-center gap-2.5 self-center text-title font-medium">
          <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Logo className="size-5 text-primary-foreground" />
          </span>
          {m.app_name()}
        </div>
        {children}
      </div>
    </div>
  );
}

/** One auth card: a white dialog-radius panel lifted off the mesh. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl shadow-elev-3 [&>[data-slot=panel]]:rounded-xl [&>[data-slot=panel]]:border-0 [&>[data-slot=panel]]:[--panel-pad:2rem] max-md:[&>[data-slot=panel]]:[--panel-pad:1.25rem]">
      {children}
    </div>
  );
}
