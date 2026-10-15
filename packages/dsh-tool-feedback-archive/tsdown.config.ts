import { defineConfig } from 'tsdown'

const PKG_ID = '@deepseek-ai/dsh-tool-feedback-archive'

export default defineConfig({
  entry: ['src/client.tsx'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  outDir: 'lib',
  clean: false,
  dts: false,
  // 输出 client.js（DSH 约定文件名）
  outExtensions: () => ({ js: '.js' }),
  // 保留所有依赖为 external，走 require() 共享模块（与 DSH 其它 client 插件一致）
  // 注意：tsdown 0.23 起此项位于 `deps` 下；写在顶层会被静默忽略，导致
  // react / dsh-client-store 被内联，进而 require("zustand/vanilla") 在 DSH 模块表里缺失
  // （"Failed to load plugins … missed the module table"）。
  deps: { neverBundle: true },
  // react / dsh-client-store 等 client 共享模块是运行时 require，构建期无需 resolve
  failOnWarn: false,
  // 包成 DSH 的 window.__ModuleLoader__.load 格式
  banner: `window.__ModuleLoader__.load({
\tid: "${PKG_ID}",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`,
  footer: `\t\treturn module.exports;
\t}
});`,
  sourcemap: false,
})
