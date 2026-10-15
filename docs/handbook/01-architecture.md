# 01 · 架构总览

## 1. 产品是什么

**Agent Desktop** 是一个 Windows 桌面 AI 助手，也是"在 DSH 之上做领域定制"的参考工程：

- 外壳是 **Electron 37**（内置 Node 22.21），仅支持 **Windows 10/11 x64**。
- 内核是 **DeepSeek Harness（DSH）`0.1.5-rc.2`**，从公共 npm 安装的 `@deepseek-ai/*` 包，**不是源码 fork**。
- 在 DSH 之上增加了：
  1. **项目模式**（一个 agent preset）：标准编码 Agent + 示例领域工具 `example_search` / `example_index_status` + 可选知识库 MCP 兜底；
  2. **查询索引**：示例工具在 `<工程>/.agent-index/` 维护 SQLite 倒排索引，由设置窗口显式重建；
  3. **点踩归档**：在回答下点 👎，把这一轮完整对话打包成 ZIP，默认存本地，可选上传企业微信微盘；
  4. **首次启动引导**：只问 `DEEPSEEK_API_KEY`；
  5. **壳层设置窗口**：数据位置、MCP 服务器、工程目录、查询索引重建、企业微信授权、诊断；
  6. **可选品牌补丁**：`npm run brand` 替换 DSH 前端的 Logo / 标题。

## 2. 架构图

```
┌──────────────────────── Agent Desktop.exe（Electron 主进程，ESM） ────────────────────────┐
│ src/main/index.ts    生命周期、窗口、托盘、菜单、单实例锁、Cookie 清理                      │
│   ├─ paths.ts         解析数据根（userdata/portable/custom/env）→ 设置 process.env.DSH_HOME │
│   ├─ locale.ts        首次运行写 locale: zh                                                 │
│   ├─ model-preset.ts  首次运行写模型种子（assets/model-preset/models.yaml）                 │
│   ├─ agent-preset.ts  首次运行安装项目模式预设到 <数据根>/.agent-presets/project/           │
│   ├─ host.ts  ★唯一导入 @deepseek-ai/* 的文件：进程内 boot DSH（port 0），叠加桌面补丁     │
│   ├─ presets.ts       修复悬空的 agent-presets.default                                      │
│   ├─ settings.ts      壳层设置窗口 + 全部 IPC（shell:*）                                    │
│   │    ├─ mcp.ts            文本级编辑 agent.cordis.yml 的 MCP 行 / tool-example.projectRoot│
│   │    ├─ index-manager.ts  查询索引状态/重建（worker 线程 index-rebuild-worker.ts）        │
│   │    └─ wecom.ts          企业微信机器人授权（node-pty 驱动 wecom-cli auth init，可选）    │
│   ├─ tray.ts / window-state.ts                                                             │
│   └─ preload/settings.ts → window.dshShell（仅设置窗口使用；主窗口无 preload）              │
│                                                                                            │
│   DSH 宿主（同进程） ── profile: desktop-profile/（bundles: dsh-base + dsh-web-app）       │
│     ├─ host 平面：webserver、sessions、LLM 路由、tool-feedback-archive（host 半）           │
│     ├─ agent 预设：standard / ptc / minimal / cordis（DSH 自带）+ project（本项目）          │
│     │     └─ project 预设额外挂载：tool-example（packages/dsh-tool-example）+ mcp-knowledge │
│     └─ client 插件：DSH 自带 + dsh-tool-feedback-archive/lib/client.js（点赞点踩 + 引导）   │
└──────────┬─────────────────────────────────────────────────────────────────────────────────┘
           │ BrowserWindow.loadURL(http://127.0.0.1:<OS 分配端口>/?token=…)
           ▼
    DSH 自带的 Web 界面（dsh-web-frontend，可选品牌补丁）
```

## 3. 三个关键事实（决定了几乎所有设计）

1. **DSH 在 Electron 主进程内启动**（`dsh-app-boot.loadProfileDirectory` + `boot`），不是子进程 `dsh web`。
   因此 Electron 必须 ≥37（Node 22）、主进程必须 ESM、必须在挂载前 `provideCmdline(['--no-open','--port','0'])`。
2. **DSH 自己拥有全部用户配置**（`settings.yaml`、`.credentials.yaml`、会话），壳层只决定 `DSH_HOME` 在哪。
   壳层**不保存**任何平行配置；唯一的壳层文件是 exe 旁的 `desktop-shell.json`（只记录数据位置模式）。
3. **打包后路径语义不同**：DSH 会 `spawn` 子进程、`new Worker()`、`createRequire(profileDir)`，这些都不能读 `app.asar` 内的文件。
   所以 `@deepseek-ai/**` 全部 asarUnpack，并在 `resources/desktop-profile/node_modules` 再放一份 DSH 树 + 普通依赖。
   **绝大多数打包故障都是这个原因**（见 [08-troubleshooting.md](08-troubleshooting.md)）。

## 4. 数据流：一次项目查询

```
用户提问 ─► DSH agent loop（preset=project）
          ─► 模型选择 example_search（系统提示里的 example:tool-quickref section 引导选工具）
          ─► packages/dsh-tool-example：列出 <projectRoot> 下的文本文件
                 ├─ 索引就绪（<projectRoot>/.agent-index/，SQLite）→ 两阶段召回，快
                 └─ 索引缺失/过期/构建中 → 直接扫描文件（慢）+ 提示「去设置里重建索引」（查询路径从不建索引）
          ─► 结果协议 {status, answer, evidence[], artifacts[], payload}
          ─► 若为消极结果（未找到 / capability_gap）且知识库 MCP 工具对当前 agent 可见
                 → 结果尾部追加固定标记 + 指令，agent 同轮调用 mcp__knowledge__kb_query
          ─► write_report=true 时完整结果落盘 <会话工作区>/data/reports/*.md，模型用 present 交付
```

设计思路详见 [`../domain-tool-patterns.md`](../domain-tool-patterns.md)。

## 5. 数据流：一次点踩归档

```
👎（client.js 弹窗：分类 + 原因）─► POST /api/feedback-archive {sessionId, messageId, note, category}
  ─► host 半（packages/dsh-tool-feedback-archive/src/index.ts）读 session 事件流（live 或 .jsonl.zstd）
  ─► convert.ts 切出该轮 → zip.ts（fflate）打包 + feedback.md
  ─► backend=local（默认）：写 <localDir>/<模式>/<YYYY-MM-DD>/<名称>.zip
     backend=wecom：upload.ts 调 wecom-cli 上传到企业微信微盘 <rootName>/<模式>/<日期>/
```

wecom 凭证由 wecom-cli 自己加密保存在 `%USERPROFILE%\.config\wecom\`，插件与仓库**零凭证**。详见 [`../feedback-archive.md`](../feedback-archive.md)。

## 6. 外部依赖一览

| 依赖 | 用途 | 在哪配置 | 备注 |
|---|---|---|---|
| 模型服务（默认 DSH 自带 `deepseek-official`） | 大模型 | `assets/model-preset/models.yaml` → `<数据根>/settings.yaml` | Key 存 `<数据根>/.credentials.yaml` 的 `DEEPSEEK_API_KEY`，每人用自己的。可换 OpenAI 兼容网关（`llm-pi-ai`） |
| 知识库 MCP（可选，示例 URL `https://kb.example.com/mcp`） | 本地查不到时兜底 | 项目预设 `mcp-knowledge` 行（默认 `disabled: true`） | 经 `mcp-remote` 桥接 OAuth；需要系统 Node + `npm i -g mcp-remote`；令牌在 `%USERPROFILE%\.mcp-auth` |
| 企业微信微盘 + wecom-cli（可选） | 点踩归档的远端后端 | 设置窗口「企业微信归档」 + `settings.yaml` `feedback-archive.backend: wecom` | wecom-cli 默认不随包分发，`npm i -g @wecom/cli` 或在 settings 指定路径 |
| 任意文本工程 | 示例工具的数据源 | 设置窗口「工程目录」→ 预设 `tool-example.projectRoot` | 索引写在 `<工程>/.agent-index/`，建议加入工程的忽略列表 |
| npm 公共源 | 安装依赖 | `package-lock.json` | 内网可用镜像源 |

## 7. 当前状态

- 无自动更新、无代码签名（SmartScreen 会警告）、无 CI。
- DSH 为 `0.1.5-rc.2` 候选版，锁版本；升级流程见 [05-maintenance.md](05-maintenance.md) §9。
