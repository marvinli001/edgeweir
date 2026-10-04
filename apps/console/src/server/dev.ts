import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createServer as createViteServer } from "vite";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";
import { attachNodeChannelWebSocket } from "./node-channel/websocket";

/**
 * Development entry: one Node.js process runs the API, the node channel and
 * the Vite dev server (middleware mode, with HMR on the same HTTP port).
 */
const running = await bootstrap();
const { env, log } = running.ctx;
const app = createApp(running.ctx);
const hono = getRequestListener(app.fetch);

const server = createServer();
const vite = await createViteServer({
  appType: "spa",
  server: { middlewareMode: true, hmr: { server } },
});
// Server paths the SPA must never answer (same set as app.ts).
const backendPaths = ["/api", "/rpc", "/downloads", "/install.sh", "/healthz", "/node-channel"];
server.on("request", (req, res) => {
  const url = req.url ?? "/";
  const path = url.split("?")[0] ?? url;
  if (backendPaths.some((p) => path === p || path.startsWith(`${p}/`))) return void hono(req, res);
  vite.middlewares(req, res, () => void hono(req, res));
});
server.listen(env.PORT, env.HOST, () => {
  log.info("dev server listening", { url: `http://localhost:${env.PORT}` });
});
running.attachHttp(server);
// Beside Vite's HMR upgrades on the same server.
if (running.nodeChannel) attachNodeChannelWebSocket(server, running.ctx, running.nodeChannel);
