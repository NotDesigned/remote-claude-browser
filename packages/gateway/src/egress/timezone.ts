import { ProxyAgent, request } from "undici";

export class ExitTimeZoneError extends Error {
  constructor() {
    super("无法获取所选出口的时区，请检查代理后重试");
    this.name = "ExitTimeZoneError";
  }
}

/** Resolve the exit's zone through the same HTTP proxy used by this browser. */
export async function detectExitTimeZone({
  proxyUrl,
  url = "https://ipwho.is/",
}: {
  proxyUrl?: string;
  url?: string;
} = {}): Promise<string> {
  try {
    const dispatcher = proxyUrl === undefined ? undefined : new ProxyAgent(proxyUrl);
    try {
      const response = await request(url, {
        dispatcher,
        signal: AbortSignal.timeout(15_000),
      });
      if (response.statusCode !== 200) {
        await response.body.dump();
        throw new Error("Exit timezone lookup failed");
      }
      const data = (await response.body.json()) as { timezone?: { id?: unknown } };
      const timeZone = data.timezone?.id;
      if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone))
        throw new Error("Exit timezone lookup returned an invalid IANA zone");
      return new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone;
    } finally {
      await dispatcher?.close();
    }
  } catch {
    throw new ExitTimeZoneError();
  }
}
