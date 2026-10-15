# 桌面端自我维护能力评估

[English](self-maintenance.md) | 中文

> 问题：桌面版如何进行**自我维护、插件扩展、DSH 升级**？
> 方法：对**打包产物**实测（非源码目录），模拟干净机器环境。
> 脚本：`scripts/audit-self-maintenance.mjs`

---

## 结论摘要

| 维护维度 | 当前是否可行 | 障碍 |
|---|---|---|
| 改组合（启用/禁用/配置插件） | **部分可行** | 需改 `resources/desktop-profile/`，**会被安装升级覆盖** |
| 装外置插件 | **不可行** | profile 没有自己的 `node_modules` |
| 升级内置 DSH | **不可行** | 版本写死在安装包内 |
| 应用自动更新 | **不可行** | 未接入 `electron-updater` |

**四项都需要改架构，不只是写文档。** 本文给出方案。

---

## 一、实测发现的一个真实缺陷

### 问题：打包后的 profile 不是自包含的

实测（`release/win-unpacked/resources/desktop-profile/`）：

```
从 profile 目录解析 @deepseek-ai/dsh-base
  -> <repo>\node_modules\@deepseek-ai\dsh-base\package.json
     ^^^ 穿透到了开发机的项目根，而不是打包内的 app.asar.unpacked
```

**为什么？** `release/win-unpacked` 位于项目目录内，Node 的向上查找自然命中了开发机的 `node_modules`。

### 在干净机器上会失败

把打包产物拷到无 `node_modules` 的位置后：

```
@deepseek-ai/dsh-base/package.json -> FAILED: MODULE_NOT_FOUND
@deepseek-ai/cordis/package.json   -> FAILED: MODULE_NOT_FOUND
```

### 为什么安装版目前还能跑

因为 `loadProfileDirectory(binName, dir, installAnchor)` 的第三个参数
`installAnchor` 指向 **DSH 自己的安装位置**，bundle 是从那里解析的，
而不是从 profile 目录。

**但这掩盖了问题的本质**：profile 目录声明了 `dsh.profile.bundles`，
却无法靠自己解析这些 bundle。一旦要往 profile 里装外置插件，
这个缺陷就会立刻暴露 —— 因为外置插件**只能**从 profile 自己的 `node_modules` 解析。

### 结论

这不是"能不能维护"的问题，而是 **profile 目录必须是自包含的**。
下面的方案以此为前提。

---

## 二、方案：把可维护内容移出安装目录

### 核心思路

打包的 `resources/` 目录 **升级时会被覆盖**，不能放用户可维护的内容。

正确做法：**profile 目录放到用户数据区**，与 `settings.yaml`、`.credentials.json` 同级。

```
<数据根>\
├── settings.yaml
├── .credentials.yaml
├── storages\
├── .agent-presets\          # 已有：用户的 agent 预设
└── desktop-profile\         # 新增：用户可维护的组合
    ├── package.json         # 声明 bundles 与依赖
    ├── cordis.patch.yml     # 用户可编辑的组合覆盖层
    ├── cordis.yml
    ├── pnpm-workspace.yaml
    └── node_modules\        # 外置插件装在这里
```

**好处**：

| 效果 | 说明 |
|---|---|
| 升级不覆盖 | 数据区不在安装包内 |
| 随数据迁移 | 与设置、凭据一起拷走 |
| 插件可安装 | 有独立的 `node_modules` |
| 可回滚 | 改坏了删掉重建即可 |

### 首次运行引导

应用启动时：

1. 检查 `<数据根>/desktop-profile/` 是否存在
2. 不存在 → 从打包内的模板复制一份（模板只读，作为"出厂默认"）
3. 存在 → 直接使用（用户的改动被保留）

这样既保证开箱可用，又不覆盖用户改动。

---

## 三、四项维护需求的具体做法

### 1. 改组合（启用/禁用/配置插件）

编辑 `<数据根>/desktop-profile/cordis.patch.yml`：

```yaml
# 禁用某个内置插件
- id: ui-schedule
  disabled: true

# 覆盖配置
- id: agent-loop
  config:
    maxParallelToolCalls: 4

# 新增一行（必须包在 insert 里）
- insert:
    - id: my-plugin
      name: '@scope/my-dsh-plugin'
```

**实测确认**：patch 生效（条目数 152 → 153，禁用生效）。

> **陷阱**：裸写 `- id: xxx` 只定位已有行，不新增，且**静默失败**。
> 新增必须用 `insert:`。

### 2. 装外置插件

profile 是一个独立的 npm 项目，因此可直接用包管理器：

```powershell
cd "<数据根>\desktop-profile"
npm install @scope/my-dsh-plugin
```

然后在 `cordis.patch.yml` 里用 `insert` 挂载它。

**外置客户端插件**（带 UI 的）需要在包内声明：

```json
{
  "dsh": { "client": { "platform": "web" } }
}
```

并导出已构建的 `./client` bundle —— 缺失会以 `MissingClientBundleError` 显式失败。

> **注意**：不能用 `dsh plugin --profile desktop`，因为 CLI 保留了这个名称
> （实测确认）。必须直接在 profile 目录里用包管理器。

### 3. 升级内置 DSH

这是最需要架构支持的一项。三个层次：

| 方式 | 做法 | 适用 |
|---|---|---|
| **A. 应用升级** | 出新版安装包，用户安装 | 简单，但需重装整个应用 |
| **B. 独立 DSH 目录** | DSH 放在数据区，可单独替换 | 推荐 |
| **C. 跟随系统 dsh** | 复用全局安装的 `dsh` | 省体积，但版本不可控 |

**方式 B 的设计**：

把 DSH 安装树从 `app.asar.unpacked` 移到用户数据区：

```
<数据根>\
└── dsh\                    # 可独立升级的 DSH 安装
    └── node_modules\
        └── @deepseek-ai\dsh\
```

应用启动时优先使用数据区的 DSH，不存在则回退到打包内的版本。
升级时只需替换 `dsh/` 目录，无需重装应用。

**需要改的地方**：`host.ts` 的 `resolveInstallAnchor()` 与 profile 解析链。

### 4. 应用自动更新

接入 `electron-updater`（当前未安装，实测确认）。

需要：
- 一个发布源（GitHub Releases / 自建静态服务 / S3）
- `electron-builder` 的 `publish` 配置
- 主进程接入更新检查与下载
- **代码签名**（否则每次更新都会触发 SmartScreen 警告）

> 签名是自动更新的**实际前提**，不是可选项。未签名的自动更新会让用户体验显著变差。

---

## 四、建议的实施顺序

| 阶段 | 内容 | 价值 | 风险 |
|---|---|---|---|
| 1 | profile 移到数据区 + 首次引导复制 | 组合可维护、升级不覆盖 | 低 |
| 2 | 文档化外置插件安装流程 | 插件可扩展 | 低 |
| 3 | DSH 安装树移到数据区 | 可独立升级 DSH | 中（改解析链） |
| 4 | 接入 electron-updater | 应用自动更新 | 中（需发布源 + 签名） |
| 5 | 代码签名 | 消除 SmartScreen 警告 | 需证书 |

**阶段 1 是其余各项的前提** —— 它解决"用户改动放在哪"这个根本问题。

---

## 五、当前状态下用户能做什么

在架构改动完成前，已安装的用户仍可手动维护，但要知道代价：

| 想做什么 | 当前做法 | 代价 |
|---|---|---|
| 改组合 | 直接编辑 `resources/desktop-profile/cordis.patch.yml` | **应用升级会覆盖** |
| 装插件 | 需手动在 profile 目录建 `node_modules` 并装包 | profile 解析链不完整，可能失败 |
| 升级 DSH | 重新安装新版应用 | 无法单独升级 |

**建议**：在阶段 1 完成前，把改动记录在别处（如一个 patch 文件的备份），
升级后重新应用。

---

## 六、复现

```bash
npm run audit:self-maintenance   # 打包产物维护能力实测
```

---

## 七、证据强度

- **实测确认**：打包后 profile 位置与可写性；patch 对组合的实际影响（152→153）；
  profile 无 `node_modules`；解析链穿透到开发机；干净位置解析失败；
  `electron-updater` 未安装
- **读取契约确认**：`loadProfileDirectory` 的 `installAnchor` 参数语义；
  CLI 保留 `desktop` 名称；外置客户端插件的 `dsh.client` 声明要求
- **未验证**：数据区 profile 的完整引导流程（需实现后才能测）；
  DSH 独立升级的实际可行性（需改解析链后验证）
