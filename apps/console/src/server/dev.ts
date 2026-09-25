import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createServer as createViteServer } from "vite";
import { createApp } from "./app";
import { bootstrap } from "./bootstrap";

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
const backendPrefixes = ["/api/", "/rpc/", "/install.sh", "/healthz"];
server.on("request", (req, res) => {
  const url = req.url ?? "/";
  if (backendPrefixes.some((p) => url.startsWith(p))) return void hono(req, res);
  vite.middlewares(req, res, () => void hono(req, res));
});
server.listen(env.PORT, env.HOST, () => {
  log.info("dev server listening", { url: `http://localhost:${env.PORT}` });
});
running.attachHttp(server);
