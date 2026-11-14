import { describe, expect, it } from "vitest";
import { createMihomoConfig } from "./mihomo";
import { parseProxyShareLink, parseSubscription } from "./subscription";

const uuid = "11111111-1111-4111-8111-111111111111";
describe("Mihomo subscription import", () => {
  it("imports only nodes from YAML and never imports a source's routes or listeners", () => {
    const [node] = parseSubscription(
      "proxies:\n  - name: Private\n    type: socks5\n    server: proxy.example\n    port: 1080\n    udp: true\nlisteners:\n  - port: 9999\nrules: [MATCH,DIRECT]\n",
    );
    const config = createMihomoConfig(node!, {
      tun: true,
      listenAddress: "10.253.0.2",
      port: 8780,
    });
    expect(config.proxies[0]).toMatchObject({ name: "EXIT", type: "socks5" });
    expect(config.rules.at(-1)).toBe("MATCH,EXIT");
    expect(config.tun["auto-route"]).toBe(false);
    expect(config.dns.nameserver).toEqual(["https://1.1.1.1/dns-query#EXIT"]);
    expect(config.dns["proxy-server-nameserver"]).toEqual(["1.1.1.1"]);
    expect(config).not.toHaveProperty("listeners");
    expect(() => parseSubscription("proxies: [{name: secret-password, type: [}")).toThrow(
      "订阅格式错误",
    );
  });
  it("parses SOCKS/HTTP, Shadowsocks, VMess and VLESS/Trojan/Hysteria2 links", () => {
    expect(parseProxyShareLink("https://user:password@proxy.example:443#TLS")).toMatchObject({
      type: "http",
      tls: true,
      username: "user",
      password: "password",
    });
    expect(parseProxyShareLink("socks5://user:password@proxy.example:1080#SOCKS")).toMatchObject({
      type: "socks5",
      udp: true,
    });
    expect(
      parseProxyShareLink(
        `ss://${Buffer.from("aes-128-gcm:password").toString("base64url")}@proxy.example:443#SS`,
      ),
    ).toMatchObject({ type: "ss", cipher: "aes-128-gcm", password: "password" });
    expect(
      parseProxyShareLink(
        `vmess://${Buffer.from(JSON.stringify({ ps: "VMess", add: "proxy.example", port: 443, id: uuid, aid: 0, net: "ws", path: "/websocket", host: "cdn.example", tls: "tls" })).toString("base64url")}`,
      ),
    ).toMatchObject({
      type: "vmess",
      tls: true,
      network: "ws",
      "ws-opts": { path: "/websocket", headers: { Host: "cdn.example" } },
    });
    expect(
      parseProxyShareLink(
        `vless://${uuid}@proxy.example:443?security=reality&sni=example.com&pbk=key&sid=aa&type=xhttp&path=%2Fgate&encryption=none#VLESS`,
      ),
    ).toMatchObject({
      type: "vless",
      tls: true,
      network: "xhttp",
      "xhttp-opts": { path: "/gate" },
      "reality-opts": { "public-key": "key", "short-id": "aa" },
    });
    expect(
      parseProxyShareLink("trojan://password@proxy.example:443?sni=example.com#TLS"),
    ).toMatchObject({ type: "trojan", password: "password" });
    expect(
      parseProxyShareLink(
        "hy2://password@proxy.example:443?obfs=salamander&obfs-password=hidden#QUIC",
      ),
    ).toMatchObject({ type: "hysteria2", password: "password", obfs: "salamander" });
    expect(
      parseSubscription(
        Buffer.from("socks5://proxy.example:1080#One\nhttp://proxy.example:8080#Two").toString(
          "base64",
        ),
      ),
    ).toHaveLength(2);
  });
  it("rejects unsupported behavior instead of silently discarding its settings", () => {
    expect(() =>
      parseProxyShareLink(`vless://${uuid}@proxy.example:443?spx=%2Fcamouflage`),
    ).toThrow("spx");
    expect(() =>
      parseProxyShareLink("ss://YWVzLTEyOC1nY206cGFzc3dvcmQ@proxy.example:443?plugin=obfs-local"),
    ).toThrow("插件");
    expect(() =>
      parseSubscription(JSON.stringify({ proxies: [{ name: "direct", type: "direct" }] })),
    ).toThrow("不支持的代理类型");
    expect(() =>
      parseSubscription(
        JSON.stringify({
          proxies: [
            {
              name: "file",
              type: "http",
              server: "example.com",
              port: 443,
              "private-key": "/etc/secret",
            },
          ],
        }),
      ),
    ).toThrow("private-key");
    const config = createMihomoConfig(
      { name: "deployment", type: "direct" },
      { tun: false, listenAddress: "127.0.0.1", port: 8782 },
    );
    expect(config.proxies).toEqual([]);
    expect(config.rules.at(-1)).toBe("MATCH,DIRECT");
    expect(config.dns.nameserver).toEqual(["https://1.1.1.1/dns-query#DIRECT"]);
  });
});
