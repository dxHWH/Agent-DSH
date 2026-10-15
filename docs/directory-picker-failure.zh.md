# 目录选择器失败：绕过方案（native → browse）

[English](directory-picker-failure.md) | 中文

> 症状（用户报告）：打包版点击"打开文件夹"报错
> ```
> directory picker failed: directory picker failed:
> win32 folder dialog worker exited before reporting a result
> ```
> 状态：**已通过切换到 browse backend 绕过。根因仍未定位。**

---

## 一、已实施的修复：切换到 browse backend

### 为什么这样修

`dsh-host-directory-picker-auto`（自适应选择器）在 Windows 上**永远**选 native：

```js
// dsh-host-directory-picker-auto/lib/index.js L67
if (facts.platform === "darwin" || facts.platform === "win32") return "native";
```

而 native backend 通过**子进程**驱动 Win32 `IFileOpenDialog` —— 那条链路在你的环境里失败。

DSH 自己的 README 指明了替换方式：

> *"Pinning an interaction means composing that `-native` or `-browse` row directly instead of this one — that is the seam's documented swap point."*

### 修复内容

`desktop-profile/cordis.patch.yml`：

```yaml
- id: directory-picker
  disabled: true

- insert:
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
```

**browse backend 不启动任何子进程** —— 它用 Node 标准库列目录，
选择器在应用内渲染，因此没有 worker 可以丢失。

### 验证结果

```
autoDisabled:            true     ← 自适应选择器已禁用
browseCapabilityPresent: true     ← browse 已接管
nativeCapabilityAbsent:  true     ← native 链路已完全移除
swapSucceeded:           true
listProbe: { entries: 48, hasHome: true }   ← browse 实际可用
```

**回退方式**：删除 patch 里的这两项，即可恢复原生对话框。

**代价**：失去系统原生对话框，改为应用内选择。

---

## 二、根因：未定位

**我做了 8 轮针对性验证，每一轮都显示 native 链路是正常的。**

| # | 验证方式 | 结果 |
|---|---|---|
| 1 | 源码树 fork worker | **正常** —— 对话框打开，返回 `done` |
| 2 | 打包树 fork（显式 unpacked 路径） | **正常** |
| 3 | 打包树 fork（asar 路径） | **正常** —— `sawShowing: true` |
| 4 | 直接 import picker 并 pick | **正常** —— 返回 `null`（取消） |
| 5 | 真实 host + native capability pick | **正常** —— 超时中断 |
| 6 | 打包 anchor + 打包 profile 启动 host | **正常** |
| 7 | picker 的**精确** stdio 配置（`inherit` + `windowsHide`） | **正常** |
| 8 | **打包版运行时内的真实 spawn 探针** | **正常** —— `exit code=0`，stderr 为空 |

**第 8 项最关键** —— 它在打包版 `DSH Desktop.exe` 的真实主进程里执行了与 picker 完全相同的 spawn：

```
picker worker: ...app.asar\...\worker.cjs
picker probe exit: code=0 signal=null
picker probe stderr: (empty)
picker probe timeout reached (dialog likely open)   ← 对话框确实打开了
```

**我没能在受控环境中复现这个失败。**

---

## 三、调查中被推翻的假设

| # | 假设 | 推翻方式 |
|---|---|---|
| 1 | koffi 未构建 | 在 Node 与 Electron 下都能加载 `ole32.dll` |
| 2 | `@koromix/koffi-win32-x64` 缺失 | 打包版里有，1MB，加载成功 |
| 3 | asar 路径无法被 spawn 执行 | asar 与 unpacked **两条路径都能成功 fork** |
| 4 | `files` 排除可让 worker 只在 asar 外 | 会导致包**完全消失**，更糟 |
| 5 | `inherit` stdio 在 GUI 进程中失败 | 三种 stdio 配置**全部正常** |
| 6 | anchor 重写能修复 | 有效但**不影响** `import.meta.url`，未解决本问题 |

**第 6 项是重要教训**：我曾基于间接证据声称"修复已验证"，那是错的。

---

## 四、DSH 自身记录的已知弱点

`dsh-host-directory-picker-native` README 明确列出：

> **"Windows has no mechanism fallback"** — the child-process picker through
> packaged koffi is the only native tier, so a COM refusal or dialog crash
> surfaces the failure.

> **"Windows foreground grant relies on injected input"** — the child synthesizes
> an Alt press before `Show` so the dialog can take the foreground from a
> background host; **where synthesized input is suppressed (secure desktops,
> restricted remote sessions, an elevated foreground window), the dialog may still
> open behind other windows. The technique is validated on Windows 11 only.**

**第二条值得关注** —— 如果 worker 在 `Show` 阶段崩溃（而非 spawn 阶段），
现象正好是 "exited before reporting a result"。

**符合以下任一情况时，这可能是解释：**
- 安全桌面 / 受控桌面环境
- 远程会话（RDP）
- 前台窗口是提权进程
- 非 Windows 11

---

## 五、如果将来要恢复原生对话框

1. 删除 `cordis.patch.yml` 中的两项（回退到 native）
2. **先确认失败的确切阶段**：对话框是否短暂出现过？
   - 完全没出现 → spawn 阶段
   - 出现后消失 → `Show` 阶段崩溃（对应第四节第二条）
3. 可启用运行时探针：`DSH_DESKTOP_PROBE_PICKER=1` 启动打包版，
   会执行一次真实的 picker spawn 并输出 worker 的 stderr

---

## 六、诊断工具（已保留）

| 脚本 | 用途 |
|---|---|
| `scripts/diagnostics/diagnose-picker-backend.mjs` | 查看实际挂载了哪个 backend |
| `scripts/diagnostics/verify-browse-swap.mjs` | 验证 browse 切换已生效 |
| `scripts/diagnostics/repro-directory-picker.mjs` | fork worker 并观察对话框 |
| `scripts/diagnostics/test-worker-fork.mjs` | 在 Electron 主进程里 fork（asar vs unpacked） |

`host.ts` 在启动时输出 worker 路径（两版都有）：
```
[dsh-desktop] picker worker: ...
[dsh-desktop] picker worker inside asar: ..., exists: ...
```

---

## 七、我的失误

**我此前声称"修复已验证"，那是基于错误的验证方法。**

当时验证的是**路径层面**（worker 能被 spawn、路径正确），
而非**端到端点击**。我应该在发现无法复现后立即说明，而不是宣布修复。

本次改为：**切换到一条不依赖那个失败子系统的实现路径**，
并明确标注"根因未定位"。

---

## 八、证据强度

- **实测确认**：browse 切换生效（capability 已替换、list 返回 48 项）；
  第一节 8 项 native 验证全部通过
- **未能复现**：用户报告的错误信息
- **未验证**：browse backend 在打包 UI 中的端到端点击体验（需人工确认）
