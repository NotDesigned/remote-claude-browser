// Sends everything the browser user opens through one outside proxy, by way of a TUN interface that
// sing-box serves. EGRESS_PROXY names the proxy as a share link, or as a sing-box outbound in JSON.
// Only the browser user's traffic enters the tunnel, so the host's own traffic is never touched.
import { writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

export const TUNNEL_INTERFACE = "egress0";
/** The tunnel's address, and the one after it is where its DNS answers. */
export const TUNNEL_ADDRESS = "198.18.0.1/30";
export const TUNNEL_DNS = "198.18.0.2";
/** Looks up the proxy's own name, which cannot go through the proxy. */
export const DEFAULT_BOOTSTRAP_DNS = "1.1.1.1";
/** Answers the browser's lookups by way of the proxy, so they leave from where its pages do. */
const REMOTE_DNS = "1.1.1.1";
/** Neither replies to viewers on these networks nor Docker's own traffic belong in the tunnel. */
const LOCAL_NETWORKS = [
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "224.0.0.0/4",
];

/** An error that names what is wrong without repeating the link, which may hold a password. */
function invalid(why) {
  return new Error(`EGRESS_PROXY: ${why}`);
}

function port(value, what = "the proxy") {
  const number = Number(value);
  if (!/^\d+$/.test(String(value)) || number < 1 || number > 65535)
    throw invalid(`${what} needs a port from 1 to 65535`);
  return number;
}

function host(url) {
  const name = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (name === "") throw invalid("the proxy needs a host");
  return name;
}

function decodeBase64(text) {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  return Buffer.from(normal, "base64").toString("utf8");
}

const truthy = (value) => value === "1" || value === "true";
const list = (value) =>
  value
    ? value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
    : undefined;

/** TLS as share links describe it: sni, alpn, fp, allowInsecure, and REALITY's pbk and sid. */
function tls(params, server, { reality = false } = {}) {
  const sni = params.get("sni") || params.get("peer") || (isIP(server) ? "" : server);
  const fingerprint = params.get("fp") || (reality ? "chrome" : "");
  return {
    enabled: true,
    ...(sni ? { server_name: sni } : {}),
    ...(truthy(params.get("allowInsecure")) || truthy(params.get("insecure"))
      ? { insecure: true }
      : {}),
    ...(list(params.get("alpn")) ? { alpn: list(params.get("alpn")) } : {}),
    ...(fingerprint ? { utls: { enabled: true, fingerprint } } : {}),
    ...(reality
      ? {
          reality: {
            enabled: true,
            public_key: required(params.get("pbk"), "a REALITY link needs pbk"),
            ...(params.get("sid") ? { short_id: params.get("sid") } : {}),
          },
        }
      : {}),
  };
}

function required(value, why) {
  if (!value) throw invalid(why);
  return value;
}

/** The V2Ray transports sing-box has: WebSocket, gRPC, HTTP/2 and HTTPUpgrade. */
function transport(params) {
  const type = params.get("type") || params.get("net") || "tcp";
  const path = params.get("path") || "";
  const hostHeader = params.get("host") || "";
  switch (type) {
    case "tcp":
    case "raw":
      if ((params.get("headerType") || "none") !== "none")
        throw invalid("TCP with a disguised header is not supported");
      return undefined;
    case "ws": {
      // Xray writes early data into the path, as /path?ed=2048.
      const [plain, query = ""] = path.split("?");
      const earlyData = Number(new URLSearchParams(query).get("ed") || 0);
      return {
        type: "ws",
        path: plain || "/",
        ...(hostHeader ? { headers: { Host: hostHeader } } : {}),
        ...(earlyData > 0
          ? { max_early_data: earlyData, early_data_header_name: "Sec-WebSocket-Protocol" }
          : {}),
      };
    }
    case "grpc":
      return { type: "grpc", service_name: params.get("serviceName") || path || "" };
    case "http":
    case "h2":
      return { type: "http", ...(hostHeader ? { host: list(hostHeader) } : {}), path: path || "/" };
    case "httpupgrade":
      return {
        type: "httpupgrade",
        ...(hostHeader ? { host: hostHeader } : {}),
        path: path || "/",
      };
    default:
      throw invalid(`the ${type} transport is not supported`);
  }
}

function withTransport(outbound, params) {
  const chosen = transport(params);
  return chosen ? { ...outbound, transport: chosen } : outbound;
}

function credentials(url) {
  return {
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

function shadowsocks(link) {
  // SIP002 is ss://userinfo@host:port, userinfo being base64 of method:password or, for 2022
  // ciphers, the two percent-encoded. The older form is ss://base64(method:password@host:port).
  const body = link.slice("ss://".length).split("#")[0];
  let url;
  if (body.includes("@")) url = new URL(`ss://${body}`);
  else {
    const [encoded, query = ""] = body.split("?");
    url = new URL(`ss://${decodeBase64(encoded.replace(/\/$/, ""))}${query ? `?${query}` : ""}`);
  }
  let userinfo = decodeURIComponent(url.username);
  if (url.password) userinfo += `:${decodeURIComponent(url.password)}`;
  else if (!userinfo.includes(":")) userinfo = decodeBase64(userinfo);
  const split = userinfo.indexOf(":");
  if (split < 1) throw invalid("a Shadowsocks link needs a method and a password");
  const plugin = url.searchParams.get("plugin");
  const [pluginName, ...pluginOptions] = plugin ? plugin.split(";") : [];
  return {
    type: "shadowsocks",
    server: host(url),
    server_port: port(url.port),
    method: userinfo.slice(0, split),
    password: userinfo.slice(split + 1),
    ...(pluginName ? { plugin: pluginName, plugin_opts: pluginOptions.join(";") } : {}),
  };
}

function vmess(link) {
  let fields;
  try {
    fields = JSON.parse(decodeBase64(link.slice("vmess://".length).split("#")[0]));
  } catch {
    throw invalid("a VMess link must be base64 of its JSON settings");
  }
  const text = (key) =>
    fields[key] === undefined || fields[key] === null ? "" : String(fields[key]);
  const server = required(text("add"), "a VMess link needs add");
  const net = text("net") || "tcp";
  // v2rayN names the transport net, keeps a TCP disguise in type and gRPC's service name in path.
  const params = new URLSearchParams({
    type: net,
    path: text("path"),
    host: text("host"),
    serviceName: net === "grpc" ? text("path") : "",
    headerType: net === "tcp" ? text("type") || "none" : "none",
    sni: text("sni"),
    alpn: text("alpn"),
    fp: text("fp"),
    allowInsecure: text("allowInsecure"),
  });
  const secure = text("tls") === "tls";
  return withTransport(
    {
      type: "vmess",
      server,
      server_port: port(text("port")),
      uuid: required(text("id"), "a VMess link needs id"),
      security: text("scy") || "auto",
      alter_id: Number(text("aid") || 0),
      packet_encoding: "xudp",
      ...(secure ? { tls: tls(params, server) } : {}),
    },
    params,
  );
}

function vless(url) {
  const params = url.searchParams;
  const server = host(url);
  const security = params.get("security") || "none";
  if (!["none", "tls", "reality"].includes(security))
    throw invalid(`VLESS security ${security} is not supported`);
  if ((params.get("encryption") || "none") !== "none")
    throw invalid("VLESS encryption other than none is not supported");
  return withTransport(
    {
      type: "vless",
      server,
      server_port: port(url.port),
      uuid: required(decodeURIComponent(url.username), "a VLESS link needs its UUID"),
      ...(params.get("flow") ? { flow: params.get("flow") } : {}),
      packet_encoding: "xudp",
      ...(security === "none"
        ? {}
        : { tls: tls(params, server, { reality: security === "reality" }) }),
    },
    params,
  );
}

function trojan(url) {
  const params = url.searchParams;
  const server = host(url);
  const security = params.get("security") || "tls";
  return withTransport(
    {
      type: "trojan",
      server,
      server_port: port(url.port || "443"),
      password: required(decodeURIComponent(url.username), "a Trojan link needs its password"),
      ...(security === "none"
        ? {}
        : { tls: tls(params, server, { reality: security === "reality" }) }),
    },
    params,
  );
}

function hysteria2(url) {
  const params = url.searchParams;
  const server = host(url);
  const password = [url.username, url.password].filter(Boolean).map(decodeURIComponent).join(":");
  const obfs = params.get("obfs");
  if (obfs && obfs !== "salamander") throw invalid(`Hysteria2 obfs ${obfs} is not supported`);
  return {
    type: "hysteria2",
    server,
    server_port: port(url.port || "443"),
    password: required(password, "a Hysteria2 link needs its password"),
    ...(obfs
      ? {
          obfs: {
            type: "salamander",
            password: required(params.get("obfs-password"), "Hysteria2 obfs needs obfs-password"),
          },
        }
      : {}),
    tls: { ...tls(params, server), alpn: list(params.get("alpn")) ?? ["h3"] },
  };
}

/** The sing-box outbound EGRESS_PROXY describes, tagged "proxy". */
export function outboundFor(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw invalid("it is empty");
  let outbound;
  if (text.startsWith("{")) {
    try {
      outbound = JSON.parse(text);
    } catch {
      throw invalid("it starts with { but is not JSON");
    }
    if (typeof outbound?.type !== "string") throw invalid("a JSON outbound needs a type");
    if (["direct", "block", "dns", "selector", "urltest"].includes(outbound.type))
      throw invalid(`a ${outbound.type} outbound does not reach a proxy`);
  } else {
    const scheme = text.slice(0, text.indexOf("://")).toLowerCase();
    if (scheme === "ss") outbound = shadowsocks(text);
    else if (scheme === "vmess") outbound = vmess(text);
    else {
      let url;
      try {
        url = new URL(text);
      } catch {
        throw invalid("it is neither a proxy link nor a JSON outbound");
      }
      switch (scheme) {
        case "socks":
        case "socks5":
        case "socks5h":
        case "socks4":
        case "socks4a":
          outbound = {
            type: "socks",
            server: host(url),
            server_port: port(url.port || "1080"),
            version: scheme.startsWith("socks4") ? scheme.slice(5) : "5",
            ...credentials(url),
          };
          break;
        case "http":
        case "https":
          outbound = {
            type: "http",
            server: host(url),
            server_port: port(url.port || (scheme === "https" ? "443" : "80")),
            ...credentials(url),
            ...(scheme === "https" ? { tls: tls(url.searchParams, host(url)) } : {}),
          };
          break;
        case "vless":
          outbound = vless(url);
          break;
        case "trojan":
          outbound = trojan(url);
          break;
        case "hysteria2":
        case "hy2":
          outbound = hysteria2(url);
          break;
        default:
          throw invalid(`${scheme}:// links are not supported; give a sing-box outbound in JSON`);
      }
    }
  }
  return { ...outbound, tag: "proxy" };
}

/** What the logs may say about the proxy: its kind and where it is, never its secrets. */
export function describeOutbound(outbound) {
  const where =
    typeof outbound.server === "string"
      ? ` ${outbound.server.includes(":") ? `[${outbound.server}]` : outbound.server}:${outbound.server_port}`
      : "";
  return `${outbound.type}${where}`;
}

/** The whole sing-box configuration: a TUN for one user, its DNS, and the proxy. */
export function singBoxConfig({ proxy, uid, bootstrapDns = DEFAULT_BOOTSTRAP_DNS }) {
  if (!Number.isSafeInteger(uid) || uid < 1) throw new Error("the browser user's uid is required");
  if (isIP(bootstrapDns) === 0) throw new Error("EGRESS_BOOTSTRAP_DNS must be an IP address");
  return {
    log: { level: "warn", timestamp: false },
    dns: {
      servers: [
        { type: "https", tag: "remote", server: REMOTE_DNS, detour: "proxy" },
        { type: "udp", tag: "bootstrap", server: bootstrapDns },
      ],
      final: "remote",
      strategy: "ipv4_only",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: TUNNEL_INTERFACE,
        address: [TUNNEL_ADDRESS],
        mtu: 1500,
        auto_route: true,
        // Anything the tunnel cannot carry, such as IPv6, fails instead of going around it.
        strict_route: true,
        include_uid: [uid],
        route_exclude_address: LOCAL_NETWORKS,
        stack: "system",
      },
    ],
    outbounds: [proxy],
    route: {
      rules: [{ action: "sniff" }, { protocol: "dns", action: "hijack-dns" }],
      final: "proxy",
      auto_detect_interface: true,
      default_domain_resolver: "bootstrap",
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // node egress-proxy.mjs <browser uid> <config path>: writes the configuration, prints the proxy.
  try {
    const [uid, path] = process.argv.slice(2);
    const proxy = outboundFor(process.env.EGRESS_PROXY);
    const config = singBoxConfig({
      proxy,
      uid: Number(uid),
      bootstrapDns: process.env.EGRESS_BOOTSTRAP_DNS?.trim() || DEFAULT_BOOTSTRAP_DNS,
    });
    await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(describeOutbound(proxy));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
