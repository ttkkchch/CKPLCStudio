import { application } from '@application'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory'
import fs from 'fs/promises'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TiaWorkspaceServer } from '../tiaWorkspace'

type TextResult = { content: Array<{ type: string; text: string }>; isError?: boolean }

async function startServer(extraRoots?: string): Promise<Client> {
  const server = new TiaWorkspaceServer(extraRoots)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await Promise.all([server.server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as TextResult
  return result.content.map((block) => block.text).join('\n')
}

describe('TiaWorkspace MCP server', () => {
  const tempRoot = path.join(process.cwd(), '.context', 'vitest-temp')
  let notesDir = ''
  let tiaRoot = ''
  let client: Client | null = null

  async function createTempDir(prefix: string) {
    await fs.mkdir(tempRoot, { recursive: true })
    return fs.mkdtemp(path.join(tempRoot, prefix))
  }

  beforeEach(async () => {
    notesDir = await createTempDir('tia-notes-')
    tiaRoot = await createTempDir('tia-root-')
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

  it('exposes exactly the four workspace tools', async () => {
    client = await startServer('F:\\TIA_Projects')
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'list_dir',
      'read_project_note',
      'read_text_file',
      'write_project_note'
    ])
  })

  it('reads a text file inside the extra root with line numbers and paging', async () => {
    const file = path.join(tiaRoot, 'FB_Motor.s7dcl')
    await fs.writeFile(file, Array.from({ length: 30 }, (_, i) => `LINE ${i + 1}`).join('\n'), 'utf-8')

    client = await startServer(tiaRoot)

    const full = await callText(client, 'read_text_file', { path: file })
    expect(full).toContain('LINE 1')
    expect(full).toContain('LINE 30')

    const paged = await callText(client, 'read_text_file', { path: file, offset: 28, limit: 2 })
    expect(paged).toContain('Lines 28 to 29 of 30')
    expect(paged).toContain('LINE 28')
    expect(paged).toContain('LINE 29')
    expect(paged).not.toContain('LINE 30\n')
    expect(paged).toContain('more lines not shown')
  })

  it('rejects paths outside the whitelist (traversal and other drives)', async () => {
    const secret = path.join(path.dirname(tiaRoot), 'secret.txt')
    await fs.writeFile(secret, 'top-secret', 'utf-8')

    client = await startServer(tiaRoot)

    const outside = await callText(client, 'read_text_file', { path: secret })
    expect(outside).toContain('Access denied')

    const traversal = await callText(client, 'read_text_file', { path: path.join(tiaRoot, '..', 'secret.txt') })
    expect(traversal).toContain('Access denied')
  })

  it('lists directories (directories first, file metadata) inside the whitelist', async () => {
    await fs.mkdir(path.join(tiaRoot, 'subdir'))
    await fs.writeFile(path.join(tiaRoot, 'block.scl'), 'FUNCTION_BLOCK', 'utf-8')

    client = await startServer(tiaRoot)
    const text = await callText(client, 'list_dir', { path: tiaRoot })

    expect(text).toContain('subdir/')
    expect(text).toContain('block.scl')
    expect(text.indexOf('subdir/')).toBeLessThan(text.indexOf('block.scl'))
  })

  it('writes and reads per-project notes inside the notes dir', async () => {
    client = await startServer()

    const missing = await callText(client, 'read_project_note', { project_name: 'ArWtPLC' })
    expect(missing).toContain('暂无笔记')

    const written = await callText(client, 'write_project_note', {
      project_name: 'ArWtPLC',
      content: '# ArWtPLC\n\n- FB1 已重建'
    })
    expect(written).toContain('已保存工程笔记')

    const noteFile = path.join(notesDir, 'ArWtPLC.md')
    await expect(fs.readFile(noteFile, 'utf-8')).resolves.toContain('FB1 已重建')

    const read = await callText(client, 'read_project_note', { project_name: 'ArWtPLC' })
    expect(read).toContain('Note:')
    expect(read).toContain('FB1 已重建')
  })

  it('sanitizes hostile project names so notes cannot escape the notes dir', async () => {
    client = await startServer()

    const hostile = '..\\..\\..\\Windows\\evil'
    const written = await callText(client, 'write_project_note', { project_name: hostile, content: 'x' })
    expect(written).toContain('已保存工程笔记')

    const escaped = path.join(notesDir, 'Windows', 'evil.md')
    await expect(fs.access(escaped)).rejects.toThrow()

    const entries = await fs.readdir(notesDir)
    expect(entries).toEqual([expect.stringMatching(/\.md$/)])
    expect(entries[0]).not.toContain('\\')
    expect(entries[0]).not.toContain('/')
  })

  it('rejects empty project names', async () => {
    client = await startServer()

    const result = await callText(client, 'write_project_note', { project_name: '...', content: 'x' })
    expect(result).toContain('Error')
  })
})
