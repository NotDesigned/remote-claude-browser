<!-- 读者：提交 PR 的开发者。开发和测试要求见 CONTRIBUTING.md。 -->

## 说明

要解决什么问题？选择了什么边界？

## 影响的文档（必填，见 docs/documentation.md 归属表）

列出改动所属主题的归属文件，以及在其中改了什么。确实没有影响时写「无」，并说明理由。

-

## 验证

- [ ] `pnpm run ci`
- [ ] `pnpm docs:check`
- [ ] `pnpm smoke:compose`（改了容器或运行时时）
- [ ] 用户能感知的改动已写进 `CHANGELOG.md` 的「未发布」

逐条写出执行的命令和结果：

## 安全和兼容性

说明本 PR 对下列各项的影响，没有影响的写「无」：

- CDP 暴露、Chromium 沙箱、查看器隔离
- 登录和权限、用户之间的隔离
- 每个浏览器配置的出口和 Mihomo
- CPA 实例和调用 Key
- remote-cc 的令牌和会话授权
- Resend webhook
- 资源抓取、浏览器配置数据、网站兼容性

- [ ] 不包含密钥、凭据或私人浏览数据。
