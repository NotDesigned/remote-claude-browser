import { request } from "node:http";
import { ClientSessionError } from "../session/clients";
import type { MihomoProxy } from "./mihomo";
import type { ExitHealth, ExitMetadata } from "./timezone";

export interface RuntimeEgress {
  proxyUrl: string;
  externalProxyUrl: string;
}
export function runtimeRequest<T>(
  path: string,
  method: string,
  body?: unknown,
  socketPath = process.env.MIRROR_RUNTIME_SOCKET ?? "/run/remote-browser/runtime.sock",
): Promise<T> {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        path,
        method,
        headers: encoded
          ? { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) }
          : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString();
            const value = text ? JSON.parse(text) : undefined;
            if (response.statusCode !== undefined && response.statusCode >= 400) {
              // Only the broker's sanitized errors cross into the user interface.
              throw value?.code?.startsWith("EXIT_") || value?.code === "BROWSER_ENGINE_MISSING"
                ? new ClientSessionError(response.statusCode, value.code, value.error)
                : new Error(`网络运行时请求失败（${response.statusCode}）`);
            }
            resolve(value as T);
          } catch (error) {
            reject(error);
          }
        });
        response.on("error", reject);
      },
    );
    req.once("error", reject);
    req.setTimeout(30_000, () => req.destroy(new Error("网络运行时请求超时")));
    req.end(encoded);
  });
}

export function createRuntimeClient(options: { socketPath?: string } = {}) {
  const call = <T>(method: string, path: string, body?: unknown) =>
    runtimeRequest<T>(path, method, body, options.socketPath);
  return {
    startEgress: (id: string, node?: MihomoProxy) =>
      call<RuntimeEgress>(
        "POST",
        `/egress/${encodeURIComponent(id)}/start`,
        node === undefined ? {} : { node },
      ),
    stopEgress: (id: string) => call<void>("DELETE", `/egress/${encodeURIComponent(id)}`),
    timeZoneForEgress: (id = "deployment-default") =>
      call<ExitMetadata>("POST", `/egress/${encodeURIComponent(id)}/timezone`),
    egressStatus: (id: string) =>
      call<ExitHealth>("GET", `/egress/${encodeURIComponent(id)}/status`),
    checkEgress: (id: string) =>
      call<ExitHealth>("POST", `/egress/${encodeURIComponent(id)}/check`),
    browserStatus: (id: string) =>
      call<ExitHealth>("GET", `/browsers/${encodeURIComponent(id)}/status`),
    checkBrowser: (id: string) =>
      call<ExitHealth>("POST", `/browsers/${encodeURIComponent(id)}/check`),
    resolveBrowser: (id: string, hostname: string) =>
      call<Array<{ address: string; family: number }>>(
        "GET",
        `/browsers/${encodeURIComponent(id)}/resolve?hostname=${encodeURIComponent(hostname)}`,
      ),
  };
}
