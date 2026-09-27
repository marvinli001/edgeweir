/**
 * Whether a node that reports `supported` provides `feature`. Nodes report
 * geoip-city-v1 for country data; newer ones add geoip-country-v1 and report
 * subdivisions (a City MMDB) separately as geoip-subdivision-v1. Before that,
 * geoip-city-v1 always came from a City MMDB, so it implies subdivisions.
 */
export function nodeSupportsFeature(supported: readonly string[], feature: string): boolean {
  if (feature === "geoip-subdivision-v1" && !supported.includes("geoip-country-v1"))
    return supported.includes("geoip-city-v1");
  return supported.includes(feature);
}
