/** API counters use JavaScript numbers; saturation keeps every stored bucket representable. */
export const MAX_TRAFFIC_COUNTER = Number.MAX_SAFE_INTEGER;

export function addTrafficCounter(left: number, right: number): number {
  return left >= MAX_TRAFFIC_COUNTER - right ? MAX_TRAFFIC_COUNTER : left + right;
}
