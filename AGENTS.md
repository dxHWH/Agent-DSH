# AGENTS.md — 给 AI 编程助手的工程说明（Agent Desktop）

> 本文件会被 DSH / 其它 AI 编程工具自动注入为项目指令。人类读者请从 `docs/handbook/README.md` 开始。
> 改动本仓库前先读这里；需要细节时按下方索引去读 `docs/handbook/0x-*.md`，不要凭猜测。

## 项目是什么
Windows-only Electron 37 桌面应用 **Agent Desktop**：在 Electron 主进程内启动 DeepSeek Harness（npm 包 `@deepseek-ai/*@0.1.5-rc.2`），窗口加载其 loopback Web UI；外加两个本地 DSH 插件（通用示例领域工具 `dsh-tool-example`、点踩归档 `dsh-tool-feedback-archive`）和一个"项目模式"agent 预设模板。

## 目录地图（只列需要改的）
- `src/main/*.ts` 主进程（ESM）。`host.ts`=DSH 启动适配；`index.ts`=生命周期；`paths.ts`=数据根；`settings.ts`+`mcp.ts`+`index-manager.ts`+`index-rebuild-worker.ts`+`wecom.ts`=设置窗口后端；`agent-preset.ts`/`model-preset.ts`/`locale.ts`/`presets.ts`=首次启动播种与修复；`tray.ts`/`window-state.ts`。
- `src/preload/settings.ts`（CJS，具名 API `window.dshShell`）、`src/settings/index.html`（设置窗口 UI）。
- `packages/dsh-tool-example/`：示例领域工具插件骨架（`example_search`、`example_index_status`）+ 统一结果协议 + 知识库兜底 + 系统提示 `example:tool-quickref` + SQLite 查询索引（`src/sqlite/`）。入口 `src/index.ts`。导出 `ProjectIndex` 给壳层。
- `packages/dsh-tool-feedback-archive/`：点踩归档（host 半 `src/index.ts` → `POST /api/feedback-archive`，settings 命名空间 `feedback-archive`；client 半 `src/client.tsx`）+ 首次 API Key 引导 `src/onboarding.tsx`。
- `assets/agent-preset/project/{agent.cordis.yml,preset.yml}`：项目模式预设模板（占位符 `__PROJECT_ROOT__` `__NODE_EXE__` `__MCP_REMOTE_PROXY__` `__MCP_AUTH_DIR__`）。
- `assets/model-preset/models.yaml`：首次启动模型种子（无密钥）。
- `desktop-profile/`：桌面 DSH profile；`cordis.patch.yml` 为补丁层。
- `electron-builder.config.cjs`、`scripts/after-pack.cjs`、`scripts/bundle-portable.mjs`：打包。
- 生成物（勿手改、勿提交）：`dist/`、`packages/*/lib/`、`release/`、`node_modules/`、`data/reports/`、`*-selfcheck.json`。

## 硬规则（违反会出真实故障）
1. **只有 `src/main/host.ts` 可以 `import '@deepseek-ai/*'`**（例外：`index-manager.ts` 懒加载本地包 `@deepseek-ai/dsh-tool-example`）。其它壳层模块只操作文件系统/Electron。
2. 壳层**不得**保存平行配置：API Key、模型、会话属于 DSH 数据根（`settings.yaml`、`.credentials.yaml`）。唯一壳层文件是 exe 旁的 `desktop-shell.json`（数据位置指针）。
3. `process.env.DSH_HOME` 必须在任何 DSH 模块导入前设置（`index.ts` `applyDataRoot()` 先于 `import('./host.js')`）。不要把 DSH 改成静态 import。
4. 首次启动播种只能**追加缺失内容**，绝不覆盖用户已有值（locale、模型段、预设目录）。
5. 编辑 `agent.cordis.yml` 一律**文本级**（保留注释和 `!!js`），不要用 YAML 库 round-trip。`mcp.ts` 依赖 `name: '@deepseek-ai/dsh-mcp-client'` 与 `tool-example` 行的文本格式。
6. cordis patch：新增行必须 `- insert: [...]`；裸 `- id:` 只定位已有行（写错会静默无效）；`config` 覆盖是整体替换。
7. 模板/打包资源中禁止出现本机绝对路径（`bundle-portable.mjs` 会校验失败）。
8. Windows 上**禁止在运行时代码中使用 `fs.cpSync`**（非 ASCII 路径会让 Electron 主进程崩溃）；用手写递归复制。
9. 打包态会 spawn/Worker 的文件必须在 `asarUnpack`，并把 `app.asar\` 路径重写为 `app.asar.unpacked\`（参照 `useUnpackedDshTree` / `unpackAsarPath`）。
10. 给 `dsh-tool-example`（或任何本地插件）加 npm 依赖时，必须把它与全部传递依赖加入 `electron-builder.config.cjs` 的 `EXAMPLE_RUNTIME_DEPS`（目前为空）。
11. 改 SQLite 索引结构/构建逻辑必须递增 `packages/dsh-tool-example/src/sqlite/schema.ts` 的 `SCHEMA_VERSION` 或 `BUILDER_VERSION`。**查询路径不得构建索引**，只有设置窗口"重建索引"会建。
12. `dsh-tool-feedback-archive` 的 client bundle 不得内联依赖（`tsdown.config.ts` `deps.neverBundle: true`；`scripts/verify-archive-client.mjs` 守卫不可关闭）。
13. 新领域工具要用 `registerTool(...)`（带知识库兜底），返回统一结果协议，并同步更新 `example:tool-quickref` 系统提示中的工具清单。payload 缺失时不得出现 `payload: undefined` 键。
14. 设置窗口新增 IPC：`ipcMain.handle('shell:…')` + preload 具名方法；涉及路径只接受白名单。
15. 文件编码 UTF-8 无 BOM、LF；`*.cmd`/`*.bat` 为 CRLF。
16. 不要提交/打包任何密钥文件（`.credentials.yaml`、wecom 凭证、`.mcp-auth`）。

## 常用命令
```
npm run build                   # 全量编译（example/feedback-archive 插件 → main → preload → assets）
npm start                       # build + electron .（与正式版共用 %APPDATA%\Agent Desktop，单实例；隔离用 npx electron . --user-data-dir=<dir>）
npm run build:example           # 只编 dsh-tool-example
npm run build:feedback-archive  # 只编 dsh-tool-feedback-archive（含 client 守卫）
npm run brand                   # 可选：给 node_modules 里的 DSH 前端打品牌补丁（npm ci 后需重新执行，幂等）
npm run icon                    # 重新生成中性图标 assets/icon.ico / icon.png
npm run selfcheck               # 壳层/迁移/语言/预设 自检
npm run selfcheck:presets       # 纯 node，最快
npm run dist:dir                # 打包到 release/win-unpacked
npm run bundle:portable         # 免安装版 + 用户文档 → release/Agent-Desktop-portable-<ver>-<date>/
npm run verify:packaged-packages ; npm run verify:profile-deps   # 打包审计
```

## 验证要求
- 改 `src/**`：`npm run build` 通过 + 相关 `selfcheck`。
- 改 `packages/dsh-tool-example/**`：`npm run build:example` + 其 `test/` 下的验证脚本（使用临时目录生成的小型样例工程，**不依赖任何真实业务工程**）。
- 改 `packages/dsh-tool-feedback-archive/**`：`npm run build:feedback-archive`（守卫必须通过）。
- 改打包配置或依赖：`npm run dist:dir` + 两个打包审计。
- 不能验证时明确说明没验证什么。

## 文档索引
`docs/handbook/01-architecture.md` 架构 · `02-directory.md` 逐文件 · `03-runtime-environments.md` 开发态/打包态路径 · `04-dev-setup.md` 开发环境 · `05-maintenance.md` 改 X 的步骤 · `06-build-release.md` · `07-testing.md` · `08-troubleshooting.md`。
技术思路沉淀：`docs/domain-tool-patterns.md`（写领域工具前必读）。
用户文档：`docs/user-guide.md`、`docs/feedback-archive.md`（改用户可见行为时同步更新；`bundle:portable` 会把它们放进免安装包）。
