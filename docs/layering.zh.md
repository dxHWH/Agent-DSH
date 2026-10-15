# 专用 Agent 与模式切换：需求落在哪一层

[English](layering.md) | 中文

> 问题：如果用桌面版自己实现专用 agent 与模式切换，这一层需求落在哪一层？
> 方法：实测桌面组合的平面归属，核对 shell 侧现有耦合。
> 脚本：`scripts/audit-layering.mjs`
> **本文不涉及任何具体工程的代码或结构。**

---

## 结论（先读这段）

**这个需求的主体不落在任何"代码层"上 —— 它落在数据层。**

| 组成部分 | 落在哪 | 由谁拥有 |
|---|---|---|
| 专用 agent 的定义 | **数据** —— `<dshHome>/.agent-presets/` | DSH 的 discovery 机制 |
| 切换逻辑 | **host 平面** —— `dsh-agent-presets` 服务 | DSH 内置 |
| 切换界面 | **client 平面** —— `dsh-client-ui-agent-preset` | DSH 内置 |
| 桌面壳的角色 | **shell 平面** —— 只做"播种"与"入口" | 本项目 |

**所以正确的架构是：桌面壳不"实现"专用 agent，而是"提供"它。**

壳层做两件事：

1. **首次运行时播种** preset 文件（就像已经做的中文语言播种）
2. **提供入口**（菜单项、快捷键、可能的"打开 preset 目录"）

**不应该做**：在壳层里维护一份 preset 副本。那会立即产生双重真相。

---

## 一、三个平面的实测边界

DSH 的组合分成三个平面，混淆它们是这类工作出错的主要原因。

### 实测数据

```
planes: {
  totalEntries: 152,
  agentPlaneRows: 12,      <- 一个 preset 拥有的
  hostPlaneRows: 140,      <- 进程级单例，preset 不能拥有
  presetRosterIsHostSide: true
}
```

### agent 平面（12 行）

一个 preset 的 `agent.cordis.yml` 定义的行，实测样本：

```
tool-bash, tool-pwsh, tool-jobs, tool-fs, tool-fs-search,
agent-instructions, skill-filesystem, tool-skill,
command-goal, tool-todo, tool-goal, tool-web
```

这些是**每个会话需要一份**的东西：工具、Skills、指令。

### host 平面（140 行）

**进程级单例**，preset 不能拥有。实测其中的关键行：

```
llm, session, settings, credentials,
session-persistence-jsonl, sandbox, approval
```

官方 `standard` preset 的注释解释了为什么：

> *"A service row here MUST sit inside a group carrying an `isolate` realm.
> Without one it publishes into the root realm, where it is process-global —
> another preset publishing the same name collides."*

即：host 平面的服务是进程全局的，**第二个 preset 发布同名服务会冲突**。

### shell 平面（本项目）

实测确认架构纪律执行到位：

| 文件 | 真实 DSH 导入 |
|---|---|
| `host.ts` | 2 处动态导入 |
| `paths.ts` | 0 |
| `locale.ts` | 0 |
| `settings.ts` | 0 |
| `tray.ts` | 0 |
| `window-state.ts` | 0 |
| `index.ts` | 0 |

`shellTouchesDshOnlyInHost: true` —— 壳层只在 `host.ts` 里接触 DSH。

**这条纪律正是本问题答案的基础**：壳层本来就不参与组合，所以"专用 agent"自然不该由壳层实现。

---

## 二、为什么专用 agent 属于数据层

### preset 是文件，不是代码

```
<dshHome>/.agent-presets/<id>/
├── preset.yml          # 显示名与描述
├── agent.cordis.yml    # agent 平面组合
└── skills/             # 可选
```

DSH 的 discovery 机制扫描这个目录，把找到的 preset 列进 UI 选择器。

**这意味着**：

| 性质 | 含义 |
|---|---|
| 无需编译 | 改 YAML 即刻生效（重启后） |
| 无需改壳层代码 | 壳层不需要知道有几个 preset |
| 随数据迁移 | 与 settings、凭据一起走 |
| 可回滚 | 删掉目录即可 |

### 壳层的正确角色：播种

这与已经实现的**中文语言播种**完全同构：

| | 语言播种 | preset 播种 |
|---|---|---|
| 目标 | `<dshHome>/settings.yaml` | `<dshHome>/.agent-presets/` |
| 时机 | 首次运行（DSH 读取前） | 首次运行（DSH discovery 前） |
| 原则 | **已有则绝不覆盖** | **已有则绝不覆盖** |
| 代码位置 | `src/main/locale.ts` | 新增 `src/main/presets.ts` |

**关键原则完全一致**：播种是"首次运行的默认值"，不是"策略"。
用户改过之后，壳层必须尊重他的改动。

---

## 三、模式切换落在哪

### 切换的四个环节

| 环节 | 平面 | 由谁实现 | 桌面壳需要做什么 |
|---|---|---|---|
| preset 发现 | host | `dsh-agent-presets` discovery | 无 |
| 切换 UI | client | `dsh-client-ui-agent-preset` | 无 |
| 切换动作 | host | `dsh-agent-presets` 服务 | 无 |
| 持久化默认值 | host | `settings.yaml` 的 `agent-presets.default` | 可播种 |

**桌面壳一个都不需要实现。** 因为桌面端加载的就是同一个前端产物，
切换器已经在那里了。

### 壳层可选的增强

如果想让桌面端体验更好，**唯一合理的增强**是给切换加一个入口：

| 增强 | 落点 | 说明 |
|---|---|---|
| 菜单项"切换模式" | shell | 打开主窗口并聚焦（不做 DOM 操作） |
| 快捷键 | shell | 同上 |
| "打开 preset 目录" | shell | 复用已有的 `openPath` IPC |
| "重新加载 preset" | shell | 重载渲染进程（已实测可行） |

这些都是**壳层在自己平面内的正当工作** —— 它们不碰组合，只提供入口。

---

## 四、明确不该做的事

| 反模式 | 为什么不行 |
|---|---|
| 在壳层维护 preset 副本 | 双重真相：DSH 改了文件，壳层的副本就过期 |
| 壳层直接改 `settings.yaml` 的 preset 选择 | 那是 DSH 的 settings 命名空间，壳层应只读 |
| 壳层解析 `agent.cordis.yml` | 那是 DSH 的组合语义，壳层不该理解 |
| 壳层 patch `agent-presets` 行 | 那会改变 host 平面的组合，超出壳层职责 |
| 用 DOM 选择器点击 DSH 的切换器 | 脆弱的隐式耦合，DSH 升级即失效 |

最后一条在实现"打开设置"按钮时已经体现过：我**刻意没有**去点 DSH 的设置项，
因为那是猜的选择器，DSH 一升级就会坏。

---

## 五、实测的补充发现

### 禁用 preset roster 不会改变组合条目数

实测：patch `disabled: true` 到 `agent-presets` 行后，
条目数**没有变化**（`disablingRosterChangesHostComposition: false`）。

**这不是 patch 失效** —— 而说明该行的 `disabled` 语义与普通行不同，
或者该行本身不在可 disable 的集合里。

**实践含义**：**不要在壳层尝试禁用 preset roster**。它是 host 平面的基础设施，
关掉它会让所有会话失去 preset 能力。

### `dsh plugin --profile desktop` 不可用

CLI 保留了 `desktop` 这个名称（此前已实测）。因此 preset 的创建不能走
CLI 的 authoring 命令，只能直接写文件。

这进一步支持"数据层"的定位：**壳层直接写 preset 文件是正当的**。

---

## 六、具体建议

### 目录结构（数据层）

```
<数据根>\
├── settings.yaml
├── .credentials.yaml
└── .agent-presets\
    └── <专用模式 id>\
        ├── preset.yml
        ├── agent.cordis.yml
        └── skills\
```

### 壳层代码（shell 平面）

新增 `src/main/presets.ts`，职责与 `locale.ts` 对称：

```
- 检查 <dshHome>/.agent-presets/ 是否存在目标 preset
- 不存在 -> 从打包内模板复制（模板只读）
- 存在   -> 不做任何事
```

再在菜单/设置窗口加一个"打开 preset 目录"入口（复用现有 `openPath` IPC）。

### 明确的分工表

| 工作 | 落在哪 | 由谁做 |
|---|---|---|
| 设计专用 agent 组成 | 数据 | 你（编辑 `agent.cordis.yml`） |
| 播种到用户数据区 | shell | 壳层新增 `presets.ts` |
| 在 UI 中列出 | host | DSH 自带 |
| 切换 | client + host | DSH 自带 |
| 加一个入口按钮 | shell | 壳层 |
| 让它随数据迁移 | — | **自动**（同在数据根下） |

---

## 七、回答

> **这一层需求落在哪一层？**

**主要落在数据层**，具体是 `<dshHome>/.agent-presets/`。
host 与 client 平面由 DSH 提供，不需要开发。
**shell 平面只承担两件事：首次播种，以及提供入口。**

这个划分的好处是：专用 agent 的主体（组成定义、Skills）是**纯数据**，
因此它随数据迁移、可版本控制、可 diff、升级 DSH 不受影响。

**壳层代码量很小** —— 一个约 100 行的 `presets.ts`（与 `locale.ts` 同构）
加上菜单项。

---

## 八、复现

```bash
npm run audit:layering   # 平面归属与壳层耦合实测
```

---

## 九、证据强度

- **实测确认**：agent 平面 12 行 / host 平面 140 行 / preset roster 在 host 平面；
  壳层除 `host.ts` 外零 DSH 耦合；禁用 roster 不改变条目数
- **读取契约确认**：preset 用户目录位置；`isolate` realm 的必要性
  （host 平面服务为进程全局）；`agent-presets.default` 是 settings 命名空间字段
- **未验证**：`presets.ts` 播种流程的完整实现（需编码后才能测）；
  禁用 roster 后条目数未变的**确切原因**（只观察到现象，未定位到代码）
