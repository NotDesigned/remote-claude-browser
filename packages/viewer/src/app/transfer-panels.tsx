/** Files and clipboard: the local file picker, upload progress and the download tray. */
import type { TabId } from "@mirror/protocol";
import { useState, type MutableRef } from "preact/hooks";
import { apiRequest } from "../api";
import { DownloadTray, type DownloadEntry } from "../chrome/downloads";
import type { UploadState } from "../uploads";

export interface TransferPanelsProps {
  fileInputRef: MutableRef<HTMLInputElement | null>;
  uploadState: UploadState | null;
  /** The downloads the tray offers. */
  downloads: readonly DownloadEntry[];
  /** The session downloads are canceled in. */
  sid: string | undefined;
  onSelectFiles(tab: TabId, input: HTMLInputElement): void;
  onCancelFilePick(tab: TabId): void;
  onCancelUpload(): void;
  onDismissDownload(id: string): void;
}

export function TransferPanels({
  fileInputRef,
  uploadState,
  downloads,
  sid,
  onSelectFiles,
  onCancelFilePick,
  onCancelUpload,
  onDismissDownload,
}: TransferPanelsProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null);
  return (
    <aside id="transfer-panels" aria-label="文件与剪贴板">
      <input
        ref={fileInputRef}
        id="local-file-picker"
        type="file"
        multiple={uploadState?.multiple ?? false}
        hidden
        onChange={(event) => {
          if (uploadState === null) event.currentTarget.value = "";
          else onSelectFiles(uploadState.tab, event.currentTarget);
        }}
        onCancel={() => {
          if (uploadState !== null) onCancelFilePick(uploadState.tab);
        }}
      />
      {/* Uploading: a thin bar along the bottom edge, over everything, taking no room. */}
      {uploadState?.phase === "uploading" && (
        <div
          id="upload-progress"
          role="progressbar"
          aria-label={uploadState.name || "正在上传附件"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            uploadState.total > 0
              ? Math.round((uploadState.loaded / uploadState.total) * 100)
              : undefined
          }
          data-indeterminate={uploadState.total > 0 ? undefined : "true"}
        >
          <span
            style={
              uploadState.total > 0
                ? { width: `${(uploadState.loaded / uploadState.total) * 100}%` }
                : undefined
            }
          />
        </div>
      )}
      {/* Only what needs the person: a tap to open the picker, or a failure. */}
      {uploadState !== null &&
        (uploadState.phase === "picking" || uploadState.phase === "error") && (
          <section id="upload-panel" role="status">
            <span>{uploadState.name}</span>
            {uploadState.phase === "picking" && (
              <>
                <button type="button" onClick={() => fileInputRef.current?.click()}>
                  选择本机文件
                </button>
                <small>单文件 ≤100 MB，单批 ≤500 MB</small>
              </>
            )}
            <button type="button" onClick={onCancelUpload}>
              {uploadState.phase === "picking" ? "取消上传" : "关闭"}
            </button>
          </section>
        )}
      <DownloadTray
        downloads={downloads}
        error={downloadError}
        onCancel={async (id) => {
          if (!sid) return;
          setDownloadError(null);
          try {
            await apiRequest(
              `/s/${encodeURIComponent(sid)}/downloads/${encodeURIComponent(id)}`,
              "DELETE",
            );
          } catch {
            setDownloadError("取消下载失败，请重试");
          }
        }}
        onDismiss={onDismissDownload}
      />
    </aside>
  );
}
