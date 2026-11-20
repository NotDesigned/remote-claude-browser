import { useEffect, useState } from "preact/hooks";
import { ApiError, apiRequest } from "./api";
import "./user-panel.css";
import "./payment-handoff.css";

type Provider = "apple-pay" | "google-pay";
type Handoff = {
  handoffId?: string;
  id?: string;
  url: string;
  expiresAt: number;
  status: "pending" | "opened" | "authorized" | "failed" | "cancelled" | "expired";
  capabilities?: { applePay?: boolean; googlePay?: boolean };
};

export function PaymentHandoffPanel({
  open,
  sid,
  resumeUrl,
  onClose,
}: {
  open: boolean;
  sid: string;
  resumeUrl: string;
  onClose(): void;
}) {
  const [provider, setProvider] = useState<Provider>("apple-pay");
  const [merchantOrigin, setMerchantOrigin] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState(resumeUrl);
  const [orderRef, setOrderRef] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = `/api/client/session/${encodeURIComponent(sid)}/payment/handoff`;

  useEffect(() => {
    if (open) {
      setCheckoutUrl(resumeUrl);
      try {
        setMerchantOrigin(new URL(resumeUrl).origin);
      } catch {
        setMerchantOrigin("");
      }
    }
  }, [open, resumeUrl]);

  useEffect(() => {
    if (!open || !handoff || !["pending", "opened"].includes(handoff.status)) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const id = handoff.handoffId || handoff.id;
        if (!id) return;
        const next = await apiRequest<Handoff>(`${path}/${encodeURIComponent(id)}`);
        if (active)
          setHandoff((current) =>
            current ? { ...current, ...next, url: next.url || current.url } : next,
          );
      } catch (reason) {
        if (active && !(reason instanceof ApiError && reason.status === 404))
          setError((reason as Error).message);
      } finally {
        if (active) timer = setTimeout(poll, 2_000);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, handoff?.handoffId, handoff?.id, handoff?.status, path]);

  if (!open) return null;
  const create = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await apiRequest<Handoff>(path, "POST", {
        provider,
        merchantOrigin: merchantOrigin.trim(),
        resumeUrl: checkoutUrl.trim(),
        ...(orderRef.trim() && { orderRef: orderRef.trim() }),
        ...(amount.trim() && { amount: amount.trim() }),
        ...(currency.trim() && { currency: currency.trim().toUpperCase() }),
      });
      setHandoff(result);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!handoff || !(handoff.handoffId || handoff.id)) return;
    setBusy(true);
    try {
      const result = await apiRequest<Handoff>(
        `${path}/${encodeURIComponent(handoff.handoffId || handoff.id!)}`,
        "DELETE",
      );
      setHandoff((current) => (current ? { ...current, status: "cancelled" } : result));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const openLocal = () => {
    if (handoff) window.open(handoff.url, "_blank", "noopener,noreferrer");
  };
  return (
    <div class="user-panel-backdrop">
      <section class="user-panel payment-handoff" role="dialog" aria-modal="true">
        <header class="user-panel-heading">
          <h2>在本机完成支付</h2>
          <button type="button" class="user-panel-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p class="user-panel-message user-panel-error" role="alert">
            {error}
          </p>
        )}
        {!handoff ? (
          <form class="user-panel-form" onSubmit={create}>
            <p class="user-panel-muted">
              本机 Safari 或 Chrome 会使用自己的 Apple Pay、Google Pay
              和验证设备。远程浏览器的登录状态不会复制到本机。
            </p>
            <label>
              支付方式
              <select
                value={provider}
                onChange={(event) => setProvider(event.currentTarget.value as Provider)}
              >
                <option value="apple-pay">Apple Pay</option>
                <option value="google-pay">Google Pay</option>
              </select>
            </label>
            <label>
              商户来源
              <input
                value={merchantOrigin}
                onInput={(event) => setMerchantOrigin(event.currentTarget.value)}
                required
              />
            </label>
            <label>
              结算地址
              <input
                value={checkoutUrl}
                onInput={(event) => setCheckoutUrl(event.currentTarget.value)}
                type="url"
                required
              />
            </label>
            <label>
              订单号（选填）
              <input
                value={orderRef}
                onInput={(event) => setOrderRef(event.currentTarget.value)}
                maxLength={120}
              />
            </label>
            <div class="payment-handoff-fields">
              <label>
                金额（选填）
                <input
                  value={amount}
                  onInput={(event) => setAmount(event.currentTarget.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                币种
                <input
                  value={currency}
                  onInput={(event) => setCurrency(event.currentTarget.value)}
                  maxLength={3}
                />
              </label>
            </div>
            <div class="user-panel-actions">
              <button type="submit" class="user-panel-save" disabled={busy}>
                {busy ? "正在创建…" : "创建本机支付交接"}
              </button>
              <button type="button" disabled={busy} onClick={onClose}>
                返回
              </button>
            </div>
          </form>
        ) : (
          <section class="user-panel-form">
            <p role="status">
              {handoff.status === "pending" || handoff.status === "opened"
                ? "交接已准备好。请在本机浏览器打开并完成支付。"
                : handoff.status === "authorized"
                  ? "支付已确认，远程会话可以继续。"
                  : handoff.status === "failed"
                    ? "支付平台报告支付失败。"
                    : handoff.status === "cancelled"
                      ? "支付交接已取消。"
                      : "支付交接已过期。"}
            </p>
            {handoff.capabilities && (
              <p class="user-panel-muted">
                本机能力：Apple Pay {handoff.capabilities.applePay ? "可用" : "未检测到"} · Google
                Pay {handoff.capabilities.googlePay ? "可用" : "未检测到"}
              </p>
            )}
            <div class="user-panel-actions">
              {(handoff.status === "pending" || handoff.status === "opened") && (
                <button type="button" class="user-panel-save" onClick={openLocal}>
                  在本机打开支付
                </button>
              )}
              {(handoff.status === "pending" || handoff.status === "opened") && (
                <button type="button" disabled={busy} onClick={() => void cancel()}>
                  取消交接
                </button>
              )}
              <button type="button" onClick={onClose}>
                完成
              </button>
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
