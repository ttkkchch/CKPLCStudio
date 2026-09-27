import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { isWin } from '@main/core/platform'
import { BuiltinMcpServerNames } from '@shared/utils/mcp'
import { app } from 'electron'
import path from 'path'
import { eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'

const logger = loggerService.withContext('TiaWorkspaceMcpSeeder')

/**
 * Row name of the seeded TIA workspace server. Must equal the
 * BuiltinMcpServerNames.tiaWorkspace key: the MCP runtime routes `inMemory`
 * rows to the in-process factory by exact name match.
 */
export const TIA_WORKSPACE_MCP_SERVER_NAME = BuiltinMcpServerNames.tiaWorkspace

let cachedDefaultRoots: string | undefined

/**
 * Default whitelisted extra root for FRESH installs: a portable per-user
 * scratch dir under the user's Documents folder where the TIA Engineer
 * assistant exports block sources for read_text_file/list_dir. Computed at
 * seed time (never a machine-specific drive letter) and stored in the row's
 * env as TIA_EXTRA_ROOTS (';'-separated list) so the user can extend it from
 * the MCP settings form without a code change.
 *
 * Lazy + cached: seeders may be imported before the electron app is ready, so
 * app.getPath must not run at module load. Existing rows are never rewritten
 * (the back-fill only fills a missing value), so upgrades keep their roots.
 */
export function getTiaWorkspaceDefaultRoots(): string {
  if (!cachedDefaultRoots) {
    cachedDefaultRoots = path.join(app.getPath('documents'), 'TIA_Export')
  }
  return cachedDefaultRoots
}

/**
 * Seed the built-in TIA workspace MCP server (in-process, `@cherry/tia-workspace`).
 *
 * Gives the TIA Engineer assistant the missing half of its toolchain: reading
 * exported block sources (read_text_file / list_dir) instead of dead-ending at
 * "please paste the file content", plus per-project session notes
 * (read_project_note / write_project_note) for cross-session context.
 *
 * Windows-only: it only exists to accompany the TIA Portal workflow.
 *
 * Insert-only, and a builtin row missing the TIA_EXTRA_ROOTS default gets it
 * back-filled (a user-configured value is never overwritten). The server row is
 * created active so the assistant works out of the box; a user's later toggle
 * is never touched because the flag is only set on fresh insert.
 */
export class TiaWorkspaceMcpSeeder implements ISeeder {
  readonly name = 'tiaWorkspaceMcp'
  readonly version = '1'
  readonly description = 'Insert the built-in TIA workspace file/note MCP server (Windows only)'

  run(db: DbType): void {
    if (!isWin) {
      return
    }

    db.transaction((tx) => {
      const [existing] = tx
        .select()
        .from(mcpServerTable)
        .where(eq(mcpServerTable.name, TIA_WORKSPACE_MCP_SERVER_NAME))
        .limit(1)
        .all()

      if (existing) {
        if (existing.installSource === 'builtin' && existing.env?.TIA_EXTRA_ROOTS == null) {
          tx.update(mcpServerTable)
            .set({ env: { ...existing.env, TIA_EXTRA_ROOTS: getTiaWorkspaceDefaultRoots() } })
            .where(eq(mcpServerTable.id, existing.id))
            .run()
          logger.info('Back-filled TIA_EXTRA_ROOTS default on existing builtin row')
        }
        return
      }

      const now = Date.now()
      tx.insert(mcpServerTable)
        .values({
          name: TIA_WORKSPACE_MCP_SERVER_NAME,
          type: 'inMemory',
          description: 'TIA workspace files & per-project notes (whitelisted sandbox)',
          env: { TIA_EXTRA_ROOTS: getTiaWorkspaceDefaultRoots() },
          isActive: true,
          installSource: 'builtin',
          isTrusted: true,
          trustedAt: now,
          installedAt: now
        })
        .run()
      logger.info('Seeded TIA workspace MCP server')
    })
  }
}
