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

The server image also carries an unmodified [sing-box](https://github.com/SagerNet/sing-box) release
binary (version in `deploy/fetch-sing-box.mjs`), which carries traffic to an outside proxy when
`EGRESS_PROXY` is set. It is a separate program, licensed GPL-3.0-or-later; its notice is in the
image at `/usr/share/doc/sing-box/LICENSE`, the license text at `/usr/share/common-licenses/GPL-3`,
and its source is the matching tag of the project's repository.

The Chromium container installs Debian's `chromium` package and its transitive system libraries.
Chromium is primarily BSD-licensed and incorporates third-party components under additional
permissive and weak-copyleft licenses; Debian package copyright files are included in the image
under `/usr/share/doc`.

This summary is provided for convenience and is not a substitute for the dependency packages'
license texts. Re-run `pnpm licenses list --prod` and inspect Debian package copyright metadata
when dependencies or base images change.
