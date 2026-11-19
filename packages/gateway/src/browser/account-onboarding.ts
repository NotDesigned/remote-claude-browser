import { setTimeout as pause } from "node:timers/promises";
import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Protocol } from "puppeteer-core";
import type { ClientBrowserScope } from "./client-scope";

const APPLE_ACCOUNT = "https://account.apple.com/account";
const APPLE_FORM = "https://appleid.apple.com/widget/account/";
const CLAUDE_LOGIN = "https://claude.ai/login";

type Browser = Pick<ClientBrowserScope, "send" | "targets">;
interface OnboardingSession {
  browser: Browser;
  open(url: string): Promise<string>;
}

interface AppleDetails {
  firstName: string;
  lastName: string;
  country: string;
  birthday: string;
  email: string;
  phoneCode: string;
  phone: string;
}

const requiredText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const emailField = { ...requiredText(254), pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" };
const appleDetails = {
  firstName: requiredText(100),
  lastName: requiredText(100),
  country: { type: "string", pattern: "^[A-Z]{3}$" },
  birthday: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  email: emailField,
  phoneCode: { type: "string", pattern: "^[A-Z]{2}$" },
  phone: requiredText(40),
};
const bodyOf = (properties: Record<string, unknown>) => ({
  type: "object",
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
});

export function registerAccountOnboarding(
  app: FastifyInstance,
  requireSession: preHandlerAsyncHookHandler,
  session: (sid: string) => OnboardingSession | undefined,
): void {
  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    await requireSession.call(app, request, reply);
    if (!reply.sent && !session((request.params as { sid: string }).sid))
      return reply.code(409).send({ error: "请先连接当前浏览器" });
  };
  const route = "/api/client/session/:sid/onboarding";
  app.post<{ Params: { sid: string } }>(`${route}/apple`, { preHandler }, async (request) => {
    const current = session(request.params.sid)!;
    const tab = await current.open(APPLE_ACCOUNT);
    const options = await waitForForm<RegistrationOptions>(
      current.browser,
      tab,
      APPLE_FORM,
      `
      const options = (name) => Array.from(document.querySelector('select[name="' + name + '"]').options,
        ({ value, text }) => [value, text]);
      if (!document.querySelector('input[name="phoneNumber"]')) return null;
      return { countries: options("countrySelect"), phoneCodes: options("phoneCode") };
    `,
    );
    return { tab, options };
  });
  app.post<{ Params: { sid: string; tab: string }; Body: AppleDetails }>(
    `${route}/apple/:tab`,
    { preHandler, bodyLimit: 2048, schema: { body: bodyOf(appleDetails) } },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const current = session(sid)!;
      if (
        !current.browser
          .targets()
          .some((target) => target.type === "page" && target.targetId === tab)
      )
        return reply.code(404).send({ error: "Apple 注册标签已关闭，请重新打开" });
      return {
        filled:
          (await waitForForm(current.browser, tab, APPLE_FORM, fillApple(request.body))) === true,
      };
    },
  );
  app.post<{ Params: { sid: string }; Body: { email: string } }>(
    `${route}/claude`,
    { preHandler, bodyLimit: 512, schema: { body: bodyOf({ email: emailField }) } },
    async (request) => {
      const current = session(request.params.sid)!;
      const tab = await current.open(CLAUDE_LOGIN);
      const filled = await waitForForm<boolean>(
        current.browser,
        tab,
        CLAUDE_LOGIN,
        `
        ${SET_VALUE}
        const email = document.querySelector('input[type="email"]');
        if (!email?.getClientRects().length) return null;
        return setValue(email, ${JSON.stringify(request.body.email)});
      `,
      );
      return { filled: filled === true };
    },
  );
}

interface RegistrationOptions {
  countries: [string, string][];
  phoneCodes: [string, string][];
}

const SET_VALUE = `
  function setValue(field, value) {
    if (!field) return false;
    if (field.value === value) return true;
    if (field.disabled || field.readOnly) return false;
    if (field instanceof HTMLSelectElement && !Array.from(field.options).some(o => o.value === value)) {
      return false;
    }
    const prototype = field instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
`;

function fillApple(details: AppleDetails): string {
  return `
    ${SET_VALUE}
    const { country, birthday, firstName, lastName, email, phoneCode, phone } = ${JSON.stringify(details)};
    const control = (name) => document.querySelector('[name="' + name + '"]');
    const countryInput = control("countrySelect");
    if (!countryInput) return null;
    if (!setValue(countryInput, country)) return false;
    const render = () => new Promise((resolve) => setTimeout(resolve, 0));
    await render();
    const [year, month, day] = birthday.split("-");
    const date = (part) => document.querySelector('[data-testid="select-' + part + '"]');
    const codeSet = setValue(control("phoneCode"), phoneCode);
    const yearSet = setValue(date("year"), year);
    const monthSet = setValue(date("month"), month);
    await render();
    return [
      setValue(control("firstName"), firstName), setValue(control("lastName"), lastName),
      yearSet, monthSet, setValue(date("day"), day),
      setValue(control("appleId"), email), codeSet,
      codeSet && setValue(control("phoneNumber"), phone),
    ].every(Boolean);
  `;
}

async function waitForForm<T>(browser: Browser, tab: string, form: string, source: string) {
  const { origin, pathname } = new URL(form);
  const expression = `(async () => {
    if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== ${JSON.stringify(pathname)}) return null;
    ${source}
  })()`;
  const deadline = Date.now() + 10_000;
  do {
    const targets = browser.targets();
    if (!targets.some(({ targetId }) => targetId === tab)) break;
    for (const { targetId, parentTargetId, sessionId } of targets) {
      if (targetId !== tab && parentTargetId !== tab) continue;
      try {
        const { frameTree } = (await browser.send(
          sessionId,
          "Page.getFrameTree",
        )) as Protocol.Page.GetFrameTreeResponse;
        const frames = [frameTree, ...(frameTree.childFrames ?? [])];
        const frame = frames.find(({ frame }) => frame.url.split(/[?#]/, 1)[0] === form)?.frame;
        if (!frame) continue;
        const { executionContextId } = (await browser.send(sessionId, "Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: "workbenchAccountOnboarding",
        })) as Protocol.Page.CreateIsolatedWorldResponse;
        const result = (await browser.send(sessionId, "Runtime.evaluate", {
          contextId: executionContextId,
          expression,
          awaitPromise: true,
          returnByValue: true,
          silent: true,
          timeout: 1_000,
        })) as Protocol.Runtime.EvaluateResponse;
        if (result.result.value != null) return result.result.value as T;
      } catch {
        // A page still loading can replace the frame before evaluation.
      }
    }
    await pause(250);
  } while (Date.now() < deadline);
  return null;
}
