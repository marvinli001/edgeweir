// Site parity G18 test origin (scripts/e2e-g18.mjs): `node server.mjs` on
// :8080. Serves the images next to this file (generated test pictures, no
// third-party content):
//   /photo.jpg   640 x 480 JPEG
//   /photo       the same without an extension
//   /icon.png    160 x 120 PNG with transparency
//   /huge.jpg    1500 x 1000 JPEG (over the e2e site's pixel limit)
//   /count       how often /photo.jpg was served, text/plain
//   anything else "<method> <path>", text/plain
import { readFileSync } from "node:fs";
import http from "node:http";

const dir = new URL(".", import.meta.url);
const file = (name) => readFileSync(new URL(name, dir));
const images = {
  "/photo.jpg": ["image/jpeg", file("photo.jpg")],
  "/photo": ["image/jpeg", file("photo.jpg")],
  "/icon.png": ["image/png", file("icon.png")],
  "/huge.jpg": ["image/jpeg", file("huge.jpg")],
};
let photos = 0;

http
  .createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://origin").pathname;
    const image = images[path];
    if (image) {
      if (path === "/photo.jpg") photos += 1;
      const [type, body] = image;
      res.setHeader("content-type", type);
      res.setHeader("content-length", body.length);
      res.setHeader("etag", `"g18-${body.length}"`);
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.setHeader("content-type", "text/plain");
    if (path === "/count") {
      res.setHeader("cache-control", "no-store");
      res.end(`${photos}\n`);
      return;
    }
    res.end(`${req.method} ${path}\n`);
  })
  .listen(8080);
