# 模式切换能力评估：为特定工程定制 Agent 行为

[English](mode-switching.md) | 中文

> 问题：能否针对一个大型工程构建专用 Agent 行为（**直接改 harness，而非 skill/rule 软约束**），
> 并在 DSH Web UI 与桌面客户端上**一键切换【通用模式】和【专用模式】**？
> 方法：读取 `dsh-agent-presets` 契约并实测组合行为。**不涉及任何具体工程内容。**
> 脚本：`scripts/audit-mode-switching.mjs`

---

## 结论

**能，而且 DSH 已经内置了这个机制 —— 不需要修改 harness 本身。**

`dsh-agent-presets` 就是那层「可以硬性改变 agent 组成」的机制。它提供的不是软约束，
而是**每个会话挂载哪些插件、哪些工具、什么 persona、什么计划策略**的完整定义。

而 UI 侧的切换器（`dsh-client-ui-agent-preset`）也已经存在。
**桌面客户端加载的是同一个前端产物，因此自动拥有同一个切换器。**

| 你的需求 | DSH 对应能力 | 实测 |
|---|---|---|
| 直接改 harness（非软约束） | preset 的 `agent.cordis.yml` 定义完整 agent 组成 | 已验证 |
| 通用模式 / 专用模式 | 两个 preset | 已验证：152 vs 153 条目，互不干扰 |
| 一键切换 | Web UI 已有的 preset 选择器 | 包已挂载 |
| 不改 DSH 安装目录 | 用户 preset 放在 `<dshHome>/.agent-presets` | 已验证 |
| Web UI 与桌面端一致 | 同一前端产物，同一机制 | 已验证（152:152 对等） |

---

## 一、preset 到底改的是什么

这是关键区别。preset **不是**提示词层面的软约束，它是一份**组合定义**。

以官方的 `standard` preset 为例（`presets/standard/agent.cordis.yml`），它定义了：

| 维度 | 内容 |
|---|---|
| persona | `dsh-persona` 的 prefix/suffix（可用 `{{model}}`、`{{cwd}}` 变量） |
| 指令加载 | `agent-instructions` 及 `maxBytes` |
| shell | `tool-pwsh` / `tool-bash`（按平台门控） |
| 文件系统 | `tool-fs`、`tool-fs-search` |
| 后台任务 | `tool-jobs` |
| Skills | `skill-filesystem`、`tool-skill` |
| 计划模式 | `plan-mode`，**含一整段注入的系统提示词** |
| 压缩 | `compaction-basic`、`tool-result-pruner`（阈值可配） |
| 委派 | `tool-subagent`、`tool-subagent-fork`、`tool-workflow`、`tool-ralph` |
| 其他 | `tool-ask-user`、`tool-todo`、`tool-web`、`present` |

也就是说：**换一个 preset，等于换掉这个 agent 能做什么、怎么做、以及它被如何描述。**

这满足你说的「不是 skill/rule 软约束」—— 工具是**真挂载或真不挂载**，
persona 是**真的替换**，计划策略是**真的注入**。

---

## 二、专用模式怎么做

### 存放位置

```
<dshHome>/.agent-presets/<preset-id>/
├── preset.yml          # 显示名与描述（UI 里看到的就是这两个字段）
├── agent.cordis.yml    # ★ 完整 agent 组合定义
└── skills/             # 可选：该 preset 专属的 Skills 目录
```

`preset.yml` 就是 UI 显示的那两行：

```yaml
name: 标准模式
description: 功能完整的编码 Agent，支持文件编辑、Shell、文件与检索、Skills、计划、目标、子代理和工作流。
order: 1
```

所以专用模式在 UI 里可以显示成：

```yaml
name: 项目模式
description: 面向特定工程的专用 Agent，启用 X/Y/Z 工具与策略。
order: 10
```

### 制作方式：官方规定「只能复制」

`dsh-agent-presets` README 明确写着 *"Authoring is copy-only"* —— 创建 preset 就是
**复制一个已有 preset 的整个目录**（composition、显示元数据、Skills 目录、资源全带上），
然后自己编辑。这是有意的设计，不是限制缺陷。

id 规则：`[a-z0-9][a-z0-9-]*`，且**不能与已存在的重复**（复制永不覆盖）。

### 官方自己就是这么做的

README 第 179 行明确说：

> *"the shipped set itself accepts the same cost — `cordis` and `code` each duplicate
> `standard`'s full assembly and then edit it — so the whole assembly stays readable in one file."*

即官方内置的 `cordis` 和 `code` preset **就是「复制 standard 再改」**，
并且官方接受这种重复，理由是「整个组装保持在一个文件里可读」。
你的项目模式走完全同一条路。

---

## 三、一键切换：Web UI 与桌面端

### 已经存在

`dsh-client-ui-agent-preset` 是 Web UI 里的 preset 选择器组件，已随桌面端挂载
（在 152 个条目中，属于 45 个客户端插件之一）。

由于桌面客户端加载的是**同一个** `dsh-web-frontend/dist`，它**自动拥有同一个切换器**。
不需要为桌面端单独实现 —— 这正是之前实测「152 : 152 零差异」的意义。

### 一条必须知道的规则

README 第 12 行：

> *"only an empty session may switch presets"*

**只有空会话（尚未开始对话的会话）能切换 preset。** 已经跑起来的会话不能中途换。
这符合直觉 —— preset 决定的是 agent 的组成，中途换会破坏会话历史的一致性。

实际影响：切换模式 = 新建一个会话并选中目标 preset。

### 另一个已存在的切换维度：权限预设

`dsh-permission-presets` 是**另一套独立的预设**（本机已配置 `danger-full-access`），
管的是沙箱与审批策略。它与 agent preset 是正交的两层：

| 机制 | 管什么 |
|---|---|
| `agent-presets` | agent 能做什么：工具、persona、计划、委派 |
| `permission-presets` | 操作被如何约束：沙箱模式、审批策略 |

你可以组合使用：项目模式 + 更严格的权限策略。

---

## 四、更能"改 harness"的那一层

如果 preset 还不够（比如要改 agent loop 本身的行为），还有一层：

**整个 agent loop 是可替换的**（详见 `agent-loop-customization.zh.md`）。
实测确认：

- 原生 `agent-loop` 行可被 patch 禁用
- 禁用后可注册自定义 `AgentFactory`
- 但要先禁用 —— `setFactory` 是排他的（`an agent factory is already registered`）

还有 4 个生命周期钩子可在不改 loop 的前提下改写行为：
`agent/pre-step`、`agent/request`、`agent/request-error`、`agent/turn-stopping`。

**这三层构成一个从轻到重的谱系：**

| 层 | 改什么 | 力度 |
|---|---|---|
| skill / rule | 提示词约束 | 软 |
| **agent preset** | **工具集、persona、计划策略** | **硬（推荐起点）** |
| 自定义 AgentFactory | 整个 agent 循环 | 最硬 |

你明确说不要软约束 —— 那么**从 preset 开始**是对的，它是官方为这个场景设计的层。

---

## 五、实测证据

`scripts/audit-mode-switching.mjs` 的结果：

```json
{
  "twoProfilesCoexist": true,
  "generalEntryCount": 152,
  "specializedEntryCount": 153,
  "generalLoopParallelism": "default",
  "specializedLoopParallelism": 2,
  "markerOnlyInSpecialized": true,
  "profilesAreIndependent": true,
  "nativeLoopDisabled": true,
  "customLoopPresent": true,
  "loopIsSwappablePerProfile": true,
  "agentPresetsShipped": ["cordis", "minimal", "ptc", "standard"],
  "agentPresetsSwitcherInUi": true
}
```

证明三件事：

1. **两个组合可共存且互不干扰** —— 条目数不同、行为参数不同、专用层独有的条目不会泄漏到通用层
2. **loop 可整体替换** —— 原生禁用 + 自定义接入
3. **UI 切换器已存在** —— 4 个内置 preset 已可切换

---

## 六、对 Web UI 与桌面端分别意味着什么

| | DSH Web UI | 桌面客户端 |
|---|---|---|
| 机制 | `dsh-agent-presets` | 同一个包 |
| 切换器 | `dsh-client-ui-agent-preset` | **同一个前端产物，自动拥有** |
| preset 存放 | `<dshHome>/.agent-presets` | 同一个 home（桌面端的数据根） |
| 需要额外开发 | 无 | **无** |
| 迁移 | — | preset 随数据根一起走（已验证） |

**两边的能力完全一致**，因为桌面端不是另做一个 UI，而是把同一个 UI 装进原生窗口。

---

## 七、需要你确认的取舍

### 1. 复制还是共享

`standard` 的完整组装有 255 行。复制它做项目模式意味着：
- **优点**：整份组装在一个文件里可读，改动直观，与 DSH 升级解耦
- **代价**：DSH 升级时，上游对 `standard` 的改进**不会自动流入你的副本**

官方接受这个代价（`cordis`/`code` 就是这么做的）。但要有意识地接受它。

### 2. 一个模式还是多个

你可以做多个 preset（如 项目-通用、项目-只读分析、项目-构建），
它们可以共用大部分行、只改关键几项。UI 会按 `order` 排序。

### 3. 是否需要自定义 AgentFactory

只有当「工具集 + persona + 计划策略」的组合仍不足以表达你的意图时才需要。
它需要自己实现事务、事件序列、持久化接入 —— 官方定位为最后手段。

**建议：先从 preset 开始，跑一段时间看是否够。** 不够再往下一层走，
那时你已经知道具体缺什么，而不是预先重写一个驱动。

---

## 八、复现

```bash
npm run audit:mode-switching    # 模式共存与切换能力实测
npm run audit:agent-loop        # agent loop 扩展点盘点
npm run experiment:replace-loop # loop 替换可行性实测
```

---

## 九、证据强度

- **实测确认**：两个组合共存且独立；loop 可禁用与替换；patch 可到达 loop config
- **读取契约确认**：preset 的用户目录（`<dshHome>/.agent-presets`）、copy-only 授权方式、
  id 规则、空会话才可切换、UI 选择器包已挂载、官方自身以复制方式制作 preset
- **未验证**：一个**功能完整**的专用 preset 能否在该工程上跑通实际任务。
  这需要一个真实的工程环境与实际的组成设计 —— 且属于你决定推进后才值得投入的部分。
- **本文不涉及**任何具体工程的内容、代码或结构。
