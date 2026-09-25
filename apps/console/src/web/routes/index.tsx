import { landingTemplate } from "@edgeweir/contract";
import {
  createFileRoute,
  type ErrorComponentProps,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { HorizonLanding } from "@/components/landing/horizon";
import { OrbitLanding } from "@/components/landing/orbit";
import { ErrorState, LoadingState } from "@/components/states";
import { useLightTheme } from "@/components/theme-provider";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";
import { releaseInitialLightLock } from "@/lib/theme";

/**
 * `/` is the public landing page when a template is chosen in the admin
 * settings; otherwise it goes straight to the console. Administrators can
 * preview a template with `?preview=<template>` before switching it on.
 * The landing page is light-only; theme-init.js paints the first load of `/`
 * light for it and that stays (also behind the loader) until the route resolves.
 */
export const Route = createFileRoute("/")({
  validateSearch: z.object({ preview: landingTemplate.exclude(["none"]).optional() }),
  beforeLoad: async ({ context, search, preload }) => {
    // Not the landing page after all: give the console the user's theme (a hover preload of `/`
    // must not touch the page that is on screen).
    const leave = (to: "/setup" | "/overview") => {
      if (!preload) releaseInitialLightLock();
      return redirect({ to });
    };
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw leave("/setup");
    const [page, session] = await Promise.all([
      context.queryClient.fetchQuery(orpc.landing.get.queryOptions()),
      authClient
        .getSession()
        .then((result) => result.data)
        .catch(() => null),
    ]);
    const isAdmin = (session?.user as { role?: string | null } | undefined)?.role === "admin";
    const template = search.preview && isAdmin ? search.preview : page.settings.template;
    if (template === "none") throw leave("/overview");
    return { page, template, signedIn: !!session };
  },
  // The three requests above can take a moment: show the loader instead of a blank page (it fades
  // in after 200ms, so fast answers never flash it).
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: LandingPending,
  component: LandingPage,
  errorComponent: LandingError,
});

function LandingPending() {
  return (
    <div className="flex min-h-svh" data-testid="landing-pending">
      <LoadingState />
    </div>
  );
}

function LandingError({ error }: ErrorComponentProps) {
  const router = useRouter();
  // Console styling, so the user's theme applies again.
  React.useLayoutEffect(() => releaseInitialLightLock(), []);
  return (
    <div className="mx-auto flex min-h-svh max-w-lg items-center p-6">
      <ErrorState error={error} onRetry={() => router.invalidate()} />
    </div>
  );
}

function LandingPage() {
  useLightTheme();
  const { page, template, signedIn } = Route.useRouteContext();
  return template === "orbit" ? (
    <OrbitLanding page={page} signedIn={signedIn} />
  ) : (
    <HorizonLanding page={page} signedIn={signedIn} />
  );
}
