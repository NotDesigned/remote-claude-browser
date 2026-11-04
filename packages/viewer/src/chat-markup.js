/**
 * Static, trusted markup of the text-chat view. The unified shell provides the brand, the view
 * switch, theme and status; this part keeps the ids the chat logic and QA scripts rely on.
 */
export const CHAT_VIEW_MARKUP = `
<div class="chat-subbar">
  <button id="history-toggle" type="button" aria-controls="chat-sidebar" aria-expanded="false">对话</button>
  <button id="mobile-new-chat" type="button" disabled>＋ 新对话</button>
  <span id="connection" role="status">连接中</span>
  <button id="retry-chat" type="button" hidden>重新连接</button>
</div>
<div class="layout">
  <button id="history-backdrop" type="button" aria-label="关闭对话列表" hidden></button>
  <aside id="chat-sidebar" aria-label="对话列表">
    <button id="history-close" type="button">关闭</button>
    <button id="new-chat" type="button" disabled>＋ 新对话</button>
    <p class="label">最近</p>
    <nav id="conversations"></nav>
    <p class="aside-note">所有人共用同一个 Claude 账号，对话历史彼此可见。</p>
  </aside>
  <main id="chat-main">
    <div id="notice" role="status">正在读取远程浏览器里的 Claude 页面…</div>
    <div id="messages" aria-label="对话内容"></div>
    <button id="jump-latest" type="button" hidden>回到最新消息 ↓</button>
    <div class="chat-status">
      <span id="generation-status" role="status"></span><span id="action-status" role="status"></span>
    </div>
    <button id="resolve-pending" type="button" hidden>已核对远端页面，解除待确认状态</button>
    <section id="downloads" aria-label="下载文件" hidden></section>
    <form id="composer">
      <section id="transfer-status" role="status" hidden>
        <span id="upload-status"></span>
        <input id="file-picker" type="file" hidden />
        <progress id="upload-progress" max="100" value="0" hidden></progress>
        <button id="cancel-upload" type="button">取消上传</button>
      </section>
      <label class="sr-only" for="draft">消息</label>
      <textarea id="draft" rows="2" maxlength="100000" placeholder="输入消息，Enter 发送，Shift + Enter 换行"></textarea>
      <div class="compose-footer">
        <button id="attach" type="button" disabled aria-label="添加附件">＋ 附件</button>
        <button type="button" id="stop" hidden>停止生成</button>
        <button type="submit" id="send" disabled>发送</button>
      </div>
    </form>
  </main>
</div>
`;
