# 02 · 目录结构（逐目录 / 逐文件）

图例：**[源]** 手写源码，需维护、进 git · **[配]** 配置/数据，进 git · **[生]** 生成物，不进 git，可随时重建 · **[外]** 外部安装，不进 git · **[证]** 研究/排障证据，不参与运行

```
<仓库根>/
├── AGENTS.md                     [源] 给 AI 编程助手看的硬规则（会被自动注入）
├── package.json                  [配] 依赖、npm scripts、name=agent-desktop、productName=Agent Desktop
├── package-lock.json             [配] 依赖锁（必须提交；换机用 npm ci）
├── electron-builder.config.cjs   [配] ★打包配置：asarUnpack / extraResources / afterPack / fuses / EXAMPLE_RUNTIME_DEPS
├── tsconfig.json                 [配] 主进程编译：src/**/*.ts → dist/（ESM，ES2022）
├── tsconfig.preload.json         [配] preload 编译：src/preload → dist/preload（CommonJS）
├── .gitignore / .gitattributes   [配] 忽略生成物；全仓 LF，*.cmd/*.bat 保持 CRLF
├── README.md / README.zh.md      [源] 项目说明
├── PLAN-desktop-client*.md       [证] 原始计划与架构决策（产品名写作 DSH Desktop）
│
├── src/                          [源] Electron 壳层
│   ├── main/                     主进程（ESM）
│   ├── preload/settings.ts       设置窗口的 contextBridge → window.dshShell
│   └── settings/index.html       设置窗口 UI（单文件 HTML+JS，无框架，中文）
│
├── packages/                     [源] 两个本地 DSH 插件（以 file: 依赖 + Junction 链接进 node_modules）
│   ├── dsh-tool-example/         示例领域工具（host 插件）
│   └── dsh-tool-feedback-archive/ 点踩归档 + 首次引导（host 半 + client 半）
│
├── desktop-profile/              [配] 桌面端自有的 DSH profile（打包时整体拷到 resources/）
│   ├── package.json              声明 bundles: dsh-base + dsh-web-app
│   ├── cordis.patch.yml          ★桌面补丁层：禁用原生目录选择器，换成应用内浏览选择器
│   ├── cordis.yml                每次启动被重写成 []（不要手改）
│   └── pnpm-workspace.yaml       DSH initProfile 生成，无实际作用
│
├── assets/                       [配] 随包资源
│   ├── agent-preset/project/     ★项目模式预设模板（含占位符，首次启动安装到数据根）
│   │   ├── preset.yml            显示名「项目模式」、描述、排序
│   │   └── agent.cordis.yml      项目 Agent 的完整组成（工具、MCP、子代理、压缩…）
│   ├── model-preset/models.yaml  ★首次启动写入 settings.yaml 的模型种子（无密钥）
│   ├── wecom-auth.cmd            放在 exe 旁的命令行企业微信授权脚本（CRLF！）
│   └── icon.ico / icon.png       中性应用图标、托盘图标（npm run icon 生成）
│
├── scripts/                      [源/证] 构建、打包、自检、审计脚本（详见 07-testing.md）
│   ├── copy-assets.mjs           build:assets：拷 settings/index.html，preload .js→.cjs
│   ├── after-pack.cjs            ★electron-builder afterPack：把 Junction 实体化，残留链接则构建失败
│   ├── bundle-portable.mjs       ★生成「免安装版 + 文档」汇总文件夹并做校验
│   ├── replace-brand-wordmark.mjs / replace-hero.mjs   就地改 node_modules 里的 DSH 前端（可选品牌）
│   ├── make-icon.mjs             生成中性图标
│   ├── verify-archive-client.mjs ★client.js 只允许 require 平台共享模块
│   ├── launch-fresh-test.ps1     在隔离目录模拟新机器首次启动
│   ├── selfcheck-*.mjs / verify-*.mjs / audit-*.mjs / experiment-*.mjs
│   ├── archive-dsh-session.mjs   命令行端到端测试归档（读→转→打包→保存/上传）
│   └── diagnostics/              [证] 一次性排障脚本（不接入 npm run）
│
├── docs/                         [源] 文档（handbook/ 为开发者手册）
│
├── dist/                         [生] npm run build 输出（主进程 JS、preload .cjs、settings html）
├── packages/*/lib/               [生] 两个插件的编译输出（tsc / tsdown）
├── node_modules/                 [外] npm 安装（含 2 个 Junction；执行 brand 后还有 2 处品牌补丁）
├── release/                      [生] 打包输出：win-unpacked/、Agent-Desktop-portable-<版本>-<日期>/
├── data/reports/                 [生] 在仓库里跑示例工具时产出的报告
└── dsh-data/ / desktop-shell.json [生] 开发态如果切到 portable 模式会出现在仓库根（勿提交）
```

## 1. `src/main/` 逐文件

| 文件 | 职责 | 改它的典型场景 |
|---|---|---|
| `index.ts` | 入口。单实例锁 → 权限加固 → 菜单 → 注册设置 IPC → `bootstrap()`：`applyDataRoot()`（设 `DSH_HOME`、播种 locale/模型/项目预设）→ 动态 `import('./host.js')` → `startHost()` → 修复悬空默认预设 → 建窗口 → 托盘。还负责关窗即隐藏到托盘、清理旧 `dsh-auth-*` Cookie（防 HTTP 431）、外链用系统浏览器、启动失败页 | 改窗口行为、菜单、启动顺序 |
| `host.ts` | ★**唯一允许 `import '@deepseek-ai/*'` 的文件**。`startHost()`：解析 DSH 安装锚点（asar→unpacked 重写，`useUnpackedDshTree`）、`ensureProfile`、`loadProfileDirectory`、合并补丁、`boot()`、`provideCmdline`、读端口与鉴权 URL。`buildDesktopPatches()`：关闭自动开浏览器、插入 `tool-feedback-archive`、禁用 DSH 原生 `ui-message-feedback` | 升级 DSH、给 host 平面加/禁插件 |
| `paths.ts` | 数据根解析（4 种模式）、`desktop-shell.json` 读写、旧产品名数据一次性迁移 | 改数据位置策略 |
| `locale.ts` | 仅当 settings.yaml 不存在时追加 `locale: preference: zh` | 改默认语言 |
| `model-preset.ts` | 把 `models.yaml` 中 settings.yaml **缺少的顶层段**追加进去（已有段绝不覆盖） | 改模型种子逻辑 |
| `agent-preset.ts` | 首次启动把 `assets/agent-preset/project` 装到 `<数据根>/.agent-presets/project/`，替换 4 个占位符；已存在则不覆盖 | 改预设安装/升级策略 |
| `presets.ts` | `agent-presets.default` 指向不存在的预设时改回可用值（否则"选择工作区没反应"） | 一般不动 |
| `settings.ts` | 设置窗口 + 全部 `shell:*` IPC：数据根、打开目录、重启、MCP 增删改测、工程目录、索引状态/重建/取消、企业微信授权 | 设置窗口加功能 |
| `mcp.ts` | **文本级**解析/改写 `agent.cordis.yml` 中的 `dsh-mcp-client` 行与 `tool-example` 的 `projectRoot`（保留注释与 `!!js`）；用 JSON-RPC 测试 Streamable HTTP MCP | 改 MCP 编辑逻辑 |
| `index-manager.ts` | 查询索引状态与重建：每工程一个 worker、进度节流 150ms、可取消、worker 崩溃也能收尾、回收孤儿锁；懒加载 `@deepseek-ai/dsh-tool-example`（host.ts 纪律的唯一例外：本地包） | 改索引 UI 行为 |
| `index-rebuild-worker.ts` | worker 线程入口：`{type:'rebuild', projectRoot}` → 进度/完成消息 | 一般不动 |
| `wecom.ts` | 企业微信授权：在临时目录用 node-pty 驱动 `wecom-cli auth init`，验证成功才把凭证拷进正式目录 | 改授权流程 |
| `tray.ts` | 托盘（Show / Settings… / Quit），首次隐藏时提示一次 | 改托盘菜单 |
| `window-state.ts` | 记住窗口尺寸位置（`<userData>/window-state.json`），防止窗口落在已拔掉的显示器上 | 一般不动 |

## 2. `packages/dsh-tool-example/`（示例领域工具）

```
dsh-tool-example/
├── package.json        name=@deepseek-ai/dsh-tool-example, main=lib/index.js, files: lib/** knowledge/**；无第三方 npm 依赖
├── tsconfig.json       src → lib（tsc，含 .d.ts，壳层的 index-manager 需要类型）
├── src/                [源]
├── knowledge/          [配] 随包分发的领域知识资产（示例为空，见其 README）
├── test/               [源] 验证脚本（在临时目录生成样例工程，不依赖真实业务工程）
└── lib/                [生]
```

| 源文件 | 职责 |
|---|---|
| `index.ts` | ★插件入口：`inject=['tools','systemPrompt']`，`Config{projectRoot, reportDir, kbQueryTool, extensions}`；注册系统提示 `example:tool-quickref` 与两个工具；所有工具经 `registerTool()`（= `withKbFallback`）注册；导出 `ProjectIndex`、`INDEX_DIR_NAME` |
| `result.ts` | 统一结果协议类型、`toOutput()`（不产生 `undefined` 键）、共享 output schema |
| `search.ts` | `example_search` 的实现：索引优先、扫描兜底、组装证据与报告 |
| `sources.ts` | 列出工程内的文本源文件（扩展名白名单、大小/数量上限、跳过 `.agent-index`） |
| `text.ts` | 归一化（NFKC、全半角、标点）、包装词剥离、分词（ASCII 词 + CJK bigram）、打分 |
| `kb_fallback.ts` | 判定"消极结果"，追加知识库兜底标记与指令 |
| `index_hint.ts` | 索引不可用时追加"去设置里重建"的提示 |
| `report_writer.ts` | 报告落盘（安全文件名、相对会话工作区） |
| `scoped_paths.ts` | 工程路径安全解析（拒绝绝对路径、`..`、symlink 逃逸） |
| `sqlite/schema.ts` | DDL、`SCHEMA_VERSION` / `BUILDER_VERSION`（任一变化触发重建）、完整性检查 |
| `sqlite/store.ts` | `node:sqlite` 连接（构建 / 只读查询）、校验、体积 |
| `sqlite/lifecycle.ts` | 代际文件 `generation-NNNNNN.sqlite3` + `current.json` 原子切换、旧代清理 |
| `sqlite/locking.ts` | `build.lock`（pid 锁，死进程锁可回收） |
| `sqlite/fingerprint.ts` | stat 快指纹 + SHA-256 内容摘要 |
| `sqlite/builder.ts` | 构建：逐文件写 source_file / line / term / occurrence，进度回调 |
| `sqlite/query.ts` | 两阶段检索：term 召回 + 与扫描共享打分器的精确重排 |
| `sqlite/index.ts` | `ProjectIndex`：`status()`（missing/building/ready/stale/error）、`openForQuery()`（从不构建）、`rebuild()` |

## 3. `packages/dsh-tool-feedback-archive/`（点踩归档 + 首次引导）

| 文件 | 平面 | 职责 |
|---|---|---|
| `src/index.ts` | host（Node） | 注册 settings 命名空间 `feedback-archive`（backend / localDir / wecomCliPath / rootFolderId / rootName）与 HTTP 路由 `POST /api/feedback-archive` |
| `src/session-read.ts` | host | 解多帧 zstd 的 `.jsonl.zstd` 会话日志 |
| `src/convert.ts` / `types.ts` | host | 事件流 → turn 结构（提问 / 回答 / 工具调用 / usage） |
| `src/zip.ts` | host | fflate 打包 + `feedback.md` |
| `src/upload.ts` | host | wecom 后端：找 wecom-cli 并上传到 `<rootName>/<模式>/<日期>/` |
| `src/archive.ts` | host | 编排 读 → 转 → 包 → 保存/上传 |
| `src/client.tsx` | 浏览器 | 替换 DSH 原生 Like/Dislike（slot `conversation.chat.assistant-actions`）+ 反馈弹窗 |
| `src/onboarding.tsx` | 浏览器 | 首次引导：shadow DSH 自带 `deepseek-official` 步骤，写 `DEEPSEEK_API_KEY` |
| `tsdown.config.ts` | 构建 | client 半打成 `window.__ModuleLoader__.load` 格式，**`deps.neverBundle: true`** |
| `package.json` 的 `dsh.client` | 声明 | 告诉 DSH 这个包有浏览器端 `lib/client.js`，以及它 inject 的 client 模块 |

## 4. 运行时会出现的目录（不在仓库里）

| 位置 | 内容 |
|---|---|
| `%APPDATA%\Agent Desktop\` | Electron userData：Chromium 缓存、`window-state.json`、`dsh-home\`（默认数据根） |
| `<数据根>\settings.yaml` | DSH 全部设置（模型、默认预设、语言、权限、`feedback-archive`…） |
| `<数据根>\.credentials.yaml` | 密钥（`DEEPSEEK_API_KEY` 等），**绝不要提交或打包** |
| `<数据根>\.agent-presets\project\` | 已安装的项目模式预设（用户改动以这里为准，模板更新**不会**自动覆盖） |
| `<数据根>\sessions\`、`storages\`、`attachments\` | 会话历史与存储 |
| `<数据根>\feedback-archive\` | 点踩归档本地后端的默认目录 |
| `<工程>\.agent-index\` | SQLite 查询索引（`current.json` + 代际 db + `build.lock`） |
| `<会话工作区>\data\reports\` | 示例工具生成的报告 |
| `%USERPROFILE%\.config\wecom\` | wecom-cli 加密凭证（仅 wecom 后端） |
| `%USERPROFILE%\.mcp-auth\` | mcp-remote OAuth 令牌（仅知识库 MCP） |
| `<exe 目录>\desktop-shell.json` / `dsh-data\` | 数据位置指针 / portable 模式数据 |

## 5. `node_modules` 里被"就地修改"的东西

| 位置 | 修改者 | 说明 |
|---|---|---|
| `node_modules/@deepseek-ai/dsh-tool-example` → `packages/dsh-tool-example` | npm（file: 依赖） | **目录联接 Junction**。打包时由 `after-pack.cjs` 实体化 |
| `node_modules/@deepseek-ai/dsh-tool-feedback-archive` → `packages/dsh-tool-feedback-archive` | npm | 同上 |
| DSH 前端 bundle（`dsh-web-frontend/dist/assets/index-*.js`、`dsh-client-ui-conversation/lib/client.js`） | `npm run brand`（可选） | 顶栏 Logo / 首页标题 |

品牌补丁**不进 git**：重新 `npm ci` 后会被还原成 DSH 原版，需要时重跑 `npm run brand`（幂等；不跑也不影响功能）。
