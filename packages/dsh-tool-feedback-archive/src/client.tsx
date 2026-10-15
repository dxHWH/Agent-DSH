/**
 * 点踩反馈归档插件 —— client 半（浏览器端）。
 *
 * 复刻 `dsh-client-ui-message-feedback` 的 Like/Dislike + 反馈弹窗 UI，但：
 * - Like（点赞）：保持原样，走 `messageFeedback` Remote（写 positive 反馈）。
 * - Dislike（点踩）：弹窗（分类标签 + 原因文本），提交后改为**归档**——
 *   把被点踩那一轮的完整流程（用户提问 + 回答 + 工具轨迹 + feedback.md）打包 ZIP，保存到本地目录（默认）或上传企业微信微盘（可选）。
 *
 * 挂载方式：在桌面 profile 里 disable 原 `ui-message-feedback`，挂本插件。
 */
import * as React from 'react'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  Button,
  IconDislikeFill16,
  IconDislikeOutline16,
  IconLikeFill16,
  IconLikeOutline16,
  Modal,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { applyOnboarding } from './onboarding.js'

const NS = 'feedback-archive'

/**
 * 复刻原件的 CSS（MessageFeedbackActions.module.css + FeedbackDialog.module.css），
 * 保证按钮/弹窗外观与原 DSH 反馈 UI 完全一致（透明背景、无灰底框）。
 */
const ACTION_CSS = "._8_XoUG_action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;border-radius:28px;justify-content:center;align-items:center;padding:6px;display:inline-flex}._8_XoUG_action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}._8_XoUG_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}._8_XoUG_action:disabled{cursor:default;opacity:.4}._8_XoUG_action[data-active]{color:var(--dsw-alias-label-tertiary)}._8_XoUG_failure{color:var(--dsw-alias-label-tertiary);padding-left:4px;font-size:13px;line-height:20px}"

const DIALOG_CSS = "._6_jNJa_dialog._6_jNJa_dialog{border-radius:18px;gap:38px;width:min(488px,100%)}._6_jNJa_categories{flex-wrap:wrap;gap:8px;margin-top:-14px;display:flex}._6_jNJa_chip{border:.5px solid var(--dsw-alias-border-l4);corner-shape:round;height:28px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;background:0 0;border-radius:14px;padding:0 12px;font-size:13px;line-height:18px;transition:background-color .12s,border-color .12s,color .12s}._6_jNJa_chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}._6_jNJa_chip:disabled{cursor:default;opacity:.4}._6_jNJa_chip:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill);outline-offset:2px}._6_jNJa_chipActive,._6_jNJa_chipActive:hover:not(:disabled){border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}._6_jNJa_detail{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:116px;max-height:280px;color:var(--dsw-alias-label-primary);font:inherit;field-sizing:content;resize:none;border-radius:16px;margin-top:18px;padding:12px 14px;font-size:14px;line-height:22px;transition:border-color .12s,box-shadow .12s;display:block}._6_jNJa_detail::placeholder{color:var(--dsw-alias-label-caption)}._6_jNJa_detail:focus{border-color:var(--dsw-alias-border-l3);box-shadow:0 0 0 1px var(--dsw-alias-border-l3);outline:none}._6_jNJa_submit{border-radius:18px;width:100%;height:44px;font-size:14px;font-weight:500}._6_jNJa_toastIcon{border:1.5px solid var(--dsw-alias-state-success-primary);corner-shape:round;width:18px;height:18px;color:var(--dsw-alias-state-success-primary);border-radius:50%;place-items:center;display:grid}@media (prefers-reduced-motion:reduce){._6_jNJa_chip,._6_jNJa_detail{transition:none}}"

/** 注入复刻的 CSS（幂等，按 tagId 去重）。 */
function injectCss(tagId: string, css: string): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = '@deepseek-ai/dsh-tool-feedback-archive'
  tag.dataset.pluginCss = tagId
  tag.textContent = css
  document.head.appendChild(tag)
}

// 复刻的 className 映射
const ACTION_CLS = '_8_XoUG_action'
const CHIP_CLS = '_6_jNJa_chip'
const CHIP_ACTIVE_CLS = '_6_jNJa_chipActive'
const CATEGORIES_CLS = '_6_jNJa_categories'
const DETAIL_CLS = '_6_jNJa_detail'
const SUBMIT_CLS = '_6_jNJa_submit'
const DIALOG_CLS = '_6_jNJa_dialog'

/** 分类标签（与原 FeedbackDialog 的 FeedbackCategory 一致）。 */
const CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const

const zh = {
  'action.like': '好的回答',
  'action.likeActive': '取消标记',
  'action.dislike': '有问题的回答',
  'action.dislikeActive': '取消标记',
  'dialog.title': '提交反馈',
  'dialog.categories': '反馈分类',
  'dialog.detail': '反馈详情',
  'dialog.hint': '填写详情以帮助我们改进体验，提交内容会包括当前对话的日志',
  'dialog.submit': '反馈（一键归档本轮对话）',
  'dialog.submitting': '归档中…',
  'category.task-result': '任务结果',
  'category.instruction-following': '指令理解与遵循',
  'category.product-interaction': '产品功能与交互',
  'category.service-stability': '稳定性和速度',
  'category.resource-cost': '资源使用与费用',
  'category.security-privacy-permission': '安全隐私与权限',
  'category.other': '其他',
  'toast.recorded': '已归档本轮对话',
  'error.generic': '归档失败',
  'error.load': '反馈状态加载失败',
  'close': '关闭',
}
const en = {
  'action.like': 'Good response',
  'action.likeActive': 'Remove rating',
  'action.dislike': 'Bad response',
  'action.dislikeActive': 'Remove rating',
  'dialog.title': 'Submit feedback',
  'dialog.categories': 'Feedback category',
  'dialog.detail': 'Feedback details',
  'dialog.hint': 'Add details to help us improve. Your submission will include the current conversation log.',
  'dialog.submit': 'Feedback (archive this turn)',
  'dialog.submitting': 'Archiving…',
  'category.task-result': 'Task result',
  'category.instruction-following': 'Instruction understanding and following',
  'category.product-interaction': 'Product features and interaction',
  'category.service-stability': 'Stability and speed',
  'category.resource-cost': 'Resource usage and cost',
  'category.security-privacy-permission': 'Security, privacy, and permissions',
  'category.other': 'Other',
  'toast.recorded': 'Turn archived',
  'error.generic': 'Archive failed',
  'error.load': 'Could not load feedback',
  'close': 'Close',
}

/** host 端归档路由。 */
const ARCHIVE_ROUTE = '/api/feedback-archive'

/** 弹窗关闭态。 */
const CLOSED = {
  target: null as { sessionId: string; messageId: string } | null,
  category: null as string | null,
  text: '',
  submitting: false,
  failure: null as string | null,
  toast: 0,
}

/**
 * Like/Dislike 按钮（复刻 MessageFeedbackActions）。
 */
function MessageFeedbackActions(props: any) {
  const { messageId, useRating, rateLike, openDislikeDialog, t } = props
  const rating = useRating((s: any) => s.items.get(messageId)?.rating)
  const [pending, setPending] = React.useState(false)

  const onLike = () => {
    setPending(true)
    rateLike(messageId).finally(() => setPending(false))
  }
  const onDislike = () => {
    setPending(true)
    openDislikeDialog(messageId)
    setPending(false)
  }

  const likeLabel = rating === 'positive' ? t('action.likeActive') : t('action.like')
  const dislikeLabel = rating === 'negative' ? t('action.dislikeActive') : t('action.dislike')

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      Tooltip,
      { label: likeLabel, side: 'bottom' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: ACTION_CLS,
          'aria-label': likeLabel,
          'aria-pressed': rating === 'positive',
          'data-active': rating === 'positive' || undefined,
          disabled: pending,
          onClick: onLike,
          children: rating === 'positive'
            ? React.createElement(IconLikeFill16, {})
            : React.createElement(IconLikeOutline16, {}),
        },
      ),
    ),
    React.createElement(
      Tooltip,
      { label: dislikeLabel, side: 'bottom' },
      React.createElement(
        'button',
        {
          type: 'button',
          className: ACTION_CLS,
          'aria-label': dislikeLabel,
          'aria-pressed': rating === 'negative',
          'data-active': rating === 'negative' || undefined,
          disabled: pending,
          onClick: onDislike,
          children: rating === 'negative'
            ? React.createElement(IconDislikeFill16, {})
            : React.createElement(IconDislikeOutline16, {}),
        },
      ),
    ),
  )
}

/**
 * 反馈弹窗（复刻 FeedbackDialog）。Dislike 提交 = 归档。
 */
function FeedbackDialog(props: any) {
  const { useDialog, edit, submit, dismiss, dismissToast, t } = props
  const state = useDialog((s: any) => s)

  // 带上真实原因（如「权限不足（640008）」），不然用户只看到一句「归档失败」无从排查。
  const failure = state.failure === null
    ? null
    : state.failure === 'generic' ? t('error.generic') : `${t('error.generic')}：${String(state.failure).slice(0, 160)}`

  return React.createElement(
    React.Fragment,
    null,
    state.toast > 0 && failure === null &&
      React.createElement(
        Toast,
        { text: t('toast.recorded'), onDone: () => dismissToast(state.toast) },
      ),
    failure !== null &&
      React.createElement(
        Toast,
        { text: failure, holdMs: 6000, onDone: () => edit({ failure: null }) },
      ),
    React.createElement(
      Modal,
      {
        open: state.target !== null,
        title: t('dialog.title'),
        closeLabel: t('close'),
        onClose: dismiss,
        className: DIALOG_CLS,
        footer: React.createElement(
          Button,
          {
            variant: 'primary',
            className: SUBMIT_CLS,
            disabled: state.submitting,
            onClick: submit,
            children: state.submitting ? t('dialog.submitting') : t('dialog.submit'),
          },
        ),
        children: [
          React.createElement(
            'div',
            { className: CATEGORIES_CLS, role: 'group', 'aria-label': t('dialog.categories') },
            CATEGORIES.map((category) =>
              React.createElement(
                'button',
                {
                  key: category,
                  type: 'button',
                  className: state.category === category ? `${CHIP_CLS} ${CHIP_ACTIVE_CLS}` : CHIP_CLS,
                  'aria-pressed': state.category === category,
                  disabled: state.submitting,
                  onClick: () => edit({ category: state.category === category ? null : category }),
                  children: t(`category.${category}`),
                },
              ),
            ),
          ),
          React.createElement(
            'textarea',
            {
              className: DETAIL_CLS,
              'aria-label': t('dialog.detail'),
              placeholder: t('dialog.hint'),
              value: state.text,
              readOnly: state.submitting,
              onChange: (e: any) => edit({ text: e.target.value }),
            },
          ),
        ],
      },
    ),
  )
}

/** client 插件体。 */
export const inject = ['slots', 'remote', 'remote.messageFeedback', 'remote.credentials', 'locale']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'feedback-archive: dict')
  // 首次启动的模型引导：API Key 弹窗（替换 DSH 自带的引导步骤，见 onboarding.tsx）。
  applyOnboarding(ctx)

  // 注入复刻的 CSS（保证按钮/弹窗外观与原 DSH 反馈 UI 一致）
  injectCss('@deepseek-ai/dsh-tool-feedback-archive/action.css', ACTION_CSS)
  injectCss('@deepseek-ai/dsh-tool-feedback-archive/dialog.css', DIALOG_CSS)

  const surfaces = new Map<string, any>()

  function surfaceFor(sessionId: string) {
    let s = surfaces.get(sessionId)
    if (!s) {
      const ratingStore = createSnapshotStore({ items: new Map<string, any>() })
      const dialogStore = createSnapshotStore({ ...CLOSED })

      const rateLike = async (messageId: string) => {
        // 乐观更新：先切换图标为 positive（实心），再异步写 feedback
        const prev = ratingStore.getSnapshot().items.get(messageId)?.rating
        const items = new Map(ratingStore.getSnapshot().items)
        if (prev === 'positive') {
          // 再次点击 = 取消标记
          items.delete(messageId)
        } else {
          items.set(messageId, { messageId, rating: 'positive' })
        }
        ratingStore.set({ items })
        try {
          await ctx.remote.messageFeedback.put({
            sessionId,
            messageId,
            rating: 'positive',
          })
        } catch {
          /* 写失败不影响本地乐观回显 */
        }
      }

      const submit = async () => {
        const cur = dialogStore.getSnapshot()
        if (!cur.target || cur.submitting) return
        dialogStore.set({ ...cur, submitting: true, failure: null })
        try {
          const res = await fetch(ARCHIVE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId: cur.target.sessionId,
              messageId: cur.target.messageId,
              note: cur.text.trim() || undefined,
              category: cur.category ?? undefined,
            }),
          })
          const result = await res.json()
          if (result.ok) {
            const items = new Map(ratingStore.getSnapshot().items)
            items.set(cur.target.messageId, { messageId: cur.target.messageId, rating: 'negative' })
            ratingStore.set({ items })
            dialogStore.set({ ...CLOSED, toast: (dialogStore.getSnapshot().toast || 0) + 1 })
          } else {
            dialogStore.set({ ...cur, submitting: false, failure: result.error || 'generic' })
          }
        } catch (e) {
          dialogStore.set({ ...cur, submitting: false, failure: e instanceof Error ? e.message : 'generic' })
        }
      }

      s = {
        rating: ratingStore,
        dialog: dialogStore,
        rateLike,
        submit,
        edit: (draft: any) => {
          const cur = dialogStore.getSnapshot()
          if (!cur.target || cur.submitting) return
          dialogStore.set({ ...cur, ...draft })
        },
        dismiss: () => dialogStore.set({ ...dialogStore.getSnapshot(), ...CLOSED, toast: dialogStore.getSnapshot().toast }),
        dismissToast: () => dialogStore.set({ ...dialogStore.getSnapshot(), toast: 0 }),
        openDislikeDialog: (messageId: string) => {
          dialogStore.set({ ...CLOSED, target: { sessionId, messageId } })
        },
      }
      surfaces.set(sessionId, s)
    }
    return s
  }

  // assistant-actions slot：Like/Dislike 按钮
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({
      name: 'conversation.chat.assistant-actions',
      id: 'feedback-archive',
      order: 10,
      locale: NS,
      inject: (sessionId: string) => {
        const s = surfaceFor(sessionId)
        return {
          hooks: { rating: s.rating },
          rateLike: (messageId: string) => s.rateLike(messageId),
          openDislikeDialog: (messageId: string) => s.openDislikeDialog(messageId),
        }
      },
    }, MessageFeedbackActions),
  )

  // input.overlay slot：弹窗
  ctx.slots.inject('conversation.input.overlay', () =>
    ctx.slots.register({
      name: 'conversation.input.overlay',
      id: 'feedback-archive-dialog',
      order: 2,
      locale: NS,
      inject: (sessionId: string) => {
        const s = surfaceFor(sessionId)
        return {
          hooks: { dialog: s.dialog },
          edit: (draft: any) => s.edit(draft),
          submit: () => s.submit(),
          dismiss: () => s.dismiss(),
          dismissToast: (seq: number) => s.dismissToast(),
        }
      },
    }, FeedbackDialog),
  )
}
