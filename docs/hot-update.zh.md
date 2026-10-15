# 桌面端热更能力评估

[English](hot-update.md) | 中文

> 问题：桌面客户端能否做到"热更"？
> 方法：把"热更"拆成四层分别实测，并做端到端实验验证可用路径。
> 脚本：`scripts/audit-hot-update.mjs`、`scripts/experiment-hot-update.mjs`

---

## 结论

**"热更"有四种含义，可行性差异极大。其中两层现在就能用，一层被 Electron 硬限制，一层需要架构改动。**

| 层 | 含义 | 可行？ | 依据 |
|---|---|---|---|
| **L1 组合热更** | 改插件组合，不重启 | **可行** | 实测：152 → 153 条目 |
| **L2 客户端插件热替换** | 换 UI 插件 bundle | **可行，但需重建监视器** | 组件已挂载 |
| **L3 宿主插件热替换** | 换 node 侧插件 | **不可行** | 需要 `--expose-internals` |
| **L4 DSH 版本升级** | 换 harness 版本 | **需架构改动** | 版本在安装包内 |

**最实用的一条路径：改组合 + 重载渲染进程 = 不重启 Electron 即可生效。**
已实测验证（`rendererSurvivedReload: true`）。

---

## 一、先厘清概念

"热更"在桌面端至少指四件不同的事，混为一谈会导致错误判断：

| 层 | 典型场景 | 用户感知 |
|---|---|---|
| L1 组合 | 启用/禁用/配置插件 | 界面功能变化 |
| L2 客户端插件 | 更新带 UI 的插件 | 某个面板变化 |
| L3 宿主插件 | 更新 node 侧逻辑 | 后台行为变化 |
| L4 DSH 本体 | 升级 harness 版本 | 整体能力升级 |

---

## 二、L1 组合热更：可行

### 机制

profile 声明 `patchReload: live`，宿主导出 `watchUserPatches` 监视 patch 文件，
改动后重新组合。

实测确认：

```
L1_compositionRecomposes: { before: 152, after: 153, changes: true }
L1_watchUserPatchesExported: true
L1_patchReloadDeclared: "live"
```

### 但要区分两件事

| | 是否生效 |
|---|---|
| **宿主侧**组合重算 | 是（watcher 驱动） |
| **已打开的界面**是否跟着变 | **不一定** —— 见 L4 |

这是关键区分：组合在宿主侧重算了，但已经加载的浏览器界面持有的是**旧的 boot 图**。

---

## 三、L2 客户端插件热替换：可行，但有个前提

### DSH 自带的机制

`dsh-client-hmr` 提供浏览器侧插件热替换：

- 宿主侧：stat 轮询 bundle，变化时通过 SSE `/plugins/events` 广播
- 客户端侧：收到 `rebuilt` 帧后，**原地替换该插件**（新 fiber、新组件状态），
  数据层（connection / Session 对象）**不受影响**

实测确认该组件在本桌面组合中已挂载：

```
L2_clientHmrPresent: true
L2_servesSSE: true
L2_pollsBundles: true
L2_rowMounted: true
L2_rowDisabled: false
```

### 前提：必须有"重建"发生

README 原文说得很清楚：

> *"The reload chain stays idle without a rebuild watcher: only a
> `pnpm run dev:web`-style process rewriting client bundles produces the rebuilds it reacts to."*

**它是纯开发机制** —— 没有 tsdown/vite 之类的 watch 进程在写 `lib/client.js`，
它就一直空闲，什么也不会发生。

**生产环境下的含义**：如果要做插件的生产热更，你需要自己提供"写 bundle"这一步
（例如下载新 bundle 到插件目录并触发重建）。

### 设计上的已知边界

| 边界 | 说明 |
|---|---|
| 状态会丢 | 替换的是新 fiber、新组件，React 状态不保留 |
| 无回滚 | 失败则 entry 停在 FAILED，不自动恢复旧 bundle |
| 粗粒度 | 有意为之，不支持 react-refresh 级的状态保持 |

---

## 四、L3 宿主插件热替换：被 Electron 硬限制

### 根因

`cordis-plugin-hmr` 要求 `ctx.loader.internal`：

```js
if (!this.ctx.loader.internal) throw new Error("--expose-internals is required for HMR service")
```

实测确认：

```
L3_requiresExposeInternals: true
environment.exposeInternalsPresent: false
environment.execArgv: []
L3_willThrowAtRuntime: true
```

### 为什么无法绕过

`--expose-internals` 是 **Node 进程启动标志**，必须在进程创建时传入。
Electron 主进程已经启动，**无法在运行中追加**。

### 可能的绕行（未验证）

这些都需要额外复杂度，且各有代价：

| 绕行 | 代价 |
|---|---|
| `NODE_OPTIONS` 环境变量 | Electron 默认忽略，且 `--expose-internals` 属于不允许通过 `NODE_OPTIONS` 传递的类别 |
| 把宿主放到独立 Node 子进程 | 失去"同进程启动"的全部优势（端口/token 传递、生命周期） |
| 用 `utilityProcess` 承载宿主 | 需要重构 `host.ts`，且要解决服务注册表跨进程问题 |

**建议：接受 L3 不可用。** 宿主插件更新走"改配置 + 重载渲染进程"或重启应用。

---

## 五、L4 组合改动如何到达已打开的界面

这是最实用的一层，实测已验证。

### 关键机制

渲染进程重载时，会**重新向宿主请求 boot 图**。因此：

```
改 patch → 宿主重算组合 → 重载渲染进程 → 界面看到新组合
```

**全程不需要重启 Electron。**

### 实测结果

```
domBeforeChange:     { rootChildren: 1, title: "DeepSeek Harness", hasLoader: true }
domAfterReload:      { rootChildren: 1, title: "DeepSeek Harness", hasLoader: true }
rendererSurvivedReload: true
electronRestartRequired: false
```

界面在重载后**完整恢复**（React 挂载、标题、模块加载器都在）。

### 这意味着什么

| 场景 | 是否需要重启应用 |
|---|---|
| 改组合（启用/禁用/配置） | **不需要** —— 重载渲染进程即可 |
| 更新客户端插件 bundle | 不需要（L2 机制或重载） |
| 更新宿主插件 | 需要重启（L3 限制） |
| 升级 DSH 版本 | 需要重启（且需架构改动） |

---

## 六、实用方案：桌面热更按钮

基于以上实测，可以做一个**不重启应用的热更**：

```
1. 应用监视数据区的 profile（或提供"检查更新"按钮）
2. 检测到 patch/插件变化
3. 宿主侧重新组合
4. 主进程调用 win.webContents.reload()
5. 界面无缝刷新到新组合
```

**已实测成立的组件**：

| 组件 | 状态 |
|---|---|
| 宿主重新组合 | 可行（`watchUserPatches`） |
| 渲染进程重载 | 可行（实测 UI 完整恢复） |
| SSH/轮询检测变化 | 需实现 |
| 界面提示"已更新" | 需实现 |

**工作量评估**：小到中等。核心机制都已存在，主要是把它们串起来并加上用户提示。

### 一处需要注意的设计问题

重载渲染进程会**中断当前正在进行的工作**（如果正在流式输出）。

建议：
- 在空闲时才能触发（或明确警告）
- 或只在会话未激活时自动热更

---

## 七、L4 的完整形态：DSH 版本热更

如果要连 **DSH 本体**也热更，需要先完成 `self-maintenance.zh.md` 中的架构改动：
把 DSH 安装树移到数据区，使其可被独立替换。

之后流程：

```
1. 下载新版 DSH 到数据区的临时目录
2. 校验完整性
3. 停止宿主（dispose）
4. 原子替换 dsh/ 目录
5. 重新 startHost()
6. 重载渲染进程
```

**这比"重启应用"对用户更友好**（窗口不消失），但复杂度显著更高，
且需要处理替换失败的回滚。

**建议顺序**：先做组合热更（第六节），它是其余的基础且风险低。

---

## 八、能力边界总结

| 能力 | 现状 | 需要做什么 |
|---|---|---|
| 改组合立即生效 | 宿主可行，界面需重载 | 串起来 + 用户提示 |
| 客户端插件热替换 | 机制已有 | 需要"重建"步骤（生产环境需自建） |
| 宿主插件热替换 | **不可行** | 接受，或重构为子进程架构 |
| DSH 版本热更 | 不可行 | 先做 self-maintenance 阶段 1、3 |
| 应用自身更新 | 不可行 | 接入 electron-updater + 签名 |

---

## 九、复现

```bash
npm run audit:hot-update          # 四层能力实测
npm run experiment:hot-update     # 端到端热更路径验证
```

---

## 十、证据强度

- **实测确认**：L1 组合重算（152→153）；L2 组件已挂载且未禁用；
  L3 需要 `--expose-internals`（且当前进程无此标志）；重载后 UI 完整恢复
- **读取契约确认**：`dsh-client-hmr` 的 SSE 机制与"需要重建监视器"的前提；
  `cordis-plugin-hmr` 的 `ctx.loader.internal` 要求；`/plugins` 的 combo 路径格式
- **未验证**：第六节"热更按钮"的完整实现；
  L3 的三种绕行方案（均未实验，代价已列出）
