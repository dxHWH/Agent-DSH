# 是否需要把项目里的 DSH 替换为源码版？

[English](replace-dsh-with-source.md) | 中文

> 决策问题：你的最终形态是「一个 button 切换通用模式 / 项目模式」，
> 其中 项目模式可能带一套自己的 harness（含改造过的 agent loop）。
> **这需要把项目里的 npm 版 DSH 换成源码版吗？**
> 方法：实测进程内组合切换、factory 槽位释放、两套 loop 共存性。
> 脚本：`scripts/audit-sequential-harness.mjs`、`scripts/audit-two-loops.mjs`
> **本文不涉及任何具体工程的代码或结构。**

---

## 直接回答

**需要。但不是因为"两套 harness 要做成源码"，而是因为你要改的包超出"改几行"的规模。**

| 你的改动 | 源码版是否必要 |
|---|---|
| 新增自有插件包 | **不必须**（插件本来就是外置的） |
| 改 agent loop 的逻辑 | **必要** —— 改的是别人发布的编译产物 |
| 长期维护一条自己的分支 | **必要** |

**一句话：源码版解决的是"改动所有权"问题，不是"能不能跑"问题。**

---

## 一、先纠正一个误解：两套 harness 不需要两个进程

你担心"两套 harness"很重。**实测结果表明比想象中轻。**

### 实测：销毁后可在同进程启动不同组合

```
firstBootDisposed:    true
secondBoot.succeeded: true
slotFreedByDispose:   true
```

**销毁插件树后，`AgentFactory` 槽位被释放，可以在同一进程内启动完全不同的组合。**

所以切换模式是：

```
通用模式 → dispose 当前组合 → 启动 项目模式组合 → 重载渲染进程
```

**全程同一个 Electron 进程、同一个窗口、同一个数据根。**

### 为什么这解决了 `setFactory` 冲突

之前的审计发现"两个 loop 不能共存"（`setFactory` 排他）。但**那是并行场景**。
你的需求是**顺序**的，所以冲突不存在 —— 前一个组合销毁后才启动下一个。

**结论：不需要两个进程，不需要两个端口，不需要并行常驻。**

---

## 二、那为什么仍需要源码版

因为**改动的性质**变了。

### 三种改动方式对比

| | 改 `lib/*.js`（M1） | 源码版 |
|---|---|---|
| 改几行试探 | 可以 | 可以 |
| 改 loop 的核心逻辑 | 可以，但难受 | **应该** |
| 新增/改接口 | **不现实** | 可行 |
| 类型检查 | 无 | 完整 |
| 长期维护 | 难以追踪 | 可 rebase |
| 上游更新 | 手工比对 | 可合并 |
| 打包进桌面端 | 需 patch 脚本 | 天然 |

你明确说了可能**改接口、新增插件**。**在编译产物上改接口是不可维护的** —— 你会失去类型检查、
重构能力，而且无法判断改动的连带影响。

### 官方自己的警告

DSH README 上有一句显著声明：

> **"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."**

`0.1.5-rc.2` 是 developer preview。**没有源码仓库，你无法跟随上游修复。**

---

## 三、源码版的真实成本

官方给出的流程（来自 `docs/development.md`）：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
```

### 前置条件（实测/文档确认）

| 要求 | 现状 |
|---|---|
| Node 22.19+ | 已有（v24.21.0） |
| **Corepack + pnpm@11.7.0** | **未安装** |
| Git 2.26+ | 已有（2.55.0） |
| 磁盘/时间 | 首次构建耗时较长 |

### 构建流程不是一步

文档描述的 `pnpm run build` 实际包含：

```
tsc -b tsconfig.host.json
tsdown --env.DSH_BUILD_FACE host
tsc -b tsconfig.client.json
tsdown --env.DSH_BUILD_FACE client
pnpm run build:web
```

还有 Typert 代码生成、lefthook git hooks、vendor 目录约束检查。

**这不是一个简单项目。** 你接受"环境不是问题"，所以这是可行的，
但要有心理预期：**首次搭建会有摩擦**。

---

## 四、但你不必全套源码化

这是关键建议。**源码仓库不必替掉 npm 版**，可以让两者并存。

### 推荐架构

```
<workspace>\
├── deepseek-harness\        # 源码仓库（你改这里）
│   └── pnpm run build       # 产出构建物
└── agent-desktop\           # 桌面端项目（本项目）
    ├── package.json
    │   └── overrides: { "@deepseek-ai/dsh-agent-loop": "file:../deepseek-harness/packages/core/agent-loop" }
    └── src\main\host.ts     # 指向 override 后的 DSH
```

**好处**：

| 效果 | 说明 |
|---|---|
| 改的是**源码** | 完整类型检查、重构能力 |
| 上游可合并 | 你的分支基于官方仓库 |
| 桌面端不动 | 只加 `overrides` 配置 |
| 可逐步接管 | 先只 override 你要改的包 |

### 关键：只需 override 你改的包

DSH 有 **240 个 `@deepseek-ai` 包**（实测）。你**不需要**全部源码化。

```json
{
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "file:../deepseek-harness/packages/core/agent-loop"
  }
}
```

**其余 239 个包继续用 npm 版。** 这大幅降低风险与构建负担。

---

## 五、项目模式的两种实现路径

基于实测，你有两个选择：

### 路径 A：纯 preset（不改 loop）

如果 项目模式只需要**不同的工具集、persona、策略**：

```
<dshHome>/.agent-presets/project/
├── preset.yml
└── agent.cordis.yml
```

**不需要源码版。** 这是最轻的路径。

**但**：preset 是 agent 平面，**不能承载 loop**（loop 是 host 平面，发布到 root realm）。

### 路径 B：换 loop（需要源码版）

如果 项目模式需要**不同的 agent loop 逻辑**：

```
1. 源码仓库：复制 dsh-agent-loop 为 dsh-agent-loop-project，改造
2. 桌面端 profile patch：
   - id: agent-loop
     disabled: true          # 停用原生 loop
   - insert:
     - id: project-loop
       name: '@your-scope/dsh-agent-loop-project'
3. 切换模式时：dispose + 重新 boot 组合
```

**这需要源码版**，因为你改的是别人的包。

### 判断标准

| 你的 项目模式需要 | 路径 |
|---|---|
| 不同工具、不同提示词、不同策略 | **A（preset）** |
| **不同 loop 逻辑**（如不同的 turn/step 机制） | **B（源码版）** |

**你自己说了"可能要将原生 agent loop 的逻辑复制过来之后修改"** ——
如果是这样，**答案是 B，需要源码版。**

---

## 六、我建议的推进顺序

| 阶段 | 做什么 | 为什么这个顺序 |
|---|---|---|
| 1 | **先用 preset 做 项目模式** | 验证"专用模式"的价值，零源码成本 |
| 2 | 观察 preset 是否够用 | 很多"需要改 loop"其实是配置问题 |
| 3 | 不够用时搭源码环境 | 此时你已明确知道要改什么 |
| 4 | override 单个包（agent-loop） | 最小化改动面 |
| 5 | 逐步扩大 | 按需 |

**第 1 步最重要**：它能在**不搭源码环境**的前提下，
验证 项目模式的产品形态（button 切换、UI 入口、会话隔离）是否成立。

**如果第 1 步就够用，你省下了整个构建链。**

---

## 七、回答

> **是否需要将项目里的 DSH 替换为源码版？**

**取决于 项目模式是否需要不同的 loop：**

| 场景 | 答案 |
|---|---|
| 项目模式只需不同工具/提示词/策略 | **不需要** —— 用 preset |
| **项目模式需要不同的 loop 逻辑** | **需要** —— 但只需 override 你改的包，不必全套源码化 |

**并且：两套 harness 不需要两个进程。**
实测确认销毁后可在同进程启动不同组合，所以"切换模式"是轻量的。

**建议先用 preset 验证产品形态，再决定是否搭源码环境。**
你已经说了"环境不是问题"，所以这是**时机**问题，不是**可行性**问题。

---

## 八、复现

```bash
npm run audit:sequential-harness   # 同进程内切换组合（关键实测）
npm run audit:two-loops            # 两套 loop 并行性
npm run audit:dev-loop             # 三条改动机制
```

---

## 九、证据强度

- **实测确认**：销毁后 `setFactory` 槽位释放，同进程可启动不同组合；
  `agent-loop` 是 host 平面行、不被任何 preset 引用；preset 可承载的能力清单；
  DSH 依赖树 240 个包
- **读取官方文档确认**：源码运行流程（`git clone` + `pnpm install` + `pnpm run build`）；
  构建的五个阶段；前置条件（Node 22.19+ / Corepack pnpm@11.7.0）；
  "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" 声明
- **未验证**：npm `overrides` 指向源码构建物的**实际可用性**（需真正搭建后验证）；
  项目模式 loop 的具体改造方式（取决于你的设计）
