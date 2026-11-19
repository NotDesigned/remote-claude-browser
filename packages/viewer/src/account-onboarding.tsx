import { useEffect, useState } from "preact/hooks";
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
  submitted?: boolean;
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
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [passwordCopied, setPasswordCopied] = useState(false);
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
    setPassword(next.name === "apple" && next.apple.options ? generatePassword() : "");
    setShowPassword(false);
    setPasswordCopied(false);
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
      if (filled) openTab(tab);
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

  const needsAppleDetails =
    step.name === "apple-verification" && !step.filled && !verification.ready;
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
            {pending && (
              <p class="user-panel-muted" role="status">
                正在从 iCloud 打开注册表单。表单未能加载时，可在 Apple 页面继续。
              </p>
            )}
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" disabled={pending} onClick={openApple}>
                注册 Apple 账户
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
                  <input
                    name="lastName"
                    autoComplete="family-name"
                    placeholder="例如 Smith"
                    maxLength={100}
                    required
                  />
                </label>
                <label>
                  名字
                  <input
                    name="firstName"
                    autoComplete="given-name"
                    placeholder="例如 Alex"
                    maxLength={100}
                    required
                  />
                </label>
                <label>
                  国家或地区
                  <RegistrationSelect
                    name="country"
                    options={step.apple.options.countries}
                    preferred="USA"
                  />
                </label>
                <div class="account-onboarding-date">
                  <label>
                    出生日期
                    <input
                      name="birthday"
                      type="date"
                      autoComplete="bday"
                      aria-describedby="account-onboarding-birthday-example"
                      required
                    />
                  </label>
                  <small id="account-onboarding-birthday-example" class="user-panel-muted">
                    例如 2000-06-15
                  </small>
                </div>
                <label>
                  电话区号
                  <RegistrationSelect
                    name="phoneCode"
                    options={step.apple.options.phoneCodes}
                    preferred="US"
                  />
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
                    disabled={pending}
                    onInput={(event) => {
                      setPassword(event.currentTarget.value);
                      setPasswordCopied(false);
                    }}
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    disabled={pending}
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? "隐藏" : "显示"}
                  </button>
                  <button
                    type="button"
                    aria-label={passwordCopied ? "已复制密码" : "复制密码"}
                    disabled={pending || !password}
                    onClick={() =>
                      void writeLocalClipboard(password).then(
                        () => setPasswordCopied(true),
                        (failure: Error) => setError(failure.message),
                      )
                    }
                  >
                    {passwordCopied ? "已复制" : "复制"}
                  </button>
                </div>
                <p class="user-panel-muted">继续前请保存密码。</p>
              </div>
              <p class="user-panel-muted">
                在 Apple 页面完成图形验证码、手机验证和注册确认。
                {selectedMailbox !== PERSONAL_ADDRESS &&
                  "向导会填入邮箱验证码，并在确认按钮可用时提交。"}
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
              <p role="status">Apple 官方注册页已打开，请在页面填写资料并完成验证。</p>
              <div class="user-panel-actions">
                <button
                  type="button"
                  class="user-panel-save"
                  onClick={() => openTab(step.apple.tab)}
                >
                  前往 Apple 注册
                </button>
                <button type="button" onClick={() => goTo({ name: "start" })}>
                  返回
                </button>
              </div>
            </section>
          ))}
        {step.name === "apple-verification" && (
          <section class="user-panel-form">
            <h3>{needsAppleDetails ? "请在 Apple 页面补全资料" : "完成 Apple 注册"}</h3>
            <p class="user-panel-muted account-onboarding-address">{step.email}</p>
            <p>在 Apple 页面完成图形验证码、手机验证和注册确认。</p>
            {step.watching && (
              <p class="user-panel-muted" role="status">
                {verification.ready
                  ? verification.submitted
                    ? "邮箱验证码已提交。请返回 Apple 查看下一步。"
                    : "邮箱验证码已填入 Apple 页面。"
                  : verification.expired
                    ? "请从收件箱读取最新的邮箱验证码。"
                    : "进入 Apple 的邮箱验证步骤后，向导会填入验证码，并在确认按钮可用时提交。"}
              </p>
            )}
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" onClick={() => openTab(step.tab)}>
                {needsAppleDetails ? "前往 Apple 补填" : "返回 Apple"}
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

function RegistrationSelect({
  name,
  options,
  preferred,
}: {
  name: string;
  options: [string, string][];
  preferred: string;
}) {
  const defaultChoice =
    options.find(([value]) => value === preferred) ??
    (options.length === 1 ? options[0] : undefined);
  return (
    <select name={name} required>
      {!defaultChoice && <option value="">请选择</option>}
      {options.map(([value, label]) => (
        <option key={value} value={value} selected={value === defaultChoice?.[0]}>
          {label}
        </option>
      ))}
    </select>
  );
}

function generatePassword(): string {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%";
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return "Aa3!" + Array.from(bytes, (byte) => characters[byte % characters.length]).join("");
}
