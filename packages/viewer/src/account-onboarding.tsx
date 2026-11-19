import { useEffect, useRef, useState } from "preact/hooks";
import { apiRequest } from "./api";
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

type Step =
  | { name: "start" | "claude" }
  | { name: "apple"; apple: AppleRegistration }
  | {
      name: "apple-verification" | "claude-verification";
      tab: string;
      watching: boolean;
      filled: boolean;
      email: string;
    };

interface Verification {
  ready: boolean;
  expired: boolean;
}

interface AccountOnboardingProps {
  open: boolean;
  sid: string;
  profileKey: string;
  profileName: string | undefined;
  storage: Pick<Storage, "getItem" | "setItem">;
  onClose(): void;
  onOpenTab(tab: string): void;
}

const NEW_ADDRESS = "new";
const PERSONAL_ADDRESS = "personal";

export function AccountOnboarding({
  open,
  sid,
  profileKey,
  profileName,
  storage,
  onClose,
  onOpenTab,
}: AccountOnboardingProps) {
  const passwordInput = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const close = () => {
    setShowPassword(false);
    setError(null);
    onClose();
  };
  const panel = useDialog(open, close);
  const [step, setStep] = useState<Step>({ name: "start" });
  const [mailboxes, setMailboxes] = useState<Awaited<ReturnType<typeof mailboxApi.addresses>>>();
  const [mailboxValue, setMailboxValue] = useState<string>();
  const [verification, setVerification] = useState<Verification>({ ready: false, expired: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = `/api/client/session/${encodeURIComponent(sid)}/onboarding`;
  const verificationRoute =
    step.name === "apple-verification"
      ? `${route}/apple/${encodeURIComponent(step.tab)}/verification`
      : step.name === "claude-verification"
        ? `${route}/claude/${encodeURIComponent(step.tab)}/verification`
        : null;
  const watching = "watching" in step && step.watching;

  useEffect(() => {
    if (!open) return;
    let active = true;
    const unavailable = { enabled: false, addresses: [] };
    void mailboxApi.addresses().then(
      (result) => {
        if (active) setMailboxes(result);
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
    if (!open || !verificationRoute || !watching || verification.ready || verification.expired)
      return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        const status = await apiRequest<Verification>(verificationRoute);
        if (active) {
          setVerification(status);
          setError(null);
        }
      } catch (failure) {
        if (active) setError((failure as Error).message);
      } finally {
        if (active) timer = setTimeout(check, 2_000);
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, verificationRoute, watching, verification.ready, verification.expired]);

  const perform = async (task: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  };
  const goTo = (next: Step) => {
    setStep(next);
    setMailboxValue(undefined);
    setShowPassword(false);
    setVerification({ ready: false, expired: false });
    setError(null);
  };
  const openTab = (tab: string) => {
    onOpenTab(tab);
    close();
  };
  const openApple = () =>
    void perform(async () => {
      const apple = await apiRequest<AppleRegistration>(`${route}/apple`, "POST");
      goTo({ name: "apple", apple });
    });
  const aliasKey = `mirror.mailbox.${profileKey}.${step.name}`;
  const rememberedAlias = open && mailboxes?.addresses.length ? storage.getItem(aliasKey) : null;
  const selectedMailbox =
    mailboxValue ??
    mailboxes?.addresses.find((address) => address.id === rememberedAlias)?.id ??
    (mailboxes?.enabled ? NEW_ADDRESS : PERSONAL_ADDRESS);
  const submitForm = async (form: FormData, service: "Apple" | "Claude") => {
    let email = String(form.get("email") ?? "").trim();
    form.delete("email");
    let identity: { mailboxId: string } | { email: string };
    if (selectedMailbox === NEW_ADDRESS) {
      const label = profileName ? `${profileName.slice(0, 70)} · ${service}` : service;
      const { address } = await mailboxApi.create(label);
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
    if (step.name === "apple") {
      const { tab } = step.apple;
      const { filled, watching } = await apiRequest<{ filled: boolean; watching: boolean }>(
        `${route}/apple/${encodeURIComponent(tab)}`,
        "POST",
        { ...Object.fromEntries(form), ...identity },
      );
      goTo({ name: "apple-verification", tab, filled, watching, email });
      openTab(tab);
    }
    if (step.name === "claude") {
      const { tab, filled, watching } = await apiRequest<{
        tab: string;
        filled: boolean;
        watching: boolean;
      }>(`${route}/claude`, "POST", identity);
      if (watching || !filled) goTo({ name: "claude-verification", tab, filled, watching, email });
      else goTo({ name: "start" });
      openTab(tab);
    }
  };

  if (!open) return null;

  const emailField = (
    <>
      {mailboxes?.enabled || mailboxes?.addresses.length ? (
        <label>
          收件地址
          <select
            value={selectedMailbox}
            disabled={pending}
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
          <input name="email" type="email" autoComplete="email" maxLength={254} required />
        </label>
      )}
      {!mailboxes && (
        <p class="user-panel-muted" role="status">
          正在读取收件地址…
        </p>
      )}
    </>
  );

  return (
    <div class="user-panel-backdrop">
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
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" disabled={pending} onClick={openApple}>
                {pending ? "正在打开 iCloud…" : "注册 Apple 账户"}
              </button>
              <button type="button" disabled={pending} onClick={() => goTo({ name: "claude" })}>
                登录 Claude
              </button>
            </div>
          </section>
        )}
        {step.name === "apple" &&
          (step.apple.options ? (
            <form
              class="user-panel-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(() => submitForm(form, "Apple"));
              }}
            >
              <div class="account-onboarding-fields">
                <label>
                  姓氏
                  <input name="lastName" autoComplete="family-name" maxLength={100} required />
                </label>
                <label>
                  名字
                  <input name="firstName" autoComplete="given-name" maxLength={100} required />
                </label>
                <label>
                  国家或地区
                  <select name="country" required>
                    <option value="">请选择</option>
                    {step.apple.options.countries.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  出生日期
                  <input name="birthday" type="date" autoComplete="bday" required />
                </label>
                <label>
                  电话区号
                  <select name="phoneCode" required>
                    {step.apple.options.phoneCodes.length !== 1 && <option value="">请选择</option>}
                    {step.apple.options.phoneCodes.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  电话号码
                  <input
                    name="phone"
                    type="tel"
                    autoComplete="tel-national"
                    maxLength={40}
                    required
                  />
                </label>
              </div>
              {emailField}
              <label>
                密码
                <input
                  ref={passwordInput}
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={128}
                  required
                />
              </label>
              <div class="user-panel-actions">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    passwordInput.current!.value = generatePassword();
                    setShowPassword(true);
                  }}
                >
                  生成密码
                </button>
                {showPassword && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() =>
                      void writeLocalClipboard(passwordInput.current!.value).then(
                        () => {
                          setShowPassword(false);
                        },
                        (failure: Error) => setError(failure.message),
                      )
                    }
                  >
                    复制密码
                  </button>
                )}
              </div>
              <p class="user-panel-muted">
                在 Apple 页面完成图形验证码、手机验证和注册确认。
                {selectedMailbox !== PERSONAL_ADDRESS && "邮箱验证码会自动填入。"}
              </p>
              <div class="user-panel-actions">
                <button type="submit" class="user-panel-save" disabled={pending || !mailboxes}>
                  {pending ? "正在填写…" : "填写并前往 Apple"}
                </button>
                <button type="button" disabled={pending} onClick={() => goTo({ name: "start" })}>
                  返回
                </button>
              </div>
            </form>
          ) : (
            <section class="user-panel-form">
              <p role="status">iCloud 已打开，请在 Apple 页面继续注册。</p>
              <div class="user-panel-actions">
                <button
                  type="button"
                  class="user-panel-save"
                  onClick={() => openTab(step.apple.tab)}
                >
                  前往 iCloud
                </button>
                <button type="button" onClick={() => goTo({ name: "start" })}>
                  返回
                </button>
              </div>
            </section>
          ))}
        {step.name === "apple-verification" && (
          <section class="user-panel-form">
            <h3>完成 Apple 注册</h3>
            {!step.filled && <p>请在 Apple 页面检查剩余资料。</p>}
            <p class="user-panel-muted account-onboarding-address">{step.email}</p>
            <p>在 Apple 页面完成图形验证码、手机验证和注册确认。</p>
            {step.watching && (
              <p class="user-panel-muted" role="status">
                {verification.ready
                  ? "邮箱验证码已填入 Apple 页面。"
                  : verification.expired
                    ? "请从收件箱读取最新的邮箱验证码。"
                    : "Apple 发出邮件后，邮箱验证码会自动填入。"}
              </p>
            )}
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" onClick={() => openTab(step.tab)}>
                返回 Apple
              </button>
              <button type="button" onClick={() => goTo({ name: "claude" })}>
                登录 Claude
              </button>
            </div>
          </section>
        )}
        {step.name === "claude" && (
          <form
            class="user-panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(() => submitForm(form, "Claude"));
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
