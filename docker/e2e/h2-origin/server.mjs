// HTTP/2 test origin of scripts/e2e-h2.mjs: HTTP/2 with prior knowledge on
// 8080 and nothing else (an HTTP/1.1 request fails). /proto answers
// "HTTP/2.0 <authority>" with the authority it saw (the Host the node sent);
// the gRPC methods /e2e.Echo/Unary, /e2e.Echo/Bidi and /e2e.Echo/Fail echo
// raw-byte messages in gRPC's length-prefixed framing, the status in the
// trailers: Unary "echo:<message> authority=<authority> te=<TE>", Bidi
// "echo:<message>" per message as it arrives, Fail status 5.
import http2 from "node:http2";

const frame = (message) => {
  const b = Buffer.alloc(5 + message.length);
  b.writeUInt32BE(message.length, 1);
  message.copy(b, 5);
  return b;
};

/** Calls onMessage with every gRPC message of the stream as it completes. */
function messages(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
      const n = buffer.readUInt32BE(1);
      onMessage(buffer.subarray(5, 5 + n));
      buffer = buffer.subarray(5 + n);
    }
  });
}

const server = http2.createServer();
server.on("stream", (stream, headers) => {
  const path = headers[":path"] ?? "/";
  const authority = headers[":authority"] ?? headers.host ?? "-";
  stream.on("error", () => {});
  if (!(headers["content-type"] ?? "").startsWith("application/grpc")) {
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end(path.startsWith("/proto") ? `HTTP/2.0 ${authority}\n` : `${path}\n`);
    return;
  }
  let status = 0;
  let message = "";
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.on("wantTrailers", () =>
    stream.sendTrailers({
      "grpc-status": String(status),
      ...(message ? { "grpc-message": message } : {}),
    }),
  );
  stream.on("end", () => stream.end());
  switch (path) {
    case "/e2e.Echo/Unary": {
      let replied = false;
      messages(stream, (m) => {
        if (replied) return;
        replied = true;
        stream.write(
          frame(Buffer.from(`echo:${m} authority=${authority} te=${headers.te ?? "-"}`)),
        );
      });
      break;
    }
    case "/e2e.Echo/Bidi":
      messages(stream, (m) => stream.write(frame(Buffer.concat([Buffer.from("echo:"), m]))));
      break;
    case "/e2e.Echo/Fail":
      status = 5;
      message = "no such thing";
      stream.resume();
      break;
    default:
      status = 12;
      message = "unknown method";
      stream.resume();
  }
});
server.listen(8080, () => console.log("h2-origin: HTTP/2 with prior knowledge on 8080"));
