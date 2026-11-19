import { AppleRegistrationFields } from "./apple-registration-fields";
import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, apiRequest } from "./api";
import { writeLocalClipboard } from "./chrome/clipboard";
import { useDialog } from "./dialog";
import { mailboxApi, mailboxLabel } from "./mailboxes";
import "./user-panel.css";
import "./account-onboarding.css";

interface RegistrationOptions {
  countries: [string, string][];
  phoneCodes: [string, string][];
}

interface AppleRegistration {
  tab: string;
  options: RegistrationOptions | null;
}

interface AppleAttempt {
  id: string;
  controller: AbortController;
  fetcher: typeof fetch;
  seenTabs: Set<string>;
}

const appleAccountStates = {
  pending: "待验证",
  created: "已创建",
  accepted: "已同意条款",
  declined: "未同意条款",
};
interface SavedAppleAccount {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  state: keyof typeof appleAccountStates;
}
interface SavedAppleDetails {
  birthday: string;
  country: string;
  phoneCode: string;
  phone: string;
  password: string;
}

type Step =
  | { name: "start" }
  | {
      name: "saved";
      accounts: SavedAppleAccount[];
      selected?: SavedAppleAccount & SavedAppleDetails;
    }
  | { name: "claude"; email?: string }
  | { name: "apple"; apple: AppleRegistration }
  | {
      name: "apple-verification" | "claude-verification";
      tab: string;
      watching: boolean;
      filled: boolean;
      email: string;
      mailboxId?: string;
    };

interface Verification {
  received?: boolean;
  ready: boolean;
  expired: boolean;
  submitted?: boolean;
  challenge?:
    | { kind: "captcha"; image: string }
    | { kind: "terms"; tab: string }
    | { kind: "email" | "sms" | "complete" | "declined" | "waiting" };
}

interface AccountOnboardingProps {
  open: boolean;
  startApple?: boolean;
  sid: string;
  profileKey: string;
  profileName: string | undefined;
  storage: Pick<Storage, "getItem" | "setItem">;
  tabs: readonly { id: string }[];
  browserConnected: boolean;
  onClose(): void;
  onOpenTab(tab: string): void;
}

const NEW_ADDRESS = "new";
const PERSONAL_ADDRESS = "personal";

const APPLE_TAB_CLOSED = "Apple 注册标签已关闭，可以重新开始。";
const APPLE_ATTEMPT_ENDED = "Apple 注册向导已结束，可以重新开始。";

export function AccountOnboarding({
  open,
  startApple,
  sid,
  profileKey,
  profileName,
  storage,
  tabs,
  browserConnected,
  onClose,
  onOpenTab,
}: AccountOnboardingProps) {
  const appleAttempt = useRef<AppleAttempt | null>(null);
  const autoStarted = useRef(false);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
  const close = () => {
    if (step.name === "saved") goTo({ name: "start" });
    setShowPassword(false);
    if (!appleAttempt.current?.controller.signal.aborted) setError(null);
    onClose();
  };
  const panel = useDialog(open, close);
  const [step, setStep] = useState<Step>({ name: "start" });
  const [mailboxes, setMailboxes] = useState<Awaited<ReturnType<typeof mailboxApi.addresses>>>();
  const [mailboxValue, setMailboxValue] = useState<string>();
  const [verification, setVerification] = useState<Verification>({ ready: false, expired: false });
  const [pending, setPending] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = pending || appleAttempt.current?.controller.signal.aborted === true;
  const route = `/api/client/session/${encodeURIComponent(sid)}/onboarding`;
  const applePath = (attempt: AppleAttempt, suffix = "") =>
    `${route}/apple${suffix}?attempt=${attempt.id}`;
  const appleTab =
    step.name === "apple" ? step.apple.tab : step.name === "apple-verification" ? step.tab : null;
  const appleVerification = step.name === "apple-verification" ? appleAttempt.current : null;
  const verificationRoute =
    step.name === "apple-verification" && appleVerification
      ? applePath(appleVerification, `/${encodeURIComponent(step.tab)}/verification`)
      : step.name === "claude-verification"
        ? `${route}/claude/${encodeURIComponent(step.tab)}/verification`
        : null;
  const watching = "watching" in step && step.watching;

  const stopApple = () => {
    const attempt = appleAttempt.current;
    if (!attempt) return;
    appleAttempt.current = null;
    attempt.controller.abort();
    void apiRequest(applePath(attempt), "DELETE").catch(() => {});
  };
  const goTo = (next: Step) => {
    setStep(next);
    setMailboxValue(undefined);
    setPassword(next.name === "apple" && next.apple.options ? generatePassword() : "");
    setShowPassword(false);
    setPasswordCopied(false);
    setVerification({ ready: false, expired: false });
    setError(null);
  };
  const resetApple = (message?: string) => {
    stopApple();
    goTo({ name: "start" });
    setPending(false);
    setCanceling(false);
    if (message) setError(message);
  };
  const cancelApple = async () => {
    const attempt = appleAttempt.current!;
    attempt.controller.abort();
    setPending(false);
    setCanceling(true);
    setError(null);
    try {
      await apiRequest(applePath(attempt), "DELETE");
      if (appleAttempt.current !== attempt) return;
      appleAttempt.current = null;
      resetApple();
    } catch {
      if (appleAttempt.current !== attempt) return;
      setCanceling(false);
      setError("暂时无法取消 Apple 向导。请重试。");
    }
  };

  useEffect(() => () => stopApple(), [route]);
  useEffect(() => {
    const attempt = appleAttempt.current;
    if (!attempt || !browserConnected || !tabs.length) return;
    for (const tab of tabs) attempt.seenTabs.add(tab.id);
    if (
      appleTab &&
      step.name === "apple" &&
      attempt.seenTabs.has(appleTab) &&
      !tabs.some(({ id }) => id === appleTab)
    )
      resetApple(APPLE_TAB_CLOSED);
  }, [appleTab, browserConnected, pending, tabs]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const unavailable = { enabled: false, addresses: [] };
    void mailboxApi.addresses().then(
      (result) => {
        if (!active) return;
        setMailboxes(result);
        setMailboxValue((id) =>
          id === NEW_ADDRESS ||
          id === PERSONAL_ADDRESS ||
          result.addresses.some((item) => item.id === id)
            ? id
            : undefined,
        );
      },
      () => {
        if (active) setMailboxes(unavailable);
      },
    );
    return () => {
      active = false;
    };
  }, [open]);

  useEffect(() => {
    const guided = step.name === "apple-verification" && step.filled;
    if (
      !open ||
      !verificationRoute ||
      (guided
        ? pending ||
          verification.challenge?.kind === "complete" ||
          verification.challenge?.kind === "declined"
        : !watching || verification.ready || verification.expired)
    )
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const status = await apiRequest<Verification>(
          verificationRoute,
          "GET",
          undefined,
          appleVerification?.fetcher,
        );
        if (active && !appleVerification?.controller.signal.aborted) {
          setVerification(status);
          if (!guided) setError(null);
        }
      } catch (failure) {
        if (active && !appleVerification?.controller.signal.aborted) {
          if (appleVerification && failure instanceof ApiError && failure.status === 410)
            resetApple(APPLE_ATTEMPT_ENDED);
          else setError((failure as Error).message);
        }
      } finally {
        if (active && !appleVerification?.controller.signal.aborted)
          timer = setTimeout(check, 2_000);
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    open,
    verificationRoute,
    pending,
    watching,
    verification.ready,
    verification.expired,
    verification.challenge?.kind,
  ]);

  const perform = async (task: () => Promise<void>, attempt?: AppleAttempt) => {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (failure) {
      if (attempt?.controller.signal.aborted) return;
      if (attempt && failure instanceof ApiError && failure.status === 410)
        resetApple(APPLE_ATTEMPT_ENDED);
      else if (attempt && step.name === "start") resetApple((failure as Error).message);
      else setError((failure as Error).message);
    } finally {
      if (!attempt?.controller.signal.aborted) setPending(false);
    }
  };
  const openTab = (tab: string) => {
    onOpenTab(tab);
    close();
  };
  const openApple = () => {
    if (appleAttempt.current) return;
    const controller = new AbortController();
    const attempt: AppleAttempt = {
      id: crypto.randomUUID(),
      controller,
      fetcher: (input, init) => fetch(input, { ...init, signal: controller.signal }),
      seenTabs: new Set(),
    };
    appleAttempt.current = attempt;
    void perform(async () => {
      const apple = await apiRequest<AppleRegistration>(
        `${applePath(attempt)}&guided=true`,
        "POST",
        undefined,
        attempt.fetcher,
      );
      if (controller.signal.aborted) return;
      const options = apple.options && {
        countries: apple.options.countries.filter(([value]) => value),
        phoneCodes: apple.options.phoneCodes.filter(([value]) => value),
      };
      goTo({
        name: "apple",
        apple: {
          tab: apple.tab,
          options: options?.countries.length && options.phoneCodes.length ? options : null,
        },
      });
    }, attempt);
  };
  useEffect(() => {
    if (!open || !startApple || autoStarted.current) return;
    autoStarted.current = true;
    openApple();
  }, [open, startApple]);
  const aliasKey = `mirror.mailbox.${profileKey}.${step.name}`;
  const rememberedAlias = open && mailboxes?.addresses.length ? storage.getItem(aliasKey) : null;
  const selectedMailbox =
    mailboxValue ??
    mailboxes?.addresses.find((address) => address.id === rememberedAlias)?.id ??
    (mailboxes?.enabled ? NEW_ADDRESS : PERSONAL_ADDRESS);
  const openClaude = async (identity: { mailboxId: string } | { email: string }, email: string) => {
    const { tab, filled, watching } = await apiRequest<{
      tab: string;
      filled: boolean;
      watching: boolean;
    }>(`${route}/claude`, "POST", identity);
    if ("mailboxId" in identity)
      storage.setItem(`mirror.mailbox.${profileKey}.claude`, identity.mailboxId);
    if (watching || !filled) goTo({ name: "claude-verification", tab, filled, watching, email });
    else goTo({ name: "start" });
    openTab(tab);
  };
  const submitForm = async (form: FormData, attempt?: AppleAttempt) => {
    const service = attempt ? "Apple" : "Claude";
    let email = String(form.get("email") ?? "").trim();
    form.delete("email");
    let identity: { mailboxId: string } | { email: string };
    if (selectedMailbox === NEW_ADDRESS) {
      const label = profileName ? `${profileName.slice(0, 70)} · ${service}` : service;
      const { address } = await mailboxApi.create(label, attempt?.fetcher);
      if (attempt?.controller.signal.aborted) return;
      setMailboxes((current) => ({
        enabled: true,
        addresses: [...(current?.addresses ?? []), address],
      }));
      setMailboxValue(address.id);
      email = address.address;
      identity = { mailboxId: address.id };
    } else {
      identity = selectedMailbox === PERSONAL_ADDRESS ? { email } : { mailboxId: selectedMailbox };
      if ("mailboxId" in identity)
        email =
          mailboxes?.addresses.find((address) => address.id === selectedMailbox)?.address ?? "";
    }
    if ("mailboxId" in identity) storage.setItem(aliasKey, identity.mailboxId);
    if (step.name === "apple" && attempt) {
      const { tab } = step.apple;
      const { filled, watching } = await apiRequest<{ filled: boolean; watching: boolean }>(
        applePath(attempt, `/${encodeURIComponent(tab)}`),
        "POST",
        { ...Object.fromEntries(form), ...identity },
        attempt.fetcher,
      );
      if (attempt.controller.signal.aborted) return;
      goTo({
        name: "apple-verification",
        tab,
        filled,
        watching,
        email,
        mailboxId: "mailboxId" in identity ? identity.mailboxId : undefined,
      });
    }
    if (step.name === "claude") await openClaude(identity, email);
  };

  if (!open && step.name !== "apple") return null;

  const needsAppleDetails =
    step.name === "apple-verification" && !step.filled && !verification.ready;
  const challenge = verification.challenge;
  const appleEnded = challenge?.kind === "complete" || challenge?.kind === "declined";
  const decideTerms = (choice: "agree" | "disagree") => {
    void perform(async () => {
      const result = await apiRequest<Pick<Verification, "challenge">>(
        verificationRoute!,
        "POST",
        { kind: "terms", choice },
        appleVerification?.fetcher,
      );
      setVerification((value) => ({ ...value, ...result }));
    }, appleVerification ?? undefined);
  };
  const manualChallenge =
    challenge?.kind === "captcha" ||
    challenge?.kind === "sms" ||
    (challenge?.kind === "email" &&
      (!watching || verification.expired || (verification.ready && !verification.submitted)));
  const emailField = (
    <>
      {mailboxes?.enabled || mailboxes?.addresses.length ? (
        <label>
          收件地址
          <select
            value={selectedMailbox}
            disabled={busy}
            onChange={(event) => setMailboxValue(event.currentTarget.value)}
          >
            {mailboxes.enabled && <option value={NEW_ADDRESS}>新建专属收件地址</option>}
            {mailboxes.addresses.map((address) => (
              <option key={address.id} value={address.id}>
                {mailboxLabel(address)}
              </option>
            ))}
            <option value={PERSONAL_ADDRESS}>输入其他邮箱</option>
          </select>
        </label>
      ) : null}
      {mailboxes && selectedMailbox === PERSONAL_ADDRESS && (
        <label>
          邮箱
          <input
            name="email"
            type="email"
            defaultValue={step.name === "claude" ? step.email : undefined}
            autoComplete="email"
            maxLength={254}
            required
          />
        </label>
      )}
      {!mailboxes && (
        <p class="user-panel-muted" role="status">
          正在读取收件地址…
        </p>
      )}
    </>
  );
  const cancelAppleButton = (
    <button type="button" disabled={canceling} onClick={() => void cancelApple()}>
      {canceling ? "正在取消…" : "取消本次向导"}
    </button>
  );

  return (
    <div class="user-panel-backdrop account-onboarding-backdrop" hidden={!open}>
      <section
        class="user-panel account-onboarding"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-onboarding-title"
        ref={panel}
      >
        <header class="user-panel-heading">
          <h2 id="account-onboarding-title">Apple 账户与 Claude 登录</h2>
          <button type="button" class="user-panel-close" aria-label="关闭" onClick={close}>
            ×
          </button>
        </header>
        {error && (
          <p class="user-panel-message user-panel-error" role="alert">
            {error}
          </p>
        )}
        {step.name === "start" && (
          <section class="user-panel-form">
            {pending && (
              <p class="user-panel-muted" role="status">
                正在加载 Apple 注册表单…
              </p>
            )}
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" disabled={busy} onClick={openApple}>
                注册 Apple 账户
              </button>
              <button type="button" disabled={busy} onClick={() => goTo({ name: "claude" })}>
                登录 Claude
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    const { accounts } = await apiRequest<{ accounts: SavedAppleAccount[] }>(
                      `${route}/apple/accounts`,
                    );
                    goTo({ name: "saved", accounts });
                  })
                }
              >
                已保存的 Apple 账户
              </button>
              {appleAttempt.current && cancelAppleButton}
            </div>
          </section>
        )}
        {step.name === "saved" && (
          <section class="user-panel-form">
            <h3>已保存的 Apple 账户</h3>
            {step.selected ? (
              <>
                <div>
                  {step.selected.firstName} {step.selected.lastName}
                </div>
                <div class="account-onboarding-address">{step.selected.email}</div>
                <div>
                  出生日期 {step.selected.birthday} · 地区 {step.selected.country}
                </div>
                <div>
                  手机号 {step.selected.phone} · 区号地区 {step.selected.phoneCode}
                </div>
                <div>{appleAccountStates[step.selected.state]}</div>
                <div class="user-panel-actions">
                  <button
                    type="button"
                    onClick={() => {
                      const { password } = step.selected!;
                      void writeLocalClipboard(password).then(
                        () => setPasswordCopied(true),
                        (failure: Error) => setError(failure.message),
                      );
                    }}
                  >
                    {passwordCopied ? "已复制密码" : "复制密码"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const { email } = step.selected!;
                      goTo({ name: "claude", email });
                      setMailboxValue(
                        mailboxes?.addresses.find((address) => address.address === email)?.id ??
                          PERSONAL_ADDRESS,
                      );
                    }}
                  >
                    用此邮箱登录 Claude
                  </button>
                  <button
                    type="button"
                    onClick={() => goTo({ name: "saved", accounts: step.accounts })}
                  >
                    返回列表
                  </button>
                </div>
              </>
            ) : (
              <>
                {step.accounts.length === 0 && <p>此配置还没有保存的 Apple 账户。</p>}
                {step.accounts.map((account) => (
                  <button
                    type="button"
                    key={account.id}
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        const details = await apiRequest<SavedAppleDetails>(
                          `${route}/apple/accounts/${encodeURIComponent(account.id)}`,
                        );
                        goTo({ ...step, selected: { ...account, ...details } });
                      })
                    }
                  >
                    {account.email} · {appleAccountStates[account.state]}
                  </button>
                ))}
                <div class="user-panel-actions">
                  <button type="button" onClick={() => goTo({ name: "start" })}>
                    返回
                  </button>
                </div>
              </>
            )}
          </section>
        )}
        {step.name === "apple" &&
          (step.apple.options ? (
            <form
              class="user-panel-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy) return;
                const form = new FormData(event.currentTarget);
                const attempt = appleAttempt.current!;
                void perform(() => submitForm(form, attempt), attempt);
              }}
            >
              <AppleRegistrationFields
                options={step.apple.options}
                busy={busy}
                onGenerate={() => setError(null)}
              />
              {emailField}
              <div class="account-onboarding-password">
                <label for="account-onboarding-password">密码</label>
                <div class="user-panel-actions">
                  <input
                    id="account-onboarding-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    minLength={8}
                    maxLength={128}
                    required
                    disabled={busy}
                    onInput={(event) => {
                      setPassword(event.currentTarget.value);
                      setPasswordCopied(false);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    disabled={busy}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? "隐藏" : "显示"}
                  </button>
                  <button
                    type="button"
                    aria-label={passwordCopied ? "已复制密码" : "复制密码"}
                    disabled={busy || !password}
                    onClick={() => {
                      const signal = appleAttempt.current!.controller.signal;
                      void writeLocalClipboard(password).then(
                        () => {
                          if (!signal.aborted) setPasswordCopied(true);
                        },
                        (failure: Error) => {
                          if (!signal.aborted) setError(failure.message);
                        },
                      );
                    }}
                  >
                    {passwordCopied ? "已复制" : "复制"}
                  </button>
                </div>
                <p class="user-panel-muted">注册资料和密码会保存到此配置。</p>
              </div>
              <p class="user-panel-muted">接下来完成图形验证码、邮箱和手机验证。</p>
              <div class="user-panel-actions">
                <button type="submit" class="user-panel-save" disabled={busy || !mailboxes}>
                  {pending ? "正在填写…" : "继续"}
                </button>
                {cancelAppleButton}
              </div>
            </form>
          ) : (
            <section class="user-panel-form">
              <p role="status">Apple 官方注册页已打开，请在页面填写资料并完成验证。</p>
              <div class="user-panel-actions">
                <button
                  type="button"
                  class="user-panel-save"
                  disabled={busy}
                  onClick={() => openTab(step.apple.tab)}
                >
                  前往 Apple 注册
                </button>
                {cancelAppleButton}
              </div>
            </section>
          ))}
        {step.name === "apple-verification" && (
          <section class="user-panel-form">
            <h3>
              {needsAppleDetails
                ? "请在 Apple 页面补全资料"
                : challenge?.kind === "complete"
                  ? "Apple 账户已创建"
                  : challenge?.kind === "declined"
                    ? "未接受 iCloud 条款"
                    : challenge?.kind === "terms"
                      ? "iCloud 条款与条件"
                      : "验证 Apple 账户"}
            </h3>
            <p class="user-panel-muted account-onboarding-address">{step.email}</p>
            {challenge?.kind === "terms" && (
              <div class="user-panel-actions">
                <button
                  type="button"
                  class="user-panel-save"
                  disabled={busy}
                  onClick={() => decideTerms("agree")}
                >
                  同意
                </button>
                <button type="button" disabled={busy} onClick={() => decideTerms("disagree")}>
                  不同意
                </button>
                <button type="button" disabled={busy} onClick={() => openTab(challenge.tab)}>
                  查看 Apple 条款原文
                </button>
              </div>
            )}
            {challenge?.kind === "declined" && <p role="status">向导已结束。账户资料已保存。</p>}
            {!needsAppleDetails && challenge?.kind === "email" && !manualChallenge && (
              <div role="status" class="account-onboarding-progress">
                <span>
                  {verification.submitted
                    ? "邮箱验证码已提交"
                    : verification.received
                      ? "正在填入邮箱验证码"
                      : "正在等待 Apple 邮件"}
                </span>
                <progress
                  aria-label="邮箱验证进度"
                  max={2}
                  value={verification.submitted ? 2 : verification.received ? 1 : undefined}
                />
              </div>
            )}
            {!needsAppleDetails && (!challenge || challenge.kind === "waiting") && (
              <p class="user-panel-muted" role="status">
                正在读取 Apple 验证步骤…
              </p>
            )}
            {manualChallenge && (
              <form
                class="user-panel-form"
                key={challenge.kind === "captcha" ? challenge.image : challenge.kind}
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const code = String(new FormData(form).get("code") ?? "").trim();
                  void perform(async () => {
                    await apiRequest(
                      verificationRoute!,
                      "POST",
                      { kind: challenge.kind, code },
                      appleVerification?.fetcher,
                    );
                    form.reset();
                  }, appleVerification ?? undefined);
                }}
              >
                {challenge.kind === "captcha" && (
                  <img
                    class="account-onboarding-captcha"
                    src={challenge.image}
                    alt="Apple 图形验证码"
                  />
                )}
                <label>
                  {challenge.kind === "captcha"
                    ? "图形验证码"
                    : challenge.kind === "sms"
                      ? "短信验证码"
                      : "邮箱验证码"}
                  <input
                    name="code"
                    required
                    disabled={busy}
                    maxLength={challenge.kind === "captcha" ? 20 : 6}
                    pattern={challenge.kind === "captcha" ? undefined : "[0-9]{6}"}
                    inputMode={challenge.kind === "captcha" ? undefined : "numeric"}
                    autoComplete={challenge.kind === "sms" ? "one-time-code" : "off"}
                  />
                </label>
                <div class="user-panel-actions">
                  <button type="submit" class="user-panel-save" disabled={busy}>
                    验证
                  </button>
                </div>
              </form>
            )}
            {challenge?.kind !== "terms" && (
              <div class="user-panel-actions">
                {!appleEnded && (
                  <button type="button" disabled={busy} onClick={() => openTab(step.tab)}>
                    {needsAppleDetails ? "前往 Apple 补填" : "在 Apple 页面继续"}
                  </button>
                )}
                {challenge?.kind !== "declined" && (
                  <button
                    type="button"
                    class={challenge?.kind === "complete" ? "user-panel-save" : undefined}
                    disabled={busy}
                    onClick={() => {
                      stopApple();
                      goTo({ name: "claude", email: step.email });
                      setMailboxValue(step.mailboxId ?? PERSONAL_ADDRESS);
                      void perform(() =>
                        openClaude(
                          step.mailboxId ? { mailboxId: step.mailboxId } : { email: step.email },
                          step.email,
                        ),
                      );
                    }}
                  >
                    用此邮箱登录 Claude
                  </button>
                )}
                {appleEnded ? (
                  <button type="button" onClick={() => resetApple()}>
                    完成
                  </button>
                ) : (
                  cancelAppleButton
                )}
              </div>
            )}
          </section>
        )}
        {step.name === "claude" && (
          <form
            class="user-panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(() => submitForm(form));
            }}
          >
            {emailField}
            {selectedMailbox === PERSONAL_ADDRESS && (
              <p class="user-panel-muted">
                如果你已在 Claude App 选择「使用 Apple 登录」和「隐藏邮件地址」，可填入 Apple
                账户显示的 Claude 转发邮箱。
              </p>
            )}
            {selectedMailbox !== PERSONAL_ADDRESS && (
              <p class="user-panel-muted">在 Claude 页面发送登录邮件后，从工作台回到这里继续。</p>
            )}
            <div class="user-panel-actions">
              <button type="submit" class="user-panel-save" disabled={pending || !mailboxes}>
                {pending ? "正在打开 Claude…" : "填写并前往 Claude"}
              </button>
              <button type="button" disabled={pending} onClick={() => goTo({ name: "start" })}>
                返回
              </button>
            </div>
          </form>
        )}
        {step.name === "claude-verification" && (
          <section class="user-panel-form">
            <h3>继续 Claude 登录</h3>
            <p class="user-panel-muted account-onboarding-address">{step.email}</p>
            <p role="status">
              {!step.filled
                ? "请在 Claude 页面手动输入此邮箱。"
                : verification.ready
                  ? "登录邮件已收到，可以继续。"
                  : verification.expired
                    ? "等待邮件已超时，请在收件箱打开最新的登录邮件。"
                    : "请在 Claude 页面发送登录邮件，收到后回到这里继续。"}
            </p>
            <div class="user-panel-actions">
              {verification.ready && (
                <button
                  type="button"
                  class="user-panel-save"
                  disabled={pending}
                  onClick={() =>
                    void perform(async () => {
                      await apiRequest(verificationRoute!, "POST");
                      goTo({ name: "start" });
                      openTab(step.tab);
                    })
                  }
                >
                  {pending ? "正在登录…" : "继续登录"}
                </button>
              )}
              <button type="button" disabled={pending} onClick={() => openTab(step.tab)}>
                返回 Claude
              </button>
              <button type="button" disabled={pending} onClick={() => goTo({ name: "start" })}>
                重新开始
              </button>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}

function generatePassword(): string {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return "Aa3!" + Array.from(bytes, (byte) => characters[byte % characters.length]).join("");
}
