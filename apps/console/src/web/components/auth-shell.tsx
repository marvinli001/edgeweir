import * as React from "react";
import { BorderBeam, GradientGlow } from "@/components/appica/effects";
import { EmbossSurface } from "@/components/effects/emboss-surface";
import { Spotlight } from "@/components/effects/spotlight";
import { Tilt } from "@/components/effects/tilt";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// WebGL and the world map load with the auth pages only.
const AuthBackdrop = React.lazy(() => import("@/components/effects/auth-backdrop"));

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
    <div className="relative isolate flex min-h-svh flex-col items-center justify-center overflow-hidden bg-background p-6 md:p-10">
      <React.Suspense fallback={null}>
        <AuthBackdrop />
      </React.Suspense>
      <ThemeToggle className="fixed top-4 right-4 z-10 md:top-6 md:right-6" />
      <div className={cn("relative flex w-full max-w-sm flex-col gap-6 animate-enter", className)}>
        <div className="flex items-center gap-2.5 self-center text-lg font-semibold tracking-tight">
          <EmbossSurface className="grid size-9 place-items-center rounded-xl">
            <Logo className="size-5" />
          </EmbossSurface>
          {m.app_name()}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Glow, border beam and a slight tilt with a spotlight around one auth card, so the card moves as
 * one piece with them.
 */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <Tilt>
      <GradientGlow>
        <BorderBeam speed={8}>
          <div className="relative overflow-hidden rounded-2xl">
            {children}
            <Spotlight size={420} className="z-10 mix-blend-soft-light dark:mix-blend-screen" />
          </div>
        </BorderBeam>
      </GradientGlow>
    </Tilt>
  );
}
