import { loggerService } from '@logger'
import type { ModelMessage, UIMessage } from 'ai'

const logger = loggerService.withContext('AiService:ContextBudget')

/**
 * Hard context-window budgeting.
 *
 * The chat shell streams the full topic history on every submit. Without a
 * budget, a long topic (e.g. TIA reviews that pull block sources into tool
 * results) eventually exceeds the model's context window and every further
 * send is rejected by the API with "maximum context length" — unrecoverable
 * for the user, who must abandon the topic. This module trims the OLDEST
 * messages (keeping the tail) so the request always fits.
 *
 * Token counts are heuristic (no tokenizer dependency): CJK chars ≈ 1.5
 * tokens each, other chars ≈ 3.5 chars per token. Deliberately pessimistic —
 * over-estimating trims slightly earlier, which is always safe.
 */

const DEFAULT_CONTEXT_WINDOW = 131_072
const OUTPUT_RESERVE_TOKENS = 8_192
/** Share of the context window usable by history + system + tools. */
const SAFETY_RATIO = 0.85
/** Never trim below this budget (protects degenerate tiny windows). */
const MIN_BUDGET_TOKENS = 4_096

const CJK_CHAR = /[\u3000-\u303f\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR.test(ch)) {
      cjk++
    } else {
      other++
    }
  }
  return Math.ceil(cjk * 1.5 + other / 3.5)
}

function estimatePartTokens(part: UIMessage['parts'][number]): number {
  if (part.type === 'text' || part.type === 'reasoning') {
    return estimateTextTokens(part.text)
  }
  try {
    return estimateTextTokens(JSON.stringify(part))
  } catch {
    // Circular or otherwise unserialisable part: count a flat penalty.
    return 64
  }
}

export function estimateMessageTokens(message: UIMessage): number {
  let total = 0
  for (const part of message.parts ?? []) {
    total += estimatePartTokens(part)
  }
  // Per-message envelope overhead (role, id, separators).
  return total + 16
}

/** Token estimate for a wire-format ModelMessage (string or content parts). */
export function estimateModelMessageTokens(message: ModelMessage): number {
  if (typeof message.content === 'string') {
    return estimateTextTokens(message.content) + 16
  }
  let total = 0
  for (const part of message.content) {
    if (part.type === 'text') {
      total += estimateTextTokens(part.text)
    } else {
      try {
        total += estimateTextTokens(JSON.stringify(part))
      } catch {
        total += 64
      }
    }
  }
  return total + 16
}

export interface ContextBudgetInput {
  /** Model context window in tokens. Falls back to a conservative default. */
  contextWindow?: number | null
  /** Token estimate for the assembled system prompt. */
  systemTokens?: number
  /** Token estimate for the serialized tool schemas sent with the request. */
  toolsTokens?: number
}

export interface ContextBudgetResult<T = UIMessage> {
  items: T[]
  /** How many oldest messages were dropped (0 = request fit the budget). */
  droppedCount: number
  estimatedTokens: number
  budgetTokens: number
}

/**
 * Trim oldest messages so history fits inside the model context budget.
 * Keeps at least the final message (the current turn is never discarded).
 */
export function enforceContextBudget(messages: UIMessage[], input: ContextBudgetInput): ContextBudgetResult {
  const perMessage = messages.map((m) => estimateMessageTokens(m))
  return trimTailToBudget(messages, perMessage, input)
}

/** Same budget for wire-format ModelMessage arrays (non-streaming generate). */
export function enforceModelMessageBudget(
  messages: ModelMessage[],
  input: ContextBudgetInput
): ContextBudgetResult<ModelMessage> {
  const perMessage = messages.map((m) => estimateModelMessageTokens(m))
  return trimTailToBudget(messages, perMessage, input)
}

function trimTailToBudget<T>(
  items: readonly T[],
  perItem: readonly number[],
  input: ContextBudgetInput
): ContextBudgetResult<T> {
  const window = input.contextWindow && input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_WINDOW
  const budgetTokens = Math.max(
    MIN_BUDGET_TOKENS,
    Math.floor(window * SAFETY_RATIO) -
      (input.systemTokens ?? 0) -
      (input.toolsTokens ?? 0) -
      OUTPUT_RESERVE_TOKENS
  )

  const estimatedTokens = perItem.reduce((a, b) => a + b, 0)

  if (estimatedTokens <= budgetTokens || items.length <= 1) {
    return { items: [...items], droppedCount: 0, estimatedTokens, budgetTokens }
  }

  // Walk backwards accumulating the tail; stop before exceeding the budget.
  let firstKeptIndex = items.length - 1
  let kept = perItem[firstKeptIndex]
  for (let i = items.length - 2; i >= 0; i--) {
    if (kept + perItem[i] > budgetTokens) break
    kept += perItem[i]
    firstKeptIndex = i
  }

  const droppedCount = firstKeptIndex
  logger.warn('context budget exceeded — dropped oldest messages from request', {
    contextWindow: input.contextWindow,
    budgetTokens,
    estimatedTokens,
    keptTokens: kept,
    droppedCount,
    totalMessages: items.length
  })

  return { items: items.slice(firstKeptIndex), droppedCount, estimatedTokens, budgetTokens }
}
