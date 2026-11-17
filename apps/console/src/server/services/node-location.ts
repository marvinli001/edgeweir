import { readFileSync } from "node:fs";
import { forbiddenOriginRange, type Node } from "@edgeweir/contract";
import { type Response as MmdbRecord, Reader } from "mmdb-lib";
import { logger } from "../lib/logger";

type Location = NonNullable<Node["location"]>;
let lookup: (address: string) => Location | null = () => null;

/** A restart replaces the optional offline map database; node rule databases are independent. */
export function setNodeLocationDatabase(path: string) {
  let reader: Reader<MmdbRecord> | null | undefined;
  lookup = (address) => {
    if (!path) return null;
    if (reader === undefined) {
      reader = null;
      try {
        const db = new Reader<MmdbRecord>(readFileSync(path));
        if (/ipinfo/i.test(db.metadata.databaseType) && /lite/i.test(db.metadata.databaseType))
          reader = db;
      } catch {}
      if (!reader) logger.warn("node map IPinfo Lite database unavailable", { path });
    }
    if (!reader) return null;
    try {
      const record = reader.get(address) as unknown as { country_code?: string } | null;
      return record?.country_code && /^[A-Z]{2}$/.test(record.country_code)
        ? {
            address,
            country: record.country_code,
            subdivision: "",
            latitude: null,
            longitude: null,
            source: "ipinfo",
          }
        : null;
    } catch {
      return null;
    }
  };
}

export function resolveNodeLocation(address: string, reported: Location | null): Location | null {
  if (!address || forbiddenOriginRange(address, []) !== null) return null;
  const current = reported?.address === address ? reported : null;
  if (current && /^[A-Z]{2}$/.test(current.country)) return current;
  return lookup(address) ?? current;
}
