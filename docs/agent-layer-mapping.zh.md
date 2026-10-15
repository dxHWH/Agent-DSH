# 专用 Agent 开发落在 L1–L4 的哪一层？

[English](agent-layer-mapping.md) | 中文

> 问题：用桌面版实现专用 agent 与模式切换，落在 **L1–L4** 的哪一层？
> 方法：逐部分实测映射（L1–L4 定义见 `hot-update.zh.md`）。
> 脚本：`scripts/audit-agent-layer-mapping.mjs`
> **本文不涉及任何具体工程的代码或结构。**

---

## 直接回答

**答案是分部分的 —— 不同部分落在不同层：**

| 工作部分 | 落在哪一层 | 是否需要开发 |
|---|---|---|
| 专用 agent 的定义（preset 文件） | **不属于 L1–L4** —— 是数据 | 是（你写 YAML） |
| preset roster 行（`agent-presets`） | **L1**（组合行）—— 但已随包挂载 | **否** |
| 切换界面（`ui-agent-preset`） | **L2**（客户端插件）—— 但已随包挂载 | **否** |
| 切换逻辑服务 | **L3**（宿主插件）—— 已随包挂载 | **否** |
| 改 agent loop 本身 | **L4**（DSH 版本升级） | 仅在必要时 |

**一句话结论：专用 agent 的主体是「数据」，最多附带一个 L1 组合行。不需要 L2、L3、L4。**

---

## 为什么主体不属于 L1–L4

L1–L4 是**热更分类**，描述的是"如何让改动生效"。而 preset 的主体**不是改动**，
它是 host 启动时读取的**数据**。

### 实测

```
partA_presetFiles: {
  location: "<dshHome>/.agent-presets",
  isCompositionRow: false,
  isData: true,
  layer: "none of L1-L4 — this is data, read by dsh-agent-presets discovery"
}
```

**新增一个 preset 不会新增任何 profile 行，也不会替换任何插件 bundle。**
它只是让 discovery 多发现一个目录。

这就是为什么用 L1–L4 问"落在哪层"会得不到整洁答案 ——
**这个需求的主体根本不在那个分类维度上。**

---

## 逐部分映射（实测）

### L1 —— 组合行

`agent-presets` 这个 roster 行**本身是 L1**（host 平面组合行）：

```
partB_rosterRow: {
  present: true,
  id: "agent-presets",
  name: "@deepseek-ai/dsh-agent-presets",
  disabled: false
}
```

**但它已随包挂载，你的工作不涉及改动它。**

如果要改（例如配置 preset 根目录），那是 L1 改动 —— 改 patch 即可，无需热更。

### L2 —— 客户端插件

切换界面是客户端插件：

```
partC_switcherUi: {
  present: true,
  id: "ui-agent-preset",
  isClientPlugin: true
}
```

**同样已随包挂载。** 只有当你需要**改这个选择器的外观或行为**时，才会落到 L2
（替换客户端 bundle）。

**当前需求不需要。**

### L3 —— 宿主插件

切换逻辑由 host 服务提供：

```
partD_switchingService: {
  present: true,
  id: "agent-presets",
  isHostService: true,
  needToReplace: false
}
```

**替换它才会落到 L3** —— 而 L3 在 Electron 中不可用（需 `--expose-internals`）。

**当前需求不需要替换。**

### L4 —— DSH 版本

只有当**agent loop 本身**必须改时，才落到 L4。

**当前需求不涉及** —— preset 改的是组成（工具集、persona、策略），不是循环实现。

---

## 操作层面的实际映射

这是唯一有实践意义的部分 —— **改动何时生效**：

```
partE_operationalLayer: {
  toAddAPreset: "需要宿主重启或渲染进程重载，discovery 才能看到它",
  reason: "discovery 在插件启动时读取 roster，而非每次按键时"
}
```

| 操作 | 生效方式 | 对应的层 |
|---|---|---|
| 新增 preset | 需重启宿主 / 重载渲染进程 | 邻近 L1（组合重算） |
| 编辑已有 preset 的组成 | 新会话自动拾取 | 无需热更 |
| 给 preset 加一个**已安装**的插件 | 该 preset 的组合行变化 | **L1** |
| 给 preset 加一个**未安装**的插件 | 需先装包 | 邻近 L4（依赖变更） |
| 改 loop 实现 | 换 DSH 版本 | **L4** |

---

## 汇总表

| 需求 | 层 | 现状 |
|---|---|---|
| 定义专用 agent | **数据** | 你写文件 |
| 让它在 UI 出现 | L1 行（roster） | 已挂载 |
| 切换界面 | L2 插件 | 已挂载 |
| 切换逻辑 | L3 服务 | 已挂载 |
| 改 loop | L4 | 不需要 |

**四层中的三层（L1 roster、L2 界面、L3 逻辑）都已经随 DSH 挂载，
你既不需要实现它们，也不需要热更它们。**

---

## 复现

```bash
npm run audit:agent-layer-mapping   # 逐部分层映射实测
npm run audit:hot-update            # L1-L4 能力本身
```
