import { contract } from "@edgeweir/contract";
import { isContractProcedure } from "@orpc/contract";
import { isProcedure } from "@orpc/server";
import { describe, expect, it } from "vitest";
import { authed, os } from "../../src/server/rpc/base";
import { router } from "../../src/server/rpc/router";

/** Procedures anyone may call: the first-run setup. */
const PUBLIC_PROCEDURES = ["system.status", "system.setup"];

/** The leaves of a (contract) router by their dotted path. */
function leaves<T>(node: unknown, isLeaf: (value: unknown) => value is T, path: string[] = []) {
  if (isLeaf(node)) return [[path.join("."), node] as const];
  return Object.entries(node as Record<string, unknown>).flatMap(
    ([key, value]): (readonly [string, T])[] => leaves(value, isLeaf, [...path, key]),
  );
}

describe("router", () => {
  const procedures = leaves(router, isProcedure);

  it("implements every procedure of the contract at its route", () => {
    const routes = (list: (readonly [string, { "~orpc": { route: unknown } }])[]) =>
      Object.fromEntries(list.map(([path, p]) => [path, p["~orpc"].route]));
    expect(routes(procedures)).toEqual(routes(leaves(contract, isContractProcedure)));
  });

  it("guards every procedure but the first-run setup with authed", () => {
    // `os` checks API keys and service account scopes; `authed` requires a caller.
    const scope = os.system.status["~orpc"].middlewares;
    const guard = authed.system.status["~orpc"].middlewares.filter((m) => !scope.includes(m));
    expect(scope).toHaveLength(1);
    expect(guard).toHaveLength(1);
    const chains = Object.fromEntries(
      procedures.map(([path, p]) => [
        path,
        p["~orpc"].middlewares.map((m) =>
          scope.includes(m) ? "os" : guard.includes(m) ? "authed" : "?",
        ),
      ]),
    );
    for (const [path, chain] of Object.entries(chains))
      expect(chain, path).toEqual(PUBLIC_PROCEDURES.includes(path) ? ["os"] : ["os", "authed"]);
  });
});
