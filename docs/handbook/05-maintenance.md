# 05 · 维护手册（按"我要改 X"查）

每一节格式：**改哪里 → 怎么生效 → 怎么验证 → 坑**。通用生效规则：

| 改动位置 | 开发态生效 | 用户机生效 |
|---|---|---|
| `src/**` | `npm start` | 重新打包分发 |
| `packages/dsh-tool-example/**` | `npm run build:example` + 重启 | 重新打包分发 |
| `packages/dsh-tool-feedback-archive/**` | `npm run build:feedback-archive` + 重启 | 重新打包分发 |
| `assets/agent-preset/**`、`assets/model-preset/**` | **只影响新数据根**；已有数据根要手动删/合并或写迁移 | 同左 |
| `<数据根>/.agent-presets/project/agent.cordis.yml` | 重启 | 重启（可让用户自己改） |
| `desktop-profile/cordis.patch.yml` | 重启 | 改 `resources\desktop-profile\cordis.patch.yml` 后重启 |
| `<数据根>/settings.yaml` | 多数项 DSH 实时生效，保险起见重启 | 同左 |

写领域工具前先读 [`../domain-tool-patterns.md`](../domain-tool-patterns.md)。

---

## 1. 领域工具（`packages/dsh-tool-example`）

### 1.1 修改已有工具的行为
1. `example_search` → `src/search.ts`（检索、证据、报告）；分词/打分 → `src/text.ts`；文件范围 → `src/sources.ts`。
2. `npm run build:example`。
3. 跑 `packages/dsh-tool-example/test/` 下对应的验证脚本。
4. 重启应用，在项目模式下实测。

### 1.2 新增一个工具
1. 新建 `src/xxx.ts`，导出纯函数或能力类，返回 `ToolResult`（`src/result.ts`）。
2. 在 `src/index.ts` 的 `apply()` 中：
   - 需要共享昂贵资源时加一个惰性 getter（参照 `getIndex`）；
   - `registerTool(defineTool({ name: 'example_xxx', description, parameters, output: RESULT_OUTPUT, isConcurrencySafe, execute }))`；
   - 用 `registerTool` 而不是 `tools.register`，这样自动获得知识库兜底；
   - `execute` 最终 `return toOutput(result)`，保证没有 `undefined` 键。
3. **更新系统提示** `example:tool-quickref` 里的工具清单（意图 → 工具），否则模型不知道何时用它。
4. `description` 写清触发语句（"当用户要……时用本工具，不要用 glob/read……"）——这是模型选工具的主要依据。
5. 若生成报告：用 `report_writer.ts`，返回 `artifacts`，并在描述里要求"返回 artifacts 时调用 present"。
6. 预设不需要改（工具随 `tool-example` 插件一起注册）。

### 1.3 修改系统提示
`src/index.ts` 中的 `ctx.systemPrompt.section({ name: 'example:tool-quickref', order })`。`order` 相对 `TOOL_SUBAGENT` 段排序。改文本 → `build:example` → 重启。需要新的行为规范时另起一个 `example:<主题>` section，不要把所有规则塞进一段。

### 1.4 知识库兜底逻辑
`src/kb_fallback.ts`：`classifyNegative()` 决定哪些结果算"消极"（`capability_gap`，误用类 gap 除外；首行为"未找到 / not found"的 `partial|needs_input`）。工具名来自插件配置 `kbQueryTool`（默认 `mcp__knowledge__kb_query` = `mcp__<serverName>__<tool>`）——**如果 MCP 的 `serverName` 或工具名改了，要在预设的 `tool-example.config.kbQueryTool` 同步改**。

### 1.5 领域知识资产
放在 `packages/dsh-tool-example/knowledge/`（`package.json` `files` 已包含），按包根定位，格式与规则见该目录 `README.md`。改完开发态重启即可，用户机需重新打包。

### 1.6 查询索引（SQLite）结构变更
- 改了表结构或构建逻辑：**必须**递增 `src/sqlite/schema.ts` 的 `SCHEMA_VERSION` 或 `BUILDER_VERSION`，否则旧索引被当作 ready，查询结果错乱。版本变化后旧索引状态变为 `stale`，查询自动回退扫描并提示用户重建。
- 查询路径**永不**建索引（`ProjectIndex.openForQuery()`），只有设置窗口的"重建索引"会建。不要在工具里加隐式重建（这类实现曾让 agent 卡住上百秒，见 `../index-benchmark.md`）。
- 新增派生表时，给它写"索引结果 vs 实时扫描结果"一致性验证脚本。

### 1.7 给插件加 npm 依赖
1. 加到 `packages/dsh-tool-example/package.json` 的 `dependencies`，在根目录 `npm install`（npm 会提升到根 `node_modules`）。
2. **必须**把它及其全部传递依赖加到 `electron-builder.config.cjs` 顶部的 `EXAMPLE_RUNTIME_DEPS` 数组（同时用于 asarUnpack 与 `desktop-profile/node_modules` 拷贝）。漏了 → 打包版报 `Cannot find module`，开发态不会暴露。
3. 打包后跑 `npm run verify:profile-deps`。
4. 能用 Node 内置模块（`node:sqlite`、`node:zlib`、`node:crypto`）解决的，优先不加依赖。

### 1.8 基于骨架做自己的领域插件
推荐直接复制 `packages/dsh-tool-example` 改名（包名、`name`、工具前缀、系统提示 section 名、`.agent-index` 目录名可保留），并同步：根 `package.json` 的 `file:` 依赖与 `build` 脚本、`electron-builder.config.cjs`、预设里的插件行、`mcp.ts` 中定位插件行的文本规则、`index-manager.ts` 懒加载的包名。

---

## 2. 项目模式预设（`assets/agent-preset/project/`）

### 2.1 组成
`agent.cordis.yml` 是 DSH 的 agent-plane 组合，基于 DSH 自带 `standard` 预设复制后增加：
- `tool-example`（`projectRoot: '__PROJECT_ROOT__'`、`reportDir: 'data/reports'`）；
- `mcp-knowledge`（`dsh-mcp-client`，stdio：`node <mcp-remote proxy.js> https://kb.example.com/mcp --transport http-only`，**默认 `disabled: true`**，`serverName: knowledge`）。

`preset.yml`：显示名、描述、`order`。

### 2.2 四个占位符（由 `src/main/agent-preset.ts` 首次安装时替换）

| 占位符 | 替换为 |
|---|---|
| `__PROJECT_ROOT__` | 空串（用户在设置窗口绑定；为空时工具返回 `needs_input` 提示去绑定） |
| `__NODE_EXE__` | 探测到的系统 node.exe（找不到时写 `node.exe`） |
| `__MCP_REMOTE_PROXY__` | `%APPDATA%\npm\node_modules\mcp-remote\dist\proxy.js` |
| `__MCP_AUTH_DIR__` | `%USERPROFILE%\.mcp-auth` |

**模板里绝不能出现本机绝对路径**——`bundle-portable.mjs` 会扫描打包资源里的 yaml/json/cmd，发现开发机路径就报错。

### 2.3 修改预设并让已安装用户拿到
模板不会覆盖已安装预设。三种方式：
1. 让用户删除 `<数据根>\.agent-presets\project\` 后重启（会丢失其 projectRoot / MCP 自定义，需要重设）；
2. 在 `agent-preset.ts` 里写一个**定向迁移**：用正则识别"未被用户改过的旧内容"再替换（推荐）；
3. 让用户手动编辑。

注意 `settings.ts` / `mcp.ts` 是**按文本**定位 `name: '@deepseek-ai/dsh-mcp-client'` 和 `tool-example` 行的，改模板格式（缩进、引号风格、字段顺序）前先读 `mcp.ts`。

### 2.4 Patch 语义陷阱（cordis YAML）
- 裸写 `- id: xxx` 是**定位已有行**，不会新增；新增必须 `- insert: [ ... ]`。写错时**静默无效**。
- 覆盖某行的 `config` 是**整体替换**，没写的字段回落 schema 默认值。
- 预设里提供 service 的行必须在带 `isolate` 的 group 中（见模板文件头注释）。

### 2.5 新增一个预设（另一个模式）
复制 `assets/agent-preset/project/` 为新目录 → 改 `preset.yml` 的 `name/description/order` → 在 `agent-preset.ts` 中照 `PROJECT_PRESET_ID` 增加安装 → `electron-builder.config.cjs` 的 extraResources 已整体拷 `assets/agent-preset`。思路见 `../mode-switching.zh.md`。

---

## 3. 模型种子与 API Key

- 种子：`assets/model-preset/models.yaml`（`agent-default-model: {provider: deepseek-official, model: deepseek-v4-pro}`，以及注释掉的 `llm-pi-ai` OpenAI 兼容网关示例）。**不含密钥**。
- 只在 settings.yaml **缺少对应顶层段**时写入。已安装用户在主窗口 设置 → 模型 中调整，或手动编辑 `<数据根>\settings.yaml`。
- 首次引导的 Key 弹窗：`packages/dsh-tool-feedback-archive/src/onboarding.tsx`（通过 `remote.credentials` 写 `DEEPSEEK_API_KEY`）。
- **换网关**：在 `models.yaml` 里启用 `llm-pi-ai.providers.<名>`（`apiKeyEnv`、`api: openai-completions`、`baseURL`、`models`），把 `agent-default-model.provider` 指向它，并把 `onboarding.tsx` 的 `KEY_REF` 与文案改成对应的 Key 名。

---

## 4. 点踩归档 / 首次引导（`packages/dsh-tool-feedback-archive`）

- host 半在 `src/main/host.ts` `buildDesktopPatches()` 中 **insert 到 host 平面**（所有预设都能用），同时 `disabled` 掉 DSH 原生 `ui-message-feedback`。
- client 半 `lib/client.js` 由 tsdown 构建，**只能 require DSH 模块表里的共享模块**（react、dsh-client-store、dsh-client-ui-primitives…）。`build:feedback-archive` 末尾的 `scripts/verify-archive-client.mjs` 会拦截内联。新增 import 时如果它报错，不要关掉守卫——改成从共享模块拿，或把逻辑放到 host 半。
- 后端与配置项见 [`../feedback-archive.md`](../feedback-archive.md)。
- 端到端测试：`node scripts/archive-dsh-session.mjs <session.jsonl.zstd> <messageId> --dry-run`。

---

## 5. 设置窗口（`src/settings/index.html` + `src/preload/settings.ts` + `src/main/settings.ts`）

新增一个设置项（IPC）的完整步骤：
1. `src/main/settings.ts` 里 `ipcMain.handle('shell:<域>:<动作>', …)`；涉及文件路径时**只接受白名单路径**（参照 `shell:open-path`）。
2. `src/preload/settings.ts` 在 `contextBridge.exposeInMainWorld('dshShell', api)` 的 `api` 对象里加一个**具名**方法（不要暴露通用 invoke）。
3. `src/settings/index.html` 加 `<section>` 和调用 `window.dshShell.xxx()` 的 JS。
4. `npm start` 验证；`npm run selfcheck:shell`。

注意：用户升级后没重启时，主进程可能老于 preload，新 IPC 会不存在——UI 要对调用失败给出"请重启"提示（参照企业微信卡片的处理）。

---

## 6. 壳层行为

| 想改 | 位置 |
|---|---|
| 窗口大小 / 最小尺寸 / 标题 | `src/main/index.ts` `createWindow` |
| 菜单与快捷键 | `index.ts` `buildMenu` |
| 托盘菜单 | `src/main/tray.ts` |
| 关窗 = 隐藏到托盘 | `index.ts` `win.on('close')` |
| 渲染进程权限 | `index.ts` `setPermissionRequestHandler`（仅放行剪贴板） |
| 数据位置模式 | `src/main/paths.ts` + 设置窗口 |
| 默认语言 | `src/main/locale.ts` |

---

## 7. 品牌（名称 / 图标 / 界面 Logo）

| 项 | 位置 |
|---|---|
| 产品名 / exe 名 / appId | `package.json` `productName`，`electron-builder.config.cjs` `productName/executableName/appId`（`com.agent.desktop`），以及 `index.ts`/`tray.ts`/`settings.ts`/`settings/index.html` 中的标题字符串。**改产品名会改变默认数据根 `%APPDATA%\<产品名>`**，已有用户的数据不会自动跟过去。当前 `paths.ts` 不含旧名迁移（`legacyMigration` 恒为 `null`）；如需迁移，在 `paths.ts` 中按「新数据根不存在且旧数据根存在时，手写递归复制 `dsh-home`」自行补充（禁用 `fs.cpSync`），并把结果写入 `legacyMigration` 供启动日志使用 |
| 应用图标 | `assets/icon.ico`、`icon.png`，`npm run icon` 生成中性图标；换成自己的图标直接替换这两个文件 |
| 界面 Logo / 首页文案 | `scripts/replace-brand-wordmark.mjs`、`scripts/replace-hero.mjs`，执行 `npm run brand`（可选） |
| **DSH 升级后** | 两个品牌脚本靠**压缩后的函数签名 / 文件名**定位，升级后几乎必然失效并报 `neither signature nor marker found`；需要在新 bundle 里重新找到对应函数并更新签名，或干脆不打品牌补丁 |

---

## 8. 桌面 profile / host 平面插件

- 增删 host 平面插件：优先改 `src/main/host.ts` `buildDesktopPatches()`（代码里，随版本走）；临时实验可改 `desktop-profile/cordis.patch.yml`。
- 新增插件必须包在 `insert` 中；`npm run audit:extensibility` 可验证。
- 新的本地 host 插件：照 `dsh-tool-feedback-archive` 的方式 `file:packages/<名>` 加到根 `package.json`，并加入 `build` 脚本。`after-pack.cjs` 会自动实体化 Junction。

---

## 9. 升级 DSH（最高风险操作）

1. 新建分支。把根 `package.json` 里所有 `@deepseek-ai/*` 的 `0.1.5-rc.2` 统一改到目标版本（两个本地包 `package.json` 的 `^0.1.5-rc.2` 也要看），`npm install`。
2. `npm run build` → 修 `host.ts` 的编译/运行错误（它是唯一耦合点，读文件头注释与 `../phase1-notes.zh.md`）。
3. 如使用品牌补丁：`npm run brand` → 大概率失败，按 §7 更新签名。
4. `npm start` 自测；`npm run selfcheck`；`npm run audit:capabilities`（对比 dsh web，onlyInWeb / onlyInDesktop 应为空）。
5. 对比 DSH 新版的 `standard` 预设，把变更合并进 `assets/agent-preset/project/agent.cordis.yml`。
6. 检查 `onboarding.tsx` 依赖的 DSH 引导步骤 id（`deepseek-official`）是否仍存在。
7. `npm run dist:dir` → `npm run verify:packaged-packages` → `npm run verify:profile-deps`（新依赖会在这里暴露，按提示补进 `electron-builder.config.cjs` 的 filter 列表）→ `npm run verify:packaged-ui`。
8. `scripts/launch-fresh-test.ps1` 做新机器模拟；再用一份旧数据根测升级兼容。
9. 更新 `package.json` `version`，写变更说明，`npm run bundle:portable`。

参考：`../replace-dsh-with-source.zh.md`、`../self-maintenance.zh.md`、`../packaged-*.md`。

---

## 10. 发版

见 [06-build-release.md](06-build-release.md)。
