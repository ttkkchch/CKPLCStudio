import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TIA_WORKSPACE_DEFAULT_ROOTS, TIA_WORKSPACE_MCP_SERVER_NAME } from '../tiaWorkspaceMcpSeeder'

// `@main/core/platform` is NOT globally mocked — loadSeeder() re-imports the
// seeder under a per-test platform mock (same pattern as tiaMcpSeeder.test.ts).
async function loadSeeder({ isWin }: { isWin: boolean }) {
  vi.resetModules()
  vi.doMock('@main/core/platform', () => ({ isWin }))
  const { TiaWorkspaceMcpSeeder } = await import('../tiaWorkspaceMcpSeeder')
  return new TiaWorkspaceMcpSeeder()
}

describe('TiaWorkspaceMcpSeeder', () => {
  const dbh = setupTestDatabase()

  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock('@main/core/platform')
  })

  it('inserts the in-memory TIA workspace server once, active and trusted (Windows)', async () => {
    const seeder = await loadSeeder({ isWin: true })

    seeder.run(dbh.db)
    seeder.run(dbh.db) // re-run must stay idempotent

    const rows = await dbh.db.select().from(mcpServerTable)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe(TIA_WORKSPACE_MCP_SERVER_NAME)
    expect(rows[0].type).toBe('inMemory')
    expect(rows[0].env).toEqual({ TIA_EXTRA_ROOTS: TIA_WORKSPACE_DEFAULT_ROOTS })
    expect(rows[0].isActive).toBe(true)
    expect(rows[0].installSource).toBe('builtin')
    expect(rows[0].isTrusted).toBe(true)
  })

  it('back-fills a missing TIA_EXTRA_ROOTS default on an existing builtin row', async () => {
    await dbh.db.insert(mcpServerTable).values({
      id: 'srv-tia-ws',
      name: TIA_WORKSPACE_MCP_SERVER_NAME,
      type: 'inMemory',
      env: {},
      isActive: false,
      installSource: 'builtin'
    })

    const seeder = await loadSeeder({ isWin: true })
    seeder.run(dbh.db)

    const [row] = await dbh.db
      .select()
      .from(mcpServerTable)
      .where(eq(mcpServerTable.name, TIA_WORKSPACE_MCP_SERVER_NAME))
    expect(row.env).toEqual({ TIA_EXTRA_ROOTS: TIA_WORKSPACE_DEFAULT_ROOTS })
    // A user's own server toggle is never flipped by the back-fill.
    expect(row.isActive).toBe(false)
  })

  it('never overwrites a user-configured TIA_EXTRA_ROOTS', async () => {
    await dbh.db.insert(mcpServerTable).values({
      id: 'srv-tia-ws-user',
      name: TIA_WORKSPACE_MCP_SERVER_NAME,
      type: 'inMemory',
      env: { TIA_EXTRA_ROOTS: 'D:\\MyTIA' },
      isActive: true,
      installSource: 'builtin'
    })

    const seeder = await loadSeeder({ isWin: true })
    seeder.run(dbh.db)

    const [row] = await dbh.db
      .select()
      .from(mcpServerTable)
      .where(eq(mcpServerTable.name, TIA_WORKSPACE_MCP_SERVER_NAME))
    expect(row.env).toEqual({ TIA_EXTRA_ROOTS: 'D:\\MyTIA' })
  })

  it('does not seed on non-Windows platforms', async () => {
    const seeder = await loadSeeder({ isWin: false })

    seeder.run(dbh.db)

    const rows = await dbh.db.select().from(mcpServerTable)
    expect(rows).toHaveLength(0)
  })
})
