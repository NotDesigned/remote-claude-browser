import type { IncomingMessage } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Protocol } from "puppeteer-core";
import type { TargetRef } from "../types";
import {
  createVerification,
  type AppleCodeAction,
  type OnboardingMailbox,
} from "./account-onboarding-mail";
import type { ClientBrowserScope } from "./client-scope";

const ICLOUD = "https://www.icloud.com/";
const APPLE_SIGN_IN = "https://idmsa.apple.com/appleauth/auth/authorize/signin";
const APPLE_ACCOUNT = "https://account.apple.com/account";
const APPLE_FORM = "https://appleid.apple.com/widget/account/";
const CLAUDE_LOGIN = "https://claude.ai/login";
const ICLOUD_FLOW_MS = 35_000;
const APPLE_REGISTRATION_MS = 30_000;

type Browser = Pick<ClientBrowserScope, "send" | "targets">;
interface OnboardingSession {
  browser: Browser;
  open(url: string): Promise<string>;
}

interface OnboardingOptions {
  currentUserId(request: IncomingMessage): string | undefined;
  mailbox?: OnboardingMailbox;
}

interface MailAddress {
  email?: string;
  mailboxId?: string;
}

interface AppleDetails extends MailAddress {
  firstName: string;
  lastName: string;
  country: string;
  birthday: string;
  phoneCode: string;
  phone: string;
  password?: string;
}

interface SessionParams {
  sid: string;
}
interface TabParams extends SessionParams {
  tab: string;
}

const requiredText = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const emailField = { ...requiredText(254), pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$" };
const appleDetails = {
  firstName: requiredText(100),
  lastName: requiredText(100),
  country: { type: "string", pattern: "^[A-Z]{3}$" },
  birthday: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  phoneCode: { type: "string", pattern: "^[A-Z]{2}$" },
  phone: requiredText(40),
};
const mailBody = (
  properties: Record<string, unknown> = {},
  required = Object.keys(properties),
) => ({
  type: "object",
  required,
  anyOf: [{ required: ["email"] }, { required: ["mailboxId"] }],
  additionalProperties: false,
  properties: { ...properties, email: emailField, mailboxId: requiredText(100) },
});

export function registerAccountOnboarding(
  app: FastifyInstance,
  requireSession: preHandlerAsyncHookHandler,
  session: (sid: string) => OnboardingSession | undefined,
  options: OnboardingOptions,
): void {
  const preHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    await requireSession.call(app, request, reply);
    if (!reply.sent && !session((request.params as SessionParams).sid))
      return reply.code(409).send({ error: "请先连接当前浏览器" });
  };
  const userId = (request: FastifyRequest) => options.currentUserId(request.raw);
  const mailboxService = options.mailbox?.enabled ? options.mailbox : undefined;
  const verification = createVerification(mailboxService);
  app.addHook("onClose", async () => verification.close());
  const address = (request: FastifyRequest<{ Body: MailAddress }>) => {
    const { mailboxId, email } = request.body;
    if (!mailboxId) return { email: email! };
    const owner = userId(request);
    const mailbox = owner && mailboxService?.getAddress(owner, mailboxId);
    if (mailbox) return { email: mailbox.address, mailboxId: mailbox.id, owner };
  };
  const watch = (
    provider: "apple" | "claude",
    details: NonNullable<ReturnType<typeof address>>,
    current: OnboardingSession,
    sid: string,
    tab: string,
    since: number,
  ) => {
    if (!details.owner || !details.mailboxId) return false;
    verification.start({
      provider,
      sid,
      tab,
      owner: details.owner,
      mailboxId: details.mailboxId,
      email: details.email,
      since,
      isActive: () => session(sid)?.browser === current.browser && !!findPage(current.browser, tab),
      ...(provider === "apple" && {
        apply: async (code: string) =>
          (
            await checkForm<AppleCodeAction>(
              current.browser,
              tab,
              APPLE_FORM,
              appleCode(details.email, code),
            )
          )?.value,
      }),
    });
    return true;
  };
  const route = "/api/client/session/:sid/onboarding";
  app.post<{ Params: SessionParams }>(`${route}/apple`, { preHandler }, async (request) => {
    const current = session(request.params.sid)!;
    const tab = await current.open(ICLOUD);
    const registration = await openAppleRegistration(current.browser, tab);
    return registration
      ? { tab: registration.tab, options: registration.value }
      : { tab, options: null };
  });
  app.post<{ Params: TabParams; Body: AppleDetails }>(
    `${route}/apple/:tab`,
    {
      preHandler,
      bodyLimit: 4096,
      schema: {
        body: mailBody({ ...appleDetails, password: requiredText(256) }, Object.keys(appleDetails)),
      },
    },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const current = session(sid)!;
      if (!findPage(current.browser, tab))
        return reply.code(404).send({ error: "Apple 注册标签已关闭，请重新打开" });
      const details = address(request);
      if (!details) return reply.code(404).send({ error: "未找到这个接收邮箱" });
      const since = Date.now();
      const result = await waitForForm<boolean>(
        current.browser,
        tab,
        APPLE_FORM,
        fillApple({ ...request.body, email: details.email }),
      );
      const filled = result?.value === true;
      return {
        filled,
        watching: watch("apple", details, current, sid, tab, since),
      };
    },
  );
  app.post<{ Params: SessionParams; Body: MailAddress }>(
    `${route}/claude`,
    { preHandler, bodyLimit: 1024, schema: { body: mailBody() } },
    async (request, reply) => {
      const details = address(request);
      if (!details) return reply.code(404).send({ error: "未找到这个接收邮箱" });
      const { sid } = request.params;
      const current = session(sid)!;
      const since = Date.now();
      const tab = await current.open(CLAUDE_LOGIN);
      const result = await waitForForm<boolean>(
        current.browser,
        tab,
        CLAUDE_LOGIN,
        `
        ${SET_VALUE}
        const email = document.querySelector('input[type="email"]');
        if (!email?.getClientRects().length) return null;
        return setValue(email, ${JSON.stringify(details.email)});
      `,
        { mainFrameOnly: true },
      );
      const filled = result?.value === true;
      return {
        tab,
        filled,
        watching: filled && watch("claude", details, current, sid, tab, since),
      };
    },
  );
  for (const provider of ["apple", "claude"] as const) {
    app.get<{ Params: TabParams }>(
      `${route}/${provider}/:tab/verification`,
      { preHandler },
      (request, reply) => {
        reply.header("cache-control", "no-store");
        return verification.status(provider, request.params, userId(request));
      },
    );
  }
  app.post<{ Params: TabParams }>(
    `${route}/claude/:tab/verification`,
    { preHandler },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const current = session(sid)!;
      const opened = await verification.open(request.params, userId(request), async (url) => {
        const result = await checkForm<boolean>(
          current.browser,
          tab,
          CLAUDE_LOGIN,
          `location.assign(${JSON.stringify(url)}); return true;`,
          { mainFrameOnly: true },
        );
        return result?.value === true;
      });
      if (!opened) return reply.code(409).send({ error: "请在原来的 Claude 登录标签中继续" });
      return { opened: true };
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

function fillApple(details: AppleDetails & { email: string }): string {
  const { firstName, lastName, country, birthday, email, phoneCode, phone, password } = details;
  return `
    ${SET_VALUE}
    const { country, birthday, firstName, lastName, email, phoneCode, phone, password } =
      ${JSON.stringify({ firstName, lastName, country, birthday, email, phoneCode, phone, password })};
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
    const passwords = [...document.querySelectorAll('input[type="password"]')]
      .filter((field) => field.getClientRects().length);
    return [
      setValue(control("firstName"), firstName), setValue(control("lastName"), lastName),
      yearSet, monthSet, setValue(date("day"), day),
      setValue(control("appleId"), email), codeSet,
      codeSet && setValue(control("phoneNumber"), phone),
      password === undefined || passwords.length === 2 &&
        passwords.map((field) => setValue(field, password)).every(Boolean),
    ].every(Boolean);
  `;
}

function appleCode(email: string, code: string) {
  return `
    ${SET_VALUE}
    const address = ${JSON.stringify(email.toLowerCase())};
    const code = ${JSON.stringify(code)};
    const page = location.origin + location.pathname;
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible" && !element.closest('[inert], [aria-hidden="true"]');
    const writable = (field) => visible(field) && !field.disabled && !field.readOnly;
    const matchingChallenge = (section) => {
      const text = section.innerText.toLowerCase().replace(/\\s+/g, " ");
      const addresses = text.match(/[a-z0-9._%+~-]+@[a-z0-9.-]+\\.[a-z]+/g) ?? [];
      return addresses.includes(address) &&
        /\\b(?:verify (?:your )?e-?mail|e-?mail verification)\\b/.test(text) &&
        !/\\b(?:phone|mobile number|trusted device|sms|text message|captcha)\\b/.test(text);
    };
    const single = [...document.querySelectorAll('input[autocomplete="one-time-code"]')].filter(writable);
    const digits = [...document.querySelectorAll('input[inputmode="numeric"][maxlength="1"]')].filter(writable);
    const fields = single.length === 1 && single[0].maxLength !== 1 ? single : digits;
    if (!(fields.length === 1 || fields.length === code.length) || fields.some((field) => field.value)) return null;
    if (fields.length === 1 && fields[0].maxLength === 1) return null;
    const scopes = 'form, dialog, [role="dialog"], section, fieldset';
    let section = fields[0].closest(scopes);
    while (section && !(matchingChallenge(section) && fields.every((field) => section.contains(field))))
      section = section.parentElement?.closest(scopes);
    if (!section && !matchingChallenge(document.body)) return null;

    const findButton = () => {
      if (!section) return;
      const buttons = [...section.querySelectorAll('button, input[type="submit"]')].filter((button) => {
        const label = (button.getAttribute("aria-label") ??
          (button.matches("input") ? button.value : button.innerText)).trim();
        return visible(button) && /^(?:verify(?: e-?mail(?: address)?)?|continue)$/i.test(label) &&
          (!button.form || (section.contains(button.form) && fields.every((field) => field.form === button.form)));
      });
      if (buttons.length === 1) return buttons[0];
    };
    const button = findButton();
    const values = fields.length === 1 ? [code] : [...code];
    if (!fields.map((field, i) => setValue(field, values[i])).every(Boolean)) return null;
    if (!button) return "filled";
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (page !== location.origin + location.pathname || !section.isConnected ||
      !fields.every((field, i) => section.contains(field) && writable(field) && field.value === values[i]) ||
      !matchingChallenge(section) || button !== findButton() ||
      button.matches(':disabled, [aria-disabled="true"]')) return "filled";
    button.click();
    return "submitted";
  `;
}

async function openAppleRegistration(browser: Browser, tab: string) {
  const registration = await openICloudRegistration(browser, tab);
  if (registration) return registration;
  const page = findPage(browser, tab);
  if (!page) return null;
  const navigation = (await browser.send(page.sessionId, "Page.navigate", {
    url: APPLE_ACCOUNT,
  })) as Protocol.Page.NavigateResponse;
  if (navigation.errorText) return null;
  return waitForRegistration(browser, tab, Date.now() + APPLE_REGISTRATION_MS, false);
}

async function openICloudRegistration(browser: Browser, tab: string) {
  const deadline = Date.now() + ICLOUD_FLOW_MS;
  const signIn = await waitForForm<{ x: number; y: number }>(
    browser,
    tab,
    ICLOUD,
    `
    const button = document.querySelector('.sign-in-button');
    if (!button?.getClientRects().length) return null;
    const { x, y, width, height } = button.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  `,
    { mainFrameOnly: true },
    deadline,
  );
  const page = findPage(browser, tab);
  if (!signIn || !page) return null;
  const mouse = { ...signIn.value, button: "left", clickCount: 1 };
  await browser.send(page.sessionId, "Input.dispatchMouseEvent", {
    ...mouse,
    type: "mousePressed",
    buttons: 1,
  });
  await browser.send(page.sessionId, "Input.dispatchMouseEvent", {
    ...mouse,
    type: "mouseReleased",
    buttons: 0,
  });
  const create = await waitForForm<boolean>(
    browser,
    tab,
    APPLE_SIGN_IN,
    `
    const button = document.getElementById("create-link") ??
      [...document.querySelectorAll('a, button, [role="button"]')].find((element) =>
      element.getClientRects().length && /Create Your Apple\\s+Account/i.test(element.innerText));
    if (!button?.getClientRects().length) return null;
    button.click();
    return true;
  `,
    { userGesture: true },
    deadline,
  );
  if (!create) return null;
  return waitForRegistration(browser, tab, deadline, true);
}

function waitForRegistration(
  browser: Browser,
  tab: string,
  deadline: number,
  includePopups: boolean,
) {
  return waitForForm<RegistrationOptions>(
    browser,
    tab,
    APPLE_FORM,
    `
    const options = (name) => Array.from(document.querySelector('select[name="' + name + '"]').options,
      ({ value, text }) => [value, text]);
    if (!document.querySelector('input[name="phoneNumber"]')) return null;
    return { countries: options("countrySelect"), phoneCodes: options("phoneCode") };
  `,
    { includePopups },
    deadline,
  );
}

interface FormScope {
  mainFrameOnly?: boolean;
  includePopups?: boolean;
  userGesture?: boolean;
}

function findPage(browser: Browser, tab: string) {
  return browser.targets().find((target) => target.type === "page" && target.targetId === tab);
}

function rootPage(target: TargetRef, targets: Map<string, TargetRef>): TargetRef | undefined {
  if (target.type === "page") return target;
  const parent = targets.get(target.parentTargetId ?? "");
  return parent && rootPage(parent, targets);
}

function descendsFrom(page: TargetRef, tab: string, targets: Map<string, TargetRef>): boolean {
  if (page.targetId === tab) return true;
  const opener = targets.get(page.openerTabId ?? "");
  return !!opener && descendsFrom(opener, tab, targets);
}

async function waitForForm<T>(
  browser: Browser,
  tab: string,
  form: string,
  source: string,
  scope?: FormScope,
  deadline = Date.now() + 10_000,
) {
  while (Date.now() < deadline) {
    const result = await checkForm<T>(browser, tab, form, source, scope);
    if (result || !findPage(browser, tab)) return result;
    await pause(250);
  }
  return null;
}

async function checkForm<T>(
  browser: Browser,
  tab: string,
  form: string,
  source: string,
  scope: FormScope = {},
): Promise<{ tab: string; value: T } | null> {
  const { origin, pathname } = new URL(form);
  const expression = `(async () => {
    if (location.origin !== ${JSON.stringify(origin)} || location.pathname !== ${JSON.stringify(pathname)}) return null;
    ${source}
  })()`;
  const targets = new Map(browser.targets().map((target) => [target.targetId, target]));
  for (const target of targets.values()) {
    if (scope.mainFrameOnly && target.type !== "page") continue;
    const page = rootPage(target, targets);
    if (
      !page ||
      !(page.targetId === tab || (scope.includePopups && descendsFrom(page, tab, targets)))
    )
      continue;
    const { sessionId } = target;
    try {
      const { frameTree } = (await browser.send(
        sessionId,
        "Page.getFrameTree",
      )) as Protocol.Page.GetFrameTreeResponse;
      const frames = [frameTree];
      for (const { frame, childFrames } of frames) {
        if (!scope.mainFrameOnly) frames.push(...(childFrames ?? []));
        if (frame.url.split(/[?#]/, 1)[0] !== form) continue;
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
          userGesture: scope.userGesture,
        })) as Protocol.Runtime.EvaluateResponse;
        if (result.result.value != null)
          return { tab: page.targetId, value: result.result.value as T };
      }
    } catch {
      // Navigation can replace the frame while the browser is evaluating it.
    }
  }
  return null;
}
