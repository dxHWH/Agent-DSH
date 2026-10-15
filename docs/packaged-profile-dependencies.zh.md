# profile 的缺失依赖：15 个 typert contributor 和一个孤零零的 `zod`

**现象。** 在上一次修复之后，安装版走得更远了，然后失败于一整屏都指向同一个
缺失包的错误：

```
dsh-desktop: plugin tree failed to load: failed to apply loader entry
typert-loader (@deepseek-ai/dsh-typert-loader): typert-loader: 15 typert
contributor(s) failed to register:
  - typert-loader: @deepseek-ai/dsh-llm exports "./typert" but importing
    …\resources\desktop-profile\node_modules\@deepseek-ai\dsh-llm\lib\typert.host.js
    failed: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'
  …（另有 14 条，全部是 'zod'）
```

注意路径：是 **`resources\desktop-profile\node_modules\`** —— 不是 `app.asar`。

**原因。** 这是早先某个修复的直接后果。为了让客户端插件解析在打包布局下能工作，
`electron-builder.config.cjs` 把 `node_modules/@deepseek-ai` 复制到了
`desktop-profile/` 下面，好让 `createRequire(profileDir).resolve(...)` 能找到
DSH 的包。

但 DSH 的包也会 import 普通的 npm 依赖 —— `zod`、`commander`、`diff`、
`js-yaml` 等约 30 个。**当时只复制了 `@deepseek-ai`。** Node 解析裸标识符的方式是
从引用文件**向上**查找，所以
`desktop-profile/node_modules/@deepseek-ai/dsh-llm/lib/typert.host.js` 会去查
`desktop-profile/node_modules/`，那里除 `@deepseek-ai` 之外什么都没有。它**不会**
去 `app.asar` 里面找 —— 而那些包恰恰在那里。

在源码检出里这永远不会发生：profile 就位于工程内部，向上查找能到达工程的
`node_modules`，一切都能解析。这个缺陷只存在于打包布局中。

**为什么一个名字出现了 15 次。** typert loader 在一批里 import 15 个
contributor，并逐个报告失败。15 个全都是同一个原因 —— `zod` —— 因为 `zod` 是每个
`typert.host.js` 里的第一个 import。那 15 条是**一个**根因，不是 15 个问题。

## 范围比错误提示的更大

对 profile 真实 import 图的审计发现 **31 个无法解析的包**（下为节选），而不只是 `zod`：

```
@agentclientprotocol/sdk   @babel/code-frame        @earendil-works/pi-ai
@joplin/turndown-plugin-gfm @modelcontextprotocol/sdk @octokit/webhooks
@opentelemetry/api-logs     @opentelemetry/exporter-logs-otlp-http
@opentelemetry/resources    @opentelemetry/sdk-logs  @vscode/ripgrep
commander  compression  diff  eventsource-parser  fflate
ipaddr.js  js-yaml  koffi  mime-types  negotiator
node-addon-require-builtin  node-pty  picomatch  resolve.exports
sharp  turndown  undici  ws  yaml  zod
```

只修 `zod` 只会让下一步得到一个名字不同、本质相同的启动失败。这就是为什么这个
修复是由 **import 图**驱动，而不是由错误信息驱动。

## 修复方式

`extraResources` 现在会把这些包与 `@deepseek-ai` 一起复制进
`desktop-profile/node_modules`。只复制需要的集合（而不是整个 622 MB 的
`node_modules`）让安装包保持在约 133 MB；这 31 个包合计约 57 MB。

## 防线

`scripts/audit-profile-dependencies.mjs` 会从真实 import 图重新计算清单 —— 它遍历
profile 各包中所有宿主侧 `.js` 文件，提取裸 `import`/`require` 标识符，并报告任何
无法解析的项。它作为 `postdist` 的一部分运行，因此某个 DSH 版本新增依赖时，会在
**构建时**被抓住，而不是在用户启动时。

必须排除两类误报，否则审计会一直喊狼来了，把真实发现淹没：

- **浏览器侧的那一半**（`lib/client.js`）。它们由 `client-modules` 提供给渲染进程，
  在浏览器里运行，React 来自前端 bundle。宿主 Node 进程从不执行它们。把它们算
  进来，会永远把 `react`/`react-dom` 报成缺失。
- **Node 内置模块**，以及 `` `${spec}` `` 这类模板字面量片段 —— 压缩过的 bundle 里
  含有它们，标识符正则会把它们当成包名。

## 验证

| 检查项 | 结果 |
| --- | --- |
| `audit-profile-dependencies.mjs <profile>` | 0 个无法解析 |
| `audit-packaged-packages.mjs <asar>` | 240/240，0 缺失 |
| 打包版启动 | 是，`client graph: 53 entries, 2 batches`，stderr 为空 |
| `verify-packaged-ui.mjs <port>` | 5/5 |

## 规律

连续三次**仅打包环境出现**的失败，每一次都藏在上一层的后面：

1. `packaged-plugin-failure.zh.md` —— 客户端插件无法解析自身 manifest。
2. `packaged-peer-dependency-failure.zh.md` —— 24 个 peer-only 包不在归档里。
3. 本次 —— profile 里那份 DSH 树的副本没有同级的依赖。

每一次都是被前一次的修复引入或暴露出来的。共同的教训是：**一棵被复制出来的子树
不是一个可工作的环境** —— 只复制包而不复制它们的依赖闭包，得到的是一个在源码检出
里能解析、在产物里却失败的树。现在两个审计都会在每次 `npm run dist` 时运行。
