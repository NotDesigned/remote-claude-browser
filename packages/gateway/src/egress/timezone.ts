import { ProxyAgent, request } from "undici";

export interface ExitMetadata {
  timeZone: string;
  exitCity?: string;
  exitCountry?: string;
}

export class ExitTimeZoneError extends Error {
  constructor() {
    super("无法获取所选出口的时区，请检查代理后重试");
    this.name = "ExitTimeZoneError";
  }
}

/** Resolve the exit's location and zone through the browser's actual HTTP proxy. */
export async function detectExitMetadata({
  proxyUrl,
  url = "https://ipwho.is/",
}: {
  proxyUrl?: string;
  url?: string;
} = {}): Promise<ExitMetadata> {
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
      const data = (await response.body.json()) as {
        timezone?: { id?: unknown };
        city?: unknown;
        country?: unknown;
      };
      const timeZone = data.timezone?.id;
      if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone))
        throw new Error("Exit timezone lookup returned an invalid IANA zone");
      const exitCity = typeof data.city === "string" ? data.city.trim() : "";
      const exitCountry = typeof data.country === "string" ? data.country.trim() : "";
      return {
        timeZone: new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone,
        ...(exitCity ? { exitCity } : {}),
        ...(exitCountry ? { exitCountry } : {}),
      };
    } finally {
      await dispatcher?.close();
    }
  } catch {
    throw new ExitTimeZoneError();
  }
}

export async function detectExitTimeZone(
  options: Parameters<typeof detectExitMetadata>[0] = {},
): Promise<string> {
  return (await detectExitMetadata(options)).timeZone;
}
