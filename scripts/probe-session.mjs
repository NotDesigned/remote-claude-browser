/** Shared credentials and owned temporary workspaces for manually invoked production probes. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

export async function readProbeCredentials({ env = process.env, read = readFile } = {}) {
  const text = await read("/etc/claude-browser/agent.env", "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const file = Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).replace(/\r$/, "")];
      }),
  );
  const username =
    env.MIRROR_PROBE_USERNAME ??
    env.SMOKE_USERNAME ??
    env.MIRROR_ADMIN_USERNAME ??
    file.MIRROR_ADMIN_USERNAME ??
    "admin";
  const password =
    env.MIRROR_PROBE_PASSWORD ??
    env.SMOKE_PASSWORD ??
    env.MIRROR_ACCESS_PASSWORD ??
    file.MIRROR_ACCESS_PASSWORD;
  if (!username || !password)
    throw new Error(
      "Set MIRROR_PROBE_USERNAME and MIRROR_PROBE_PASSWORD, or provide the local maintenance credential file",
    );
  return { username, password };
}

export async function createProbeSession(
  origin,
  { env = process.env, fetcher = fetch, credentials } = {},
) {
  const headers = { Origin: env.MIRROR_PUBLIC_ORIGIN || origin };
  const login = await fetcher(origin + "/gate", {
    method: "POST",
    redirect: "manual",
    headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(credentials ?? (await readProbeCredentials({ env }))),
    signal: AbortSignal.timeout(20000),
  });
  if (login.status !== 303) throw new Error(`Probe login failed (${login.status})`);
  headers.Cookie = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  if (!headers.Cookie) throw new Error("Probe login did not set a session cookie");
  const api = (path, method = "GET", body) =>
    fetcher(origin + path, {
      method,
      redirect: "manual",
      headers: {
        ...headers,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
  let sid;
  let closed = false;
  const sockets = new Set();
  const close = async () => {
    if (closed) return;
    closed = true;
    const failures = [];
    for (const socket of sockets) {
      try {
        if (typeof socket.terminate === "function") socket.terminate();
        else socket.close();
      } catch (error) {
        failures.push(error);
      }
    }
    if (sid) {
      try {
        const response = await api(`/api/client/session/${encodeURIComponent(sid)}`, "DELETE");
        if (response.status !== 204)
          throw new Error(`Temporary workspace release failed (${response.status})`);
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      const response = await api("/logout", "POST");
      if (response.status !== 204) throw new Error(`Probe logout failed (${response.status})`);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) throw new AggregateError(failures, "Probe cleanup failed");
  };
  try {
    const response = await api("/api/client/session", "POST", { clientKey: randomUUID() });
    if (response.status !== 200)
      throw new Error(`Temporary workspace admission failed (${response.status})`);
    const lease = await response.json();
    if (typeof lease.sid !== "string" || !/^client-[1-9]\d*$/.test(lease.sid))
      throw new Error("Probe received an invalid workspace");
    sid = lease.sid;
    const socketUrl = new URL("/ws", origin);
    socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("sid", sid);
    socketUrl.searchParams.set("connectionKey", randomUUID());
    return {
      sid,
      headers,
      api,
      socketUrl: socketUrl.href,
      attach(socket) {
        sockets.add(socket);
        return socket;
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Probe setup and cleanup failed");
    }
    throw error;
  }
}
