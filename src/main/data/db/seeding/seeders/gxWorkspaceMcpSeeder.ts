import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { isWin } from '@main/core/platform'
import { BuiltinMcpServerNames } from '@shared/utils/mcp'
import { app } from 'electron'
import path from 'path'
import { eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'

const logger = loggerService.withContext('GxWorkspaceMcpSeeder')

/**
 * Row name of the seeded GX workspace server. Must equal the
 * BuiltinMcpServerNames.gxWorkspace key: the MCP runtime routes `inMemory`
 * rows to the in-process factory by exact name match.
 */
export const GX_WORKSPACE_MCP_SERVER_NAME = BuiltinMcpServerNames.gxWorkspace

let cachedDefaultRoots: string | undefined

/**
 * Default whitelisted extra root for FRESH installs: a per-user scratch dir
 * under Documents where the Mitsubishi Engineer assistant parks generated
 * .st sources and device-comment CSVs. Stored in the row env as
 * GX_EXTRA_ROOTS (';'-separated) so the user can extend it from the MCP
 * settings form. Lazy + cached: seeders may be imported before the electron
 * app is ready. Existing rows are never rewritten (back-fill only).
 */
export function getGxWorkspaceDefaultRoots(): string {
  if (!cachedDefaultRoots) {
    cachedDefaultRoots = path.join(app.getPath('documents'), 'GX_Export')
  }
  return cachedDefaultRoots
}

/**
 * Seed the built-in GX workspace MCP server (in-process, `@cherry/gx-workspace`).
 *
 * Reuses the TiaWorkspaceServer implementation with the GX notes root
 * (feature.gx.workspace) — the file/note toolset is platform-agnostic.
 * Windows-only: it only exists to accompany the GX Works3 workflow.
 */
export class GxWorkspaceMcpSeeder implements ISeeder {
  readonly name = 'gxWorkspaceMcp'
  readonly version = '1'
  readonly description = 'Insert the built-in GX workspace file/note MCP server (Windows only)'

  run(db: DbType): void {
    if (!isWin) {
      return
    }

    db.transaction((tx) => {
      const [existing] = tx
        .select()
        .from(mcpServerTable)
        .where(eq(mcpServerTable.name, GX_WORKSPACE_MCP_SERVER_NAME))
        .limit(1)
        .all()

      if (existing) {
        if (existing.installSource === 'builtin' && existing.env?.GX_EXTRA_ROOTS == null) {
          tx.update(mcpServerTable)
            .set({ env: { ...existing.env, GX_EXTRA_ROOTS: getGxWorkspaceDefaultRoots() } })
            .where(eq(mcpServerTable.id, existing.id))
            .run()
          logger.info('Back-filled GX_EXTRA_ROOTS default on existing builtin row')
        }
        return
      }

      const now = Date.now()
      tx.insert(mcpServerTable)
        .values({
          name: GX_WORKSPACE_MCP_SERVER_NAME,
          type: 'inMemory',
          description: 'GX workspace files & per-project notes (whitelisted sandbox)',
          env: { GX_EXTRA_ROOTS: getGxWorkspaceDefaultRoots() },
          isActive: true,
          installSource: 'builtin',
          isTrusted: true,
          trustedAt: now,
          installedAt: now
        })
        .run()
      logger.info('Seeded GX workspace MCP server')
    })
  }
}
