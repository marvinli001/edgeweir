import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { bindLists, type Expression, evaluate, type Phase, parseExpression } from "../src/index";

type Vector = {
  source: string;
  phase: Phase;
  ir: Expression;
  request: Record<string, string | number | boolean>;
  lists: Record<string, string[]>;
  expected: boolean;
};
const vectors: Vector[] = JSON.parse(
  readFileSync(new URL("./vectors.json", import.meta.url), "utf8"),
);
it.each(vectors)(
  "shared TS/Lua vector: $source",
  ({ source, phase, ir, request, lists, expected }) => {
    expect(bindLists(parseExpression(source, phase as Phase), { blocked: "list-1" })).toEqual(ir);
    expect(evaluate(ir, request, lists)).toBe(expected);
  },
);
