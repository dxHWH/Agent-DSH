# 点踩归档（Feedback Archive）

在 Agent Desktop 中，对某条回答点 **👎（点踩）** 并填写原因后，这一轮的完整对话（提问、回答、工具调用、用量）会被打包成一个 ZIP，用于后续复盘和改进。

- **默认后端：本地**——ZIP 保存在本机目录，无需任何配置。
- **可选后端：企业微信微盘**——上传到团队共享的微盘目录，需要安装 wecom-cli 并授权一个企业微信智能机器人。

插件与仓库中**不保存任何凭证**。

---

## 1. 使用方法

1. 在回答下方点 👎。
2. 在弹窗中选择分类（任务结果 / 指令理解与遵循 / 产品功能与交互 / 稳定性和速度 / 资源使用与费用 / 安全隐私与权限 / 其他），填写原因（可选），提交。
3. 成功后提示保存位置（本地路径或微盘目录）。失败时提示具体阶段和原因（见 §6）。

点 👍 只是本地标记，不会归档。

---

## 2. 本地后端（默认）

不需要任何配置。ZIP 保存在：

```
<localDir>/<模式>/<YYYY-MM-DD>/<名称>.zip
```

- `localDir` 默认为 `<数据根>\feedback-archive`（默认数据根为 `%APPDATA%\Agent Desktop\dsh-home`，可在 设置 → 诊断信息 查看）。
- `<模式>` 为会话所用预设（例如 `project`、`standard`）。
- 想改目录：在 `<数据根>\settings.yaml` 中设置（见 §5），重启生效。

---

## 3. 企业微信微盘后端（可选）

### 3.1 前提

| 项 | 说明 |
|---|---|
| wecom-cli | **默认不随包分发**。安装：`npm i -g @wecom/cli`（需要系统 Node） |
| 企业微信智能机器人 | 由企业管理员创建，获得 **Bot ID**（以 `aib_` 开头）与 **Secret**，并为机器人开通微盘能力 |
| 网络 | 能访问 `qyapi.weixin.qq.com` |

wecom-cli 查找顺序：

1. `settings.yaml` 中 `feedback-archive.wecomCliPath`；
2. 环境变量 `WECOM_CLI`；
3. `%APPDATA%\npm\wecom-cli.cmd`（即 `npm i -g @wecom/cli` 的安装位置）；
4. 程序目录 `resources\wecom-cli\wecom-cli.exe`（仅当打包者手动放入时存在）。

### 3.2 授权机器人（每台机器一次）

**方式 A：设置窗口**

1. 托盘 → Settings…（或主窗口 `Ctrl+,`）→「企业微信归档（可选）」。
2. 填写 Bot ID 与 Secret →「验证并保存」。
3. 应用会先在**临时目录**里验证凭证，验证成功才替换正式凭证；失败不会覆盖已有的正式凭证。

**方式 B：命令行**

双击程序目录中的 `wecom-auth.cmd`，按提示输入 Bot ID 与 Secret。

凭证由 wecom-cli 加密保存在 `%USERPROFILE%\.config\wecom\`（`credentials.enc`、`.encryption_key`）。退出授权：设置窗口点「清除本机授权」，或删除该目录。

### 3.3 切换到 wecom 后端

编辑 `<数据根>\settings.yaml`：

```yaml
feedback-archive:
  backend: wecom
```

重启应用。

### 3.4 微盘目录结构

```
<rootName>/<模式>/<YYYY-MM-DD>/<名称>.zip
```

- `rootName` 默认为 `AgentDesktop反馈归档`。
- `rootFolderId` 为空（推荐）时，在**机器人自己的微盘空间**里按名称查找该根目录，不存在则创建；日期与模式子目录同理自动创建。
- 机器人**只能写入它自己创建的目录**。如果手动指定了 `rootFolderId` 而该目录不是这个机器人创建的（例如换了机器人），会报权限错误 640008——清空 `rootFolderId` 即可自愈。
- 想让团队成员看到归档：在企业微信微盘中把机器人创建的根目录共享给相关成员。

---

## 4. ZIP 内容

文件名：`[<模式标签>]<用户提问前 16 个字>_<8 位短 id>.zip`（过长时退化为 `<短 id>.zip`）。

| 文件 | 内容 |
|---|---|
| `manifest.json` | 归档元信息：归档 id、时间、会话 id、模式、文件清单 |
| `session.json` | 会话元信息 + 轮次摘要索引 |
| `turn-NN.json` | 该轮完整的机器可读记录（提问、回答、工具调用与结果、用量） |
| `turn-NN.md` | 同一轮的人读 Markdown |
| `feedback.md` | 点踩反馈：分类标签 + 原因文本 |

> 归档内容包含该轮对话中出现的全部文本（包括工具读到的文件片段）。若对话涉及敏感信息，请谨慎选择后端与共享范围。

---

## 5. `settings.yaml` 配置项（命名空间 `feedback-archive`）

| 键 | 默认 | 说明 |
|---|---|---|
| `backend` | `local` | `local` = 保存到本地目录；`wecom` = 上传企业微信微盘 |
| `localDir` | `''` | 本地归档目录；空 = `<数据根>/feedback-archive` |
| `wecomCliPath` | `''` | [wecom] wecom-cli 路径；空 = 按 §3.1 顺序自动探测 |
| `rootFolderId` | `''` | [wecom] 归档根目录 folder_id；空 = 按 `rootName` 查找 / 创建（推荐） |
| `rootName` | `AgentDesktop反馈归档` | [wecom] 归档根目录名 |

示例：

```yaml
feedback-archive:
  backend: local
  localDir: D:\AgentDesktop\feedback
```

修改后重启应用。请用 UTF-8（无 BOM）编辑该文件。

---

## 6. 常见错误

| 提示 | 原因 | 处理 |
|---|---|---|
| 未找到 wecom-cli | 未安装或路径不对 | `npm i -g @wecom/cli`，或设置 `wecomCliPath` / `WECOM_CLI` |
| 853000 | Bot ID / Secret 错误 | 重新授权（正式凭证不会被错误输入覆盖） |
| 640008 | 机器人无权写目标目录 | 清空 `rootFolderId`，让机器人在自己的空间建目录 |
| 网络错误 / 超时 | 无法访问 `qyapi.weixin.qq.com` | 检查网络 / 代理；或改回 `backend: local` |
| 找不到会话 / 消息 | 会话已删除或消息不属于该会话 | 在原会话中重新点踩 |
| 设置窗口企业微信卡片一直转圈 | 程序更新后未重启 | 完全退出（Ctrl+Q）后重新打开 |

---

## 7. 开发者说明

- 插件：`packages/dsh-tool-feedback-archive`。host 半注册 `POST /api/feedback-archive`（body `{sessionId, messageId, note, category}`），读取实时会话（`snapshotEvents()`）或冷存储会话日志（`.jsonl.zstd`），转换 → fflate 打包 → 本地保存 / 上传。
- 选择普通 HTTP 路由而不是 Typert Remote 接口：Remote 需要代码生成步骤，壳层仓库里不运行该生成器。
- client 半替换 DSH 原生 👍/👎（slot `conversation.chat.assistant-actions`），bundle 不得内联依赖（`scripts/verify-archive-client.mjs` 守卫）。
- 端到端测试：`node scripts/archive-dsh-session.mjs <会话日志> <messageId> --dry-run`。
