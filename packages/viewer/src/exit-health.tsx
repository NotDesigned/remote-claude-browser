import type { ExitHealth } from "./network-api";

export function ExitHealthDetails({ health }: { health?: ExitHealth }) {
  if (!health || health.status === "unchecked") return <p class="network-muted">尚未检查出口</p>;
  if (health.status === "checking")
    return (
      <p class="network-muted" role="status">
        正在检查出口…
      </p>
    );
  return (
    <div class="network-exit-health" role="status">
      <p class={health.status === "error" ? "network-error" : "network-muted"}>
        {health.status === "healthy" ? "出口可用" : (health.error ?? "出口不可用")}
        {health.exitIp && (
          <>
            {" "}
            · <code>{health.exitIp}</code>
          </>
        )}
      </p>
      {health.timeZone && (
        <p class="network-muted">
          {[health.exitCity, health.exitCountry, health.timeZone].filter(Boolean).join(" · ")}
        </p>
      )}
      {health.checkedAt && (
        <p class="network-muted">检测时间：{new Date(health.checkedAt).toLocaleString()}</p>
      )}
      {health.status === "healthy" &&
        health.browserTimeZone &&
        health.timeZone !== health.browserTimeZone && (
          <p class="network-error">
            出口时区已变化，浏览器仍使用 {health.browserTimeZone}
            。请结束该配置的所有会话，等待约两分钟至「运行中」消失后再打开，使本地时间与出口一致。
          </p>
        )}
    </div>
  );
}
