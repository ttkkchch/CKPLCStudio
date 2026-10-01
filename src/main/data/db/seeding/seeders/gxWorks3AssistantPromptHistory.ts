import { GX_ASSISTANT_PROMPT } from '@shared/data/presets/gxWorks3Assistant'

/**
 * Every previously shipped factory prompt of the Mitsubishi Engineer assistant,
 * newest first, byte-exact as they were seeded into user databases.
 *
 * Purpose: factory prompt hot-update. Changing GX_ASSISTANT_PROMPT bumps the
 * MitsubishiAssistantSeeder version (hashObject), which re-runs the seeder; a
 * stored assistant prompt that still equals one of these texts was never
 * user-edited and is safe to advance to the current shipped prompt. A
 * user-customized prompt matches none of them and is never rewritten.
 *
 * Convention: whenever GX_ASSISTANT_PROMPT changes, prepend the outgoing text
 * here, unmodified. Main-process only — never import from the renderer bundle.
 */
export const GX_ASSISTANT_PROMPT_HISTORY: readonly string[] = []

export function isOutdatedGxFactoryPrompt(prompt: string): boolean {
  return prompt !== GX_ASSISTANT_PROMPT && GX_ASSISTANT_PROMPT_HISTORY.includes(prompt)
}
