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
    <div class="side-head" id="side-head"><span class="wordmark">Claude</span></div>
    <button id="history-close" class="sr-only" type="button">关闭</button>
    <div class="side-scroll">
      <div class="side-rows" id="side-rows">
        <button id="new-chat" class="side-row" type="button" disabled><span class="glyph" aria-hidden="true"></span><span>New</span></button>
      </div>
      <div class="recents-head" id="recents-head"><button id="recents-toggle" type="button" aria-expanded="true"><span id="recents-label">Recents</span></button></div>
      <nav id="conversations"></nav>
    </div>
    <div class="side-account" id="side-account" hidden></div>
  </aside>
  <div class="chat-body">
  <header class="chat-title"><button id="sidebar-show" type="button" aria-label="展开对话列表" hidden><span class="glyph" aria-hidden="true"></span></button><span id="chat-title"></span><span id="chat-title-glyph" class="glyph" aria-hidden="true"></span><button id="chat-header" class="replica" type="button" aria-label="在页面模式中打开" hidden></button><button id="new-header" class="replica" type="button" aria-label="在页面模式中打开" hidden></button></header>
  <div class="chat-columns">
  <main id="chat-main">
    <h1 class="chat-greeting" id="chat-greeting" hidden><span id="chat-greeting-text"></span></h1>
    <div id="notice" role="status" hidden></div>
    <div id="messages" aria-label="对话内容"></div>
    <button id="jump-latest" type="button" aria-label="回到最新消息" hidden><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M5 11l5 5 5-5"/></svg></button>
    <div class="chat-status">
      <span id="generation-status" role="status"></span><span id="action-status" role="status"></span><span id="history-status" role="status"></span>
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
      <ul id="attachments" aria-label="已添加的附件" hidden></ul>
      <div class="compose-box">
        <label class="sr-only" for="draft">消息</label>
        <textarea id="draft" rows="1" maxlength="100000" placeholder="Reply"></textarea>
        <button type="button" id="stop" aria-label="停止生成" hidden></button>
        <button type="submit" id="send" aria-label="发送" disabled><span class="glyph" aria-hidden="true">↵</span></button>
      </div>
      <div class="compose-footer">
        <button id="compose-project" type="button" aria-label="在页面模式中选择项目" hidden></button>
        <button id="attach" type="button" disabled aria-label="添加附件"><span class="glyph" aria-hidden="true">＋</span></button>
        <span id="compose-extras"></span>
        <span class="compose-note" id="compose-note"></span>
        <button id="compose-model" type="button" aria-haspopup="menu" aria-expanded="false" hidden></button>
        <button id="compose-mode" type="button" aria-label="在页面模式中更改" hidden></button>
      </div>
    </form>
    <button id="new-below" class="replica" type="button" aria-label="在页面模式中打开" hidden></button>
    <div id="model-menu" role="menu" aria-label="模型" hidden></div>
  </main>
  <button id="chat-panel" class="replica" type="button" aria-label="在页面模式中打开侧栏" hidden></button>
  </div>
  </div>
</div>
`;
