/** A node counts as online if it sent a heartbeat within this window. */
export const ONLINE_WINDOW_SECONDS = 45;

export function isOnline(lastSeenAt: Date | null, now = Date.now()): boolean {
  return !!lastSeenAt && now - lastSeenAt.getTime() <= ONLINE_WINDOW_SECONDS * 1000;
}
