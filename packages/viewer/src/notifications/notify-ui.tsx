/**
 * 「网页通知」 in the ⋯ menu, and the prompt shown when a page asks to send notifications. The
 * prompt does not block the page: it sits over the top of the mirror until answered.
 */
import type { NotificationsControl } from "./use-notifications";
import { notifySummary, siteLabel } from "./policy";
import "./notify.css";

export function NotificationMenuSection({ control }: { control: NotificationsControl }) {
  const { state } = control;
  if (state === null) return null;
  const summary = notifySummary(state.settings, state.device);
  const sites = Object.keys(state.settings.origins).length;
  const unsupported = state.device === "unsupported";
  return (
    <div
      class="shell-menu-section"
      role="group"
      aria-label="网页通知"
      id="shell-notify-setting"
      data-notify-tone={summary.tone}
    >
      <span>网页通知</span>
      <div class="shell-menu-choices">
        {(
          [
            [true, "开启"],
            [false, "关闭"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={label}
            type="button"
            data-notify-enabled={String(value)}
            aria-pressed={!unsupported && state.settings.enabled === value}
            disabled={unsupported}
            onClick={() => control.setEnabled(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <small class="shell-notify-summary">{summary.text}</small>
      {sites > 0 && (
        <button type="button" class="shell-notify-reset" onClick={() => control.resetSites()}>
          清除 {sites} 个网站的选择
        </button>
      )}
    </div>
  );
}

export function NotificationPrompts({ control }: { control: NotificationsControl }) {
  const ask = control.state?.asks[0];
  if (ask === undefined) return null;
  const blocked = control.state?.device === "denied";
  return (
    <div id="notify-prompt" role="dialog" aria-label="网页通知请求" data-origin={ask.origin}>
      <p>
        <strong>{siteLabel(ask.origin)} 想给你发通知</strong>
        <span>
          {blocked
            ? "浏览器已阻止本站通知，请先在浏览器的网站设置里允许"
            : "允许后，任务完成等提醒会出现在这台设备上"}
        </span>
      </p>
      <div class="notify-prompt-actions">
        <button
          type="button"
          data-notify-answer="deny"
          onClick={() => control.answer(ask.id, false)}
        >
          拒绝
        </button>
        <button
          type="button"
          data-notify-answer="allow"
          class="notify-prompt-allow"
          onClick={() => control.answer(ask.id, true)}
        >
          允许
        </button>
        <button
          type="button"
          class="notify-prompt-close"
          aria-label="以后再说"
          title="以后再说"
          onClick={() => control.dismiss(ask.id)}
        >
          ×
        </button>
      </div>
    </div>
  );
}
