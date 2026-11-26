import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import type { FrontendUser } from "../auth/users";
import { codeAnswer, type ErrorStyle } from "../http-errors";
import { ASSET_CONTENT_SECURITY_POLICY } from "../assets/route";
import { SECURITY_HEADERS } from "../security-headers";
import { cpaManagementPath } from "./routes";
import { CpaError } from "./store";
import type { CpaRuntime } from "./runtime";

/** The official panel uses the workbench session; instance management secrets stay on the server. */
function panelBridge(prefix: string, scope: string) {
  return `<script>(()=>{
    const prefix=${JSON.stringify(prefix)}, scope=${JSON.stringify(scope)};
    Object.defineProperty(window,'localStorage',{value:{
      getItem:k=>sessionStorage.getItem(scope+k),
      setItem:(k,v)=>sessionStorage.setItem(scope+k,v),
      removeItem:k=>sessionStorage.removeItem(scope+k)
    }});
    const route=value=>{const u=new URL(value,location.href);return u.origin===location.origin&&/^\\/(v8|v0)\\/management(?:\\/|$)/.test(u.pathname)?prefix+u.pathname+u.search:value;};
    const open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open=function(method,url,...args){return open.call(this,method,route(url),...args);};
    const fetch=window.fetch;
    window.fetch=(input,init)=>fetch.call(window,typeof input==='string'?route(input):input,init);
    const observer=new MutationObserver(()=>{
      const input=document.querySelector('input[name="cpa-management-key"]');
      if(!input||input.readOnly)return;
      observer.disconnect();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'workbench-session');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      requestAnimationFrame(()=>input.form.requestSubmit());
    });
    observer.observe(document.documentElement,{childList:true,subtree:true});
  })();</script>`;
}

const MANAGE_PREFIX = /^\/api\/cpa\/instances\/[^/?#]+\/manage(\/.*)$/;

/** Types the panel reads as data keep their type; markup and script become plain text. */
export function managementContentType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const essence = value.split(";", 1)[0]!.trim().toLowerCase();
  if (essence === "") return undefined;
  if (MANAGEMENT_CONTENT_TYPES.has(essence) || essence.endsWith("+json")) return value;
  return essence.startsWith("text/") ||
    essence.endsWith("+xml") ||
    essence.endsWith("/xml") ||
    essence.includes("javascript") ||
    essence.includes("ecmascript")
    ? "text/plain; charset=utf-8"
    : "application/octet-stream";
}

const MANAGEMENT_CONTENT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "text/plain",
  "text/event-stream",
  "text/csv",
  "application/octet-stream",
  "application/zip",
  "application/gzip",
  "application/x-yaml",
  "application/yaml",
]);

/** The CPA panel answers `{ error: code, message }`; anything else is the panel unavailable. */
export const cpaManagementErrors: ErrorStyle = (error) =>
  error instanceof CpaError
    ? codeAnswer(error)
    : { status: 502, body: { error: "CPA_MANAGEMENT", message: "CPA 管理页面暂不可用" } };

export function registerCpaManagementRoutes(
  app: FastifyInstance,
  options: {
    runtime: CpaRuntime;
    currentUser(request: IncomingMessage): FrontendUser | null | undefined;
    panelFile?: string;
  },
) {
  const userFor = (request: IncomingMessage) => {
    const user = options.currentUser(request);
    if (!user?.enabled) throw new CpaError(401, "LOGIN_REQUIRED", "请先登录工作台");
    return user;
  };
  const config = { errors: cpaManagementErrors };
  let panel: Promise<string> | undefined;
  app.get("/management.html", { config }, async (request, reply) => {
    const user = userFor(request.raw);
    const managed = (await options.runtime.list(user)).filter((instance) => instance.canManage);
    const instance = managed.find((instance) => instance.ownerId === user.id) ?? managed[0];
    if (!instance) throw new CpaError(404, "CPA_UNKNOWN", "请先在工作台创建 CPA 实例");
    return reply.redirect(`/api/cpa/instances/${instance.id}/manage/management.html`);
  });
  app.get<{ Params: { id: string } }>(
    "/api/cpa/instances/:id/manage/management.html",
    { config },
    async (request, reply) => {
      const user = userFor(request.raw);
      const instance = options.runtime.managementInstance(user, request.params.id);
      const title = `CPA · ${instance.scope === "shared" ? "共享实例" : user.username}`;
      panel ??= readFile(options.panelFile ?? join(process.cwd(), "cpa-management.html"), "utf8");
      const html = await panel;
      const prefix = `/api/cpa/instances/${request.params.id}/manage`;
      return reply
        .header("cache-control", "no-store")
        .type("text/html; charset=utf-8")
        .send(
          html.replace(
            "<head>",
            "<head>" +
              panelBridge(prefix, `cpa-panel:${user.id}:${request.params.id}:`) +
              `<script>document.title=${JSON.stringify(title)}</script>`,
          ),
        );
    },
  );
  void app.register(async (native) => {
    native.removeAllContentTypeParsers();
    native.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    native.route<{ Params: { id: string; "*": string }; Body: Buffer }>({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      url: "/api/cpa/instances/:id/manage/*",
      bodyLimit: 33_554_432,
      config,
      async handler(request, reply) {
        const user = userFor(request.raw);
        // Forward exactly the path that was checked: taken from the raw URL, dot segments
        // resolved, and refused when it hides a separator or a dot behind percent-encoding.
        const rest = MANAGE_PREFIX.exec(request.raw.url ?? "")?.[1];
        const path = rest === undefined ? undefined : cpaManagementPath(rest);
        if (path === undefined) throw new CpaError(404, "CPA_ROUTE", "没有这个管理接口");
        const headers = { ...request.headers };
        for (const name of [
          "host",
          "cookie",
          "authorization",
          "x-management-key",
          "content-length",
          "connection",
        ])
          delete headers[name];
        const response = await options.runtime.managementRequest(user, request.params.id, {
          method: request.method,
          path,
          headers,
          body: request.body,
        });
        reply.code(response.statusCode ?? 502).header("cache-control", "no-store");
        for (const name of [
          "content-encoding",
          "vary",
          "x-cpa-version",
          "x-cpa-build-date",
          "x-cpa-support-plugin",
          "x-server-version",
          "x-server-build-date",
        ])
          if (response.headers[name] !== undefined) reply.header(name, response.headers[name]);
        // These answers are data for the panel's scripts, served on the gateway's origin: never
        // a document or script of their own, and a download only ever as an attachment.
        const type = managementContentType(response.headers["content-type"]);
        if (type !== undefined) reply.header("content-type", type);
        const disposition = response.headers["content-disposition"];
        if (typeof disposition === "string" && /^\s*attachment\s*(;|$)/i.test(disposition))
          reply.header("content-disposition", disposition);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
        reply.header("content-security-policy", ASSET_CONTENT_SECURITY_POLICY);
        return reply.send(response);
      },
    });
  });
}
