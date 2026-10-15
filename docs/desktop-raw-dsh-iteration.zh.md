# 桌面客户端能否满足"在桌面端工作 + 迭代 raw DSH"的需求？

[English](desktop-raw-dsh-iteration.md) | 中文

> 最终需求：**在桌面客户端里日常使用，同时后续要迭代 raw DSH（插件、agent loop）。**
> 方法：实测桌面端的 DSH 解析路径、代码可改性、三条可行机制。
> 脚本：`scripts/audit-dev-loop.mjs`
> **本文不涉及任何具体工程的代码或结构。**

---

## 直接回答

**能满足。三条机制，今天就能用第一条。**

| 机制 | 做法 | 今天可用？ | 适合 |
|---|---|---|---|
| **M1 就地改** | 直接编辑 `node_modules/@deepseek-ai/*/lib/*.js` | **是** | 快速试验 |
| **M2 覆盖解析** | npm `overrides` 指向本地 checkout | 需配置 | 长期开发 |
| **M3 数据区 DSH** | 桌面端优先用数据区的 DSH | **否**（需小改动） | 分发场景 |

**核心事实：桌面端加载的 DSH 就在你自己的项目里，且可写。**

```
<repo>\node_modules\@deepseek-ai\dsh          ← 桌面端用的
<repo>\node_modules\@deepseek-ai\dsh-agent-loop
```

**不是只读的系统安装，是你项目里的普通依赖。** 这让"迭代 raw DSH"变得直接。

---

## 一、关键前提：编译产物可读可改

我实测了 `dsh-agent-loop/lib/index.js`（71267 字节）：

| 检验项 | 结果 |
|---|---|
| 有源码 `src/` | **否** |
| 有 source map | **否** |
| 具名函数 | **18 个** |
| 变量名保留 | **是** |
| 缩进保留 | **是** |

关键业务函数**全部可定位**：

```
executeToolCalls  (L512)
runGroup          (L530)
parseArguments    (L520)
appendToolCall    (L586)
ReactLoopAgent    (L64)
```

**真实代码片段**（证明可改性）：

```js
async function executeToolCalls(ctx, turn, step, toolCalls, signal, acceptContext) {
	const agent = ctx.agents.requireInitiator();
	const { session } = agent;
	const planned = toolCalls.map((block) => ({
		block,
		exec: {
			callId: block.id,
			name: block.name,
			arguments: parseArguments(block.arguments),
			agent,
			signal
		}
	}));
	// ...
}
```

**这是标准的 bundler 输出（esbuild/tsdown 风格），不是混淆代码。**
函数名、参数名、控制流全部可读，直接改是可行的。

---

## 二、M1：就地改（今天就能用）

### 做法

```powershell
# 直接编辑
notepad "node_modules\@deepseek-ai\dsh-agent-loop\lib\index.js"
# 重启桌面应用
```

**无需重新构建**（`lib/*.js` 就是运行时加载的产物），改完重启即可。

### 实测状态

```
entryIsWritable: true
needsRebuild: false
```

### 优势与代价

| | |
|---|---|
| 优势 | 零配置，改完即用 |
| 优势 | 无需构建步骤 |
| **代价** | **`npm install` 会覆盖** |
| 代价 | 改的是构建产物，不是源码 |
| 代价 | 难以做版本管理（除非把补丁存起来） |

### 必须配套的措施

既然 `npm install` 会覆盖，**改动必须落到可重放的脚本里**：

```
scripts/
└── patch-dsh/
    ├── 001-tool-execution-order.patch
    └── apply.mjs          # 在 postinstall 里跑
```

否则一次 `npm install` 就全部丢失。

---

## 三、M2：npm overrides（长期方案）

### 做法

```json
{
  "overrides": {
    "@deepseek-ai/dsh-agent-loop": "file:./vendor/dsh-agent-loop"
  }
}
```

把要改的包 vendor 到本地，npm 解析时指向它。

### 优势

| | |
|---|---|
| 改动是**普通文件**，可版本控制 | |
| 不受 `npm install` 覆盖 | |
| 可以逐步 vendor（只 vendor 要改的包） | |

### 代价

**DSH 包只有编译产物**，所以 vendor 过来仍然是编译产物。
如果你想要真正的源码编辑，需要：

```
1. 从 GitHub 克隆 deepseek-harness 仓库
2. pnpm run build（官方 README 说明的构建步骤）
3. overrides 指向构建产物
```

**这才能做到"改 TypeScript 源码 → 构建 → 桌面端生效"。**

### 一个需要注意的点

`overrides` 是按包名覆盖。如果你要改 `dsh-agent-loop`，
只需 vendor 它一个；但它与 `dsh-agent`、`cordis` 有耦合，改接口时要注意连带影响。

---

## 四、M3：数据区 DSH（分发时才需要）

### 现状

实测确认**当前不支持**：

```
M3_dataAreaDsh: {
  supportedToday: false,
  changeNeeded: "add an env-var override in resolveInstallAnchor()"
}
```

`host.ts` 直接 `require.resolve('@deepseek-ai/dsh/package.json')`，没有覆盖钩子。

### 改动很小

加一个环境变量覆盖即可：

```ts
function resolveInstallAnchor(): string {
  const override = process.env.DSH_DESKTOP_ANCHOR
  if (override && existsSync(override)) return override
  return require.resolve('@deepseek-ai/dsh/package.json')
}
```

**但这是分发场景的需求**（让用户能换 DSH），不是你现在开发场景的需求。

---

## 五、迭代循环长什么样

### 改 agent loop（M1）

```
编辑 node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js
        ↓
Ctrl+Q 退出
        ↓
npm start
        ↓
验证
```

**一次循环约 10–20 秒**（启动占大头）。

### 改插件

插件比 loop 更灵活：

| 插件类型 | 迭代方式 |
|---|---|
| 客户端插件（UI） | 改 bundle，重载渲染进程即可（**不需要重启应用**） |
| 宿主插件（node 侧） | 改 lib/*.js，重启应用 |
| preset 组成 | 改 YAML，重启（或重载渲染进程） |

**客户端插件那条最快** —— 已实测重载渲染进程后 UI 完整恢复。

### 不需要热更

如 `do-you-need-hot-update.zh.md` 所述：**开发阶段重启几秒即可，热更不值得做。**

---

## 六、一个必须正视的取舍

**你要在"编译产物"上迭代，而不是"源码"。**

| | 现在能做 | 更好但需投入 |
|---|---|---|
| 改代码 | 编辑 `lib/*.js` | 克隆源码仓库 + 构建 |
| 可读性 | 好（具名函数保留） | 原始 TypeScript |
| 类型检查 | 无 | 完整 |
| 升级上游 | 手动比对 | 可 rebase |
| 上手成本 | 零 | 需搭建构建环境 |

**我的建议**：

| 阶段 | 用什么 |
|---|---|
| 验证想法（改几行试试） | **M1** |
| 改动稳定下来（几十行以上） | 存成 patch 脚本 |
| 改动成为长期分支 | **M2 + 构建好的源码 checkout** |
| 要给用户分发 | M3 |

**不要一开始就搭源码构建环境** —— 先用 M1 验证想法值不值得投入，
再决定是否升级到 M2。

---

## 七、回答

> **桌面客户端能否满足"在桌面端使用 + 迭代 raw DSH"的需求？**

**能，而且今天就能开始。**

| 需求 | 满足方式 |
|---|---|
| 在桌面端日常使用 | 已实现（原生窗口 + 托盘） |
| 迭代插件 | M1 改 lib，或改 preset 组成 |
| 迭代 agent loop | **M1 改 `dsh-agent-loop/lib/index.js`** |
| 改动持久化 | patch 脚本 / M2 overrides |
| 不需要热更 | 开发阶段重启即可 |

**唯一的限制**：DSH 是 npm 安装的编译产物，没有源码。
但你项目里的这份副本**可写**，且代码**可读可改**，所以迭代是可行的。

**这个限制在 M2 + 源码 checkout 后就消失了** —— 那是你决定长期投入时的事。

---

## 八、复现

```bash
npm run audit:dev-loop   # 三条机制与代码可改性实测
```

---

## 九、证据强度

- **实测确认**：桌面端 DSH 解析到项目内；`lib/index.js` 可写；
  18 个具名函数、关键业务函数可定位；无 `src/`、无 source map；
  `host.ts` 无 anchor 覆盖钩子
- **读取契约确认**：npm `overrides` 的语义；官方 README 的源码构建步骤
  （`pnpm run build` + `pnpm dsh`）
- **未验证**：M1 改动后桌面端能否真正按预期运行（需实际改一处并验证）；
  M2 overrides 与 DSH 依赖树的实际兼容性
