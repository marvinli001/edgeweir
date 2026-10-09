import { describe, expect, it } from "vitest";
import {
  bodyFilenames,
  formValue,
  fromBytes,
  jsonValue,
  multipartBoundary,
  toBytes,
  validFormName,
  validJsonPath,
} from "../src/index.ts";
import vectors from "./body_vectors.json" with { type: "json" };

// The node's Lua (test/lua/body.lua) runs the same file. Bodies, names, paths and results are
// UTF-8 text (byte strings here); `hex` vectors carry bytes that are not UTF-8.
const hexBytes = (hex: string) =>
  String.fromCharCode(...(hex.match(/../g) ?? []).map((b) => Number.parseInt(b, 16)));

describe("request body vectors", () => {
  it("form_value", () => {
    for (const v of vectors.form)
      expect(
        fromBytes(formValue(toBytes(v.body), toBytes(v.contentType), toBytes(v.name))),
        JSON.stringify(v),
      ).toBe(v.expected);
  });
  it("json_value", () => {
    for (const v of vectors.json)
      expect(
        fromBytes(jsonValue(toBytes(v.body), toBytes(v.contentType), toBytes(v.path))),
        JSON.stringify(v),
      ).toBe(v.expected);
  });
  it("file names", () => {
    for (const v of vectors.filenames)
      expect(
        fromBytes(bodyFilenames(toBytes(v.body), toBytes(v.contentType))),
        JSON.stringify(v),
      ).toBe(v.expected);
  });
  it("bytes that are not UTF-8", () => {
    for (const v of vectors.hex) {
      const fn = v.kind === "form" ? formValue : jsonValue;
      expect(fn(hexBytes(v.bodyHex), v.contentType, v.arg), JSON.stringify(v)).toBe(
        hexBytes(v.expectedHex),
      );
    }
  });
  it("boundaries", () => {
    for (const v of vectors.boundary)
      expect(multipartBoundary(toBytes(v.contentType)), v.contentType).toBe(
        v.expected === null ? null : toBytes(v.expected),
      );
  });
  it("names and paths", () => {
    for (const v of vectors.validFormName)
      expect(validFormName(toBytes(v.input)), v.input).toBe(v.valid);
    for (const v of vectors.validJsonPath)
      expect(validJsonPath(toBytes(v.input)), v.input).toBe(v.valid);
  });
});
