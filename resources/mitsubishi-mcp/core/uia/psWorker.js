"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PsWorker = exports.PsWorkerUnhealthyError = exports.PsWorkerTimeoutError = void 0;
/**
 * Resident PowerShell UIA worker client (GX Works3 bridge).
 *
 * Spawns `powershell.exe -File <temp script>` running psWorkerScript.ts and
 * speaks NDJSON over stdio. One PowerShell process serves many calls; on
 * crash/timeout the client rejects pending calls and lazily respawns on the
 * next call (spawn latency ≈1s, acceptable for UI-automation pacing).
 *
 * Pure Node stdlib — this file is compiled standalone into
 * resources/mitsubishi-mcp/ (see tsconfig.mitsubishi.json) and must not import
 * electron or project aliases.
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const psWorkerScript_1 = require("./scripts/psWorkerScript");
class PsWorkerTimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PsWorkerTimeoutError';
    }
}
exports.PsWorkerTimeoutError = PsWorkerTimeoutError;
/** Fail-fast after repeated spawn failures (e.g. PowerShell blocked by policy). */
class PsWorkerUnhealthyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PsWorkerUnhealthyError';
    }
}
exports.PsWorkerUnhealthyError = PsWorkerUnhealthyError;
const SCRIPT_TEMP_PATH = node_path_1.default.join(node_os_1.default.tmpdir(), 'ckplcstudio-gx-uia-worker.ps1');
const MAX_STDERR_LINES = 20;
const MAX_CONSECUTIVE_SPAWN_FAILURES = 3;
class PsWorker {
    powershellPath;
    defaultTimeoutMs;
    child = null;
    pending = new Map();
    nextId = 1;
    stdoutBuffer = '';
    stderrLines = [];
    consecutiveSpawnFailures = 0;
    stopped = false;
    constructor(options = {}) {
        this.powershellPath = options.powershellPath ?? 'powershell.exe';
        this.defaultTimeoutMs = options.defaultTimeoutMs ?? 20_000;
    }
    isAlive() {
        return this.child !== null && this.child.exitCode === null;
    }
    /** Send one op and await its correlated response. */
    async call(op, params, timeoutMs) {
        if (this.stopped) {
            throw new Error('PS worker has been stopped');
        }
        if (this.consecutiveSpawnFailures >= MAX_CONSECUTIVE_SPAWN_FAILURES) {
            throw new PsWorkerUnhealthyError(`PS worker failed to start ${this.consecutiveSpawnFailures} times in a row; last stderr: ${this.stderrTail()}`);
        }
        const child = this.isAlive() ? this.child : this.spawnWorker();
        if (!child) {
            throw new PsWorkerUnhealthyError('PS worker could not be spawned');
        }
        const id = this.nextId++;
        const timeout = timeoutMs ?? this.defaultTimeoutMs;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(String(id));
                // A wedged UIA call blocks the script's read loop — kill so the next
                // call lazily respawns a clean worker.
                try {
                    child.kill();
                }
                catch {
                    /* already dead */
                }
                reject(new PsWorkerTimeoutError(`op "${op}" timed out after ${timeout}ms; worker killed`));
            }, timeout);
            this.pending.set(String(id), { resolve: resolve, reject, timer });
            const line = JSON.stringify({ id, op, params: params ?? {} }) + '\n';
            try {
                child.stdin.write(line);
            }
            catch (err) {
                this.pending.delete(String(id));
                clearTimeout(timer);
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    }
    /** Reject pendings and terminate the child (idempotent). */
    stop() {
        this.stopped = true;
        this.failPending('PS worker stopped');
        const child = this.child;
        this.child = null;
        if (child) {
            try {
                child.kill();
            }
            catch {
                /* already dead */
            }
        }
    }
    stderrTail() {
        return this.stderrLines.slice(-5).join(' | ') || '(no stderr captured)';
    }
    spawnWorker() {
        try {
            node_fs_1.default.writeFileSync(SCRIPT_TEMP_PATH, psWorkerScript_1.PS_WORKER_SCRIPT, 'utf8');
        }
        catch (err) {
            this.consecutiveSpawnFailures++;
            throw new PsWorkerUnhealthyError(`failed to materialize worker script at ${SCRIPT_TEMP_PATH}: ${err instanceof Error ? err.message : String(err)}`);
        }
        const child = (0, node_child_process_1.spawn)(this.powershellPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT_TEMP_PATH], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.child = child;
        child.on('error', (err) => {
            // Spawn failures (ENOENT, EACCES) surface here.
            if (this.child === child)
                this.child = null;
            this.consecutiveSpawnFailures++;
            this.failPending(`PS worker spawn failed: ${err.message}`);
        });
        child.stdin.on('error', () => {
            /* EPIPE when the worker dies mid-write; pending calls are rejected on exit */
        });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            this.stdoutBuffer += chunk;
            let idx = this.stdoutBuffer.indexOf('\n');
            while (idx >= 0) {
                const line = this.stdoutBuffer.slice(0, idx).trim();
                this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
                if (line.length > 0)
                    this.handleLine(line);
                idx = this.stdoutBuffer.indexOf('\n');
            }
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            for (const line of chunk.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length > 0) {
                    this.stderrLines.push(trimmed);
                    if (this.stderrLines.length > MAX_STDERR_LINES)
                        this.stderrLines.shift();
                }
            }
        });
        child.on('exit', (code) => {
            if (this.child === child)
                this.child = null;
            this.failPending(`PS worker exited unexpectedly (code ${code ?? 'null'}); stderr: ${this.stderrTail()}`);
        });
        return child;
    }
    handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        }
        catch {
            // Stray non-JSON output (e.g. profile noise) — keep for diagnostics.
            this.stderrLines.push(`stdout(non-json): ${line}`);
            if (this.stderrLines.length > MAX_STDERR_LINES)
                this.stderrLines.shift();
            return;
        }
        if (msg.id === null || msg.id === undefined)
            return;
        const pending = this.pending.get(String(msg.id));
        if (!pending)
            return;
        this.pending.delete(String(msg.id));
        clearTimeout(pending.timer);
        this.consecutiveSpawnFailures = 0;
        if (msg.ok) {
            pending.resolve(msg.result);
        }
        else {
            pending.reject(new Error(msg.error || 'PS worker reported an error without a message'));
        }
    }
    failPending(message) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error(message));
        }
        this.pending.clear();
    }
}
exports.PsWorker = PsWorker;
