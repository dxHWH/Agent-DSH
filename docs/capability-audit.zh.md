# 能力与可扩展性审计

[English](capability-audit.md) | 中文

> 问题：桌面客户端能否具备 Web UI 的所有功能和可扩展性质？
> 方法：对已建成的桌面客户端与原生 `dsh web` 做**组合级实测对比**，而非推断。
> 脚本：`scripts/audit-capabilities.mjs`、`scripts/audit-extensibility.mjs`

---

## 术语对照

本文保留英文标识符（它们是代码里实际的名字，翻译反而会造成歧义），首次出现时附中文解释：

| 英文 | 中文 | 含义 |
|---|---|---|
| `profile` | 配置集 | 一组 bundle（插件包）的有序叠加，决定启动哪些组件 |
| `bundle` | 插件包 | 一个 patch 层包，如 `dsh-base`、`dsh-web-app` |
| `entry` / `row` | 条目 / 行 | 组合后的一个插件挂载项 |
| `patch` | 补丁 / 覆盖层 | 对组合的增删改，按顺序叠加，后者覆盖前者 |
| `insert` | 插入列表 | patch 中新增条目的语法，必须显式包裹 |
| `composition` | 组合 | 多个 patch 层叠加后的最终插件树 |
| `host` | 宿主 | 运行在 Node 侧、提供服务的 DSH 主体 |
| shell | 壳层 | 本项目本身，即 Electron 外壳 |
| HMR | 热模块替换 | 改代码后不重启即生效的开发时能力 |

---

## 结论

**功能上：完全一致，零差异。**
**可扩展性上：一致，但有一处需要注意的构造性差异。**

---

## 一、功能对等性：实测 152 : 152，完全相同

### 实测方法

用 `dsh-app-boot` 分别组合两个 profile，对比最终 entry 列表：

- **对照组**：全新初始化的 `web` profile（等效于 `dsh web`）
- **实验组**：桌面客户端的 `desktop-profile`

### 实测结果

```json
"diff": {
  "onlyInWeb": [],
  "onlyInDesktop": [],
  "identical": true,
  "webCount": 152,
  "desktopCount": 152
}
```

**零差异。** 包括：

| 类别 | 数量 | 说明 |
|---|---|---|
| 总 entry | 152 | 完全一致 |
| 客户端插件（`dsh-client-*`） | 45 | 完全一致 |
| UI 插件 | 36 | 聊天、会话、工具、审批、计划、目标、子代理…… |

### 为什么必然一致

两边的 profile 清单**逐字相同**：

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app"
]}}
```

且加载的是**同一个前端产物**：`@deepseek-ai/dsh-web-frontend/dist`。

桌面客户端不做任何 UI 层面的替换或裁剪 —— 它把 DSH 自己的界面装进原生窗口，而不是重写一个。

### 唯一的差异在「壳层」，且只增不减

桌面端相对 web 端**多出**的能力（不影响 DSH 内部功能）：

| 能力 | 来源 |
|---|---|
| 系统托盘常驻、关窗最小化 | `tray.ts` |
| 窗口尺寸/位置持久化 | `window-state.ts` |
| 原生应用菜单与快捷键 | `index.ts` |
| 壳层设置窗口（数据根、诊断） | `settings.ts` |
| 可移植数据根（4 种模式） | `paths.ts` |
| OS 分配端口（消除端口冲突） | `host.ts` |

**没有任何 DSH 功能被削减。**

---

## 二、可扩展性：实证通过

静态对等不代表可扩展。我实测了 profile 的**用户 patch 层**能否真正改动组合。

### 实测结果

```
beforeCount:  152
afterCount:   153          ← insert 生效
rowAdded:     true
addedRow:     { id: 'user-added-plugin', name: '@deepseek-ai/dsh-cordis-host-runner' }
disableWorks: true         ← id 定向覆盖生效
verdict:      extensible: insert adds rows, id-targeted entries override and disable
```

### 可用的扩展手段

| 手段 | 载体 | 是否实测 |
|---|---|---|
| 新增插件 | `cordis.patch.yml` 的 `- insert:` | ✅ |
| 覆盖配置 / 禁用组件 | `- id: <目标>` + `config:` / `disabled:` | ✅ |
| 外置客户端插件 | 包 `package.json` 声明 `dsh.client` | 未实测（需构建 bundle） |
| 热重载 patch | profile 的 `patchReload: live` | 声明存在；见下方限制 |

### ⚠️ 一处必须知道的陷阱（实测踩到）

**裸写 `- id: xxx` 不会新增行，只会「定位」已有行。**

我第一次测试时写了：

```yaml
- id: user-added-plugin
  name: '@deepseek-ai/dsh-cordis-host-runner'
```

结果 **entry 数仍是 152，行没有加上，且不报任何错** —— 静默失败。
正确写法必须包在 `insert` 里：

```yaml
- insert:
    - id: user-added-plugin
      name: '@deepseek-ai/dsh-cordis-host-runner'
```

这是所有桌面端扩展工作都会遇到的第一个坑，值得写进文档。

---

## 三、需要注意的真实差异与限制

以下不是「功能缺失」，而是桌面形态带来的**结构性差异**，应如实告知：

### 1. HMR / 客户端插件热重载不可用

DSH 的客户端插件热重载依赖 `cordis-plugin-hmr`，而它**要求 Node 的 `--expose-internals` 标志**。Electron 主进程启动后无法追加该标志。

**影响**：开发外置客户端插件时，改完代码需要重启应用，而不是自动热替换。
**不影响**：已构建好的客户端插件正常加载（走 `/plugins` 静态 bundle 路径，不需要 HMR）。

> 注：这正是 DSH 官方设计里 `file://` + Electron 路径会遇到的同源问题，官方 README 未给出解法。

### 2. 端口是动态的，不是固定 3080

桌面端用 `--port 0` 让 OS 分配，避免端口冲突。这对功能无影响（窗口加载真实 URL），但：

- 若你有外部工具硬编码 `127.0.0.1:3080` 去连 DSH，**连不上**
- 实际端口在壳层设置窗口的「诊断」里可见，也打印在 stdout

### 3. 认证 Cookie 的 origin 随机

每次启动端口不同 → `127.0.0.1:<port>` 不同 → 浏览器会话 cookie 绑定的是该 origin。
桌面端自己完成 token 交换，**用户无感**；但如果你想把普通浏览器指向桌面端这个实例，需要重新走 URL。

### 4. `desktop` profile 名被 CLI 保留

`dsh --profile desktop` **会被 CLI 拒绝**（官方为 Electron 预留）。这不影响桌面客户端（它用 `loadProfileDirectory` 绕开 CLI 查找），但意味着：

- 你**不能用 `dsh plugin --profile desktop add <pkg>`** 管理桌面端的插件
- 要加桌面端插件，需直接编辑 `desktop-profile/cordis.patch.yml` 或 `package.json`

这是官方明确的设计，不是本实现的缺陷。

### 5. live patch reload 当前未强制启用

profile 声明了 `patchReload: live`，但 `host.ts` **刻意不主动装配 HMR 插件**（原因见限制 1）。
用户 patch 层在**启动时**正常生效；运行中改动不会自动重载。

---

## 四、语言支持（中文模式）

### DSH 本身已内置双语

实测确认 `dsh-client-locale` 已挂载，其编译产物同时含 `zh` 与 `en` 词典：

```json
"localeRows": [{ "id": "locale", "name": "@deepseek-ai/dsh-client-locale" }],
"clientMentionsZh": true,
"clientMentionsEn": true
```

精确契约（来自 `dsh-client-locale/lib/index.js`）：

| 项 | 值 |
|---|---|
| settings 命名空间 | `locale` |
| 字段 | `preference` |
| 合法值 | `["zh", "en"]` |
| 存储位置 | `$DSH_HOME/settings.yaml` |
| 切换入口 | 主窗口 设置 → General → Language（即时生效） |

**所以中文不是新增功能，而是让桌面端首次启动就说中文。**

### 桌面端做的事：首次运行播种

`src/main/locale.ts` 在 DSH 读取 settings 之前播种 `zh`。

**关键设计边界（已实测）：**

| 场景 | 行为 |
|---|---|
| 全新数据根 | 播种 `zh` |
| 已有 `locale.preference: en` | **绝不覆盖** |
| 有 settings.yaml 但无 locale 段 | 追加 locale 段，保留其他段 |
| 二次启动 | 不再播种 |

第三条是实施中发现并修正的真实缺陷：DSH 首次启动会先写入
`ui-onboarding` 段，若按「文件存在即跳过」判定，则**真正的首次安装永远不会被播种**。
改为按「是否已设 locale」判定，并采用**追加**而非替换。

端到端实测（清空数据根后启动）：

```yaml
# DSH Desktop settings.
locale:
  preference: zh                        ← 播种
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1    ← DSH 随后追加，未覆盖 locale
```

证明两点：播种生效，且 DSH 启动后不会抹掉它。

### 复现

```bash
npm run selfcheck:locale    # 15 项断言
```

---

## 五、回答

**能否具备 Web UI 的所有功能？**
能，且是实测的完全对等（152/152，零差异）。因为桌面端**就是** Web UI —— 同一个前端产物、同一套 profile、同一个 host，只是装进了原生窗口。

**能否具备可扩展性质？**
能。profile 的 patch 层可增、可改、可禁，已实测验证。外置客户端插件机制（`dsh.client` 声明）与 Web 端完全共用，因为走的是同一条 `/plugins` 通路。

**代价是什么？**
三处结构性差异，都不影响日常使用，但会影响开发与外部集成：
1. 客户端插件热重载不可用（需重启）
2. 端口动态，外部工具不能硬编码 3080
3. 不能用 `dsh plugin` 命令管理桌面端插件，需直接编辑 profile 文件

---

## 六、复现方式

```bash
npm run audit:capabilities     # 功能对等性对比
npm run audit:extensibility    # 可扩展性实测
npm run audit:locale           # 语言支持盘点（已挂载的 locale 能力）
npm run selfcheck:locale       # 中文播种与边界（15 项断言）
```
