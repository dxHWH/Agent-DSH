// 设置面板企业微信授权后端验证（不需要真实 Secret）：
//  1) status 能找到 CLI 并读出授权态；
//  2) 空输入 / 换行注入被拒；
//  3) 错误凭证 → 853000 友好提示，且正式凭证文件字节不变；
//  4) 隔离目录（WECOM_CLI_CONFIG_DIR）下 logout 只动该目录，并留 .bak。
// 用法：npm run build:main && node scripts/verify-wecom-auth.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { wecomAuthorize, wecomLogout, wecomStatus, wecomConfigDir } from '../dist/main/wecom.js'

const dshHome = join(tmpdir(), 'nonexistent-dsh-home')
let pass = 0
const ok = async (name, fn) => { await fn(); pass++; console.log('  ✓', name) }
const hash = (p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null
const realDir = wecomConfigDir()
const files = ['credentials.enc', '.encryption_key'].map((f) => join(realDir, f))
const before = files.map(hash)

const s = await wecomStatus(dshHome)
await ok(`status: 找到 CLI（${s.cli?.source}），授权=${s.authorized}`, () => {
  assert.equal(s.ok, true, s.error)
  assert.ok(s.cli.cmd.toLowerCase().endsWith('wecom-cli.exe'))
})
await ok('空 Bot ID 被拒', async () => assert.match((await wecomAuthorize(dshHome, '', 'x')).error, /Bot ID/))
await ok('空 Secret 被拒', async () => assert.match((await wecomAuthorize(dshHome, 'aib_x', '  ')).error, /Secret/))
await ok('换行注入被拒', async () => assert.match((await wecomAuthorize(dshHome, 'aib_x\rfoo', 'y')).error, /换行/))

const t0 = Date.now()
const bad = await wecomAuthorize(dshHome, 'aib_FAKEBOTID000', 'FAKESECRET000')
await ok(`错误凭证 → 失败且提示明确（${Date.now() - t0} ms）：${bad.error}`, () => {
  assert.equal(bad.ok, false)
  assert.equal(bad.errcode, 853000)
  assert.ok(!bad.error.includes('FAKESECRET000'), 'Secret 不得出现在错误信息里')
})
await ok('错误凭证后正式凭证文件字节不变', () => assert.deepEqual(files.map(hash), before))
const s2 = await wecomStatus(dshHome)
await ok('错误凭证后授权态不变', () => assert.equal(s2.authorized, s.authorized))

// logout 在隔离目录里测试，绝不碰正式凭证。
if (before.every(Boolean)) {
  const iso = mkdtempSync(join(tmpdir(), 'wecom-iso-'))
  for (const f of files) cpSync(f, join(iso, f.split(/[\\/]/).pop()))
  process.env.WECOM_CLI_CONFIG_DIR = iso
  await ok('隔离目录：logout 前已授权', async () => assert.equal((await wecomStatus(dshHome)).authorized, true))
  await ok('隔离目录：logout 后未授权且有 .bak', async () => {
    assert.equal(wecomLogout().ok, true)
    assert.equal((await wecomStatus(dshHome)).authorized, false)
    assert.ok(existsSync(join(iso, 'credentials.enc.bak')))
  })
  delete process.env.WECOM_CLI_CONFIG_DIR
  rmSync(iso, { recursive: true, force: true })
  await ok('正式凭证仍然完好', async () => {
    assert.deepEqual(files.map(hash), before)
    assert.equal((await wecomStatus(dshHome)).authorized, true)
  })
} else {
  console.log('  - 本机未授权，跳过 logout 隔离测试')
}
console.log(`\n全部通过：${pass} 项（正式目录 ${realDir}，home=${homedir()}）`)
process.exit(0)
