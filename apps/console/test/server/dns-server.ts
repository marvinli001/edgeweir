import { createSocket } from "node:dgram";
/** Tiny loopback TXT authority for tests. No external resolver or account. */
export async function dnsFixture() {
  const records = new Map<string, string[]>();
  const server = createSocket("udp4");
  server.on("message", (query, remote) => {
    let offset = 12;
    const labels: string[] = [];
    while (offset < query.length && query[offset]) {
      const length = query[offset] ?? 0;
      labels.push(query.subarray(offset + 1, offset + 1 + length).toString());
      offset += length + 1;
    }
    const name = labels.join(".");
    offset += 5;
    const question = query.subarray(12, offset),
      values = records.get(name) ?? [];
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.readUInt16BE(0));
    header.writeUInt16BE(values.length ? 0x8180 : 0x8183, 2);
    header.writeUInt16BE(1, 4);
    header.writeUInt16BE(values.length, 6);
    const answers = values.map((value) => {
      const text = Buffer.from(value);
      const rr = Buffer.alloc(13);
      rr.writeUInt16BE(0xc00c, 0);
      rr.writeUInt16BE(16, 2);
      rr.writeUInt16BE(1, 4);
      rr.writeUInt32BE(1, 6);
      rr.writeUInt16BE(text.length + 1, 10);
      rr[12] = text.length;
      return Buffer.concat([rr, text]);
    });
    server.send(Buffer.concat([header, question, ...answers]), remote.port, remote.address);
  });
  await new Promise<void>((resolve) => server.bind(0, "127.0.0.1", resolve));
  return {
    records,
    address: `127.0.0.1:${server.address().port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
