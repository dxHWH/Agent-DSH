# Agent loop 定制能力评估

[English](agent-loop-customization.md) | 中文

> 问题：DSH 能否修改内部的 agent loop？如果当前版本不行，从源码运行是否可行？
> 方法：读取 `dsh-agent-loop` / `dsh-agent` 的类型契约与编译产物，并**实际启动插件树做替换实验**。
> 脚本：`scripts/audit-agent-loop.mjs`、`scripts/experiment-replace-loop.mjs`

---

## 结论

**能改，且有三条路径，粒度不同。当前安装版本（`0.1.5-rc.2`）就够用 —— 不需要从源码运行。**

| 路径 | 粒度 | 是否需要源码 | 实测 |
|---|---|---|---|
| 1. 配置 | 调整 loop 的参数 | 否 | 已验证 |
| 2. 生命周期钩子 | 在 loop 的关键节点拦截/改写 | 否 | 已确认存在 |
| 3. 替换整个 `AgentFactory` | 换掉整个 loop 驱动 | 否（但需禁用内置行） | **已验证可行** |

**"从源码运行"不是必需的** —— 它是为改 DSH 自身代码准备的，而替换 loop 并不需要改 DSH 的代码。

---

## 术语对照

| 英文 | 中文 | 含义 |
|---|---|---|
| agent loop | 智能体循环 | 「调用模型 → 执行工具 → 再调用」的主驱动 |
| turn / step | 轮次 / 步 | 一轮对话；一步是一次模型调用及其工具执行 |
| factory | 工厂 | 负责创建与恢复 agent 的对象 |
| waterfall | 瀑布式分发 | 监听器依次改写值，链式传递 |
| serial | 顺序分发 | 监听器按注册顺序被通知，不改写值 |
| hook | 钩子 | 可供插件挂载的扩展点 |
| composition | 组合 | 多个 patch 层叠加后的最终插件树 |

---

## 一、loop 的扩展点（实测盘点）

`dsh-agent-loop` 通过三类分发调用扩展点。实测扫出的全部钩子：

| 钩子 | 分发方式 | 作用 |
|---|---|---|
| `agent/pre-step` | waterfall | 每一步开始前，可改写或拒绝该步 |
| `agent/request` | waterfall | 组装模型请求时，可改写 provider/model 等 |
| `agent/request-error` | waterfall | 请求失败时，返回 `{ kind: 'retry' }` 可重试 |
| `agent/turn-stopping` | serial | 轮次停止时通知，可用于实现轮次预算 |

**共 4 个钩子**（waterfall 3 个 + serial 1 个，无 bail）。

这是**官方的扩展契约** —— loop 的 README 明确说
*"a policy that bounds runaway turns must cancel from an existing lifecycle extension point
such as `agent/turn-stopping`"*，即官方指引用这些钩子实现自定义策略，而非改 loop 源码。

---

## 二、替换整个 loop：实测结果

### 关键约束

`AgentRegistry.setFactory` 的文档写着：

> **"Throws if a factory is already registered."**

而 `dsh-agent-loop` 在构造时自己调用 `ctx.agents.setFactory(this)`（编译产物中已确认）。
**所以不能直接覆盖 —— 必须先把内置行禁用掉。**

### 实测（`scripts/experiment-replace-loop.mjs`）

| 实验 | 操作 | 结果 |
|---|---|---|
| A | 原生 loop 在位时注册第二个 factory | **被拒绝**：`Error: an agent factory is already registered` |
| B | patch 禁用 `agent-loop` 行后再注册 | **成功接受** |
| C | patch 能否到达 loop 的 config | **能**，`maxParallelToolCalls: 3` 生效 |

```
verdict: replaceable: disabling the built-in row frees the factory slot for a custom driver
```

### 替换方式

`AgentFactory` 是**公开接口**（定义在 `dsh-agent`，而非 loop 包内），只需实现两个方法：

```ts
interface AgentFactory {
  createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>
  resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle>
}
```

`dsh-agent` 的文档明确说明这是有意设计：

> *"Kept on the `dsh-agent` interface so consumers program against `ctx.agents`
> without depending on the concrete `dsh-agent-loop` package."*

组合上这样做：

```yaml
# desktop-profile/cordis.patch.yml
- id: agent-loop
  disabled: true          # 释放 factory 槽位
- insert:
    - id: my-agent-loop
      name: './my-agent-loop.js'   # 你的自定义实现
```

### ⚠️ 代价：替换 factory 等于重写整个驱动

`AgentFactory` 的两个方法看着简单，但契约注释里列出的职责很重：

- 创建私有 session、具体 agent、作用域 context（**一个带回滚保护的事务**）
- 依次发出 `session/created` → `agent/created` → `agent/session-start`
- 接入持久化：`persistence.create(header)` / `persistence.open(id, 'write')`
- 管理写入句柄的所有权

loop README 的措辞是`"Choose a custom Agent implementation only when the standard
'call model, run tools, repeat' lifecycle is insufficient."`
—— 官方自己把它定位成**最后手段**，不是常规扩展方式。

---

## 三、配置路径（最轻）

`agent-loop` 行接受 patch config，实测可到达：

```yaml
- id: agent-loop
  config:
    maxParallelToolCalls: 3      # 每步并行的安全工具调用上限，1 为串行
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
        reasoningEffort: high
        cwd: /workspace
```

`maxParallelToolCalls` 同时是 `agent-loop` settings 命名空间，
**用户层可以在运行中调整，无需重启**。

---

## 四、"从源码运行"是否可行？

### 官方怎么说的

`@deepseek-ai/dsh` 的 README（第 54-56 行）：

> *"Production runs require built package and frontend artifacts. From the repository
> root, run `pnpm run build` separately, then use `pnpm dsh <args...>` to run the
> TypeScript entry and forward every argument; the source-execution reference owns
> the module-resolution contract."*

即：克隆仓库 → `pnpm run build` → `pnpm dsh <args>`。

### 但它解决的是另一个问题

从源码运行能让你改**DSH 自身的代码**（比如直接编辑 `dsh-agent-loop/src/agent.ts`）。
而我实测确认的替换路径**不需要改 DSH 代码** —— 它是官方设计好的扩展接缝。

### 一个已确认的缺口

README 引用的 `reference/README.md#source-execution`（模块解析契约的权威来源）
**没有包含在 npm 包里**：

```
node_modules/@deepseek-ai/dsh/ 下只有 README.md 与 README.zh.md
reference/ 目录不存在
```

所以如果你要改 DSH 自身代码，那份契约文档需要从 GitHub 仓库获取。
README 里引用的其他决策记录（`.agents/notes/implemented/**`）同样不在包里。

---

## 五、该选哪条路径

| 你的目标 | 推荐路径 |
|---|---|
| 调整并行度、模型路由、工作目录 | **配置**（改 patch，1 行） |
| 限制失控轮次、审计每次请求、失败重试策略 | **生命周期钩子**（写一个插件监听 `agent/*`） |
| 完全不同的 agent 生命周期（如自定义规划器、多模型编排） | **替换 `AgentFactory`**（禁用内置行 + 自实现） |
| 修改 loop 自身的内部实现细节 | **从源码运行**（npm 包只有编译产物） |

前三条在当前安装版本上都能做。只有第四条需要源码。

---

## 六、复现

```bash
npm run audit:agent-loop        # 扩展点盘点
npm run experiment:replace-loop # 替换可行性实测
```

---

## 七、证据强度

- **实测确认**：4 个钩子的存在与分发方式；factory 排他性（实验 A）；
  禁用后可替换（实验 B）；patch config 到达 loop（实验 C）
- **读取类型契约确认**：`AgentFactory` 接口定义位置与两个方法签名；
  `setFactory` 的排他性文档；`AgentLoop implements AgentFactory`
- **未验证**：自定义 `AgentFactory` 的**完整实现**能否真正跑通一轮对话。
  本实验只验证到「注册被接受」，未实现一个功能完整的驱动
  —— 那是可观的工作量，且属于你决定替换后才需要投入的部分。
- **不在 npm 包内**：`reference/README.md`（源码运行契约）、
  `.agents/notes/implemented/**`（设计决策记录）
