import type { ISeeder } from '../types'
import { CherryAiDefaultModelSeeder } from './seeders/cherryaiDefaultModelSeeder'
import { CherryAssistantSeeder } from './seeders/cherryAssistantSeeder'
import { DefaultAssistantSeeder } from './seeders/defaultAssistantSeeder'
import { GxWorks3McpSeeder } from './seeders/gxWorks3McpSeeder'
import { GxWorkspaceMcpSeeder } from './seeders/gxWorkspaceMcpSeeder'
import { MiniAppSeeder } from './seeders/miniAppSeeder'
import { MitsubishiAssistantSeeder } from './seeders/mitsubishiAssistantSeeder'
import { PreferenceSeeder } from './seeders/preferenceSeeder'
import { PresetProviderSeeder } from './seeders/presetProviderSeeder'
import { TiaAssistantSeeder } from './seeders/tiaAssistantSeeder'
import { TiaMcpSeeder } from './seeders/tiaMcpSeeder'
import { TiaWorkspaceMcpSeeder } from './seeders/tiaWorkspaceMcpSeeder'
import { TranslateLanguageSeeder } from './seeders/translateLanguageSeeder'

/**
 * All seeders in execution order.
 *
 * Keep CherryAiDefaultModelSeeder before DefaultAssistantSeeder because the
 * seeded assistant references the CherryAI default model (FK to user_model).
 *
 * To add a new seeder: create an ISeeder class, add it to this array.
 * No changes to DbService needed.
 */
export const seeders: ISeeder[] = [
  new CherryAiDefaultModelSeeder(),
  new CherryAssistantSeeder(),
  new DefaultAssistantSeeder(),
  new PreferenceSeeder(),
  new TranslateLanguageSeeder(),
  new PresetProviderSeeder(),
  new MiniAppSeeder(),
  new TiaMcpSeeder(),
  // Must run after TiaMcpSeeder and before TiaAssistantSeeder: the assistant
  // seeder binds the factory assistant to both seeded MCP server rows.
  new TiaWorkspaceMcpSeeder(),
  // Must run after TiaMcpSeeder: it binds the assistant to the seeded MCP server row.
  new TiaAssistantSeeder(),
  // GX (Mitsubishi) chain mirrors the TIA order: both MCP servers must exist
  // before the assistant seeder binds them. Windows-gated inside each seeder.
  new GxWorks3McpSeeder(),
  new GxWorkspaceMcpSeeder(),
  new MitsubishiAssistantSeeder()
]
