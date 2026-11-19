import { useState } from "preact/hooks";
import { apiRequest } from "./api";
import { useDialog } from "./dialog";
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

export function AccountOnboarding({ sid, onClose }: { sid: string; onClose(): void }) {
  const panel = useDialog(true, onClose);
  const [step, setStep] = useState<"start" | "apple" | "claude">("start");
  const [apple, setApple] = useState<AppleRegistration | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const route = `/api/client/session/${encodeURIComponent(sid)}/onboarding`;
  const perform = async (task: () => Promise<void>) => {
    setPending(true);
    setError(null);
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : "暂时无法打开页面，请重试。");
    } finally {
      setPending(false);
    }
  };
  const openApple = () =>
    void perform(async () => {
      setApple(await apiRequest<AppleRegistration>(`${route}/apple`, "POST"));
      setStep("apple");
    });

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
          <button type="button" class="user-panel-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p class="user-panel-message user-panel-error" role="alert">
            {error}
          </p>
        )}
        {step === "start" && (
          <section class="user-panel-form">
            <div class="user-panel-actions">
              <button type="button" class="user-panel-save" disabled={pending} onClick={openApple}>
                {pending ? "正在打开 Apple…" : "注册 Apple 账户"}
              </button>
              <button
                type="button"
                class="account-onboarding-secondary"
                disabled={pending}
                onClick={() => setStep("claude")}
              >
                用邮箱登录 Claude
              </button>
            </div>
          </section>
        )}
        {step === "apple" &&
          apple &&
          (apple.options ? (
            <form
              class="user-panel-form"
              onSubmit={(event) => {
                event.preventDefault();
                const details = Object.fromEntries(new FormData(event.currentTarget));
                void perform(async () => {
                  const { filled } = await apiRequest<{ filled: boolean }>(
                    `${route}/apple/${encodeURIComponent(apple.tab)}`,
                    "POST",
                    details,
                  );
                  if (filled) onClose();
                  else setError("请在打开的 Apple 注册页检查剩余资料。");
                });
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
                    {apple.options.countries.map(([value, label]) => (
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
                <label class="account-onboarding-email">
                  注册邮箱
                  <input name="email" type="email" autoComplete="email" maxLength={254} required />
                </label>
                <label>
                  电话区号
                  <select
                    name="phoneCode"
                    defaultValue={
                      apple.options.phoneCodes.length === 1 ? apple.options.phoneCodes[0]![0] : ""
                    }
                    required
                  >
                    <option value="">请选择</option>
                    {apple.options.phoneCodes.map(([value, label]) => (
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
              <p class="user-panel-muted">在 Apple 页面设定密码，完成验证码和邮箱、手机验证。</p>
              <div class="user-panel-actions">
                <button type="submit" class="user-panel-save" disabled={pending}>
                  {pending ? "正在填写…" : "填写并前往 Apple"}
                </button>
              </div>
            </form>
          ) : (
            <section class="user-panel-form">
              <p role="status">Apple 注册页已打开，请在页面继续填写。</p>
              <div class="user-panel-actions">
                <button type="button" class="user-panel-save" onClick={onClose}>
                  前往 Apple
                </button>
              </div>
            </section>
          ))}
        {step === "claude" && (
          <form
            class="user-panel-form"
            onSubmit={(event) => {
              event.preventDefault();
              const email = new FormData(event.currentTarget).get("email");
              void perform(async () => {
                const { filled } = await apiRequest<{ filled: boolean }>(
                  `${route}/claude`,
                  "POST",
                  { email },
                );
                if (filled) onClose();
                else setError("Claude 登录页已打开，请在页面填写邮箱。");
              });
            }}
          >
            <label>
              Claude 登录邮箱
              <input name="email" type="email" autoComplete="email" maxLength={254} required />
            </label>
            <p class="user-panel-muted">
              想隐藏真实邮箱时，请先在 iPhone 的 Claude App 选择「使用 Apple
              登录」和「隐藏邮件地址」。再到 Apple 账户的「使用 Apple 登录」中查看 Claude
              的转发邮箱，填入这里。
            </p>
            <div class="user-panel-actions">
              <button type="submit" class="user-panel-save" disabled={pending}>
                {pending ? "正在打开 Claude…" : "填写并前往 Claude"}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
