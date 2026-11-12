# Configuration

The server reads `.env` in the repository root, and the entry host reads `client/.env`. Both are
excluded from Git. Do not commit a populated one. `scripts/bootstrap.sh` writes the server's for you.

## Server (`.env`)

| Variable | Required | Default | Notes |
| --- | :---: | --- | --- |
| `MIRROR_ACCESS_PASSWORD` | for first initialization | none | Bootstrap administrator password, at least 8 characters. Used only when the user database is empty; Compose still requires a non-empty value |
| `MIRROR_ADMIN_USERNAME` | no | `admin` | Bootstrap administrator name. Changing it does not rename an existing user |
| `MIRROR_ACCESS_SECRET` | yes | none | At least 16 characters. Retained for compatibility with access-token authentication |
| `MIRROR_AUTH_SECRET` | yes | none | At least 16 characters. Signs device/session ownership tokens |
| `MIRROR_PUBLIC_ORIGIN` | for public use | empty | The exact origin people open. WebSockets from others are refused |
| `SERVER_BIND` | no | `127.0.0.1` | Keep loopback behind a tunnel or reverse proxy |
| `SERVER_PORT` | no | `3010` | The gateway's port on the host |
| `SERVER_MEMORY` | no | `4g` | Container memory limit. New sessions are refused as it runs short |
| `SERVER_MEMSWAP` | no | `0` | Memory plus swap. `0` leaves it to Docker |
| `SERVER_CPUS` | no | `0` | CPU limit. `0` means all of the host's CPUs |
| `SERVER_SUBNET` | no | `172.31.66.0/24` | The Compose network. Change it if it collides with another network |
| `SERVER_IMAGE` | no | local build | A prebuilt image |
| `MIRROR_CLIENTS` | no | `8` | Total active session slots across users; any positive safe integer. Invalid values prevent startup |
| `MIRROR_START_URL` | no | `https://claude.ai/new` | The page a new session opens |
| `MIRROR_ACCOUNTS_DIR` | no | `<profile>-accounts` | Where browser configurations other than the legacy default keep their Chrome profiles |
| `EGRESS_POLICY` | no | `on` | `off` lets pages reach private networks and the host |
| `EGRESS_BLOCK` | no | empty | More addresses to block, comma-separated. Add the host's public IP |
| `EGRESS_PROXY` | for `compose.proxy.yml` | none | An outside proxy all browser traffic leaves through, DNS and WebRTC included: a share link (`socks5://`, `http://`, `https://`, `ss://`, `vless://`, `vmess://`, `trojan://`, `hy2://`) or an Xray outbound in JSON (`protocol`, `settings`, `streamSettings`), including VLESS Encryption and REALITY `pqv`. Needs `EGRESS_POLICY=on`. If the proxy is down, pages get no connection rather than a direct one. See [outside proxy](deployment.md#出站代理) |
| `EGRESS_BOOTSTRAP_DNS` | no | `1.1.1.1` | The resolver that looks up the proxy's own name, which cannot go through the proxy. An IPv4 address |
| `MIRROR_PAGE_SLEEP_MS` | no | `1800000` | A page nobody has seen for this long sleeps: it shows a placeholder and the site's renderer exits. A page is seen while it is its session's active tab and a viewer of that session is on screen, so tabs left behind the one in use sleep too. Each loads again when someone switches to it or comes back. Pages writing a reply, playing sound, using the microphone or in picture mode keep running. `0` turns it off |
| `TZ` | no | `Etc/UTC` | The browser's timezone, an IANA name such as `Asia/Shanghai`. An invalid name stops the container from starting. See [timezone behavior](timezone.md) |
| `PUBLIC_HOST` | for `compose.https.yml` | none | The domain Caddy serves |

Generate each signing secret independently with `openssl rand -hex 32`, and keep them stable.
Front-end logins are stored in SQLite and are not revoked by rotating these signing secrets.
Disable a user, reset their password or delete them in user management to revoke their logins.

The default database is `<CHROME_USER_DATA_DIR>/users.sqlite`, or `/data/profile/users.sqlite` in
Docker. It contains service users, scrypt password hashes, SHA-256 login-token digests and browser
profile ownership; website credentials remain in Chrome's profiles. A remembered login lasts up to
60 days. Usernames and passwords for this service are independent of accounts on visited websites.

Each front-end user sees only their own browser configurations and sessions. The session limit is
global, rather than a limit on front-end users or online devices. Lowering it keeps existing sessions
running and refuses new ones until occupancy drops below the configured capacity. Admission can
also be refused when memory is low.

The server's `compose.yml` also accepts these if you add them to its `environment`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIRROR_DISABLE_RTC` | unset | `1` turns off video over WebRTC in page mode |
| `MIRROR_USERS_DB` | `<profile>/users.sqlite` | Override the SQLite path. Put it on persistent, protected storage and include it in consistent backups |
| `MIRROR_SCREEN_GRAB` | on | `0` turns off the screen capture behind picture mode's video |
| `MIRROR_TRUSTED_PROXIES` | `SERVER_SUBNET` | Comma-separated proxies that may set `X-Forwarded-For` |
| `XVFB_SCREEN` | `12800x2880x24` | The virtual display's size |

Compose passes the password and signing keys as container environment variables. Anyone who can
inspect the container or control the Docker daemon can read them, and Docker daemon access is already
equivalent to root on the host.

## Optional CPA (`compose.cpa.yml`)

Run `node scripts/setup-cpa.mjs` to generate keys and append the CPA Compose files to `.env`.
See [CPA deployment](cpa.md) for public URLs, OAuth, Caddy routing and persistent configuration.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CPA_API_KEY` | generated by setup | Client bearer key; at least 32 characters, different from the management key |
| `CPA_MANAGEMENT_KEY` | generated by setup | CPA panel/management key; at least 32 characters |
| `CPA_PORT` | `8317` | Host IPv4 loopback port forwarded to CPA |
| `CPA_CALLBACK_PORT` | `54545` | Host IPv4 loopback OAuth callback port. Claude's redirect URI uses port 54545; use the manual callback flow if this mapping is changed |
| `CPA_MEMORY` | `512m` | CPA container memory limit, independent of the browser |
| `CPA_MEMSWAP` | `512m` | CPA memory plus Swap; equal to memory means no Swap |
| `CPA_CPUS` | `1` | CPA CPU limit |
| `CPA_IMAGE` | `remote-claude-browser-cpa:local` | This repository's CPA image with initialization/probe helpers, not an upstream image used directly |
| `CPA_EGRESS_IMAGE` | `remote-claude-browser-cpa-egress:local` | This repository's Xray SOCKS/loopback forwarding image |

`EGRESS_PROXY`, `EGRESS_BOOTSTRAP_DNS`, `EGRESS_BLOCK` and `TZ` are reused. The dedicated egress
container is limited to 128 MiB memory with no Swap and 0.5 CPU. Only its loopback TCP forwarding
ports are published; its SOCKS port is not published. CPA itself only joins an internal network.

The `.env` keys initialize `cpa-config` once. Subsequent panel edits are retained in that volume;
editing `.env` does not automatically reset them. See [configuration reset](cpa.md#配置持久化升级和密钥).

## Entry host (`client/.env`)

| Variable | Required | Default | Notes |
| --- | :---: | --- | --- |
| `PUBLIC_HOST` | yes | none | The domain people open, pointing at this host |
| `SERVER_SSH_HOST` | yes | none | The server's SSH address |
| `SERVER_SSH_PORT` | no | `22` | |
| `SERVER_SSH_USER` | no | `root` | The user whose `authorized_keys` holds the tunnel's key |
| `SERVER_PORT` | no | `3010` | `SERVER_PORT` from the server's `.env` |
| `HTTP_BIND` | no | `0.0.0.0` | The address Caddy is published on |
| `HTTP_PORT`, `HTTPS_PORT` | no | `80`, `443` | Change them if the host already uses these |
| `TUNNEL_IMAGE` | no | local build | A prebuilt tunnel image |

## Development outside Docker

| Variable | Meaning |
| --- | --- |
| `CHROME_PATH` | Absolute path to Chromium or Google Chrome |
| `CHROME_HEADFUL=1` | Run the browser headfully. Needs `DISPLAY` |
| `CHROME_USER_DATA_DIR` | Where the profile, downloads and uploads go. Temporary if unset |
| `VIEWER_PORT` | Vite port, default `5173` |
| `VITE_GATEWAY_URL` | Vite proxy target, default `http://127.0.0.1:3000` |

`MIRROR_E2E=1` enables test-only unauthenticated routes. The gateway refuses it in production.
