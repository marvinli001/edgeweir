import type * as React from "react";
import { BackgroundPattern, BorderBeam, GradientGlow } from "@/components/appica/effects";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Full-screen frame for sign-in and first-run setup. Put the card in an `AuthFrame`, or several
 * cards that take turns in `AuthViews`.
 */
export function AuthShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <BackgroundPattern
      variant="dots"
      spotlight={{ size: 320 }}
      track="window"
      className="flex min-h-svh flex-col items-center justify-center bg-muted/40 p-6 md:p-10"
    >
      <ThemeToggle className="fixed top-4 right-4 z-10 md:top-6 md:right-6" />
      <div className={cn("flex w-full max-w-sm flex-col gap-6 animate-enter", className)}>
        <div className="flex items-center gap-2 self-center text-lg font-semibold tracking-tight">
          <Logo className="size-6" />
          {m.app_name()}
        </div>
        {children}
      </div>
    </BackgroundPattern>
  );
}

/** Glow and border beam around one auth card, so the card moves as one piece with them. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <GradientGlow>
      <BorderBeam speed={8}>{children}</BorderBeam>
    </GradientGlow>
  );
}
