import fs from 'node:fs'

import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { isWin } from '@main/core/platform'
import {
  CHERRY_APP_EXE_PREFIX,
  CHERRY_RESOURCE_PREFIX,
  resolveBundledMcpCommand
} from '@main/utils/bundledMcpCommand'
import { eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'

const logger = loggerService.withContext('GxWorks3McpSeeder')

/** Display name of the seeded server (shown in the MCP settings list). */
export const GX_MCP_SERVER_NAME = 'GX Works3 MCP Bridge'

/**
 * UIA-window operations and Rebuild All are seconds-to-minutes long: same
 * rationale as TIA_MCP_TIMEOUT_SECONDS (longRunning resets the client timeout
 * on progress and raises maxTotalTimeout).
 */
export const GX_MCP_TIMEOUT_SECONDS = 300
export const GX_MCP_LONG_RUNNING = true

/**
 * Location-independent command marker: resolved at spawn time to the app's own
 * Electron binary (see resolveBundledMcpCommand). The spawn env must set
 * ELECTRON_RUN_AS_NODE=1 (stored in the row env) so the binary behaves as Node.
 */
export const GX_MCP_COMMAND = CHERRY_APP_EXE_PREFIX

/** Bundled bridge script (esbuild-free tsc CJS emit), resolved at seed time. */
export const GX_MCP_SCRIPT_RESOURCE = `${CHERRY_RESOURCE_PREFIX}mitsubishi-mcp/mcpServer/entry.js`

export function resolveGxMcpScriptPath(): string {
  return resolveBundledMcpCommand(GX_MCP_SCRIPT_RESOURCE)
}

/**
 * Seed the bundled Mitsubishi GX Works3 bridge MCP server (Windows only).
 *
 * Unlike the TIA seeder this server is OUR OWN pure-JS code (no native addon),
 * run with the app's own Electron binary in Node mode — nothing extra ships
 * except the compiled script under resources/mitsubishi-mcp/.
 *
 * The stored `command` is the resolved on-disk execPath so the settings page
 * shows a real path; the resolver re-resolves the marker every spawn so the
 * command can never go stale. The script-path ARG is resolved at seed time and
 * repaired on seeder re-runs (version bump) when it points at a missing file.
 */
export class GxWorks3McpSeeder implements ISeeder {
  readonly name = 'gxWorks3Mcp'
  readonly version = '1'
  readonly description = 'Insert the bundled GX Works3 UIA-bridge MCP server (Windows only)'

  run(db: DbType): void {
    if (!isWin) {
      return
    }

    // Skip when the compiled bridge script is missing (e.g. a dev checkout that
    // has not run `pnpm mitsubishi:build`).
    const scriptPath = resolveGxMcpScriptPath()
    if (!fs.existsSync(scriptPath)) {
      logger.warn('Compiled GX Works3 bridge script missing, skipping seed', { scriptPath })
      return
    }

    db.transaction((tx) => {
      const [existing] = tx
        .select()
        .from(mcpServerTable)
        .where(eq(mcpServerTable.name, GX_MCP_SERVER_NAME))
        .limit(1)
        .all()

      if (existing) {
        // Repair an untouched builtin row after an install move/reinstall: the
        // script arg is an absolute path baked at seed time. Only rewritten when
        // it no longer exists on disk (a user-customized arg that exists wins).
        const storedScript = Array.isArray(existing.args) ? existing.args[0] : undefined
        if (
          existing.installSource === 'builtin' &&
          typeof storedScript === 'string' &&
          storedScript !== scriptPath &&
          !fs.existsSync(storedScript)
        ) {
          tx.update(mcpServerTable)
            .set({ command: process.execPath, args: [scriptPath] })
            .where(eq(mcpServerTable.id, existing.id))
            .run()
          logger.info('Repaired GX Works3 bridge script path', { scriptPath })
        }
        return
      }

      const now = Date.now()
      tx.insert(mcpServerTable)
        .values({
          name: GX_MCP_SERVER_NAME,
          type: 'stdio',
          description: 'Mitsubishi GX Works3 UIA bridge MCP server (ST write/compile/sim)',
          command: process.execPath,
          args: [scriptPath],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          isActive: false,
          installSource: 'builtin',
          isTrusted: true,
          trustedAt: now,
          installedAt: now,
          longRunning: GX_MCP_LONG_RUNNING,
          timeout: GX_MCP_TIMEOUT_SECONDS
        })
        .run()
      logger.info('Seeded GX Works3 MCP bridge server', { scriptPath })
    })
  }
}
