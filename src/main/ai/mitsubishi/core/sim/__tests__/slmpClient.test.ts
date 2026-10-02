/**
 * SlmpClient 单测：全部走注入的 fake socket（不碰真实网络）。
 * 覆盖：断帧收齐、分片、粘包截断、connect/exchange 超时、exchange 中断线、
 * 一次性服务端 resolve + 下次透明重连、并发拒绝。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SlmpSocketLike } from '../slmpClient'
import { SlmpClient } from '../slmpClient'

class FakeSocket implements SlmpSocketLike {
  handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  written: Buffer[] = []
  destroyed = false
  ended = false
  connectCalls: Array<{ host: string; port: number }> = []

  constructor(private readonly autoConnect = true) {}

  on(event: 'connect', cb: () => void): void
  on(event: 'data', cb: (chunk: Buffer) => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 实现签名必须宽松以兼容全部重载
  on(event: string, cb: (...args: any[]) => void): void {
    ;(this.handlers[event] ??= []).push(cb)
  }

  removeListener(event: 'error', cb: (err: Error) => void): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 实现签名必须宽松以兼容全部重载
  removeListener(event: string, cb: (...args: any[]) => void): void {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== cb)
  }

  connect(options: { host: string; port: number }): void {
    this.connectCalls.push(options)
    // 模拟本机即连成功（同步 emit——fake timers 会 mock queueMicrotask/nextTick）。
    // autoConnect=false 用于 connect 超时用例。
    if (this.autoConnect) this.emitConnect()
  }

  write(data: Uint8Array): void {
    this.written.push(Buffer.from(data))
  }

  end(): void {
    this.ended = true
  }

  destroy(): void {
    this.destroyed = true
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args)
  }

  emitConnect(): void {
    this.emit('connect')
  }

  emitData(bytes: number[] | Uint8Array): void {
    this.emit('data', Buffer.from(bytes))
  }

  emitClose(): void {
    this.emit('close')
  }
}

/** D000H 子头 + 访问路径 + 长度 + 结束代码 0000 + 数据区（纯 Uint8Array，避免 Buffer 池干扰 toEqual） */
function respFrame(payload: number[]): Uint8Array {
  const declared = 2 + payload.length
  return Uint8Array.from([
    0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, declared & 0xff, (declared >> 8) & 0xff, 0x00, 0x00,
    ...payload
  ])
}

const REQ = new Uint8Array([0x50, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, 0x0c, 0x00, 0x00, 0x00, 0x01, 0x04, 0x00, 0x00])

describe('SlmpClient', () => {
  let socket: FakeSocket
  let sockets: FakeSocket[]
  let client: SlmpClient

  beforeEach(() => {
    vi.useFakeTimers()
    socket = new FakeSocket()
    sockets = [socket]
    client = new SlmpClient({ socketFactory: () => sockets.shift() ?? new FakeSocket() })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exchange 发出请求字节并按长度字段断帧收齐响应', async () => {
    await client.connect()
    const p = client.exchange(REQ)
    expect(socket.written[0]).toEqual(Buffer.from(REQ))
    socket.emitData(respFrame([0x34, 0x12]))
    await expect(p).resolves.toEqual(respFrame([0x34, 0x12]))
  })

  it('响应分片到达（多次 data 事件）也能收齐', async () => {
    await client.connect()
    socket.emitConnect()
    const p = client.exchange(REQ)
    const full = respFrame([0x01, 0x02, 0x03, 0x04])
    socket.emitData(full.subarray(0, 5))
    socket.emitData(full.subarray(5))
    await expect(p).resolves.toEqual(full)
  })

  it('响应后紧跟的粘包垃圾字节被截断，resolve 帧恰为声明长度', async () => {
    await client.connect()
    socket.emitConnect()
    const p = client.exchange(REQ)
    socket.emitData(Buffer.concat([respFrame([0xaa]), Buffer.from([0xde, 0xad])]))
    await expect(p).resolves.toEqual(respFrame([0xaa]))
  })

  it('connect 超时抛中文错误', async () => {
    sockets.unshift(new FakeSocket(false)) // 永不触发 connect 事件的 socket
    const p = client.connect()
    const assertion = expect(p).rejects.toThrow(/超时/)
    await vi.advanceTimersByTimeAsync(3000)
    await assertion
  })

  it('exchange 超时 destroy socket 并拒绝', async () => {
    await client.connect()
    socket.emitConnect()
    const p = client.exchange(REQ)
    const assertion = expect(p).rejects.toThrow(/响应超时/)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    expect(socket.destroyed).toBe(true)
  })

  it('exchange 进行中收到 close → 拒绝且 connected=false', async () => {
    await client.connect()
    socket.emitConnect()
    const p = client.exchange(REQ)
    const assertion = expect(p).rejects.toThrow(/连接已断开/)
    socket.emitClose()
    await assertion
    expect(client.connected).toBe(false)
  })

  it('一次性服务端（响应后立即 close）不破坏当次 resolve，下一次 exchange 透明重连', async () => {
    await client.connect()
    socket.emitConnect()
    const p = client.exchange(REQ)
    socket.emitData(respFrame([0x01]))
    socket.emitClose()
    await expect(p).resolves.toEqual(respFrame([0x01]))

    const socket2 = new FakeSocket()
    sockets.push(socket2)
    await client.connect() // 断线后透明重连（新建 socket 并完成监听注册）
    const p2 = client.exchange(REQ)
    socket2.emitData(respFrame([0x02]))
    await expect(p2).resolves.toEqual(respFrame([0x02]))
    expect(socket2.connectCalls).toEqual([{ host: '127.0.0.1', port: 5511 }])
  })

  it('并发 exchange 直接拒绝', async () => {
    await client.connect()
    socket.emitConnect()
    void client.exchange(REQ)
    await expect(client.exchange(REQ)).rejects.toThrow(/并发|尚未完成/)
  })
})
