/**
 * Outbound-target policy shared by every gateway-side fetch that a user can steer (asset proxy
 * fallback, proxy subscriptions): only public unicast addresses may be reached.
 *
 * Checking a hostname and then letting the HTTP client resolve it again leaves a DNS-rebinding
 * window. `createPublicOnlyAgent` closes it: the socket's own lookup resolves once, rejects the
 * whole answer if any address is non-public, and the socket connects to exactly those addresses.
 */
import { lookup as dnsLookupCallback, type LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, buildConnector } from "undici";

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type TargetLookup = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export class PrivateTargetError extends Error {
  readonly code = "EPRIVATETARGET";
  constructor() {
    super("Private network target rejected");
    this.name = "PrivateTargetError";
  }
}

export async function defaultTargetLookup(hostname: string): Promise<readonly ResolvedAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

/** Resolve-then-check every address so a hostname cannot hide a non-public destination. */
export async function rejectPrivateTarget(
  target: string,
  lookup: TargetLookup = defaultTargetLookup,
): Promise<void> {
  const parsed = new URL(target);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PrivateTargetError();
  }
  const hostname = unbracket(parsed.hostname);
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily === 0 ? await lookup(hostname) : [{ address: hostname, family: literalFamily }];
  if (addresses.length === 0) throw new Error("Target resolved to no addresses");
  if (addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new PrivateTargetError();
  }
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A `net.connect` lookup that only ever hands the socket public addresses. */
export function createPublicOnlyLookup(
  resolve: (hostname: string) => Promise<readonly ResolvedAddress[]> = defaultTargetLookup,
) {
  return (hostname: string, options: { all?: boolean } | number, callback: LookupCallback) => {
    const all = typeof options === "object" && options?.all === true;
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          const error: NodeJS.ErrnoException = new Error(`No addresses for ${hostname}`);
          error.code = "ENOTFOUND";
          return callback(error, "");
        }
        if (addresses.some(({ address }) => isPrivateAddress(address))) {
          return callback(new PrivateTargetError() as NodeJS.ErrnoException, "");
        }
        if (all) return callback(null, addresses.map((item) => ({ ...item })) as LookupAddress[]);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };
}

/** Undici agent whose connections can reach public addresses only (literal or resolved). */
export function createPublicOnlyAgent(
  options: {
    resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
    connectTimeoutMs?: number;
  } = {},
): Agent {
  const base = buildConnector({
    lookup: createPublicOnlyLookup(options.resolve) as unknown as typeof dnsLookupCallback,
    ...(options.connectTimeoutMs === undefined ? {} : { timeout: options.connectTimeoutMs }),
  });
  return new Agent({
    connect: (connectOptions, callback) => {
      // net.connect skips the lookup for IP literals, so check those here.
      const literal = unbracket(connectOptions.hostname);
      if (isIP(literal) !== 0 && isPrivateAddress(literal)) {
        callback(new PrivateTargetError(), null);
        return;
      }
      base(connectOptions, callback);
    },
  });
}

export function isPrivateAddress(address: string): boolean {
  const normalized = unbracket(address).toLowerCase().split("%", 1)[0]!;
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  // Anything that is not a parseable IP literal is not a routable public address.
  if (isIP(normalized) !== 6) return true;

  const words = parseIpv6(normalized);
  if (words === undefined) return true;
  const [w0, w1, w2, w3, w4, w5, w6, w7] = words as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const embedded = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;

  // ::/128 unspecified, ::1/128 loopback, ::/96 IPv4-compatible, ::ffff:0:0/96 IPv4-mapped,
  // ::ffff:0:0:0/96 IPv4-translated.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) {
    if (w4 === 0 && w5 === 0) {
      if (w6 === 0) return true; // ::/112 contains :: and ::1 and is never public
      return isPrivateIpv4(embedded(w6, w7));
    }
    if ((w4 === 0 && w5 === 0xffff) || (w4 === 0xffff && w5 === 0)) {
      return isPrivateIpv4(embedded(w6, w7));
    }
    return true;
  }
  // 64:ff9b::/96 NAT64 well-known prefix: judge the IPv4 it translates to.
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return isPrivateIpv4(embedded(w6, w7));
  }
  // 64:ff9b:1::/48 local-use NAT64.
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 1) return true;
  // 100::/64 discard-only.
  if (w0 === 0x100 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  // 2001::/32 Teredo tunnels an obfuscated IPv4; 2001:2::/48 benchmarking.
  if (w0 === 0x2001 && (w1 === 0 || (w1 === 2 && w2 === 0))) return true;
  // 2002::/16 6to4: judge the embedded IPv4.
  if (w0 === 0x2002) return isPrivateIpv4(embedded(w1, w2));
  // fc00::/7 unique-local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((w0 & 0xfe00) === 0xfc00) return true;
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;
  if ((w0 & 0xff00) === 0xff00) return true;
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking, also Mihomo's fake-IP range
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
}

function parseIpv6(address: string): number[] | undefined {
  let text = address;
  // Expand a dotted IPv4 tail (::ffff:127.0.0.1) into two hextets.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    const high = ((octets[0]! << 8) | octets[1]!).toString(16);
    const low = ((octets[2]! << 8) | octets[3]!).toString(16);
    text = `${text.slice(0, dotted.index)}${high}:${low}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 1 || halves[1] === "" ? [] : halves[1]!.split(":");
  const parsedLeft = parseHextets(left);
  const parsedRight = parseHextets(right);
  if (parsedLeft === undefined || parsedRight === undefined) return undefined;
  const missing = 8 - parsedLeft.length - parsedRight.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return undefined;
  }
  return [...parsedLeft, ...Array.from({ length: missing }, () => 0), ...parsedRight];
}

function parseHextets(parts: string[]): number[] | undefined {
  const output: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    output.push(Number.parseInt(part, 16));
  }
  return output;
}

function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
