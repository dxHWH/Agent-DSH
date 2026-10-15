/**
 * 生成「免安装版 + 文档」汇总文件夹：
 *
 *   release/Agent-Desktop-portable-<版本>-<日期>/
 *   ├── Agent Desktop/              ← release/win-unpacked 的完整副本（Agent Desktop.exe）
 *   ├── 文档/
 *   │   ├── user-guide.md
 *   │   └── feedback-archive.md
 *   └── 先读我.txt
 *
 * 用法：npm run bundle:portable          （先 dist:dir 再汇总）
 *       node scripts/bundle-portable.mjs --skip-build   （直接用现有 win-unpacked）
 *
 * 校验：程序目录中不得残留指向本机的链接，不得含开发机路径；文档中的相对链接都能找到。
 */
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const unpacked = join(root, 'release', 'win-unpacked')
const PRODUCT = pkg.productName            // 'Agent Desktop'：程序文件夹名与 exe 名
const EXE = `${PRODUCT}.exe`
const DOCS = ['user-guide.md', 'feedback-archive.md']

if (!process.argv.includes('--skip-build')) {
  execSync('npm run dist:dir', { cwd: root, stdio: 'inherit' })
}
if (!existsSync(join(unpacked, EXE))) {
  console.error('✗ 未找到 release/win-unpacked/${EXE}，请先 npm run dist:dir')
  process.exit(1)
}

const d = new Date()
const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
const outDir = join(root, 'release', `${PRODUCT.replace(/\s+/g, '-')}-portable-${pkg.version}-${stamp}`)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, '文档'), { recursive: true })

// 1) 程序（复制时解引用，保证没有链接）
console.log('• 复制程序 …')
cpSync(unpacked, join(outDir, PRODUCT), { recursive: true, dereference: true })
// 运行时可能生成的本机状态不得带出
for (const f of ['desktop-shell.json', 'dsh-data']) rmSync(join(outDir, PRODUCT, f), { recursive: true, force: true })

// 2) 文档
console.log('• 复制文档 …')
for (const f of DOCS) cpSync(join(root, 'docs', f), join(outDir, '文档', f))

// 3) 先读我
const readme = `${PRODUCT} ${pkg.version} 免安装版（Windows 10/11 x64）
====================================================

1. 把「${PRODUCT}」整个文件夹复制到本机任意位置（不要只复制 exe）。
2. 双击「${PRODUCT}\\${EXE}」启动。不需要安装 Node.js 或任何运行库。
3. 首次启动后按「文档\\user-guide.md」完成配置：
     - 填写 DeepSeek API Key（必做）
     - 在设置窗口绑定工程目录并构建查询索引（项目模式，可选）
     - 知识库 MCP（可选，需要 Node.js）
4. 点踩归档默认保存到本机；改为上传企业微信见「文档\\feedback-archive.md」（可选）。

退出程序：Ctrl+Q 或托盘右键 Quit（点 X 只是隐藏到托盘）。
数据位置：%APPDATA%\\${PRODUCT}\\dsh-home（程序文件夹里只有程序）。

打包时间：${d.toLocaleString('zh-CN', { hour12: false })}
`
writeFileSync(join(outDir, '先读我.txt'), '\ufeff' + readme.replace(/\n/g, '\r\n'), 'utf8')

// 4) 校验
console.log('• 校验 …')
const problems = []
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (lstatSync(p).isSymbolicLink()) { problems.push(`链接：${relative(outDir, p)}`); continue }
    if (e.isDirectory()) walk(p)
  }
}
walk(outDir)

const devMarkers = [root, root.replace(/\\/g, '/'), process.env.USERPROFILE].filter(Boolean)
const textCheck = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules' || dir.endsWith('desktop-profile')) textCheck(p); continue }
    if (!/\.(ya?ml|json|cmd)$/i.test(e.name) || statSync(p).size > 2_000_000) continue
    const s = readFileSync(p, 'utf8')
    for (const m of devMarkers) if (s.includes(m)) problems.push(`含开发机路径「${m}」：${relative(outDir, p)}`)
  }
}
textCheck(join(outDir, PRODUCT, 'resources', 'agent-preset'))
textCheck(join(outDir, PRODUCT, 'resources', 'desktop-profile'))
for (const f of ['wecom-auth.cmd']) textCheck(join(outDir, PRODUCT))

for (const f of DOCS) {
  const s = readFileSync(join(outDir, '文档', f), 'utf8')
  // 允许在「旧版…升级」说明里提到旧名；其它地方出现即视为漏改。
  for (const line of s.split('\n')) if (line.includes('DSH Desktop') && !line.includes('旧')) problems.push(`${f} 仍含旧产品名「DSH Desktop」：${line.trim().slice(0, 60)}`)
  for (const m of s.matchAll(/\]\((?!https?:|#)([^)#]+)(#[^)]*)?\)/g)) {
    if (!existsSync(join(outDir, '文档', decodeURIComponent(m[1])))) problems.push(`${f} 链接失效：${m[1]}`)
  }
}
for (const need of [EXE, 'resources/app.asar', 'resources/agent-preset/project/agent.cordis.yml', 'wecom-auth.cmd', 'resources/desktop-profile/node_modules/@deepseek-ai/dsh-tool-example/lib/index.js'].map((p) => `${PRODUCT}/${p}`)) {
  if (!existsSync(join(outDir, need))) problems.push(`缺少：${need}`)
}

// 本地工具包的运行时依赖必须能从包内两份副本解析（desktop-profile 给 DSH 工具，
// app.asar.unpacked 给「重建索引」worker）。漏打依赖会在运行时报 Cannot find module。
for (const base of ['resources/desktop-profile/node_modules', 'resources/app.asar.unpacked/node_modules']) {
  const pj = join(outDir, PRODUCT, base, '@deepseek-ai/dsh-tool-example/package.json')
  if (!existsSync(pj)) { problems.push(`缺少：${PRODUCT}/${base}/@deepseek-ai/dsh-tool-example`); continue }
  const req = createRequire(pj)
  for (const dep of Object.keys(JSON.parse(readFileSync(pj, 'utf8')).dependencies ?? {})) {
    try { req.resolve(dep) } catch { problems.push(`${base} 下 dsh-tool-example 无法解析依赖「${dep}」`) }
  }
}

if (problems.length) {
  console.error('✗ 汇总包校验失败：')
  for (const p of [...new Set(problems)]) console.error('  -', p)
  process.exit(1)
}
let files = 0, bytes = 0
const count = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) count(p); else { files++; bytes += statSync(p).size } } }
count(outDir)
console.log(`✓ ${relative(root, outDir)}  （${files} 个文件，${(bytes / 1024 / 1024).toFixed(0)} MB）`)
