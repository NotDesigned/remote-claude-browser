# 出口当地时间与时区

每个浏览器配置启动时，经它实际使用的出口查询 `https://ipwho.is/`，读取出口 IP 地域信息中的 IANA 时区。选择节点的配置通过自己的 Mihomo 查询；默认配置通过部署默认出口查询。用户设备的所在地不参与探测。

Chrome 进程使用该时区启动，网页、iframe 和 Worker 的 `Date`、`Intl.DateTimeFormat` 保持一致。夏令时由 IANA 数据处理，例如洛杉矶冬季 UTC−8、夏季 UTC−7。工作台顶部的「出口当地时间」使用服务器 UTC 时间样本和当前会话的出口时区；设备时钟不准确也不会改变显示的当地时间。配置卡片显示最近一次探测的时区。

切换出口会关闭该配置的浏览器，清除旧时区，下一次启动时从新出口重新探测。运行中的出口缓存探测结果；修改节点内容或重建运行时后重新查询。无法获取有效时区时，启动会明确报错；修复节点连接后可以重新打开配置。

## 服务进程的时区

`.env` 的 `TZ` 配置网关、日志和系统工具的时区，默认 `Etc/UTC`：

```bash
TZ=Asia/Shanghai
```

Compose 将该值传给入口的 `MIRROR_TIMEZONE`。入口把 zoneinfo 和名称写入 `/data/timezone/`，只读根文件系统中的 `/etc/localtime`、`/etc/timezone` 指向这些文件。无效的 IANA 名称会阻止容器启动。Chrome 按各自出口使用独立的 `TZ`。

`docker compose exec server date -Is` 显示服务进程时间。浏览器时区可在工作台时钟提示中查看，或在对应浏览器中检查：

```js
Intl.DateTimeFormat().resolvedOptions().timeZone
new Date().toString()
```

完整隔离验收覆盖东京、洛杉矶双出口的主线程/Worker、冬夏偏移、浏览器重开、私有 X11 画面及探测失败处理，运行方式见[部署文档](deployment.md#可选按浏览器配置选择出口)。
