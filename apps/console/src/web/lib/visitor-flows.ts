import type { LatLng } from "@/lib/edge-map";

/** Requests from a visitor region into an edge location. */
export interface VisitorFlow {
  from: LatLng;
  /** The edge location's region name, as the nodes carry it. */
  to: string;
  /** Share of the traffic, 0–1. */
  share: number;
}

/**
 * Where visitors come from. The API reports no visitor regions yet, so this is empty and the edge
 * network shows locations without arcs; the design lab supplies sample flows.
 */
export function useVisitorFlows(): VisitorFlow[] {
  return [];
}
