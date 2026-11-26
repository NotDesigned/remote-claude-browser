// @vitest-environment node
import type { NotifyAgentOut } from "@mirror/protocol";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { installNotificationShim } from "./notifications";

/** A page's window in its own realm, so the shim's Function.prototype patch stays inside it. */
async function fakePage() {
  const context = createContext({
    EventTarget,
    Event,
    setTimeout,
    structuredClone,
  });
  const target = runInContext("globalThis", context) as Record<string, unknown>;
  let nativeHidden = false;
  class FakeDocument extends EventTarget {
    baseURI = "https://claude.ai/chat/1";
    get hidden() {
      return nativeHidden;
    }
    get visibilityState() {
      return nativeHidden ? "hidden" : "visible";
    }
    hasFocus() {
      return !nativeHidden;
    }
  }
  // The real interfaces define these as accessors on the prototype.
  for (const name of ["hidden", "visibilityState"])
    Object.defineProperty(FakeDocument.prototype, name, {
      ...Object.getOwnPropertyDescriptor(FakeDocument.prototype, name),
      enumerable: true,
    });
  class FakeRegistration {}
  (FakeRegistration.prototype as unknown as Record<string, unknown>).showNotification = () =>
    Promise.reject(new TypeError("blocked"));
  class FakeStatus extends EventTarget {
    state = "denied";
    onchange: ((event: Event) => void) | null = null;
  }
  class FakePermissions {
    async query(descriptor: { name: string }) {
      void descriptor;
      const status = new FakeStatus();
      status.addEventListener("change", (event) => status.onchange?.(event));
      return status;
    }
  }
  const document = new FakeDocument();
  Object.assign(target, {
    Document: FakeDocument,
    document,
    location: { origin: "https://claude.ai" },
    ServiceWorkerRegistration: FakeRegistration,
    Permissions: FakePermissions,
    setTimeout,
  });
  const sent: NotifyAgentOut[] = [];
  const shim = installNotificationShim(
    target as unknown as Window & typeof globalThis,
    (message) => void sent.push(message),
  );
  const run = <T>(code: string): T => runInContext(code, context) as T;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    target,
    document,
    sent,
    shim,
    run,
    setNativeHidden: (value: boolean) => (nativeHidden = value),
    registration: new FakeRegistration() as unknown as ServiceWorkerRegistration,
    permissions: new FakePermissions() as unknown as Permissions,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the page's Notification", () => {
  it("starts at default, says hello, and asks the viewer through the gateway", async () => {
    const page = await fakePage();
    expect(page.sent).toEqual([{ op: "hello", origin: "https://claude.ai" }]);
    expect(page.run("Notification.permission")).toBe("default");
    const answers: string[] = [];
    const asked = page.run<Promise<string>>(
      "Notification.requestPermission((value) => globalThis.callbackAnswer = value)",
    );
    expect(page.sent[1]).toEqual({ op: "ask", req: 1, origin: "https://claude.ai" });
    page.shim.receive({ answer: 1, permission: "granted" });
    answers.push(await asked);
    await tick();
    expect(answers).toEqual(["granted"]);
    expect(page.run("globalThis.callbackAnswer")).toBe("granted");
    expect(page.run("Notification.permission")).toBe("granted");
    // Answered: no new question.
    expect(await page.run<Promise<string>>("Notification.requestPermission()")).toBe("granted");
    expect(page.sent).toHaveLength(2);
  });

  it("reports an error and sends nothing without permission", async () => {
    const page = await fakePage();
    page.shim.receive({ permission: "denied", away: false });
    page.run(`
      globalThis.errors = 0;
      const n = new Notification("Done");
      n.onerror = () => globalThis.errors++;
    `);
    await tick();
    expect(page.run("globalThis.errors")).toBe(1);
    expect(page.sent.filter((message) => message.op === "show")).toEqual([]);
  });

  it("sends a granted notification and fires the device's events on it", async () => {
    const page = await fakePage();
    page.shim.receive({ permission: "granted", away: false });
    page.run(`
      globalThis.events = [];
      globalThis.n = new Notification("Claude", {
        body: "Your reply is ready", icon: "/icon.png", tag: "chat", data: { secret: 1 },
      });
      n.onshow = () => events.push("show");
      n.onclick = (event) => events.push("click:" + event.cancelable);
      n.addEventListener("close", () => events.push("close"));
    `);
    expect(page.sent[1]).toEqual({
      op: "show",
      id: 1,
      origin: "https://claude.ai",
      title: "Claude",
      body: "Your reply is ready",
      icon: "https://claude.ai/icon.png",
      tag: "chat",
    });
    expect(page.run("n.data")).toEqual({ secret: 1 });
    page.shim.receive({ event: 1, type: "show" });
    page.shim.receive({ event: 1, type: "click" });
    page.shim.receive({ event: 1, type: "close" });
    // Gone: a late event changes nothing.
    page.shim.receive({ event: 1, type: "click" });
    expect(page.run("events")).toEqual(["show", "click:true", "close"]);
  });

  it("closes from the page, telling the gateway once", async () => {
    const page = await fakePage();
    page.shim.receive({ permission: "granted", away: false });
    page.run(`
      globalThis.closed = 0;
      globalThis.n = new Notification("x");
      n.onclose = () => closed++;
      n.close();
      n.close();
    `);
    await tick();
    expect(page.sent.filter((message) => message.op === "close")).toEqual([{ op: "close", id: 1 }]);
    expect(page.run("closed")).toBe(1);
  });

  it("replaces an open notification with the same tag", async () => {
    const page = await fakePage();
    page.shim.receive({ permission: "granted", away: false });
    const registration = page.registration;
    await registration.showNotification("one", { tag: "t" });
    await registration.showNotification("two", { tag: "t" });
    await registration.showNotification("other", { tag: "u" });
    const open = await registration.getNotifications({ tag: "t" });
    expect(open.map((notification) => notification.title)).toEqual(["two"]);
    expect((await registration.getNotifications()).length).toBe(2);
    expect(page.sent.filter((message) => message.op === "show").map((m) => m.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("refuses showNotification without permission, as Chromium does", async () => {
    const page = await fakePage();
    await expect(page.registration.showNotification("x")).rejects.toThrow(/permission/);
  });

  it("looks like the browser's own to a quick inspection", async () => {
    const page = await fakePage();
    expect(page.run("Function.prototype.toString.call(Notification)")).toBe(
      "function Notification() { [native code] }",
    );
    expect(page.run("Function.prototype.toString.call(Function.prototype.toString)")).toBe(
      "function toString() { [native code] }",
    );
    expect(
      page.run(
        "Function.prototype.toString.call(Object.getOwnPropertyDescriptor(Notification, 'permission').get)",
      ),
    ).toBe("function get permission() { [native code] }");
    expect(page.run("(() => 1).toString()")).toBe("() => 1");
    expect(page.run("Notification.length")).toBe(1);
    expect(page.run("Notification.name")).toBe("Notification");
    expect(page.run("Object.prototype.toString.call(Notification.prototype)")).toBe(
      "[object Notification]",
    );
    expect(page.run("Object.getPrototypeOf(Notification) === EventTarget")).toBe(true);
    expect(page.run("Object.keys(globalThis).includes('Notification')")).toBe(false);
    expect(() => page.run("Notification('x')")).toThrow(/'new' operator/);
    expect(() => page.run("new Notification()")).toThrow(/1 argument required/);
    expect(() => page.run("Notification.prototype.title")).toThrow(/Illegal invocation/);
    page.shim.receive({ permission: "granted", away: false });
    expect(page.run("new Notification('x') instanceof Notification")).toBe(true);
    expect(page.run("new Notification('x') instanceof EventTarget")).toBe(true);
    expect(() => page.run("new Notification('x', { renotify: true })")).toThrow(/tag/);
  });

  it("answers permissions.query with the viewer's state, and reports changes", async () => {
    const page = await fakePage();
    const status = await page.permissions.query({ name: "notifications" });
    expect(status.state).toBe("default");
    let changes = 0;
    status.onchange = () => changes++;
    page.shim.receive({ permission: "granted", away: false });
    expect(status.state).toBe("granted");
    expect(changes).toBe(1);
    const other = await page.permissions.query({ name: "geolocation" as PermissionName });
    expect(other.state).toBe("denied");
  });

  it("hides the page while nobody looks, only once it may notify", async () => {
    const page = await fakePage();
    let changes = 0;
    page.document.addEventListener("visibilitychange", () => changes++);
    const hidden = () => page.run("document.hidden");
    page.shim.receive({ permission: "default", away: true });
    expect(hidden()).toBe(false);
    expect(page.run("document.hasFocus()")).toBe(true);
    page.shim.receive({ permission: "granted", away: true });
    expect(hidden()).toBe(true);
    expect(page.run("document.visibilityState")).toBe("hidden");
    expect(page.run("document.hasFocus()")).toBe(false);
    expect(changes).toBe(1);
    page.shim.receive({ permission: "granted", away: false });
    expect(hidden()).toBe(false);
    expect(changes).toBe(2);
    // Hidden for real: the page heard it from the browser already.
    page.setNativeHidden(true);
    page.shim.receive({ permission: "granted", away: true });
    expect(changes).toBe(2);
    expect(hidden()).toBe(true);
  });
});
