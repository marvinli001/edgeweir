/**
 * Lab stand-in for `@/lib/orpc`: the same exports, answered by the fixtures in this process.
 * Answers are checked against the contract's output schemas (a mismatch is logged, not thrown).
 * The lab state (state.ts) turns every answer outside the shell into its empty value, a 500 or a
 * request that never finishes.
 */
import type { Contract } from "@edgeweir/contract";
import type { ClientLink } from "@orpc/client";
import { createORPCClient, ORPCError } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { localizeError } from "@/lib/errors";
import { fixtures } from "./fixtures";
import { emptyOutput, outputSchema } from "./fixtures/empty";
import { emptyFixtures } from "./fixtures/empty-state";
import { labState, SHELL_PROCEDURES } from "./state";

/** Round trip of a nearby console, so loading states show the way they do for real. */
const LATENCY_MS = 140;

type Handler = (input: unknown) => unknown;

function handlerAt(tree: unknown, path: readonly string[]): Handler | undefined {
  let node: unknown = tree;
  for (const key of path) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === "function" ? (node as Handler) : undefined;
}

interface SafeParser {
  safeParse(value: unknown): {
    success: boolean;
    error?: { issues?: { path: PropertyKey[]; message: string }[] };
  };
}

/** Pending until the caller gives up (a query that is cancelled or reset). */
function never(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const link: ClientLink<Record<never, never>> = {
  async call(path, input, options) {
    const state = SHELL_PROCEDURES.has(path.join(".")) ? "full" : labState();
    if (state === "loading") return never(options.signal);
    await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
    options.signal?.throwIfAborted();
    if (state === "error") {
      throw new ORPCError("INTERNAL_SERVER_ERROR", { status: 500, message: "Lab: server error" });
    }
    const handler = state === "empty" ? handlerAt(emptyFixtures, path) : handlerAt(fixtures, path);
    const output = handler ? await handler(input) : emptyOutput(path);
    const schema = outputSchema(path) as unknown as SafeParser | undefined;
    const check = schema?.safeParse(output);
    if (check && !check.success) {
      const issues = (check.error?.issues ?? [])
        .slice(0, 4)
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`);
      console.warn(`[lab] ${path.join(".")} answers outside its schema: ${issues.join("; ")}`);
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
