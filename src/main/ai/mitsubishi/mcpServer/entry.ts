/**
 * GX Works stdio MCP bridge — process entry point.
 *
 * Runs under the app's own Electron binary in Node mode
 * (ELECTRON_RUN_AS_NODE=1, see gxWorks3McpSeeder). Implements the MCP stdio
 * transport by hand (newline-delimited JSON-RPC 2.0) — zero dependencies so
 * the file tree compiles standalone via `pnpm mitsubishi:build` into
 * resources/mitsubishi-mcp/mcpServer/entry.js.
 *
 * One bridge serves both generations (GX Works3 default, GX Works2 via the
 * per-tool `target` argument).
 *
 * Handshake: initialize → notifications/initialized → tools/list → tools/call.
 */
import readline from 'node:readline'

import { PsWorker } from '../core/uia/psWorker'
import { TOOLS, callTool, type ToolCallResult } from './tools'

const SERVER_NAME = 'gx-works-bridge'
const SERVER_VERSION = '0.1.0'
const PROTOCOL_VERSION = '2024-11-05'

interface RpcRequest {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

const worker = new PsWorker()

function log(message: string): void {
  // stderr is protocol-safe (never parsed by the client as JSON-RPC).
  process.stderr.write(`[gx-works-bridge] ${message}\n`)
}

function send(message: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function respond(id: number | string, result: unknown): void {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleToolCall(params: Record<string, unknown>): Promise<ToolCallResult> {
  const name = typeof params.name === 'string' ? params.name : ''
  const args =
    params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {}
  return callTool(worker, name, args)
}

async function dispatch(req: RpcRequest): Promise<void> {
  const id = req.id
  if (id === null || id === undefined) {
    // Notifications never get a response.
    return
  }
  switch (req.method) {
    case 'initialize':
      respond(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      })
      return
    case 'ping':
      respond(id, {})
      return
    case 'tools/list':
      respond(id, { tools: TOOLS })
      return
    case 'tools/call': {
      try {
        const result = await handleToolCall(req.params ?? {})
        respond(id, result)
      } catch (err) {
        // callTool already converts tool errors; reaching here means a bug.
        log(`tools/call crashed: ${err instanceof Error ? err.stack : String(err)}`)
        respond(id, {
          content: [{ type: 'text', text: `internal error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true
        })
      }
      return
    }
    default:
      respondError(id, -32601, `method not found: ${req.method}`)
  }
}

function onLine(line: string): void {
  const trimmed = line.trim()
  if (trimmed.length === 0) return
  let req: RpcRequest
  try {
    req = JSON.parse(trimmed) as RpcRequest
  } catch {
    // Parse errors on the wire respond with id=null per JSON-RPC 2.0.
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  void dispatch(req).catch((err) => {
    log(`dispatch failed: ${err instanceof Error ? err.stack : String(err)}`)
    if (req.id !== null && req.id !== undefined) {
      respondError(req.id, -32603, 'internal error')
    }
  })
}

function shutdown(): void {
  worker.stop()
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', onLine)
rl.on('close', shutdown)
process.on('exit', shutdown)
process.on('SIGINT', () => {
  shutdown()
  process.exit(0)
})

log(`started (${SERVER_NAME} v${SERVER_VERSION}, ${TOOLS.length} tools)`)
