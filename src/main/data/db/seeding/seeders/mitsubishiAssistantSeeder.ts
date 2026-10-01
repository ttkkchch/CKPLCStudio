import { assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { assistantTable } from '@data/db/schemas/assistant'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { insertWithOrderKey } from '@data/services/utils/orderKey'
import {
  GX_ASSISTANT_ID,
  GX_ASSISTANT_PROMPT,
  GX_ASSISTANT_SEED,
  getGxAssistantNameForLocale
} from '@shared/data/presets/gxWorks3Assistant'
import { and, eq, isNull } from 'drizzle-orm'
import { app } from 'electron'

import type { DbOrTx, DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'
import { GX_MCP_SERVER_NAME } from './gxWorks3McpSeeder'
import { isOutdatedGxFactoryPrompt } from './gxWorks3AssistantPromptHistory'
import { GX_WORKSPACE_MCP_SERVER_NAME } from './gxWorkspaceMcpSeeder'

const logger = loggerService.withContext('MitsubishiAssistantSeeder')

/**
 * MCP servers the factory assistant must be bound to. A missing binding for
 * any of them is back-filled on seeder re-runs (repair path).
 */
const REQUIRED_MCP_SERVER_NAMES = [GX_MCP_SERVER_NAME, GX_WORKSPACE_MCP_SERVER_NAME]

/**
 * Seed the bundled "三菱工程师" (Mitsubishi Engineer) assistant:
 *
 * - Inserts the assistant with the self-authored GX Works3 prompt, pinned first
 *   in the assistant list (position 'first').
 * - Binds it to the seeded GX MCP servers (assistant_mcp_server junction).
 * - On first creation only, flips bundled, currently-inactive MCP server rows
 *   to active so the assistant works out of the box.
 *
 * Insert-repair semantics mirror TiaAssistantSeeder: hot-update the prompt ONLY
 * when the stored text is a previously shipped factory version (byte-exact in
 * GX_ASSISTANT_PROMPT_HISTORY); a customized prompt is never rewritten; only
 * missing MCP bindings are back-filled; a user-deleted assistant is re-created.
 * Identified by stable id only (name matching deliberately avoided).
 */
export class MitsubishiAssistantSeeder implements ISeeder {
  readonly name = 'mitsubishiAssistant'
  readonly description =
    'Insert the bundled Mitsubishi Engineer assistant, bind it to the GX Works3 MCP servers and pin it first'
  readonly version: string

  constructor() {
    this.version = hashObject({
      prompt: GX_ASSISTANT_SEED.prompt,
      name: GX_ASSISTANT_SEED.name,
      emoji: GX_ASSISTANT_SEED.emoji,
      description: GX_ASSISTANT_SEED.description,
      modelId: GX_ASSISTANT_SEED.modelId
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => {
      const [existing] = this.findSeededAssistant(tx)
      if (existing) {
        // Repair path: back-fill missing MCP bindings only; never touch user edits.
        this.ensureBindings(tx, existing.id as string, /* activateServers */ false)
        this.hotUpdateFactoryPrompt(tx, existing.id as string, existing.prompt)
        return
      }

      // Only reuse the stable factory id when no (soft-deleted) row occupies it;
      // fall back to a random id instead of failing the whole seeding transaction.
      const [occupied] = tx
        .select({ id: assistantTable.id })
        .from(assistantTable)
        .where(eq(assistantTable.id, GX_ASSISTANT_ID))
        .limit(1)
        .all()
      const seedId = occupied ? {} : { id: GX_ASSISTANT_ID }

      const assistant = insertWithOrderKey(
        tx,
        assistantTable,
        {
          ...seedId,
          ...GX_ASSISTANT_SEED,
          name: getGxAssistantNameForLocale(this.getPreferredSystemLanguage()),
          settings: { ...GX_ASSISTANT_SEED.settings }
        },
        {
          pkColumn: assistantTable.id,
          scope: isNull(assistantTable.deletedAt),
          position: 'first'
        }
      )

      this.ensureBindings(tx, assistant.id as string, /* activateServers */ true)
      logger.info('Seeded Mitsubishi Engineer assistant', { assistantId: assistant.id })
    })
  }

  private findSeededAssistant(tx: DbOrTx) {
    return tx
      .select({ id: assistantTable.id, prompt: assistantTable.prompt })
      .from(assistantTable)
      .where(and(eq(assistantTable.id, GX_ASSISTANT_ID), isNull(assistantTable.deletedAt)))
      .limit(1)
      .all()
  }

  private hotUpdateFactoryPrompt(tx: DbOrTx, assistantId: string, storedPrompt: string | null): void {
    const current = storedPrompt ?? ''
    if (!isOutdatedGxFactoryPrompt(current)) {
      return
    }
    tx.update(assistantTable).set({ prompt: GX_ASSISTANT_PROMPT }).where(eq(assistantTable.id, assistantId)).run()
    logger.info('Hot-updated factory Mitsubishi assistant prompt to the shipped version', {
      assistantId,
      previousChars: current.length,
      shippedChars: GX_ASSISTANT_PROMPT.length
    })
  }

  private ensureBindings(tx: DbOrTx, assistantId: string, activateServers: boolean): void {
    for (const serverName of REQUIRED_MCP_SERVER_NAMES) {
      const [server] = tx
        .select({
          id: mcpServerTable.id,
          isActive: mcpServerTable.isActive,
          installSource: mcpServerTable.installSource
        })
        .from(mcpServerTable)
        .where(eq(mcpServerTable.name, serverName))
        .limit(1)
        .all()

      if (!server) {
        logger.warn('Required MCP server not found, assistant seeded without its binding', {
          assistantId,
          serverName
        })
        continue
      }

      const [binding] = tx
        .select({ assistantId: assistantMcpServerTable.assistantId })
        .from(assistantMcpServerTable)
        .where(
          and(eq(assistantMcpServerTable.assistantId, assistantId), eq(assistantMcpServerTable.mcpServerId, server.id))
        )
        .limit(1)
        .all()

      if (!binding) {
        tx.insert(assistantMcpServerTable).values({ assistantId, mcpServerId: server.id }).run()
      }

      if (activateServers && !server.isActive && server.installSource === 'builtin') {
        tx.update(mcpServerTable).set({ isActive: true }).where(eq(mcpServerTable.id, server.id)).run()
      }
    }
  }

  private getPreferredSystemLanguage(): string | undefined {
    try {
      return app.getPreferredSystemLanguages()[0]
    } catch {
      return undefined
    }
  }
}
