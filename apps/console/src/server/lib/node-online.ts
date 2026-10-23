/** How often nodes send heartbeats (ReportStatus.report_interval_seconds). */
const HEARTBEAT_SECONDS = 15;

let heartbeat = HEARTBEAT_SECONDS;

/**
 * Shortens the heartbeat and with it the online window, for end-to-end tests
 * only (EDGEWEIR_E2E_HEARTBEAT_SECONDS); set once at startup.
 */
export function setHeartbeatSeconds(seconds: number | undefined): void {
  heartbeat = seconds ?? HEARTBEAT_SECONDS;
}

export function heartbeatSeconds(): number {
  return heartbeat;
}

/** A node counts as online if it sent a heartbeat within this window: three heartbeats. */
export function onlineWindowSeconds(): number {
  return heartbeat * 3;
}

export function isOnline(lastSeenAt: Date | null, now = Date.now()): boolean {
  return !!lastSeenAt && now - lastSeenAt.getTime() <= onlineWindowSeconds() * 1000;
}
