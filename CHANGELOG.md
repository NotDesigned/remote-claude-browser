# Changelog

Notable changes to Remote Browser are recorded here.

## [Unreleased]

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
