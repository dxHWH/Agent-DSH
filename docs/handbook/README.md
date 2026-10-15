# Agent Desktop 开发者手册（索引）

> 产品：**Agent Desktop**（Electron 37 桌面壳 + 内置 DeepSeek Harness `0.1.5-rc.2` + 示例领域工具 + 点踩归档）
> 仓库根：本文件所在仓库，路径任意（工程内没有依赖硬编码绝对路径）。

## 阅读顺序

| 顺序 | 文档 | 读者 | 用途 |
|---|---|---|---|
| 1 | [01-architecture.md](01-architecture.md) | 人 | 这是什么、由哪几块组成、数据怎么流动 |
| 2 | [02-directory.md](02-directory.md) | 人 / AI | 每个目录、每个源文件是干什么的；哪些是生成物 |
| 3 | [03-runtime-environments.md](03-runtime-environments.md) | 人 / AI | 源码开发态 / 打包态 / 免安装包 / 安装包 / `dsh web` 的区别，路径如何解析 |
| 4 | [04-dev-setup.md](04-dev-setup.md) | 人 | 新机器第一天：装依赖、跑起来，含验收清单 |
| 5 | [05-maintenance.md](05-maintenance.md) | 人 / AI | 按"我要改 X"分类的操作步骤（加工具、加 IPC、改预设、改模型种子、改品牌、升级 DSH……） |
| 6 | [06-build-release.md](06-build-release.md) | 人 | 构建链、打包链、发布物、版本号 |
| 7 | [07-testing.md](07-testing.md) | 人 / AI | 所有 selfcheck / verify / audit 脚本，什么时候跑哪个 |
| 8 | [08-troubleshooting.md](08-troubleshooting.md) | 人 / AI | 已踩过的坑、根因、现象 → 原因速查、已知未修复问题 |
| AI | [`/AGENTS.md`](../../AGENTS.md) | AI 编程助手 | 面向 AI 的精简硬规则（DSH 会自动注入在本仓库工作的 Agent） |

## 相关文档

| 文档 | 说明 |
|---|---|
| [`../domain-tool-patterns.md`](../domain-tool-patterns.md) | **★ 领域工具工程模式**：结果协议、证据、知识库兜底、SQLite 索引、路径安全……写领域工具前必读 |
| [`../user-guide.md`](../user-guide.md) / [`../feedback-archive.md`](../feedback-archive.md) | **随免安装版一起发给最终用户**的文档（`bundle:portable` 会复制它们） |
| [`../index-benchmark.md`](../index-benchmark.md) | 查询索引的测量方法与结论 |
| `../*-failure*.md`、`../packaged-*.md`、`../dangling-preset-default*.md` | 已修复故障的根因分析（排障时必读） |
| `../phase0-findings*`、`phase1-notes*`、`capability-audit*`、`layering*`、`hot-update*`、`mode-switching*` 等 | 架构可行性研究与决策依据（部分仍用旧名 "DSH Desktop"） |

## 一句话总结

> Agent Desktop = **Electron 主进程在进程内启动 DSH 宿主** → 原生窗口加载 DSH 自带 Web 界面（`http://127.0.0.1:<随机端口>`）
> + **两个本地 DSH 插件**（`packages/dsh-tool-example`：示例领域工具骨架；`packages/dsh-tool-feedback-archive`：点踩归档 + 首次 API Key 引导）
> + **一个预设模板**（`assets/agent-preset/project`：项目模式 = 标准编码 Agent + 示例工具 + 可选知识库 MCP）
> + **一个壳层设置窗口**（数据位置 / MCP / 工程目录 / 查询索引 / 企业微信授权 / 诊断）。
