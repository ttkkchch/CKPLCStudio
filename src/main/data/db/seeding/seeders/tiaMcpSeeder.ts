import fs from 'node:fs'
import { join } from 'node:path'

import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { loggerService } from '@logger'
import { isWin } from '@main/core/platform'
import { CHERRY_RESOURCE_PREFIX, resolveBundledMcpCommand } from '@main/utils/bundledMcpCommand'
import { eq } from 'drizzle-orm'

import type { DbType, ISeeder } from '../../types'

const logger = loggerService.withContext('TiaMcpSeeder')

/** Display name of the seeded server (shown in the MCP settings list). */
export const TIA_MCP_SERVER_NAME = 'TIA Portal MCP (V21)'

/**
 * TIA Openness operations that touch the hardware catalog (SearchHardwareCatalog,
 * AddDeviceWithFallback, AddHardwareCatalogDeviceWithProbe) routinely exceed a generic
 * MCP tool's default time budget: building the catalog / enumerating all matching entries
 * can take well over a minute on a large or partially-loaded installation. Without an
 * explicit timeout the client's 60 s default kills the call mid-search (surfacing as
 * `-32001: Request timed out`).
 *
 * We opt the bundled server into `longRunning` (client resets its timeout on progress and
 * raises `maxTotalTimeout`), plus a generous per-call budget. 300 s is enough headroom for
 * hardware-catalog enumeration on slow first-load while staying well under the 10-minute
 * long-running cap enforced by `McpRuntimeService.callToolByServer`.
 */
export const TIA_MCP_TIMEOUT_SECONDS = 300
export const TIA_MCP_LONG_RUNNING = true

/**
 * Location-independent command marker for the bundled runtime. The seeder
 * resolves it to the real on-disk path (see {@link resolveBundledMcpCommand})
 * and stores THAT path — so the MCP settings page shows a normal filesystem
 * path instead of this internal marker.
 */
export const TIA_MCP_COMMAND = `${CHERRY_RESOURCE_PREFIX}tia-mcp/v21/TiaMcpServer.exe`

/**
 * Default launch arguments. `--tia-portal-location` points at the TIA Portal V21
 * Openness API installation and is user-customizable afterwards via the MCP
 * settings form (it is a default, not a fixed value). The seeder replaces the
 * C:-drive default with a detected installation when one exists on another drive.
 */
export const TIA_MCP_DEFAULT_ARGS = [
  '--tia-portal-location',
  'C:\\Program Files\\Siemens\\Automation\\Portal V21',
  '--tia-major-version',
  '21'
]

/**
 * Probe common installation roots for the TIA Portal V21 Openness directory.
 * Installations frequently live on a non-system drive (e.g. `D:\Program Files\
 * Siemens\Automation\Portal V21`); the shipped C:-default would break MCP
 * startup there. Only V21 is probed: the bundled TiaMcpServer.exe is built
 * against the V21 Openness API, so pointing at an older Portal would yield a
 * self-contradictory config (path of V19 + `--tia-major-version 21`).
 * Returns the first V21 directory that contains a `Bin` subdirectory (the
 * Openness runtime marker), or null when nothing matches.
 */
export function detectTiaPortalLocation(): string | null {
  const drives = ['C:', 'D:', 'E:', 'F:']
  const programDirs = ['Program Files', 'Program Files (x86)']
  const candidates: string[] = []
  for (const drive of drives) {
    for (const programDir of programDirs) {
      candidates.push(`${drive}\\${programDir}\\Siemens\\Automation\\Portal V21`)
    }
  }
  for (const dir of candidates) {
    try {
      if (fs.existsSync(join(dir, 'Bin'))) {
        return dir
      }
    } catch {
      // Unreadable drive (e.g. empty card reader) — keep probing.
    }
  }
  return null
}

/** True when `args` still equals the shipped default (i.e. the user never customized it). */
function isDefaultArgs(args: unknown): boolean {
  return (
    Array.isArray(args) &&
    args.length === TIA_MCP_DEFAULT_ARGS.length &&
    TIA_MCP_DEFAULT_ARGS.every((v, i) => (args as string[])[i] === v)
  )
}

/**
 * Seed the bundled TIA Portal Openness MCP server (Siemens TIA Portal V21).
 *
 * Windows-only: the server is a .NET Framework executable that drives the local
 * TIA Portal Openness API, so seeding is skipped on other platforms and when
 * the bundled runtime is absent.
 *
 * The stored `command` is the resolved on-disk path (e.g.
 * `<app>/resources/app.asar.unpacked/resources/tia-mcp/v21/TiaMcpServer.exe`),
 * NOT the `cherry-resource://` marker — the settings page shows a real path.
 *
 * Insert-only by default, but the seeder repairs rows a previous version wrote
 * with the `cherry-resource://` marker: an untouched builtin row whose command
 * is still that marker is rewritten to the current resolved path. A
 * user-customized command is never overwritten.
 */
export class TiaMcpSeeder implements ISeeder {
  readonly name = 'tiaMcp'
  // v1 seeded the `cherry-resource://` marker; v2 seeds the resolved path;
  // v3 seeds/probes the real TIA Portal installation location.
  readonly version = '3'
  readonly description = 'Insert the bundled TIA Portal Openness MCP server (Windows only)'

  run(db: DbType): void {
    if (!isWin) {
      return
    }

    // Skip when the bundled runtime is missing (e.g. a dev checkout without it).
    const exePath = resolveBundledMcpCommand(TIA_MCP_COMMAND)
    if (!fs.existsSync(exePath)) {
      logger.warn('Bundled TIA MCP runtime missing, skipping seed', { exePath })
      return
    }

    // All multi-step reads/writes run in one transaction so journal replay after
    // a crash cannot leave a half-seeded server row.
    db.transaction((tx) => {
      const [existing] = tx
        .select()
        .from(mcpServerTable)
        .where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
        .limit(1)
        .all()

      if (existing) {
        // Repair a row our v1 seeder wrote with the marker command: rewrite it to
        // the real on-disk path. Only when it is still an untouched builtin row
        // whose command is the marker — a user-customized command is never touched.
        if (existing.installSource === 'builtin' && existing.command === TIA_MCP_COMMAND) {
          tx.update(mcpServerTable).set({ command: exePath }).where(eq(mcpServerTable.id, existing.id)).run()
        }

        // Back-fill the long-running / timeout defaults on a builtin row that never
        // had them set (timeout is null = the user has not explicitly configured one).
        // This lets an existing install pick up the hardware-catalog fix without a full
        // re-seed, while never clobbering a timeout the user deliberately configured.
        if (existing.installSource === 'builtin' && existing.timeout == null) {
          tx.update(mcpServerTable)
            .set({ longRunning: TIA_MCP_LONG_RUNNING, timeout: TIA_MCP_TIMEOUT_SECONDS })
            .where(eq(mcpServerTable.id, existing.id))
            .run()
        }

        // v3: repair an untouched builtin row still pointing at the C:-drive default
        // when a real TIA Portal installation exists elsewhere (probe result wins).
        if (existing.installSource === 'builtin' && isDefaultArgs(existing.args)) {
          const detected = detectTiaPortalLocation()
          if (detected && detected !== TIA_MCP_DEFAULT_ARGS[1]) {
            tx.update(mcpServerTable)
              .set({ args: ['--tia-portal-location', detected, '--tia-major-version', '21'] })
              .where(eq(mcpServerTable.id, existing.id))
              .run()
            logger.info('Repaired TIA Portal location', { detected })
          }
        }
        return
      }

      // Fresh insert: use the detected installation location when available.
      const detected = detectTiaPortalLocation()
      const args = detected
        ? ['--tia-portal-location', detected, '--tia-major-version', '21']
        : [...TIA_MCP_DEFAULT_ARGS]

      const now = Date.now()
      tx.insert(mcpServerTable)
        .values({
          name: TIA_MCP_SERVER_NAME,
          type: 'stdio',
          description: 'Siemens TIA Portal Openness MCP server (V21)',
          command: exePath,
          args,
          env: {},
          isActive: false,
          installSource: 'builtin',
          isTrusted: true,
          trustedAt: now,
          installedAt: now,
          longRunning: TIA_MCP_LONG_RUNNING,
          timeout: TIA_MCP_TIMEOUT_SECONDS
        })
        .run()
    })
  }
}
