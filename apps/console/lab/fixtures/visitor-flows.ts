/**
 * Lab stand-in for `@/lib/visitor-flows`: sample visitor regions flowing into the fixture's edge
 * locations, so the overview globe shows its arcs.
 */
import type { VisitorFlow } from "@/lib/visitor-flows";

export type { VisitorFlow };

const FLOWS: VisitorFlow[] = [
  { from: [31.23, 121.47], to: "Tokyo", share: 0.16 },
  { from: [37.57, 126.98], to: "Tokyo", share: 0.08 },
  { from: [-33.87, 151.21], to: "Singapore", share: 0.06 },
  { from: [19.08, 72.88], to: "Singapore", share: 0.07 },
  { from: [13.76, 100.5], to: "Singapore", share: 0.05 },
  { from: [51.51, -0.13], to: "Frankfurt", share: 0.09 },
  { from: [40.42, -3.7], to: "Frankfurt", share: 0.04 },
  { from: [52.23, 21.01], to: "Frankfurt", share: 0.03 },
  { from: [40.71, -74.01], to: "Virginia", share: 0.12 },
  { from: [-23.55, -46.63], to: "Virginia", share: 0.05 },
  { from: [34.05, -118.24], to: "Virginia", share: 0.07 },
  { from: [43.65, -79.38], to: "Virginia", share: 0.04 },
];

export function useVisitorFlows(): VisitorFlow[] {
  return FLOWS;
}
