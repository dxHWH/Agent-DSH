# 07 · 测试与验证

项目**没有单元测试框架和 CI**，验证全部靠脚本。分 5 类：

## 1. 日常必跑（改完代码就跑）

| 命令 | 运行器 | 内容 | 前提 |
|---|---|---|---|
| `npm run build` | node | 编译 + client.js 守卫 | — |
| `npm run selfcheck:presets` | node | 悬空默认预设修复的边界 | — |
| `npm run selfcheck:shell` | electron | 托盘、设置窗口、IPC、关窗到托盘 | 已 build |
| `npm run selfcheck:portable` | electron | portable 模式：拷文件夹后配置/会话仍在 | 已 build |
| `npm run selfcheck:locale` | electron | 首次 zh 播种，不覆盖已有 en | 已 build |
| `npm run selfcheck` | — | 上面 4 个串行 | 已 build |

自检脚本会在仓库根生成 `*-selfcheck.json` 结果文件（已 gitignore）。

## 2. 示例领域工具

位于 `packages/dsh-tool-example/test/`，先 `npm run build:example`，再 `node test/<脚本>` 运行。脚本应**在临时目录生成一个小型样例工程**（几份含中英文内容的文本文件），不依赖任何真实业务工程，因此任何机器都能跑。建议覆盖：

| 方向 | 断言 |
|---|---|
| 结果协议 | 每个 status 分支都能产出；输出无 `undefined` 键 |
| 扫描 vs 索引一致性 | 同一查询，索引命中与直接扫描返回相同结果集 |
| 查询路径不建索引 | 索引缺失时调用工具后 `.agent-index/` 仍不存在，且回答带重建提示 |
| 过期判定 | 改动一个源文件 / 递增版本常量后状态变为 `stale` |
| 代际切换与锁 | 重建后 `current.json` 指向新代；存在死 pid 的 `build.lock` 可被回收 |
| 知识库兜底 | 消极结果追加标记；误用类 gap、知识库工具不可见时不追加 |
| 路径安全 | 绝对路径、`..`、symlink 逃逸均被拒绝 |
| 报告 | `write_report` 产出文件、`artifacts` 路径相对会话工作区 |

## 3. 打包产物验证（打包后跑）

| 命令 | 内容 |
|---|---|
| `npm run verify:packaged-packages` | app.asar 中是否缺 `@deepseek-ai` 包 |
| `npm run verify:profile-deps` | profile 里的 DSH 副本能否解析所有裸 import |
| `npm run verify:which-copy` | 打包后 Electron 实际加载的是哪一份文件（asar vs unpacked） |
| `npm run verify:packaged-preset-repair` | 预设修复逻辑是否真的进了 asar |
| `npm run verify:packaged-ui` | 启动打包版：选工作区 → 出输入框，预设选择器里有项目模式 |
| `scripts/launch-fresh-test.ps1` | 隔离目录人工走首次安装流程 |

## 4. 功能专项

| 命令 | 内容 |
|---|---|
| `npx electron scripts/selfcheck-wecom-settings.mjs` | 企业微信卡片（假凭证） |
| `node scripts/verify-wecom-auth.mjs` | 企业微信授权后端（输入校验、失败不覆盖） |
| `node scripts/archive-dsh-session.mjs …` | 归档端到端（`--dry-run` 只打包不上传） |
| `scripts/diagnostics/verify-index-manager.mjs` | 设置窗口索引管理（进度、取消、worker 退出收尾） |

## 5. 架构审计（研究性质，回答"能不能"的问题）

`npm run audit:*`、`experiment:*` —— capabilities（与 dsh web 对等）、extensibility、locale、agent-loop、mode-switching、self-maintenance、hot-update、layering、agent-layer-mapping、kernel-iteration、dev-loop、two-loops、sequential-harness。
每个脚本文件头有问题陈述，对应结论在 `docs/<同名>.zh.md`。**升级 DSH 后至少跑 `audit:capabilities` 和 `audit:extensibility`。**

`scripts/diagnostics/` 下是排障一次性脚本，`npx electron scripts/diagnostics/<名>.mjs` 运行，详见其 README。
