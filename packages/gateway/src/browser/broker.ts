import { request } from "node:http";
import { connect as connectSocket } from "node:net";
import type { ConnectionTransport } from "puppeteer-core";
import { chromiumLaunchArgs, connectBrowserTransport, type LaunchOpts } from "./launch";
import { ClientSessionError } from "../session/clients";

export async function runtimeRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: process.env.MIRROR_RUNTIME_SOCKET,
        path,
        method,
        headers: { "content-type": "application/json" },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (response.statusCode !== 200)
              return reject(
                body.code === "EXIT_TIMEZONE"
                  ? new ClientSessionError(503, "EXIT_TIMEZONE", body.error)
                  : new Error("浏览器网络运行时未就绪"),
              );
            resolve(body as T);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export async function pipeTransport(path: string): Promise<ConnectionTransport> {
  const socket = connectSocket(path);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const transport: ConnectionTransport = {
    send(message) {
      socket.write(message + "\0");
    },
    close() {
      socket.destroy();
    },
  };
  let pending = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    pending += chunk;
    let separator: number;
    while ((separator = pending.indexOf("\0")) !== -1) {
      const message = pending.slice(0, separator);
      pending = pending.slice(separator + 1);
      transport.onmessage?.(message);
    }
  });
  socket.on("close", () => transport.onclose?.());
  return transport;
}

export async function launchBrokerBrowser(id: string, node: unknown, opts: LaunchOpts) {
  const started = await runtimeRequest<{ socketPath: string; proxyUrl: string; timeZone: string }>(
    `/browsers/${id}/start`,
    "POST",
    {
      node,
      options: {
        userDataDir: opts.userDataDir,
        args: chromiumLaunchArgs(opts.args, {
          headful: opts.headful,
          enableExtensions: opts.enableExtensions,
        }),
        env: opts.env,
      },
    },
  );
  const stop = () => runtimeRequest(`/browsers/${id}`, "DELETE");
  try {
    const browser = await connectBrowserTransport(await pipeTransport(started.socketPath));
    const close = browser.close.bind(browser);
    browser.close = async () => {
      try {
        await close();
      } finally {
        await stop();
      }
    };
    browser.kill = async () => {
      await stop();
    };
    return { browser, proxyUrl: started.proxyUrl, timeZone: started.timeZone };
  } catch (error) {
    await stop();
    throw error;
  }
}
