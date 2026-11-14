import { request, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { CpaError, type CpaInstance } from "./store";

export interface CpaRequest {
  method: string;
  path: string;
  headers?: IncomingHttpHeaders;
  body?: Readable | Buffer | string;
}
export interface CpaDriver {
  ensure(instance: CpaInstance, proxyUrl: string): Promise<void>;
  stop(instance: CpaInstance): Promise<void>;
  status(instance: CpaInstance): Promise<"running" | "stopped" | "missing">;
  request(instance: CpaInstance, input: CpaRequest): Promise<IncomingMessage>;
}

export async function responseJson(response: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > 4 * 1024 * 1024) {
      response.destroy();
      throw new CpaError(502, "CPA_RESPONSE", "CPA 管理响应过大");
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!response.statusCode || response.statusCode >= 400)
    throw new CpaError(502, "CPA_UPSTREAM", "CPA 操作失败，请检查实例状态");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export function createCpaBrokerDriver(socketPath: string): CpaDriver {
  const send = (path: string, input: Omit<CpaRequest, "path">): Promise<IncomingMessage> =>
    new Promise((resolve, reject) => {
      const req = request(
        { socketPath, path, method: input.method, headers: input.headers },
        resolve,
      );
      req.once("error", () => reject(new CpaError(503, "CPA_BROKER", "CPA 运行服务暂不可用")));
      if (input.body instanceof Readable) {
        input.body.once("error", (error) => req.destroy(error));
        input.body.pipe(req);
      } else req.end(input.body);
    });
  const action = async (instance: CpaInstance, name: string, body?: unknown) =>
    responseJson(
      await send(`/instances/${instance.id}/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    );
  return {
    async ensure(instance, proxyUrl) {
      await action(instance, "ensure", {
        apiKey: instance.apiKey,
        managementKey: instance.managementKey,
        proxyUrl,
      });
    },
    async stop(instance) {
      await action(instance, "stop");
    },
    async status(instance) {
      const result = await responseJson(await send(`/instances/${instance.id}`, { method: "GET" }));
      return result.status as "running" | "stopped" | "missing";
    },
    request(instance, input) {
      return send(
        `/instances/${instance.id}/request?path=${encodeURIComponent(input.path)}`,
        input,
      );
    },
  };
}
