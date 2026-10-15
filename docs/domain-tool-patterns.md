# 领域工具工程模式（技术思路沉淀）

> 读者：要在 DSH 上为某个具体工程 / 领域写"确定性查询工具"的人和 AI。
> 本文把一个生产级领域工具插件里沉淀下来的工程思路抽象成通用模式；每个模式都给出"为什么"，并指向 `packages/dsh-tool-example` 中的参考实现（骨架只演示模式，不含业务逻辑）。
> 规则摘要已写入 `AGENTS.md`；本文解释规则背后的原因。

---

## 0. 速览

| # | 模式 | 一句话 | 参考实现 |
|---|---|---|---|
| 1 | 确定性查询工具 | 领域问题交给工具，不让模型自己 glob/read 拼答案 | `src/index.ts`、`src/search.ts` |
| 2 | 统一结果协议 | `{status, answer, evidence[], artifacts[], payload}`，status 是封闭枚举 | `src/result.ts` |
| 3 | 证据与 locator | 每条结论带来源与定位，工程相对路径 | `src/result.ts`、`src/scoped_paths.ts` |
| 4 | 歧义 → 问用户 → 用 ID 续查 | `needs_input` + 候选列表 + `ask_user_question` | `src/result.ts`（约定） |
| 5 | 报告落盘 + present | 对话只给摘要，完整内容进文件 | `src/report_writer.ts` |
| 6 | lossless 输出 | payload 不得出现 `undefined` 键 | `src/result.ts` `toOutput()` |
| 7 | 工具速查 system prompt | 用一段系统提示把"意图 → 工具"讲清楚 | `src/index.ts` `example:tool-quickref` |
| 8 | 知识库兜底 | 消极结果追加固定标记与指令，由 agent 同轮调用知识库 | `src/kb_fallback.ts` |
| 9 | 持久化 SQLite 索引 | 代际文件 + 原子指针 + 锁 + 指纹 + 版本常量 | `src/sqlite/*` |
| 10 | 查询路径不建索引 | 失效则降级扫描 + 提示用户重建；重建在 worker 线程 | `src/index_hint.ts`、`src/main/index-manager.ts` |
| 11 | 文本归一化与召回 | NFKC、全半角、包装词剥离、n-gram 两阶段召回 | `src/text.ts`、`src/sqlite/query.ts` |
| 12 | 路径安全 | 拒绝绝对路径、`..`、symlink 逃逸，白名单根 | `src/scoped_paths.ts` |
| 13 | 数据源组合与受控降级 | 主格式优先，只在"文件不存在"时降级 | （模式说明） |
| 14 | 知识资产随包分发 | `knowledge/` 目录，按包根定位 | `knowledge/README.md` |
| 15 | 惰性单例 | 昂贵 reader / 索引句柄每插件实例一个 | `src/index.ts` `getIndex` |
| 16 | 组合能力 | 报告类工具内部编排原子能力 | （模式说明） |
| 17 | 只读取证子代理 | 三层结论：代码事实 / 调用链证据 / 推断 | （persona 模板） |
| 18 | 打包注意事项 | 插件依赖进 RUNTIME_DEPS 与 asarUnpack | `electron-builder.config.cjs` |

---

## 1. 确定性查询工具 vs 让模型自己 glob/read

**问题**：通用编码 Agent 拿到"X 在哪定义 / 配置在哪 / 哪些地方引用了 X"这类领域问题时，会用 glob/grep/read 自己摸索。结果是：

- 每次路径不同、覆盖不同，**答案不可复现**；
- 大工程里多轮读文件，**token 与时间成本高**，且容易因上下文截断漏掉结果；
- 模型会把"没读到"误当成"不存在"，**假阴性**严重；
- 领域里的隐含规则（注册表、命名约定、主/次数据格式）模型并不知道。

**模式**：把领域里**可以确定性回答**的问题封装成工具。工具负责：定位数据源、按领域规则解析、匹配、组装证据；模型负责：理解用户意图、选工具、解释结果、决定下一步。

**取舍准则**：

| 适合做成工具 | 留给模型 |
|---|---|
| 需要领域规则才能正确定位的数据（注册表、索引、命名映射） | 开放式的代码阅读与推理 |
| 需要全量扫描才能回答的"有没有 / 有哪些" | 需要跨领域综合判断的问题 |
| 结果需要可复现、可审计 | 一次性的探索 |

工具描述（`description`）里明确写"当用户问……时用本工具，**不要**用 glob/grep/read"——这是模型选工具的首要依据。参考 `src/index.ts` 中 `example_search` 的描述。

---

## 2. 统一结果协议与 status 语义

所有领域工具返回同一结构（`src/result.ts`）：

```ts
interface ToolResult {
  status: 'trusted_hit' | 'partial' | 'needs_input' | 'capability_gap' | 'execution_error'
  answer: string            // 给模型看的紧凑文本
  evidence: Evidence[]      // 每条结论的来源
  artifacts?: ArtifactRef[] // 写给用户的文件（必须 present）
  payload?: Record<string, unknown> // 结构化数据，给程序消费
}
```

| status | 含义 | 模型应当 |
|---|---|---|
| `trusted_hit` | 找到并已对照数据源验证 | 直接基于证据回答 |
| `partial` | 找到一部分，或"未找到" | 说明缺什么；若首行是"未找到"，可能触发知识库兜底 |
| `needs_input` | 输入有歧义或缺参数（候选在 payload） | 问用户，拿到 ID 后续查 |
| `capability_gap` | 超出本地工具能力 | 换路径（知识库、人工、子代理） |
| `execution_error` | 工具失败（参数错、文件不可读） | 修正参数重试一次，否则如实报告 |

**为什么是封闭枚举**：系统提示、兜底包装器、前端渲染都可以**按 status 分支而不必解析自然语言**。不要临时发明新 status；需要细分原因时放在 `payload.gap_reason` 之类的字段里（兜底逻辑就靠它区分"误用"与"能力不足"）。

`answer` 要**短**：首行即结论（兜底判定会读首行），细节放证据或报告。

---

## 3. 证据（evidence）与 locator

```ts
interface Evidence {
  kind: string        // 'file' | 'index' | 'knowledge' …
  source: string      // 工程相对 POSIX 路径，绝不是本机绝对路径
  locator?: string    // 源内的细粒度位置，如 'L42'、'sheet/row'
  claim?: string      // 这条证据支撑的结论
  verified: boolean   // 是否对照实时数据源验证过
}
```

要点：

- **工程相对路径**：结果会进对话、归档、报告，绝对路径既泄露机器信息又在别的机器上无意义。由 `ScopedPathResolver` 统一生成（`src/scoped_paths.ts`）。
- **verified 的诚实性**：来自索引但已逐条回读源文件确认的 → `true`；来自随包知识资产或推断的 → `false`。模型据此措辞（"已确认" vs "根据映射推测"）。
- **locator 让用户能跳转**：`path:Lnn` 是最通用的形式；结构化数据用"表/行键/字段"之类的路径。

---

## 4. needs_input：歧义候选 → ask_user_question → 用 ID 续查

当一个名字对应多个实体（同名、模糊匹配多个结果），**不要让工具猜**，也不要让模型猜：

1. 工具返回 `status: 'needs_input'`，`answer` 首行写"匹配到 N 个候选，请确认"，`payload.candidates` 给出 `[{id, label, hint}]`（`id` 是稳定、唯一、可直接回传给工具的键）。
2. 工具描述 / 系统提示要求模型调用 `ask_user_question`，把候选做成选项。
3. 用户选择后，模型用 **ID**（而不是名字）再次调用工具，此时结果唯一。

为什么用 ID 续查：名字在归一化后仍可能冲突；ID 让第二次调用是确定性的，并且可以在会话里复用。工具参数里同时支持 `name` 与 `id` 两种入口，`id` 优先。

注意：**歧义不是消极结果**——知识库兜底不应在此触发（见 §8）。

---

## 5. 完整结果落盘报告 + present 交付，对话只给摘要

长结果（上百条命中、完整档案、多段分析）直接塞进工具结果会：挤占上下文、被截断、模型复述时出错。

模式（`src/report_writer.ts`）：

1. 工具参数提供 `write_report`（或报告类工具默认落盘）；
2. 完整内容写到 `<会话工作区>/<reportDir>/<安全文件名>.md`，`reportDir` 来自插件配置（相对路径相对会话工作区）；
3. `answer` 只放摘要（总数 + 前若干条 + "完整报告见附件"）；
4. 返回 `artifacts: [{path, media_type, label}]`，`path` 相对会话工作区；
5. 工具描述与系统提示要求："返回 artifacts 时调用 `present` 交付"。用户得到一个文件卡片。

细节：文件名只保留字母数字、CJK、`-`、`_`，限长；`reportDir` 未配置时不落盘并在 answer 里说明。

---

## 6. payload 不得出现 undefined 键

DSH 对工具输出做 **lossless JSON** 校验：值为 `undefined` 的键无法 JSON 往返，会导致整个工具调用校验失败——而且在开发时极易被忽视（TypeScript 不会报错）。

```ts
// 错误：r.payload 不存在时会产出 { payload: undefined }
return { status, answer, evidence, payload: r.payload }

// 正确：只在存在时赋值
const out: Record<string, unknown> = { status, answer, evidence, artifacts: r.artifacts ?? [] }
if (r.payload !== undefined) out.payload = r.payload
```

统一走 `toOutput()`（`src/result.ts`），不要在每个工具里手写。payload 内部的嵌套对象同理：构造时跳过 undefined 字段。

---

## 7. 系统提示"工具速查" section，防止选错工具

只靠工具描述，模型在工具多、描述长时仍会选错（或干脆去 grep）。模式：插件注入一段**短小的**系统提示 section（`src/index.ts`）：

```ts
ctx.systemPrompt.section({
  name: 'example:tool-quickref',
  order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT') - 100,
  text: '…意图 → 工具 的映射表…',
})
```

要点：

- 按**用户意图**组织（"在哪 / 有哪些 / 值是多少 → 工具 X"），而不是按工具罗列参数；
- 写清"对已绑定工程的问题优先用这些工具而不是 glob/grep/read"；
- 写清约定的固定标记（兜底标记、artifacts → present）；
- 新增工具时**必须同步更新**这段（`AGENTS.md` 硬规则 13）；
- 一个主题一个 section（速查、兜底规则、输出格式要求……），用 `order` 控制相对位置；
- `ctx.systemPrompt` 可能不存在（例如被裁剪的组合）——容错跳过，不影响工具注册。

---

## 8. 知识库兜底（KB fallback）

**场景**：本地确定性工具答不了（查无此物、超出能力）时，应自动转向团队知识库（通常是一个 MCP 服务），而不是让模型说"没找到"就结束。

### 8.1 机制（`src/kb_fallback.ts`）

`registerTool()` 把每个工具包一层 `withKbFallback`：执行原工具 → `classifyNegative(result)` → 若为消极结果，在 `answer` 末尾追加**固定标记 + 指令**，并写入 `payload.kb_fallback = {required, tool, reason}`。status、证据等其它字段不变。系统提示里写明"看到该标记就按指令执行"。

### 8.2 消极结果判定规则

| 结果 | 兜底？ | 理由 |
|---|---|---|
| `capability_gap` | 是 | 本地能力之外 |
| `capability_gap` 且 `gap_reason` 为误用类（`unknown_operation`、`unsupported_operation`、`invalid_argument`…） | **否** | 是工具用错了，应改参数重试 |
| `partial` / `needs_input` 且**首行**为"未找到 / not found / 无匹配" | 是 | 本地查无此物 |
| `needs_input` 的歧义候选、缺参数 | 否 | 应该问用户（§4） |
| `execution_error` | 否 | 多为可纠正错误（路径写错等） |
| `trusted_hit` / 普通 `partial` | 否 | 已有答案 |

判定是**确定性代码**完成的；模型只负责执行已经做出的决定。这比"在提示词里告诉模型何时该查知识库"可靠得多。

### 8.3 工具不可见时静默

只在知识库工具**对当前 agent 可见**时才追加指令（`tools.get(kbTool, exec.agent)`）。未配置、被禁用、连接失败时什么都不加——**绝不指挥模型调用一个不存在的工具**，否则模型会编造调用或反复报错。

### 8.4 为什么由 agent 而不是工具内部调用 MCP

- **原话透传**：知识库通常要求 `user_question` 逐字填写用户原话（便于检索与审计），工具只看得到结构化参数，看不到用户原话；agent 看得到。
- **长任务**：知识库查询可能是分钟级甚至异步任务。工具内部阻塞会卡住整个工具调用、无法展示进度、无法被用户中断。
- **可见与可控**：由 agent 调用，用户能在对话里看到"转知识库"这一步，权限策略也照常生效。

### 8.5 指令文本的要点

- "除非有明显的本地纠正手段（改正参数重试一次），否则**本轮内**立即调用 `<kbTool>`"；
- "question / user_question 逐字填写用户本轮原话"；
- "无需征求用户同意"（避免多一轮无意义确认）；
- "若返回 query id（长任务），把 id 告知用户，**不要轮询**结果工具"——轮询会把一个分钟级任务变成几十次空调用。

工具名通过插件配置 `kbQueryTool` 注入（默认 `mcp__knowledge__kb_query`，即 `mcp__<serverName>__<toolName>`），MCP 服务改名时只改配置。

---

## 9. SQLite 持久化倒排索引

大工程下每次查询都全量扫描太慢；常驻内存的索引又让进程峰值内存高、冷启动慢。模式：用 `node:sqlite`（`DatabaseSync`，Node 22+ 内置，无第三方依赖）在工程目录下维护持久化索引。

### 9.1 目录布局（`src/sqlite/lifecycle.ts`）

```
<projectRoot>/.agent-index/
├── current.json                 # 指针：{generation, schema_version, builder_version, fingerprint, built_at}
├── generation-000001.sqlite3    # 代际数据库（只读使用）
├── generation-000002.sqlite3    # 新一代构建中 / 已完成
└── build.lock                   # 构建锁 {pid, started_at, generation, host}
```

- **代际文件 + 原子切换**：新索引总是写到一个**新的**代际文件；构建并校验完成后，写 `current.json.tmp` 再 `rename` 覆盖 `current.json`。读者要么看到旧代，要么看到新代，**永远看不到半成品**；构建失败或取消不影响旧索引继续服务。
- 切换成功后清理旧代（正在被读的文件在 Windows 上删不掉时跳过，下次再清）。
- 索引目录建议加入工程的版本控制忽略列表。

### 9.2 构建锁（`src/sqlite/locking.ts`）

- `build.lock` 记录 pid；获取锁前若发现锁的 pid 已不在运行（`process.kill(pid, 0)` 失败）→ 视为死锁并回收。
- **坑**：worker 线程与主进程共享 pid。worker 被终止 / 崩溃后留下的锁，pid 仍"活着"（就是主进程）。所以由壳层在确认没有重建在进行时主动回收这类孤儿锁（`src/main/index-manager.ts` `releaseOrphanLock`）。

### 9.3 指纹：stat 快指纹 vs digest 强指纹（`src/sqlite/fingerprint.ts`）

| | 快指纹 | 强指纹 |
|---|---|---|
| 内容 | 所有在范围内文件的 `path + size + mtime` 的哈希 | 单个文件字节的 SHA-256 |
| 成本 | 只 stat，毫秒到百毫秒级 | 需读全部字节 |
| 用途 | **查询路径**判断"索引是否仍新鲜" | 构建时逐文件记录，用于校验与增量策略 |

查询路径只用快指纹，并对 "ready" 判定做短 TTL 缓存（如 30 秒），避免每次调用都遍历文件树。逐文件记录 stat 后，可以做到"某个文件改了只让该文件回退读源文件，其余仍走索引"。

### 9.4 版本常量（`src/sqlite/schema.ts`）

```ts
export const SCHEMA_VERSION = 1   // 表结构
export const BUILDER_VERSION = 1  // 构建/归一化逻辑
```

写进 `current.json` 与 `index_meta`。任一与代码不一致 → 状态 `stale`。**改表结构或构建逻辑（包括分词、归一化规则）必须递增**，否则旧索引被当作 ready，查询结果与扫描结果不一致且难以察觉。打开数据库后还要校验必需表存在、可选做 `integrity_check`。

### 9.5 状态机

`missing`（无指针）· `building`（锁有效）· `ready` · `stale`（指纹 / 版本不符）· `error`（校验失败或上次构建失败）。状态查询**从不构建**。

### 9.6 两阶段召回 + 精确匹配（`src/sqlite/query.ts`）

1. **召回（exact + n-gram）**：查询经归一化后拆成 term（ASCII 词 + CJK bigram，见 §11）；先做 compact 文本的精确匹配（以及剥离包装词后的精确匹配），再按共享 term 数召回候选，要求覆盖查询 term 的一定比例（如 ≥30%），候选数设上限（如 5000）。
2. **精确重排**：对候选用**与直接扫描完全相同的打分器**（`src/text.ts` `scoreLine`）重新打分，过阈值保留，排序截断。

**共享打分器是关键**：这保证"索引命中"与"降级扫描"返回同样的答案，差别只在速度。任何索引加速都应配一个"索引 vs 实时扫描逐项一致"的验证脚本。

---

## 10. 查询路径不建索引 + 降级提示；worker 线程重建

### 10.1 查询路径永不构建

早期实现会在工具调用里发现索引过期就同步重建——单次调用卡住上百秒，agent 完全无响应，用户以为程序死了（见 [`index-benchmark.md`](index-benchmark.md)）。规则：

- 工具只调用 `ProjectIndex.openForQuery()`：状态为 `ready` 才返回连接，否则返回状态；
- 非 ready 时**降级为直接扫描源文件**（结果正确，只是慢），并用 `appendIndexHint()`（`src/index_hint.ts`）在 answer 末尾附"索引未就绪，已直接扫描；到 设置 → 工程目录与查询索引 → 重建索引 可加速"，同时写 `payload.index_hint`，让模型转告用户；
- 构建只由用户在设置窗口显式触发。

### 10.2 worker 线程重建（`src/main/index-manager.ts`、`index-rebuild-worker.ts`）

- 每个工程一个 worker（`new Worker`），主进程 UI 不受影响；打包态 worker 入口必须在 `asarUnpack` 并经 `unpackAsarPath` 重写路径；
- **进度节流**：构建回调可能每毫秒触发，主进程按 150ms 合并后 `webContents.send('shell:index:progress', …)`，最后一帧总是送达；
- **可取消**：取消 = `worker.terminate()`；因为写的是新代际文件，旧索引不受影响；
- **收尾健壮**：worker 未报告就退出（崩溃 / 被杀）时，也要把 UI 置为 error / cancelled 状态，并回收孤儿锁（§9.2）；
- 同一工程已有重建在进行时拒绝第二次（`another build is already running`）；
- 应用退出（Ctrl+Q）时取消进行中的重建。

---

## 11. 文本归一化（中文友好）（`src/text.ts`）

索引构建、索引查询、降级扫描**必须共用同一套归一化与分词**，否则三者对"匹配"的理解不一致。

| 步骤 | 做法 | 解决的问题 |
|---|---|---|
| Unicode NFKC | `text.normalize('NFKC')` | 全角字母数字 → 半角、兼容字符折叠 |
| 中文标点映射 | `，。：；！？（）【】《》「」“”` 等 → ASCII | 中英文标点混用 |
| 大小写 / 空白 | 小写、折叠连续空白；compact 形式去掉全部空白 | "Foo Bar" 与 "foobar" |
| 包装词剥离 | 去掉"在哪 / 怎么配置 / 是什么 / where is / find …"等无检索信号的前后缀 | 用户自然语言问法污染召回 |
| 分词 | ASCII 词（长度 ≥2）+ CJK 连续串切 bigram（单字成 unigram） | 中文没有空格可切 |
| 低信息量检测 | 过短或全是高频弱词的查询标记为低信息量 | 防止"配置""类型"之类召回爆炸 |

包装词表和高频弱词表是**领域相关**的，按领域调整；改了它们要递增 `BUILDER_VERSION`。

---

## 12. 路径安全（`src/scoped_paths.ts`）

模型传给工具的每个路径都是**不可信输入**。`ScopedPathResolver`：

- 拒绝绝对路径（只接受工程相对路径）；
- 拒绝 `..` 穿越（规范化后再判断）；
- 用 `realpath` 解析 symlink / Windows junction 后再判断是否仍在工程根内——防止通过链接逃逸；
- 支持 `allowedRoots` 白名单：某个工具只允许访问工程内若干子目录；
- 生成 evidence locator 时转成工程相对 POSIX 路径。

壳层同理：设置窗口的 IPC 涉及路径时**只接受白名单**（`shell:open-path` 只能打开数据根、报告目录等已知位置），不能把任意路径交给 `shell.openPath`。

---

## 13. 数据源组合与受控降级

很多工程的同一份数据存在多种格式（例如一个"主格式"由工具链导出，一个"次格式"是人工编辑的源文件）。模式：

1. 由注册表 / 约定先确定"这份数据应在哪"；
2. **主格式优先**读取；
3. **只在主格式文件物理不存在时**降级到次格式；
4. 主格式**存在但解析失败、目标段不存在**等其它错误 → **不降级，直接报错**。

为什么不"失败就换一个试试"：主格式解析失败往往意味着数据真有问题（导出中断、格式升级），静默降级会用一份可能过时的次格式给出看似正确的答案，问题被掩盖。降级时在 evidence 里标明实际读取的来源。

---

## 14. 知识资产随包分发（`knowledge/`）

有些领域知识不在工程里（概念 → 位置的映射、字段语义、术语表、事件/节点说明）。模式：

- 放在插件包的 `knowledge/` 目录，加入 `package.json` `files`，随包分发；
- **按包根定位**：`join(dirname(fileURLToPath(import.meta.url)), '..', 'knowledge')`，绝不用 `process.cwd()`（打包态 cwd 不可预期）；
- Markdown / JSON 等可审阅格式，进版本控制；
- 惰性加载，缺失或格式错误时返回空结果而不是让工具失败；
- 来自知识资产的结论在 evidence 中 `kind: 'knowledge'`、`verified: false`；
- 不放本机绝对路径或密钥（`bundle-portable.mjs` 会扫描）。

这让"不写代码就能补能力"成为可能：维护者往 `knowledge/` 加一份映射，下次打包即生效。

---

## 15. 惰性单例 reader 缓存

插件 `apply()` 在组合启动时执行，此时**不要**做任何昂贵工作（扫描工程、打开数据库、解析大文件）——会拖慢每次启动，且用户可能根本不用这个工具。

```ts
let index: ProjectIndex | null = null
const getIndex = () => (index ??= new ProjectIndex(projectRoot, sourceOptions))
```

- 每个插件实例一个，跨工具调用复用（注册表解析结果、已打开的只读连接、知识资产）；
- 多个能力共享同一个底层 reader，避免同一份数据被解析多次；
- 未绑定工程时工具仍注册，调用时返回 `needs_input` 提示去绑定，而不是在 `apply()` 抛错让整个预设加载失败。

---

## 16. 组合能力：报告类工具内部编排原子能力

"给我一份 X 的完整报告"往往需要先定位实体、再查配置、再查引用、再汇总。若让模型手工串联 4–5 个原子工具：步骤易漏、参数传递出错、上下文被中间结果塞满。

模式：提供一个**报告类工具**，内部以依赖注入的方式调用原子能力（定位、查询、引用、时间线……），在工具内部完成编排、交叉验证与渲染，最终落盘报告（§5）。原子工具仍然保留，供模型做细粒度追问。

实现要点：

- 原子能力写成纯函数 / 能力类，与 `defineTool` 包装分离，便于组合复用与单测；
- 组合工具把每一步的证据合并进最终 evidence；
- 某一步失败时报告里明确标出缺失段落（`partial`），而不是整体失败。

---

## 17. 只读取证子代理 persona 模板

当本地工具与知识库都不够、需要深入代码调查时，可以在预设里配置一个**只读**子代理（`dsh-tool-subagent`，`toolFilter.allow: [read, glob, grep]`，`backgroundMode: one-shot`）。persona 模板要点：

```
你是「<工程名>」的深度代码调查只读取证代理。
- 只在收到明确的：原始问题、标准化目标、现有证据、明确缺口、工程绑定、允许范围时执行；缺项时只返回缺失项。
- 先限定实体 / 符号 / 目录，再用 glob/grep 精确检索；不默认扫描全工程。
- 只读取证：不修改工程、不写文件、不读凭证或无关文件。
- 结论分三层：
  1. 代码事实（直接读到的定义、值）；
  2. 调用链证据（谁调用谁，带文件/符号定位）；
  3. 业务推断（基于以上的推测，必须标注）。
- 输出：结论、关键调用链、文件/符号证据（工程相对路径）、未确认部分、建议沉淀位置（哪类知识值得补进 knowledge/）。
- 所有结论标「未验证」，由主 agent 决定是否采信。
```

三层划分的价值：主 agent 与用户能一眼区分"读到的事实"与"推测"，防止推断被当成事实传播。若知识库服务端已具备代码调查能力，该子代理可以默认 `disabled: true` 作为备用。

---

## 18. 打包相关

- 插件的 npm 依赖会被 npm 提升到根 `node_modules`。打包后 DSH 经 `createRequire(profileDir)` 从 `resources/desktop-profile/node_modules` 解析插件，那里**只有显式拷进去的东西**。所以：插件依赖及其**全部传递依赖**必须加入 `electron-builder.config.cjs` 的 `EXAMPLE_RUNTIME_DEPS`（同时驱动 asarUnpack 与 profile 拷贝）。开发态不会暴露这个问题。
- 本地插件以 Junction 链接进 `node_modules`，`after-pack.cjs` 负责实体化，否则别的机器上指向构建机路径。
- 会被 `new Worker` / `spawn` 的文件必须在 `asarUnpack`，路径重写为 `app.asar.unpacked`。
- 能用 Node 内置能力（`node:sqlite`、`node:zlib`、`node:crypto`）就不加依赖——示例插件因此零第三方依赖。
- 打包后跑 `npm run verify:profile-deps` 与 `npm run verify:packaged-packages`。

---

## 附：新领域工具自检清单

- [ ] 用 `registerTool()` 注册（带兜底），不是 `tools.register()`
- [ ] 返回 `toOutput(result)`，无 `undefined` 键
- [ ] status 属于封闭枚举；"未找到"写在 answer 首行
- [ ] evidence 用工程相对路径，`verified` 如实
- [ ] 歧义返回 `needs_input` + 带 ID 的候选
- [ ] 长结果落盘 + artifacts + 描述里要求 present
- [ ] 更新 `example:tool-quickref` 工具速查
- [ ] 路径参数经 `ScopedPathResolver`
- [ ] 不在查询路径上构建索引；改索引逻辑递增版本常量
- [ ] 新 npm 依赖进 `EXAMPLE_RUNTIME_DEPS`
- [ ] 验证脚本用临时样例工程，不依赖真实业务数据
