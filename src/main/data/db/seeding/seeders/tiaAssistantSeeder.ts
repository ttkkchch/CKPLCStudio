import { assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { assistantTable } from '@data/db/schemas/assistant'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { insertWithOrderKey } from '@data/services/utils/orderKey'
import {
  TIA_ASSISTANT_ID,
  TIA_ASSISTANT_PROMPT,
  TIA_ASSISTANT_SEED,
  getTiaAssistantNameForLocale
} from '@shared/data/presets/tiaAssistant'
import { and, eq, isNull } from 'drizzle-orm'
import { app } from 'electron'

import type { DbOrTx, DbType, ISeeder } from '../../types'
import { hashObject } from '../hashObject'
import { TIA_MCP_SERVER_NAME } from './tiaMcpSeeder'
import { isOutdatedFactoryPrompt } from './tiaAssistantPromptHistory'
import { TIA_WORKSPACE_MCP_SERVER_NAME } from './tiaWorkspaceMcpSeeder'

const logger = loggerService.withContext('TiaAssistantSeeder')

/**
 * MCP servers the factory assistant must be bound to. A missing binding for
 * any of them is back-filled on seeder re-runs (repair path).
 */
const REQUIRED_MCP_SERVER_NAMES = [TIA_MCP_SERVER_NAME, TIA_WORKSPACE_MCP_SERVER_NAME]

/**
 * Seed the bundled "TIA Engineer" assistant (CKPLCStudio factory assistant):
 *
 * - Inserts the assistant with the self-authored TIA prompt, pinned first in the
 *   assistant list (position 'first') so it acts as the out-of-box default pick.
 * - Binds it to the seeded TIA MCP servers (assistant_mcp_server junction).
 * - On first creation only, flips bundled, currently-inactive MCP server rows to
 *   active so the assistant works out of the box; a later user toggle is never
 *   overwritten because the flip happens solely inside this first-insert transaction.
 *
 * Insert-repair semantics: an existing assistant (either locale name) has its
 * prompt hot-updated ONLY when the stored prompt is still a previously shipped
 * factory text (byte-exact match against TIA_ASSISTANT_PROMPT_HISTORY) — such a
 * row was never user-edited. A customized prompt matches no factory version and
 * is never rewritten. Only a missing MCP binding is back-filled. Changing
 * TIA_ASSISTANT_PROMPT bumps `version` (hashObject) which re-runs this seeder
 * and drives the hot-update; a user-deleted assistant is treated as self-healing
 * of the factory assistant and will be re-created on such a re-run.
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
        // Repair path: back-fill missing MCP bindings only; never touch user edits.
        this.ensureBindings(tx, existing.id as string, /* activateServers */ false)
        this.hotUpdateFactoryPrompt(tx, existing.id as string, existing.prompt)
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

      this.ensureBindings(tx, assistant.id as string, /* activateServers */ true)
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
      .select({ id: assistantTable.id, prompt: assistantTable.prompt })
      .from(assistantTable)
      .where(and(eq(assistantTable.id, TIA_ASSISTANT_ID), isNull(assistantTable.deletedAt)))
      .limit(1)
      .all()
  }

  /**
   * Factory prompt hot-update: advance a stored prompt to the current shipped
   * version only when it is still a previously shipped factory text (byte-exact
   * match in TIA_ASSISTANT_PROMPT_HISTORY) — such a row was never user-edited.
   * Called on every seeder re-run, which happens exactly when the factory seed
   * (prompt included) changed.
   */
  private hotUpdateFactoryPrompt(tx: DbOrTx, assistantId: string, storedPrompt: string | null): void {
    const current = storedPrompt ?? ''
    if (!isOutdatedFactoryPrompt(current)) {
      return
    }
    tx.update(assistantTable).set({ prompt: TIA_ASSISTANT_PROMPT }).where(eq(assistantTable.id, assistantId)).run()
    logger.info('Hot-updated factory TIA assistant prompt to the shipped version', {
      assistantId,
      previousChars: current.length,
      shippedChars: TIA_ASSISTANT_PROMPT.length
    })
  }

  /**
   * Bind the assistant to each required MCP server that exists, when the
   * binding is absent. With `activateServers`, a bundled, currently-inactive
   * server is flipped to active inside the same transaction (first insert only).
   * A missing server row is logged and skipped (it may be platform-gated).
   */
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
