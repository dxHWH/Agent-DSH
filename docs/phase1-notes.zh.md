# Phase 1 实施记录 — 最小可用客户端

[English](phase1-notes.md) | 中文

> 状态：**完成并实测通过**
> 代码：`src/main/{index,host,paths}.ts`
> 环境：Electron 37.10.3（Node 22.21.1）、`@deepseek-ai/dsh@0.1.5-rc.2`

---

## 术语对照

| 英文 | 中文 | 含义 |
|---|---|---|
| plugin tree | 插件树 | 由全部 patch 层叠加而成的最终挂载结构 |
| entry | 条目 | 插件树中的一个挂载项 |
| pending | 等待中 | 依赖的服务尚未提供，条目挂着不激活 |
| inject | 注入声明 | 条目声明它需要哪些服务才能激活 |
| prepare callback | 准备回调 | `boot()` 挂载插件树之前的钩子 |
| commit | 提交（就绪） | 确认启动成功，放行注册在 `onReady` 上的工作 |
| spawn | 派生 | 创建子进程 |
| asar | Electron 归档 | Electron 的打包归档格式，内部文件不能被当作可执行路径 |

---

## 1. 成果

应用可以启动、在进程内启动 DSH 宿主，并加载真实 UI。实测日志：

```
[dsh-desktop] data root (userdata): C:\Users\<user>\AppData\Roaming\DSH Desktop\dsh-home
[dsh-desktop] anchor: <repo>\node_modules\@deepseek-ai\dsh\package.json
[dsh-desktop] profile: initializing <repo>\desktop-profile
[dsh-desktop] profile loaded: 2 bundle layer(s)
[dsh-desktop] listening on 127.0.0.1:54199
[dsh-desktop] loading http://127.0.0.1:54199/?token=***
```

独立验证：
```
GET /                              -> 401   （认证网关工作正常）
GET /assets/index-BKQ_L1z6.js      -> 200, 555,959 bytes  （与源文件字节数一致）
```

**方案 A 端到端成立。**

---

## 2. 三个必须解决的技术障碍（均已实测解决）

### 2.1 Electron 内置 Node 版本不足

**症状**：插件树加载失败，报三个缺失的内置模块导出：
```
node:zlib   不提供 createZstdCompress
node:util   不提供 getSystemErrorMessage
node:module 不提供 stripTypeScriptTypes
```

**根因**：Electron 33 内置 Node **20.18.3**，而 DSH 需要 Node 22+
（`zstd` 是 22.15+，`stripTypeScriptTypes` 是 22.13+，`getSystemErrorMessage` 是 22.14+）。

**解决**：升级到 **Electron 37.10.3（Node 22.21.1）**，四个 API 全部到位。

**这是硬性约束**：Electron 33 及更早版本无法运行 DSH。

### 2.2 主进程必须是 ESM

**症状**：`ERR_REQUIRE_ESM` —— DSH 全部包是 `"type": "module"`。

**解决**：`tsconfig.json` 用 `"module": "ES2022"`，`package.json` 加 `"type": "module"`。
Electron 28+ 支持 ESM 主进程。

### 2.3 缺少 `provideCmdline` 导致 11 个条目永久 pending

**症状**：
```
dsh-desktop: 11 entries did not activate
@deepseek-ai/dsh-web-app/startup: pending (waiting for service: cmdlineArgs)
@deepseek-ai/dsh-host-webserver:   pending (waiting for service: webStartup)
...
```

**根因**：`web-startup` 注入 `cmdlineArgs`，把它解析成 `webStartup` 服务；
webserver 等行再注入 `webStartup`。没有 `cmdlineArgs` 就整条链断掉。

**解决**：在 `boot` 的 prepare 回调里调用
```ts
provideCmdline(hostCtx, { args: [...], exit, ready })
```

`appReady` 也必须提供：它在 boot 成功后 `commit()`，用于放行生命周期工作。
提交时机很关键 —— 不能在 boot 失败时触发，否则会掩盖真实错误。

---

## 3. Patch 语义陷阱（重要）

**patch 条目的 `config` 是整体替换，不是合并。**

实测证据（`scripts/diagnostics/check-patches.mjs`）：当桌面 patch 只写了
`config: { printUrl: false, surfaceContext: true }` 时，组合结果是：

```json
{ "printUrl": false, "surfaceContext": true }
```

`openBrowser` **消失了**，并回落到插件 schema 默认值 `true` ——
结果就是 DSH 在 Electron 背后偷偷打开了系统浏览器。

**正确做法**：把该行需要的每个字段都重写一遍。

```ts
{ id: 'web-runtime', config: {
    openBrowser: false, printUrl: false, surfaceContext: true, trustedHosts: [],
} }
```

这条陷阱值得警惕：patch 看起来像「覆盖某几个键」，实际是「替换整个 config 对象」。

---

## 4. 启动参数契约

`provideCmdline` 的 `args` 直接交给 commander 的
`program.parse(args, { from: 'user' })`。

实测（`scripts/diagnostics/check-cmdline.mjs`）：

| args | action 是否运行 | 结果 |
|---|---|---|
| `['--no-open', '--port', '0']` | 是 | `openBrowser: false, port: '0'` |
| `['web', '--no-open']` | 否 | `excessArguments` |
| `['dsh --profile web', ...]` | 否 | `excessArguments` |

即：**不要包含程序名**，只传 flag。

最终采用 `['--no-open', '--port', '0']`：
- `--no-open` 让 `openBrowser` 为 false（双保险，与 patch 一致）
- `--port 0` 让 OS 分配端口，`readPort` 再读回真实值

---

## 5. 数据根与可移植性（对应「迁移到其他 Windows 机器」要求）

`resolveDshHome()` 的优先级是 **显式配置 > `$DSH_HOME` > `~/.dsh`**。

桌面壳在**导入任何 DSH 模块之前**设置 `process.env.DSH_HOME`，
时机是关键 —— DSH 在 import 时解析 home。

实测结果，DSH 启动后在 `dsh-home` 下自动生成了全部用户数据：
```
%APPDATA%\DSH Desktop\dsh-home\.credentials.yaml      ← API 凭据
%APPDATA%\DSH Desktop\dsh-home\.anonymous-user-id
%APPDATA%\DSH Desktop\dsh-home\storages\workspace.json
```

**没有文件落在 `dsh-home` 之外。**

`src/main/paths.ts` 支持四种数据根模式：

| 模式 | 位置 | 用途 |
|---|---|---|
| `userdata` | `%APPDATA%\DSH Desktop\dsh-home` | 默认 |
| `portable` | 可执行文件旁的 `dsh-data\dsh-home` | 整个文件夹可拷走 |
| `custom` | 用户指定绝对路径 | 放共享盘/同步盘 |
| `env` | 尊重外部 `$DSH_HOME` | 高级用户、CI |

选择记录在执行文件旁的 `desktop-shell.json`（只存「数据在哪」，不存数据本身），
因此便携部署拷走整个目录即可。

---

## 6. 关于「保留配置 API 的接口」要求

**没有新建任何平行配置存储。** 这是有意的设计：

- 凭据走 DSH 的 `.credentials.yaml`（`ctx.credentials`）
- 设置走 DSH 的 `settings.yaml`
- 二者都在 `dsh-home` 下，由 DSH 自己的 Settings UI 管理

桌面壳**不旁路、不复制、不缓存**这些值，所以：

1. DSH 官方的模型/凭据设置界面原样可用（已决策：复用而非自建）
2. 在桌面端配好的 key，用 `dsh web` 打开同一个 `DSH_HOME` 也能直接用
3. 迁移时凭据随 `dsh-home` 一起走

`host.ts` 是唯一接触 DSH API 的文件，且它只做启动与端口/token 获取，
不触碰设置或凭据 —— 这条纪律保证了上述性质。

---

## 7. 遗留与下一步

- **HMR 未启用**：DSH 的 HMR 服务要求 Node 的 `--expose-internals`，
  Electron 主进程启动后无法追加该标志。已改为不主动挂载，避免启动报错。
  profile 仍声明 `patchReload: live`，但不强制启用 watcher。
- **`node-pty` 原生构建**：`build/Release/pty.node` 不存在，但
  `prebuilds/win32-x64/` 带有完整预编译产物（`conpty.node`、`conpty.dll`、
  `OpenConsole.exe`），无需本地编译。这些原生二进制在打包时必须
  `asarUnpack`，否则子进程无法加载。**已在 Phase 3 处理并验证。**
- **托盘、窗口状态、原生能力**：Phase 2。**已完成。**
- **打包与 asar 对子进程 spawn 的影响**：Phase 3 首要风险。
  **已验证通过** —— 打包后应用能从解包目录正确提供前端资源。
