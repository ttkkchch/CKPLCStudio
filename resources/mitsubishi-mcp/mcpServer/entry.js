"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const node_readline_1 = __importDefault(require("node:readline"));
const psWorker_1 = require("../core/uia/psWorker");
const tools_1 = require("./tools");
const SERVER_NAME = 'gx-works-bridge';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const worker = new psWorker_1.PsWorker();
function log(message) {
    // stderr is protocol-safe (never parsed by the client as JSON-RPC).
    process.stderr.write(`[gx-works-bridge] ${message}\n`);
}
function send(message) {
    process.stdout.write(JSON.stringify(message) + '\n');
}
function respond(id, result) {
    send({ jsonrpc: '2.0', id, result });
}
function respondError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}
async function handleToolCall(params) {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? params.arguments
        : {};
    return (0, tools_1.callTool)(worker, name, args);
}
async function dispatch(req) {
    const id = req.id;
    if (id === null || id === undefined) {
        // Notifications never get a response.
        return;
    }
    switch (req.method) {
        case 'initialize':
            respond(id, {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
            });
            return;
        case 'ping':
            respond(id, {});
            return;
        case 'tools/list':
            respond(id, { tools: tools_1.TOOLS });
            return;
        case 'tools/call': {
            try {
                const result = await handleToolCall(req.params ?? {});
                respond(id, result);
            }
            catch (err) {
                // callTool already converts tool errors; reaching here means a bug.
                log(`tools/call crashed: ${err instanceof Error ? err.stack : String(err)}`);
                respond(id, {
                    content: [{ type: 'text', text: `internal error: ${err instanceof Error ? err.message : String(err)}` }],
                    isError: true
                });
            }
            return;
        }
        default:
            respondError(id, -32601, `method not found: ${req.method}`);
    }
}
function onLine(line) {
    const trimmed = line.trim();
    if (trimmed.length === 0)
        return;
    let req;
    try {
        req = JSON.parse(trimmed);
    }
    catch {
        // Parse errors on the wire respond with id=null per JSON-RPC 2.0.
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        return;
    }
    void dispatch(req).catch((err) => {
        log(`dispatch failed: ${err instanceof Error ? err.stack : String(err)}`);
        if (req.id !== null && req.id !== undefined) {
            respondError(req.id, -32603, 'internal error');
        }
    });
}
function shutdown() {
    worker.stop();
}
const rl = node_readline_1.default.createInterface({ input: process.stdin, terminal: false });
rl.on('line', onLine);
rl.on('close', shutdown);
process.on('exit', shutdown);
process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
});
log(`started (${SERVER_NAME} v${SERVER_VERSION}, ${tools_1.TOOLS.length} tools)`);
