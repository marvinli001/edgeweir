import type { Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

const running = await bootstrap();
const { env, log } = running.ctx;

if (env.ROLE === "app" || env.ROLE === "all") {
  const webDist =
    env.EDGEWEIR_WEB_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), "../web");
  const app = createApp(running.ctx, { webDist });
  const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
    log.info("console listening", { port: info.port, url: env.EDGEWEIR_PUBLIC_URL });
  });
  running.attachHttp(server as Server);
}
