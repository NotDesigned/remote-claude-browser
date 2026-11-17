import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect } from "vitest";
import { pipeTransport } from "./broker";
import { createRuntimeClient, runtimeRequest } from "../egress/runtime-client";

test("browser startup and node checks keep sanitized exit failures across the broker socket", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mirror-runtime-test-"));
  const path = join(dir, "runtime.sock");
  let failure = { code: "EXIT_TIMEOUT", error: "通过所选代理检查出口超时，请检查节点连通性" };
  const server = createHttpServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify(failure));
  });
  await new Promise<void>((done) => server.listen(path, done));
  try {
    await expect(runtimeRequest("/browsers/test/start", "POST", {}, path)).rejects.toMatchObject({
      statusCode: 503,
      code: failure.code,
      message: failure.error,
    });
    await expect(
      createRuntimeClient({ socketPath: path }).timeZoneForEgress("test"),
    ).rejects.toMatchObject({ code: "EXIT_TIMEOUT", message: failure.error });
    failure = { code: "PRIVATE_RUNTIME_ERROR", error: "secret://user:password@node.invalid" };
    await expect(runtimeRequest("/browsers/test/start", "POST", {}, path)).rejects.toThrow(
      "网络运行时请求失败（503）",
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(dir, { recursive: true, force: true });
  }
});

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
