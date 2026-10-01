import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PsWorker, PsWorkerTimeoutError, PsWorkerUnhealthyError } from '../psWorker'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

/** Fake powershell child: stdio emitters + recording stdin. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    write: vi.fn(() => true),
    on: vi.fn(),
    end: vi.fn()
  }
  exitCode: number | null = null
  kill = vi.fn(() => {
    if (this.exitCode === null) this.finish(0)
    return true
  })
  finish(code: number): void {
    this.exitCode = code
    this.emit('exit', code)
  }
}

function makeChild(): FakeChild {
  const child = new FakeChild()
  ;(child.stdout as unknown as { setEncoding: unknown }).setEncoding = vi.fn()
  ;(child.stderr as unknown as { setEncoding: unknown }).setEncoding = vi.fn()
  return child
}

/** Emit a worker response line on the fake child's stdout. */
function respond(child: FakeChild, msg: unknown): void {
  child.stdout.emit('data', JSON.stringify(msg) + '\n')
}

function lastRequestLine(child: FakeChild): { id: number; op: string; params?: Record<string, unknown> } {
  const calls = child.stdin.write.mock.calls as unknown as Array<[string]>
  return JSON.parse(calls[calls.length - 1][0])
}

describe('PsWorker', () => {
  let child: FakeChild

  beforeEach(() => {
    child = makeChild()
    spawnMock.mockReset()
    spawnMock.mockReturnValue(child)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends an NDJSON request and resolves with the correlated result', async () => {
    const w = new PsWorker()
    const promise = w.call<{ pid: number }>('ping', { x: 1 })
    const req = lastRequestLine(child)
    expect(req.op).toBe('ping')
    expect(req.params).toEqual({ x: 1 })
    respond(child, { id: req.id, ok: true, result: { pid: 5 } })
    await expect(promise).resolves.toEqual({ pid: 5 })
    w.stop()
  })

  it('rejects with the script error message when ok is false', async () => {
    const w = new PsWorker()
    const promise = w.call('clipboardRead')
    const req = lastRequestLine(child)
    respond(child, { id: req.id, ok: false, error: 'clipboard busy' })
    await expect(promise).rejects.toThrow('clipboard busy')
    w.stop()
  })

  it('times out, kills the worker and respawns on the next call', async () => {
    const w = new PsWorker({ defaultTimeoutMs: 25 })
    const first = w.call('findWindow')
    await expect(first).rejects.toBeInstanceOf(PsWorkerTimeoutError)
    expect(child.kill).toHaveBeenCalled()

    const second = makeChild()
    spawnMock.mockReturnValue(second)
    const p2 = w.call('ping')
    expect(spawnMock).toHaveBeenCalledTimes(2)
    const req2 = lastRequestLine(second)
    respond(second, { id: req2.id, ok: true, result: { pid: 7 } })
    await expect(p2).resolves.toEqual({ pid: 7 })
    w.stop()
  })

  it('rejects pending calls when the worker exits and lazily respawns', async () => {
    const w = new PsWorker()
    const promise = w.call('ping')
    child.finish(1)
    await expect(promise).rejects.toThrow(/exited unexpectedly/)

    const second = makeChild()
    spawnMock.mockReturnValue(second)
    const p2 = w.call('ping')
    const req = lastRequestLine(second)
    respond(second, { id: req.id, ok: true, result: { ok: 1 } })
    await expect(p2).resolves.toEqual({ ok: 1 })
    w.stop()
  })

  it('stop() rejects pendings, kills the child and refuses further calls', async () => {
    const w = new PsWorker()
    const promise = w.call('ping')
    w.stop()
    await expect(promise).rejects.toThrow('stopped')
    expect(child.kill).toHaveBeenCalled()
    await expect(w.call('ping')).rejects.toThrow('stopped')
  })

  it('fails fast after repeated spawn errors', async () => {
    const w = new PsWorker()
    for (let i = 0; i < 3; i++) {
      const failing = makeChild()
      spawnMock.mockReturnValue(failing)
      const p = w.call('ping')
      failing.emit('error', new Error('ENOENT'))
      await expect(p).rejects.toThrow(/spawn failed/)
    }
    await expect(w.call('ping')).rejects.toBeInstanceOf(PsWorkerUnhealthyError)
    w.stop()
  })

  it('ignores non-JSON stdout noise without breaking the protocol', async () => {
    const w = new PsWorker()
    const promise = w.call('ping')
    child.stdout.emit('data', 'profile noise\n')
    const req = lastRequestLine(child)
    respond(child, { id: req.id, ok: true, result: { fine: true } })
    await expect(promise).resolves.toEqual({ fine: true })
    w.stop()
  })
})
