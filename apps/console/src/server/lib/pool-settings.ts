import type { ActiveHealthCheckModel, SessionAffinityModel } from "@edgeweir/config-compiler";
import {
  type ActiveHealthCheck,
  activeHealthCheck,
  type SessionAffinity,
  sessionAffinity,
} from "@edgeweir/contract";

/** A pool's stored active health check; missing or invalid fields fall back to the defaults. */
export function readActiveHealthCheck(value: unknown): ActiveHealthCheck {
  const parsed = activeHealthCheck.safeParse(value ?? {});
  return parsed.success ? parsed.data : activeHealthCheck.parse({});
}

/** A pool's stored session affinity; missing or invalid fields fall back to the defaults. */
export function readSessionAffinity(value: unknown): SessionAffinity {
  const parsed = sessionAffinity.safeParse(value ?? {});
  return parsed.success ? parsed.data : sessionAffinity.parse({});
}

/** The compiler model of a stored active health check: null while it is off. */
export function activeHealthCheckModel(value: unknown): ActiveHealthCheckModel | null {
  const { enabled, ...check } = readActiveHealthCheck(value);
  return enabled ? check : null;
}

/** The compiler model of a stored session affinity: null while it is off. */
export function sessionAffinityModel(value: unknown): SessionAffinityModel | null {
  const affinity = readSessionAffinity(value);
  return affinity.enabled ? { ttlSeconds: affinity.ttlSeconds } : null;
}
