# Third-party notices

Remote Browser source is licensed under Apache License 2.0. Direct dependencies are installed
from the lockfile and remain under their own terms. Their license files are retained inside the
installed packages and production image.

The MVP dependency review found the following major direct dependency families:

| Component                                           | Declared license |
| --------------------------------------------------- | ---------------- |
| Fastify and `@fastify/static`                       | MIT              |
| Preact and `@preact/preset-vite`                    | MIT              |
| rrweb record/replay/types and canvas WebRTC plugins | MIT              |
| Puppeteer Core                                      | Apache-2.0       |
| Dockerode                                           | Apache-2.0       |
| Undici                                              | MIT              |
| ws                                                  | MIT              |
| Vite, Vitest, and tsx                               | MIT              |
| TypeScript and Playwright                           | Apache-2.0       |
| esbuild and Prettier                                | MIT              |

The server image also carries an unmodified [Xray-core](https://github.com/XTLS/Xray-core) release
binary (version in `deploy/fetch-xray.mjs`), which carries traffic to an outside proxy when
`EGRESS_PROXY` is set. It is a separate program, licensed MPL-2.0; its license is retained in the
image at `/usr/share/doc/xray/LICENSE`, and its source is the matching tag of the project's repository.

The server also includes the unmodified [Mihomo v1.19.34](https://github.com/MetaCubeX/mihomo/tree/v1.19.34)
executable for optional per-profile exits. Mihomo is a separate GPL-3.0 program; its license is
retained in `deploy/mihomo.LICENSE` and `/usr/share/doc/mihomo/LICENSE` in the image. The matching
source is available at the linked upstream tag. The archive digests are pinned in
`deploy/fetch-mihomo.mjs`.

The Chromium container installs Debian's `chromium` package and its transitive system libraries.
Chromium is primarily BSD-licensed and incorporates third-party components under additional
permissive and weak-copyleft licenses; Debian package copyright files are included in the image
under `/usr/share/doc`.

This summary is provided for convenience and is not a substitute for the dependency packages'
license texts. Re-run `pnpm licenses list --prod` and inspect Debian package copyright metadata
when dependencies or base images change.

The optional CPA image carries the unmodified [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
8.0.68 executable, copied from the upstream image pinned by digest in `deploy/Dockerfile.cpa`.
It is MIT-licensed; its license is retained in `deploy/cpa.LICENSE` and in the image at
`/usr/share/doc/cliproxyapi/LICENSE`. The optional Xray sidecar retains Xray's MPL-2.0 license as
described above. The management panel is downloaded from the upstream
[Management Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center) on first
access and kept in a separate volume. Its source and license remain with that upstream project.
