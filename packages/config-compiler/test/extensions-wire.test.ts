import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fromBinary, fromJson, type JsonObject, toBinary, toJson } from "@bufbuild/protobuf";
import { EXTENSIONS_NODE_FEATURE } from "@edgeweir/contract";
import { ExtensionSchema, NodeConfigDiffSchema, NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  compileNodeConfig,
  EXTENSIONS_V2_FEATURE,
  type ExtensionModel,
  encodeNodeConfig,
  nodeRequirements,
} from "../src/index";
import { site } from "./v0230-models";

// Synthetic wire values isolate field encoding from package/signature validation.
type Vector = { name: string; extension: JsonObject; canonical_hex: string };
const vectors = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "extension_wire_vectors.json"), "utf8"),
) as Vector[];

const model = (overrides: Partial<ExtensionModel> = {}): ExtensionModel => ({
  ...fromJson(ExtensionSchema, (vectors[0] as Vector).extension),
  size: 1,
  failureMode: "open",
  scope: undefined,
  ...overrides,
});

describe("extension wire compatibility", () => {
  it.each(vectors)("encodes and decodes $name", ({ extension, canonical_hex }) => {
    const encoded = toBinary(ExtensionSchema, fromJson(ExtensionSchema, extension));
    expect(Buffer.from(encoded).toString("hex")).toBe(canonical_hex);
    const decoded = fromBinary(ExtensionSchema, Buffer.from(canonical_hex, "hex"));
    expect(toJson(ExtensionSchema, decoded)).toEqual(extension);
    expect(toBinary(ExtensionSchema, decoded)).toEqual(encoded);
  });

  it("adds no bytes to legacy site extensions for empty scope and bindings", () => {
    const legacy = vectors[0] as Vector;
    const extension = fromJson(ExtensionSchema, {
      ...legacy.extension,
      scope: "",
      listeners: [],
    });
    expect(Buffer.from(toBinary(ExtensionSchema, extension)).toString("hex")).toBe(
      legacy.canonical_hex,
    );
    expect(toJson(ExtensionSchema, extension)).toEqual(legacy.extension);
  });

  it.each(vectors)("retains $name in full configs and diffs", ({ extension, canonical_hex }) => {
    const input = { extensions: [extension] };
    const full = fromJson(NodeConfigSchema, input);
    const diff = fromJson(NodeConfigDiffSchema, input);
    const decodedFull = fromBinary(NodeConfigSchema, toBinary(NodeConfigSchema, full));
    const decodedDiff = fromBinary(NodeConfigDiffSchema, toBinary(NodeConfigDiffSchema, diff));
    expect(toJson(NodeConfigSchema, decodedFull)).toEqual(input);
    expect(toJson(NodeConfigDiffSchema, decodedDiff)).toEqual(input);
    expect(Buffer.from(toBinary(NodeConfigSchema, full)).toString("hex")).toBe(
      `e203${(canonical_hex.length / 2).toString(16).padStart(2, "0")}${canonical_hex}`,
    );
    expect(toBinary(NodeConfigDiffSchema, diff)).toEqual(toBinary(NodeConfigSchema, full));
  });

  it("compiles the legacy site vector byte for byte, ignoring unreferenced site packages", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { extensions: [{ id: "old-ext", configJson: "{}" }] })],
        extensions: [model(), model({ id: "unused" })],
      },
      1n,
    );
    expect(config.extensions).toHaveLength(1);
    expect(
      config.extensions.map((extension) =>
        Buffer.from(toBinary(ExtensionSchema, extension)).toString("hex"),
      ),
    ).toEqual([(vectors[0] as Vector).canonical_hex]);
    expect(config.requiredFeatures).toContain(EXTENSIONS_V2_FEATURE);
    expect(config.requiredFeatures).not.toContain(EXTENSIONS_NODE_FEATURE);
  });

  it("delivers a node package without sites or bindings and never adds a site configuration", () => {
    const node = model({ id: "node-ext", scope: "node" });
    const empty = compileNodeConfig({ clusterId: "c", sites: [], extensions: [node] }, 1n);
    expect(empty.sites).toEqual([]);
    expect(empty.extensions).toMatchObject([{ id: "node-ext", scope: "node", listeners: [] }]);
    expect(nodeRequirements(empty)).toContain(EXTENSIONS_NODE_FEATURE);
    const mixed = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            extensions: [
              { id: "node-ext", configJson: '{"forged":true}' },
              { id: "old-ext", configJson: "{}" },
            ],
          }),
        ],
        extensions: [node, model()],
      },
      1n,
    );
    expect(mixed.extensions.map((extension) => extension.id)).toEqual(["node-ext", "old-ext"]);
    expect(mixed.sites[0]?.extensions.map((entry) => entry.id)).toEqual(["old-ext"]);
  });

  it("sorts bindings and ACL/method sets, preserving explicit zero and default body limits", () => {
    const listener = {
      port: 9145,
      bind: "127.0.0.1",
      allow: ["::1/128", "127.0.0.1/32"],
      methods: ["HEAD", "GET"],
    };
    const node = model({
      scope: "node",
      listeners: [
        { ...listener, name: "zero", maxBody: 0 },
        { ...listener, name: "default", port: 9146 },
      ],
    });
    const input = { clusterId: "c", sites: [], extensions: [node] };
    const config = compileNodeConfig(input, 1n);
    expect(
      config.extensions[0]?.listeners.map((binding) => [binding.name, binding.maxBody]),
    ).toEqual([
      ["default", 4096],
      ["zero", 0],
    ]);
    const shuffled = model({
      ...node,
      listeners: node.listeners?.toReversed().map((binding) => ({
        ...binding,
        allow: [...binding.allow.toReversed(), ...binding.allow],
        methods: binding.methods.toReversed(),
      })),
    });
    expect(encodeNodeConfig(compileNodeConfig({ ...input, extensions: [shuffled] }, 1n))).toEqual(
      encodeNodeConfig(config),
    );
    const bare = compileNodeConfig({ clusterId: "c", sites: [] }, 1n);
    for (const withdrawn of [
      { ...input, extensionsDisabled: true },
      { ...input, extensions: [model({ ...node, enabled: false })] },
    ]) {
      expect(encodeNodeConfig(compileNodeConfig(withdrawn, 1n))).toEqual(encodeNodeConfig(bare));
    }
  });
});
