// Xray's TUN receives only the browser UID's traffic, selected by egress-tunnel.sh.
// Share links are converted locally; credentials never enter the browser's environment.
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

export const TUNNEL_INTERFACE = "egress0";
export const TUNNEL_ADDRESS = "198.18.0.1/30";
export const TUNNEL_DNS = "198.18.0.2";
export const DEFAULT_BOOTSTRAP_DNS = "1.1.1.1";

const invalid = (why) => new Error(`EGRESS_PROXY: ${why}`);
const required = (value, why) => {
  if (!value) throw invalid(why);
  return value;
};
const truthy = (value) => value === "1" || value === "true";
const list = (value) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
const decodeBase64 = (value) => Buffer.from(value, "base64url").toString("utf8");
function port(value) {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || number < 1 || number > 65535)
    throw invalid("the proxy needs a port from 1 to 65535");
  return number;
}
const host = (url) => required(url.hostname.replace(/^\[(.*)\]$/, "$1"), "the proxy needs a host");
function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalid("invalid percent encoding");
  }
}
function key(value, length, name) {
  if (!value || !/^[\w-]+$/.test(value) || Buffer.from(value, "base64url").length !== length)
    throw invalid(`${name} must be a base64url key of ${length} bytes`);
  return value;
}

function security(params, server, fallback = "none") {
  const type = params.get("security") || fallback;
  if (type === "none") return { security: "none" };
  const serverName = params.get("sni") || params.get("peer") || (isIP(server) ? "" : server);
  const fingerprint = params.get("fp") || "chrome";
  if (type === "reality") {
    const shortId = params.get("sid") || "";
    if (!/^(?:[0-9a-fA-F]{2}){0,8}$/.test(shortId)) throw invalid("invalid REALITY sid");
    return {
      security: "reality",
      realitySettings: {
        serverName: required(serverName, "REALITY needs sni"),
        fingerprint,
        password: key(params.get("pbk"), 32, "REALITY pbk"),
        shortId,
        ...(params.get("pqv")
          ? { mldsa65Verify: key(params.get("pqv"), 1952, "REALITY pqv") }
          : {}),
        spiderX: params.get("spx") || "/",
      },
    };
  }
  if (type !== "tls") throw invalid("unsupported transport security");
  if (truthy(params.get("allowInsecure")) || truthy(params.get("insecure")))
    throw invalid(
      "Xray removed allowInsecure; use pcs (certificate SHA256) or vcn (certificate name)",
    );
  return {
    security: "tls",
    tlsSettings: {
      ...(serverName ? { serverName } : {}),
      fingerprint,
      ...(list(params.get("alpn"))?.length ? { alpn: list(params.get("alpn")) } : {}),
      ...(params.get("pcs") ? { pinnedPeerCertSha256: params.get("pcs") } : {}),
      ...(params.get("vcn") ? { verifyPeerCertByName: params.get("vcn") } : {}),
    },
  };
}

function transport(params) {
  const type = params.get("type") || params.get("net") || "tcp";
  const path = params.get("path") || "/";
  const hostname = params.get("host");
  switch (type) {
    case "tcp":
    case "raw":
      if ((params.get("headerType") || "none") !== "none")
        throw invalid("TCP disguised headers are not supported");
      return { network: "raw" };
    case "ws":
      return { network: "ws", wsSettings: { path, ...(hostname ? { host: hostname } : {}) } };
    case "grpc":
      return {
        network: "grpc",
        grpcSettings: {
          serviceName: params.get("serviceName") || params.get("path") || "",
          ...(hostname ? { authority: hostname } : {}),
          ...(params.get("mode") === "multi" ? { multiMode: true } : {}),
        },
      };
    case "httpupgrade":
      return {
        network: "httpupgrade",
        httpupgradeSettings: { path, ...(hostname ? { host: hostname } : {}) },
      };
    case "xhttp":
    case "splithttp": {
      let extra;
      if (params.has("extra")) {
        try {
          extra = JSON.parse(params.get("extra"));
        } catch {
          throw invalid("XHTTP extra is not JSON");
        }
        if (!extra || typeof extra !== "object" || Array.isArray(extra))
          throw invalid("XHTTP extra must be an object");
      }
      return {
        network: "xhttp",
        xhttpSettings: {
          path,
          mode: params.get("mode") || "auto",
          ...(hostname ? { host: hostname } : {}),
          ...(extra ? { extra } : {}),
        },
      };
    }
    default:
      throw invalid("unsupported transport; use raw, ws, grpc, httpupgrade or xhttp");
  }
}
const stream = (params, server, fallback) => ({
  ...transport(params),
  ...security(params, server, fallback),
});

function vless(url) {
  const params = url.searchParams,
    server = host(url);
  return {
    protocol: "vless",
    settings: {
      address: server,
      port: port(url.port),
      id: required(decode(url.username), "VLESS needs a UUID"),
      encryption: params.get("encryption") || "none",
      ...(params.get("flow") ? { flow: params.get("flow") } : {}),
    },
    streamSettings: stream(params, server),
  };
}
function shadowsocks(link) {
  const body = link.slice(5).split("#")[0];
  let url;
  try {
    if (body.includes("@")) url = new URL(`ss://${body}`);
    else {
      const [encoded, query = ""] = body.split("?");
      url = new URL(`ss://${decodeBase64(encoded.replace(/\/$/, ""))}${query ? `?${query}` : ""}`);
    }
  } catch {
    throw invalid("invalid Shadowsocks link");
  }
  if (url.searchParams.get("plugin"))
    throw invalid("Shadowsocks plugins are not supported by Xray");
  let info = decode(url.username);
  if (url.password) info += `:${decode(url.password)}`;
  else if (!info.includes(":")) info = decodeBase64(info);
  const split = info.indexOf(":");
  if (split < 1) throw invalid("Shadowsocks needs a method and password");
  return {
    protocol: "shadowsocks",
    settings: {
      address: host(url),
      port: port(url.port),
      method: info.slice(0, split),
      password: info.slice(split + 1),
    },
  };
}
function vmess(link) {
  let fields;
  try {
    fields = JSON.parse(decodeBase64(link.slice(8).split("#")[0]));
  } catch {
    throw invalid("VMess needs base64 JSON settings");
  }
  if (!fields || typeof fields !== "object") throw invalid("VMess needs an object");
  if (Number(fields.aid || 0) !== 0) throw invalid("Xray requires VMess AEAD (aid=0)");
  const text = (key) => String(fields[key] ?? "");
  const server = required(text("add"), "VMess needs add");
  const params = new URLSearchParams({
    type: text("net") || "tcp",
    path: text("path"),
    host: text("host"),
    serviceName: text("net") === "grpc" ? text("path") : "",
    sni: text("sni"),
    alpn: text("alpn"),
    fp: text("fp"),
    headerType: text("net") === "tcp" ? text("type") || "none" : "none",
    allowInsecure: text("allowInsecure"),
    security: text("tls") === "tls" ? "tls" : "none",
  });
  return {
    protocol: "vmess",
    settings: {
      address: server,
      port: port(text("port")),
      id: required(text("id"), "VMess needs id"),
      security: text("scy") || "auto",
    },
    streamSettings: stream(params, server),
  };
}
function hysteria2(url) {
  const params = url.searchParams,
    server = host(url);
  const obfs = params.get("obfs");
  if (obfs && obfs !== "salamander") throw invalid("unsupported Hysteria2 obfs");
  return {
    protocol: "hysteria",
    settings: { version: 2, address: server, port: port(url.port || "443") },
    streamSettings: {
      network: "hysteria",
      ...security(params, server, "tls"),
      hysteriaSettings: {
        version: 2,
        auth: required(
          [url.username, url.password].filter(Boolean).map(decode).join(":"),
          "Hysteria2 needs a password",
        ),
      },
      ...(obfs
        ? {
            finalmask: {
              udp: [
                {
                  type: "salamander",
                  settings: {
                    password: required(
                      params.get("obfs-password"),
                      "Salamander needs obfs-password",
                    ),
                  },
                },
              ],
            },
          }
        : {}),
    },
  };
}
export function outboundFor(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw invalid("it is empty");
  let outbound;
  if (text.startsWith("{")) {
    try {
      outbound = JSON.parse(text);
    } catch {
      throw invalid("it starts with { but is not JSON");
    }
    if (typeof outbound?.protocol !== "string")
      throw invalid("JSON must be an Xray outbound with protocol; migrate old sing-box JSON");
    if (["freedom", "blackhole", "dns", "loopback"].includes(outbound.protocol))
      throw invalid("the outbound does not reach a proxy");
  } else if (text.startsWith("ss://")) outbound = shadowsocks(text);
  else if (text.startsWith("vmess://")) outbound = vmess(text);
  else {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw invalid("it is neither a proxy link nor Xray outbound JSON");
    }
    const server = host(url);
    switch (url.protocol) {
      case "vless:":
        outbound = vless(url);
        break;
      case "trojan:":
        outbound = {
          protocol: "trojan",
          settings: {
            address: server,
            port: port(url.port || "443"),
            password: required(decode(url.username), "Trojan needs a password"),
          },
          streamSettings: stream(url.searchParams, server, "tls"),
        };
        break;
      case "socks:":
      case "socks5:":
      case "socks5h:":
      case "http:":
      case "https:":
        outbound = {
          protocol: url.protocol.startsWith("socks") ? "socks" : "http",
          settings: {
            address: server,
            port: port(
              url.port ||
                (url.protocol.startsWith("socks")
                  ? "1080"
                  : url.protocol === "https:"
                    ? "443"
                    : "80"),
            ),
            ...(url.username ? { user: decode(url.username), pass: decode(url.password) } : {}),
          },
          ...(url.protocol === "https:"
            ? { streamSettings: security(url.searchParams, server, "tls") }
            : {}),
        };
        break;
      case "hy2:":
      case "hysteria2:":
        outbound = hysteria2(url);
        break;
      default:
        throw invalid("unsupported share link protocol; give an Xray outbound in JSON");
    }
  }
  return { ...outbound, tag: "proxy" };
}
function endpoint(outbound) {
  const settings = outbound.settings;
  return settings?.address ? settings : settings?.servers?.[0] || settings?.vnext?.[0];
}
export function describeOutbound(outbound) {
  const target = endpoint(outbound);
  const server = target?.address;
  return `${outbound.protocol}${typeof server === "string" ? ` ${server.includes(":") ? `[${server}]` : server}:${target.port}` : ""}`;
}
export function xrayConfig({ proxy, bootstrapDns = DEFAULT_BOOTSTRAP_DNS }) {
  if (isIP(bootstrapDns) !== 4) throw new Error("EGRESS_BOOTSTRAP_DNS must be an IPv4 address");
  const server = endpoint(proxy)?.address;
  const bootstrap =
    typeof server === "string" && !isIP(server)
      ? [
          {
            address: bootstrapDns,
            domains: [`full:${server}`],
            skipFallback: true,
            tag: "bootstrap-dns",
          },
        ]
      : [];
  return {
    log: { loglevel: "warning", access: "none" },
    dns: {
      servers: [...bootstrap, { address: "https://1.1.1.1/dns-query", tag: "remote-dns" }],
      queryStrategy: "UseIPv4",
      disableFallbackIfMatch: true,
    },
    inbounds: [
      {
        tag: "tun-in",
        protocol: "tun",
        settings: { name: TUNNEL_INTERFACE, mtu: 1500, gateway: [TUNNEL_ADDRESS] },
      },
    ],
    outbounds: [
      {
        ...proxy,
        streamSettings: {
          ...proxy.streamSettings,
          sockopt: { ...proxy.streamSettings?.sockopt, domainStrategy: "UseIPv4" },
        },
      },
      {
        tag: "dns-out",
        protocol: "dns",
        settings: {
          rules: [
            { qType: "1,28", action: "hijack" },
            { action: "return", rCode: 0 },
          ],
        },
      },
      { tag: "bootstrap", protocol: "freedom" },
    ],
    routing: {
      domainStrategy: "AsIs",
      rules: [
        {
          type: "field",
          inboundTag: ["bootstrap-dns"],
          ip: [bootstrapDns],
          port: "53",
          outboundTag: "bootstrap",
        },
        { type: "field", inboundTag: ["remote-dns"], outboundTag: "proxy" },
        { type: "field", inboundTag: ["tun-in"], port: "53", outboundTag: "dns-out" },
      ],
    },
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [path] = process.argv.slice(2);
    const proxy = outboundFor(process.env.EGRESS_PROXY);
    const config = xrayConfig({
      proxy,
      bootstrapDns: process.env.EGRESS_BOOTSTRAP_DNS?.trim() || DEFAULT_BOOTSTRAP_DNS,
    });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(describeOutbound(proxy));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid proxy configuration");
    process.exit(1);
  }
}
