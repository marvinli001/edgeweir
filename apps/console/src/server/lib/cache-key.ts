import { type CacheKeyPolicy, cacheKeyPolicy } from "@edgeweir/contract";

/** Reads a stored cache key policy; missing or invalid fields fall back to the defaults. */
export function readCacheKey(value: unknown): CacheKeyPolicy {
  const parsed = cacheKeyPolicy.safeParse(value ?? {});
  return parsed.success ? parsed.data : cacheKeyPolicy.parse({});
}
