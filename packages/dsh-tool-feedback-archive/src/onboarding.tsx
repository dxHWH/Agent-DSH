/**
 * First-run model onboarding for Agent Desktop: ask for the model API key.
 *
 * DSH's stock step (`client-ui-settings-models`, slot `settings.onboarding`,
 * id `deepseek-official`) is shadowed here so the desktop app controls the copy
 * and which credential reference is asked for. The slot contract says reusing a
 * shipped id "puts you in THAT cell", so this registers under the same id with
 * a lower shadowing priority.
 *
 * `KEY_REF` must match the provider seeded in `assets/model-preset/models.yaml`
 * (written by the desktop shell). By default that is the official DeepSeek API
 * (`DEEPSEEK_API_KEY`); when switching to an OpenAI-compatible gateway via
 * `llm-pi-ai`, set `KEY_REF` to that provider's `apiKeyEnv` and adjust the copy.
 *
 * Readiness is the credential itself: once `KEY_REF` is configured the step
 * completes without rendering. "稍后配置" also completes it for this launch; the
 * key can be entered later under 设置 → 模型.
 */
import * as React from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

export const KEY_REF = 'DEEPSEEK_API_KEY'
const NS = 'agent-onboarding'

export const onboardingZh = {
  title: '填写 DeepSeek API Key 开始使用',
  description: '模型服务默认使用 DeepSeek 官方 API（api.deepseek.com）。填写你的 API Key 即可开始对话。',
  label: 'API Key',
  placeholder: '粘贴 DeepSeek API Key（sk-…）',
  later: '稍后配置',
  save: '保存并继续',
  saving: '保存中…',
  empty: '请填写 API Key',
  failed: '保存失败：',
  hint: '之后可在 主窗口 → 设置 → 模型 中修改 Key 与模型。Key 只保存在本机数据文件夹。',
}
export const onboardingEn = {
  title: 'Add your DeepSeek API key to get started',
  description: 'The model service defaults to the official DeepSeek API (api.deepseek.com). Enter your API key to start.',
  label: 'API Key',
  placeholder: 'Paste your DeepSeek API key (sk-…)',
  later: 'Configure later',
  save: 'Save and continue',
  saving: 'Saving…',
  empty: 'Please enter an API key',
  failed: 'Could not save: ',
  hint: 'You can change the key and models later under Settings → Models. The key is stored only in the local data folder.',
}

const CSS = `
.agob-desc{color:var(--dsw-alias-label-secondary);margin:0;font-size:14px;line-height:24px}
.agob-field{display:flex;flex-direction:column;gap:6px;margin-top:20px}
.agob-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.agob-input{box-sizing:border-box;width:100%;height:40px;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:12px;padding:0 12px;font:inherit;font-size:14px}
.agob-input:focus{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-border-l3);outline:none}
.agob-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin:0}
.agob-error{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;margin:0}
.agob-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:24px}
`

function injectCss(): void {
  if (typeof document === 'undefined') return
  const id = '@deepseek-ai/dsh-tool-feedback-archive/onboarding.css'
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@deepseek-ai/dsh-tool-feedback-archive'
  tag.dataset.pluginCss = id
  tag.textContent = CSS
  document.head.appendChild(tag)
}

type Phase = 'checking' | 'ask' | 'done'

function ApiKeyOnboarding(props: any) {
  const { complete, credentials, t } = props
  const [phase, setPhase] = React.useState<Phase>('checking')
  const [value, setValue] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Readiness: a configured key (or an unreadable credential store, where
  // prompting cannot help) ends the step without painting anything.
  React.useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await credentials.describe([KEY_REF])
        if (!alive) return
        if (!res?.ok || res.value?.[KEY_REF]?.configured === true || res.value?.[KEY_REF]?.writable === false) {
          setPhase('done')
          complete()
        } else {
          setPhase('ask')
        }
      } catch {
        if (alive) { setPhase('done'); complete() }
      }
    })()
    return () => { alive = false }
  }, [])

  // Keep the app behind the dialog inert, as the stock onboarding modal does.
  React.useEffect(() => {
    if (phase !== 'ask') return
    const root = document.getElementById('root')
    if (root === null) return
    const previous = root.inert
    root.inert = true
    return () => { root.inert = previous }
  }, [phase])

  if (phase !== 'ask') return null

  const save = async () => {
    const key = value.trim()
    if (key === '') { setError(t('empty')); return }
    setBusy(true)
    setError(null)
    try {
      const res = await credentials.set(KEY_REF, key)
      if (res?.ok === false) throw new Error(res.error?.message ?? 'unknown')
      setPhase('done')
      complete()
    } catch (e) {
      setError(t('failed') + (e instanceof Error ? e.message : String(e)))
      setBusy(false)
    }
  }

  const later = (): void => { if (!busy) { setPhase('done'); complete() } }

  return React.createElement(Modal, {
    open: true,
    title: t('title'),
    closeLabel: t('later'),
    // 右上角 X / Esc 与「稍后配置」相同。
    onClose: later,
    children: [
      React.createElement('p', { key: 'd', className: 'agob-desc' }, t('description')),
      React.createElement('label', { key: 'f', className: 'agob-field' },
        React.createElement('span', { className: 'agob-label' }, t('label')),
        React.createElement('input', {
          className: 'agob-input',
          type: 'password',
          autoFocus: true,
          autoComplete: 'off',
          spellCheck: false,
          placeholder: t('placeholder'),
          value,
          readOnly: busy,
          onChange: (e: any) => { setValue(e.target.value); setError(null) },
          onKeyDown: (e: any) => { if (e.key === 'Enter') void save() },
        }),
      ),
      error !== null && React.createElement('p', { key: 'e', className: 'agob-error', role: 'alert' }, error),
      React.createElement('p', { key: 'h', className: 'agob-hint', style: { marginTop: 12 } }, t('hint')),
      React.createElement('div', { key: 'a', className: 'agob-actions' },
        React.createElement(Button, { variant: 'secondary', disabled: busy, onClick: later, children: t('later') }),
        React.createElement(Button, { variant: 'primary', disabled: busy, onClick: () => void save(), children: busy ? t('saving') : t('save') }),
      ),
    ],
  })
}

/**
 * Skip DSH's「内测声明」(slot `settings.onboarding`, id `welcome-notice`).
 *
 * Shadowed in its own cell rather than pre-acknowledged in settings: the stock
 * step compares `ui-onboarding.welcomeNoticeVersion` to a version baked into
 * the DSH release, so a seeded ack would resurface on every DSH upgrade. This
 * renders nothing and immediately hands ownership to the next step (the
 * API key dialog).
 */
function SkipWelcomeNotice(props: any) {
  const { complete } = props
  React.useEffect(() => { complete() }, [])
  return null
}

/** Register the steps; `ctx` must inject `slots`, `locale`, `remote.credentials`. */
export function applyOnboarding(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: onboardingZh, en: onboardingEn }), 'agent-onboarding: dict')
  injectCss()
  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register({
      name: 'settings.onboarding',
      id: 'welcome-notice',
      order: -100,
      priority: -100,
    }, SkipWelcomeNotice),
  )
  ctx.slots.inject('settings.onboarding', () =>
    ctx.slots.register({
      name: 'settings.onboarding',
      // Same id as the stock DeepSeek step → same cell. A list cell renders its
      // lowest-priority entry; the stock one sits at 0, so -100 shadows it
      // (equal priority throws "already has an entry with id …").
      id: 'deepseek-official',
      order: 0,
      priority: -100,
      inject: () => ({ credentials: ctx.remote.credentials, t }),
    }, ApiKeyOnboarding),
  )
}
