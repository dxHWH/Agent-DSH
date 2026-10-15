# 04 · 开发环境搭建（第一天照着做）

> 目标：在一台全新的 Windows 10/11 x64 上 → `npm start` 跑起来 → 能打出免安装版。

## 0. 准备软件

| 软件 | 版本 | 必需？ | 说明 |
|---|---|---|---|
| Node.js | **≥ 22**（需要 `node:sqlite`） | 是 | 自带 npm 10/11 |
| Git | 任意 | 是 | |
| PowerShell 7（pwsh） | 可选 | 否 | 脚本兼容 Windows PowerShell 5.1 |
| VS Build Tools / Python | — | **否** | node-pty、koffi 均为预编译二进制 |
| mcp-remote | 最新 | 仅调试知识库 MCP 时 | `npm i -g mcp-remote` |
| wecom-cli | 最新 | 仅调试企业微信归档后端时 | `npm i -g @wecom/cli` |

**磁盘**：工程 + node_modules ≈ 0.7 GB；每次打包 release ≈ 1–1.5 GB。
**路径**：仓库可放任意目录，**含空格可以**；**避免**放在非 ASCII（中文）路径下做开发（`fs.cpSync` 在中文路径会让进程崩溃，运行时代码已规避，但构建工具链未全量验证）。

## 1. 获取源码

```powershell
git clone <仓库地址> D:\work\agent-desktop
cd D:\work\agent-desktop
```

## 2. 安装依赖

```powershell
npm ci
```

npm 11 可能提示 install scripts 被拦截，批准后重装：

```powershell
npm install-scripts approve electron @deepseek-ai/dsh-subprocess-local koffi node-pty protobufjs @google/genai
npm ci
```

Electron 二进制下载慢/失败时可设置镜像：

```powershell
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm ci
```

### 安装后检查

```powershell
node -v                                                          # ≥ v22
(Get-Item node_modules\@deepseek-ai\dsh-tool-example).LinkType   # Junction
(Get-Item node_modules\@deepseek-ai\dsh-tool-feedback-archive).LinkType  # Junction
Test-Path node_modules\electron\dist\electron.exe                # True
npm run brand                                                    # 可选：品牌补丁（幂等）
```

> **为什么是 Junction**：两个本地包以 `file:packages/<名>` 依赖安装，npm 在 Windows 上建目录联接。这样改了 `packages/` 下的代码、`npm run build:example` 后立刻生效；打包时 `after-pack.cjs` 会把它们实体化。若离线拷贝 `node_modules`，需手工重建：
> ```powershell
> New-Item -ItemType Junction -Path node_modules\@deepseek-ai\dsh-tool-example -Target (Resolve-Path packages\dsh-tool-example)
> New-Item -ItemType Junction -Path node_modules\@deepseek-ai\dsh-tool-feedback-archive -Target (Resolve-Path packages\dsh-tool-feedback-archive)
> ```

## 3. 构建与运行

```powershell
npm run build      # 两个插件 → 主进程 → preload → assets（含 client.js 守卫）
npm start          # build + electron .
```

首次启动会：在 `%APPDATA%\Agent Desktop\dsh-home` 建数据根 → 写 zh / 模型种子 / 项目预设 → 弹出 API Key 引导。

> ⚠️ 若这台机器也装了 Agent Desktop 正式版：两者**共用数据根且单实例**。开发时建议隔离：
> ```powershell
> npm run build; npx electron . --user-data-dir="D:\tmp\agent-dev"
> ```

## 4. 首次配置

1. **API Key**：引导弹窗填 `DEEPSEEK_API_KEY`（用你自己的 Key）。之后可在主窗口 设置 → 模型 修改；文件位于 `<数据根>\.credentials.yaml`。
2. **切到项目模式**：主窗口会话的预设选择器里选「项目模式」。
3. **工程目录**：`Ctrl+,` →「工程目录与查询索引」选择任意文本工程（例如本仓库自身）→ 保存 → 重启。
4. **查询索引**：同一页「重建索引」。
5. （可选）**知识库 MCP**：装系统 Node + `npm i -g mcp-remote`，在设置窗口「MCP 服务器」中把 `knowledge` 改成你的服务地址并启用（或编辑预设去掉 `disabled: true`），重启；首次调用会弹浏览器 OAuth 登录。
6. （可选）**企业微信归档**：见 [`../feedback-archive.md`](../feedback-archive.md)。

## 5. 验收清单

| # | 验证 | 命令 / 操作 | 期望 |
|---|---|---|---|
| 1 | 依赖完整 | `npm run build` | 无报错，最后一行 `[build] preload settings.js -> settings.cjs` |
| 2 | 纯 Node 自检 | `npm run selfcheck:presets` | 全部 passed |
| 3 | 壳层自检 | `npm run selfcheck` | 全部 PASS（会弹出/关闭 Electron 窗口） |
| 4 | 启动 | `npm start` | 窗口标题 Agent Desktop |
| 5 | 设置窗口 | `Ctrl+,` | 诊断信息里 Host port 为数字，DSH 版本 0.1.5-rc.2 |
| 6 | 示例工具 | 项目模式下问「在工程里找一下 `startHost` 在哪定义」 | 调用 `example_search`，返回带 `文件:行号` 证据的结果 |
| 7 | 打包 | `npm run bundle:portable` | 输出 `release\Agent-Desktop-portable-<版本>-<日期>\` |
| 8 | 打包产物依赖审计 | `npm run verify:packaged-packages`、`npm run verify:profile-deps` | 全部 OK |
| 9 | 新机器模拟 | `powershell -ExecutionPolicy Bypass -File scripts\launch-fresh-test.ps1 -TestRoot D:\AgentDesktop-Test` | 以全新数据根启动，出现 API Key 引导 |

## 6. 推荐的编辑器设置

- VS Code + 内置 TypeScript；文件一律 **UTF-8 无 BOM、LF**（`.cmd/.bat` 为 CRLF，`.gitattributes` 已强制）。
- 不要用 Windows PowerShell 5.1 的 `Get-Content/Set-Content` 默认编码改中文 YAML（会乱码），用编辑器或加 `-Encoding utf8`。
- 在本仓库使用 AI 编程助手时，它会读取根目录 `AGENTS.md`。
