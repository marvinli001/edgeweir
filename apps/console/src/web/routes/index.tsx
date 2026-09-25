import { landingTemplate } from "@edgeweir/contract";
import {
  createFileRoute,
  type ErrorComponentProps,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import * as z from "zod";
import { HorizonLanding } from "@/components/landing/horizon";
import { OrbitLanding } from "@/components/landing/orbit";
import { ErrorState } from "@/components/states";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";

/**
 * `/` is the public landing page when a template is chosen in the admin
 * settings; otherwise it goes straight to the console. Administrators can
 * preview a template with `?preview=<template>` before switching it on.
 */
export const Route = createFileRoute("/")({
  validateSearch: z.object({ preview: landingTemplate.exclude(["none"]).optional() }),
  beforeLoad: async ({ context, search }) => {
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
    const [page, session] = await Promise.all([
      context.queryClient.fetchQuery(orpc.landing.get.queryOptions()),
      authClient
        .getSession()
        .then((result) => result.data)
        .catch(() => null),
    ]);
    const isAdmin = (session?.user as { role?: string | null } | undefined)?.role === "admin";
    const template = search.preview && isAdmin ? search.preview : page.settings.template;
    if (template === "none") throw redirect({ to: "/overview" });
    return { page, template, signedIn: !!session };
  },
  component: LandingPage,
  errorComponent: LandingError,
});

function LandingError({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="mx-auto flex min-h-svh max-w-lg items-center p-6">
      <ErrorState error={error} onRetry={() => router.invalidate()} />
    </div>
  );
}

function LandingPage() {
  const { page, template, signedIn } = Route.useRouteContext();
  return template === "orbit" ? (
    <OrbitLanding page={page} signedIn={signedIn} />
  ) : (
    <HorizonLanding page={page} signedIn={signedIn} />
  );
}
