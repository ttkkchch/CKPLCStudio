import { application } from '@application'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TiaWorkspaceServer } from '../tiaWorkspace'

/**
 * End-to-end check against the REAL TIA export files on this machine
 * (F:\TIA_Projects). Proves the exact handler code that ships in the app can
 * read an actual TiaMcpServer export through the whitelist. Skips elsewhere.
 */

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

const REAL_ROOT = 'F:\\TIA_Projects'
const EXPORT_SOURCES = path.join(REAL_ROOT, '_export_src')
const TARGET = path.join(EXPORT_SOURCES, 'modbus485通信.s7dcl')

const available = await fs
  .access(TARGET)
  .then(() => true)
  .catch(() => false)

describe.skipIf(!available)('TiaWorkspace server e2e (real TIA exports)', () => {
  const tempRoot = path.join(process.cwd(), '.context', 'vitest-temp')
  let notesDir = ''
  let client: Client | null = null

  async function startServer() {
    const server = new TiaWorkspaceServer(REAL_ROOT)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'e2e-client', version: '1.0.0' })
    await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)])
  }

  async function callText(name: string, args: Record<string, unknown>): Promise<string> {
    const result = (await client!.callTool({ name, arguments: args })) as TextResult
    return result.content.map((block) => block.text).join('\n')
  }

  beforeEach(async () => {
    await fs.mkdir(tempRoot, { recursive: true })
    notesDir = await fs.mkdtemp(path.join(tempRoot, 'tia-e2e-'))
    vi.mocked(application.getPath).mockImplementation((key) =>
      key === 'feature.tia.workspace' ? notesDir : `/mock/${key}`
    )
  })

  afterEach(async () => {
    client?.close()
    client = null
    vi.restoreAllMocks()
    vi.mocked(application.getPath).mockReset()
    await fs.rm(tempRoot, { recursive: true, force: true })
  })

  it('reads a real exported SCL source through the whitelist', async () => {
    await startServer()

    const text = await callText('read_text_file', { path: TARGET, limit: 30 })
    expect(text).toContain(`File: ${TARGET}`)
    // Real SCL content, not an error path
    expect(text).toMatch(/FUNCTION_BLOCK|ORGANIZATION_BLOCK|FB|SCL/i)

    const full = await callText('read_text_file', { path: TARGET })
    const contentLines = full.split('\n').filter((line) => /^\s*\d+\t/.test(line))
    expect(contentLines.length).toBeGreaterThan(50) // real 8 KB source, fully paged through
  })

  it('lists the real export directory', async () => {
    await startServer()

    const text = await callText('list_dir', { path: EXPORT_SOURCES })
    expect(text).toContain('modbus485通信.s7dcl')
    expect(text).toContain('Main.s7dcl')
  })

  it('reads the real exported DB XML through the whitelist', async () => {
    await startServer()

    const text = await callText('read_text_file', { path: path.join(REAL_ROOT, '_export', 'db14', '能效.xml'), limit: 20 })
    expect(text).toContain('File:')
    expect(text).toMatch(/<|SimaticML|xml/i)
  })
})
