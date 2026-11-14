# Changelog

Notable changes to Remote Browser are recorded here.

## [Unreleased]

- Choose a browser configuration before opening a new workspace, with remembered Claude emails, login status and unavailable accounts. Reopen the picker from the workspace menu to switch or return to the current session. Existing sessions still resume on reload.
- Rename configurations, choose a default per user, and delete non-default configurations directly in the picker.
- Give each browser account its own screen size, font subset and font rendering, so accounts no longer share one fingerprint. No canvas or audio noise is added.
- Launch Chromium with an explicit argument list instead of Puppeteer's defaults, whose disabled MediaRouter made fingerprint.com classify the browser as automation.
- Keep media SDP/ICE and PeerConnections in a private isolated world, removing the page-visible legacy frame signaling path.
- Isolate authenticated asset fallback HTTP/TLS pools per workspace, and destroy them on release or profile switch.
- Give managed headful browser configurations separate authenticated Xvfb displays and native clipboards, including scoped pixel capture.
- Keep native browser identity for phone viewers, isolate per-session screen geometry from the shared X display, and preserve native device, permission and EME APIs.

- Replace sing-box egress with checksum-pinned Xray, including VLESS Encryption, REALITY ML-DSA-65 verification and XHTTP. Browser-only TUN routing and fail-closed DNS/UDP forwarding remain enabled. Existing sing-box outbound JSON must be migrated to Xray JSON.

- The server is one container holding Xvfb, Chromium and the gateway, with its own firewall.
- `client/` deploys an entry host with HTTPS and an SSH tunnel; `compose.https.yml` does HTTPS on one machine.

## [0.1.0] - 2026-07-26

- First portable self-hosted release of the semantic DOM browser and scriptless viewer.
- Trusted CDP input across tabs, frames, shadow DOM, mobile text, IME, uploads, and downloads.
- Ordered snapshot/delta recovery with WebRTC media lanes and whole-tab pixel fallback.
- Loopback-first Docker Compose deployment with generated credentials and an ephemeral profile.
- Reproducible full-browser fidelity, OOPIF, media, security, and container acceptance gates.

[Unreleased]: https://github.com/mystxcal/remote-browser/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mystxcal/remote-browser/releases/tag/v0.1.0
