// 守卫：dsh-tool-feedback-archive 的浏览器端 client.js 不得内联 node_modules 里的包。
// DSH 的 client 模块表只提供平台共享模块（react / dsh-client-store / dsh-client-ui-primitives …）；
// 一旦把 dsh-client-store 等内联进来，它们内部的 require("zustand/vanilla") 就会在运行时
// 报 "Failed to load plugins … missed the module table"。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(new URL('../packages/dsh-tool-feedback-archive/lib/client.js', import.meta.url))
const src = readFileSync(file, 'utf8')
const inlined = [...src.matchAll(/^\/\/#region (.*node_modules.*)$/gm)].map((m) => m[1])
const requires = [...new Set([...src.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]))].sort()
// 与 DSH 官方 client 插件实际使用的共享模块一致。
const allowed = new Set(['react', '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-primitives'])
const unexpected = requires.filter((r) => !allowed.has(r))

if (inlined.length || unexpected.length) {
  console.error('✗ feedback-archive client.js 打包异常：')
  for (const r of inlined) console.error('  内联了 node_modules 模块：', r)
  for (const r of unexpected) console.error('  require 了模块表中不保证存在的模块：', r)
  console.error('  检查 packages/dsh-tool-feedback-archive/tsdown.config.ts 的 deps.neverBundle 是否生效。')
  process.exit(1)
}
console.log(`✓ feedback-archive client.js：${(src.length / 1024).toFixed(1)} KB，仅 require ${requires.join(', ')}`)
