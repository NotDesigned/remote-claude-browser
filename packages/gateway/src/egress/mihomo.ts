/** Fixed Mihomo configuration: only node settings come from a subscription. */
export const MIHOMO_VERSION = "v1.19.34";
export const MIHOMO_AMD64_SHA256 =
  "0c07340a01408d033dda4088ea2a4c1e4d82aeed7b2f84f7c046e93b6ff3290c";

export type MihomoProxyType = "socks5" | "http" | "ss" | "vmess" | "vless" | "trojan" | "hysteria2";
export interface MihomoProxy extends Record<string, unknown> {
  name: string;
  type: MihomoProxyType;
  server: string;
  port: number;
}
export type MihomoExit = MihomoProxy | { name: string; type: "direct" };

export interface MihomoConfigOptions {
  tun: boolean;
  listenAddress: string;
  port: number;
  dnsPort?: number;
  device?: string;
  bootstrapDns?: string;
  tunAddress?: string;
  block?: string[];
}

export function createMihomoConfig(node: MihomoExit, options: MihomoConfigOptions) {
  const bootstrap = options.bootstrapDns ?? "1.1.1.1";
  const exit = node.type === "direct" ? "DIRECT" : "EXIT";
  return {
    "mixed-port": options.port,
    "bind-address": options.listenAddress,
    "allow-lan": options.listenAddress !== "127.0.0.1",
    ipv6: false,
    mode: "rule",
    "log-level": "silent",
    "find-process-mode": "off",
    "geodata-mode": false,
    "geo-auto-update": false,
    profile: { "store-selected": false, "store-fake-ip": false },
    dns: {
      enable: true,
      listen: `127.0.0.1:${options.dnsPort ?? 1053}`,
      ipv6: false,
      "enhanced-mode": "redir-host",
      "use-hosts": false,
      "use-system-hosts": false,
      "default-nameserver": [bootstrap],
      "proxy-server-nameserver": [bootstrap],
      // Proxy hostnames bootstrap directly; website DNS always crosses the selected exit.
      nameserver: [`https://1.1.1.1/dns-query#${exit}`],
      "respect-rules": true,
    },
    tun: {
      enable: options.tun,
      device: options.device ?? "profiletun",
      stack: "mixed",
      "auto-route": false,
      "auto-redirect": false,
      "auto-detect-interface": false,
      "inet4-address": [options.tunAddress ?? "198.18.0.1/30"],
      "dns-hijack": ["any:53", "tcp://any:53"],
    },
    proxies: node.type === "direct" ? [] : [{ ...node, name: "EXIT" }],
    rules: [
      ...[
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/4",
        "240.0.0.0/4",
      ].map((range) => `IP-CIDR,${range},REJECT,no-resolve`),
      ...(options.block ?? []).map((address) => {
        const ipv6 = address.includes(":");
        const range = address.includes("/") ? address : `${address}/${ipv6 ? 128 : 32}`;
        return `${ipv6 ? "IP-CIDR6" : "IP-CIDR"},${range},REJECT,no-resolve`;
      }),
      `MATCH,${exit}`,
    ],
  };
}
