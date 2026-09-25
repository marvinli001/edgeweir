import { type ErrorCode, errorDefs } from "@edgeweir/contract";
import { ORPCError } from "@orpc/server";

/**
 * Throws a stable, localizable API error: the code and HTTP status come from
 * the contract's error table, `data` carries the message parameters and the
 * English `message` is the fallback for clients that do not know the code.
 */
export function fail(
  code: ErrorCode,
  message: string,
  data: Record<string, string | number> = {},
): never {
  throw new ORPCError(code, { status: errorDefs[code].status, message, data });
}
