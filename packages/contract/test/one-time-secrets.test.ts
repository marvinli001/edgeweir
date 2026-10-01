import { describe, expect, it } from "vitest";
import * as z from "zod";
import { contract, oneTimeSecretProcedures } from "../src/index";

function procedures(node: unknown, prefix = ""): [string, { outputSchema?: unknown }][] {
  if (node && typeof node === "object" && "~orpc" in node)
    return [[prefix, (node as { "~orpc": { outputSchema?: unknown } })["~orpc"]]];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    procedures(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("procedures that return a credential once", () => {
  const all = procedures(contract);

  it("names existing procedures", () => {
    const names = new Set(all.map(([name]) => name));
    for (const name of oneTimeSecretProcedures) expect(names.has(name), name).toBe(true);
  });

  it("lists every procedure whose output has a string key, secret or token", () => {
    const returning = all
      .filter(([, def]) => {
        const output = def.outputSchema;
        if (!(output instanceof z.ZodObject)) return false;
        return Object.entries(output.shape).some(
          ([field, schema]) =>
            ["key", "secret", "token"].includes(field) && schema instanceof z.ZodString,
        );
      })
      .map(([name]) => name);
    expect(returning.sort()).toEqual([...oneTimeSecretProcedures].sort());
  });
});
