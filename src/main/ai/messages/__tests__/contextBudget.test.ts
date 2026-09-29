import { describe, expect, it } from 'vitest'
import type { ToolUIPart, UIMessage } from 'ai'

import {
  enforceContextBudget,
  estimateMessageTokens,
  estimateTextTokens
} from '../contextBudget'

function textMsg(text: string, role: 'user' | 'assistant' = 'user'): UIMessage {
  return { id: `m-${Math.random().toString(36).slice(2)}`, role, parts: [{ type: 'text', text }] }
}

// 'a' tokens: ceil(n / 3.5). Message envelope adds 16.
function latinTokens(chars: number): number {
  return Math.ceil(chars / 3.5) + 16
}

describe('estimateTextTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTextTokens('')).toBe(0)
  })

  it('counts CJK chars heavier than latin chars', () => {
    const cjk = estimateTextTokens('冷机评审')
    const latin = estimateTextTokens('abcd')
    expect(cjk).toBeGreaterThan(latin)
  })

  it('is deterministic and accumulates', () => {
    expect(estimateTextTokens('PLC评审')).toBe(
      estimateTextTokens('PLC') + estimateTextTokens('评审')
    )
  })
})

describe('estimateMessageTokens', () => {
  it('sums text parts plus envelope overhead', () => {
    const msg: UIMessage = {
      id: 'm1',
      role: 'user',
      parts: [
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'second' }
      ]
    }
    expect(estimateMessageTokens(msg)).toBe(estimateTextTokens('hello world') + estimateTextTokens('second') + 16)
  })

  it('serialises tool parts (input/output are not plain text)', () => {
    const toolPart = {
      type: 'tool-read_text_file',
      toolCallId: 't1',
      state: 'output-available',
      input: { path: 'x.s7dcl' },
      output: 'SOURCE LINE 1\nSOURCE LINE 2'
    } as unknown as ToolUIPart
    const msg: UIMessage = { id: 'm2', role: 'assistant', parts: [toolPart] }
    const viaToolPart = estimateMessageTokens(msg)
    const viaText = estimateTextTokens(JSON.stringify(toolPart)) + 16
    expect(viaToolPart).toBe(viaText)
  })
})

describe('enforceContextBudget', () => {
  it('returns messages untouched when they fit the budget', () => {
    const messages = [textMsg('short'), textMsg('history', 'assistant'), textMsg('question')]
    const result = enforceContextBudget(messages, { contextWindow: 131_072 })
    expect(result.droppedCount).toBe(0)
    expect(result.items).toEqual(messages)
    expect(result.estimatedTokens).toBeLessThanOrEqual(result.budgetTokens)
  })

  it('trims oldest messages and keeps the tail when over budget', () => {
    // Budget with default window: 111411 - 8192 = 103219 tokens.
    const big = 'a'.repeat(350_000) // ≈ 100k tokens
    const messages = [
      textMsg(big),
      textMsg(big, 'assistant'),
      textMsg('tail question') // small tail must be kept
    ]
    const result = enforceContextBudget(messages, { contextWindow: 131_072 })
    expect(result.droppedCount).toBeGreaterThan(0)
    expect(result.items.length).toBeLessThan(messages.length)
    expect(result.items.at(-1)?.parts[0]).toEqual({ type: 'text', text: 'tail question' })
    expect(result.estimatedTokens).toBeGreaterThan(result.budgetTokens) // reports pre-trim size
  })

  it('never drops the final message even if it alone exceeds the budget', () => {
    const huge = 'a'.repeat(500_000) // ≈ 143k tokens > budget
    const result = enforceContextBudget([textMsg(huge)], { contextWindow: 131_072 })
    expect(result.droppedCount).toBe(0)
    expect(result.items).toHaveLength(1)
  })

  it('falls back to the default window when contextWindow is missing or invalid', () => {
    const big = 'a'.repeat(350_000)
    const messages = [textMsg(big), textMsg(big, 'assistant')]
    for (const contextWindow of [undefined, null, 0, -5]) {
      const result = enforceContextBudget(messages, { contextWindow })
      expect(result.droppedCount).toBe(1)
    }
  })

  it('discounts system and tools tokens from the budget', () => {
    const messages = [textMsg('a'.repeat(150_000)), textMsg('a'.repeat(150_000), 'assistant')]
    // Two ~42.9k-token messages (85.7k total) fit in the default 103219 budget.
    const noOverhead = enforceContextBudget(messages, { contextWindow: 131_072 })
    expect(noOverhead.droppedCount).toBe(0)
    // 60k tokens of tool schemas shrink the budget below the tail size.
    const withTools = enforceContextBudget(messages, {
      contextWindow: 131_072,
      toolsTokens: 60_000
    })
    expect(withTools.droppedCount).toBe(1)
  })

  it('clamps the budget at the minimum floor for tiny windows', () => {
    const messages = [textMsg('a'.repeat(50_000)), textMsg('a'.repeat(50_000), 'assistant')]
    // window=1000 → floor(1000*0.85) - 8192 is negative → MIN_BUDGET 4096.
    const result = enforceContextBudget(messages, { contextWindow: 1000 })
    expect(result.budgetTokens).toBe(4_096)
    expect(result.droppedCount).toBe(1)
  })

  it('uses latinTokens estimates consistently for sizing', () => {
    const chars = 300_000
    const messages = [textMsg('a'.repeat(chars))]
    const result = enforceContextBudget(messages, { contextWindow: 131_072 })
    expect(result.estimatedTokens).toBe(latinTokens(chars))
  })
})
