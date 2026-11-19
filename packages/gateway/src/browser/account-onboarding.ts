import type { IncomingMessage } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import type { Protocol } from "puppeteer-core";
import type { TargetRef } from "../types";
import { createAppleAttempts, untilCanceled } from "./account-onboarding-attempts";
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
  open(url: string, background?: boolean): Promise<string>;
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

interface AppleQuery {
  attempt?: string;
  guided?: boolean;
}

const attemptQuery = {
  type: "object",
  properties: {
    attempt: { type: "string", pattern: "^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$" },
    guided: { type: "boolean" },
  },
};
const appleGone = (reply: FastifyReply) =>
  reply.code(410).send({ error: "Apple 注册已结束，请重新打开向导" });

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
  const attempts = createAppleAttempts();
  app.addHook("onClose", async () => {
    attempts.close();
    verification.close();
  });
  const applePreHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    if ((request.query as AppleQuery).attempt) return requireSession.call(app, request, reply);
    return preHandler.call(app, request, reply);
  };
  const appleAttempt = (sid: string, tab: string, id: string) => {
    const attempt = attempts.get(sid, id);
    const browser = session(sid)?.browser;
    if (attempt?.tab === tab && browser === attempt.browser && findPage(browser, tab))
      return attempt;
  };
  const performApple = async <T>(
    reply: FastifyReply,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ) => {
    try {
      return await untilCanceled(signal, work);
    } catch (error) {
      if (signal?.aborted) return appleGone(reply);
      throw error;
    }
  };
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
    signal?: AbortSignal,
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
      signal,
      isActive: () => session(sid)?.browser === current.browser && !!findPage(current.browser, tab),
      ...(provider === "apple" && {
        apply: async (code: string) =>
          (
            await checkForm<AppleCodeAction>(
              current.browser,
              tab,
              APPLE_FORM,
              appleCode(details.email, code),
              { signal },
            )
          )?.value,
      }),
    });
    return true;
  };
  const route = "/api/client/session/:sid/onboarding";
  app.post<{ Params: SessionParams; Querystring: AppleQuery }>(
    `${route}/apple`,
    { preHandler: applePreHandler, schema: { querystring: attemptQuery } },
    async (request, reply) => {
      const { sid } = request.params;
      const { attempt: id } = request.query;
      const current = session(sid);
      if (!current) return reply.code(409).send({ error: "请先连接当前浏览器" });
      const attempt = id && attempts.start(sid, id, current.browser);
      if (id && !attempt) return appleGone(reply);
      const signal = attempt ? attempt.control.signal : undefined;
      return performApple(reply, signal, async () => {
        const guided = !!attempt && request.query.guided === true;
        const tab = guided ? await current.open(ICLOUD, true) : await current.open(ICLOUD);
        signal?.throwIfAborted();
        const registration = await openAppleRegistration(current.browser, tab, signal);
        signal?.throwIfAborted();
        const activeTab = registration?.tab ?? tab;
        if (attempt) {
          if (session(sid)?.browser !== current.browser || !findPage(current.browser, activeTab))
            return appleGone(reply);
          attempt.tab = activeTab;
          attempt.guided = guided;
        }
        return { tab: activeTab, options: registration?.value ?? null };
      });
    },
  );
  app.delete<{ Params: SessionParams; Querystring: { attempt: string } }>(
    `${route}/apple`,
    {
      preHandler: requireSession,
      schema: { querystring: { ...attemptQuery, required: ["attempt"] } },
    },
    (request, reply) => {
      attempts.cancel(request.params.sid, request.query.attempt);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: TabParams; Querystring: AppleQuery; Body: AppleDetails }>(
    `${route}/apple/:tab`,
    {
      preHandler: applePreHandler,
      bodyLimit: 4096,
      schema: {
        querystring: attemptQuery,
        body: mailBody({ ...appleDetails, password: requiredText(256) }, Object.keys(appleDetails)),
      },
    },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const { attempt: id } = request.query;
      const attempt = id && appleAttempt(sid, tab, id);
      if (id && !attempt) return appleGone(reply);
      const signal = attempt ? attempt.control.signal : undefined;
      const current = session(sid)!;
      if (!findPage(current.browser, tab))
        return reply.code(404).send({ error: "Apple 注册标签已关闭，请重新打开" });
      const details = address(request);
      if (!details) return reply.code(404).send({ error: "未找到这个接收邮箱" });
      const since = Date.now();
      return performApple(reply, signal, async () => {
        const result = await waitForForm<boolean>(
          current.browser,
          tab,
          APPLE_FORM,
          fillApple({ ...request.body, email: details.email }),
          { signal },
        );
        signal?.throwIfAborted();
        if (id) {
          if (!appleAttempt(sid, tab, id)) return appleGone(reply);
          attempts.refresh(sid, id);
        }
        if (attempt && result?.value === true) attempt.email = details.email;
        return {
          filled: result?.value === true,
          watching: watch("apple", details, current, sid, tab, since, signal),
        };
      });
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
    app.get<{ Params: TabParams; Querystring: AppleQuery }>(
      `${route}/${provider}/:tab/verification`,
      provider === "apple"
        ? { preHandler: applePreHandler, schema: { querystring: attemptQuery } }
        : { preHandler },
      async (request, reply) => {
        reply.header("cache-control", "no-store");
        const { sid, tab } = request.params;
        const id = request.query.attempt;
        const attempt = provider === "apple" && id ? appleAttempt(sid, tab, id) : undefined;
        if (provider === "apple" && id && !attempt) return appleGone(reply);
        const status = verification.status(provider, request.params, userId(request));
        if (!attempt?.guided || !attempt.email) return status;
        return performApple(reply, attempt.control.signal, async () => ({
          ...status,
          challenge: await readAppleChallenge(session(sid)!.browser, tab, attempt.control.signal),
        }));
      },
    );
  }
  app.post<{ Params: TabParams; Querystring: AppleQuery; Body: { kind: string; code: string } }>(
    `${route}/apple/:tab/verification`,
    {
      preHandler: applePreHandler,
      bodyLimit: 256,
      schema: {
        querystring: { ...attemptQuery, required: ["attempt"] },
        body: {
          type: "object",
          required: ["kind", "code"],
          additionalProperties: false,
          properties: { kind: { enum: ["captcha", "email", "sms"] }, code: requiredText(20) },
        },
      },
    },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const attempt = appleAttempt(sid, tab, request.query.attempt!);
      if (!attempt?.guided || !attempt.email) return appleGone(reply);
      const { kind, code } = request.body;
      if ((kind !== "captcha" && !/^\d{6}$/.test(code)) || attempt.submitting)
        return reply.code(409).send({ error: "请检查验证码后重试" });
      const signal = attempt.control.signal;
      const browser = session(sid)!.browser;
      attempt.submitting = true;
      try {
        return await performApple(reply, signal, async () => {
          const result = await checkForm(
            browser,
            tab,
            APPLE_FORM,
            kind === "captcha" ? appleChallenge(code) : appleCode(attempt.email!, code, kind),
            { signal },
          );
          if (result?.value !== "submitted")
            return reply
              .code(409)
              .send({ error: "Apple 暂未接受提交，请检查验证码或打开官方页面继续" });
          attempts.refresh(sid, request.query.attempt!);
          return { submitted: true };
        });
      } finally {
        attempt.submitting = false;
      }
    },
  );
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

type AppleChallenge =
  { kind: "captcha"; image: string } | { kind: "email" | "sms" | "complete" | "waiting" };

function appleChallenge(code?: string) {
  return `
    ${SET_VALUE}
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible" && !element.closest('[inert], [aria-hidden="true"]');
    const images = [...document.images].filter((image) => visible(image) && image.naturalWidth &&
      /captcha|image challenge|visual challenge/i.test([image.id, image.alt, image.currentSrc.split(/[?#]/)[0].slice(0, 256)].join(" ")));
    const writable = (field) => visible(field) && !field.disabled && !field.readOnly;
    const caption = /characters (?:in|from) the image/i;
    let captcha = [...document.querySelectorAll('input[type="text"], input:not([type])')].filter(writable).find((field) =>
      /captcha/i.test(field.name + " " + field.id) ||
      caption.test([field.getAttribute("aria-label"), field.placeholder,
        ...Array.from(field.labels ?? [], label => label.innerText)].join(" ")));
    for (let group = images[0]?.parentElement; !captcha && images.length === 1 && group; group = group.parentElement) {
      const fields = [...group.querySelectorAll('input[type="text"], input:not([type])')].filter(writable);
      if (fields.length > 1) break;
      if (caption.test(group.innerText)) captcha = fields[0];
    }
    const code = ${JSON.stringify(code)};
    const continueButton = (root) => {
      const buttons = [...root.querySelectorAll('button, input[type="submit"]')].filter((button) =>
        visible(button) && /^(?:continue|create (?:an? |your )?(?:apple )?account)$/i.test(
          (button.getAttribute("aria-label") ?? (button.matches("input") ? button.value : button.innerText)).trim()));
      return buttons.length === 1 ? buttons[0] : undefined;
    };
    const submit = (field) => {
      const scope = field.form ?? field.closest('dialog, [role="dialog"]') ?? document;
      const button = continueButton(scope) ?? (scope !== document && continueButton(document));
      if (!button || button.matches(':disabled, [aria-disabled="true"]')) return null;
      button.click();
      return "submitted";
    };
    if (captcha && images.length === 1) {
      if (code === undefined) {
        const image = images[0];
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        try {
          canvas.getContext("2d").drawImage(image, 0, 0);
          return { kind: "captcha", src: canvas.toDataURL("image/png") };
        } catch {
          return { kind: "captcha", src: image.currentSrc };
        }
      }
      setValue(captcha, code);
      await new Promise((resolve) => setTimeout(resolve, 0));
      return submit(captcha);
    }
    if (code !== undefined) return null;
    for (const heading of document.querySelectorAll('h1, h2, h3, [role="heading"]')) {
      if (!visible(heading)) continue;
      const text = heading.innerText.trim();
      if (/^verify (?:your )?(?:apple (?:account|id) )?e-?mail(?: address)?$/i.test(text))
        return { kind: "email" };
      if (/^verify (?:your )?(?:phone|mobile(?: phone)?) number$/i.test(text))
        return { kind: "sms" };
      if (/^(?:your )?apple account (?:has been |was )?created[.!]?$/i.test(text))
        return { kind: "complete" };
    }
    return null;
  `;
}

async function readAppleChallenge(
  browser: Browser,
  tab: string,
  signal: AbortSignal,
): Promise<AppleChallenge> {
  const result = await checkForm<
    { kind: "captcha"; src: string } | { kind: "email" | "sms" | "complete" }
  >(browser, tab, APPLE_FORM, appleChallenge(), { signal });
  if (!result) return { kind: "waiting" };
  if (result.value.kind !== "captcha") return result.value;
  const { src } = result.value;
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,[\w+/=]+$/i.test(src) && src.length <= 400_000)
    return { kind: "captcha", image: src };
  if (!src.startsWith("https://")) return { kind: "waiting" };
  const resource = (await browser
    .send(result.sessionId, "Page.getResourceContent", {
      frameId: result.frameId,
      url: src,
    })
    .catch(() => undefined)) as Protocol.Page.GetResourceContentResponse | undefined;
  signal.throwIfAborted();
  if (!resource?.base64Encoded || resource.content.length > 400_000) return { kind: "waiting" };
  const prefix = resource.content;
  const format = prefix.startsWith("iVBORw0KGgo")
    ? "png"
    : prefix.startsWith("/9j/")
      ? "jpeg"
      : prefix.startsWith("R0lGOD")
        ? "gif"
        : undefined;
  return format
    ? { kind: "captcha", image: `data:image/${format};base64,${resource.content}` }
    : { kind: "waiting" };
}

function appleCode(email: string, code: string, mode = "auto-email") {
  return `
    ${SET_VALUE}
    const address = ${JSON.stringify(email.toLowerCase())};
    const code = ${JSON.stringify(code)};
    const mode = ${JSON.stringify(mode)};
    const page = location.origin + location.pathname;
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible" && !element.closest('[inert], [aria-hidden="true"]');
    const writable = (field) => visible(field) && !field.disabled && !field.readOnly;
    const matchingChallenge = (section) => {
      const text = section.innerText.toLowerCase().replace(/\\s+/g, " ");
      const addresses = text.match(/[a-z0-9._%+~-]+@[a-z0-9.-]+\\.[a-z]+/g) ?? [];
      const emailChallenge = /\\b(?:verify (?:your )?(?:apple (?:account|id) )?e-?mail|e-?mail verification)\\b/.test(text);
      if (mode === "sms") return !emailChallenge &&
        /\\b(?:verify (?:your )?(?:phone|mobile(?: phone)?) number|phone number verification)\\b/.test(text);
      return addresses.includes(address) && emailChallenge &&
        !/\\b(?:phone|mobile number|trusted device|sms|text message|captcha)\\b/.test(text);
    };
    const inputs = [...document.querySelectorAll('input:is(:not([type]), [type="text"], [type="tel"], [type="number"])')]
      .filter(writable);
    const single = inputs.filter((field) => field.autocomplete === "one-time-code" && field.maxLength !== 1);
    const digits = inputs.filter((field) => field.maxLength === 1);
    const fields = single.length === 1 ? single : digits.length === code.length ? digits : inputs;
    if (!(single.length === 1 || fields.length === code.length) ||
      (mode === "auto-email" && fields.some((field) => field.value))) return null;
    const scopes = 'form, dialog, [role="dialog"], section, fieldset';
    let section = fields[0].closest(scopes);
    while (section && !(matchingChallenge(section) && fields.every((field) => section.contains(field))))
      section = section.parentElement?.closest(scopes);
    if (!section && matchingChallenge(document.body)) section = document.body;
    if (!section) return null;

    const findButton = () => {
      const buttons = [...section.querySelectorAll('button, input[type="submit"]')].filter((button) => {
        const label = (button.getAttribute("aria-label") ??
          (button.matches("input") ? button.value : button.innerText)).trim();
        return visible(button) && /^(?:verify(?: e-?mail(?: address)?| phone number)?|continue)$/i.test(label) &&
          (!button.form || (section.contains(button.form) && fields.every((field) => field.form === button.form)));
      });
      if (buttons.length === 1) return buttons[0];
    };
    let button = findButton();
    if (!button && section !== document.body && matchingChallenge(document.body)) {
      section = document.body;
      button = findButton();
    }
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

async function openAppleRegistration(browser: Browser, tab: string, signal?: AbortSignal) {
  try {
    const registration = await openICloudRegistration(browser, tab, signal);
    signal?.throwIfAborted();
    if (registration) return registration;
    const page = findPage(browser, tab);
    if (!page) return null;
    const navigation = (await browser.send(page.sessionId, "Page.navigate", {
      url: APPLE_ACCOUNT,
    })) as Protocol.Page.NavigateResponse;
    if (navigation.errorText) return null;
    return waitForRegistration(browser, tab, Date.now() + APPLE_REGISTRATION_MS, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (!findPage(browser, tab)) return null;
    throw error;
  }
}

async function openICloudRegistration(browser: Browser, tab: string, signal?: AbortSignal) {
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
    { mainFrameOnly: true, signal },
    deadline,
  );
  signal?.throwIfAborted();
  const page = findPage(browser, tab);
  if (!signIn || !page) return null;
  const mouse = { ...signIn.value, button: "left", clickCount: 1 };
  // Dispatch the complete click before checking cancellation again.
  await Promise.all([
    browser.send(page.sessionId, "Input.dispatchMouseEvent", {
      ...mouse,
      type: "mousePressed",
      buttons: 1,
    }),
    browser.send(page.sessionId, "Input.dispatchMouseEvent", {
      ...mouse,
      type: "mouseReleased",
      buttons: 0,
    }),
  ]);
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
    { userGesture: true, signal },
    deadline,
  );
  if (!create) return null;
  return waitForRegistration(browser, tab, deadline, { includePopups: true, signal });
}

function waitForRegistration(browser: Browser, tab: string, deadline: number, scope: FormScope) {
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
    scope,
    deadline,
  );
}

interface FormScope {
  mainFrameOnly?: boolean;
  includePopups?: boolean;
  userGesture?: boolean;
  signal?: AbortSignal;
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
    await pause(250, undefined, { signal: scope?.signal });
  }
  return null;
}

async function checkForm<T>(
  browser: Browser,
  tab: string,
  form: string,
  source: string,
  scope: FormScope = {},
): Promise<{ tab: string; value: T; sessionId: string; frameId: string } | null> {
  const { signal } = scope;
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const frames = [frameTree];
      for (const { frame, childFrames } of frames) {
        if (!scope.mainFrameOnly) frames.push(...(childFrames ?? []));
        if (frame.url.split(/[?#]/, 1)[0] !== form) continue;
        const { executionContextId } = (await browser.send(sessionId, "Page.createIsolatedWorld", {
          frameId: frame.id,
          worldName: "workbenchAccountOnboarding",
        })) as Protocol.Page.CreateIsolatedWorldResponse;
        signal?.throwIfAborted();
        const result = (await browser.send(sessionId, "Runtime.evaluate", {
          contextId: executionContextId,
          expression,
          awaitPromise: true,
          returnByValue: true,
          silent: true,
          timeout: 1_000,
          userGesture: scope.userGesture,
        })) as Protocol.Runtime.EvaluateResponse;
        signal?.throwIfAborted();
        if (result.result.value != null)
          return {
            tab: page.targetId,
            value: result.result.value as T,
            sessionId,
            frameId: frame.id,
          };
      }
    } catch {
      signal?.throwIfAborted();
      // Navigation can replace the frame while the browser is evaluating it.
    }
  }
  return null;
}
