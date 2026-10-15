# 悬空的默认 preset：为什么「选择工作区」没有反应

**现象。** 打包后的桌面客户端里，选择工作区看起来成功了，然后什么也没发生。
「选择工作区」按钮能打开菜单，「添加工作区…」能打开应用内目录浏览器，**打开**
能列出真实目录，选中的文件夹甚至出现在侧边栏的「工作区」下面 —— 但主视图永远
停在「选择一个工作区开始」。任何地方都没有错误对话框；如果不主动去翻，控制台
也是安静的。

**原因。** 与目录选择器无关，也与桌面外壳无关。`settings.yaml` 里写着：

```yaml
agent-presets:
  default: code
```

`code` 不是这个 DSH 版本随附的 preset。`AgentPresets.resolve()` 遇到未知 id
**不会回退**，而是直接抛出：

```
agent-preset/not-found: preset "code" not found
(available: standard, ptc, minimal, cordis, project)
```

选择工作区会触发创建会话，而创建会话要解析默认 preset。于是失败发生在 UI 让你
看得见的那一步**之后** —— 这就是为什么看起来像是选择器坏了。

**为什么错误看不见。** hero picker 的 `onPick` 处理器吞掉了这个拒绝：

```js
onPick: (workspaceId) => {
  setPickerOpen(false);
  setPendingWorkspaceId(workspaceId);
  selectWorkspace(workspaceId).catch(() => {
    setPendingWorkspaceId((current) => current === workspaceId ? void 0 : current);
  });
}
```

那个 `catch` 把乐观更新回滚掉，什么也不显示。唯一的痕迹是另一个调用点发出的
`console.warn`（`initial workspace selection failed: …`）。侧边栏自己的
`startSession` 路径也会打类似的警告。两者都不会出现在 UI 上。

**为什么 id 会悬空。** `settings.yaml` 会在机器之间、DSH 版本之间被搬运，而
preset 集合因版本而异。来源是本机的 `~/.dsh/settings.yaml` —— 它带着
`default: code`，而全局 DSH 安装会拿另一套 preset 去解析它。桌面数据根继承了
同一个值。在 DSH 0.1.5-rc.2 上只随附四个 preset：

```
cordis  minimal  ptc  standard
```

整个安装中都不存在 `code` preset。它是别的版本留下来的残渣，而不是一个可以被
尊重的用户选择。

## 修复方式

`src/main/presets.ts` 在启动时、窗口能创建会话之前，对悬空的默认值做一次性修复。
它沿用 `locale.ts` 的纪律：

- **只碰悬空的 id。** 配置的 id 能解析就一个字节都不写 —— 包括像 `cordis`
  这种不常见但合法的选择。
- **只替换值本身。** 注释、键顺序、缩进风格以及其他所有 section 都逐字节保留。
  不做 YAML 往返。
- **空的 preset 列表意味着「什么都别动」。** 枚举失败绝不能被当成「没有
  preset」，否则会把一个本来正确的默认值改坏。
- **不代写缺失的 preset。** 悬空的 id 指向一个不存在的东西；凭空造出来会悄悄
  改变 agent 行为。
- **回退值本身也要校验**，因此修复不可能再写出第二个悬空 id。

权威的 preset 列表来自运行时组合（`host.availablePresets()`），而不是假定值，
因为随附集合会随版本变化。

在带 `default: code` 的数据根上观察到的启动日志：

```
[dsh-desktop] presets: 5 available (standard, ptc, minimal, cordis, project)
[dsh-desktop] preset default: repaired — default preset "code" does not exist
              in this build; reset to "standard"
```

同一数据根第二次启动：

```
[dsh-desktop] preset default: unchanged — default "standard" resolves
```

## 顺带发现的第二个、无关的缺陷

在验证修复时，DSH 干脆启动不了：

```
settings-file: invalid document at …/settings.yaml:
BLOCK_AS_IMPLICIT_KEY at line 103, column 17
```

第 103 行有两个键挤在同一行，因为模型名里一个乱码字符在早先某次
GBK/UTF-8 往返中吞掉了换行：

```yaml
- id: my-model-selfhosted
  name: My-Model-鑷儴缃?          contextWindow: 200000    # 两个键，一行
```

这是 `settings.yaml` 里既有的损坏，与桌面外壳无关，而且会让**任何**客户端的
DSH 启动失败。已修复为：

```yaml
- id: my-model-selfhosted
  name: My-Model-自部署
  contextWindow: 200000
```

本机两份 `settings.yaml` 都在同一行受影响，均已修复。当 `settings.yaml` 在机器
之间搬运时值得记住：值里的乱码可能破坏的是**结构**，而不只是文字。

## 验证

| 检查项 | 结果 |
| --- | --- |
| `node scripts/selfcheck-presets.mjs` | 22/22 |
| 打包/开发版应用自愈 `default: code` | `repaired` → `standard`，stderr 为空 |
| 第二次启动幂等 | `unchanged` |
| 选择工作区后能到达输入框 | 是（textarea 存在，无警告） |
| `project`（项目模式）仍可选 | 是，5 个 preset 之一 |

## 有意不做的事

- **不在 DSH 里修。** `resolve()` 的硬失败是 DSH 自身的设计，安装目录不做修改。
  修复放在外壳里，因为可搬运的 `settings.yaml` 归外壳管。
- **不为它做 UI。** 这不是面向用户的功能，而是针对一类陈旧配置的防护。它只记
  日志然后继续。
