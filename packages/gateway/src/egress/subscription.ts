import { parse } from "yaml";
import type { MihomoProxy, MihomoProxyType } from "./mihomo";

const fields: Record<MihomoProxyType, readonly string[]> = {
  socks5: [
    "username",
    "password",
    "tls",
    "udp",
    "skip-cert-verify",
    "name-cert-verify",
    "fingerprint",
  ],
  http: [
    "username",
    "password",
    "tls",
    "sni",
    "skip-cert-verify",
    "name-cert-verify",
    "fingerprint",
  ],
  ss: ["cipher", "password", "udp", "udp-over-tcp"],
  vmess: [
    "uuid",
    "alterId",
    "cipher",
    "tls",
    "udp",
    "servername",
    "skip-cert-verify",
    "client-fingerprint",
    "alpn",
    "network",
    "ws-opts",
    "grpc-opts",
    "packet-encoding",
  ],
  vless: [
    "uuid",
    "flow",
    "encryption",
    "tls",
    "udp",
    "servername",
    "skip-cert-verify",
    "client-fingerprint",
    "alpn",
    "network",
    "ws-opts",
    "grpc-opts",
    "xhttp-opts",
    "reality-opts",
    "packet-encoding",
  ],
  trojan: [
    "password",
    "udp",
    "sni",
    "skip-cert-verify",
    "client-fingerprint",
    "alpn",
    "network",
    "ws-opts",
    "grpc-opts",
  ],
  hysteria2: ["password", "obfs", "obfs-password", "sni", "skip-cert-verify", "up", "down", "alpn"],
};
const common = new Set(["name", "type", "server", "port", "ip-version"]);

/** Subscription globals are never imported: no remote rules, listeners, scripts or providers. */
export function parseSubscription(content: string): MihomoProxy[] {
  let text = content.trim();
  if (!text) throw new Error("代理源内容不能为空");
  if (/^[A-Za-z0-9+/_=\s-]+$/.test(text)) {
    const decoded = Buffer.from(text.replace(/\s/g, ""), "base64url").toString("utf8").trim();
    if (decoded.includes("://")) text = decoded;
  }
  if (/^(socks5?|https?|ss|vmess|vless|trojan|hy2|hysteria2):\/\//i.test(text))
    return text
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => validateProxy(parseShareLink(line.trim())));
  let data: { proxies?: unknown } | unknown[];
  try {
    data = parse(text, { maxAliasCount: 0 });
  } catch {
    throw new Error("订阅格式错误；请提供 Mihomo YAML/JSON 或代理分享链接");
  }
  const nodes = Array.isArray(data) ? data : data?.proxies;
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("订阅需要包含 proxies 节点列表");
  return nodes.map(validateProxy);
}

export function parseProxyShareLink(text: string): MihomoProxy {
  return validateProxy(parseShareLink(text.trim()));
}

export function validateProxy(value: unknown): MihomoProxy {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("代理节点必须是对象");
  const node = value as Record<string, unknown>;
  if (typeof node.type !== "string" || !Object.hasOwn(fields, node.type))
    throw new Error("不支持的代理类型；支持 socks5、http、ss、vmess、vless、trojan、hysteria2");
  const type = node.type as MihomoProxyType;
  if (
    typeof node.server !== "string" ||
    !node.server.trim() ||
    !Number.isInteger(node.port) ||
    Number(node.port) < 1 ||
    Number(node.port) > 65535
  )
    throw new Error("代理节点需要有效的服务器和端口");
  if (typeof node.name !== "string" || !node.name.trim()) throw new Error("代理节点需要名称");
  for (const key of Object.keys(node))
    if (!common.has(key) && !fields[type].includes(key))
      throw new Error(`代理类型 ${type} 不支持参数 ${key}`);
  if (["vmess", "vless"].includes(type) && typeof node.uuid !== "string")
    throw new Error(`${type} 节点需要 UUID`);
  if (["ss", "trojan", "hysteria2"].includes(type) && typeof node.password !== "string")
    throw new Error(`${type} 节点需要密码`);
  if (type === "ss" && typeof node.cipher !== "string")
    throw new Error("Shadowsocks 节点需要 cipher");
  if (node.network !== undefined && !["tcp", "ws", "grpc", "xhttp"].includes(String(node.network)))
    throw new Error("只支持 tcp、ws、grpc、xhttp 传输");
  // Nested transport options are data only. File paths and outbound chains are intentionally absent.
  for (const [key, allowed] of Object.entries({
    "ws-opts": ["path", "headers", "max-early-data", "early-data-header-name"],
    "grpc-opts": ["grpc-service-name"],
    "reality-opts": ["public-key", "short-id", "support-x25519mlkem768", "mldsa65-verify"],
    "xhttp-opts": [
      "path",
      "host",
      "mode",
      "headers",
      "no-grpc-header",
      "x-padding-bytes",
      "sc-max-each-post-bytes",
      "sc-min-posts-interval-ms",
      "sc-stream-up-server-secs",
    ],
  })) {
    if (node[key] === undefined) continue;
    const options = node[key];
    if (!options || typeof options !== "object" || Array.isArray(options))
      throw new Error(`${key} 必须是对象`);
    for (const field of Object.keys(options))
      if (!allowed.includes(field)) throw new Error(`${key} 不支持参数 ${field}`);
  }
  return structuredClone(node) as MihomoProxy;
}

function parseShareLink(text: string): Record<string, unknown> {
  if (text.startsWith("vmess://")) {
    let v: Record<string, string>;
    try {
      v = JSON.parse(Buffer.from(text.slice(8), "base64url").toString("utf8"));
    } catch {
      throw new Error("VMess 分享链接需要有效的 base64 JSON");
    }
    if (v.type && v.type !== "none") throw new Error("VMess 分享链接不支持伪装头");
    if (v.net && !["tcp", "ws", "grpc"].includes(v.net)) throw new Error("不支持的 VMess 传输");
    const result: Record<string, unknown> = {
      name: v.ps || "VMess",
      type: "vmess",
      server: v.add,
      port: Number(v.port),
      uuid: v.id,
      alterId: Number(v.aid || 0),
      cipher: v.scy || "auto",
      udp: true,
      tls: v.tls === "tls",
    };
    if (v.sni) result.servername = v.sni;
    if (v.fp) result["client-fingerprint"] = v.fp;
    if (v.alpn) result.alpn = v.alpn.split(",");
    if (v.allowInsecure === "1" || v.allowInsecure === "true") result["skip-cert-verify"] = true;
    if (v.net === "ws") {
      result.network = "ws";
      result["ws-opts"] = { path: v.path || "/", ...(v.host ? { headers: { Host: v.host } } : {}) };
    }
    if (v.net === "grpc") {
      result.network = "grpc";
      result["grpc-opts"] = { "grpc-service-name": v.path || "" };
    }
    return result;
  }
  if (text.startsWith("ss://")) {
    const [body = "", fragment = ""] = text.slice(5).split("#");
    const uri = new URL(
      `ss://${body.includes("@") ? body : Buffer.from(body, "base64url").toString("utf8")}`,
    );
    if (uri.search) throw new Error("Shadowsocks 插件参数暂不支持");
    const credentials = uri.password
      ? `${decodeURIComponent(uri.username)}:${decodeURIComponent(uri.password)}`
      : Buffer.from(uri.username, "base64url").toString("utf8");
    const split = credentials.indexOf(":");
    return {
      name: decodeURIComponent(fragment) || "Shadowsocks",
      type: "ss",
      server: uri.hostname.replace(/^\[|\]$/g, ""),
      port: Number(uri.port),
      cipher: credentials.slice(0, split),
      password: credentials.slice(split + 1),
      udp: true,
    };
  }
  const uri = new URL(text);
  const type = uri.protocol.slice(0, -1);
  const name = decodeURIComponent(uri.hash.slice(1)) || uri.hostname;
  const base = {
    name,
    server: uri.hostname.replace(/^\[|\]$/g, ""),
    port: Number(
      uri.port ||
        (type === "https"
          ? 443
          : type === "http"
            ? 80
            : ["hy2", "hysteria2"].includes(type)
              ? 443
              : 0),
    ),
  };
  if (["socks", "socks5", "http", "https"].includes(type)) {
    if (uri.search) throw new Error("SOCKS/HTTP 分享链接不支持查询参数");
    return {
      ...base,
      type: type.startsWith("socks") ? "socks5" : "http",
      ...(uri.username ? { username: decodeURIComponent(uri.username) } : {}),
      ...(uri.password ? { password: decodeURIComponent(uri.password) } : {}),
      ...(type === "https" ? { tls: true } : {}),
      ...(type.startsWith("socks") ? { udp: true } : {}),
    };
  }
  const p = uri.searchParams;
  const supported = new Set([
    "type",
    "security",
    "sni",
    "peer",
    "fp",
    "alpn",
    "flow",
    "encryption",
    "pbk",
    "sid",
    "pqv",
    "path",
    "host",
    "serviceName",
    "mode",
    "obfs",
    "obfs-password",
    "insecure",
    "allowInsecure",
  ]);
  for (const key of p.keys()) if (!supported.has(key)) throw new Error(`分享链接不支持参数 ${key}`);
  if (["hy2", "hysteria2"].includes(type))
    return {
      ...base,
      type: "hysteria2",
      password: decodeURIComponent([uri.username, uri.password].filter(Boolean).join(":")),
      ...(p.get("sni") ? { sni: p.get("sni") } : {}),
      ...(p.get("obfs") ? { obfs: p.get("obfs"), "obfs-password": p.get("obfs-password") } : {}),
      ...(p.get("insecure") === "1" ? { "skip-cert-verify": true } : {}),
    };
  if (!["vless", "trojan"].includes(type)) throw new Error("不支持的代理分享链接");
  const result: Record<string, unknown> = {
    ...base,
    type,
    udp: true,
    ...(type === "vless"
      ? { uuid: decodeURIComponent(uri.username), encryption: p.get("encryption") || "none" }
      : { password: decodeURIComponent(uri.username) }),
  };
  const security = p.get("security") || (type === "trojan" ? "tls" : "none");
  if (!["none", "tls", "reality"].includes(security)) throw new Error("不支持的传输加密");
  if (security !== "none" && type !== "trojan") result.tls = true;
  const servername = p.get("sni") || p.get("peer");
  if (servername) result[type === "trojan" ? "sni" : "servername"] = servername;
  if (p.get("fp")) result["client-fingerprint"] = p.get("fp");
  if (p.get("alpn")) result.alpn = p.get("alpn")!.split(",");
  if (p.get("flow")) result.flow = p.get("flow");
  if (p.get("insecure") === "1" || p.get("allowInsecure") === "1")
    result["skip-cert-verify"] = true;
  if (security === "reality")
    result["reality-opts"] = {
      "public-key": p.get("pbk"),
      "short-id": p.get("sid") || "",
      ...(p.get("pqv") ? { "mldsa65-verify": p.get("pqv") } : {}),
    };
  const network = p.get("type") || "tcp";
  if (network !== "tcp") result.network = network;
  if (network === "ws")
    result["ws-opts"] = {
      path: p.get("path") || "/",
      ...(p.get("host") ? { headers: { Host: p.get("host") } } : {}),
    };
  if (network === "grpc") result["grpc-opts"] = { "grpc-service-name": p.get("serviceName") || "" };
  if (network === "xhttp")
    result["xhttp-opts"] = {
      path: p.get("path") || "/",
      ...(p.get("host") ? { host: p.get("host") } : {}),
      mode: p.get("mode") || "auto",
    };
  return result;
}
