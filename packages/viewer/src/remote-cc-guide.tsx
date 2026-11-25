/**
 * How to use remote-cc with this workbench, from installing it to running Claude Code as a
 * browser profile: shown at the bottom of the 「remote-cc」 tab. Commands follow remote-cc ≥ 0.8.
 */
export function RemoteCcGuide({ origin }: { origin: string }) {
  return (
    <section class="network-card remote-cc-guide" aria-labelledby="remote-cc-guide-title">
      <h3 id="remote-cc-guide-title">使用说明</h3>
      <p class="network-muted">
        remote-cc 让 Claude Code
        在服务器的容器里运行，界面在你电脑的终端里，命令和文件都在你的电脑上。 命令里的{" "}
        <code>&lt;服务器&gt;-cc</code> 是你电脑上的服务器别名，用 <code>remote-cc host list</code>{" "}
        查看。每条命令的全部选项见 <code>remote-cc help 命令</code>。
      </p>

      <details>
        <summary>第一次使用：从安装到运行</summary>
        <ol class="remote-cc-guide-steps">
          <li>
            <strong>安装 remote-cc</strong>（在你的电脑上）
            <p class="network-muted">Windows（PowerShell）：</p>
            <pre>
              {"irm https://raw.githubusercontent.com/NotDesigned/remote-cc/main/install.ps1 | iex"}
            </pre>
            <p class="network-muted">macOS、Linux：</p>
            <pre>
              {
                "curl -fsSL https://raw.githubusercontent.com/NotDesigned/remote-cc/main/install.sh | sh"
              }
            </pre>
            <p class="network-muted">
              以后升级用 <code>remote-cc update</code>。
            </p>
          </li>
          <li>
            <strong>拿到服务器上的账号</strong>
            <p class="network-muted">
              用别人的服务器：请服务器管理员为你添加用户，他会得到一条一次性邀请码，私下发给你：
            </p>
            <pre>{"remote-cc server user add root@<服务器> <你的用户名>   # 管理员执行"}</pre>
            <p class="network-muted">你在自己电脑上用邀请码加入：</p>
            <pre>{"remote-cc device join <邀请码>"}</pre>
            <p class="network-muted">
              自己有服务器（root 或 sudo 账号）：一条命令部署，你就是第一个用户，电脑也一并配好：
            </p>
            <pre>{"remote-cc server setup root@<服务器>"}</pre>
          </li>
          <li>
            <strong>出口主机</strong>（每台服务器只需一次，由管理员完成）
            <p class="network-muted">
              服务器管理员在服务器上部署出口主机，它让 Claude Code 经浏览器配置的节点出网：
            </p>
            <pre>{`remote-cc server egress --rcb ${origin} root@<服务器>`}</pre>
            <p class="network-muted">然后工作台管理员在本页「出口主机」下批准它（核对连接码）。</p>
          </li>
          <li>
            <strong>把电脑连到工作台</strong>
            <pre>{`remote-cc rcb login ${origin}`}</pre>
            <p class="network-muted">
              终端显示连接码和链接。打开链接，或在上方「批准连接」输入连接码；确认连接码和终端里的一致后批准。
            </p>
          </li>
          <li>
            <strong>在项目目录里选一个浏览器配置</strong>
            <pre>{"cd 你的项目\nremote-cc rcb use"}</pre>
            <p class="network-muted">
              按序号选一个配置。以后这个目录和它的子目录都默认用这个配置和服务器。
            </p>
          </li>
          <li>
            <strong>第一次：登录这个配置的 Claude 账号</strong>
            <pre>{"remote-cc account login"}</pre>
            <p class="network-muted">
              登录页会在这个配置的浏览器里打开（没有自动打开时，在上方「等待完成的 Claude Code
              登录」里点「打开授权页」），点「授权」即可，授权码会自动交回终端。
            </p>
          </li>
          <li>
            <strong>开始使用</strong>
            <pre>
              {
                "remote-cc                 # 启动 Claude Code\nremote-cc -- --continue   # 继续这个目录上次的对话"
              }
            </pre>
          </li>
        </ol>
      </details>

      <details>
        <summary>换一台新电脑</summary>
        <ul class="remote-cc-guide-list">
          <li>
            在已经能用的电脑上生成邀请码，到新电脑上加入（不用找管理员）：
            <pre>
              {
                "remote-cc device invite <服务器>-cc   # 在旧电脑上\nremote-cc device join <邀请码>        # 在新电脑上"
              }
            </pre>
          </li>
          <li>
            新电脑也要连到工作台：运行 <code>remote-cc rcb login {origin}</code>
            ，在这里批准。每台电脑单独批准，可以在「已连接的电脑」里单独断开。
          </li>
          <li>浏览器配置的 Claude 登录跟着配置走，存放在服务器上，新电脑不用重新登录 Claude。</li>
          <li>
            电脑丢了：在「已连接的电脑」里断开它，再用{" "}
            <code>remote-cc device list &lt;服务器&gt;-cc</code> 和{" "}
            <code>remote-cc device remove</code> 撤销它的服务器访问。
          </li>
        </ul>
      </details>

      <details>
        <summary>切换配置、服务器和账号</summary>
        <ul class="remote-cc-guide-list">
          <li>
            查看配置和序号：<code>remote-cc rcb profiles</code>。只这一次换用别的配置：
            <code>remote-cc --rcb 2</code>；也可以写配置名称、邮箱或 id 中的一段，例如{" "}
            <code>--rcb sola</code>。
          </li>
          <li>
            改掉这个目录记住的配置：在目录里再运行一次 <code>remote-cc rcb use</code>。
          </li>
          <li>
            换服务器：<code>remote-cc rcb use &lt;配置&gt; &lt;服务器&gt;-cc</code>
            ，或者只这一次 <code>remote-cc --rcb &lt;配置&gt; &lt;服务器&gt;-cc</code>。
          </li>
          <li>
            不经过工作台、用你自己的 Claude 账号：<code>remote-cc &lt;服务器&gt;-cc</code>（第一次先{" "}
            <code>remote-cc account login &lt;服务器&gt;-cc</code>）。
          </li>
        </ul>
      </details>

      <details>
        <summary>常见问题</summary>
        <dl class="remote-cc-guide-faq">
          <dt>批准请求里的连接码和终端里的不一样，或者不是我发起的</dt>
          <dd>点「拒绝」。只批准你自己刚刚发起、连接码一致的请求。</dd>
          <dt>remote-cc 报「连接已失效，请重新连接」</dt>
          <dd>
            这台电脑在「已连接的电脑」里被断开了，或者你的工作台账户被停用。重新运行{" "}
            <code>remote-cc rcb login {origin}</code> 并批准。
          </dd>
          <dt>remote-cc 报「太久没有通过单点登录进入工作台」</dt>
          <dd>
            用单点登录创建、没有密码的用户，需要定期登录一次工作台。在浏览器里登录工作台后再试。
          </dd>
          <dt>启动时说出口和工作台记录的不一致</dt>
          <dd>
            remote-cc
            会让工作台重新检查一次这个配置的出口，再启动一次。仍然不一致时，在「代理来源」检查这个配置绑定的节点。
          </dd>
          <dt>登录页没有在浏览器里打开</dt>
          <dd>
            在上方「等待完成的 Claude Code
            登录」里点「打开授权页」；或者把终端里的链接复制到这个配置的浏览器里打开，再把授权码粘贴回终端。
          </dd>
          <dt>网络断了怎么办</dt>
          <dd>
            remote-cc 会自动重连，服务器上的 Claude Code
            不会中断，断线时正在执行的命令照常完成。服务器保留断线的会话 10 分钟；按 Ctrl-C
            放弃重连。
          </dd>
          <dt>容器坏了，或者想要一个全新的容器</dt>
          <dd>
            请服务器管理员运行{" "}
            <code>remote-cc server user rebuild root@&lt;服务器&gt; &lt;用户名&gt;</code>
            。登录、对话历史和密钥都会保留。
          </dd>
          <dt>还有问题</dt>
          <dd>
            加 <code>-v</code> 运行可以看到每一步；电脑上的日志在 remote-cc 的缓存目录里（
            <code>last.log</code>）。更多说明见{" "}
            <a
              href="https://github.com/NotDesigned/remote-cc/blob/main/docs/usage.md#rcb"
              target="_blank"
              rel="noreferrer"
            >
              remote-cc 使用文档
            </a>
            。
          </dd>
        </dl>
      </details>
    </section>
  );
}
