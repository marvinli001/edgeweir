import type { CompileInput, SiteModel } from "../src/index";
import { site } from "./v0230-models";

const origin = (id: string, proxyProtocolVersion: number, scheme: "http" | "https" = "http") => ({
  id,
  address: `${id}.origin.test`,
  port: scheme === "https" ? 443 : 80,
  scheme,
  weight: 1,
  backup: false,
  hostHeader: "",
  sni: "",
  proxyProtocolVersion,
});

const health = {
  path: "/",
  method: "GET" as const,
  expectedStatusMin: 200,
  expectedStatusMax: 399,
  host: "",
  intervalSeconds: 10,
  timeoutSeconds: 2,
  healthyThreshold: 2,
  unhealthyThreshold: 3,
};

/** A site with the given origins and active health check. */
const withPool = (
  id: string,
  origins: ReturnType<typeof origin>[],
  activeHealthCheck: SiteModel["originPool"]["activeHealthCheck"],
): SiteModel => {
  const model = site(id);
  return { ...model, originPool: { ...model.originPool, origins, activeHealthCheck } };
};

/**
 * The console models behind the v1.6.0 vector: site a sends PROXY protocol
 * v2 to one origin and v1 to another and probes them with grpc.health.v1
 * for the service e2e.Echo; site b probes the server's overall gRPC health;
 * site c keeps an HTTP check and sends none.
 */
export const v160Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    withPool("a", [origin("o-a1", 2), origin("o-a2", 1, "https")], {
      ...health,
      type: "grpc",
      grpcService: "e2e.Echo",
    }),
    withPool("b", [origin("o-b1", 0)], { ...health, type: "grpc", grpcService: "" }),
    withPool("c", [origin("o-c1", 0)], { ...health, type: "http" }),
  ],
});
