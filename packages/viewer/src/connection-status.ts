/** What the top bar's status pill says, and the sentence behind it in the 「连接」 popover. */
import type { GatewayConnectionState } from "./ws";

export type StatusTone = "ok" | "busy" | "bad";
export type ClientPhase =
  "picking" | "starting" | "ready" | "error" | "ending" | "closed" | "replaced";

export type ConnectionKind =
  | "connected"
  | "syncing"
  | "input-unsynced"
  | "connecting"
  | "reconnecting"
  | "starting"
  | "replaced"
  | "ending"
  | "ended"
  | "failed";

export interface ConnectionStatus {
  kind: ConnectionKind;
  text: string;
  tone: StatusTone;
  /** One sentence on why, and what it means for the person typing. */
  reason: string;
}

export function describeConnection(input: {
  clientPhase: ClientPhase;
  connection: GatewayConnectionState;
  inputUnsynced: boolean;
  inputReady: boolean;
}): ConnectionStatus {
  const { clientPhase, connection } = input;
  if (clientPhase === "replaced")
    return {
      kind: "replaced",
      text: "已由另一页面接管",
      tone: "bad",
      reason: "这个会话已在另一个页面打开，本页面不再显示画面，也不再发送输入。",
    };
  if (clientPhase === "closed")
    return { kind: "ended", text: "已结束", tone: "bad", reason: "会话已结束，远程浏览器已断开。" };
  if (clientPhase === "ending")
    return { kind: "ending", text: "结束中", tone: "bad", reason: "正在结束会话。" };
  if (clientPhase === "error")
    return {
      kind: "failed",
      text: "未连接",
      tone: "bad",
      reason: "会话没有连上，页面上的提示说明了原因和可以做什么。",
    };
  if (clientPhase !== "ready")
    return {
      kind: "starting",
      text: "连接中",
      tone: "busy",
      reason: "正在准备远程浏览器。",
    };
  if (connection === "connecting")
    return {
      kind: "connecting",
      text: "连接中",
      tone: "busy",
      reason: "正在连接远程浏览器，连上之前输入不会发送。",
    };
  if (connection !== "open")
    return {
      kind: "reconnecting",
      text: "重新连接中",
      tone: "busy",
      reason: "与服务器的连接断开了，正在自动重试；连上之前输入不会发送。",
    };
  if (input.inputUnsynced)
    return {
      kind: "input-unsynced",
      text: "输入未同步",
      tone: "bad",
      reason: "最近一次输入没有同步到页面，回车和点击暂时不会发送。",
    };
  if (!input.inputReady)
    return {
      kind: "syncing",
      text: "同步中",
      tone: "busy",
      reason: "正在载入页面内容，载入完成后才能输入。",
    };
  return {
    kind: "connected",
    text: "已连接",
    tone: "ok",
    reason: "页面已同步，输入会直接发送到远程浏览器。",
  };
}
