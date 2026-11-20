import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import type { Protocol } from "puppeteer-core";
import type { TargetRef } from "../types";
import type {
  AppleAccountState,
  AppleAccountStore,
  AppleCredentials,
} from "../auth/apple-accounts";
import {
  createAppleAttempts,
  untilCanceled,
  type AppleAttempt,
} from "./account-onboarding-attempts";
import {
  createVerification,
  isAppleRelayEmail,
  isICloudWelcome,
  type AppleCodeAction,
  type OnboardingMailbox,
} from "./account-onboarding-mail";
import type { ClientBrowserScope } from "./client-scope";

const ICLOUD = "https://www.icloud.com/";
const APPLE_SIGN_IN = "https://idmsa.apple.com/appleauth/auth/authorize/signin";
const APPLE_ACCOUNT = "https://account.apple.com/account";
const APPLE_FORM = "https://appleid.apple.com/widget/account/";
const APPLE_TERMS = [ICLOUD, APPLE_FORM, APPLE_SIGN_IN, APPLE_ACCOUNT];
const CLAUDE_LOGIN = "https://claude.ai/login";
const GOOGLE_MAIL = "https://mail.google.com/";
const GOOGLE_ACCOUNTS = "https://accounts.google.com";
const APPLE_AUTH = ["https://appleid.apple.com", "https://idmsa.apple.com"];
const ICLOUD_FLOW_MS = 35_000;
const APPLE_REGISTRATION_MS = 30_000;

type Browser = Pick<ClientBrowserScope, "send" | "targets">;
interface OnboardingSession {
  browser: Browser;
  open(url: string, background?: boolean): Promise<string>;
  profileId?: string;
}

interface OnboardingOptions {
  currentUserId(request: IncomingMessage): string | undefined;
  mailbox?: OnboardingMailbox;
  accounts?: AppleAccountStore;
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

interface GoogleQuery {
  attempt?: string;
}

interface GoogleDetails {
  firstName: string;
  lastName: string;
  birthday: string;
  gender: string;
  username: string;
  password: string;
  passwordConfirmation: string;
  phone?: string;
  recoveryEmail?: string;
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
const googleGone = (reply: FastifyReply) =>
  reply.code(410).send({ error: "Google 注册已结束，请重新打开向导" });

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
const googleDetails = {
  firstName: requiredText(100),
  lastName: requiredText(100),
  birthday: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
  gender: requiredText(32),
  username: { type: "string", pattern: "^[a-zA-Z0-9._-]{1,30}$" },
  password: requiredText(256),
  passwordConfirmation: requiredText(256),
  phone: { type: "string", maxLength: 40 },
  recoveryEmail: { ...emailField, nullable: true },
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
  const archive = (request: FastifyRequest, sid: string) => {
    const user = userId(request);
    const profile = session(sid)?.profileId;
    if (user && profile && options.accounts) return { user, profile, accounts: options.accounts };
  };
  const archiveState = (
    request: FastifyRequest,
    sid: string,
    id: string,
    state: AppleAccountState,
  ) => {
    const entry = archive(request, sid);
    entry?.accounts.setState(entry.user, entry.profile, id.toLowerCase(), state);
  };
  const mailboxService = options.mailbox?.enabled ? options.mailbox : undefined;
  const welcomeReceived = async (attempt: AppleAttempt) => {
    if (!mailboxService || !attempt.inbox) return false;
    const { owner, mailboxId, since } = attempt.inbox;
    const welcome = mailboxService.listMessages(owner, mailboxId, since).find(isICloudWelcome);
    if (!welcome || welcome.id === attempt.welcomeChecked) return false;
    const message = await mailboxService
      .readMessage(owner, mailboxId, welcome.id)
      .catch(() => undefined);
    if (!message || attempt.control.signal.aborted) return false;
    attempt.welcomeChecked = welcome.id;
    return message.authenticated && isICloudWelcome(message);
  };
  const verification = createVerification(mailboxService);
  const attempts = createAppleAttempts();
  const googleAttempts = new Map<
    string,
    {
      sid: string;
      browser: Browser;
      tab: string;
      control: AbortController;
      timer: NodeJS.Timeout;
      details?: GoogleDetails;
      submitting?: boolean;
      termsOutcome?: "complete" | "declined";
    }
  >();
  const shutdown = new AbortController();
  app.addHook("onClose", async () => {
    shutdown.abort();
    attempts.close();
    verification.close();
    for (const [key, attempt] of googleAttempts) {
      clearTimeout(attempt.timer);
      attempt.control.abort();
      googleAttempts.delete(key);
    }
  });
  const applePreHandler: preHandlerAsyncHookHandler = async (request, reply) => {
    if ((request.query as AppleQuery).attempt) return requireSession.call(app, request, reply);
    return preHandler.call(app, request, reply);
  };
  const appleAttempt = (sid: string, tab: string, id: string) => {
    const attempt = attempts.get(sid, id);
    const browser = session(sid)?.browser;
    if (
      attempt?.tab === tab &&
      browser === attempt.browser &&
      (attempt.termsOutcome ||
        findPage(browser, tab) ||
        (attempt.guided && attempt.startTab && findPage(browser, attempt.startTab)))
    )
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
    autoOpen = false,
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
      ...(provider === "claude" &&
        autoOpen && {
          apply: async (url: string) =>
            (await openClaudeLink(current.browser, tab, url)) ? ("submitted" as const) : undefined,
        }),
    });
    return true;
  };
  const route = "/api/client/session/:sid/onboarding";
  const googleKey = (sid: string, id: string) => `${sid}:${id.toLowerCase()}`;
  const googleAttempt = (sid: string, id: string) => googleAttempts.get(googleKey(sid, id));
  const googleTabAttempt = (sid: string, tab: string, id: string) => {
    const attempt = googleAttempt(sid, id);
    return attempt?.tab === tab && findPage(attempt.browser, tab) ? attempt : undefined;
  };
  const rememberGoogle = (sid: string, browser: Browser, tab: string) => {
    const id = randomUUID();
    const control = new AbortController();
    const key = googleKey(sid, id);
    const timer = setTimeout(() => {
      googleAttempts.delete(key);
      control.abort();
    }, 10 * 60_000).unref();
    googleAttempts.set(key, { sid, browser, tab, control, timer });
    return { id, control };
  };
  app.post<{ Params: SessionParams }>(`${route}/google`, { preHandler }, async (request) => {
    const current = session(request.params.sid)!;
    const tab = await current.open(GOOGLE_MAIL, true);
    const { id } = rememberGoogle(request.params.sid, current.browser, tab);
    return { attempt: id, tab, url: GOOGLE_MAIL };
  });
  app.post<{ Params: TabParams; Querystring: GoogleQuery; Body: GoogleDetails }>(
    `${route}/google/:tab`,
    {
      preHandler: requireSession,
      bodyLimit: 4096,
      schema: {
        querystring: { ...attemptQuery, required: ["attempt"] },
        body: {
          type: "object",
          required: [
            "firstName",
            "lastName",
            "birthday",
            "gender",
            "username",
            "password",
            "passwordConfirmation",
          ],
          additionalProperties: false,
          properties: googleDetails,
        },
      },
    },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const attempt = googleAttempt(sid, request.query.attempt!);
      if (!attempt || attempt.tab !== tab || !findPage(attempt.browser, tab))
        return googleGone(reply);
      if (request.body.password !== request.body.passwordConfirmation)
        return reply.code(400).send({ error: "两次输入的 Google 密码不一致" });
      const result = await fillGoogleRegistration(
        attempt.browser,
        tab,
        request.body,
        attempt.control.signal,
      );
      if (!result)
        return reply.code(409).send({ error: "未找到 Google 注册表单，请在官方页面继续" });
      attempt.details = request.body;
      return { filled: true, stage: result };
    },
  );
  app.get<{ Params: TabParams; Querystring: GoogleQuery }>(
    `${route}/google/:tab/verification`,
    {
      preHandler: requireSession,
      schema: { querystring: { ...attemptQuery, required: ["attempt"] } },
    },
    async (request, reply) => {
      const attempt = googleTabAttempt(
        request.params.sid,
        request.params.tab,
        request.query.attempt!,
      );
      if (!attempt) return googleGone(reply);
      if (attempt.termsOutcome)
        return { ready: false, expired: true, challenge: { kind: attempt.termsOutcome } };
      const challenge = await readGoogleChallenge(
        attempt.browser,
        attempt.tab,
        attempt.control.signal,
      );
      return { ready: false, expired: false, challenge };
    },
  );
  app.post<{
    Params: TabParams;
    Querystring: GoogleQuery;
    Body:
      { kind: "captcha" | "sms"; code: string } | { kind: "terms"; choice: "agree" | "disagree" };
  }>(
    `${route}/google/:tab/verification`,
    {
      preHandler: requireSession,
      schema: {
        querystring: { ...attemptQuery, required: ["attempt"] },
        body: {
          anyOf: [
            {
              type: "object",
              required: ["kind", "code"],
              additionalProperties: false,
              properties: {
                kind: { enum: ["captcha", "sms"] },
                code: requiredText(20),
              },
            },
            {
              type: "object",
              required: ["kind", "choice"],
              additionalProperties: false,
              properties: { kind: { const: "terms" }, choice: { enum: ["agree", "disagree"] } },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const attempt = googleTabAttempt(
        request.params.sid,
        request.params.tab,
        request.query.attempt!,
      );
      if (!attempt) return googleGone(reply);
      if (attempt.submitting)
        return reply.code(409).send({ error: "请等待 Google 处理上一次提交" });
      attempt.submitting = true;
      try {
        const signal = attempt.control.signal;
        const body = request.body;
        if (body.kind === "terms") {
          const result = await submitGoogleTerms(attempt.browser, attempt.tab, body.choice, signal);
          if (!result) return reply.code(409).send({ error: "未找到 Google 条款确认按钮" });
          if (body.choice === "disagree") {
            attempt.termsOutcome = "declined";
            return { challenge: { kind: "declined" } };
          }
          return { challenge: { kind: "waiting" } };
        }
        if (body.kind === "sms" && !/^\d{6}$/.test(body.code))
          return reply.code(409).send({ error: "请输入六位验证码" });
        const submitted = await submitGoogleCode(
          attempt.browser,
          attempt.tab,
          body.kind,
          body.code,
          signal,
        );
        if (!submitted) return reply.code(409).send({ error: "未能提交 Google 验证码，请重试" });
        if (attempt.details)
          await advanceGoogleRegistration(attempt.browser, attempt.tab, attempt.details, signal);
        return { submitted: true };
      } finally {
        attempt.submitting = false;
      }
    },
  );
  app.delete<{ Params: SessionParams; Querystring: GoogleQuery }>(
    `${route}/google`,
    {
      preHandler: requireSession,
      schema: {
        querystring: {
          type: "object",
          required: ["attempt"],
          properties: { attempt: { type: "string" } },
        },
      },
    },
    (request, reply) => {
      const key = googleKey(request.params.sid, request.query.attempt!);
      const attempt = googleAttempts.get(key);
      if (attempt) {
        clearTimeout(attempt.timer);
        attempt.control.abort();
        googleAttempts.delete(key);
      }
      return reply.code(204).send();
    },
  );
  app.get<{ Params: TabParams; Querystring: GoogleQuery }>(
    `${route}/google/:tab/status`,
    { preHandler, schema: { querystring: { type: "object", required: ["attempt"] } } },
    (request, reply) => {
      const attempt = googleAttempt(request.params.sid, request.query.attempt!);
      if (!attempt || attempt.tab !== request.params.tab || !findPage(attempt.browser, attempt.tab))
        return googleGone(reply);
      return { active: true, tab: attempt.tab };
    },
  );
  app.get<{ Params: SessionParams }>(
    `${route}/apple/accounts`,
    { preHandler },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const entry = archive(request, request.params.sid);
      return { accounts: entry ? await entry.accounts.list(entry.user, entry.profile) : [] };
    },
  );
  app.get<{ Params: SessionParams & { record: string } }>(
    `${route}/apple/accounts/:record`,
    { preHandler },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const entry = archive(request, request.params.sid);
      const account =
        entry && (await entry.accounts.get(entry.user, entry.profile, request.params.record));
      if (!account) return reply.code(404).send({ error: "没有这条 Apple 账户记录" });
      return account;
    },
  );
  app.post<{ Params: SessionParams & { record: string } }>(
    `${route}/apple/accounts/:record/claude/apple`,
    { preHandler },
    async (request, reply) => {
      const { sid, record } = request.params;
      const entry = archive(request, sid);
      const account = entry && (await entry.accounts.get(entry.user, entry.profile, record));
      if (!account) return reply.code(404).send({ error: "没有这条 Apple 账户记录" });
      const current = session(sid)!;
      const tab = await current.open(CLAUDE_LOGIN, true);
      const signal = AbortSignal.any([shutdown.signal, AbortSignal.timeout(8 * 60_000)]);
      const started = await waitForForm<boolean>(
        current.browser,
        tab,
        CLAUDE_LOGIN,
        `
        const buttons = [...document.querySelectorAll('button,a,[role="button"]')].filter((button) =>
          button.getClientRects().length && !button.matches(':disabled,[aria-disabled="true"]') &&
          [button.getAttribute("aria-label"), button.innerText].some(
            (label) => /^(?:continue|sign in|sign up) with Apple$/i.test(label?.trim() ?? "")));
        if (buttons.length !== 1) return null;
        buttons[0].click();
        return true;
      `,
        { mainFrameOnly: true, signal, userGesture: true },
        Date.now() + 6_000,
      );
      if (started)
        void assistClaudeApple(current.browser, tab, account, signal, async (email) => {
          if (session(sid)?.browser !== current.browser || userId(request) !== entry!.user) return;
          await entry!.accounts.bindRelay(entry!.user, entry!.profile, record, email, false);
          entry!.accounts.setState(entry!.user, entry!.profile, record, "created");
        }).catch(() => {});
      const signIn =
        started &&
        (await waitForForm<boolean>(
          current.browser,
          tab,
          APPLE_AUTH,
          "return true;",
          { originOnly: true, includePopups: true, signal },
          Date.now() + 4_000,
        ));
      return { tab: signIn ? signIn.tab : tab, started: !!started };
    },
  );
  app.post<{ Params: SessionParams & { record: string }; Body: { relayEmail?: string } }>(
    `${route}/apple/accounts/:record/claude`,
    {
      preHandler,
      bodyLimit: 512,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { relayEmail: emailField },
        },
      },
    },
    async (request, reply) => {
      const { sid, record } = request.params;
      const entry = archive(request, sid);
      if (!entry) return reply.code(404).send({ error: "没有这条 Apple 账户记录" });
      const supplied = request.body.relayEmail?.trim().toLowerCase();
      if (supplied !== undefined && !isAppleRelayEmail(supplied))
        return reply.code(400).send({ error: "请输入 Apple 为 Claude 生成的转发邮箱" });
      const account = supplied
        ? await entry.accounts.bindRelay(entry.user, entry.profile, record, supplied)
        : await entry.accounts.get(entry.user, entry.profile, record);
      if (!account) return reply.code(404).send({ error: "没有这条 Apple 账户记录" });
      const email = account.relayEmail;
      if (!email) return reply.code(409).send({ error: "请先填写 Claude 的 Apple 转发邮箱" });
      const current = session(sid)!;
      const mailbox = mailboxService
        ?.listAddresses?.(entry.user)
        .find((address) => address.address.toLowerCase() === account.email.toLowerCase());
      const tab = await current.open(CLAUDE_LOGIN, true);
      const since = Date.now();
      const focused = await waitForForm<boolean>(
        current.browser,
        tab,
        CLAUDE_LOGIN,
        `
        const field = document.querySelector('input[type="email"]');
        if (!field?.getClientRects().length || field.disabled || field.readOnly) return null;
        field.focus();
        field.select();
        return field === document.activeElement ? true : null;
      `,
        { mainFrameOnly: true },
      );
      const page = findPage(current.browser, tab);
      if (focused && page)
        await current.browser.send(page.sessionId, "Input.insertText", { text: email });
      const watching =
        !!mailbox &&
        watch(
          "claude",
          { email, owner: entry.user, mailboxId: mailbox.id },
          current,
          sid,
          tab,
          since,
          undefined,
          true,
        );
      const requested = !!(
        focused &&
        (await waitForForm<boolean>(
          current.browser,
          tab,
          CLAUDE_LOGIN,
          `
        const field = document.querySelector('input[type="email"]');
        if (field?.value.toLowerCase() !== ${JSON.stringify(email)}) return null;
        const buttons = [...document.querySelectorAll('button, [role="button"]')].filter((button) =>
          button.getClientRects().length && !button.matches(':disabled, [aria-disabled="true"]') &&
          [button.getAttribute("aria-label"), button.innerText].some(
            (label) => /^Continue with email$/i.test(label?.trim() ?? "")));
        if (buttons.length !== 1) return null;
        buttons[0].click();
        return true;
      `,
          { mainFrameOnly: true, userGesture: true },
          Date.now() + 4_000,
        ))
      );
      return { tab, email, filled: !!focused, requested, watching };
    },
  );
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
          attempt.startTab = tab;
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
        if (attempt && result?.value === true) {
          const entry = attempt.guided && archive(request, sid);
          if (entry && id && request.body.password !== undefined) {
            const { firstName, lastName, country, birthday, phoneCode, phone, password } =
              request.body;
            await entry.accounts.save(entry.user, entry.profile, id.toLowerCase(), {
              firstName,
              lastName,
              country,
              birthday,
              phoneCode,
              phone,
              email: details.email,
              password,
            });
          }
          attempt.email = details.email;
          if (details.owner && details.mailboxId)
            attempt.inbox = { owner: details.owner, mailboxId: details.mailboxId, since };
        }
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
        if (provider === "apple" && id && !attempt) {
          const previous = attempts.get(sid, id);
          if (
            previous?.guided &&
            previous.tab === tab &&
            previous.browser === session(sid)?.browser &&
            (previous.smsSubmitted || previous.termsSeen)
          ) {
            if (await welcomeReceived(previous)) {
              previous.termsOutcome = "complete";
              archiveState(request, sid, id, "accepted");
              return { ready: false, expired: true, challenge: { kind: "complete" } };
            }
            return { ready: false, expired: true, challenge: { kind: "closed" } };
          }
          return appleGone(reply);
        }
        const status = verification.status(provider, request.params, userId(request));
        if (!attempt?.guided || !attempt.email) return status;
        const { signal } = attempt.control;
        return performApple(reply, signal, async () => {
          if (attempt.termsOutcome) return { ...status, challenge: { kind: attempt.termsOutcome } };
          const browser = session(sid)!.browser;
          const challenge = await readAppleChallenge(browser, tab, signal);
          const root = attempt.startTab ?? tab;
          if (
            challenge.kind === "waiting" ||
            challenge.kind === "complete" ||
            challenge.kind === "sms"
          ) {
            const terms = await findAppleTerms(browser, root, signal);
            if (terms || challenge.kind === "complete") archiveState(request, sid, id!, "created");
            if (terms) {
              attempt.termsSeen = true;
              return { ...status, challenge: { kind: "terms", tab: terms.tab } };
            }
            if (
              (attempt.termsSeen || attempt.smsSubmitted) &&
              ((await appleFinished(browser, root, signal)) || (await welcomeReceived(attempt)))
            ) {
              attempt.termsOutcome = "complete";
              archiveState(request, sid, id!, "accepted");
              return { ...status, challenge: { kind: "complete" } };
            }
          }
          return { ...status, challenge };
        });
      },
    );
  }
  app.post<{
    Params: TabParams;
    Querystring: AppleQuery;
    Body:
      | { kind: "captcha" | "email" | "sms"; code: string }
      | { kind: "terms"; choice: "agree" | "disagree" };
  }>(
    `${route}/apple/:tab/verification`,
    {
      preHandler: applePreHandler,
      bodyLimit: 256,
      schema: {
        querystring: { ...attemptQuery, required: ["attempt"] },
        body: {
          anyOf: [
            {
              type: "object",
              required: ["kind", "code"],
              additionalProperties: false,
              properties: { kind: { enum: ["captcha", "email", "sms"] }, code: requiredText(20) },
            },
            {
              type: "object",
              required: ["kind", "choice"],
              additionalProperties: false,
              properties: { kind: { const: "terms" }, choice: { enum: ["agree", "disagree"] } },
            },
          ],
        },
      },
    },
    async (request, reply) => {
      const { sid, tab } = request.params;
      const attempt = appleAttempt(sid, tab, request.query.attempt!);
      if (!attempt?.guided || !attempt.email) return appleGone(reply);
      const body = request.body;
      if (attempt.submitting) return reply.code(409).send({ error: "请等待 Apple 处理上一次提交" });
      const signal = attempt.control.signal;
      const browser = session(sid)!.browser;
      attempt.submitting = true;
      try {
        return await performApple(reply, signal, async () => {
          if (body.kind === "terms") {
            if (attempt.termsOutcome) return { challenge: { kind: attempt.termsOutcome } };
            const root = attempt.startTab ?? tab;
            const initial = await findAppleTerms(browser, root, signal, body.choice);
            if (!initial)
              return reply
                .code(409)
                .send({ error: "未找到可操作的 iCloud 条款，请在 Apple 页面查看" });
            let confirmed = initial.value === "confirm";
            let gone = 0;
            for (let retry = 0; retry < 16; retry++) {
              await pause(250, undefined, { signal });
              const stage = await findAppleTerms(browser, root, signal);
              if (!confirmed && body.choice === "agree" && stage?.value === "confirm") {
                confirmed = !!(await findAppleTerms(browser, root, signal, "confirm"));
              }
              gone = stage ? 0 : gone + 1;
              if (
                gone >= 3 &&
                (confirmed ||
                  body.choice === "disagree" ||
                  !findPage(browser, root) ||
                  (await appleFinished(browser, root, signal)))
              ) {
                attempt.termsOutcome = body.choice === "agree" ? "complete" : "declined";
                archiveState(
                  request,
                  sid,
                  request.query.attempt!,
                  body.choice === "agree" ? "accepted" : "declined",
                );
                attempts.refresh(sid, request.query.attempt!);
                return { challenge: { kind: attempt.termsOutcome } };
              }
            }
            return reply
              .code(409)
              .send({ error: "Apple 的条款页面仍然打开，请在 Apple 页面查看是否需要确认" });
          }
          const { kind, code } = body;
          if (kind !== "captcha" && !/^\d{6}$/.test(code))
            return reply.code(409).send({ error: "请输入六位验证码" });
          if (kind === "captcha") {
            const focused = await checkForm<boolean>(
              browser,
              tab,
              APPLE_FORM,
              appleChallenge("focus"),
              { signal },
            );
            if (!focused?.value)
              return reply.code(409).send({ error: "Apple 的图形验证码输入框已变化，请重试" });
            const page = findPage(browser, focused.tab);
            if (!page) return appleGone(reply);
            signal.throwIfAborted();
            await browser.send(page.sessionId, "Input.insertText", { text: code });
          }
          const result = await (kind === "captcha" ? waitForForm : checkForm)(
            browser,
            tab,
            APPLE_FORM,
            kind === "captcha"
              ? appleChallenge("submit", code)
              : appleCode(attempt.email!, code, kind),
            { signal, userGesture: true },
            Date.now() + 3_000,
          );
          if (result?.value !== "submitted")
            return reply
              .code(409)
              .send({ error: "未能点击 Apple 的 Continue，请重试或在 Apple 页面继续" });
          if (kind === "sms") attempt.smsSubmitted = true;
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
      const opened = await verification.open(request.params, userId(request), (url) =>
        openClaudeLink(current.browser, tab, url),
      );
      if (!opened) return reply.code(409).send({ error: "请在原来的 Claude 登录标签中继续" });
      return { opened: true };
    },
  );
}

type GoogleStage =
  | "name"
  | "birthday"
  | "credentials"
  | "phone"
  | "recovery"
  | "sms"
  | "captcha"
  | "terms"
  | "complete"
  | "waiting";
type GoogleChallenge =
  { kind: "captcha"; image: string } | { kind: "sms" | "terms" | "complete" | "waiting" };

async function fillGoogleRegistration(
  browser: Browser,
  tab: string,
  details: GoogleDetails,
  signal: AbortSignal,
) {
  const started = await waitForForm<boolean>(
    browser,
    tab,
    [GOOGLE_MAIL, GOOGLE_ACCOUNTS],
    `
      const visible = (element) => element.getClientRects().length &&
        getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert],[aria-hidden="true"]');
      if (location.origin === ${JSON.stringify(GOOGLE_ACCOUNTS)} && /\\/signup(?:\\/|$)/.test(location.pathname)) return true;
      if (location.origin !== ${JSON.stringify(GOOGLE_MAIL)}) return null;
      const link = [...document.querySelectorAll('a,button,[role="button"]')].find((element) =>
        visible(element) && /create account/i.test([element.innerText, element.getAttribute('aria-label'), element.getAttribute('href')].join(' ')));
      if (!link) return null;
      link.click();
      return true;
    `,
    { mainFrameOnly: true, userGesture: true, signal, originOnly: true },
    Date.now() + 10_000,
  );
  if (!started) return null;
  return advanceGoogleRegistration(browser, tab, details, signal);
}

async function advanceGoogleRegistration(
  browser: Browser,
  tab: string,
  details: GoogleDetails,
  signal: AbortSignal,
): Promise<GoogleStage> {
  for (let index = 0; index < 12; index++) {
    const result = await waitForForm<GoogleStage>(
      browser,
      tab,
      GOOGLE_ACCOUNTS,
      googleRegistrationStep(details),
      { mainFrameOnly: true, userGesture: true, signal, originOnly: true },
      Date.now() + 8_000,
    );
    if (!result) return "waiting";
    if (["sms", "captcha", "terms", "complete", "waiting"].includes(result.value))
      return result.value;
  }
  return "waiting";
}

function googleRegistrationStep(details: GoogleDetails) {
  return `
    ${SET_VALUE}
    const details = ${JSON.stringify(details)};
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert],[aria-hidden="true"]');
    const writable = (element) => visible(element) && !element.disabled && !element.readOnly;
    const field = (...selectors) => selectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .find(writable);
    const button = (labels) => [...document.querySelectorAll('button,[role="button"],input[type="submit"]')]
      .find((element) => visible(element) && !element.matches(':disabled,[aria-disabled="true"]') &&
        labels.some((label) => new RegExp('^' + label + '$', 'i').test((element.innerText || element.value || '').trim())));
    const next = () => button(['next', 'continue', 'create account']);
    const text = document.body.innerText.replace(/\\s+/g, ' ').toLowerCase();
    if (/account created|welcome to your google account|you\\'re all set/.test(text)) return 'complete';
    if (/privacy and terms|terms of service/.test(text) && button(['i agree', 'agree', 'accept'])) return 'terms';
    const code = field('input[autocomplete="one-time-code"]', 'input[name="code"]', 'input[name="pin"]');
    if (code && /verify|code|phone|text message/.test(text)) return 'sms';
    const first = field('input[name="firstName"]', 'input[autocomplete="given-name"]');
    const last = field('input[name="lastName"]', 'input[autocomplete="family-name"]');
    if (first && last) {
      if (!setValue(first, details.firstName) || !setValue(last, details.lastName)) return null;
      next()?.click();
      return 'name';
    }
    const month = field('select[name="month"]');
    const day = field('input[name="day"]');
    const year = field('input[name="year"]');
    if (month && day && year) {
      const [yearValue, monthValue, dayValue] = details.birthday.split('-');
      const monthOption = [...month.options].find((option) =>
        option.value === String(Number(monthValue)) || option.textContent?.trim().startsWith(String(Number(monthValue))));
      if (!monthOption || !setValue(month, monthOption.value) || !setValue(day, dayValue) || !setValue(year, yearValue)) return null;
      const gender = field('select[name="gender"]');
      if (gender) {
        const option = [...gender.options].find((item) =>
          new RegExp(details.gender === 'female' ? 'female|woman' : details.gender === 'male' ? 'male|man' : details.gender === 'other' ? 'custom|other' : 'rather', 'i').test(item.textContent ?? ''));
        if (option && !setValue(gender, option.value)) return null;
      }
      next()?.click();
      return 'birthday';
    }
    const username = field('input[name="Username"]', 'input[autocomplete="username"]');
    const password = field('input[name="Passwd"]', 'input[type="password"]');
    const confirmation = field('input[name="PasswdAgain"]');
    if (username && password) {
      if (!setValue(username, details.username) || !setValue(password, details.password)) return null;
      if (confirmation && !setValue(confirmation, details.passwordConfirmation)) return null;
      next()?.click();
      return 'credentials';
    }
    const phone = field('input[name="phoneNumber"]', 'input[type="tel"]');
    if (phone) {
      if (details.phone && !setValue(phone, details.phone)) return null;
      if (details.phone) next()?.click();
      return 'phone';
    }
    const recovery = field('input[name="recoveryEmail"]', 'input[type="email"]');
    if (recovery && details.recoveryEmail) {
      setValue(recovery, details.recoveryEmail);
      next()?.click();
      return 'recovery';
    }
    return null;
  `;
}

async function readGoogleChallenge(
  browser: Browser,
  tab: string,
  signal: AbortSignal,
): Promise<GoogleChallenge> {
  const result = await checkForm<
    { kind: "captcha"; src: string } | { kind: "sms" | "terms" | "complete" }
  >(
    browser,
    tab,
    GOOGLE_ACCOUNTS,
    `
      const visible = (element) => element.getClientRects().length &&
        getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert],[aria-hidden="true"]');
      const text = document.body.innerText.replace(/\\s+/g, ' ').toLowerCase();
      if (/account created|welcome to your google account|you\\'re all set/.test(text)) return { kind: 'complete' };
      if (/privacy and terms|terms of service/.test(text) &&
          [...document.querySelectorAll('button,[role="button"]')].some((element) => visible(element) && /^(?:i agree|agree|accept)$/i.test(element.innerText.trim())))
        return { kind: 'terms' };
      const image = [...document.images].find((element) => visible(element) && element.naturalWidth &&
        /captcha|recaptcha|challenge/i.test([element.id, element.alt, element.currentSrc].join(' ')));
      if (image) return { kind: 'captcha', src: image.currentSrc };
      const code = [...document.querySelectorAll('input')].find((element) => visible(element) &&
        !element.disabled && !element.readOnly && (element.autocomplete === 'one-time-code' || /verification|code|pin/i.test(element.name + ' ' + element.id + ' ' + element.placeholder)));
      if (code && /verify|code|phone|text message/.test(text)) return { kind: 'sms' };
      return null;
    `,
    { mainFrameOnly: true, originOnly: true, signal },
  );
  if (!result) return { kind: "waiting" };
  if (result.value.kind !== "captcha") return result.value;
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,[\w+/=]+$/i.test(result.value.src))
    return { kind: "captcha", image: result.value.src };
  const resource = (await browser
    .send(result.sessionId, "Page.getResourceContent", {
      frameId: result.frameId,
      url: result.value.src,
    })
    .catch(() => undefined)) as Protocol.Page.GetResourceContentResponse | undefined;
  signal.throwIfAborted();
  if (!resource?.base64Encoded || resource.content.length > 400_000) return { kind: "waiting" };
  const format = resource.content.startsWith("iVBORw0KGgo")
    ? "png"
    : resource.content.startsWith("/9j/")
      ? "jpeg"
      : resource.content.startsWith("R0lGOD")
        ? "gif"
        : undefined;
  return format
    ? { kind: "captcha", image: `data:image/${format};base64,${resource.content}` }
    : { kind: "waiting" };
}

async function submitGoogleCode(
  browser: Browser,
  tab: string,
  kind: "captcha" | "sms",
  code: string,
  signal: AbortSignal,
) {
  const result = await waitForForm<boolean>(
    browser,
    tab,
    GOOGLE_ACCOUNTS,
    `
      ${SET_VALUE}
      const code = ${JSON.stringify(code)};
      const visible = (element) => element.getClientRects().length &&
        getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert],[aria-hidden="true"]');
      const field = [...document.querySelectorAll('input')].find((element) => visible(element) &&
        !element.disabled && !element.readOnly && (${JSON.stringify(kind)} === 'captcha'
          ? /captcha|challenge/i.test(element.name + ' ' + element.id + ' ' + element.placeholder)
          : element.autocomplete === 'one-time-code' || /verification|code|pin/i.test(element.name + ' ' + element.id + ' ' + element.placeholder)));
      if (!field || !setValue(field, code)) return null;
      const scope = field.form ?? field.closest('dialog,[role="dialog"]') ?? document;
      const button = [...scope.querySelectorAll('button,[role="button"],input[type="submit"]')].find((element) =>
        visible(element) && !element.matches(':disabled,[aria-disabled="true"]') && /^(?:next|continue|verify|submit)$/i.test((element.innerText || element.value || '').trim()));
      if (!button) return true;
      button.click();
      return true;
    `,
    { mainFrameOnly: true, originOnly: true, userGesture: true, signal },
    Date.now() + 4_000,
  );
  return !!result?.value;
}

async function submitGoogleTerms(
  browser: Browser,
  tab: string,
  choice: "agree" | "disagree",
  signal: AbortSignal,
) {
  const result = await waitForForm<boolean>(
    browser,
    tab,
    GOOGLE_ACCOUNTS,
    `
      const choice = ${JSON.stringify(choice)};
      const visible = (element) => element.getClientRects().length &&
        getComputedStyle(element).visibility !== "hidden" && !element.closest('[inert],[aria-hidden="true"]');
      const labels = choice === 'agree' ? /^(?:i agree|agree|accept)$/i : /^(?:i don\\'t agree|disagree|cancel)$/i;
      const button = [...document.querySelectorAll('button,[role="button"],input[type="submit"]')].find((element) =>
        visible(element) && !element.matches(':disabled,[aria-disabled="true"]') && labels.test((element.innerText || element.value || '').trim()));
      if (!button) return null;
      button.click();
      return true;
    `,
    { mainFrameOnly: true, originOnly: true, userGesture: true, signal },
    Date.now() + 4_000,
  );
  return !!result?.value;
}

async function openClaudeLink(browser: Browser, tab: string, url: string) {
  const result = await checkForm<boolean>(browser, tab, CLAUDE_LOGIN, "return true;", {
    mainFrameOnly: true,
  });
  if (!result?.value) return false;
  const navigation = (await browser.send(result.sessionId, "Page.navigate", {
    url,
  })) as Protocol.Page.NavigateResponse;
  return !navigation.errorText;
}

async function assistClaudeApple(
  browser: Browser,
  tab: string,
  account: AppleCredentials,
  signal: AbortSignal,
  saveRelay: (email: string) => Promise<void>,
) {
  let enteredEmail = false;
  let enteredPassword = false;
  let selectedHide = false;
  while (!signal.aborted && findPage(browser, tab)) {
    const action = await checkForm<"email" | "password" | "hide">(
      browser,
      tab,
      APPLE_AUTH,
      `
      if (!/^\\/(?:appleauth|auth)\\//.test(location.pathname)) return null;
      ${SET_VALUE}
      const { email, password, enteredEmail, enteredPassword, selectedHide } =
        ${JSON.stringify({ email: account.email, password: account.password, enteredEmail, enteredPassword, selectedHide })};
      const visible = (element) => element.getClientRects().length &&
        getComputedStyle(element).visibility === "visible" && !element.closest('[inert], [aria-hidden="true"]');
      const field = (selector) => [...document.querySelectorAll(selector)].find((input) =>
        visible(input) && !input.disabled && !input.readOnly);
      const next = (scope) => {
        const buttons = [...scope.querySelectorAll('button,input[type="submit"],[role="button"]')].filter((button) =>
          visible(button) && !button.matches(':disabled,[aria-disabled="true"]') &&
          (button.id === "sign-in" || [button.getAttribute("aria-label"), button.matches("input") ? button.value : button.innerText]
            .some((label) => /^(?:continue|sign in|next)$/i.test(label?.trim() ?? ""))));
        if (buttons.length === 1) buttons[0].click();
      };
      const choices = [...document.querySelectorAll('input[type="radio"],[role="radio"],label')]
        .filter((option) => visible(option) && (!option.matches("label") || option.control?.type === "radio"));
      const hide = choices.find((option) => /^hide my email\\b/i.test((
        option.getAttribute("aria-label") || option.innerText ||
        Array.from(option.labels ?? [], (label) => label.innerText).join(" ")
      ).trim()));
      if (hide && !selectedHide) {
        const selected = () => hide.checked || hide.control?.checked || hide.getAttribute("aria-checked") === "true";
        if (!selected()) hide.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!selected()) return null;
        next(hide.form ?? hide.closest('dialog,[role="dialog"]') ?? document);
        return "hide";
      }
      const username = field('#account_name_text_field,input[type="email"],input[autocomplete="username"]');
      const secret = field('input[type="password"]');
      if (secret && !enteredPassword &&
        (enteredEmail || username?.value.toLowerCase() === email.toLowerCase() ||
          document.body.innerText.toLowerCase().includes(email.toLowerCase()))) {
        if (!setValue(secret, password)) return null;
        await new Promise((resolve) => setTimeout(resolve, 0));
        next(secret.form ?? document);
        return "password";
      }
      if (username && !enteredEmail && setValue(username, email)) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!secret) next(username.form ?? document);
        return "email";
      }
      return null;
      `,
      { originOnly: true, includePopups: true, signal, userGesture: true },
    );
    if (action?.value === "email") enteredEmail = true;
    if (action?.value === "password") enteredPassword = true;
    if (action?.value === "hide") selectedHide = true;
    if (enteredPassword) {
      const login = await checkForm<string>(
        browser,
        tab,
        "https://claude.ai",
        `
        if (location.pathname === "/login") return null;
        const response = await fetch("/api/account", { cache: "no-store", signal: AbortSignal.timeout(800) });
        if (!response.ok) return null;
        const account = await response.json();
        return account.email_address ?? account.account?.email_address ?? null;
      `,
        { originOnly: true, mainFrameOnly: true, includePopups: true, signal },
      );
      if (typeof login?.value === "string" && isAppleRelayEmail(login.value)) {
        await saveRelay(login.value.toLowerCase());
        return;
      }
    }
    await pause(1_500, undefined, { ref: false, signal });
  }
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

function appleChallenge(action = "read", code?: string) {
  return `
    const action = ${JSON.stringify(action)};
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
      const buttons = [...root.querySelectorAll('button, input[type="submit"], [role="button"]')].filter((button) =>
        visible(button) && !button.matches(':disabled, [aria-disabled="true"]') &&
        [button.getAttribute("aria-label"), button.matches("input") ? button.value : button.innerText].some(
          label => /^(?:continue|create (?:an? |your )?(?:apple )?account)$/i.test(label?.trim() ?? "")));
      return buttons.length === 1 ? buttons[0] : undefined;
    };
    const submit = (field) => {
      const scope = field.form ?? field.closest('dialog, [role="dialog"]') ?? document;
      const button = continueButton(scope) ?? (scope !== document && continueButton(document));
      if (!button) return null;
      button.click();
      return "submitted";
    };
    if (captcha && images.length === 1) {
      if (action === "read") {
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
      if (action === "focus") {
        captcha.focus();
        captcha.select();
        return captcha === document.activeElement;
      }
      if (captcha.value !== code) return null;
      captcha.blur();
      return submit(captcha);
    }
    if (action !== "read") return null;
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
  originOnly?: boolean;
  signal?: AbortSignal;
}

function findAppleTerms(
  browser: Browser,
  tab: string,
  signal: AbortSignal,
  choice?: "agree" | "disagree" | "confirm",
) {
  return checkForm<"terms" | "confirm">(
    browser,
    tab,
    APPLE_TERMS,
    `
    const choice = ${JSON.stringify(choice)};
    const visible = (element) => element.getClientRects().length &&
      getComputedStyle(element).visibility === "visible" && !element.closest('[inert], [aria-hidden="true"]');
    const buttons = (root, label) => [...root.querySelectorAll('button,[role="button"],input[type="submit"]')]
      .filter((button) => visible(button) &&
        [button.getAttribute("aria-label"), button.matches("input") ? button.value : button.innerText]
          .some((text) => text?.trim().toLowerCase() === label));
    const click = (button) => {
      if (!button || button.matches(':disabled,[aria-disabled="true"]')) return false;
      button.click();
      return true;
    };
    for (const dialog of document.querySelectorAll('dialog,[role="dialog"],[role="alertdialog"]')) {
      if (!visible(dialog) || !/iCloud Terms (?:and|&) Conditions/i.test(dialog.innerText)) continue;
      const agree = buttons(dialog, "agree");
      if (agree.length === 1 && buttons(dialog, "cancel").length === 1) {
        if (choice && (choice === "disagree" || !click(agree[0]))) return null;
        return "confirm";
      }
    }
    if (choice === "confirm") return null;
    const title = (text) => /^iCloud Terms (?:and|&) Conditions$/i.test(text.trim());
    const heading = [...document.querySelectorAll('h1,h2,h3,[role="heading"]')].find((element) =>
      visible(element) && title(element.innerText));
    if (!heading && !document.body.innerText.split("\\n").some(title)) return null;
    const findActions = (scope) => {
      const agree = buttons(scope, "agree");
      const disagree = buttons(scope, "disagree");
      if (agree.length === 1 && disagree.length === 1) return { agree: agree[0], disagree: disagree[0] };
    };
    const scope = heading?.closest('dialog,[role="dialog"]') ?? document;
    const actions = findActions(scope) ?? (scope !== document && findActions(document));
    if (!actions) return null;
    if (choice && !click(actions[choice])) return null;
    return "terms";
  `,
    { includePopups: true, originOnly: true, userGesture: !!choice, signal },
  );
}

async function appleFinished(browser: Browser, tab: string, signal: AbortSignal) {
  return !!(await checkForm<boolean>(
    browser,
    tab,
    ICLOUD,
    `
    const elements = [...document.querySelectorAll('button,[role="button"],a')].filter((element) =>
      element.getClientRects().length && !element.closest('[inert],[aria-hidden="true"]'));
    const has = (label) => elements.some((element) =>
      [element.getAttribute("aria-label"), element.title, element.innerText]
        .some((text) => text?.trim().toLowerCase() === label));
    return (has("app launcher") && (has("account") || has("icloud settings"))) || has("sign out") ? true : null;
  `,
    { includePopups: true, mainFrameOnly: true, originOnly: true, signal },
  ));
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
  form: string | readonly string[],
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
  form: string | readonly string[],
  source: string,
  scope: FormScope = {},
): Promise<{ tab: string; value: T; sessionId: string; frameId: string } | null> {
  const { signal } = scope;
  signal?.throwIfAborted();
  const allowed = (typeof form === "string" ? [form] : form).map((url) =>
    scope.originOnly ? new URL(url).origin : url,
  );
  const expression = `(async () => {
    if (!${JSON.stringify(allowed)}.includes(location.origin ${scope.originOnly ? "" : "+ location.pathname"})) return null;
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
        const url = scope.originOnly ? new URL(frame.url).origin : frame.url.split(/[?#]/, 1)[0]!;
        if (!allowed.includes(url)) continue;
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
