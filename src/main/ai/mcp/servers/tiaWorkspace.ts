import { application } from '@application'
import { loggerService } from '@logger'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

import { isBinaryFile } from './filesystem/types'

const logger = loggerService.withContext('McpServer:TiaWorkspace')

const DEFAULT_READ_LIMIT = 2000
const MAX_READ_BYTES = 2 * 1024 * 1024
const MAX_LIST_ENTRIES = 500
const MAX_NOTE_BYTES = 512 * 1024
const MAX_NOTE_NAME_LENGTH = 100

/**
 * Whitespace/formatting contract for tool results: handlers return plain-text
 * content blocks (like the filesystem server), never structured payloads, so
 * the TIA assistant can quote lines directly in its answers.
 */

function expandHome(filepath: string): string {
  if (filepath.startsWith('~/') || filepath === '~') {
    return path.join(os.homedir(), filepath.slice(1))
  }
  return filepath
}

function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  const target = normalizeForCompare(targetPath)
  const root = normalizeForCompare(rootPath)
  if (target === root) {
    return true
  }
  const relative = path.relative(root, target)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/**
 * Resolve symlinks for the deepest existing ancestor so a junction/symlink
 * cannot smuggle a path out of the whitelist (same defense as the filesystem
 * server's validatePath).
 */
async function resolveRealOrNearestExisting(targetPath: string): Promise<string> {
  try {
    return path.normalize(await fs.realpath(targetPath))
  } catch {
    let current = path.dirname(targetPath)
    while (true) {
      try {
        const realCurrent = await fs.realpath(current)
        return path.normalize(path.join(realCurrent, path.relative(current, targetPath)))
      } catch {
        const parent = path.dirname(current)
        if (parent === current) {
          return path.normalize(targetPath)
        }
        current = parent
      }
    }
  }
}

interface DirEntryView {
  name: string
  type: 'file' | 'directory'
  size?: number
  modified?: string
}

export class TiaWorkspaceServer {
  public server: Server
  /** Always-allowed root: per-project session notes (feature.tia.workspace). */
  private readonly notesDir: string
  /** Extra whitelisted roots (from the server row env TIA_EXTRA_ROOTS, ';'-separated). */
  private readonly roots: string[]

  constructor(extraRoots?: string) {
    this.notesDir = application.getPath('feature.tia.workspace')
    const candidates = [this.notesDir]
    for (const raw of (extraRoots ?? '').split(';')) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const expanded = expandHome(trimmed)
      candidates.push(path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(this.notesDir, expanded))
    }
    const unique = new Map<string, string>()
    for (const candidate of candidates) {
      unique.set(normalizeForCompare(candidate), candidate)
    }
    this.roots = [...unique.values()]

    logger.info(`TiaWorkspace MCP roots: ${this.roots.join(' ; ')}`)

    this.server = new Server(
      {
        name: 'tia-workspace-server',
        version: '1.0.0'
      },
      {
        capabilities: {
          tools: {}
        }
      }
    )

    this.registerHandlers()
  }

  private registerHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [readTextFileTool, listDirTool, readProjectNoteTool, writeProjectNoteTool]
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params
      try {
        switch (name) {
          case 'read_text_file':
            return await this.readTextFile((args ?? {}) as Record<string, unknown>)
          case 'list_dir':
            return await this.listDir((args ?? {}) as Record<string, unknown>)
          case 'read_project_note':
            return await this.readProjectNote((args ?? {}) as Record<string, unknown>)
          case 'write_project_note':
            return await this.writeProjectNote((args ?? {}) as Record<string, unknown>)
          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(`Tool error: ${name}`, { error: message })
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true as const
        }
      }
    })
  }

  /** Whitelist check shared by the filesystem-reading tools. */
  private async validateAllowedPath(requested: string): Promise<string> {
    const expanded = expandHome(requested.trim())
    const absolute = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(this.notesDir, expanded)
    const resolved = await resolveRealOrNearestExisting(absolute)
    for (const root of this.roots) {
      if (isWithinRoot(resolved, root)) {
        return resolved
      }
    }
    throw new Error(
      `Access denied: "${requested}" 不在允许的根目录白名单内。允许的根目录：${this.roots.join(' ; ')}。` +
        `如需读取其他目录，请让用户在 MCP 设置中该服务器的 env.TIA_EXTRA_ROOTS 里追加（多个目录用英文分号分隔）。`
    )
  }

  private text(text: string) {
    return { content: [{ type: 'text' as const, text }] }
  }

  private async readTextFile(args: Record<string, unknown>) {
    const requested = typeof args.path === 'string' ? args.path : ''
    if (!requested.trim()) {
      throw new Error("'path' is required")
    }
    const validPath = await this.validateAllowedPath(requested)

    const stats = await fs.stat(validPath).catch(() => null)
    if (!stats || !stats.isFile()) {
      throw new Error(`File not found (or not a file): ${requested}`)
    }
    if (stats.size > MAX_READ_BYTES) {
      throw new Error(
        `File too large to read at once (${stats.size} bytes, limit ${MAX_READ_BYTES}). ` +
          `请让 TiaMcpServer 导出单个块文件，或对该文件分段处理。`
      )
    }
    if (await isBinaryFile(validPath)) {
      throw new Error(`Cannot read binary file: ${requested}`)
    }

    const content = await fs.readFile(validPath, 'utf-8')
    const lines = content.split('\n')
    const offset = Math.max(1, typeof args.offset === 'number' ? Math.floor(args.offset) : 1)
    const limit = Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : DEFAULT_READ_LIMIT)
    if (offset > lines.length) {
      throw new Error(`Invalid offset: ${offset}. File has ${lines.length} lines.`)
    }
    const selected = lines.slice(offset - 1, offset - 1 + limit)

    const output: string[] = [`File: ${validPath}`]
    if (offset > 1 || limit < lines.length) {
      output.push(`Lines ${offset} to ${Math.min(offset - 1 + limit, lines.length)} of ${lines.length}`)
    }
    output.push('')
    if (lines.length === 1 && lines[0] === '') {
      output.push('(empty file)')
    }
    selected.forEach((line, index) => {
      output.push(`${(offset + index).toString().padStart(6)}\t${line}`)
    })
    if (offset - 1 + limit < lines.length) {
      output.push('')
      output.push(`(${lines.length - (offset - 1 + limit)} more lines not shown, use offset/limit to page)`)
    }
    return this.text(output.join('\n'))
  }

  private async listDir(args: Record<string, unknown>) {
    const requested = typeof args.path === 'string' ? args.path : ''
    if (!requested.trim()) {
      throw new Error("'path' is required")
    }
    const validPath = await this.validateAllowedPath(requested)

    const stats = await fs.stat(validPath).catch(() => null)
    if (!stats || !stats.isDirectory()) {
      throw new Error(`Directory not found (or not a directory): ${requested}`)
    }

    const dirents = await fs.readdir(validPath, { withFileTypes: true })
    const entries: DirEntryView[] = []
    for (const dirent of dirents.slice(0, MAX_LIST_ENTRIES)) {
      const entry: DirEntryView = {
        name: dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file'
      }
      if (entry.type === 'file') {
        try {
          const entryStats = await fs.stat(path.join(validPath, dirent.name))
          entry.size = entryStats.size
          entry.modified = entryStats.mtime.toISOString()
        } catch {
          // Racy delete between readdir and stat — report without metadata.
        }
      }
      entries.push(entry)
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-Hans-CN')
    })

    const output = [`Dir: ${validPath}`, `Entries: ${dirents.length}${dirents.length > MAX_LIST_ENTRIES ? ` (showing first ${MAX_LIST_ENTRIES})` : ''}`, '']
    for (const entry of entries) {
      const meta =
        entry.type === 'file' && entry.size != null
          ? ` (${entry.size} bytes${entry.modified ? `, ${entry.modified}` : ''})`
          : ''
      output.push(`- ${entry.name}${entry.type === 'directory' ? '/' : ''}${meta}`)
    }
    if (dirents.length === 0) {
      output.push('(empty directory)')
    }
    return this.text(output.join('\n'))
  }

  /**
   * Notes live as `<sanitized project name>.md` directly under notesDir. The
   * sanitizer strips path separators, control chars and leading/trailing dots
   * so the note name can never traverse outside notesDir.
   */
  private notePath(projectNameRaw: string): string {
    const cleaned = projectNameRaw
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .trim()
    if (!cleaned) {
      throw new Error("'project_name' is required (non-empty after sanitization)")
    }
    const name = cleaned.length > MAX_NOTE_NAME_LENGTH ? cleaned.slice(0, MAX_NOTE_NAME_LENGTH) : cleaned
    return path.join(this.notesDir, `${name}.md`)
  }

  private async readProjectNote(args: Record<string, unknown>) {
    const projectName = typeof args.project_name === 'string' ? args.project_name : ''
    if (!projectName.trim()) {
      throw new Error("'project_name' is required")
    }
    const notePath = this.notePath(projectName)
    const content = await fs.readFile(notePath, 'utf-8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (content === null) {
      return this.text(
        `（工程「${projectName.trim()}」暂无笔记——这可能是首次会话。请把它当作新工程处理：先扫描工程上下文，收尾时用 write_project_note 建立笔记。）`
      )
    }
    return this.text(`Note: ${notePath}\n\n${content}`)
  }

  private async writeProjectNote(args: Record<string, unknown>) {
    const projectName = typeof args.project_name === 'string' ? args.project_name : ''
    const content = typeof args.content === 'string' ? args.content : ''
    if (!projectName.trim()) {
      throw new Error("'project_name' is required")
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_NOTE_BYTES) {
      throw new Error(`Note content too large (limit ${MAX_NOTE_BYTES} bytes). 请精炼笔记后重写。`)
    }
    const notePath = this.notePath(projectName)
    await fs.mkdir(this.notesDir, { recursive: true })
    await fs.writeFile(notePath, content, 'utf-8')
    logger.info('Project note written', { notePath, bytes: Buffer.byteLength(content, 'utf-8') })
    return this.text(`已保存工程笔记（覆盖写入）：${notePath}（${Buffer.byteLength(content, 'utf-8')} 字节）`)
  }
}

const readTextFileTool = {
  name: 'read_text_file',
  description:
    '读取白名单目录内的文本文件（TIA 导出的 .s7dcl/.xml/.md 等）。返回带行号的内容，支持 offset/limit 分页。路径必须在白名单根目录内：默认含 TIA 工程目录与工程笔记目录。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '文件的绝对路径（必须在白名单根目录内）' },
      offset: { type: 'number', description: '起始行号（1-based，默认 1）' },
      limit: { type: 'number', description: '读取行数（默认 2000）' }
    },
    required: ['path']
  }
}

const listDirTool = {
  name: 'list_dir',
  description: '列出白名单目录内的条目（目录优先排序，文件附大小与修改时间）。用于浏览 TIA 工程目录或导出目录结构。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: { type: 'string', description: '目录的绝对路径（必须在白名单根目录内）' }
    },
    required: ['path']
  }
}

const readProjectNoteTool = {
  name: 'read_project_note',
  description:
    '读取指定 TIA 工程的跨会话笔记（Connect 后先调用它恢复上下文）。无笔记时返回首次会话提示而非报错。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_name: { type: 'string', description: 'TIA 工程名（笔记文件名由此生成，非法字符自动替换为下划线）' }
    },
    required: ['project_name']
  }
}

const writeProjectNoteTool = {
  name: 'write_project_note',
  description:
    '覆盖写入指定 TIA 工程的跨会话笔记（会话收尾时调用，记录工程结构要点、关键约定、遗留 TODO 与用户偏好）。内容保持精炼。',
  inputSchema: {
    type: 'object' as const,
    properties: {
      project_name: { type: 'string', description: 'TIA 工程名（与 read_project_note 一致）' },
      content: { type: 'string', description: 'Markdown 笔记全文（覆盖写入）' }
    },
    required: ['project_name', 'content']
  }
}
