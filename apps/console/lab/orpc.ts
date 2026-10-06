/**
 * Lab stand-in for `@/lib/orpc`: the same exports, answered by the fixtures in this process.
 * Answers are checked against the contract's output schemas (a mismatch is logged, not thrown).
 */
import type { Contract } from "@edgeweir/contract";
import type { ClientLink } from "@orpc/client";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { localizeError } from "@/lib/errors";
import { fixtures } from "./fixtures";
import { emptyOutput, outputSchema } from "./fixtures/empty";

/** Round trip of a nearby console, so loading states show the way they do for real. */
const LATENCY_MS = 140;

type Handler = (input: unknown) => unknown;

function handlerAt(path: readonly string[]): Handler | undefined {
  let node: unknown = fixtures;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "function" ? (node as Handler) : undefined;
}

interface SafeParser {
  safeParse(value: unknown): { success: boolean; error?: unknown };
}

const link: ClientLink<Record<never, never>> = {
  async call(path, input, options) {
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    options.signal?.throwIfAborted();
    const handler = handlerAt(path);
    const output = handler ? await handler(input) : emptyOutput(path);
    const schema = outputSchema(path) as unknown as SafeParser | undefined;
    const check = schema?.safeParse(output);
    if (check && !check.success) {
      console.warn(`[lab] ${path.join(".")} answers outside its schema`, check.error);
    }
    return output;
  },
};

/** Typed client for the console contract, answered by fixtures. */
export const client: ContractRouterClient<Contract> = createORPCClient(link);

export const orpc = createTanstackQueryUtils(client);

export function errorMessage(error: unknown, fallback?: string): string {
  return localizeError(error, fallback);
}

export function isUnauthorized(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: number }).status === 401;
}

export function isNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { status?: number }).status === 404;
}
