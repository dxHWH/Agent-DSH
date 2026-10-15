# 08 · 排障与已知问题

## 1. 第一步永远是看日志

- 从命令行启动，看 `[dsh-desktop] …` 开头的启动轨迹：
  - 开发态：`npm start` 的终端；
  - 打包态：`& "<程序目录>\Agent Desktop.exe"`（PowerShell 前台运行，stdout 会打出来）。
- 渲染进程错误：主窗口按 `Alt` 显示菜单 → View → Toggle Developer Tools → Console。
- 设置窗口 → 诊断信息：版本、数据根、profile 目录、端口、是否打包。
- 一条通用规律：**打包版报 "worker exited / 解析失败 / Cannot find module" 时，先看路径是否落在 `app.asar\` 内**。

## 2. 现象 → 原因速查

| 现象 | 根因 | 处理 / 参考 |
|---|---|---|
| 打包版窗口 "Failed to load plugins" | ① profile 解析不到 DSH 包；② client.js 内联了共享模块（missed the module table）；③ Cookie 堆积导致 HTTP 431 | ① `extraResources` 放 DSH 树副本（`../packaged-plugin-failure.zh.md`）；② tsdown `deps.neverBundle: true` + `verify-archive-client.mjs`；③ 启动时自动清理旧 `dsh-auth-*` Cookie |
| 打包版启动失败、缺一批包 | peer-only 包没进 asar | `../packaged-peer-dependency-failure.zh.md`、`npm run verify:packaged-packages` |
| 打包版多个 typert contributor 失败（缺 `zod` 等） | profile 内 DSH 副本没有同级普通依赖 | `../packaged-profile-dependencies.zh.md`，补 `electron-builder.config.cjs` filter |
| "win32 folder dialog worker exited before reporting a result" | 原生选择器 spawn asar 内文件 | 已换成应用内浏览选择器（`desktop-profile/cordis.patch.yml`）；`../directory-picker-failure.zh.md` |
| 选择工作区后一直停在"选择一个工作区开始" | `agent-presets.default` 指向不存在的预设 | `presets.ts` 启动自动修复；`../dangling-preset-default.zh.md` |
| glob/grep 报 "ripgrep provider failure" | 缺 `@vscode/ripgrep-win32-x64` | 确认在 filter 中 |
| 打包版插件报 `Cannot find module '<dep>'` | 插件依赖被提升到根 node_modules，没进 `EXAMPLE_RUNTIME_DEPS` | 把依赖及传递依赖加入 `EXAMPLE_RUNTIME_DEPS` |
| 别的机器上项目模式 / 点踩不加载 | profile 里的 Junction 指向构建机路径 | `scripts/after-pack.cjs` 实体化 Junction，残留链接即构建失败 |
| 程序放在中文路径下启动即崩溃 `length_error: basic_string` | `fs.cpSync` 在 Windows 非 ASCII 路径崩溃，try/catch 拦不住 | 统一用手写递归复制（`agent-preset.ts`、`paths.ts`）。**运行时代码禁止用 `fs.cpSync`** |
| 打包版重建索引报 worker 无法启动 | `new Worker()` 指向 `app.asar` 内文件 | worker 入口在 `asarUnpack`，路径经 `unpackAsarPath` 重写 |
| 示例工具回答"No project directory is bound" | 预设里 projectRoot 为空 | 设置 → 工程目录 → 保存 → 重启 |
| 设置里保存工程目录报找不到 `tool-example` 插件行 | 预设被改坏或格式被改（`mcp.ts` 按文本定位） | 删除 `<数据根>\.agent-presets\project\` 重启 |
| 知识库工具不可见 / 兜底不触发 | `mcp-knowledge` 仍为 `disabled: true`，或未装 Node / mcp-remote | 设置 → MCP 服务器启用并改成真实地址；装好后重启 |
| 知识库要求重新登录 | OAuth 令牌失效 | 删 `%USERPROFILE%\.mcp-auth` 重启 |
| 点踩归档（wecom）报 640008 等权限错误 | 机器人无权限写目标目录（换机器人后旧 folder_id 失效） | 不写死 `rootFolderId`，自动在机器人空间按名建目录 |
| 企业微信授权报 853000 | Bot ID / Secret 错误 | 正式凭证不会被覆盖，重新输入 |
| 设置窗口某个卡片一直转圈 | 主进程是旧版本，没有新 IPC | 重启应用 |
| 查询很慢，回答末尾提示"去设置里重建索引" | 索引缺失 / 过期（源文件改了或版本常量升级） | 设置 → 查询索引 → 重建 |
| 重建提示 "another build is already running" | 已有重建在进行，或残留 `build.lock` | 等待或取消；死进程留下的锁会被自动回收 |
| `npm run dist` 报 EBUSY | 有 Agent Desktop 在运行占用 release 目录 | Ctrl+Q 退出（关窗只是隐藏） |
| `npm run brand` 报 `neither signature nor marker found` | DSH 升级后压缩代码变了 | 更新脚本中的签名（05 号 §7），或不使用品牌补丁 |
| 中文 YAML 乱码 / settings.yaml 解析失败 | GBK/UTF-8 往返导致乱码字符吞掉换行 | UTF-8 无 BOM；不要用 PowerShell 5 默认编码改写 |
| 开发态启动后直接退出 | 已有 Agent Desktop 实例（单实例锁，共用数据根） | 退出正式版或用 `--user-data-dir` |

## 3. 已知未修复 / 需要留意

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | `verify:profile-deps` 可能报浏览器端模块（如 `immer`）`[NOT ON DISK EITHER]` | 运行时无影响（浏览器端模块由 DSH 前端模块表提供）；但会让 `postdist` 以非 0 退出 | 在 `scripts/audit-profile-dependencies.mjs` 加白名单，或在 filter 里排除该 devDependency |
| 2 | 品牌补丁直接改 `node_modules` | 重装依赖后丢失，DSH 升级必坏 | 可选功能；长期可改为 patch-package |
| 3 | 预设模板更新不会推送给已安装用户 | 用户拿不到新的 agent 组成 | 在 `agent-preset.ts` 写定向迁移 |
| 4 | DSH 是 `0.1.5-rc.2` 候选版 | 上游会有破坏性变更 | 锁版本；升级按 05 号 §9 |
| 5 | 无代码签名、无自动更新、无 CI | SmartScreen 警告；手动分发 | — |
| 6 | 开发态与正式版共用 `%APPDATA%\Agent Desktop` | 开发测试污染真实数据 | 开发时用 `--user-data-dir` |
| 7 | 部分研究笔记仍使用旧名 DSH Desktop | 文档混淆 | 以 `docs/handbook/` 为准 |

## 4. 根因分析文档索引

`../phase0-findings.zh.md`（为什么不能 file://）、`../phase1-notes.zh.md`（宿主启动、patch 语义）、`../packaged-plugin-failure.zh.md`、`../packaged-peer-dependency-failure.zh.md`、`../packaged-profile-dependencies.zh.md`、`../directory-picker-failure.zh.md`、`../dangling-preset-default.zh.md`、`../dsh-desktop-subprocess-status.md`、`../issue-dsh-desktop-subprocess-failure.md`。
