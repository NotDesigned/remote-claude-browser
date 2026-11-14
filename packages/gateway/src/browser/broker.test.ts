import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import { pipeTransport } from "./broker";

test("private CDP bridge preserves messages across chunks, Unicode and adjacent frames", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mirror-pipe-test-"));
  const path = join(dir, "cdp.sock");
  const server = createServer();
  await new Promise<void>((done) => server.listen(path, done));
  const connected = new Promise<import("node:net").Socket>((done) =>
    server.once("connection", done),
  );
  const transport = await pipeTransport(path);
  const peer = await connected;
  try {
    const messages: string[] = [];
    const received = new Promise<void>((done) => {
      transport.onmessage = (message) => {
        messages.push(message);
        if (messages.length === 3) done();
      };
    });
    const text = Buffer.from('{"text":"中文"}\0{"id":2}\0{"id":3}\0');
    peer.write(text.subarray(0, 10));
    peer.write(text.subarray(10, 12));
    peer.write(text.subarray(12));
    await received;
    expect(messages).toEqual(['{"text":"中文"}', '{"id":2}', '{"id":3}']);
    const sent = new Promise<Buffer>((done) => peer.once("data", done));
    transport.send('{"id":4}');
    expect((await sent).toString()).toBe('{"id":4}\0');
  } finally {
    transport.close();
    peer.destroy();
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
