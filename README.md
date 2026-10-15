# Agent Desktop

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 Windows Electron 桌面客户端，附带一个可复用的"领域工具插件"骨架和点踩归档插件。

它在 Electron 主进程**内**启动 DSH 宿主，再让原生窗口加载返回的 loopback URL。DSH 自带的界面、工具与设置无需改动即可工作——不 fork 前端，也不重新实现通信协议。

> 给 AI 编程助手的工程说明见 [`AGENTS.md`](AGENTS.md)；开发者手册见 [`docs/handbook/`](docs/handbook/README.md)；用户手册见 [`docs/user-guide.md`](docs/user-guide.md)。

---

## 它能做什么

- **原生窗口 + 托盘常驻**：承载真正的 DSH 界面，关窗不结束会话。
- **复用 DSH 自身配置**：API Key、模型、会话全部由 DSH 读写，存放在数据根中；壳层不保留平行副本。
- **可迁移**：用户数据集中在一个文件夹，可整体拷贝到另一台机器（四种数据位置模式）。
- **项目模式**（一个 agent 预设）：标准编码 Agent + 示例领域工具 `example_search` / `example_index_status` + 可选的知识库 MCP 兜底。
- **查询索引**：示例工具可在 `<工程>/.agent-index/` 构建 SQLite 倒排索引；由设置窗口显式重建，查询路径从不建索引。
- **点踩归档**：在回答下点 👎，把该轮完整对话打包成 ZIP，默认保存到本地，可选上传到企业微信微盘。
- **首次启动引导**：只问一次 `DEEPSEEK_API_KEY`。
- **壳层设置窗口**：数据位置、MCP 服务器、工程目录、索引重建、企业微信机器人授权、诊断信息。

## 架构

```
Agent Desktop.exe（Electron 主进程，ESM）
├── index.ts         生命周期、窗口、托盘、菜单、单实例锁
├── paths.ts         解析数据根（userdata / portable / custom / env）→ process.env.DSH_HOME
├── locale.ts / model-preset.ts / agent-preset.ts   首次启动播种（只追加，不覆盖）
├── host.ts          ★唯一导入 @deepseek-ai/* 的模块：进程内 boot DSH（port 0）+ 桌面补丁
├── presets.ts       修复悬空的 agent-presets.default
├── settings.ts      设置窗口 + IPC（mcp.ts / index-manager.ts / wecom.ts）
└── tray.ts / window-state.ts
        │
        ▼
BrowserWindow ──加载──▶ http://127.0.0.1:<OS 分配的端口>/?token=...

DSH 宿主（同进程，profile = desktop-profile/）
├── host 平面：webserver、sessions、LLM 路由、tool-feedback-archive（host 半）…
├── agent 预设：standard / ptc / minimal / cordis（DSH 自带）+ project（本项目）
└── client 插件：DSH 自带 + dsh-tool-feedback-archive/client.js（点赞点踩 + 引导）
```

### 为什么用真实 HTTP URL 而不是 `file://`

DSH 前端 `dist` 是纯静态 SPA，没有编译进任何服务端地址：boot graph（`window.__DSH_BOOT__`）是提供服务时注入的。`file://` 加载会失败并报 `window.__ModuleLoader__ bootstrap facade is missing`（见 `docs/phase0-findings.zh.md`）。在 loopback 上提供服务后，`/api`、`/api/remote.mux` WebSocket、`/plugins/*` 全部原生可用。

### 非可选的硬性要求

| 要求 | 原因 |
|---|---|
| **Electron 37+**（Node 22+） | DSH 导入 `zlib.createZstdCompress`、`util.getSystemErrorMessage`、`module.stripTypeScriptTypes`；Electron 33 的 Node 20 会让插件树加载失败。 |
| **主进程必须是 ESM** | DSH 每个包都是 `"type": "module"`；CommonJS 会以 `ERR_REQUIRE_ESM` 失败。 |
| **挂载前调用 `provideCmdline`** | `dsh-web-app/startup` 注入 `cmdlineArgs`；缺少它会让 11 个 entry 永久 pending。 |
| **`DSH_HOME` 先于 DSH 导入设置** | DSH 在 import 时解析 home，所以 `host.ts` 必须动态 import。 |

## 快速开始（源码）

```powershell
npm ci
npm run build
npm start
```

需要 Windows 10/11 x64 与 Node 22+。npm 11 可能拦截安装脚本，批准后重装：

```powershell
npm install-scripts approve electron @deepseek-ai/dsh-subprocess-local koffi node-pty protobufjs @google/genai
npm ci
```

> 开发态与已安装的 Agent Desktop 默认共用 `%APPDATA%\Agent Desktop\dsh-home` 且单实例。隔离方式：`npx electron . --user-data-dir=D:\tmp\agent-dev`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run build` | 全量编译（两个本地插件 → 主进程 → preload → assets） |
| `npm start` | build + 启动 Electron |
| `npm run build:example` / `npm run build:feedback-archive` | 只编某个插件 |
| `npm run brand` | 可选：给 DSH 前端打品牌补丁（幂等，`npm ci` 后需重跑） |
| `npm run icon` | 重新生成中性图标 |
| `npm run selfcheck` / `npm run selfcheck:presets` | 自检 |
| `npm run dist:dir` | 打包到 `release/win-unpacked/` |
| `npm run bundle:portable` | 免安装版 + 用户文档 → `release/Agent-Desktop-portable-<ver>-<date>/` |
| `npm run verify:packaged-packages` / `npm run verify:profile-deps` | 打包审计 |

## 数据位置

| 模式 | 位置 | 适用场景 |
|---|---|---|
| `userdata`（默认） | `%APPDATA%\Agent Desktop\dsh-home` | 常规单机使用 |
| `portable` | exe 旁的 `dsh-data\dsh-home` | U 盘 / 整个文件夹拷走 |
| `custom` | 任意文件夹 | 同步盘、共享盘 |
| `env` | `$DSH_HOME` | 脚本、CI |

选择记录在 exe 旁的 `desktop-shell.json`（只是指针，不存数据），在设置窗口「数据存放位置」切换，重启生效。

## 模型与 API Key

首次启动写入 `assets/model-preset/models.yaml` 中的种子：默认 `deepseek-official / deepseek-v4-pro`，引导弹窗只问 `DEEPSEEK_API_KEY`（存入 `<数据根>\.credentials.yaml`）。想换 OpenAI 兼容网关，参考 `models.yaml` 里注释掉的 `llm-pi-ai` 示例，并同步 `onboarding.tsx` 的 `KEY_REF`。之后在**主窗口 → 设置 → 模型**中修改。

## 功能对等性与扩展

壳层运行的组合与 `dsh web` 相同（`npm run audit:capabilities` 验证 onlyInWeb / onlyInDesktop 为空，桌面补丁除外）。向桌面组合添加插件：

```yaml
# desktop-profile/cordis.patch.yml
- insert:
    - id: my-plugin
      name: '@scope/my-dsh-plugin'
```

裸写 `- id: ...` 只会**定位**已有行，不会新增；写错时静默失败。

## 文档

- [`docs/handbook/`](docs/handbook/README.md) — **开发者手册**（架构、目录、运行态差异、开发环境、维护、构建发布、测试、排障）
- [`docs/domain-tool-patterns.md`](docs/domain-tool-patterns.md) — **★ 领域工具工程模式**（结果协议、知识库兜底、SQLite 索引、路径安全……）
- [`docs/user-guide.md`](docs/user-guide.md) — 用户手册
- [`docs/feedback-archive.md`](docs/feedback-archive.md) — 点踩归档（本地 / 企业微信）
- `PLAN-desktop-client*.md` — 原始计划与架构决策
- 研究与根因分析（`docs/*.md` 英文，`docs/*.zh.md` 中文）：`phase0-findings`、`phase1-notes`、`capability-audit`、`agent-loop-customization`、`mode-switching`、`specialized-agent-summary`、`layering`、`agent-layer-mapping`、`self-maintenance`、`hot-update`、`do-you-need-hot-update`、`desktop-raw-dsh-iteration`、`replace-dsh-with-source`、`directory-picker-failure`、`dangling-preset-default`、`packaged-plugin-failure`、`packaged-peer-dependency-failure`、`packaged-profile-dependencies`、`dsh-desktop-subprocess-status`、`issue-dsh-desktop-subprocess-failure`、`index-benchmark`、`USAGE`

> 部分早期研究笔记仍使用旧名 "DSH Desktop"（本项目的前身代号），内容仍然有效。

## 已知限制

- **仅支持 Windows。**
- **没有自动更新**，内置 DSH 版本在打包时固定（`0.1.5-rc.2` 候选版）。
- **客户端插件热重载不可用**：DSH 的 HMR 需要 `--expose-internals`，Electron 主进程启动后无法追加。
- **构建未签名**，首次运行 SmartScreen 会警告。
