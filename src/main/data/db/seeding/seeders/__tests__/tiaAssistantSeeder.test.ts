import { assistantMcpServerTable } from '@data/db/schemas/assistantRelations'
import { assistantTable } from '@data/db/schemas/assistant'
import { mcpServerTable } from '@data/db/schemas/mcpServer'
import { userModelTable } from '@data/db/schemas/userModel'
import { userProviderTable } from '@data/db/schemas/userProvider'
import { TiaAssistantSeeder } from '@data/db/seeding/seeders/tiaAssistantSeeder'
import { TIA_ASSISTANT_PROMPT_HISTORY } from '../tiaAssistantPromptHistory'
import { resolveBundledMcpCommand } from '@main/utils/bundledMcpCommand'
import { TIA_MCP_COMMAND, TIA_MCP_SERVER_NAME } from '../tiaMcpSeeder'
import {
  TIA_ASSISTANT_DESCRIPTION,
  TIA_ASSISTANT_EMOJI,
  TIA_ASSISTANT_ID,
  TIA_ASSISTANT_NAME,
  TIA_ASSISTANT_NAME_ZH,
  TIA_ASSISTANT_PROMPT
} from '@shared/data/presets/tiaAssistant'
import { CHERRYAI_DEFAULT_UNIQUE_MODEL_ID, CHERRYAI_PROVIDER_ID } from '@shared/data/presets/cherryai'
import { DEFAULT_ASSISTANT_SETTINGS } from '@shared/data/types/assistant'
import { setupTestDatabase } from '@test-helpers/db'
import { eq } from 'drizzle-orm'
import { app } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const TIA_MODEL_ID = CHERRYAI_DEFAULT_UNIQUE_MODEL_ID

describe('TiaAssistantSeeder', () => {
  const dbh = setupTestDatabase()
  const resolvedCommand = resolveBundledMcpCommand(TIA_MCP_COMMAND)

  beforeEach(async () => {
    vi.mocked(app.getPreferredSystemLanguages).mockReturnValue(['zh-CN'])
    // FK chain: assistant.modelId -> user_model.providerId -> user_provider
    await dbh.db.insert(userProviderTable).values({
      providerId: CHERRYAI_PROVIDER_ID,
      presetProviderId: CHERRYAI_PROVIDER_ID,
      name: 'CherryAI',
      apiKeys: [],
      isEnabled: true,
      orderKey: 'a0'
    })
    await dbh.db.insert(userModelTable).values({
      id: TIA_MODEL_ID,
      providerId: CHERRYAI_PROVIDER_ID,
      modelId: 'qwen',
      presetModelId: 'qwen',
      orderKey: 'a0'
    })
  })

  async function seedMcpServer(overrides?: Partial<typeof mcpServerTable.$inferInsert>) {
    await dbh.db.insert(mcpServerTable).values({
      id: 'srv-tia-1',
      name: TIA_MCP_SERVER_NAME,
      type: 'stdio',
      command: resolvedCommand,
      args: ['--tia-portal-location', 'C:\\Program Files\\Siemens\\Automation\\Portal V21', '--tia-major-version', '21'],
      env: {},
      isActive: false,
      installSource: 'builtin',
      isTrusted: true,
      timeout: 300,
      longRunning: true,
      ...overrides
    })
  }

  it('seeds the localized assistant first, binds the MCP server and activates it', async () => {
    // A pre-existing assistant proves the new one is pinned in front of it.
    await dbh.db.insert(assistantTable).values({
      id: 'asst-pre-existing',
      name: 'PLC 助手',
      emoji: '😀',
      prompt: '',
      description: '',
      modelId: null,
      settings: DEFAULT_ASSISTANT_SETTINGS,
      orderKey: 'a0'
    })
    await seedMcpServer()

    new TiaAssistantSeeder().run(dbh.db)

    const [assistant] = await dbh.db
      .select()
      .from(assistantTable)
      .where(eq(assistantTable.name, TIA_ASSISTANT_NAME_ZH))
    expect(assistant).toMatchObject({
      emoji: TIA_ASSISTANT_EMOJI,
      prompt: TIA_ASSISTANT_PROMPT,
      description: TIA_ASSISTANT_DESCRIPTION,
      modelId: TIA_MODEL_ID
    })
    // Pinned before the pre-existing assistant (fractional ordering: smaller key = earlier).
    expect(assistant.orderKey! < 'a0').toBe(true)

    const [binding] = await dbh.db
      .select()
      .from(assistantMcpServerTable)
      .where(eq(assistantMcpServerTable.assistantId, assistant.id))
    expect(binding).toMatchObject({ assistantId: assistant.id, mcpServerId: 'srv-tia-1' })

    const [server] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(server.isActive).toBe(true)
  })

  it('is idempotent: re-running neither duplicates rows nor deactivates the server', async () => {
    await seedMcpServer()
    new TiaAssistantSeeder().run(dbh.db)
    new TiaAssistantSeeder().run(dbh.db)

    const assistants = await dbh.db.select().from(assistantTable)
    const bindings = await dbh.db.select().from(assistantMcpServerTable)
    const [server] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(assistants).toHaveLength(1)
    expect(bindings).toHaveLength(1)
    expect(server.isActive).toBe(true)
  })

  it('never rewrites a user-edited prompt, but back-fills a missing binding without activating', async () => {
    await seedMcpServer()
    // The factory assistant is recognized by its stable id only (never by name),
    // so the user-edited row must carry TIA_ASSISTANT_ID to hit the repair path.
    await dbh.db.insert(assistantTable).values({
      id: TIA_ASSISTANT_ID,
      name: TIA_ASSISTANT_NAME_ZH,
      emoji: '🔧',
      prompt: '用户自定义提示词',
      description: '',
      modelId: null,
      settings: DEFAULT_ASSISTANT_SETTINGS,
      orderKey: 'Zz'
    })

    new TiaAssistantSeeder().run(dbh.db)

    const [assistant] = await dbh.db
      .select()
      .from(assistantTable)
      .where(eq(assistantTable.name, TIA_ASSISTANT_NAME_ZH))
    expect(assistant.prompt).toBe('用户自定义提示词')
    expect(assistant.id).toBe(TIA_ASSISTANT_ID)

    const bindings = await dbh.db
      .select()
      .from(assistantMcpServerTable)
      .where(eq(assistantMcpServerTable.assistantId, TIA_ASSISTANT_ID))
    expect(bindings).toHaveLength(1)

    // Repair path must not flip the user's own server toggle.
    const [server] = await dbh.db.select().from(mcpServerTable).where(eq(mcpServerTable.name, TIA_MCP_SERVER_NAME))
    expect(server.isActive).toBe(false)
  })

  it('hot-updates a stored factory prompt to the shipped version and stays idempotent', async () => {
    await seedMcpServer()
    // A row still holding the previously shipped factory text was never
    // user-edited, so a seeder re-run (version bump) advances it.
    await dbh.db.insert(assistantTable).values({
      id: TIA_ASSISTANT_ID,
      name: TIA_ASSISTANT_NAME_ZH,
      emoji: TIA_ASSISTANT_EMOJI,
      prompt: TIA_ASSISTANT_PROMPT_HISTORY[0],
      description: TIA_ASSISTANT_DESCRIPTION,
      modelId: TIA_MODEL_ID,
      settings: DEFAULT_ASSISTANT_SETTINGS,
      orderKey: 'Zz'
    })

    new TiaAssistantSeeder().run(dbh.db)

    const [assistant] = await dbh.db.select().from(assistantTable).where(eq(assistantTable.id, TIA_ASSISTANT_ID))
    expect(assistant.prompt).toBe(TIA_ASSISTANT_PROMPT)

    // Re-running with the prompt already shipped must not touch the row again.
    new TiaAssistantSeeder().run(dbh.db)
    const [after] = await dbh.db.select().from(assistantTable).where(eq(assistantTable.id, TIA_ASSISTANT_ID))
    expect(after.prompt).toBe(TIA_ASSISTANT_PROMPT)
  })

  it('still seeds the assistant when the TIA MCP server row is absent', async () => {
    new TiaAssistantSeeder().run(dbh.db)

    const assistants = await dbh.db.select().from(assistantTable)
    const bindings = await dbh.db.select().from(assistantMcpServerTable)
    expect(assistants).toHaveLength(1)
    expect(assistants[0].prompt).toBe(TIA_ASSISTANT_PROMPT)
    expect(bindings).toHaveLength(0)
  })

  it('uses the English assistant name for non-zh locales', async () => {
    vi.mocked(app.getPreferredSystemLanguages).mockReturnValue(['en-US'])
    await seedMcpServer()

    new TiaAssistantSeeder().run(dbh.db)

    const [assistant] = await dbh.db
      .select()
      .from(assistantTable)
      .where(eq(assistantTable.name, TIA_ASSISTANT_NAME))
    expect(assistant).toBeDefined()
  })
})
