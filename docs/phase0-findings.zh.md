# Phase 0 实证结论

[English](phase0-findings.md) | 中文

> 实验环境：Windows、Node v24.21.0、Electron 33.4.11、`@deepseek-ai/dsh@0.1.5-rc.2`
> 实验代码：`src/main/probe.ts`，原始输出：`phase0-*.json`

---

## 术语对照

| 英文 | 中文 | 含义 |
|---|---|---|
| boot graph | 启动图 | 描述要加载哪些客户端插件的清单，经 `window.__DSH_BOOT__` 下发 |
| facade | 外观对象 | 浏览器侧接手加载的入口对象（此处指 `__ModuleLoader__`） |
| `did-fail-load` | 加载失败事件 | Electron 在页面或资源加载失败时触发的事件 |
| origin | 源 | 浏览器安全模型中的「协议 + 主机 + 端口」三元组 |
| opaque origin | 不透明源 | `file://` 这类无法被同源比较的特殊源 |
| in-process | 进程内 | 直接 import 调用，而非派生独立子进程 |
| ESM | ES 模块 | JavaScript 的标准模块格式（`import`/`export`） |
| prepare callback | 准备回调 | `boot()` 挂载插件树之前调用的钩子 |

---

## 结论摘要

| 实验 | 假设 | 实测结果 | 判定 |
|---|---|---|---|
| 1. `file://` 加载 dist | ES module + `crossorigin` 会因 CORS 被拦截 | **假设错误** —— ES module 正常加载 | 推翻 |
| 2. 真实 URL 加载 | 可行 | 依赖实验 3 | — |
| 3. 同进程导入 DSH 启动库 | 可行 | **完全可行** | 确认 |

**最终选型：方案 A（Electron 内嵌 HTTP 服务 + 加载真实 URL）—— 结论不变，但理由需要修正。**

原计划的理由是错的，修正后的理由见下方。**方案选择本身没有改变**，因为它建立在实验 3 之上，而不是建立在那个被推翻的 CORS 假设之上。

---

## 实验 1：`file://` 加载前端 dist

**命令**
```
npx electron . --probe=file
```

**原始输出**
```json
{
  "probe": "file",
  "ok": true,
  "distIndex": "<repo>\\node_modules\\@deepseek-ai\\dsh-web-frontend\\dist\\index.html",
  "dom": {
    "rootChildren": 1,
    "hasBoot": false,
    "hasLoader": false
  },
  "failures": [],
  "corsSuspicious": [
    "[3] Error: web boot: window.__ModuleLoader__ bootstrap facade is missing (file:///<repo>/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-BKQ_L1z6.js:114)"
  ],
  "totalConsoleMessages": 2
}
```

**分析**

- `failures: []` —— **没有任何 `did-fail-load`**。整个 ES module 图（`index-BKQ_L1z6.js` + `vendor-CCJJTK99.js`）都成功加载并执行了。
- `rootChildren: 1` —— **React 成功挂载**到了 `#root`。
- `totalConsoleMessages: 2` —— 只有两条消息，无 CORS/CSP 报错。

**我原计划的判断是错的。** 我预测 `<script type="module" crossorigin>` 在
`file://` origin 下会被 CORS 拦截。实测表明 Electron 33 默认允许 `file://` 下的
module 加载 —— 推测 Chromium 对 `file://` 这一不透明源（opaque origin）的 module
请求给予了豁免（同源视为自身）。**原判断应当作废。**

- 真正的失败点是：`window.__ModuleLoader__ bootstrap facade is missing`
  （缺少 `__ModuleLoader__` 启动外观对象）

这完全符合调研发现：`dist/index.html` 是 17 行纯静态 HTML，
**不含 `__DSH_BOOT__` 也不含 `__ModuleLoader__`**，两者都由 `dsh web` 在提供服务时
通过 `ctx.webServer.renderIndex()` 注入。`file://` 下没有服务端，因此没人注入 →
启动引导失败。

**这推翻的是「理由」，不是「结论」**：`file://` 确实走不通，但原因是
**缺少 boot 注入**，而非传输层被拦截。

---

## 实验 3：同进程导入 DSH 启动库

**命令**
```
npx electron . --probe=boot
```

**原始输出（节选）**
```json
{
  "probe": "boot",
  "ok": true,
  "exports": [
    "DEFAULT_PROFILE_BUNDLES", "DEFAULT_PROFILE_PATCH_RELOAD",
    "FAIL_LOUD_RELEASE_TIMEOUT_MS", "HARNESS_SOURCE_SECTION",
    "PROFILES_DIR", "PROFILE_PATCH_FILENAME", "PROFILE_TEMPLATES",
    "addHarnessSourceSection", "assertEntriesActivated", "assertEntriesLoaded",
    "boot", "composeEntries", "healProfilesModuleFallback", "initProfile",
    "installFailLoud", "loadEnv", "loadLayeredEnv", "loadOptionalPatches",
    "loadOverlayPatches", "loadProfile", "loadProfileDirectory",
    "mountRootInclude", "readProfileManifest", "renderConfigDump",
    "resolveBundleDir", "resolveConfigPath", "resolveProfileDir",
    "watchUserPatches", "writeProfileManifest"
  ],
  "hasLoadProfileDirectory": true,
  "hasBoot": true
}
```

**分析**

- DSH 的启动库 `@deepseek-ai/dsh-app-boot` 可在 Electron 主进程内直接 `import`。
- `loadProfileDirectory`、`boot`、`composeEntries`、`initProfile` 等全部公开可用 —— 与调研预期一致。
- **前提条件**：主进程必须是 **ESM**。DSH 全部包是 `"type": "module"`，
  CommonJS 编译产物会以 `ERR_REQUIRE_ESM` 失败（实验中已实际遇到）。
  Electron 28+ 支持 ESM 主进程，Electron 33 可用。

**已确认的精确签名**

```ts
boot(
  binName: string,
  absoluteConfigPath: string,
  patches?: PatchOptions[],
  prepare?: (ctx: Context) => Promise<void> | void,
  bareModuleBaseUrl?: string,
): Promise<Context>

loadProfileDirectory(
  binName: string,
  dir: string,
  installAnchor: string,
  options?: { userLayer?: boolean },
): Profile
```

---

## 用于 Phase 1 的启动模式（从 `dsh web` 真实实现提取）

`dsh/lib/profile-boot-Dk-7KqJc.js` 的 `runProfile()` 是可靠蓝本，关键步骤：

1. `loadProfile(NAME, name, INSTALL_ANCHOR, home?, { userLayer })` 载入 profile
2. `writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)` 把根配置重写为 `[]`
3. 叠加顺序（**顺序即优先级，后者覆盖前者**）：
   ```
   bundlePatches → profile.patches → homePatches → overlays → telemetryPatch
   ```
4. `composeEntries([...])` 得到有效 entry 列表
5. `boot(NAME, rootConfig, structuredClone(allPatches), (hostCtx) => { ... })`
6. 在 `prepare` 回调内：
   - `hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)`
   - `provideCmdline(hostCtx, { args, exit, ready })`
7. `installFailLoud` 包装致命错误；SIGTERM/SIGINT 触发 `fiber.dispose()`

**桌面壳的实现策略**：用 `loadProfileDirectory` 替代 `loadProfile`，指向自持的
profile 目录，从而绕开 CLI 对 `desktop` 名称的保留限制（这正是官方 README
为该函数写明的用途）。

---

## 对计划文档的修正

`PLAN-desktop-client.zh.md` 中「`file://` 会因 CORS 失败」的论证**已被实测推翻**，
需更正为「`file://` 缺少 boot 注入」。方案 A 的结论保持不变。

新增确认的技术约束：
- **主进程必须是 ESM**（否则无法导入 DSH）
- Electron 33 支持 ESM 主进程

> **后续修订（Phase 1 实测）**：实验阶段用的 Electron 33 虽然能导入启动库，
> 但**无法真正加载 DSH 插件树** —— 它内置 Node 20，缺少 DSH 需要的
> `zlib.createZstdCompress`、`util.getSystemErrorMessage`、
> `module.stripTypeScriptTypes`。实际可行下限是 **Electron 37（Node 22.21.1）**。
> 详见 `phase1-notes.zh.md`。

---

## 仍未验证的部分

- **完整 in-process serve**：尚未实际跑通 `loadProfileDirectory` + `boot`
  起一个可访问的 HTTP 服务并读回端口。这是 Phase 1 的首要任务，
  也是方案 A 的最后一个未验证环节。
  （**已完成** —— 见 `phase1-notes.zh.md`。）
- **npm 11 的 install-scripts 拦截**：本环境 `npm install` 默认阻止了 6 个包的
  安装脚本（electron 二进制、`dsh-subprocess-local` 的 spawn helper、`koffi`、
  `node-pty`、`protobufjs`、`@google/genai`）。已通过 `npm install-scripts approve`
  全部批准。`node-pty` 实际带有 `prebuilds/win32-x64/` 预编译产物，
  无需本地编译；这些原生二进制在打包时必须 `asarUnpack`（见
  `phase1-notes.zh.md`）。
