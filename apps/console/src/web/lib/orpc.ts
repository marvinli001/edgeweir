import type { Contract } from "@edgeweir/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { localizeError } from "@/lib/errors";

const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: "same-origin" }),
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

/** Typed client for the console contract (same procedures as /api/v1). */
export const client: ContractRouterClient<Contract> = createORPCClient(link);

/** TanStack Query helpers: orpc.sites.list.queryOptions(), .mutationOptions(), ... */
export const orpc = createTanstackQueryUtils(client);

/** A user-facing message for an API error, localized by its stable code. */
export function errorMessage(error: unknown, fallback?: string): string {
  return localizeError(error, fallback);
}

export function isUnauthorized(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: number }).status === 401;
}
