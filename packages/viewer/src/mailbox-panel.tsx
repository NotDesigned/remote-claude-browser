import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { writeLocalClipboard } from "./chrome/clipboard";
import { Panel, useConfirm } from "./panel";
import { usePolling } from "./polling";
import {
  mailboxApi,
  mailboxLabel,
  type MailboxAddress,
  type MailboxContents,
  type MailboxMessage,
} from "./mailboxes";
import { extractSanitizedHtmlLinks, isPrivateMailHostname, MailHtmlView } from "./mail-view";
import "./user-panel.css";
import "./mailbox-panel.css";

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" });
const MAX_MAIL_LINKS = 20;

/** Pulls unique HTTP(S) links out of plain-text mail without turning them into local anchors. */
export function extractMailLinks(text: string): string[] {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\]]+/gi)) {
    let raw = match[0];
    while (raw.length > 0) {
      const last = raw[raw.length - 1]!;
      if (/[.,;:!?]/.test(last)) {
        raw = raw.slice(0, -1);
        continue;
      }
      if (last === ")") {
        const opens = (raw.match(/\(/g) ?? []).length;
        const closes = (raw.match(/\)/g) ?? []).length;
        if (closes > opens) {
          raw = raw.slice(0, -1);
          continue;
        }
      }
      break;
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (isPrivateMailHostname(parsed.hostname)) continue;
      if (seen.has(raw)) continue;
      seen.add(raw);
      links.push(raw);
      if (links.length >= MAX_MAIL_LINKS) break;
    } catch {
      // Ignore malformed URL-like text fragments.
    }
  }
  return links;
}

export interface MailboxPanelProps {
  onClose(): void;
  /** Active remote browser profile name, when connected. */
  browserProfileName?: string;
  /** Opens a link inside the remote proxied browser instead of the viewer's local device. */
  onOpenUrlInBrowser?(url: string): void;
  /** Navigates to the browser profile picker when no remote browser session is open yet. */
  onChooseBrowser?(): void;
}

export function MailboxPanel({
  onClose,
  browserProfileName,
  onOpenUrlInBrowser,
  onChooseBrowser,
}: MailboxPanelProps) {
  const { confirm, dialog } = useConfirm();
  const [mailboxes, setMailboxes] = useState<Awaited<ReturnType<typeof mailboxApi.addresses>>>();
  const [addressId, setAddressId] = useState("");
  const [addressForm, setAddressForm] = useState<"create" | "claim">();
  const [claimAddress, setClaimAddress] = useState("");
  const [localPart, setLocalPart] = useState("");
  const [selectedDomain, setSelectedDomain] = useState("");
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [selectedMessage, setSelectedMessage] = useState<MailboxMessage>();
  const [contents, setContents] = useState<MailboxContents>();
  const [bodyView, setBodyView] = useState<"html" | "text">("html");
  const [error, setError] = useState("");
  const address = mailboxes?.addresses.find((item) => item.id === addressId);
  const domains = mailboxes?.domains ?? [];
  const domain = selectedDomain || mailboxes?.domain;

  // Every 5 s while an address is chosen; a failed poll shows until one succeeds.
  const polled = usePolling(() => mailboxApi.messages(addressId), 5_000, {
    enabled: addressId !== "",
    key: addressId,
  });
  const messages: MailboxMessage[] | undefined = polled.data?.messages;
  // Opening a message replaces the list (and the button pressed); returning brings it back.
  const messageHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const returnTo = useRef<string | null>(null);
  const focusMoved = useRef(false);
  useLayoutEffect(() => {
    if (!focusMoved.current) return;
    focusMoved.current = false;
    if (selectedMessage) {
      messageHeading.current?.focus();
      return;
    }
    const id = returnTo.current;
    const button =
      id === null
        ? null
        : listHeading.current?.parentElement?.querySelector<HTMLButtonElement>(
            `[data-message-id="${CSS.escape(id)}"]`,
          );
    (button ?? listHeading.current)?.focus();
  }, [selectedMessage]);
  const openMessage = (message: MailboxMessage | undefined) => {
    if (message) {
      returnTo.current = message.id;
      setBodyView("html");
    }
    focusMoved.current = true;
    setSelectedMessage(message);
    setError("");
  };
  const selectAddress = (selected: string) => {
    setAddressId(selected);
    setSelectedMessage(undefined);
    setContents(undefined);
    setCopied(false);
    setError("");
  };
  useEffect(() => {
    let active = true;
    void mailboxApi.addresses().then(
      (result) => {
        if (!active) return;
        setMailboxes(result);
        setAddressId(result.addresses[0]?.id ?? "");
      },
      (failure: Error) => {
        if (active) setError(failure.message);
      },
    );
    return () => {
      active = false;
    };
  }, []);
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

  const save = async (operation: () => Promise<void>) => {
    setSaving(true);
    setError("");
    try {
      await operation();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const addAddress = (added: MailboxAddress) => {
    const current = mailboxes!;
    setMailboxes({
      ...current,
      addresses: [...current.addresses, added],
      pendingClaim: addressForm === "claim" ? undefined : current.pendingClaim,
    });
    selectAddress(added.id);
    setAddressForm(undefined);
  };

  const deleteAddress = async () => {
    if (
      !address ||
      !mailboxes ||
      saving ||
      !(await confirm({
        title: `删除 ${address.address}？`,
        message: "工作台将移除该地址的所有邮件记录，并停止为它收件。",
        confirmLabel: "删除地址",
        danger: true,
      }))
    )
      return;
    await save(async () => {
      await mailboxApi.remove(address.id);
      const remaining = mailboxes.addresses.filter((item) => item.id !== address.id);
      setMailboxes({ ...mailboxes, addresses: remaining });
      selectAddress(remaining[0]?.id ?? "");
    });
  };

  const sendClaimCode = (target: string) =>
    save(async () => {
      const { address } = await mailboxApi.startClaim(target);
      setClaimAddress(address);
      setMailboxes((current) => ({ ...current!, pendingClaim: address }));
    });

  return (
    <Panel
      variant="user"
      class="mailbox-panel"
      onClose={onClose}
      titleId="mailbox-title"
      title="收件箱"
      closeLabel="关闭收件箱"
    >
      {error && (
        <p class="user-panel-message user-panel-error" role="alert">
          {error}
        </p>
      )}
      {polled.error && polled.error !== error && (
        <p class="user-panel-message user-panel-error" role="alert">
          {polled.error}
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
              {addressForm === "create" ? (
                <form
                  class="mailbox-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const label = String(new FormData(event.currentTarget).get("label"));
                    void save(async () => {
                      const { address } = await mailboxApi.create({
                        label,
                        domain,
                        ...(localPart && { localPart }),
                      });
                      addAddress(address);
                    });
                  }}
                >
                  {domains.length > 1 && (
                    <label>
                      收件域名
                      <select
                        value={domain}
                        disabled={saving}
                        onChange={(event) => setSelectedDomain(event.currentTarget.value)}
                      >
                        {domains.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    地址名称（选填）
                    <input
                      name="localPart"
                      placeholder="留空生成双词地址"
                      title="使用英文字母、数字和中间的连字符"
                      pattern="[A-Za-z0-9](?:[A-Za-z0-9\-]{0,56}[A-Za-z0-9])?"
                      maxLength={58}
                      value={localPart}
                      disabled={saving}
                      autoCapitalize="none"
                      spellcheck={false}
                      onInput={(event) => setLocalPart(event.currentTarget.value)}
                    />
                  </label>
                  {localPart && (
                    <p class="mailbox-address user-panel-muted">
                      inbox-{localPart.toLowerCase()}@{domain}
                    </p>
                  )}
                  <label>
                    地址备注（选填）
                    <input name="label" maxLength={80} placeholder="工作浏览器" disabled={saving} />
                  </label>
                  <div class="user-panel-actions">
                    <button type="submit" class="user-panel-save" disabled={saving}>
                      {saving ? "正在创建…" : "创建地址"}
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setAddressForm(undefined)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : addressForm === "claim" ? (
                <form
                  class="mailbox-create"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const fields = new FormData(event.currentTarget);
                    if (!claimAddress) {
                      void sendClaimCode(String(fields.get("address")));
                      return;
                    }
                    void save(async () => {
                      const { address } = await mailboxApi.confirmClaim(
                        claimAddress,
                        String(fields.get("code")),
                      );
                      addAddress(address);
                    });
                  }}
                >
                  {claimAddress ? (
                    <>
                      <p class="mailbox-address user-panel-muted" role="status">
                        在原邮箱或 Resend 收件页查看发往 {claimAddress} 的 8 位验证码。
                      </p>
                      <label>
                        验证码
                        <input
                          name="code"
                          inputMode="numeric"
                          autoComplete="one-time-code"
                          pattern="[0-9]{8}"
                          maxLength={8}
                          disabled={saving}
                          required
                        />
                      </label>
                    </>
                  ) : (
                    <label>
                      已有邮箱地址
                      <input
                        name="address"
                        type="email"
                        autoComplete="email"
                        placeholder={`name@${domain}`}
                        maxLength={254}
                        disabled={saving}
                        required
                      />
                    </label>
                  )}
                  <div class="user-panel-actions">
                    <button type="submit" class="user-panel-save" disabled={saving}>
                      {claimAddress ? "确认绑定" : "发送验证码"}
                    </button>
                    {claimAddress && (
                      <>
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => void sendClaimCode(claimAddress)}
                        >
                          重发验证码
                        </button>
                        <button type="button" disabled={saving} onClick={() => setClaimAddress("")}>
                          修改地址
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => setAddressForm(undefined)}
                    >
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
                      onClick={() => {
                        setLocalPart("");
                        setAddressForm("create");
                      }}
                    >
                      新建地址
                    </button>
                  )}
                  {mailboxes.canClaim && (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setError("");
                        setClaimAddress(mailboxes.pendingClaim ?? "");
                        setAddressForm("claim");
                      }}
                    >
                      添加已有地址
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
              <div class="user-panel-actions mailbox-message-toolbar">
                <button type="button" onClick={() => openMessage(undefined)}>
                  返回邮件列表
                </button>
                {contents?.html && (
                  <div class="mailbox-view-switch" role="group" aria-label="邮件显示方式">
                    <button
                      type="button"
                      class={bodyView === "html" ? "user-panel-save" : undefined}
                      aria-pressed={bodyView === "html"}
                      onClick={() => setBodyView("html")}
                    >
                      排版视图
                    </button>
                    <button
                      type="button"
                      class={bodyView === "text" ? "user-panel-save" : undefined}
                      aria-pressed={bodyView === "text"}
                      onClick={() => setBodyView("text")}
                    >
                      纯文本
                    </button>
                  </div>
                )}
              </div>
              <h3 ref={messageHeading} tabIndex={-1}>
                {selectedMessage.subject || "无主题"}
              </h3>
              <p class="user-panel-muted">
                {selectedMessage.from} · {dateTime.format(selectedMessage.receivedAt)}
              </p>
              {contents ? (
                <>
                  {(() => {
                    const showHtml = Boolean(contents.html) && bodyView === "html";
                    const links = [
                      ...new Set([
                        ...extractSanitizedHtmlLinks(contents.html),
                        ...extractMailLinks(contents.text),
                      ]),
                    ].slice(0, MAX_MAIL_LINKS);
                    const activateMailUrl = (url: string) => {
                      if (!onOpenUrlInBrowser) {
                        setError("当前未连接远程浏览器；请先选择远程浏览器后再打开邮件链接。");
                        return;
                      }
                      onOpenUrlInBrowser(url);
                    };
                    return (
                      <>
                        {showHtml && (
                          <p class="user-panel-muted mailbox-privacy-note">
                            已屏蔽外部图片以防追踪；点击邮件内按钮或链接将在远程浏览器打开。
                          </p>
                        )}
                        {!onOpenUrlInBrowser && links.length > 0 && onChooseBrowser && (
                          <div class="user-panel-actions">
                            <button
                              type="button"
                              class="user-panel-save"
                              onClick={() => onChooseBrowser()}
                            >
                              先选择远程浏览器
                            </button>
                          </div>
                        )}
                        {showHtml ? (
                          <MailHtmlView html={contents.html!} onActivateLink={activateMailUrl} />
                        ) : (
                          <pre class="mailbox-body">{contents.text || "邮件没有正文。"}</pre>
                        )}
                        {links.length > 0 && (
                          <div class="mailbox-links" role="region" aria-label="邮件内链接">
                            <p class="user-panel-muted mailbox-links-hint">
                              {onOpenUrlInBrowser
                                ? `为避免暴露本机网络地址，请通过远程浏览器${browserProfileName ? `（${browserProfileName}）` : ""}打开邮件链接：`
                                : "当前未连接远程浏览器；请勿复制到本机浏览器打开邮件链接。"}
                            </p>
                            <ul class="mailbox-link-list">
                              {links.map((url) => (
                                <li key={url} class="mailbox-link-item">
                                  <code class="mailbox-link-url">{url}</code>
                                  <button
                                    type="button"
                                    class="user-panel-save"
                                    disabled={!onOpenUrlInBrowser}
                                    onClick={() => activateMailUrl(url)}
                                  >
                                    在远程浏览器打开
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </>
              ) : (
                <p class="user-panel-muted" role="status">
                  正在读取邮件…
                </p>
              )}
            </>
          ) : (
            <>
              <h3 ref={listHeading} tabIndex={-1}>
                邮件
              </h3>
              {messages?.length ? (
                <ul class="mailbox-list">
                  {messages.map((message) => (
                    <li key={message.id}>
                      <button
                        type="button"
                        data-message-id={message.id}
                        onClick={() => {
                          setContents(undefined);
                          openMessage(message);
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
      {dialog}
    </Panel>
  );
}
