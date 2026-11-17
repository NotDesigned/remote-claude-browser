import { ProxyAgent, request } from "undici";
import { isIP } from "node:net";

export interface ExitMetadata {
  timeZone: string;
  exitCity?: string;
  exitCountry?: string;
  exitIp?: string;
  checkedAt?: number;
}

export interface ExitHealth extends Partial<ExitMetadata> {
  status: "unchecked" | "checking" | "healthy" | "error";
  error?: string;
  browserTimeZone?: string;
}

export class ExitTimeZoneError extends Error {
  readonly code: string;
  constructor(code = "EXIT_CONNECT", message = "无法通过所选代理连接外网，请检查节点连通性") {
    super(message);
    this.code = code;
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
        throw new ExitTimeZoneError(
          "EXIT_LOOKUP",
          `出口地区查询服务返回 HTTP ${response.statusCode}，请稍后重试`,
        );
      }
      const data = (await response.body.json()) as {
        ip?: unknown;
        timezone?: { id?: unknown };
        city?: unknown;
        country?: unknown;
      };
      const timeZone = data.timezone?.id;
      if (typeof data.ip !== "string" || !isIP(data.ip))
        throw new ExitTimeZoneError("EXIT_DATA", "出口地区查询未返回有效 IP 地址");
      if (typeof timeZone !== "string" || !timeZone || /^[+-]/.test(timeZone))
        throw new ExitTimeZoneError("EXIT_DATA", "出口地区查询未返回有效时区");
      const exitCity = typeof data.city === "string" ? data.city.trim() : "";
      const exitCountry = typeof data.country === "string" ? data.country.trim() : "";
      return {
        exitIp: data.ip,
        checkedAt: Date.now(),
        timeZone: new Intl.DateTimeFormat("en", { timeZone }).resolvedOptions().timeZone,
        ...(exitCity ? { exitCity } : {}),
        ...(exitCountry ? { exitCountry } : {}),
      };
    } finally {
      await dispatcher?.close();
    }
  } catch (error) {
    if (error instanceof ExitTimeZoneError) throw error;
    const failure = error as { code?: string; name?: string; cause?: { code?: string } };
    const code = failure.cause?.code ?? failure.code ?? failure.name;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN")
      throw new ExitTimeZoneError("EXIT_DNS", "出口检查的域名解析失败，请检查节点和 DNS");
    if (code === "TimeoutError" || code === "ETIMEDOUT" || code?.includes("TIMEOUT"))
      throw new ExitTimeZoneError("EXIT_TIMEOUT", "通过所选代理检查出口超时，请检查节点连通性");
    if (error instanceof SyntaxError || error instanceof RangeError)
      throw new ExitTimeZoneError("EXIT_DATA", "出口地区查询返回的数据或时区无效");
    throw new ExitTimeZoneError();
  }
}

export async function detectExitTimeZone(
  options: Parameters<typeof detectExitMetadata>[0] = {},
): Promise<string> {
  return (await detectExitMetadata(options)).timeZone;
}
