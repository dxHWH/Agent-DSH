# 06 · 构建、打包、发布

## 1. 构建链（`npm run build`）

```
（顺序：先编两个本地插件，再编主进程——src/main/index-manager.ts 与 index-rebuild-worker.ts 需要
  dsh-tool-example 的 lib/*.d.ts，全新克隆时若先编主进程会报 TS2307。）
build:example           cd packages/dsh-tool-example && tsc            src → lib/（含 .d.ts）
build:feedback-archive  cd packages/dsh-tool-feedback-archive && tsc && tsdown && node ../../scripts/verify-archive-client.mjs
                          tsc   : src/*.ts   → lib/*.js（host 半）
                          tsdown: src/client.tsx → lib/client.js（浏览器半，__ModuleLoader__ 包装）
                          verify: client.js 只允许 require 平台共享模块
build:main              tsc -p tsconfig.json            src/**/*.ts        → dist/main/*.js (+map)   ESM
build:preload           tsc -p tsconfig.preload.json    src/preload/*.ts   → dist/preload/settings.js  CJS
build:assets            node scripts/copy-assets.mjs    src/settings/index.html → dist/settings/；settings.js → settings.cjs
```

> `build:main` 的 `rootDir: src` 也会把 `src/preload/settings.ts` 编进 `dist/preload/`（ESM 版），随后被 `build:preload` 的 CJS 输出覆盖，再被 copy-assets 改名为 `.cjs`。顺序不能乱。

## 2. 打包链

| 命令 | 做什么 | 输出 |
|---|---|---|
| `npm run dist:dir` | build + electron-builder `--win --dir` | `release/win-unpacked/` |
| `npm run dist` | build + electron-builder `--win`（NSIS） + **postdist** 两个审计 | `release/Agent Desktop Setup <版本>.exe` + `win-unpacked/` |
| `npm run bundle:portable` | `dist:dir` + 汇总 + 校验 | `release/Agent-Desktop-portable-<version>-<yyyymmdd>/` |
| `node scripts/bundle-portable.mjs --skip-build` | 只用现有 win-unpacked 汇总 | 同上 |

electron-builder 关键配置（`electron-builder.config.cjs`，每段都有注释，改前必读）：

| 配置 | 作用 |
|---|---|
| `appId` / `productName` / `executableName` | `com.agent.desktop` / `Agent Desktop` / `Agent Desktop` |
| `files` | 只打 `dist/**` + `package.json` + 生产依赖；排除 map/md/test |
| `asarUnpack` | 原生二进制、`node_modules/@deepseek-ai/**`、索引 worker、`EXAMPLE_RUNTIME_DEPS` |
| `extraResources` | `desktop-profile`、`icon.png`、`agent-preset`、`model-preset`、**DSH 树副本 + 普通依赖** → `desktop-profile/node_modules`、本地插件运行时依赖 |
| `extraFiles` | `wecom-auth.cmd` 放在 exe 旁 |
| `electronFuses.onlyLoadAppFromAsar: false` | 允许从 unpacked 目录加载代码 |
| `npmRebuild: false` | 不重编原生模块（使用预编译） |
| `afterPack: scripts/after-pack.cjs` | 把 profile 里的 Junction 实体化；还有任何链接就让构建失败 |
| 签名 | 未配置，产物未签名 |

> wecom-cli **默认不随包分发**。如需让免安装包开箱即用企业微信后端，打包者可手动把 `wecom-cli.exe` 放到 `resources/wecom-cli/`，运行时会被识别。

`bundle-portable.mjs` 的校验：无符号链接；预设模板 / `desktop-profile` / `wecom-auth.cmd` 里没有开发机路径；文档相对链接可解析；本地插件可从 profile 解析。

## 3. 发布物

- **推荐分发方式**：把 `release\Agent-Desktop-portable-<版本>-<日期>\` 整个文件夹压缩后分发。
- 用户文档 = `docs/user-guide.md`、`docs/feedback-archive.md`（脚本自动复制到汇总包）。改用户可见行为时**同步改这两份**。
- 升级：用户退出旧版（Ctrl+Q），用新文件夹整体替换旧程序文件夹即可；数据在 `%APPDATA%\Agent Desktop\dsh-home`，不受影响（portable 模式的用户要保留 `dsh-data\` 和 `desktop-shell.json`）。

## 4. 发版清单

1. `git status` 干净；改 `package.json` `version`（同时影响汇总包目录名）。
2. 如有 DSH/依赖变化：`npm ci`（如使用品牌补丁再 `npm run brand`）。
3. `npm run selfcheck`。
4. `npm run bundle:portable`。
5. `npm run verify:packaged-packages`、`npm run verify:profile-deps`、`npm run verify:packaged-preset-repair`、（可选）`npm run verify:packaged-ui`。
6. `scripts\launch-fresh-test.ps1 -TestRoot D:\AgentDesktop-Test` 走一遍：首次启动 → 配 Key → 绑工程 → 建索引 → 提问 → 点踩归档（本地后端）。
7. `git tag v<版本>`；压缩汇总包分发；记录变更。

## 5. 体积参考

| 项 | 数量级 |
|---|---|
| `node_modules` | ~0.6–0.7 GB |
| 汇总包 | ~0.5–0.6 GB / 1.5 万余个文件 |
| 压缩后 zip | ~0.2 GB |
