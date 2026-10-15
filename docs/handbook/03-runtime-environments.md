# 03 · 运行态与环境差异

同一份代码存在 **5 种运行形态**。绝大多数"在我这能跑、在别处不行"的问题，都来自它们之间的路径差异。

## 1. 五种形态一览

| 形态 | 怎么得到 | 怎么启动 | `app.isPackaged` | 谁会用 |
|---|---|---|---|---|
| **A. 源码开发态** | `git clone` + `npm ci` | `npm start`（= build + `electron .`） | `false` | 开发者 |
| **B. 打包目录态** `release/win-unpacked/` | `npm run dist:dir` | 双击 `release\win-unpacked\Agent Desktop.exe` | `true` | 开发者验包 |
| **C. 免安装汇总包** `release/Agent-Desktop-portable-<版本>-<日期>/` | `npm run bundle:portable` | `Agent Desktop\Agent Desktop.exe` | `true` | 主要分发形态 |
| **D. NSIS 安装包** `release/Agent Desktop Setup <版本>.exe` | `npm run dist` | 安装后从开始菜单启动 | `true` | 可选分发方式 |
| **E. 纯 `dsh web`**（不经过本项目） | `npm i -g @deepseek-ai/dsh` | `dsh web` → 浏览器 `http://127.0.0.1:3080` | — | 对照组（功能对等性比较），不含桌面补丁、设置窗口 |

C 与 B 的程序文件**完全相同**（C = B 的去链接副本 + 用户文档 + 说明文件，并删除了 `desktop-shell.json`、`dsh-data`）。D 安装后的目录结构也与 B 相同。

## 2. 路径解析差异（核心）

| 资源 | 源码开发态（A） | 打包态（B/C/D） | 代码位置 |
|---|---|---|---|
| 主进程代码 | `<仓库>/dist/main/*.js` | `resources/app.asar/dist/main/*.js` | `package.json` `main` |
| DSH 包 | `<仓库>/node_modules/@deepseek-ai/*` | `resources/app.asar.unpacked/node_modules/@deepseek-ai/*`（host.ts 把 `app.asar\` 重写成 `app.asar.unpacked\`） | `host.ts` `useUnpackedDshTree` |
| DSH profile | `<仓库>/desktop-profile/` | `resources/desktop-profile/`（**其中还有一整份 `node_modules/@deepseek-ai` + 普通依赖**，供 `createRequire(profileDir)` 解析） | `index.ts` `profileDir()` |
| 项目预设模板 | `<仓库>/assets/agent-preset/project/` | `resources/agent-preset/project/` | `agent-preset.ts` |
| 模型种子 | `<仓库>/assets/model-preset/models.yaml` | `resources/model-preset/models.yaml` | `model-preset.ts` |
| 托盘图标 | `<仓库>/assets/icon.png` | `resources/icon.png` | `tray.ts` |
| 设置窗口 HTML / preload | `<仓库>/dist/settings/index.html`、`dist/preload/settings.cjs` | asar 内同路径 | `settings.ts` |
| 索引重建 worker | `<仓库>/dist/main/index-rebuild-worker.js` | `app.asar.unpacked/dist/main/…`（`new Worker` 读不了 asar） | `index-manager.ts` `unpackAsarPath` |
| 本地插件的 npm 依赖 | 根 `node_modules/<dep>` | `app.asar.unpacked/node_modules/<dep>` **和** `desktop-profile/node_modules/<dep>` | `electron-builder.config.cjs` `EXAMPLE_RUNTIME_DEPS`（目前为空） |
| wecom-cli（可选） | settings 指定 / `WECOM_CLI` / `%APPDATA%\npm\wecom-cli.cmd` | 同左；打包者手动放入的 `resources/wecom-cli/wecom-cli.exe` 也会被识别 | `wecom.ts`、`upload.ts` |
| `desktop-shell.json` | `<仓库>/desktop-shell.json` | `<exe 目录>/desktop-shell.json` | `paths.ts` |
| portable 数据根 | `<仓库>/dsh-data/dsh-home` | `<exe 目录>/dsh-data/dsh-home` | `paths.ts` |
| **默认数据根（userdata）** | `%APPDATA%\Agent Desktop\dsh-home`（**与打包版共用！**） | `%APPDATA%\Agent Desktop\dsh-home` | `paths.ts` |

> ⚠️ **开发态和已安装的 Agent Desktop 默认使用同一个数据根**，而且有单实例锁——两个不能同时开。
> 想隔离：`npx electron . --user-data-dir=D:\tmp\agent-dev`（数据根变为 `D:\tmp\agent-dev\dsh-home`，且不会触发旧数据迁移），
> 或用 `scripts/launch-fresh-test.ps1` 测打包版。

## 3. 数据根 4 种模式

在设置窗口「数据存放位置」切换，写入 `desktop-shell.json`，**重启生效**（DSH 在 import 时解析 home）。

| 模式 | 数据根 | 用途 |
|---|---|---|
| `userdata`（默认，无 desktop-shell.json 时） | `%APPDATA%\Agent Desktop\dsh-home` | 常规 |
| `portable` | `<exe 目录>\dsh-data\dsh-home` | U 盘 / 整夹拷贝 |
| `custom` | 任意目录 | 同步盘 |
| `env` | `$DSH_HOME` | 脚本 / CI；未设置则回落 userdata |

`--user-data-dir=X` 会把 userdata 模式下的数据根改为 `X\dsh-home`。

## 4. 首次启动 vs 再次启动

| 动作 | 触发条件 | 已有数据时 |
|---|---|---|
| 旧产品名数据迁移 | userdata 模式、新根不存在、且没用 `--user-data-dir` | 不动 |
| 语言 `zh` | `settings.yaml` 不存在 | 不动（尊重 `en`） |
| 模型种子 | `settings.yaml` 缺 `agent-default-model` 等顶层段 | 缺哪段补哪段，已有段不动 |
| 项目预设安装 | `<根>/.agent-presets/project/agent.cordis.yml` 不存在 | 不覆盖 |
| 悬空默认预设修复 | 每次启动，`agent-presets.default` 指向不存在的预设时 | 合法值不动 |
| API Key 引导弹窗 | DSH onboarding 状态未完成 | — |

**推论：改了 `assets/agent-preset` 或 `models.yaml` 之后，已安装用户不会自动拿到新版本。** 需要用户删掉 `<数据根>\.agent-presets\project\` 后重启，或写定向迁移（见 [05-maintenance.md](05-maintenance.md) §2.3）。

## 5. 开发态独有 / 打包态独有的能力

| 能力 | 开发态 | 打包态 |
|---|---|---|
| 改 `src/` 后生效 | `npm start`（重新编译 + 重启 Electron） | 需重新打包 |
| 改 `packages/*` 后生效 | `npm run build:example` / `build:feedback-archive` + 重启（Junction 直通，无需重装） | 需重新打包 |
| 改 `<数据根>/.agent-presets/project/agent.cordis.yml` | 重启生效 | 重启生效（用户机上也可以直接改） |
| 改 `desktop-profile/cordis.patch.yml` | 重启生效 | 可改 `resources/desktop-profile/cordis.patch.yml` 后重启 |
| DevTools | 菜单 View → Toggle Developer Tools（菜单栏默认隐藏，按 Alt 显示） | 同左 |
| 控制台日志 `[dsh-desktop] …` | 启动终端里直接看 | 需从命令行启动 exe 才能看到 stdout |
| 客户端插件热重载（HMR） | ❌（需要 `--expose-internals`，Electron 不支持） | ❌ |
| 端口 | OS 随机分配（设置 → 诊断信息 可见） | 同左 |

## 6. 与 `dsh web`（形态 E）的区别

| 项 | dsh web | Agent Desktop |
|---|---|---|
| 进程 | 独立 CLI | Electron 主进程内 |
| 端口 | 默认 3080 | 0（随机） |
| profile | `$DSH_HOME/profiles/<名>` | 应用自带 `desktop-profile/`（`desktop` 名被 CLI 保留，`dsh plugin --profile desktop` 会被拒绝） |
| 目录选择器 | 原生 Win32 对话框 | 应用内浏览选择器（cordis.patch.yml） |
| 点赞点踩 | DSH 原版 | feedback-archive 替换（点踩 = 归档） |
| 首次引导 | DSH 原版（含声明步骤） | 精简为只问 `DEEPSEEK_API_KEY` |
| 其余 entry | 完全一致（`npm run audit:capabilities` 验证） | |

## 7. Node 环境差异

| 场景 | 用哪个 Node |
|---|---|
| Electron 主进程、DSH、示例工具、索引 worker | Electron 内置 Node 22.21（不依赖系统 Node） |
| `npm run build`、`node scripts/*.mjs`、`packages/dsh-tool-example/test/*.mjs` | **系统 Node ≥ 22**（需 `node:sqlite`） |
| 知识库 MCP（`mcp-remote`） | **系统 Node**（`agent-preset.ts` 探测 `%ProgramFiles%\nodejs\node.exe`、PATH 等） |
| wecom-cli | 原生 exe 或 npm 全局 shim |

最终用户机器上**只有知识库 MCP（可选）需要装 Node**，其余全部开箱即用。
