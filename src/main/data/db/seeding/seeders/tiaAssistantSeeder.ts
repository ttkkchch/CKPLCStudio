import { assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { assistantTable } from '@data/db/schemas/assistant'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { insertWithOrderKey } from '@data/services/utils/orderKey'
import {
  TIA_ASSISTANT_ID,
  TIA_ASSISTANT_SEED,
  getTiaAssistantNameForLocale
} from '@shared/data/presets/tiaAssistant'
import { and, eq, isNull } from 'drizzle-orm'
import { app } from 'electron'

import type { DbOrTx, DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'
import { TIA_MCP_SERVER_NAME } from './tiaMcpSeeder'

const logger = loggerService.withContext('TiaAssistantSeeder')

/**
 * Seed the bundled "TIA Engineer" assistant (CKPLCStudio factory assistant):
 *
 * - Inserts the assistant with the self-authored TIA prompt, pinned first in the
 *   assistant list (position 'first') so it acts as the out-of-box default pick.
 * - Binds it to the seeded TIA Portal MCP server (assistant_mcp_server junction).
 * - On first creation only, flips the bundled MCP server row to isActive so the
 *   assistant works out of the box; a later user toggle is never overwritten
 *   because the flip happens solely inside this first-insert transaction.
 *
 * Insert-repair semantics: an existing assistant (either locale name) is never
 * rewritten — the user may have edited the prompt. Only a missing MCP binding is
 * back-filled. Changing TIA_ASSISTANT_PROMPT bumps `version` (hashObject) which
 * re-runs this seeder; a user-deleted assistant is treated as self-healing of the
 * factory assistant and will be re-created on such a re-run.
 */
export class TiaAssistantSeeder implements ISeeder {
  readonly name = 'tiaAssistant'
  readonly description =
    'Insert the bundled TIA Engineer assistant, bind it to the TIA Portal MCP server and pin it first'
  readonly version: string

  constructor() {
    this.version = hashObject({
      prompt: TIA_ASSISTANT_SEED.prompt,
      name: TIA_ASSISTANT_SEED.name,
      emoji: TIA_ASSISTANT_SEED.emoji,
      description: TIA_ASSISTANT_SEED.description,
      modelId: TIA_ASSISTANT_SEED.modelId
    })
  }

  run(db: DbType): void {
    db.transaction((tx) => {
      const [existing] = this.findSeededAssistant(tx)
      if (existing) {
        // Repair path: back-fill a missing MCP binding only; never touch user edits.
        this.ensureBinding(tx, existing.id as string, /* activateServer */ false)
        return
      }

      // Only reuse the stable factory id when no (soft-deleted) row occupies it;
      // a soft-deleted factory assistant keeps its id, so fall back to a random
      // one instead of failing the whole seeding transaction.
      const [occupied] = tx
        .select({ id: assistantTable.id })
        .from(assistantTable)
        .where(eq(assistantTable.id, TIA_ASSISTANT_ID))
        .limit(1)
        .all()
      const seedId = occupied ? {} : { id: TIA_ASSISTANT_ID }

      const assistant = insertWithOrderKey(
        tx,
        assistantTable,
        {
          ...seedId,
          ...TIA_ASSISTANT_SEED,
          name: getTiaAssistantNameForLocale(this.getPreferredSystemLanguage()),
          settings: { ...TIA_ASSISTANT_SEED.settings }
        },
        {
          pkColumn: assistantTable.id,
          scope: isNull(assistantTable.deletedAt),
          position: 'first'
        }
      )

      this.ensureBinding(tx, assistant.id as string, /* activateServer */ true)
      logger.info('Seeded TIA Engineer assistant', { assistantId: assistant.id })
    })
  }

  /**
   * Identify the factory assistant by its stable id only. Matching by name is
   * deliberately avoided: a user-created assistant sharing the name must not be
   * mistaken for the factory row (it would receive MCP bindings), and a renamed
   * factory assistant must still be recognized.
   */
  private findSeededAssistant(tx: DbOrTx) {
    return tx
      .select({ id: assistantTable.id })
      .from(assistantTable)
      .where(and(eq(assistantTable.id, TIA_ASSISTANT_ID), isNull(assistantTable.deletedAt)))
      .limit(1)
      .all()
  }

  /**
   * Bind the assistant to the TIA Portal MCP server when both exist and the
   * binding is absent. With `activateServer`, a bundled, currently-inactive
   * server is flipped to active inside the same transaction (first insert only).
   */
  private ensureBinding(tx: DbOrTx, assistantId: string, activateServer: boolean): void {
    const [server] = tx
      .select({ id: mcpServerTable.id, isActive: mcpServerTable.isActive, installSource: mcpServerTable.installSource })
      .from(mcpServerTable)
      .where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
      .limit(1)
      .all()

    if (!server) {
      logger.warn('TIA Portal MCP server not found, assistant seeded without binding', { assistantId })
      return
    }

    const [binding] = tx
      .select({ assistantId: assistantMcpServerTable.assistantId })
      .from(assistantMcpServerTable)
      .where(and(eq(assistantMcpServerTable.assistantId, assistantId), eq(assistantMcpServerTable.mcpServerId, server.id)))
      .limit(1)
      .all()

    if (!binding) {
      tx.insert(assistantMcpServerTable).values({ assistantId, mcpServerId: server.id }).run()
    }

    if (activateServer && !server.isActive && server.installSource === 'builtin') {
      tx.update(mcpServerTable).set({ isActive: true }).where(eq(mcpServerTable.id, server.id)).run()
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
