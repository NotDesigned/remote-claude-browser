import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { outboundFor, describeOutbound, xrayConfig, TUNNEL_INTERFACE } from "./egress-proxy.mjs";

const uuid = "bf000d23-0752-40b4-affe-68f7707a9661";
const base64 = (s) => Buffer.from(s).toString("base64url");
const pbk = Buffer.alloc(32, 1).toString("base64url");
const pqv = Buffer.alloc(1952, 2).toString("base64url");
const encryption = `mlkem768x25519plus.native.0rtt.${Buffer.alloc(32, 3).toString("base64url")}`;
const reality = `vless://${uuid}@proxy.example.com:443?encryption=${encryption}&security=reality&sni=www.example.com&pbk=${pbk}&sid=abcd&pqv=${pqv}&spx=%2Ftest&fp=chrome&support-x25519mlkem768=true&type=tcp`;
const samples = [
  "socks5://user:password@127.0.0.1:1080",
  "http://user:password@proxy.example.com:8080",
  "https://proxy.example.com:443",
  `ss://${base64("aes-256-gcm:password")}@proxy.example.com:8388`,
  reality,
  `vless://${uuid}@proxy.example.com:443?security=tls&type=ws&path=%2Ftest%3Fed%3D2048&host=www.example.com`,
  `vless://${uuid}@proxy.example.com:443?security=tls&type=grpc&serviceName=test`,
  `vless://${uuid}@proxy.example.com:443?security=tls&type=httpupgrade&path=%2Ftest`,
  `vless://${uuid}@proxy.example.com:443?security=tls&type=xhttp&path=%2Ftest&mode=auto`,
  `vmess://${base64(JSON.stringify({ add: "proxy.example.com", port: 443, id: uuid, aid: 0, net: "grpc", path: "svc", tls: "tls" }))}`,
  "trojan://password@proxy.example.com:443?vcn=www.example.com",
  "hy2://password@proxy.example.com:443?obfs=salamander&obfs-password=test",
];

test("converts SOCKS5 and HTTP credentials and TLS to Xray", () => {
  assert.deepEqual(outboundFor("socks5://us%40er:p%3Ass@[2001:db8::1]:1080"), {
    protocol: "socks",
    settings: { address: "2001:db8::1", port: 1080, user: "us@er", pass: "p:ss" },
    tag: "proxy",
  });
  assert.equal(
    outboundFor("https://proxy.example.com").streamSettings.tlsSettings.serverName,
    "proxy.example.com",
  );
  assert.equal(
    describeOutbound(outboundFor("socks5://user:password@[2001:db8::1]:1080")),
    "socks [2001:db8::1]:1080",
  );
});
test("preserves VLESS post-quantum encryption and REALITY verification without downgrade", () => {
  const out = outboundFor(reality);
  assert.equal(out.settings.encryption, encryption);
  assert.equal(out.settings.id, uuid);
  assert.equal(out.streamSettings.network, "raw");
  assert.deepEqual(out.streamSettings.realitySettings, {
    serverName: "www.example.com",
    fingerprint: "chrome",
    password: pbk,
    shortId: "abcd",
    mldsa65Verify: pqv,
    spiderX: "/test",
  });
  assert.equal(outboundFor(reality + "&flow=xtls-rprx-vision").settings.flow, "xtls-rprx-vision");
});
test("maps WebSocket early data, gRPC, HTTPUpgrade and XHTTP", () => {
  assert.equal(outboundFor(samples[5]).streamSettings.wsSettings.path, "/test?ed=2048");
  assert.equal(outboundFor(samples[6]).streamSettings.grpcSettings.serviceName, "test");
  assert.equal(outboundFor(samples[7]).streamSettings.network, "httpupgrade");
  const extra = encodeURIComponent(JSON.stringify({ noGRPCHeader: true }));
  const out = outboundFor(samples[8] + `&extra=${extra}`);
  assert.deepEqual(out.streamSettings.xhttpSettings.extra, { noGRPCHeader: true });
});
test("keeps Shadowsocks forms, VMess AEAD, Trojan and Hysteria2", () => {
  assert.deepEqual(
    outboundFor(samples[3]),
    outboundFor(`ss://${base64("aes-256-gcm:password@proxy.example.com:8388")}`),
  );
  assert.equal(outboundFor(samples[9]).settings.security, "auto");
  assert.equal(
    outboundFor(samples[10]).streamSettings.tlsSettings.verifyPeerCertByName,
    "www.example.com",
  );
  const hy = outboundFor(samples[11]);
  assert.equal(hy.streamSettings.hysteriaSettings.auth, "password");
  assert.deepEqual(hy.streamSettings.finalmask.udp, [
    { type: "salamander", settings: { password: "test" } },
  ]);
});
test("accepts Xray outbound JSON and explicitly rejects old JSON and unsupported links", () => {
  const out = { protocol: "socks", settings: { address: "1.2.3.4", port: 1080 }, tag: "old" };
  assert.deepEqual(outboundFor(JSON.stringify(out)), { ...out, tag: "proxy" });
  for (const [link, pattern] of [
    ['{"type":"vless","uuid":"private-credential"}', /Xray outbound/],
    ['{"protocol":"freedom"}', /does not reach a proxy/],
    ['{"protocol":"loopback"}', /does not reach a proxy/],
    ["socks4://user:private-credential@proxy.example.com:1080", /unsupported share/],
    ["trojan://private-credential@proxy.example.com:443?allowInsecure=1", /removed allowInsecure/],
    ["ss://YWVzLTI1Ni1nY206cA@proxy.example.com:8388?plugin=private-credential", /plugins/],
    [
      samples[9].replace(
        samples[9].slice(8),
        base64(JSON.stringify({ add: "proxy.example.com", port: 443, id: uuid, aid: 1 })),
      ),
      /AEAD/,
    ],
    [reality.replace("type=tcp", "type=h2"), /unsupported transport/],
    [reality.replace(pbk, "private-credential"), /pbk/],
    [reality.replace(pqv, "private-credential"), /pqv/],
    [reality.replace("sid=abcd", "sid=abc"), /sid/],
    [samples[8] + "&extra=private-credential", /extra/],
    ["socks5://user:private-credential@proxy.example.com:0", /port/],
    ["socks5://user:%zzprivate-credential@proxy.example.com:1080", /percent/],
  ])
    assert.throws(
      () => outboundFor(link),
      (error) => pattern.test(error.message) && !error.message.includes("private-credential"),
    );
});
test("sends website DNS through the proxy and restricts direct routing to bootstrap DNS", () => {
  const config = xrayConfig({ proxy: outboundFor(reality) });
  assert.equal(config.inbounds[0].protocol, "tun");
  assert.equal(config.inbounds[0].settings.name, TUNNEL_INTERFACE);
  assert.equal(config.inbounds[0].settings.autoSystemRoutingTable, undefined);
  assert.equal(config.outbounds[0].tag, "proxy");
  assert.equal(config.outbounds[0].settings.encryption, encryption);
  assert.equal(config.dns.disableFallbackIfMatch, true);
  assert.deepEqual(config.dns.servers[0].domains, ["full:proxy.example.com"]);
  assert.deepEqual(config.routing.rules[0], {
    type: "field",
    inboundTag: ["bootstrap-dns"],
    ip: ["1.1.1.1"],
    port: "53",
    outboundTag: "bootstrap",
  });
  assert.equal(
    config.routing.rules.find((r) => r.inboundTag.includes("remote-dns")).outboundTag,
    "proxy",
  );
  assert.equal(
    config.routing.rules.find((r) => r.inboundTag.includes("tun-in")).outboundTag,
    "dns-out",
  );
  assert.equal(xrayConfig({ proxy: outboundFor("socks5://1.2.3.4:1080") }).dns.servers.length, 1);
  assert.throws(() => xrayConfig({ proxy: {}, bootstrapDns: "dns.example" }), /IPv4/);
});
test(
  "all generated protocol configs pass the pinned Xray binary",
  { skip: !process.env.XRAY_PATH },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "xray-config-test-"));
    try {
      for (const [index, link] of samples.entries()) {
        const path = join(dir, "config.json");
        await writeFile(path, JSON.stringify(xrayConfig({ proxy: outboundFor(link) })), {
          mode: 0o600,
        });
        const result = spawnSync(process.env.XRAY_PATH, ["run", "-test", "-config", path], {
          encoding: "utf8",
          timeout: 10000,
        });
        assert.equal(result.status, 0, `fixture ${index}: ${result.stdout}${result.stderr}`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
