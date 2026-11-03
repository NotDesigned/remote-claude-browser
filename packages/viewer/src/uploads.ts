/**
 * File-upload relay, viewer half. A local rrweb-clone input keeps the native mobile picker and
 * stages its File objects until the gateway's authoritative fileChooserOpened key arrives (or
 * vice versa). Each bounded file is streamed as one raw, same-origin request in selection order.
 */
import type { Down, TabId } from "@mirror/protocol";

const DEFAULT_STAGE_TIMEOUT_MS = 2 * 60 * 1_000;
const MAX_ENCODED_NAME_LENGTH = 2_048;
const MAX_MIME_LENGTH = 256;

type FilePick = Extract<Down, { t: "filepick" }>;

interface PendingPick {
  message: FilePick;
  sessionId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface Selection {
  files: File[];
  timer: ReturnType<typeof setTimeout>;
}

export interface UploadState {
  tab: TabId;
  phase: "picking" | "uploading" | "done" | "error";
  multiple: boolean;
  loaded: number;
  total: number;
  name: string;
}

export interface FileUploadRelayOptions {
  onState?: (state: UploadState | null) => void;
  fetch?: typeof fetch;
  stageTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onError?: (error: unknown) => void;
}

export interface FileUploadRelay {
  handlePick(message: FilePick, sessionId: string): void;
  select(tab: TabId, input: HTMLInputElement): void;
  /** Stage files that did not come from a file input (for example a pasted screenshot). */
  selectFiles(tab: TabId, files: readonly File[]): void;
  cancel(): void;
  clear(): void;
  dispose(): void;
}

export function createFileUploadRelay(options: FileUploadRelayOptions = {}): FileUploadRelay {
  const request = options.fetch ?? fetch;
  const stageTimeoutMs = options.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  if (!Number.isSafeInteger(stageTimeoutMs) || stageTimeoutMs < 1) {
    throw new RangeError("stageTimeoutMs must be a positive safe integer");
  }
  const schedule = options.setTimer ?? setTimeout;
  const cancel = options.clearTimer ?? clearTimeout;
  const report = options.onError ?? (() => undefined);
  const picks = new Map<TabId, PendingPick>();
  const selections = new Map<TabId, Selection>();
  const active = new Map<AbortController, PendingPick>();
  let disposed = false;

  const clearPick = (tab: TabId): PendingPick | undefined => {
    const pick = picks.get(tab);
    if (pick !== undefined) cancel(pick.timer);
    picks.delete(tab);
    return pick;
  };

  const clearSelection = (tab: TabId): Selection | undefined => {
    const selection = selections.get(tab);
    if (selection !== undefined) cancel(selection.timer);
    selections.delete(tab);
    return selection;
  };

  const pair = (tab: TabId): void => {
    const pick = picks.get(tab);
    const selection = selections.get(tab);
    if (pick === undefined || selection === undefined) return;
    clearPick(tab);
    clearSelection(tab);
    const controller = new AbortController();
    active.set(controller, pick);
    const notify = (loaded: number, total: number, name: string) =>
      options.onState?.({
        tab,
        phase: "uploading",
        multiple: pick.message.multiple,
        loaded,
        total,
        name,
      });
    notify(
      0,
      selection.files.reduce((sum, file) => sum + file.size, 0),
      selection.files[0]?.name ?? "",
    );
    const transport = options.fetch ?? ((url, init) => xhrUpload(url, init, notify));
    void uploadBatch(transport, pick, selection.files, controller.signal, notify)
      .then(() => {
        if (!controller.signal.aborted)
          options.onState?.({
            tab,
            phase: "done",
            multiple: false,
            loaded: 1,
            total: 1,
            name: "附件已传至远端，请等待官网处理完成",
          });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        options.onState?.({
          tab,
          phase: "error",
          multiple: false,
          loaded: 0,
          total: 0,
          name: error instanceof Error ? error.message : "上传失败，请重试",
        });
        void request(`/s/${encodeURIComponent(pick.sessionId)}/u/${pick.message.key}`, {
          method: "DELETE",
        }).catch(() => undefined);
        report(error);
      })
      .finally(() => active.delete(controller));
  };

  return {
    handlePick(message, sessionId) {
      if (disposed) return;
      validatePick(message);
      if (sessionId.trim() === "") throw new TypeError("sessionId must not be empty");
      if (
        picks.get(message.tab)?.message.key === message.key ||
        [...active.values()].some((pick) => pick.message.key === message.key)
      )
        return;
      for (const [controller, previous] of active) {
        if (previous.message.tab === message.tab) {
          controller.abort();
          active.delete(controller);
        }
      }
      clearPick(message.tab);
      options.onState?.({
        tab: message.tab,
        phase: "picking",
        multiple: message.multiple,
        loaded: 0,
        total: 0,
        name: "请选择本机文件",
      });
      const timer = schedule(() => {
        picks.delete(message.tab);
        clearSelection(message.tab);
        options.onState?.({
          tab: message.tab,
          phase: "error",
          multiple: false,
          loaded: 0,
          total: 0,
          name: "选择文件已超时，请重新点击附件入口",
        });
      }, stageTimeoutMs);
      picks.set(message.tab, { message, sessionId, timer });
      pair(message.tab);
    },
    select(tab, input) {
      if (disposed) return;
      const files = input.files === null ? [] : Array.from(input.files);
      // File objects remain readable after reset and resetting allows the same file to be picked.
      input.value = "";
      this.selectFiles(tab, files);
    },
    selectFiles(tab, files) {
      if (disposed || files.length === 0) return;
      clearSelection(tab);
      const timer = schedule(() => selections.delete(tab), stageTimeoutMs);
      selections.set(tab, { files: [...files], timer });
      pair(tab);
    },
    cancel() {
      this.clear();
    },
    clear() {
      for (const pick of [...picks.values(), ...active.values()]) {
        void request(`/s/${encodeURIComponent(pick.sessionId)}/u/${pick.message.key}`, {
          method: "DELETE",
        }).catch(() => undefined);
      }
      for (const controller of active.keys()) controller.abort();
      active.clear();
      for (const tab of [...picks.keys()]) clearPick(tab);
      for (const tab of [...selections.keys()]) clearSelection(tab);
      options.onState?.(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      this.clear();
    },
  };
}

async function uploadBatch(
  request: typeof fetch,
  pick: PendingPick,
  files: readonly File[],
  signal: AbortSignal,
  progress: (loaded: number, total: number, name: string) => void,
): Promise<void> {
  const { message } = pick;
  if (files.length > message.maxFiles) throw new Error("所选文件数量超过上限");
  if (!message.multiple && files.length !== 1) {
    throw new Error("远端附件入口只接受一个文件");
  }
  let totalSize = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > message.maxFileBytes) {
      throw new Error(`${file.name || "File"} exceeds the upload size limit`);
    }
    totalSize += file.size;
    if (!Number.isSafeInteger(totalSize) || totalSize > message.maxTotalBytes) {
      throw new Error("Selected files exceed the total upload size limit");
    }
    if (encodeURIComponent(file.name).length > MAX_ENCODED_NAME_LENGTH) {
      throw new Error("Selected filename is too long");
    }
    if (file.type.length > MAX_MIME_LENGTH || /[^\x20-\x7e]/.test(file.type)) {
      throw new Error("Selected file has an invalid MIME type");
    }
  }

  const url = `/s/${encodeURIComponent(pick.sessionId)}/u/${encodeURIComponent(message.key)}`;
  let completedBytes = 0;
  for (const [index, file] of files.entries()) {
    progress(completedBytes, totalSize, file.name);
    const response = await request(url, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-mirror-file-index": String(index),
        "x-mirror-file-offset": String(completedBytes),
        "x-mirror-file-count": String(files.length),
        "x-mirror-file-size": String(file.size),
        "x-mirror-total-size": String(totalSize),
        "x-mirror-file-name": encodeURIComponent(file.name),
        "x-mirror-file-type": encodeURIComponent(file.type),
      },
      body: file,
      signal,
    });
    if (!response.ok) throw new Error(`上传失败（HTTP ${response.status}），请重新选择文件`);
    completedBytes += file.size;
    progress(completedBytes, totalSize, file.name);
  }
}

/** XHR streams browser File bodies and reports actual upstream progress without ArrayBuffers. */
function xhrUpload(
  url: RequestInfo | URL,
  init: RequestInit | undefined,
  progress: (loaded: number, total: number, name: string) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", String(url));
    const headers = init?.headers as Record<string, string>;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    const total = Number(headers["x-mirror-total-size"]);
    const name = decodeURIComponent(headers["x-mirror-file-name"] ?? "");
    const abort = () => xhr.abort();
    const signal = init?.signal;
    const finish = () => signal?.removeEventListener("abort", abort);
    xhr.timeout = 10 * 60 * 1000;
    xhr.upload.onprogress = (event) =>
      progress(Number(headers["x-mirror-file-offset"] ?? 0) + event.loaded, total, name);
    xhr.onload = () => {
      finish();
      resolve(new Response(null, { status: xhr.status }));
    };
    xhr.onerror = () => {
      finish();
      reject(new Error("上传连接中断，请重新选择文件"));
    };
    xhr.ontimeout = () => {
      finish();
      reject(new Error("上传超时，请重新选择文件"));
    };
    xhr.onabort = () => {
      finish();
      reject(new DOMException("Upload canceled", "AbortError"));
    };
    if (signal?.aborted) {
      finish();
      reject(new DOMException("Upload canceled", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.send(init?.body as File);
  });
}

function validatePick(message: FilePick): void {
  if (message.key === "" || !/^[A-Za-z0-9_-]+$/.test(message.key)) {
    throw new TypeError("filepick key must be URL-safe");
  }
  for (const [name, value] of [
    ["maxFiles", message.maxFiles],
    ["maxFileBytes", message.maxFileBytes],
    ["maxTotalBytes", message.maxTotalBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
}
