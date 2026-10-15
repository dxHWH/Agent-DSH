# scripts/diagnostics

One-off diagnostic, reproduction, and probe scripts written while chasing
specific failures (directory picker, asar spawn, packaged boot, missing peer
packages, …). They are **not** wired into `npm run` and are kept only as
evidence referenced from `docs/*.md`.

Run them from the project root, e.g. `npx electron scripts/diagnostics/<name>.mjs`.
Each script derives the project root from its own location, so paths such as
`desktop-profile/` and `dist/main/` still resolve correctly.

中文：排障时写的一次性诊断 / 复现 / 探测脚本，未接入 `npm run`，仅作为
`docs/*.md` 中引用的证据保留。请在项目根目录下运行。
