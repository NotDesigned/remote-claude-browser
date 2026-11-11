# 容器时区

浏览器使用的时区由服务端 `.env` 里的 `TZ` 决定，写一个 IANA 时区名，例如：

```bash
TZ=Asia/Shanghai
```

未设置时为 UTC。服务不会联网查询时区。网站常拿浏览器时区和 IP 的所在地比对，所以一般应设成服务器所在地的时区，而不是你自己设备所在地。夏令时由 IANA 时区数据自动处理。

改完后重新创建服务容器才会生效：

```bash
docker compose up -d server
```

无效的时区名会阻止容器启动，避免悄悄用错时区。

Compose 把这项设置传给入口脚本的 `MIRROR_TIMEZONE`。入口脚本在启动 Chrome 前导出 `TZ`，并把时区名称和 zoneinfo 文件写入持久化卷的 `/data/timezone/`。镜像里的 `/etc/timezone` 和 `/etc/localtime` 指向这些文件，所以只读根文件系统中的其他进程也使用同一个时区。

检查生效结果：

```bash
docker compose exec server date -Is
docker compose exec server cat /data/timezone/name
```

离线测试：

```bash
bash scripts/limited-run.sh node --test deploy/timezone.test.mjs
```
