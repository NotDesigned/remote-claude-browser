import { request } from "node:http";
import type { MihomoProxy } from "./mihomo";
import type { ExitMetadata } from "./timezone";

export interface RuntimeEgress {
  proxyUrl: string;
  externalProxyUrl: string;
}
export function createRuntimeClient(options: { socketPath?: string } = {}) {
  const socketPath = options.socketPath ?? "/run/remote-browser/runtime.sock";
  const call = <T>(method: string, path: string, body?: unknown) =>
    new Promise<T>((resolve, reject) => {
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
            const value = Buffer.concat(chunks).toString();
            if (response.statusCode !== undefined && response.statusCode >= 400) {
              // Runtime diagnostics and proxy credentials stay in its private logs.
              reject(new Error(`网络运行时请求失败（${response.statusCode}）`));
            } else {
              try {
                resolve((value ? JSON.parse(value) : undefined) as T);
              } catch (error) {
                reject(error);
              }
            }
          });
          response.on("error", reject);
        },
      );
      req.once("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("网络运行时请求超时")));
      req.end(encoded);
    });
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
  };
}
