# DSH Desktop 子进程故障 —— 修复现状与交接说明

> 配套文档：`docs/issue-dsh-desktop-subprocess-failure.md`（上游 issue 报告）
> 本文记录**本机当前实际状态**：改了什么、验证到什么程度、哪些会被覆盖、后续怎么接手。
> 日期：2026-09-21

---

## 1. 一句话现状

三个子进程工具（`pwsh` / `glob` / `grep`）**已全部修复并实测通过**；目录选择器的同类缺陷**已修复并实测通过**。
本轮额外完成：(1) 将 `ELECTRON_RUN_AS_NODE` 内建为共享 helper `runnerEnv()`（落在 `dsh-subprocess`），
并覆盖此前休眠的 2 处潜在 spawn 点（`dsh-web-app`、`dsh-sandbox-local`）；
(2) 重新 `npm run dist` 固化到安装包，替换了 9/18 的旧 exe —— **直接安装不再带回 bug**（见 §5）。


---

## 2. 环境基线

| 项 | 值 |
|---|---|
| 宿主壳 | `dsh-desktop` 0.1.0（Electron 37） |
| DSH | `@deepseek-ai/dsh@0.1.5-rc.2` |
| 平台 | Windows 11 x64 |
| 运行 Node | v24.21.0（子进程侧） |
| 源码 checkout | `<repo>` |
| 安装目录 | `C:\Users\<user>\AppData\Local\Programs\DSH Desktop` |
| 本地安装包 | `release\DSH Desktop Setup 0.1.0.exe`（**9/18 构建，早于本次修复**） |

### 为什么同一份代码有 3 个副本

这直接决定了修复必须打 3 遍，也是排查时最容易迷失的地方：

| 副本 | 路径 | 作用 |
|---|---|---|
| **A. app.asar.unpacked** | `<install>\resources\app.asar.unpacked\node_modules\@deepseek-ai\...` | **运行中的 Electron 实际加载的**（`asarUnpack` 复制而来） |
| **B. desktop-profile** | `<install>\resources\desktop-profile\node_modules\@deepseek-ai\...` | DSH profile 自带的 `node_modules`（`extraResources` 复制而来） |
| **C. dev checkout** | `<repo>\node_modules\@deepseek-ai\...` | 源码依赖树，**重新打包时的来源** |

> ⚠️ 注意：Electron 报告已解包文件的 URL 时**仍显示 `app.asar` 前缀**（`asarUnpack` 是复制而非移动）。
> 因此栈追踪里看到 `.../app.asar/...` **不代表**存在第四份文件 —— 它指向的就是副本 A。
> 这一点在排查中曾误导过我，记录于此以免后来者重蹈。

---

## 3. 修复清单

### BUG 1 — Electron 下 runner 从未执行（`ELECTRON_RUN_AS_NODE`）

**影响**：`pwsh` / `glob` / `grep` 全部失败，报
`subprocess-local: Windows Job runner exited with exit code 0 before proving its managed range empty`

| 文件 | 副本 | 状态 |
|---|---|---|
| `@deepseek-ai/dsh-subprocess-local/lib/runner-launch-COYGu0Dl.js` | A / B / C | ✅ 3/3 已修 + 实测 |
| `@deepseek-ai/dsh-host-directory-picker-native/lib/index.js` | A / B / C | ✅ 3/3 已修 + 实测 |

**改动**：在 `runnerEnvironment()` / `spawnDialogWorker()` 的环境对象中增补一行

```js
...process.versions.electron === void 0 ? {} : { ELECTRON_RUN_AS_NODE: "1" },
```

真实 Node 下该变量被忽略；`RUNNER_CONTROL_ENV_PREFIXES`（`["NODE_", "TSX_"]`）不会误删它。

#### 共享 helper：`runnerEnv()`（新增，覆盖全部 spawn 点）

按 issue 报告的建议，将 `ELECTRON_RUN_AS_NODE` 逻辑内建为共享 helper，落在子进程能力 seam
`@deepseek-ai/dsh-subprocess`（该包已导出 `scrubbedParentEnv()`，是多数 spawn 点的天然共享点）：

```js
export function runnerEnv(extra) {
  return {
    ...extra,
    ...process.versions.electron === void 0 ? {} : { ELECTRON_RUN_AS_NODE: "1" },
  };
}
```

| 消费方 | 接入方式 |
|---|---|
| `dsh-subprocess-local` `runnerEnvironment()` | ✅ 改用 `runnerEnv({...})`（消除内联展开） |
| `dsh-web-app` `spawnBrowserLauncher()` | ✅ `runnerEnv(scrubbedParentEnv())`（**原潜在缺陷，现已覆盖**） |
| `dsh-sandbox-local` `defaultProbeWindowsAcl()` | ✅ 内联标志（该包不依赖 `dsh-subprocess`，避免改 manifest） |
| `dsh-host-directory-picker-native` `spawnDialogWorker()` | ⚪ 保持内联（无 `dsh-subprocess` 依赖；改用 helper 需新增 peerDependency，风险大于收益） |

> 注：`runnerEnv()` 已同步 `lib/types/index.d.ts` 声明。

### BUG 2 — asar 路径未改写（ripgrep）

**影响**：`glob` / `grep` 失败，报 `subprocess failed before reporting an outcome (ripgrep provider failure)`
（与 BUG 1 独立，修好 BUG 1 后**仍会失败**）

| 文件 | 副本 | 状态 |
|---|---|---|
| `@deepseek-ai/dsh-tool-fs-search/lib/index.js` | A / B / C | ✅ 3/3 已修 + 实测 |

**改动**：新增 `unpackAsarPath()`（复刻壳侧 `host.ts` 的 `useUnpackedDshTree()` 语义），并在 `resolveRgPath()` 中套用。

### BUG 3 — 打包配置漏 ripgrep 平台包

| 文件 | 状态 |
|---|---|
| `electron-builder.config.cjs` | ✅ 已补 `'@vscode/ripgrep-win32-x64/**/*'` |

> `@vscode/ripgrep-win32-x64` 是 **optionalDependency**，不会被隐式带上；只带 wrapper 会让 `require.resolve` 抛 `MODULE_NOT_FOUND`。

---

## 4. 验证结果

### 工具级（重启后实测）

| 工具 | 验证内容 | 结果 |
|---|---|---|
| `pwsh` | `sum(1..5) = 15`、管道、嵌套命令 | ✅ |
| `glob` | 53 个 `.mjs`；跨目录 `**/*.ts` | ✅ |
| `grep` | 全库检索 84 处匹配（含行号） | ✅ |

### 目录选择器（独立探针实测）

复刻 `spawnDialogWorker()` 的 spawn 方式做对照实验：

| | worker 是否响应 | 退出码 |
|---|---|---|
| **不带** `ELECTRON_RUN_AS_NODE` | ❌ 零输出 | **0** |
| **带** `ELECTRON_RUN_AS_NODE=1` | ✅ `{"kind":"showing","threadId":3724}` | — |

坏的情况**退出码 0 且 worker 零输出** —— 与报错文案逐字吻合，构成 BUG 1 根因的决定性证据。
修复后**真实弹出了目录对话框**。

> 方法学备注：BUG 2 是靠**运行时埋点**（在 `resolveRgPath` / `spawn` / `handle.done` 三处记录真实异常）定位的，不是静态推断。
> 因为 `SearchError` 会吞掉 `cause`，且会话转录不保留，仅读代码拿不到 `ENOENT` 这一关键证据。
> 埋点已全部移除，见 §6。

---

## 5. ⚠️ 持久性说明（重要）

| 改动位置 | 重新打包后 | 重装客户端后 | 说明 |
|---|---|---|---|
| C. dev checkout 的 `dsh-subprocess`（`runnerEnv` helper） | ✅ 保留 | — | 打包来源 |
| C. dev checkout 的 `dsh-subprocess-local` | ✅ 保留 | — | 打包来源 |
| C. dev checkout 的 `dsh-tool-fs-search` | ✅ 保留 | — | 打包来源 |
| C. dev checkout 的 `dsh-host-directory-picker-native` | ✅ 保留 | — | 打包来源 |
| C. dev checkout 的 `dsh-web-app` / `dsh-sandbox-local` | ✅ 保留 | — | 打包来源（本轮新增） |
| `electron-builder.config.cjs` | ✅ 保留 | — | 打包配置 |
| A / B 安装目录的热修 | — | ❌ **丢失** | 会被新包覆盖 |

### ✅ 固化状态（本轮已完成）

`release\DSH Desktop Setup 0.1.0.exe` **已重新构建**（2026/9/21 15:08，替换 9/18 旧包），
`npm run dist` 全流程成功（postdist 审计：240 包 / 0 缺失 / 0 不可解析依赖）。
打包产物已确认携带全部修复：`runnerEnv()`、subprocess-local 接入、web-app 接入、
sandbox-local 标志，且 `@vscode/ripgrep-win32-x64/bin/rg.exe` 在
`app.asar.unpacked` 与 `desktop-profile` 两处均正确解包。

> 现在**直接安装这个新 exe 不会带回 bug**。旧的 9/18 包已被覆盖。

### 恢复热修的步骤（若安装目录被覆盖）

1. 确认 dev checkout 的 C 类改动仍在（这是源头）。
2. 重新打包：`npm run dist`，然后安装新产物；**或**
3. 若不想重装，手工把 C 的改动文件同步到 A 与 B：

```powershell
$dev  = "<repo>\node_modules\@deepseek-ai"
$res  = "C:\Users\<user>\AppData\Local\Programs\DSH Desktop\resources"
$tgt  = @("$res\app.asar.unpacked\node_modules\@deepseek-ai",
          "$res\desktop-profile\node_modules\@deepseek-ai")

$files = @(
  "dsh-subprocess\lib\index.js",
  "dsh-subprocess\lib\types\index.d.ts",
  "dsh-subprocess-local\lib\runner-launch-COYGu0Dl.js",
  "dsh-tool-fs-search\lib\index.js",
  "dsh-host-directory-picker-native\lib\index.js",
  "dsh-web-app\lib\index.js",
  "dsh-sandbox-local\lib\index.js"
)
foreach ($t in $tgt) { foreach ($f in $files) { Copy-Item "$dev\$f" "$t\$f" -Force } }
```

改完**必须重启客户端**（模块在启动时载入）。

---

## 6. 当前无残留

| 项 | 状态 |
|---|---|
| 临时诊断埋点（`DSH_TEMP_DIAG` / `__dshDiag` / `diagLog`） | ✅ 已全部移除（全树扫描确认） |
| `.dshbak` 备份文件 | ✅ 已删除 |
| `dsh-diag-*.log` 诊断日志 | ✅ 已删除 |
| 临时探针脚本 `scripts/diag-*.mjs` | ✅ 已删除 |

---

## 7. 未处理项（有意为之）

对 `node_modules/@deepseek-ai` 全树扫描 `process.execPath`，共 5 处裸 spawn 点：

| 包 | 判定 | 处理 |
|---|---|---|
| `dsh-subprocess-local` | 🔴 本次主因 | ✅ 已修（改用 `runnerEnv()`） |
| `dsh-host-directory-picker-native` | 🔴 同类缺陷 | ✅ 已修（内联标志） |
| `dsh-sandbox-local`（`defaultProbeWindowsAcl`） | 🟡 潜在 | ✅ **已修**（内联标志） |
| `dsh-web-app`（`spawnBrowserLauncher`） | 🟡 潜在 | ✅ **已修**（`runnerEnv()`） |
| `dsh-tool-fs-search` | ⚪ 非缺陷（仅 pkg sidecar 探测） | — |
| `dsh-client-ui-directory-picker-native` | ⚪ 非缺陷（纯 UI stub，无 spawn） | — |

**说明**：先前将 `dsh-sandbox-local` 与 `dsh-web-app` 标注为「有意未改」，
理由是二者在本机休眠（`danger-full-access` 不走 ACL 沙箱；`openBrowser:false` 不调浏览器）。
本轮按交接需求补齐：`dsh-web-app` 走共享 `runnerEnv()`，`dsh-sandbox-local` 用内联标志
（该包不依赖 `dsh-subprocess`，避免为单一 helper 引入新 peer 依赖）。
二者均通过 `node --check` 与根入口加载验证，但**未做运行时实测**（休眠路径，无法端到端触发）。

> 至此 `process.execPath` 裸 spawn 点已全部覆盖（含 2 处潜在），无同类残余。

---

## 8. 交付物

| 文件 | 用途 |
|---|---|
| `docs/issue-dsh-desktop-subprocess-failure.md` | 上游 issue 报告（根因、机制、补丁建议、全量排查表） |
| `docs/dsh-desktop-subprocess-status.md` | **本文** —— 现状、验证、持久性与恢复步骤 |

---

## 9. 一句话给上游

> 两个**互相独立**的缺陷恰好只在「Electron 壳 + asar 打包」组合下同时暴露：
> **(1)** 所有 `process.execPath` 裸 spawn 点都缺 `ELECTRON_RUN_AS_NODE`，导致 runner 变成「启动第二个宿主实例 → 撞单实例锁 → 退出码 0」；
> **(2)** `asarUnpack` 复制出的二进制路径未从 `app.asar` 改写为 `app.asar.unpacked`，导致 `existsSync` 为真但 `spawn` 报 `ENOENT`。
> 修 (1) 后 `pwsh` 恢复但 `glob`/`grep` **仍失败** —— 这本身就是二者独立的证明。
