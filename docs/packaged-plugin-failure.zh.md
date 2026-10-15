# 打包版插件加载失败：根因与修复

[English](packaged-plugin-failure.md) | 中文

> 症状：打包版显示 **"Failed to load plugins / client-modules: HTML did not preload ..."**
> 源码模式（`npm start`）完全正常。
> 状态：**根因已定位，修复已验证生效**

---

## 修复结果（已验证）

```
修复前: client graph: 0 entries, 0 batches (rev 240c4d8dcf0d)
修复后: client graph: 53 entries, 2 batches (rev bac2a6a25253)
```

打包版渲染进程状态：

```json
"boot":   { "entryCount": 53, "batchCount": 2 }
"loader": { "mode": "live" }
"rootHTML": "<div data-slot=\"root\">...<div data-slot=\"sidebar\">..."
```

**UI 完整渲染** —— 不再是 "Failed to load plugins" 错误页。

### 修复内容

`electron-builder.config.cjs` 的 `extraResources` 增加一项：

```js
{
  from: 'node_modules/@deepseek-ai',
  to: 'desktop-profile/node_modules/@deepseek-ai',
}
```

让 profile 目录拥有自己的 DSH 包解析路径。

---

## 一、根因

**`client-modules` 解析包清单时依赖 `ctx.loader.internal`（需要 Node 的 `--expose-internals`）；该 internal 在 Electron 中不可用，回退路径又基于错误的基准目录，导致所有客户端插件被丢弃。**

### 源码依据

`dsh-client-modules/lib/index.js` 的 `locatePkgJson`：

```js
const internal = this.ctx.loader.internal;
if (internal === void 0 || typeof Reflect.get(internal, "resolveSync") !== "function") {
  // 回退：用 baseUrl 做 createRequire 解析
  return {
    path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
    packageName: expectedPackageName
  };
}
```

**优先路径**：`loader.internal.resolveSync` —— 需要 `--expose-internals`
**回退路径**：`createRequire(baseUrl)` —— `baseUrl` 是 **profile 目录**

---

## 二、决定性证据

### 打包版宿主内诊断（修复前）

```
[dsh-desktop] loader.internal present: false, resolveSync: undefined
[dsh-desktop] fallback resolve from profile FAILED:
              Error: Cannot find module '@deepseek-ai/dsh-client-modules/package.json'
[dsh-desktop] client graph: 0 entries, 0 batches (rev 240c4d8dcf0d)
```

### 完整因果链

```
1. locatePkgJson 检查 ctx.loader.internal
        ↓
2. Electron 无 --expose-internals → internal === undefined
        ↓
3. 回退到 createRequire(profileDir).resolve('@deepseek-ai/<pkg>/package.json')
        ↓
4. profile 目录下没有 DSH 包 → MODULE_NOT_FOUND
        ↓
5. 每个条目都被丢弃 → sources = 0 → composed 图 = 0 entries
        ↓
6. HTML 请求的 bundle 在图中不存在 → /plugins 返回 404
        ↓
7. UI 显示 "Failed to load plugins"
```

### 佐证：pkgMeta 的 key 暴露了回退路径

```
clientModules pkgMeta entries: 128
  meta file:///D:/.../desktop-profile/ cordis:include: null
  meta file:///D:/.../desktop-profile/ @deepseek-ai/cordis-plugin-timer: null
```

**所有 key 都以 `desktop-profile/` 为前缀** —— 正是回退路径用 profile 作 `baseUrl` 的痕迹。

---

## 三、为什么源码模式不受影响

**这是一个偶然的"幸运"：**

```
源码 profile 目录:  <repo>\desktop-profile
                    ↓ 向上查找 node_modules
                    <repo>\node_modules\@deepseek-ai\...  ← 命中！
```

源码模式下 profile 位于**项目根内**，Node 的向上查找**穿透**到项目根的 `node_modules`，
回退路径因此成功。

**打包后 profile 在 `resources/desktop-profile`，再无上层 `node_modules` 可穿透** → 失败。

> 我在之前的审计中曾把这个"穿透"标记为设计缺陷
> （见 `self-maintenance.zh.md`），**现在它成了这个故障的最终解释**。

---

## 四、与其它已知问题的关系

这个根因同时解释了另外两个已记录的问题：

| 问题 | 关联 |
|---|---|
| HMR 不可用（需 `--expose-internals`） | **同源** —— 都因 Electron 无法提供 Node internals |
| 打包后 profile 解析穿透开发机 | **同源** —— 都是 profile 不可自包含的表现 |

**这三个问题是一个根因的三个表现。**

---

## 五、影响

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `npm start`（开发） | 正常 | 正常 |
| 打包版 | **不可用** | **正常** |

**代价**：安装包体积增加（DSH 树在 profile 下多一份副本）。
如需避免重复，可用 junction/symlink 替代复制。

---

## 六、诊断工具（已固化）

`host.ts` 启动时输出（两版都会输出，便于对比）：

```
[dsh-desktop] client graph: N entries, M batches (rev ...)
[dsh-desktop] loader rows: N total, M with fiber, K disabled
[dsh-desktop] loader.internal present: true|false, resolveSync: function|undefined
[dsh-desktop] fallback resolve from profile SUCCEEDED|FAILED: ...
[dsh-desktop] clientModules pkgMeta entries: N
```

---

## 七、证据强度

- **实测确认**：修复前 `loader.internal` 为 `undefined`、回退解析失败、图 0 entries；
  **修复后 53 entries、`mode: live`、UI 完整渲染**
- **因果链完整**：从 internal 缺失 → 回退失败 → 扫描全空 → 图空 → bundle 404 → UI 报错，
  每一环都有实测或代码依据
- **调查中被推翻的假设**（记录以备参考）：asar 读取失败、构造时序竞态、
  `onlyLoadAppFromAsar` fuse —— 三者在实测中均被排除


---

## 一、根因

**`client-modules` 解析包清单时依赖 `ctx.loader.internal`（需要 Node 的 `--expose-internals`）；该 internal 在 Electron 中不可用，回退路径又基于错误的基准目录，导致所有客户端插件被丢弃。**

### 源码依据

`dsh-client-modules/lib/index.js` 的 `locatePkgJson`：

```js
const internal = this.ctx.loader.internal;
if (internal === void 0 || typeof Reflect.get(internal, "resolveSync") !== "function") {
  // 回退：用 baseUrl 做 createRequire 解析
  return {
    path: createRequire(baseUrl).resolve(`${expectedPackageName}/package.json`),
    packageName: expectedPackageName
  };
}
```

**优先路径**：`loader.internal.resolveSync` —— 需要 `--expose-internals`
**回退路径**：`createRequire(baseUrl)` —— `baseUrl` 是 **profile 目录**

---

## 二、决定性证据

### 打包版宿主内诊断

```
[dsh-desktop] loader.internal present: false, resolveSync: undefined
[dsh-desktop] fallback resolve from profile FAILED:
              Error: Cannot find module '@deepseek-ai/dsh-client-modules/package.json'
[dsh-desktop] client graph: 0 entries, 0 batches (rev 240c4d8dcf0d)
```

### 完整因果链

```
1. locatePkgJson 检查 ctx.loader.internal
        ↓
2. Electron 无 --expose-internals → internal === undefined
        ↓
3. 回退到 createRequire(profileDir).resolve('@deepseek-ai/<pkg>/package.json')
        ↓
4. profile 目录下没有 DSH 包 → MODULE_NOT_FOUND
        ↓
5. 每个条目都被丢弃 → sources = 0 → composed 图 = 0 entries
        ↓
6. HTML 请求的 bundle 在图中不存在 → /plugins 返回 404
        ↓
7. UI 显示 "Failed to load plugins"
```

### 佐证：pkgMeta 的 key 暴露了回退路径

```
clientModules pkgMeta entries: 128
  meta file:///D:/.../desktop-profile/ cordis:include: null
  meta file:///D:/.../desktop-profile/ @deepseek-ai/cordis-plugin-timer: null
```

**所有 key 都以 `desktop-profile/` 为前缀** —— 正是回退路径用 profile 作 `baseUrl` 的痕迹。
（正常情况应是 `@deepseek-ai/<pkg>` 形式的包名。）

---

## 三、为什么源码模式不受影响

**这是一个偶然的"幸运"：**

```
源码 profile 目录:  <repo>\desktop-profile
                    ↓ 向上查找 node_modules
                    <repo>\node_modules\@deepseek-ai\...  ← 命中！
```

源码模式下，profile 位于**项目根内**，Node 的向上查找**穿透**到了项目根的 `node_modules`，
回退路径因此成功。

**打包后 profile 在 `resources/desktop-profile`，再无上层 `node_modules` 可穿透** → 失败。

> 我在之前的审计中曾把这个"穿透"标记为设计缺陷
> （见 `self-maintenance.zh.md`），**现在它成了这个故障的最终解释**。

---

## 四、与其它已知问题的关系

这个根因同时解释了另外两个已记录的问题：

| 问题 | 关联 |
|---|---|
| HMR 不可用（需 `--expose-internals`） | **同源** —— 都因 Electron 无法提供 Node internals |
| 打包后 profile 解析穿透开发机 | **同源** —— 都是 profile 不可自包含的表现 |

**这三个问题是一个根因的三个表现。**

---

## 五、修复方案

### 方案 A：让 profile 目录可解析 DSH 包 ★ 推荐

在 profile 目录下建立指向 DSH `node_modules` 的链接：

```
resources/desktop-profile/node_modules/
  └── @deepseek-ai -> ../app.asar.unpacked/node_modules/@deepseek-ai
```

**理由**：回退路径用 `createRequire(profileDir)`，只要 profile 能解析到包就成功。

**实现**：打包时用 `extraResources` 或 postinstall 创建 junction/symlink。

**风险**：Windows 上创建符号链接需要权限；可用 junction（目录联接）替代。

### 方案 B：改用「可自包含的 profile」

把 DSH 安装树整个放到 profile 旁边，使 `createRequire(profileDir)` 能解析：

```
resources/
├── desktop-profile/
│   └── node_modules/@deepseek-ai/...   ← 真实副本或链接
└── app.asar.unpacked/
```

### 方案 C：向上游报告并等待修复

`locatePkgJson` 的回退路径假设 `baseUrl` 能解析到 DSH 包，
这在"profile 位于安装树之外"时并不成立。

**上游可能希望改进这个假设。**

---

## 六、建议

**先试方案 A** —— 它是唯一能直接验证根因的改动，且成本低：

```js
// electron-builder.config.cjs
extraResources: [
  {
    from: 'node_modules/@deepseek-ai',
    to: 'desktop-profile/node_modules/@deepseek-ai',
  },
],
```

**若成功**：根因确认无误，且打包恢复可用。

**注意**：这会增加安装包体积（DSH 约 34MB），但 `asarUnpack` 已经有这份副本，
可以用链接而非复制来避免重复。

---

## 七、影响与当前建议

| 场景 | 状态 |
|---|---|
| `npm start`（开发） | **完全正常** |
| 打包版 | **不可用** |

**建议**：用源码模式开工，不受影响。打包问题按第五节修复。

---

## 八、诊断工具（已固化）

`host.ts` 启动时输出（两版都会输出，便于对比）：

```
[dsh-desktop] client graph: N entries, M batches (rev ...)
[dsh-desktop] loader rows: N total, M with fiber, K disabled
[dsh-desktop] loader.internal present: true|false, resolveSync: function|undefined
[dsh-desktop] fallback resolve from profile SUCCEEDED|FAILED: ...
[dsh-desktop] clientModules pkgMeta entries: N
```

---

## 九、证据强度

- **实测确认**：`loader.internal` 在打包版为 `undefined`；
  profile 目录的回退解析失败；`pkgMeta` 的 key 带 `desktop-profile/` 前缀；
  源码模式 53 entries、打包版 0 entries
- **因果链完整**：从 internal 缺失 → 回退失败 → 扫描全空 → 图空 → bundle 404 → UI 报错，
  每一环都有实测或代码依据
- **未做**：修复实现（方案 A 待执行验证）
- **调查中被推翻的假设**（记录以备参考）：asar 读取失败、构造时序竞态、
  `onlyLoadAppFromAsar` fuse —— 三者在实测中均被排除
