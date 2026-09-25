// Minimal WebSocket echo check for scripts/e2e.sh: connects over a raw TCP
// socket (so the Host header can name a site served by the node), sends one
// text frame and prints the echoed payload.
//   node scripts/ws-echo.mjs <host> <port> <Host header> <path> <text>
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";

const [host, port, vhost, path, text] = process.argv.slice(2);
if (!text) {
  console.error("usage: ws-echo.mjs <host> <port> <Host header> <path> <text>");
  process.exit(2);
}
const key = randomBytes(16).toString("base64");
const expectedAccept = createHash("sha1")
  .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
  .digest("base64");
const socket = connect(Number(port), host);
const timer = setTimeout(() => {
  console.error("timeout");
  process.exit(1);
}, 10_000);
let buffer = Buffer.alloc(0);
let upgraded = false;

socket.on("connect", () => {
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: ${vhost}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
});
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buffer.subarray(0, end).toString();
    buffer = buffer.subarray(end + 4);
    const status = head.split("\r\n")[0] ?? "";
    if (!status.includes(" 101 ")) {
      console.error(`handshake failed: ${status}`);
      process.exit(1);
    }
    if (!head.toLowerCase().includes(`sec-websocket-accept: ${expectedAccept.toLowerCase()}`)) {
      console.error("handshake failed: bad Sec-WebSocket-Accept");
      process.exit(1);
    }
    upgraded = true;
    console.log(status);
    const payload = Buffer.from(text);
    const mask = randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ (mask[i % 4] ?? 0)));
    socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]));
  }
  if (upgraded && buffer.length >= 2) {
    const length = (buffer[1] ?? 0) & 0x7f;
    if (buffer.length < 2 + length) return;
    console.log(`echo: ${buffer.subarray(2, 2 + length).toString()}`);
    clearTimeout(timer);
    socket.end();
    process.exit(0);
  }
});
socket.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
