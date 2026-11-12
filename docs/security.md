# Security model

Remote Browser is intended for a small set of trusted viewers. It is not a hardened multi-tenant
RBI service and does not claim that DOM reconstruction provides the same viewer isolation as a
pixel-only stream.

## Trust boundaries

### Visited sites are untrusted

Site JavaScript executes in authoritative Chromium. Chromium's sandbox and the container boundary
reduce risk but do not make renderer compromise impossible. A browser exploit could attempt to
reach host or network resources.

Production deployments should:

- keep Chromium non-root with its sandbox enabled;
- keep CDP private and unexposed;
- block browser egress to private, carrier-NAT, link-local, and cloud metadata destinations;
- isolate the Docker host from unrelated sensitive services;
- patch host, Docker, Chromium base image, and Node dependencies regularly.

The default server container sets these egress rules in its own network namespace, leaving the host's
firewall alone. With `compose.hostnet.yml`, rules instead live in the host namespace and target the
browser UID. Add the host's public IP to `EGRESS_BLOCK`.

With `EGRESS_PROXY` and `compose.proxy.yml`, Xray carries the browser UID's traffic to that
proxy over a TUN interface, and the firewall rejects anything the browser UID sends elsewhere, so a
proxy outage leaves pages offline rather than on the host's address. Xray runs as UID 10002
holding only `CAP_NET_ADMIN`; the proxy's credentials stay out of the browser's and gateway's
environment. The private-network rules above still apply to what goes through the proxy. A root supervisor forwards shutdown signals and waits for browser processes before removing policy routes; neither it nor the tunnel exposes a control port.

### Viewers are trusted with page content

Authenticated front-end users receive reconstructed markup, CSS, text, proxied assets and media from
their own browser configurations and sessions. Ownership is checked on session operations,
WebSocket upgrades and resource access. A user can navigate, type, upload and download within their
own sessions. Devices signed into the same front-end account can access that account's browser
configurations, and website cookies remain shared between sessions that select the same configuration.

Front-end users are separate from accounts on visited sites. New users start with their own Chrome
profiles and choose which websites to sign into. Existing profiles are assigned once to the bootstrap
administrator during migration; they are not copied to new users. Deleting a front-end user revokes
their logins and removes profile ownership, but retains the browser data on disk. Treat retained data
and backups as sensitive even when the corresponding user no longer exists.

Each browser configuration uses its own Chrome process and profile directory, but these processes
run as the same browser UID in the same container. This is application-level separation, not separate
VMs or a hardened boundary against malicious tenants. Administrators and host operators remain
trusted, and all users share CPU, memory, disk and the global session capacity.

All Chrome processes, including the legacy default configuration, start on demand and close after
120 seconds without an assigned session. Closing a process retains its persistent profile. Each
session runtime has a fresh random asset-token key. Asset routes resolve that active key and use the
sealed token as the cache namespace, so reusing a session slot cannot reveal another runtime's cached
content. Resource requests are rejected if the runtime disappears or its key changes while work is
pending; stylesheet child-resource tokens use the same runtime key.

### The reconstructed DOM is inert, not sanitized

The replay iframe allows `allow-same-origin` and `allow-scripts` for replay interaction, while its
inherited CSP sets `script-src 'none'` and blocks visited-site JavaScript and inline handlers.
The sandbox omits forms, popups, top navigation and direct downloads. Local defaults that would
navigate or fetch are cancelled.

### Optional CPA has separate credentials

CPA's inference key, management key and OAuth credentials are separate from front-end user logins
and browser profiles. Its management page is publicly loadable, while configuration and credential
APIs require the management key. Native OAuth callback routes use their pending OAuth state/PKCE
flow instead of a management bearer key. The inference key does not grant management access.

The CPA process only joins an internal network. A separate, unprivileged Xray service handles its
outbound traffic and forwards the two host-loopback ports without changing their authentication.
The SOCKS destination filter blocks private addresses and `EGRESS_BLOCK`; the SOCKS listener has
no host port mapping. Proxy failure does not give CPA a direct internet route. The OAuth and config
volumes contain credentials and must receive the same backup protection as browser profiles.

However, markup, SVG, CSS, fonts, and browser parsing behavior still cross into the viewer origin.
They are not passed through a general sanitizer or transcoder. This is a different boundary from
pixel-only RBI, where the viewer receives pixels and input coordinates. A browser vulnerability in
markup/style/font processing, a containment bug, or an application bug could affect the viewer.
Use pixel-only technology when adversarial content-to-viewer isolation is the primary goal.

### Docker control is host control

Anyone who can control the Docker daemon can inspect environment secrets, profile volumes,
downloads, and process state. The gateway does not mount the Docker socket in the supported
Compose deployment.

## Implemented controls

- no built-in administrator password; initial credentials are supplied by the operator;
- salted scrypt password hashes, constant-time hash comparison and bounded login concurrency/backoff;
- 60-day opaque login tokens, with only SHA-256 token digests persisted in SQLite;
- Secure, HttpOnly, SameSite login cookies and signed device/session ownership cookies;
- individual users, administrator-only user management and per-user browser profile ownership;
- login revocation on password/role changes, disabling and deletion;
- authorization on WebSocket upgrade and asset/upload/download routes;
- one active driver per remote session with server-side enforcement;
- rrweb masking of password values;
- runtime-scoped sealed asset tokens, isolated cache keys and resolution-time private-address rejection;
- one-time download redemption;
- viewer-scoped WebRTC signaling with size/type checks;
- unprivileged Chromium container and private, unpublished CDP;
- Chromium sandbox retained with the Docker capability needed to create nested namespaces;
- scriptless replay iframe and local navigation-default containment;
- browser-facing CSP, anti-framing, MIME-sniffing, referrer, and permissions headers;
- bounded viewer backpressure and snapshot-based resync;
- configurable global session capacity and memory-based session admission.

## Important limitations

- Front-end authentication does not provide MFA, SSO or a durable audit trail.
- Browser profiles are separated within one shared container and system UID.
- Egress denial depends on the supported entrypoint, Docker capabilities and correct host addresses.
- Signing secrets supplied as Compose environment variables are visible to Docker administrators.
- The Chromium container receives the broad `SYS_ADMIN` capability for namespace sandboxing.
- Downloads are not malware-scanned.
- Persistent profiles store high-value cookies and credentials.
- There is no claim of resistance to malicious authenticated viewers or cross-user browser exploits.
- Admission checks do not provide per-user resource quotas or distributed rate limiting.
- SQLite front-end login tokens are not revoked by rotating the legacy signing secrets.

## Deployment checklist

- Use HTTPS and keep the upstream gateway on loopback or a private proxy network.
- Set a unique bootstrap administrator password and two independent stable signing secrets.
- Confirm port 9222 has no host mapping.
- Install and test a browser egress policy.
- Restrict and encrypt backups of profiles, SQLite, WAL files and management metadata.
- Stop the service when taking or restoring a full-volume backup so ownership and profile data agree.
- Manage user access in the administrator UI; changing the bootstrap environment does not reset users.
- Place the host on a dedicated VM or machine when browsing hostile sites.
- Review logs and resource usage; update dependencies and images.
- Never enable `MIRROR_E2E` outside a test process.

## Reporting vulnerabilities

Follow [SECURITY.md](../SECURITY.md). Do not include cookies, tokens, private URLs, captured page
content, or browser profiles in a report.
