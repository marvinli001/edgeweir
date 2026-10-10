import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema, SiteSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  IMAGE_CONVERT_FEATURE,
  type ImageConvertModel,
  type SiteModel,
} from "../src/index";
import { site, tls } from "./v0230-models";
import { v0310Models } from "./v0310-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0310.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0310.json"), "utf8"),
) as Vector;

const input = (extra: Partial<SiteModel> = {}): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), ...extra })],
});

const conversion: ImageConvertModel = {
  webp: true,
  avif: false,
  webpQuality: 80,
  avifQuality: 50,
  jpeg: true,
  png: true,
  minSize: 1024,
  maxSize: 10_485_760,
  maxPixels: 16_000_000,
};

describe("WebP / AVIF conversion (image-convert-v1)", () => {
  it("compiles the settings and requires image-convert-v1", () => {
    const config = compileNodeConfig(input({ imageConvert: conversion }), 1n);
    expect(config.requiredFeatures).toContain(IMAGE_CONVERT_FEATURE);
    const c = config.sites[0]?.imageConvert;
    expect(c).toMatchObject({
      webp: true,
      avif: false,
      webpQuality: 80,
      jpeg: true,
      png: true,
      minSize: 1024n,
      maxSize: 10_485_760n,
      maxPixels: 16_000_000n,
    });
    // The quality of a format the site does not offer is not sent: it
    // changes nothing on nodes, so it changes no hash either.
    expect(c?.avifQuality).toBe(0);
    const other = compileNodeConfig(input({ imageConvert: { ...conversion, avifQuality: 90 } }), 1n);
    expect(other.contentHash).toBe(config.contentHash);
    const avif = compileNodeConfig(input({ imageConvert: { ...conversion, avif: true } }), 1n);
    expect(avif.sites[0]?.imageConvert?.avifQuality).toBe(50);
    expect(avif.contentHash).not.toBe(config.contentHash);
  });

  it("encodes a site without conversion exactly as before", () => {
    const before = compileNodeConfig(input(), 1n);
    expect(before.requiredFeatures).not.toContain(IMAGE_CONVERT_FEATURE);
    const [b] = before.sites;
    if (!b) throw new Error("missing site");
    expect(b.imageConvert).toBeUndefined();
    const plain = compileNodeConfig(input({ imageConvert: undefined }), 1n);
    const [p] = plain.sites;
    if (!p) throw new Error("missing site");
    expect(toBinary(SiteSchema, p)).toEqual(toBinary(SiteSchema, b));
  });
});

describe("content hash matches the Go agent (v0.31.0)", () => {
  it("encodes the v0.31.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    expect(raw.requiredFeatures).toEqual(["tls-v1", IMAGE_CONVERT_FEATURE]);
    const config = canonicalize(raw);
    const a = config.sites[0];
    expect(a?.imageConvert).toMatchObject({ webp: true, avif: true, webpQuality: 80, avifQuality: 50, jpeg: true, png: false });
    expect(config.sites[1]?.imageConvert).toBeUndefined();
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(vector.canonical_hex);
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v0.31.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0310Models(), 12n);
    expect(config.requiredFeatures).toEqual([IMAGE_CONVERT_FEATURE, "tls-v1"]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
