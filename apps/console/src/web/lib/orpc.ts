import type { Contract } from "@edgeweir/contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";

const link = new RPCLink({
  url: () => `${window.location.origin}/rpc`,
  fetch: (request, init) => fetch(request, { ...init, credentials: "same-origin" }),
  plugins: [new SimpleCsrfProtectionLinkPlugin()],
});

/** Typed client for the console contract (same procedures as /api/v1). */
export const client: ContractRouterClient<Contract> = createORPCClient(link);

/** TanStack Query helpers: orpc.sites.list.queryOptions(), .mutationOptions(), ... */
export const orpc = createTanstackQueryUtils(client);

export function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "message" in error) {
    const message = String((error as { message: unknown }).message);
    if (message) return message;
  }
  return fallback;
}

export function isUnauthorized(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: number }).status === 401;
}
