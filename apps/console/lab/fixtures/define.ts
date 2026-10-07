/**
 * The shape of fixture answers, typed by the contract's client: a handler takes the procedure's
 * input and returns its output. Each area file exports a partial tree; index.ts merges them.
 */
import type { Contract } from "@edgeweir/contract";
import type { ContractRouterClient } from "@orpc/contract";

type Handler<T extends (...args: never[]) => unknown> = (
  input: Parameters<T>[0],
) => Awaited<ReturnType<T>> | Promise<Awaited<ReturnType<T>>>;

type Fixture<T> = T extends (...args: never[]) => unknown
  ? Handler<T>
  : { [K in keyof T]?: Fixture<T[K]> };

export type Fixtures = Fixture<ContractRouterClient<Contract>>;

/** The answer of a record that does not exist (404, as `*_NOT_FOUND` answers). */
export const notFound = () =>
  Object.assign(new Error("Not found"), { status: 404, code: "NOT_FOUND" });

export const ok = { ok: true } as const;

const isTree = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** One tree of the parts; a handler defined twice is a mistake (the later one wins). */
export function mergeFixtures(...parts: Fixtures[]): Fixtures {
  const merge = (into: Record<string, unknown>, from: Record<string, unknown>, at: string) => {
    for (const [key, value] of Object.entries(from)) {
      const existing = into[key];
      if (isTree(existing) && isTree(value)) {
        merge(existing, value, `${at}${key}.`);
      } else {
        if (existing !== undefined) console.warn(`[lab] fixture ${at}${key} defined twice`);
        into[key] = isTree(value) ? merge({}, value, `${at}${key}.`) : value;
      }
    }
    return into;
  };
  const out: Record<string, unknown> = {};
  for (const part of parts) merge(out, part as Record<string, unknown>, "");
  return out as Fixtures;
}
