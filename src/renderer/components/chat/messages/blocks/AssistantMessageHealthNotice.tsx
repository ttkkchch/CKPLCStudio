import { Button } from '@cherrystudio/ui'
import { hasReasoningWithoutReplyText } from '@shared/data/types/uiParts'
import type { CherryMessagePart } from '@shared/data/types/message'
import { Eraser, TriangleAlert } from 'lucide-react'
import React, { useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { useMessageListActions, useMessageListMessages } from '../MessageListProvider'
import type { MessageListItem } from '../types'

/** 上下文规模预警阈值（输入 token）。超过后模型出现空回复等长上下文退化的概率明显上升。 */
const CONTEXT_SIZE_WARNING_TOKENS = 300_000

const NOTICE_DESCRIPTION_COLOR = 'color-mix(in oklch, var(--foreground) 66.6667%, transparent)'

interface Props {
  message: MessageListItem
  messageParts: CherryMessagePart[]
  isActiveTurnProcessing: boolean
}

/**
 * 助手消息健康提示（两道防线）：
 * 1) 空回复守卫 — 模型只产出思考、没有正文时，解释原因并提供一键「清除上下文」。
 * 2) 上下文规模预警 — 最后一条助手消息的输入 token 超过阈值时提示清理。
 */
const AssistantMessageHealthNotice: React.FC<Props> = ({ message, messageParts, isActiveTurnProcessing }) => {
  const { t } = useTranslation()
  const { startNewContext } = useMessageListActions()
  const messages = useMessageListMessages()

  // 空回复：仅对已成功完成、非流式进行中的助手消息判定
  const isEmptyReply =
    message.role === 'assistant' &&
    message.status === 'success' &&
    !isActiveTurnProcessing &&
    hasReasoningWithoutReplyText(messageParts)

  // 规模预警：只提示最后一条助手消息，避免历史消息反复出现
  const lastAssistantId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role === 'assistant') return messages[index].id
    }
    return undefined
  }, [messages])
  const inputTokens = message.stats?.inputTokens
  const isContextSizeWarning =
    !isEmptyReply &&
    !isActiveTurnProcessing &&
    message.role === 'assistant' &&
    typeof inputTokens === 'number' &&
    inputTokens >= CONTEXT_SIZE_WARNING_TOKENS &&
    message.id === lastAssistantId

  if (!isEmptyReply && !isContextSizeWarning) return null

  const tokensLabel =
    typeof inputTokens === 'number' ? new Intl.NumberFormat().format(Math.round(inputTokens)) : ''

  const title = isEmptyReply
    ? t('chat.message.health_notice.empty_reply_title')
    : t('chat.message.health_notice.context_size_title')
  const tip = isEmptyReply
    ? t('chat.message.health_notice.empty_reply_tip')
    : t('chat.message.health_notice.context_size_tip', { tokens: tokensLabel })

  return (
    <div className="my-2 rounded-lg border border-border border-l-[3px] border-l-amber-400 bg-transparent px-3.5 py-3 text-[13px]">
      <div className="mb-1.5 flex items-center gap-2">
        <div className="flex shrink-0 items-center justify-center text-amber-500">
          <TriangleAlert size={15} className="lucide-custom" />
        </div>
        <div className="font-medium text-[13px] leading-[1.4]">{title}</div>
      </div>
      <div className="wrap-break-word ml-5.75 text-xs leading-normal" style={{ color: NOTICE_DESCRIPTION_COLOR }}>
        {tip}
      </div>
      <div className="mt-2.5 ml-5.75 flex items-center gap-2">
        {startNewContext && (
          <Button
            size="sm"
            type="button"
            variant="outline"
            className="rounded-[5px] text-foreground-secondary hover:border-border-hover hover:bg-accent hover:text-foreground"
            onClick={() => startNewContext()}>
            <Eraser size={13} />
            {t('chat.message.health_notice.clear_context_action')}
          </Button>
        )}
        <span className="text-xs" style={{ color: NOTICE_DESCRIPTION_COLOR }}>
          {t('chat.message.health_notice.new_topic_hint')}
        </span>
      </div>
    </div>
  )
}

export default React.memo(AssistantMessageHealthNotice)
