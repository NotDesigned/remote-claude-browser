import assert from "node:assert/strict";
import { test } from "node:test";
import { describeOutbound, outboundFor, singBoxConfig, TUNNEL_INTERFACE } from "./egress-proxy.mjs";

const uuid = "bf000d23-0752-40b4-affe-68f7707a9661";
const base64 = (text) => Buffer.from(text).toString("base64");

test("reads SOCKS and HTTP proxies, with their credentials", () => {
  assert.deepEqual(outboundFor("socks5://us%40er:p%3Ass@1.2.3.4:1080"), {
    type: "socks",
    server: "1.2.3.4",
    server_port: 1080,
    version: "5",
    username: "us@er",
    password: "p:ss",
    tag: "proxy",
  });
  assert.deepEqual(outboundFor("https://proxy.example.com"), {
    type: "http",
    server: "proxy.example.com",
    server_port: 443,
    tls: { enabled: true, server_name: "proxy.example.com" },
    tag: "proxy",
  });
});

test("reads both forms of Shadowsocks link and a plugin", () => {
  const expected = {
    type: "shadowsocks",
    server: "ss.example.com",
    server_port: 8388,
    method: "aes-256-gcm",
    password: "pa:ss",
    tag: "proxy",
  };
  assert.deepEqual(
    outboundFor(`ss://${base64("aes-256-gcm:pa:ss")}@ss.example.com:8388#name`),
    expected,
  );
  assert.deepEqual(
    outboundFor(`ss://${base64("aes-256-gcm:pa:ss@ss.example.com:8388")}#name`),
    expected,
  );
  assert.deepEqual(
    outboundFor(
      "ss://2022-blake3-aes-128-gcm:a%2Bb%3D@1.2.3.4:443/?plugin=obfs-local%3Bobfs%3Dhttp",
    ),
    {
      type: "shadowsocks",
      server: "1.2.3.4",
      server_port: 443,
      method: "2022-blake3-aes-128-gcm",
      password: "a+b=",
      plugin: "obfs-local",
      plugin_opts: "obfs=http",
      tag: "proxy",
    },
  );
});

test("reads VLESS with REALITY, and its WebSocket early data", () => {
  assert.deepEqual(
    outboundFor(
      `vless://${uuid}@v.example.com:443?security=reality&sni=www.apple.com&pbk=KEY&sid=ab&flow=xtls-rprx-vision&type=tcp`,
    ),
    {
      type: "vless",
      server: "v.example.com",
      server_port: 443,
      uuid,
      flow: "xtls-rprx-vision",
      packet_encoding: "xudp",
      tls: {
        enabled: true,
        server_name: "www.apple.com",
        utls: { enabled: true, fingerprint: "chrome" },
        reality: { enabled: true, public_key: "KEY", short_id: "ab" },
      },
      tag: "proxy",
    },
  );
  assert.deepEqual(
    outboundFor(`vless://${uuid}@1.2.3.4:80?type=ws&path=%2Fray%3Fed%3D2048&host=cdn.example.com`)
      .transport,
    {
      type: "ws",
      path: "/ray",
      headers: { Host: "cdn.example.com" },
      max_early_data: 2048,
      early_data_header_name: "Sec-WebSocket-Protocol",
    },
  );
});

test("reads v2rayN's VMess links, Trojan and Hysteria2", () => {
  const vmess = outboundFor(
    `vmess://${base64(
      JSON.stringify({
        add: "vm.example.com",
        port: 443,
        id: uuid,
        aid: 0,
        net: "grpc",
        path: "svc",
        tls: "tls",
      }),
    )}`,
  );
  assert.equal(vmess.type, "vmess");
  assert.deepEqual(vmess.transport, { type: "grpc", service_name: "svc" });
  assert.deepEqual(vmess.tls, { enabled: true, server_name: "vm.example.com" });

  const trojan = outboundFor("trojan://pw@t.example.com:443?allowInsecure=1");
  assert.equal(trojan.password, "pw");
  assert.deepEqual(trojan.tls, { enabled: true, server_name: "t.example.com", insecure: true });

  assert.deepEqual(outboundFor("hy2://pw@h.example.com:8443?obfs=salamander&obfs-password=x"), {
    type: "hysteria2",
    server: "h.example.com",
    server_port: 8443,
    password: "pw",
    obfs: { type: "salamander", password: "x" },
    tls: { enabled: true, server_name: "h.example.com", alpn: ["h3"] },
    tag: "proxy",
  });
});

test("takes any other proxy as a sing-box outbound in JSON", () => {
  assert.deepEqual(outboundFor('{"type":"tuic","server":"1.2.3.4","server_port":443,"tag":"x"}'), {
    type: "tuic",
    server: "1.2.3.4",
    server_port: 443,
    tag: "proxy",
  });
  assert.throws(() => outboundFor('{"type":"direct"}'), /does not reach a proxy/);
});

test("says what is wrong without repeating a secret", () => {
  for (const [link, why] of [
    ["", /empty/],
    ["ftp://user:secret@host:21", /not supported/],
    ["socks5://user:secret@host:0", /port/],
    [`vless://${uuid}@v.example.com:443?type=xhttp&pbk=secret`, /xhttp transport/],
    [`vless://${uuid}@v.example.com:443?security=reality`, /pbk/],
  ]) {
    assert.throws(
      () => outboundFor(link),
      (error) => why.test(error.message) && !error.message.includes("secret"),
    );
  }
  assert.equal(
    describeOutbound(outboundFor("socks5://user:secret@[2001:db8::1]:1080")),
    "socks [2001:db8::1]:1080",
  );
});

test("tunnels the browser user alone, its DNS too, and fails closed", () => {
  const config = singBoxConfig({ proxy: outboundFor("socks5://1.2.3.4:1080"), uid: 10001 });
  const [tun] = config.inbounds;
  assert.equal(tun.interface_name, TUNNEL_INTERFACE);
  assert.deepEqual(tun.include_uid, [10001]);
  assert.equal(tun.auto_route, true);
  assert.equal(tun.strict_route, true);
  assert.ok(tun.route_exclude_address.includes("172.16.0.0/12"));
  assert.equal(config.route.final, "proxy");
  assert.deepEqual(config.route.rules.at(-1), { protocol: "dns", action: "hijack-dns" });
  assert.equal(config.dns.servers.find((server) => server.tag === "remote").detour, "proxy");
  assert.throws(() => singBoxConfig({ proxy: {}, uid: 0 }), /uid/);
  assert.throws(
    () => singBoxConfig({ proxy: {}, uid: 10001, bootstrapDns: "dns.example" }),
    /EGRESS_BOOTSTRAP_DNS/,
  );
});
