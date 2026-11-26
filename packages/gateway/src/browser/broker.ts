import { connect as connectSocket } from "node:net";
import type { ConnectionTransport } from "puppeteer-core";
import { chromiumLaunchArgs, connectBrowserTransport, type LaunchOpts } from "./launch";
import { runtimeRequest } from "../egress/runtime-client";
import type { ExitMetadata } from "../egress/timezone";
import { recordPhases, timed } from "../timing";

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

/** Starts the profile's exit network and its lookup, ahead of launchBrokerBrowser. */
export async function prepareBrokerBrowser(id: string, node: unknown): Promise<void> {
  await runtimeRequest(`/browsers/${id}/prepare`, "POST", { node });
}

/** Closes the profile's browser, or removes its prepared exit when it has none. */
export async function stopBrokerBrowser(id: string): Promise<void> {
  await runtimeRequest(`/browsers/${id}`, "DELETE");
}

/**
 * `timeZone`, the zone the exit had last time, lets the runtime start the browser while it looks
 * the exit up again; the browser it answers with always has the zone the lookup found.
 */
export async function launchBrokerBrowser(
  id: string,
  node: unknown,
  opts: LaunchOpts,
  timeZone?: string,
) {
  const started = await runtimeRequest<
    ExitMetadata & { socketPath: string; proxyUrl: string; phases?: unknown }
  >(`/browsers/${id}/start`, "POST", {
    node,
    ...(timeZone === undefined ? {} : { timeZone }),
    options: {
      userDataDir: opts.userDataDir,
      engine: opts.engine,
      args: chromiumLaunchArgs(opts.args, {
        headful: opts.headful,
        enableExtensions: opts.enableExtensions,
      }),
      env: opts.env,
    },
  });
  recordPhases("broker-", started.phases);
  const stop = () => stopBrokerBrowser(id);
  try {
    const browser = await timed("cdp", async () =>
      connectBrowserTransport(await pipeTransport(started.socketPath)),
    );
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
    return {
      browser,
      proxyUrl: started.proxyUrl,
      timeZone: started.timeZone,
      exitCity: started.exitCity,
      exitCountry: started.exitCountry,
      exitIp: started.exitIp,
      checkedAt: started.checkedAt,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
