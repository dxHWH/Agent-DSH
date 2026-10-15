# DSH 桌面客户端 — 实现计划

[English](PLAN-desktop-client.md) | 中文

> 状态：**Phase 0–3 全部完成并实测通过**
> 目标目录：`<repo>`
> 依据：对 `@deepseek-ai/dsh@0.1.5-rc.2` 安装产物的通读（README / package.json / lib 编译产物）

---

## 术语对照

| 英文 | 中文 | 含义 |
|---|---|---|
| profile | 配置集 | 一组 bundle 的有序叠加，决定启动哪些组件 |
| bundle | 插件包 | 一个 patch 层包，如 `dsh-base`、`dsh-web-app` |
| patch / overlay | 补丁 / 覆盖层 | 对组合的增删改，按顺序叠加，后者覆盖前者 |
| entry | 条目 | 组合后的一个插件挂载项 |
| composition | 组合 | 多个 patch 层叠加后的最终插件树 |
| host | 宿主 | 运行在 Node 侧、提供服务的 DSH 主体 |
| shell | 壳层 | 本项目自身，即 Electron 外壳 |
| boot graph | 启动图 | 客户端要加载哪些插件的清单，经 `window.__DSH_BOOT__` 下发 |
| launch token | 启动令牌 | 每次进程启动随机生成的一次性认证串 |
| loopback | 回环 | 仅本机可访问的网络地址（`127.0.0.1`） |
| spawn | 派生 | 创建子进程 |
| asar | Electron 归档 | Electron 打包格式，内部文件不能按路径执行 |
| HMR | 热模块替换 | 改代码后不重启即生效的开发时能力 |

---

## 实施结果（收尾更新）

| 阶段 | 结果 | 证据 |
|---|---|---|
| Phase 0 可行性 | 完成，**推翻了 CORS 假设** | `docs/phase0-findings.zh.md` |
| Phase 1 最小可用 | 端到端跑通 | 服务监听 + 前端 JS `HTTP 200, 555,959 bytes` |
| Phase 2 桌面化 | 自检 **12/12** | `npm run selfcheck:shell` |
| Phase 3 打包分发 | 安装包 **110.8 MB**，asar 验证通过 | `release/DSH Desktop Setup 0.1.0.exe` |
| Phase 3 迁移能力 | 自检 **11/11** | `npm run selfcheck:portable` |
| 语言（中文） | 自检 **15/15** | `npm run selfcheck:locale` |
| 功能对等性 | **152 : 152，零差异** | `npm run audit:capabilities` |

**关键技术结论（实施中确认）：**
- **必须 Electron 37+**：DSH 需要 Node 22+ 的三个内置模块导出（`zstd`、`getSystemErrorMessage`、`stripTypeScriptTypes`），Electron 33 的 Node 20 无法加载插件树
- **主进程必须 ESM**
- **必须提供 `provideCmdline`**，否则 11 个条目永久 pending
- **patch 的 `config` 是整体替换而非合并** —— 这是最容易踩的陷阱
- **`insert:` 才能新增行**，裸写 `- id:` 只定位已有行，且静默失败

## 已锁定的决策

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 架构选型 | **方案 A**（Electron 内嵌 HTTP 服务 + 加载真实 URL） |
| 2 | DSH 依赖方式 | **内置固定版本的 DSH**（锁定 `0.1.5-rc.2`，打入安装包） |
| 3 | 目标平台 | **仅 Windows** |
| 4 | 托盘行为 | **托盘常驻，关窗最小化到托盘** |
| 5 | 配置入口 | **复用 DSH 现有设置界面**；壳层只做应用级配置 |
| 6 | 语言 | **首次运行播种中文**，已有选择绝不覆盖 |

---

## 1. 结论摘要

**DSH 官方预留了桌面客户端的位置，但没有实现它。** 存在一个明确的、被文档命名的扩展接缝：

| 证据 | 出处 |
|---|---|
| CLI 主动拒绝 `desktop` profile：`profile "desktop" is managed exclusively by the Electron application` | `dsh/lib/bin.js:28-30` |
| "Electron's reserved Desktop profile" 用 `loadProfileDirectory` 加载自持 profile 目录 | `dsh-app-boot/README.md:50` |
| "It serves browsers only; **Electron loads dist over `file://` and carries fetch over an IPC bridge**" | `dsh-host-webserver/README.md:12` |
| 客户端传输层可被外壳替换：`ClientTransportHooks { fetch, openStream?, loadBundle?, ownsHost? }` | `dsh-client-connection/lib/types/client/index.d.ts:37-63` |
| 前端 `dist/` 是纯静态产物，**未编译进任何服务端地址** | 实测 `dsh-web-frontend/dist/index.html` |

**但官方没有交付任何 Electron/Tauri 代码**：全部 `@deepseek-ai` 包零 Electron 依赖，`PROFILE_TEMPLATES` 只有 `acp`/`web`/`headless`/`sdk`/`sdk-minimal`，没有 `desktop`。

**本计划的核心判断：**

> 采用 **Electron 外壳 + 内嵌真实 HTTP 服务 + `BrowserWindow` 加载 `127.0.0.1` 真实 URL**。
>
> **不采用**文档提及的 `file://` + IPC fetch 桥方案。

这个判断与官方 README 的暗示相反。经 Phase 0 实测，**结论成立但理由被修正** —— 详见 §4.2。

---

## 2. 已验证的技术事实

以下全部经实际读取源码/产物或实测确认，非推测。

### 2.1 `dsh` CLI 的真实结构

`dsh` 只是一个 **profile 启动器**，共三个命令：

- `dsh --profile <name>` — 启动 `$DSH_HOME/profiles/<name>`
- `dsh web` — `--profile web` 的硬编码别名
- `dsh plugin --profile <name> <pnpm args>` — 转发给 pnpm

关键机制：**启动器只解析自己的参数，其余原样交给被启动的 app**。
`rejectElectronProfile()` 仅在两处调用 —— 根命令（`bin.js:92`，在 `resolveBoot`
之前，因此 `--dump-config` 也被覆盖）与 `plugin` 子命令（`bin.js:109`）。
大小写不敏感。

启动 patch 叠加顺序：
```
bundle patches → profile/cordis.patch.yml → $DSH_HOME/cordis.patch.yml → --patch → telemetry
```

### 2.2 前端产物（可复用的核心资产）

`dsh-web-frontend/dist/` 是一份**完整的、已构建的 vite SPA**：

```
dist/index.html                 679 B
dist/manifest.webmanifest       267 B
dist/favicon.svg              3,721 B
dist/assets/index-BKQ_L1z6.js   555,959 B
dist/assets/vendor-CCJJTK99.js  740,575 B
dist/assets/index-DPX2bQLO.css   51,949 B
dist/assets/vendor-BNsW4eBh.css  29,288 B
dist/assets/langs/*.js          ~24 个（shiki 语法高亮包）
dist/assets/*.woff2             ~90 个（KaTeX 字体）
```

> 注意：`assets/langs/*.js` 是 shiki 的**代码高亮语法包**，与界面语言无关。
> 界面语言由 `dsh-client-locale` 提供（见 §2.8）。

`package.json` 中 `exports` 仅 `./dist/*` 与 `./package.json`，
**无 `main`/`bin`/`types`，无任何 runtime 依赖** —— 纯构建产物。

**`index.html` 全文只有 17 行，实测确认：**
- 资源引用全部是**相对路径**（`./assets/...`）
- **没有 `window.__DSH_BOOT__`**
- **没有服务端地址**

这是决定性的：`dist` 本身不含任何服务端信息，它靠 `dsh web` 在提供服务时用
`ctx.webServer.renderIndex(html)` 注入 boot 图。

### 2.3 客户端 — 主机通信协议

**不是 stdio，不是裸 JSON-RPC。** 三种载体：

| 用途 | 载体 | 常量 |
|---|---|---|
| 一元调用 | HTTP POST | `API_PATH = "/api"` |
| 流 | 单条 WebSocket | `/api/remote.mux` |
| 非 JSON 响应 | HTTP GET/HEAD/POST | `GET\|HEAD /api/file?path=` |

信封格式：
```ts
ClientRequest  { type: 'client-request',  rpcId, method, payload }
ServerResponse { type: 'server-response', rpcId, result }
result = { ok: true, value: T } | { ok: false, error: { code, message, details } }
```

主叫方生成 `rpcId`，主机回显。**`RemoteResult` 从不因载体故障而 reject** ——
错误也在 `ok:false` 里。

### 2.4 认证

- 每次进程启动生成随机 launch token
- `?token=...` **仅在 `GET /` 被接受**，随后写入绑定 authority 的签名 cookie，
  303 重定向到干净的 `/`
- Cookie 签名密钥 = `ctx.credentials` 中 `client-connection/browser-session` 授权记录，
  落在 `$DSH_HOME/.credentials.yaml`（已实测确认存在）
- Cookie 属性：`HttpOnly`、`SameSite=Strict`、`Path=/`、**刻意不带 `Secure`**
  （loopback HTTP）、默认 30 天
- 请求信任围栏：`Host` 必须是 loopback 或在 `trustedHosts` 中，`Origin` 必须等于 Host，
  `sec-fetch-site: cross-site` 拒绝
- **`dsh web --host 0.0.0.0` 在启动期被硬拒绝**

### 2.5 客户端插件系统

**没有 Module Federation，没有原生动态 `import()`。** 是手写的 **lazy-CJS 模块表**，
替换了 vendored cordis Loader 的 import 接缝。

外置插件注册方式（无需改核心）：
1. `package.json` 里声明 `dsh.client { platform: 'web' }`
2. 导出已构建的 `./client` bundle
3. 作为 enabled Loader entry 出现在组合中

bundle URL：`/plugins/<package-id>/client.js`，boot 图经 `window.__DSH_BOOT__` 下发。

**构建前提**：`lib/client.js` 必须已构建，缺失会以 `MissingClientBundleError` 显式失败。

### 2.6 路由归属（完整路径图）

| 路径 | 归属 |
|---|---|
| `/api` (prefix) | `dsh-client-connection` |
| `/api/remote.mux` (upgrade) | `dsh-api-gateway` |
| `/plugins` (prefix) | `dsh-client-modules` |
| `/plugins/events` (SSE) | `dsh-client-hmr` |
| fallback（其余全部） | `dsh-host-frontend-static` |

默认监听 **`127.0.0.1:3080`**（`dsh-web-app/cordis.patch.yml`）。

桌面端改用 `--port 0`，让 OS 分配空闲端口。

### 2.7 本机环境

```
Node      v24.21.0
npm       11.19.0
dsh       0.1.5-rc.2
Electron  37.10.3（Node 22.21.1）
DSH_HOME  C:\Users\<user>\.dsh
```

### 2.8 语言支持（`dsh-client-locale`）

实测确认已挂载，编译产物同时含 `zh` 与 `en` 词典。

精确契约（来自 `dsh-client-locale/lib/index.js`）：

| 项 | 值 |
|---|---|
| settings 命名空间 | `locale` |
| 字段 | `preference` |
| 合法值 | `["zh", "en"]` |
| 存储位置 | `$DSH_HOME/settings.yaml` |
| 切换入口 | 主窗口 设置 → General → Language（即时生效） |

---

## 3. 目标与非目标

### 目标
- 双击即用的原生桌面窗口，无需手动开浏览器、无需记端口
- 复用 DSH 官方前端 `dist` 与全部主机能力（会话、工具、审批、沙箱）
- 外壳提供浏览器给不了的桌面能力：原生窗口控制、系统托盘、原生目录选择、打开本地文件/文件夹
- 与现有 `dsh web` 工作流**不冲突**，可共存
- 外置插件，**不修改 DSH 安装目录**（保证 `dsh` 升级不被破坏）
- 可迁移：全部用户数据集中一处，可拷到另一台 Windows 机器

### 非目标（本期明确不做）
- 不做移动端 / Web 端改造
- 不 fork 或重建 DSH 前端（`dist` 原样复用）
- 不实现自定义编辑器 / 终端模拟器
- 不做自动更新与代码签名（列为后续）
- 不追求 `file://` 无服务器架构

---

## 4. 架构选型

### 4.1 三个候选方案

| | A. 内嵌服务 + 真实 URL | B. `file://` + IPC 桥 | C. 系统浏览器外壳（Tauri/轻壳） |
|---|---|---|---|
| 认证 | 复用官方 token→cookie 流程，**零改造** | 需 `ownsHost: true`，绕过认证 | 同 A |
| ES module | 正常（http origin） | 实测可加载，但缺 boot 注入 | 正常 |
| WebSocket 流 | 原生可用 | 需自实现 `openStream` | 原生可用 |
| `/plugins` bundle | 原生可用 | 需自实现 `loadBundle` + `fetchBundle` | 原生可用 |
| 官方文档支持 | 未提及但完全合规 | README 明确提及 | 未提及 |
| 实现难度 | **低** | 高 | 中 |
| 原生能力（托盘/原生选择器） | 完整 | 完整 | 受限于所选框架 |

### 4.2 判定：方案 A（已按实测修正）

> **本节已按 Phase 0 实测结果修正。** 原论证（「`file://` 会因 CORS 失败」）
> **已被实验推翻**，详见 `docs/phase0-findings.zh.md`。
> 方案 A 的结论不变，但理由不同。

**理由（修正后）：**

1. **`file://` 走不通的真实原因是缺少 boot 注入，不是 CORS。** 实测 `file://` 下
   ES module 正常加载、React 正常挂载，`did-fail-load` 为空 —— 原先的 CORS 判断是错的。
   真正失败的是 `window.__ModuleLoader__ bootstrap facade is missing`：
   `dist/index.html` 是 17 行纯静态 HTML，`__DSH_BOOT__` 与 `__ModuleLoader__`
   都由 `dsh web` 在提供服务时经 `ctx.webServer.renderIndex()` 注入，
   `file://` 下没有服务端来注入。
   - 理论上可以自己实现注入（读取 boot 图 + 提供 `/plugins` 字节），
     但那等于**重实现方案 A 免费获得的一切**。

2. **方案 A 免费拿到全部协议能力。** HTTP origin 下，`fetch` 到 `/api`、
   WebSocket `/api/remote.mux`、`/plugins` bundle 加载、SSE `/plugins/events`
   全部原生工作，**不需要实现任何 `ClientTransportHooks`**。

3. **认证流程零改造。** `BrowserWindow` 指向
   `http://127.0.0.1:<port>/?token=<token>`，cookie 正常写入，与浏览器行为完全一致。

4. **它是唯一立刻可验证的方案。** 方案 B 依赖的 IPC 桥接协议
   （channel 名、序列化、流分帧）在安装产物中完全没有文档化。

**已被实测确认的额外约束：**
- **Electron 主进程必须是 ESM** —— DSH 全部包是 `"type": "module"`，
  CommonJS 会以 `ERR_REQUIRE_ESM` 失败
- **Electron 37+（Node 22+）** —— Electron 33 虽能导入启动库，但无法加载插件树
- `loadProfileDirectory`、`boot` 等启动 API 在 Electron 主进程内**可直接导入使用**

### 4.3 关键实现要点

**不要用 `dsh web` 子进程 + 解析 stdout 拿端口。** 更稳的做法是
**在同进程内直接 boot DSH**：

```js
import { loadProfileDirectory, boot } from '@deepseek-ai/dsh-app-boot'
```

- `loadProfileDirectory(binName, dir, installAnchor, options)` 是官方导出的公开 API，
  明确为「应用自持 profile 目录」设计，**不经过 CLI profile 查找**，
  因此不受 `desktop` 名称保留限制
- `--port 0` 让 OS 分配端口，再通过 `ctx.webServer.port` 读回，**彻底消除端口冲突**

---

## 5. 实施中确认的额外契约

以下三点在计划阶段未预见，实施中实测确认，属于必须遵守的硬约束：

### 5.1 `provideCmdline` 必须调用

不调用会导致 11 个条目永久 pending：
```
@deepseek-ai/dsh-web-app/startup: pending (waiting for service: cmdlineArgs)
@deepseek-ai/dsh-host-webserver:   pending (waiting for service: webStartup)
```

`appReady` 也必须提供，且在**启动成功后**才 `commit()`，否则会掩盖真实错误。

### 5.2 patch 的 `config` 是整体替换

不是合并。只写 `config: { printUrl: false }` 会让 `openBrowser` 回落到 schema
默认值 `true`，导致 DSH 在 Electron 背后偷偷打开系统浏览器。必须重写该行需要的每个字段。

### 5.3 `insert:` 才能新增行

裸写 `- id: xxx` 只**定位**已有行，不会新增，**且静默失败**（entry 数不变、不报错）。

```yaml
- insert:
    - id: my-plugin
      name: '@scope/my-dsh-plugin'
```

---

## 6. 分阶段实施计划（全部已完成）

### Phase 0 — 可行性实证 ✅

- [x] 初始化 npm 项目，装 Electron（升至 37 以满足 Node 22+）
- [x] **实验 1**：`BrowserWindow.loadFile(dist/index.html)` —— 推翻 CORS 假设
- [x] **实验 3**：同进程 `loadProfileDirectory` + `boot` —— 确认可导入
- [x] 产出 `docs/phase0-findings.zh.md`

### Phase 1 — 最小可用客户端 ✅

- [x] Electron 主进程：`loadProfileDirectory` 启动 DSH（`port: 0`）
- [x] 经 `connection.authenticatedUrl()` 取得已认证 URL
- [x] `BrowserWindow` 加载该 URL（无 preload，最小攻击面）
- [x] 生命周期：优雅关闭 DSH
- [x] 单实例锁；boot 失败有可读错误页
- [x] 安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`

### Phase 2 — 桌面化能力 ✅

- [x] 系统托盘：显示/隐藏窗口、设置、退出
- [x] 关窗最小化到托盘而非退出（含首次气泡提示）
- [x] 窗口状态持久化（尺寸/位置/最大化，含离屏保护）
- [x] 应用菜单与快捷键
- [x] 壳层设置窗口（数据根、诊断、语言只读显示）
- [x] 原生通知

### Phase 3 — 打包与分发 ✅

- [x] `electron-builder` 出 Windows NSIS 安装包
- [x] 内置固定版本 DSH（打入 `app.asar.unpacked`）
- [x] `asarUnpack`：原生二进制 + DSH 目录树 + 非 JS 资源
- [x] 应用图标（7 个尺寸的 ICO，脚本生成）
- [x] 打包后应用实测：前端 JS `HTTP 200, 555,959 bytes`
- [x] 迁移能力实测：拷贝文件夹后配置与凭据完好

### Phase 4 — 探索项（未做）

- [ ] 自定义 scheme 的无端口方案
- [ ] 桌面专属客户端插件（走 `dsh.client` 声明机制）
- [ ] 自动更新（`electron-updater`）
- [ ] 代码签名

---

## 7. 风险登记（含实施后的实际结果）

| 风险 | 影响 | 结果 |
|---|---|---|
| `0.1.5-rc.2` 是 RC 版本 | 接缝可能变动 | 已缓解：全部耦合集中在 `host.ts` 单文件 |
| `loadProfileDirectory` 未在 Electron 验证 | Phase 1 受阻 | **已解除** —— 实验 3 通过 |
| **`app.asar` 破坏子进程 spawn** | 工具调用全失效 | **已解除** —— `asarUnpack` 生效，打包后实测通过 |
| 端口冲突 | 启动失败 | **已解除** —— `--port 0` 由 OS 分配 |
| 前端 `dist` 路径硬编码 | 升级后白屏 | **已缓解** —— 经 `require.resolve` 动态解析 |
| **Electron 内置 Node 版本不足** | 插件树加载失败 | **实测遇到并解决** —— 升级到 Electron 37 |
| 关窗最小化致误以为已退出 | 体验问题 | **已缓解** —— 首次气泡提示 |
| `nodeIntegration` 配置不当引入 RCE | 严重安全问题 | **已缓解** —— `sandbox: true`，主窗口无 preload |
| 语言播种覆盖用户选择 | 用户设置被改 | **已缓解** —— 仅首次播种，已有选择绝不覆盖 |

---

## 8. 实际目录结构

```
<repo>\
├── PLAN-desktop-client.md / .zh.md      # 本文档
├── README.md / .zh.md                   # 使用说明
├── package.json                          # Electron 应用清单
├── electron-builder.config.cjs           # 打包配置
├── tsconfig.json / tsconfig.preload.json # 主进程 ESM / preload CJS
├── src\
│   ├── main\
│   │   ├── index.ts                      # 主进程入口、窗口生命周期、菜单
│   │   ├── host.ts                       # ★ DSH 启动适配层（唯一与 DSH API 耦合处）
│   │   ├── paths.ts                      # 数据根解析（4 种模式）
│   │   ├── locale.ts                     # 首次运行中文播种
│   │   ├── settings.ts                   # 壳层设置窗口 + IPC
│   │   ├── tray.ts                       # 系统托盘
│   │   └── window-state.ts               # 窗口状态持久化
│   ├── preload\
│   │   └── settings.ts                   # 设置窗口的最小权限 preload（编译为 .cjs）
│   └── settings\
│       └── index.html                    # 设置窗口界面
├── scripts\                              # 自检与审计脚本
├── docs\                                 # 技术文档（中英双语）
├── assets\icon.ico                       # 应用图标
├── desktop-profile\                      # 应用自持的 DSH profile 目录
└── release\                              # 打包产物
```

**架构纪律**：所有对 `@deepseek-ai/*` 的调用**只允许出现在 `src/main/host.ts`**。
DSH 目前是 RC 版本，把耦合收进单一文件，未来升级时改动面最小。

---

## 9. 遗留问题

1. **Phase 0 的实证结论推翻了原假设**，但方案 A 结论不变；
   唯一保留的架构回退路径是自定义 scheme 的无端口方案（Phase 4）。
2. **`app.asar` 与 DSH 子进程** —— 已通过 `asarUnpack` 解决并实测验证。
3. **内置 DSH 的升级通道** —— 锁定 `0.1.5-rc.2` 意味着用户拿不到上游修复。
   建议在 Phase 4 评估受控的升级流程（而非自动跟随）。
4. **HMR 不可用** —— DSH 的 HMR 服务要求 Node 的 `--expose-internals`，
   Electron 主进程启动后无法追加。影响外置客户端插件的开发效率，
   不影响已构建插件的加载。

---

## 10. 参考：已确认的关键文件路径

```
dsh 安装根
C:\Users\<user>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\

启动器
  lib\bin.js                                        # 命令解析、desktop 名称保留
  lib\profile-boot-Dk-7KqJc.js                      # runProfile 真实实现（349 行）

前端产物（复用目标）
  node_modules\@deepseek-ai\dsh-web-frontend\dist\index.html
  node_modules\@deepseek-ai\dsh-web-frontend\dist\assets\*

关键接口
  dsh-app-boot\README.md:50                         # Electron 保留 profile + loadProfileDirectory
  dsh-host-webserver\README.md:12                   # Electron file:// + IPC 桥的表述
  dsh-client-connection\lib\types\client\index.d.ts:37-63   # ClientTransportHooks
  dsh-client-connection\lib\client.js:6307,6344     # __DSH_TRANSPORT__ 运行时读取
  dsh-web-app\cordis.patch.yml                      # 默认 127.0.0.1:3080
  dsh-client-locale\lib\index.js                    # locale 命名空间与 preference 字段
  dsh-cmdline\lib\index.js                          # provideCmdline 契约
  dsh-permission-presets\lib\index.js               # 权限预设

用户配置
  C:\Users\<user>\.dsh\settings.yaml
  C:\Users\<user>\.dsh\.credentials.yaml
  C:\Users\<user>\.dsh\profiles\web\
```

---

## 11. 证据强度声明

- **经实测确认**：§2.1、§2.2、§2.7、§2.8、§4.2 全部结论、§5 三个契约
- **经读取源码/README 确认**：§2.3、§2.4、§2.5、§2.6
- **已推翻的原推断**：原 §4.2 中「`file://` 会因 CORS 失败」—— Phase 0 实测证明
  ES module 在 `file://` 下正常加载，真实原因是缺少 boot 注入
- **未文档化的空白**：Electron IPC 桥的具体协议（channel 名、序列化、流分帧）、
  `__DSH_BOOT__` 在 `renderIndex` 之外注入的方法。
  上游决策记录（`.agents/notes/implemented/architecture/2026-07-2*-*.md`）
  未包含在 npm 包中，建议从 GitHub 仓库获取。
