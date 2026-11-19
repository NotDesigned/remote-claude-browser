import { useEffect, useState } from "preact/hooks";
import { writeLocalClipboard } from "./chrome/clipboard";
import { useDialog } from "./dialog";
import { mailboxApi, mailboxLabel, type MailboxContents, type MailboxMessage } from "./mailboxes";
import "./user-panel.css";
import "./mailbox-panel.css";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });

export function MailboxPanel({ onClose }: { onClose(): void }) {
  const panel = useDialog(true, onClose);
  const [mailboxes, setMailboxes] = useState<Awaited<ReturnType<typeof mailboxApi.addresses>>>();
  const [addressId, setAddressId] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [messages, setMessages] = useState<MailboxMessage[]>();
  const [selectedMessage, setSelectedMessage] = useState<MailboxMessage>();
  const [contents, setContents] = useState<MailboxContents>();
  const [error, setError] = useState("");
  const address = mailboxes?.addresses.find((item) => item.id === addressId);

  const selectAddress = (selected: string) => {
    setAddressId(selected);
    setMessages(undefined);
    setSelectedMessage(undefined);
    setContents(undefined);
    setCopied(false);
    setError("");
  };
  useEffect(() => {
    void mailboxApi.addresses().then(
      (result) => {
        setMailboxes(result);
        setAddressId(result.addresses[0]?.id ?? "");
      },
      (failure: Error) => setError(failure.message),
    );
  }, []);
  useEffect(() => {
    if (!addressId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await mailboxApi.messages(addressId);
        if (active) setMessages(result.messages);
      } catch (failure) {
        if (active) setError((failure as Error).message);
      } finally {
        if (active) timer = setTimeout(load, 5_000);
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [addressId]);
  useEffect(() => {
    if (!selectedMessage) return;
    let active = true;
    void mailboxApi.message(addressId, selectedMessage.id).then(
      ({ message }) => {
        if (active) setContents(message);
      },
      (failure: Error) => {
        if (active) {
          setSelectedMessage(undefined);
          setError(failure.message);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [addressId, selectedMessage]);

  const createAddress = async (label: string) => {
    setSaving(true);
    setError("");
    try {
      const { address } = await mailboxApi.create(label);
      setMailboxes((current) => ({
        enabled: true,
        addresses: [...(current?.addresses ?? []), address],
      }));
      selectAddress(address.id);
      setCreating(false);
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const deleteAddress = async () => {
    if (
      !address ||
      !mailboxes ||
      !window.confirm(`删除 ${address.address}？工作台将移除该地址的所有邮件记录，并停止为它收件。`)
    )
      return;
    setSaving(true);
    setError("");
    try {
      await mailboxApi.remove(address.id);
      const remaining = mailboxes.addresses.filter((item) => item.id !== address.id);
      setMailboxes({ ...mailboxes, addresses: remaining });
      selectAddress(remaining[0]?.id ?? "");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="user-panel-backdrop">
      <section
        class="user-panel mailbox-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mailbox-title"
        ref={panel}
      >
        <header class="user-panel-heading">
          <h2 id="mailbox-title">收件箱</h2>
          <button type="button" class="user-panel-close" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {error && (
          <p class="user-panel-message user-panel-error" role="alert">
            {error}
          </p>
        )}
        {!mailboxes && !error && (
          <p class="user-panel-form user-panel-muted" role="status">
            正在读取收件地址…
          </p>
        )}
        {mailboxes && (
          <>
            {!mailboxes.enabled && (
              <p class="user-panel-form user-panel-muted">管理员尚未启用域名收件。</p>
            )}
            {(mailboxes.enabled || address) && (
              <section class="user-panel-form mailbox-addresses">
                {address && (
                  <>
                    <label>
                      收件地址
                      <select
                        value={addressId}
                        disabled={saving}
                        onChange={(event) => selectAddress(event.currentTarget.value)}
                      >
                        {mailboxes.addresses.map((item) => (
                          <option key={item.id} value={item.id}>
                            {mailboxLabel(item)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p class="mailbox-address">{address.address}</p>
                  </>
                )}
                {creating ? (
                  <form
                    class="mailbox-create"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void createAddress(String(new FormData(event.currentTarget).get("label")));
                    }}
                  >
                    <label>
                      地址备注（选填）
                      <input name="label" maxLength={80} placeholder="工作浏览器" />
                    </label>
                    <div class="user-panel-actions">
                      <button type="submit" class="user-panel-save" disabled={saving}>
                        {saving ? "正在创建…" : "创建地址"}
                      </button>
                      <button type="button" disabled={saving} onClick={() => setCreating(false)}>
                        取消
                      </button>
                    </div>
                  </form>
                ) : (
                  <div class="user-panel-actions">
                    {mailboxes.enabled && (
                      <button
                        type="button"
                        class="user-panel-save"
                        disabled={saving}
                        onClick={() => setCreating(true)}
                      >
                        新建地址
                      </button>
                    )}
                    {address && (
                      <button type="button" disabled={saving} onClick={() => void deleteAddress()}>
                        删除地址
                      </button>
                    )}
                    {address && (
                      <button
                        type="button"
                        onClick={() =>
                          void writeLocalClipboard(address.address).then(
                            () => setCopied(true),
                            (failure: Error) => setError(failure.message),
                          )
                        }
                      >
                        {copied ? "已复制" : "复制地址"}
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}
          </>
        )}
        {address && (
          <section class="user-panel-form mailbox-messages" aria-label="邮件">
            {selectedMessage ? (
              <>
                <div class="user-panel-actions">
                  <button type="button" onClick={() => setSelectedMessage(undefined)}>
                    返回邮件列表
                  </button>
                </div>
                <h3>{selectedMessage.subject || "无主题"}</h3>
                <p class="user-panel-muted">
                  {selectedMessage.from} · {dateTime.format(selectedMessage.receivedAt)}
                </p>
                {contents ? (
                  <pre class="mailbox-body">{contents.text || "邮件没有正文。"}</pre>
                ) : (
                  <p class="user-panel-muted" role="status">
                    正在读取邮件…
                  </p>
                )}
              </>
            ) : (
              <>
                <h3>邮件</h3>
                {messages?.length ? (
                  <ul class="mailbox-list">
                    {messages.map((message) => (
                      <li key={message.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setContents(undefined);
                            setSelectedMessage(message);
                          }}
                        >
                          <strong>{message.subject || "无主题"}</strong>
                          <span class="user-panel-muted">
                            {message.from} · {dateTime.format(message.receivedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p class="user-panel-muted" role="status">
                    {messages ? "还没有邮件。" : "正在读取邮件…"}
                  </p>
                )}
              </>
            )}
          </section>
        )}
      </section>
    </div>
  );
}
