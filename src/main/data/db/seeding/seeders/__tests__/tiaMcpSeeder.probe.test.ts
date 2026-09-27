import type * as NodeFS from 'node:fs'
import fs from 'node:fs'

import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { resolveBundledMcpCommand } from '@main/utils/bundledMcpCommand'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  TIA_MCP_COMMAND,
  TIA_MCP_DEFAULT_ARGS,
  TIA_MCP_SERVER_NAME,
  detectTiaPortalLocation
} from '../tiaMcpSeeder'

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFS>('node:fs')
  const existsSync = vi.fn(actual.existsSync)
  return {
    ...actual,
    existsSync,
    default: { ...actual, existsSync }
  }
})

async function loadSeeder({ isWin }: { isWin: boolean }) {
  vi.resetModules()
  vi.doMock('@main/core/platform', () => ({ isWin }))
  const { TiaMcpSeeder } = await import('../tiaMcpSeeder')
  return new TiaMcpSeeder()
}

const D_V21 = 'D:\\Program Files\\Siemens\\Automation\\Portal V21'

/**
 * existsSync stub: pass through to the real fs only for the bundled-runtime
 * check (mocked app.root resource path); every probe path is answered by the
 * provided predicate.
 */
function stubProbe(bundleExe: string, probeHit: (path: string) => boolean) {
  vi.mocked(fs.existsSync).mockImplementation((path) => {
    const p = typeof path === 'string' ? path : path.toString()
    if (p === bundleExe) return true
    return probeHit(p)
  })
}

describe('TiaMcpSeeder v3 (TIA Portal location probing)', () => {
  const dbh = setupTestDatabase()
  const resolvedExe = resolveBundledMcpCommand(TIA_MCP_COMMAND)

  afterEach(() => {
    vi.mocked(fs.existsSync).mockClear()
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('@main/core/platform')
  })

  it('ignores pre-V21 installations (bundled TiaMcpServer.exe requires V21 Openness)', () => {
    stubProbe(resolvedExe, (p) => p === 'C:\\Program Files\\Siemens\\Automation\\Portal V20\\Bin')
    expect(detectTiaPortalLocation()).toBeNull()
  })

  it('detectTiaPortalLocation prefers non-system drives when they hold the V21 install', () => {
    stubProbe(resolvedExe, (p) => p === `${D_V21}\\Bin`)
    expect(detectTiaPortalLocation()).toBe(D_V21)
  })

  it('detectTiaPortalLocation returns null when nothing matches', () => {
    stubProbe(resolvedExe, () => false)
    expect(detectTiaPortalLocation()).toBeNull()
  })

  it('seeds fresh rows with the detected installation location', async () => {
    stubProbe(resolvedExe, (p) => p === `${D_V21}\\Bin`)
    const seeder = await loadSeeder({ isWin: true })

    seeder.run(dbh.db)

    const [row] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(row.args).toEqual(['--tia-portal-location', D_V21, '--tia-major-version', '21', '--with-ui'])
  })

  it('repairs an untouched builtin row that still points at the C:-drive default', async () => {
    stubProbe(resolvedExe, (p) => p === `${D_V21}\\Bin`)
    await dbh.db.insert(mcpServerTable).values({
      id: 'srv-c-default',
      name: TIA_MCP_SERVER_NAME,
      type: 'stdio',
      command: resolvedExe,
      args: [...TIA_MCP_DEFAULT_ARGS],
      env: {},
      isActive: false,
      installSource: 'builtin',
      isTrusted: true,
      timeout: 300,
      longRunning: true
    })
    const seeder = await loadSeeder({ isWin: true })

    seeder.run(dbh.db)

    const [row] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(row.args).toEqual(['--tia-portal-location', D_V21, '--tia-major-version', '21', '--with-ui'])
  })

  it('keeps user-customized args untouched', async () => {
    stubProbe(resolvedExe, (p) => p === `${D_V21}\\Bin`)
    const customArgs = ['--tia-portal-location', 'E:\\TIA\\Portal V21', '--tia-major-version', '21']
    await dbh.db.insert(mcpServerTable).values({
      id: 'srv-custom-args',
      name: TIA_MCP_SERVER_NAME,
      type: 'stdio',
      command: resolvedExe,
      args: customArgs,
      env: {},
      isActive: false,
      installSource: 'builtin',
      isTrusted: true,
      timeout: 300,
      longRunning: true
    })
    const seeder = await loadSeeder({ isWin: true })

    seeder.run(dbh.db)

    const [row] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(row.args).toEqual(customArgs)
  })

  it('keeps the shipped default when no installation is detected', async () => {
    stubProbe(resolvedExe, () => false)
    const seeder = await loadSeeder({ isWin: true })

    seeder.run(dbh.db)

    const [row] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(row.args).toEqual(TIA_MCP_DEFAULT_ARGS)
  })
})
