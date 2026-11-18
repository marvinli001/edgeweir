import type { ApiSecuritySettings } from "@edgeweir/contract";
import { byBytes } from "./sort";

export function apiSecurityEnabled(settings: ApiSecuritySettings): boolean {
  return (
    settings.discovery.enabled ||
    settings.schema.mode !== "off" ||
    settings.jwt.mode !== "off" ||
    settings.graphql.mode !== "off"
  );
}

export function encodeApiSecurity(settings: ApiSecuritySettings): string {
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(byBytes(([key]) => key))
              .map(([key, child]) => [key, stable(child)]),
          )
        : value;
  return apiSecurityEnabled(settings) ? JSON.stringify(stable(settings)) : "";
}
