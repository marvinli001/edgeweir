import { bigint, jsonb } from "drizzle-orm/pg-core";

/**
 * Statistics dimensions of a minute, hour or day (stats-dims-v1, ADR-0041):
 * bounded maps of key → requests (country_bytes: bytes sent), and the
 * challenge counters. Networks and referring hosts keep the heaviest 50.
 */
export const statsDimensionColumns = () => ({
  countryRequests: jsonb("country_requests").$type<Record<string, number>>().notNull().default({}),
  countryBytes: jsonb("country_bytes").$type<Record<string, number>>().notNull().default({}),
  asns: jsonb("asns").$type<Record<string, number>>().notNull().default({}),
  referers: jsonb("referers").$type<Record<string, number>>().notNull().default({}),
  browsers: jsonb("browsers").$type<Record<string, number>>().notNull().default({}),
  oses: jsonb("oses").$type<Record<string, number>>().notNull().default({}),
  devices: jsonb("devices").$type<Record<string, number>>().notNull().default({}),
  httpVersions: jsonb("http_versions").$type<Record<string, number>>().notNull().default({}),
  tlsVersions: jsonb("tls_versions").$type<Record<string, number>>().notNull().default({}),
  blockReasons: jsonb("block_reasons").$type<Record<string, number>>().notNull().default({}),
  challengesIssued: bigint("challenges_issued", { mode: "number" }).notNull().default(0),
  challengesPassed: bigint("challenges_passed", { mode: "number" }).notNull().default(0),
});
