# DSH Desktop 子进程工具失效 —— 根因分析与修复报告

> 报告对象：DSH Web UI / 桌面端上游维护者
> 环境：Windows 11 x64 · DSH Desktop 0.1.0 · `@deepseek-ai/dsh@0.1.5-rc.2` · Electron 37 (Node 22.21.1)
> 日期：2026-09-21

---

## 摘要

在一个 Electron 壳（DSH Desktop）中以内嵌方式启动 DSH host 时，**三个基于子进程的工具全部失效**，而 `read` / `write` / `edit`（纯进程内 fs 操作）**完全正常**：

| 工具 | 报错 |
|---|---|
| `pwsh` | `subprocess-local: Windows Job runner exited with exit code 0 before proving its managed range empty` |
| `glob` | `glob subprocess failed before reporting an outcome (ripgrep provider failure)` |
| `grep` | `grep subprocess failed before reporting an outcome (ripgrep provider failure)` |

最简单的 `echo hi` 也失败。故障呈**间歇性**（本会话曾短暂自愈一次）。重启客户端无效。

**结论：这是两个互相独立的缺陷，不是同一个根因。** 二者恰好只在「Electron 壳 + 打包分发」这一组合下同时暴露：

- **BUG 1** — `process.execPath` 在 Electron 下不是 `node`，且缺少 `ELECTRON_RUN_AS_NODE`；影响 **所有** `ctx.subprocess` 消费者（`pwsh` 与 `glob`/`grep` 都受影响）。
- **BUG 2** — `asarUnpack` 的路径未从 `app.asar` 改写为 `app.asar.unpacked`；**仅**影响 `glob`/`grep`（ripgrep 二进制）。

---

## BUG 1 — Electron 下 runner 从未真正执行

### 影响范围

`@deepseek-ai/dsh-subprocess-local` · 影响**全部** `ctx.subprocess` 调用者。
在 Electron 壳中，这意味着 `pwsh`、`glob`、`grep`、以及任何 LSP/终端/子进程消费者**全部**不可用。

### 机制

`spawnRunnerInvocation()`（`lib/runner-launch-*.js`）在 Node 模式下返回：

```js
return [process.execPath, fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-subprocess-local/runner"))];
```

**在 Electron 主进程中，`process.execPath` 是应用二进制（如 `DSH Desktop.exe`），不是 `node`。**

而 `runnerEnvironment()` 拼装 runner 环境时，**从不设置 `ELECTRON_RUN_AS_NODE`**：

```js
function runnerEnvironment(selection, invocation) {
	const entry = invocation?.at(-1);
	const env = childEnv();
	for (const name of Object.keys(env)) {
		const normalized = name.toUpperCase();
		if (RUNNER_CONTROL_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))) Reflect.deleteProperty(env, name);
	}
	return {
		...env,
		[SUBPROCESS_RUNNER_ENV]: selection,
		SYSTEMD_LOG_TARGET: "null",
		...entry?.endsWith(".ts") === true ? { TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH } : {}
	};
}
```

于是实际发生的是：

1. 启动**第二个宿主应用实例**（而非 Node 运行 `runner.js`）。
2. 该实例走进宿主的启动逻辑，例如 DSH Desktop 的：
   ```js
   const gotLock = app.requestSingleInstanceLock();
   if (!gotLock) { app.quit(); }
   ```
3. 真实宿主已持有单实例锁 → `gotLock === false` → **`app.quit()`，进程以退出码 0 结束**。
4. `runner.js` 一行未执行，父进程永远等不到结果消息。

父进程的校验（`lib/index.js`）要求同时满足 `exitCode === 0 && signal === null && directResultType !== void 0`；结果消息缺失，于是抛出那句极具误导性的错误：

```
subprocess-local: Windows Job runner exited with exit code 0 before proving its managed range empty
```

### 为什么报错文案会误导

「exit code 0」是那个**空转的第二个 Electron 实例**的退出码，**不是**目标命令的退出码。排查者极易误判为「进程正常退出但 job object 计数校验有缺陷」，从而怀疑 Win32 Job Object 逻辑——实际上 Job Object 代码完全正常。

### 为什么是间歇性的

`requestSingleInstanceLock()` 与第二个实例启动之间存在竞态。当第二个实例恰好抢在宿主之前或宿主释放锁时，它可能真的执行了 runner，于是工具短暂恢复——这正是本会话中观察到的「中途短暂恢复一次」。

### 为什么 `read`/`write`/`edit` 不受影响

它们是进程内 fs 操作，不经过 `ctx.subprocess`。

### 建议修复（二选一）

**方案 A（推荐，改一处全局生效）** —— 在 `runnerEnvironment()` 中补标志：

```js
return {
	...env,
	[SUBPROCESS_RUNNER_ENV]: selection,
	SYSTEMD_LOG_TARGET: "null",
	// Electron's process.execPath is the app binary, not `node`; without this flag
	// the spawn boots a second app instance that quits on the single-instance lock.
	...process.versions.electron === void 0 ? {} : { ELECTRON_RUN_AS_NODE: "1" },
	...entry?.endsWith(".ts") === true ? { TSX_TSCONFIG_PATH: SOURCE_TSCONFIG_PATH } : {}
};
```

`RUNNER_CONTROL_ENV_PREFIXES` 为 `["NODE_", "TSX_"]`，不会误删该变量；真实 Node 下该变量被忽略，无副作用。

**方案 B（更稳健）** —— 在 `spawnRunnerInvocation()` 中显式解析出一个真正的 Node 运行时（`process.execPath` 沿 `ELECTRON_RUN_AS_NODE` 语义处理），或在 `probeWindowsJob()` 中当 `process.versions.electron` 存在且缺少该变量时判为不可用、退回 `fallback` 模式（立即止血，代价是失去 Job Object 强包含）。

### ⚠️ 同一缺陷不止一处 —— 仓库内全量排查结果

对 `node_modules/@deepseek-ai` 全树扫描 `process.execPath` 后，共发现 **5 处**裸 spawn 点，其中 **3 处**属于本缺陷：

| 包 | 位置 | 状态 | 说明 |
|---|---|---|---|
| `dsh-subprocess-local` | `spawnRunnerInvocation()` | 🔴 **本次故障主因** | 影响所有 `ctx.subprocess` 消费者 |
| `dsh-host-directory-picker-native` | `spawnDialogWorker()` | 🔴 **同类缺陷** | 「选择工作目录」对话框会失败 |
| `dsh-sandbox-local` | `windowsAclRunnerInvocation()` | 🟡 **潜在** | Windows ACL 沙箱 runner；仅在启用沙箱时触发 |
| `dsh-web-app` | `spawnBrowserLauncher()` | 🟡 **潜在** | 打开系统浏览器；DSH Desktop 设 `openBrowser:false`，当前休眠 |
| `dsh-tool-fs-search` | `resolveRgPath()` | ⚪ 非缺陷 | 该处 `process.execPath` 仅用于 pkg sidecar 探测，逻辑正确 |
| `dsh-client-ui-directory-picker-native` | — | ⚪ 非缺陷 | 纯 UI stub（`function apply() {}`），无 host 侧 spawn |

**建议：不要逐个包打补丁，而是在 DSH 内建一个共享 helper**，例如：

```js
/** Environment for spawning process.execPath as a script runner, not as an app. */
export function runnerEnv(extra) {
  return {
    ...extra,
    ...process.versions.electron === void 0 ? {} : { ELECTRON_RUN_AS_NODE: '1' },
  };
}
```

让上述 4 处（含 2 处潜在）统一走该 helper。否则每新增一个 spawn 点都会重复引入同一个 bug。
`dsh-tool-fs-search` 的 `resolveRgPath()` 也应复用同一模块的 asar 改写 helper（见 BUG 2）。

---

## BUG 2 — `asarUnpack` 路径未改写，ripgrep 无法 spawn

### 影响范围

`@deepseek-ai/dsh-tool-fs-search`（`glob` / `grep`）· **仅**影响打包（asar）环境。

### 机制

`@vscode/ripgrep` 只是 JS wrapper，它这样定位可执行文件：

```js
resolved = require.resolve(`${platformPkg}/bin/${binaryName}`);  // 例如 @vscode/ripgrep-win32-x64/bin/rg.exe
export const rgPath = resolved;
```

在 asar 打包下，`asarUnpack` 会把文件**复制**到 `app.asar.unpacked`（而非移动），所以 `require.resolve` **仍然返回 `app.asar` 内的路径**。

`resolveRgPath()` 直接采用该路径：

```js
return (await import("@vscode/ripgrep")).rgPath;
```

随后 `ctx.subprocess.spawn({ argv: [rgPath, ...] })` 失败。

### 关键症状：`existsSync` 说 true，`spawn` 说 ENOENT

这是最容易误判的一点。实测埋点输出：

```
resolve-ok : ...\resources\app.asar\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe   exists: true
done-reject: spawn ...\app.asar\...\rg.exe ENOENT
```

原因：Node 的 asar shim 会拦截 `fs` 调用并**穿透归档**读取，所以 `existsSync` 返回 `true`；但 **`spawn` 需要磁盘上的真实文件**，归档内路径无法执行，故 `ENOENT`。

asar 头部标记证实 `rg.exe` 已正确解包，缺的只是路径改写：

```
in-archive  /node_modules/@vscode/ripgrep/lib/index.js                    ← wrapper 在归档内
UNPACKED    /node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe            ← 二进制已解包 ✅
```

### 讽刺之处：仓库里已有现成解法

DSH Desktop 的 `host.ts` **早已**为目录选择器解决过**完全相同**的问题，并写下了准确注释：

> Under Electron the URL of an unpacked entry is still reported as `…/app.asar/…`, because `asarUnpack` COPIES to `app.asar.unpacked` rather than moving. `spawn` cannot execute a path that exists only inside the archive, so the child dies immediately…

其解法是 `useUnpackedDshTree()`：

```js
function useUnpackedDshTree(anchor: string): string {
  const asarSegment = `app.asar${sep}`;
  if (!anchor.includes(asarSegment)) return anchor;
  const unpacked = anchor.replace(asarSegment, `app.asar.unpacked${sep}`);
  return existsSync(unpacked) ? unpacked : anchor;
}
```

**ripgrep 从未得到同等待遇。** 该方法属于 Electron 壳，DSH 包自身不该依赖它——DSH 应当内建等价能力。

### 建议修复（二选一）

**方案 A（推荐）** —— 在 DSH 侧内建 asar 路径改写，供所有「需要 spawn 的包内二进制」共用：

```js
function unpackAsarPath(p) {
	const marker = `app.asar${sep}`;
	if (typeof p !== "string" || !p.includes(marker)) return p;
	const unpacked = p.replace(marker, `app.asar.unpacked${sep}`);
	return existsSync(unpacked) ? unpacked : p;
}

function resolveRgPath() {
	rgPathPromise ??= Promise.resolve().then(async () => {
		const executable = parse(process.execPath);
		const executableSidecar = process.platform === "win32"
			? join(executable.dir, `${executable.name}-rg.exe`) : `${process.execPath}-rg`;
		if ("pkg" in process && existsSync(executableSidecar)) return executableSidecar;
		return unpackAsarPath((await import("@vscode/ripgrep")).rgPath);
	});
	return rgPathPromise;
}
```

**方案 B** —— 不依赖 `require.resolve`，改为从 `process.resourcesPath` 直接定位，从根本上绕开归档路径。

### 📌 打包方须知（对 Electron 壳作者）

`asarUnpack` 必须同时覆盖 ripgrep 的**两半**。`@vscode/ripgrep-win32-x64` 是 **optionalDependency**，不会被隐式带上：

```js
asarUnpack: [
  '**/*.node', '**/*.dll', '**/*.exe', '**/*.wasm',
  '**/node-pty/**', '**/koffi/**', '**/@koromix/**',
  'node_modules/@deepseek-ai/**',
  // ...

  // 同时提供 wrapper 与平台二进制；只带 wrapper 会让 require.resolve 抛 MODULE_NOT_FOUND
  '@vscode/ripgrep/**/*',
  '@vscode/ripgrep-win32-x64/**/*',
],
```

> 注：此条属于打包方配置，不是 DSH 自身的缺陷，但极易踩坑，故一并记录。

---

## 验证方式

修复后逐项实测通过：

| 工具 | 验证内容 | 结果 |
|---|---|---|
| `pwsh` | `sum(1..5) = 15`、管道、`node --version` | ✅ |
| `glob` | `**/*.mjs` 返回 53 项；跨目录 `**/*.ts` | ✅ |
| `grep` | 全库检索返回 84 处匹配（含行号） | ✅ |

定位 BUG 2 时使用的是**运行时埋点**（在 `resolveRgPath` / `spawn` / `handle.done` 三处记录真实异常），而非静态推断。这一点很关键：`SearchError` 会把底层 `cause` 吞掉，会话转录中也不保留，仅靠读代码无法得到 `ENOENT` 这一决定性证据。

---

## 给上游的最小复现要点

1. Electron 壳中以内嵌方式（非 `dsh` CLI 子进程）启动 host。
2. 打包时 `asarUnpack` 覆盖 `@deepseek-ai/**`。
3. 触发任一子进程工具 → BUG 1。
4. 触发 `glob`/`grep` → BUG 2。

两个 bug 都**不依赖 Windows Job Object**；在 macOS / Linux 的 Electron 打包环境下同样会出现（Linux 走 systemd-scope 路径，但 BUG 1 的 `process.execPath` 问题一致存在）。

---

## 附：为什么容易误判

| 表面现象 | 直觉误判 | 实际原因 |
|---|---|---|
| 「exited with **exit code 0**」 | 进程正常退出，是 job object 计数校验有缺陷 | 空转的第二个 Electron 实例的退出码；runner 根本没跑 |
| `glob`/`grep` 同时挂 | 共同底层 spawn 基础设施故障 | BUG 1 确实同时影响二者；但 BUG 2 是**独立**的第二层故障，修好 BUG 1 后 `glob`/`grep` **仍会失败** |
| `existsSync` 返回 `true` | 文件存在，路径没问题 | asar shim 穿透归档；`spawn` 需要真实文件 |
| 间歇性自愈 | 句柄泄漏 / 状态污染 | 单实例锁的启动竞态 |
| 重启客户端无效 | 需重装 | 重启不改变上述任一代码缺陷 |
