// @vitest-environment node
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { request } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPublicOnlyAgent,
  createPublicOnlyLookup,
  isPrivateAddress,
  rejectPrivateTarget,
} from "./public-target";

describe("public target policy", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.1.2.3",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "224.0.0.1",
    "239.255.255.250",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::127.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:0:a00:1",
    "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "2001::1",
    "100::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "febf::1",
    "fec0::1",
    "ff02::1",
    "[::1]",
    "not-an-address",
  ])("treats %s as non-public", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "203.0.113.8",
    "223.255.255.255",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2002:808:808::1",
  ])("treats %s as public", (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it("rejects non-HTTP schemes and any private address in a resolved set", async () => {
    await expect(rejectPrivateTarget("file:///etc/passwd")).rejects.toThrow();
    await expect(
      rejectPrivateTarget("https://mixed.example/", async () => [
        { address: "203.0.113.8", family: 4 },
        { address: "fd00::1", family: 6 },
      ]),
    ).rejects.toMatchObject({ code: "EPRIVATETARGET" });
    await expect(
      rejectPrivateTarget("https://[::ffff:a9fe:a9fe]/latest/meta-data"),
    ).rejects.toMatchObject({ code: "EPRIVATETARGET" });
    await rejectPrivateTarget("https://public.example/", async () => [
      { address: "203.0.113.8", family: 4 },
    ]);
  });

  it("hands the socket exactly the addresses it checked", async () => {
    const resolve = vi.fn(async () => [
      { address: "203.0.113.8", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
    const lookup = createPublicOnlyLookup(resolve);
    const all = await new Promise((done, fail) =>
      lookup("public.example", { all: true }, (error, addresses) =>
        error ? fail(error) : done(addresses),
      ),
    );
    expect(all).toEqual([
      { address: "203.0.113.8", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ]);
    const single = await new Promise((done, fail) =>
      lookup("public.example", {}, (error, address, family) =>
        error ? fail(error) : done([address, family]),
      ),
    );
    expect(single).toEqual(["203.0.113.8", 4]);
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

describe("public-only agent", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  async function listen() {
    const hits = { count: 0 };
    server = createServer((_request, response) => {
      hits.count++;
      response.end("internal");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return { port: (server.address() as AddressInfo).port, hits };
  }

  it("refuses literal and resolved private addresses at connect time", async () => {
    const { port, hits } = await listen();
    // A rebinding resolver: whatever it answered for a pre-check, the connection uses this answer.
    const agent = createPublicOnlyAgent({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    });
    try {
      for (const url of [
        `http://127.0.0.1:${port}/`,
        `http://[::ffff:127.0.0.1]:${port}/`,
        `http://rebind.example:${port}/`,
      ]) {
        const failure = await request(url, { dispatcher: agent }).catch((error) => error);
        expect(failure).toMatchObject({ code: "EPRIVATETARGET" });
      }
      expect(hits.count).toBe(0);
    } finally {
      await agent.close();
    }
  });
});
