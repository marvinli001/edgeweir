// G7 layer-4 test origin (scripts/e2e-g7.mjs): two instances, l4-origin-a and
// l4-origin-b (the name is the first argument).
//   TCP 7000  echo; a first line "NAME" is answered with the instance name
//   UDP 7001  echo; a datagram "NAME" is answered with the instance name
//   TCP 7002  reads a PROXY protocol header (v1 text or v2 binary), answers
//             one JSON line {origin, version, source, sourcePort, destination,
//             destinationPort, peer} and then echoes
import dgram from "node:dgram";
import net from "node:net";

const NAME = process.argv[2] ?? "l4-origin";
const V2_SIGNATURE = Buffer.from([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);

const echo = net.createServer((socket) => {
  let first = true;
  socket.on("data", (data) => {
    if (first && data.toString("utf8") === "NAME\n") {
      socket.write(`${NAME}\n`);
    } else socket.write(data);
    first = false;
  });
  socket.on("error", () => {});
});
echo.listen(7000, "0.0.0.0");

const udp = dgram.createSocket("udp4");
udp.on("message", (message, remote) => {
  const reply = message.toString("utf8") === "NAME" ? Buffer.from(NAME) : message;
  udp.send(reply, remote.port, remote.address);
});
udp.bind(7001, "0.0.0.0");

/** Parses a PROXY header at the start of buffer; returns { header, rest } or null when incomplete. */
function parseProxy(buffer) {
  if (buffer.length >= 16 && buffer.subarray(0, 12).equals(V2_SIGNATURE)) {
    const length = buffer.readUInt16BE(14);
    if (buffer.length < 16 + length) return null;
    const command = buffer[12] & 0x0f;
    const family = buffer[13] >> 4;
    const body = buffer.subarray(16, 16 + length);
    let header = { version: 2, command: command === 1 ? "PROXY" : "LOCAL" };
    if (family === 1 && body.length >= 12)
      header = {
        ...header,
        source: [...body.subarray(0, 4)].join("."),
        destination: [...body.subarray(4, 8)].join("."),
        sourcePort: body.readUInt16BE(8),
        destinationPort: body.readUInt16BE(10),
      };
    if (family === 2 && body.length >= 36) {
      const ip6 = (b) =>
        Array.from({ length: 8 }, (_, i) => b.readUInt16BE(i * 2).toString(16)).join(":");
      header = {
        ...header,
        source: ip6(body.subarray(0, 16)),
        destination: ip6(body.subarray(16, 32)),
        sourcePort: body.readUInt16BE(32),
        destinationPort: body.readUInt16BE(34),
      };
    }
    return { header, rest: buffer.subarray(16 + length) };
  }
  const end = buffer.indexOf("\r\n");
  if (end < 0)
    return buffer.length > 107 ? { header: { version: 0, invalid: true }, rest: buffer } : null;
  const line = buffer.subarray(0, end).toString("latin1");
  const parts = line.split(" ");
  if (parts[0] !== "PROXY") return { header: { version: 0, invalid: true, line }, rest: buffer };
  return {
    header: {
      version: 1,
      family: parts[1],
      source: parts[2],
      destination: parts[3],
      sourcePort: Number(parts[4]),
      destinationPort: Number(parts[5]),
    },
    rest: buffer.subarray(end + 2),
  };
}

const proxy = net.createServer((socket) => {
  let buffer = Buffer.alloc(0);
  let parsed = false;
  socket.on("data", (data) => {
    if (parsed) return socket.write(data);
    buffer = Buffer.concat([buffer, data]);
    const result = parseProxy(buffer);
    if (!result) return;
    parsed = true;
    socket.write(
      `${JSON.stringify({ origin: NAME, ...result.header, peer: socket.remoteAddress })}\n`,
    );
    if (result.rest.length) socket.write(result.rest);
  });
  socket.on("error", () => {});
});
proxy.listen(7002, "0.0.0.0");
