import Fastify from "fastify";
import { expect, it } from "vitest";
import type { FrontendUser } from "../auth/users";
import { registerErrorHandler } from "../http-errors";
import type { ProxyCatalog } from "./catalog";
import { createExitCheckLimiter } from "./probe-limit";
import { registerProxyRoutes } from "./routes";
import type { ExitHealth } from "./timezone";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

it("runs at most a few exit checks per user and in all, and frees a slot when one ends", async () => {
  const limiter = createExitCheckLimiter({ perUser: 2, total: 3 });
  const gate = deferred();
  const started: string[] = [];
  const check = (user: string) =>
    limiter.run(user, async () => {
      started.push(user);
      await gate.promise;
      return user;
    });
  const running = [check("a"), check("a"), check("b")];
  await expect(check("a")).rejects.toMatchObject({ statusCode: 429, code: "EXIT_CHECK_BUSY" });
  await expect(check("c")).rejects.toMatchObject({ statusCode: 429 });
  expect(started).toEqual(["a", "a", "b"]);
  gate.resolve();
  expect(await Promise.all(running)).toEqual(["a", "a", "b"]);
  expect(limiter.running).toBe(0);
  expect(await limiter.run("c", async () => "done")).toBe("done");
  await expect(
    limiter.run("c", async () => {
      throw new Error("probe failed");
    }),
  ).rejects.toThrow("probe failed");
  expect(limiter.running).toBe(0);
});

it("answers 429 on the node check route while the user's checks are running", async () => {
  const limiter = createExitCheckLimiter({ perUser: 1 });
  const gate = deferred();
  const user = { id: "u", username: "u", role: "user", enabled: true } as FrontendUser;
  const app = Fastify();
  registerErrorHandler(app, () => undefined);
  registerProxyRoutes(app, {
    catalog: { getNodeConfig: () => ({}) } as unknown as ProxyCatalog,
    currentUser: () => user,
    checkProxy: (owner) =>
      limiter.run(owner.id, async (): Promise<ExitHealth> => {
        await gate.promise;
        return { status: "healthy", checkedAt: 1 };
      }),
  });
  try {
    const first = app.inject({ method: "POST", url: "/api/proxies/n/check" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const busy = await app.inject({ method: "POST", url: "/api/proxies/n/check" });
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toMatchObject({ code: "EXIT_CHECK_BUSY" });
    gate.resolve();
    expect((await first).statusCode).toBe(200);
  } finally {
    await app.close();
  }
});
