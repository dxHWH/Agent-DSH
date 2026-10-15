# 安装包启动失败：peer-only 包从未进入归档

**现象。** 全新安装的版本启动失败，错误窗口里只有一行：

```
DSH host failed to start
Cannot find package '@deepseek-ai/cordis-plugin-group' imported from
…\resources\app.asar\node_modules\@deepseek-ai\dsh-app-boot\lib\index.js
```

这个包在源码树里存在，开发模式下也正常。只有打包版是坏的。

**原因。** electron-builder 沿 `dependencies` 决定打包内容。但 DSH 把很多
**运行时必需**的包声明为 `peerDependencies` —— cordis 插件链，以及各 seam 包
（`dsh-fs`、`dsh-sandbox`、`dsh-settings`、`dsh-shell` 等）。peer 依赖不会被
提升进 electron-builder 遍历的那棵树，所以这些包躺在 `node_modules` 里却从未
进入归档。宿主启动时会 import 它们，于是在遇到的第一个就倒下了 ——
`cordis-plugin-group`，被 `dsh-app-boot` 直接 import。

错误里那一个名字具有误导性：它只是第一个缺失项。对已安装归档的审计发现
**24 个包缺失**：

```
cordis-plugin-group        dsh-jobs                    dsh-session-telemetry
dsh-anonymous-user-id      dsh-output-retention        dsh-session-title-llm
dsh-attachment             dsh-sandbox                 dsh-settings
dsh-authorization          dsh-sdk-protocol            dsh-shell
dsh-bash-local             dsh-session-persistence     dsh-spill
dsh-code-runtime           dsh-session-query           dsh-subagent-in-process-driver
dsh-compaction                                         dsh-util-time
dsh-fs                     dsh-hook-protocol           dsh-util-workspace-path
                                                       dsh-workflow
```

这 24 个**全部是 peer-only**，且每一个都被至少一个**确实已打包**的包声明为
peer。这就是特征信号：归档里有声明者，却没有依赖本身。

这也解释了为什么开发阶段从未发现。`npm start` 从源码树运行，那里的
`node_modules` 无论怎么声明都有全部 240 个包。这个缺陷只存在于打包产物中。

## 修复方式

这 24 个包被显式声明进 `package.json` 的 `dependencies`，版本锁定为
`node_modules` 中已经解析出来的版本，从而让 electron-builder 的遍历能到达
它们。不会触发任何安装变更 —— 树里本来就是这些版本；声明只是让打包器看得见
它们。

已验证：归档中 **240 个中的 240 个** `@deepseek-ai` 包齐全，安装版启动干净。

## 为什么这值得加一道防线，而不只是打个补丁

这个缺陷类别有两个危险特性：

1. **打包之前不可见。** 所有开发信号 —— `npm start`、各项自检、各项审计 ——
   都跑在一个这些包确实存在的树上。
2. **它一次只暴露一个包。** 错误报的是启动序列最先到达的那个 import，所以
   只修那一个，会得到一个名字不同、本质相同的失败。

因此 `scripts/audit-packaged-packages.mjs` 会把归档与磁盘对比，缺任何东西就
失败。它作为 `postdist` 运行，所以 `npm run dist` 现在会在构建时就报告归档不
完整，而不是等到用户第一次启动。

诊断配套脚本：`scripts/diagnostics/diagnose-missing-packages.mjs` 会为每个缺失包报出「谁
声明了它、声明在哪个字段」，从而解释**为什么**缺失。正是它识别出了 peer-only
这个模式。

## 验证

| 检查项 | 结果 |
| --- | --- |
| `node scripts/audit-packaged-packages.mjs <asar>` | 240/240，0 缺失 |
| 安装版启动 | 是，stderr 为空 |
| `node scripts/verify-packaged-ui.mjs <port>` | 5/5 |

## 相关

这是本项目第三个**仅打包环境出现**的缺陷，前两个是
`docs/packaged-plugin-failure.zh.md`（客户端插件解析失败）和
`docs/directory-picker-failure.zh.md`（选择器 worker）。共同点在于：打包运行时
与源码检出一个真正不同的环境，而每一处差异都必须在**产物中**验证，不能从一
个能跑通的开发循环里推断。
