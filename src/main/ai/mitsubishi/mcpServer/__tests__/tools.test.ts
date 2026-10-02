/**
 * callTool 分流单测：works2 零回归 pin 先行（无/显式 target=works2 原路
 * simWorker 且参数形状不变），works3 走注入的 fake Simulator3Gateway（vi.mock
 * 模块级 mock，不碰真实网络），覆盖通道建/复用/删、未连接守卫、无效 target、
 * gx_sim_start 不进 SLMP 通道、closeAllWorks3Channels 全量释放。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { callTool, closeAllWorks3Channels, type ToolCallResult } from '../tools'
import type { PsWorkerLike } from '../../core/uia/windowOps'

interface FakeGateway {
  connect: ReturnType<typeof vi.fn>
  readDevices: ReturnType<typeof vi.fn>
  writeItems: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}

const { fakeGateways, createSimulator3GatewayMock } = vi.hoisted(() => {
  const fakeGateways: FakeGateway[] = []
  const createSimulator3GatewayMock = vi.fn((): FakeGateway => {
    const gateway: FakeGateway = {
      // 默认按真实 gateway 的返回形状回值（connect 回显 station）
      connect: vi.fn((station: number) =>
        Promise.resolve({ station, host: '127.0.0.1', port: 5511, alive: true })
      ),
      readDevices: vi.fn(() => Promise.resolve({ results: [] })),
      writeItems: vi.fn(() => Promise.resolve({ written: 0 })),
      disconnect: vi.fn((station: number) => Promise.resolve({ station, closed: true })),
      dispose: vi.fn()
    }
    fakeGateways.push(gateway)
    return gateway
  })
  return { fakeGateways, createSimulator3GatewayMock }
})

vi.mock('../../core/sim/simulator3', () => ({ createSimulator3Gateway: createSimulator3GatewayMock }))

/** 记录调用的 fake worker（UIA 与 simWorker 共用形状） */
class FakeWorker implements PsWorkerLike {
  calls: Array<{ op: string; params?: Record<string, unknown> }> = []
  async call<T = unknown>(op: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, params })
    return {} as T
  }
}

function resultOf(res: ToolCallResult): { isError?: boolean; payload: unknown } {
  return { isError: res.isError, payload: JSON.parse(res.content[0].text) }
}

beforeEach(() => {
  fakeGateways.length = 0
})

describe('works2 零回归（缺省/显式 target=works2 原路 simWorker）', () => {
  it('gx_sim_connect 无 target → simWorker.call("open", {station})，UIA worker 零调用', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const res = await callTool(ui, 'gx_sim_connect', { station: 3 }, sim, new Map())
    expect(sim.calls).toEqual([{ op: 'open', params: { station: 3 } }])
    expect(ui.calls).toHaveLength(0)
    expect(createSimulator3GatewayMock).not.toHaveBeenCalled()
    expect(res.isError).toBeUndefined()
  })

  it('gx_sim_read/write/disconnect → simWorker.call("read"/"write"/"close") 参数形状不变', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    await callTool(ui, 'gx_sim_read', { station: 1, devices: ['X0'] }, sim, new Map())
    await callTool(ui, 'gx_sim_write', { station: 1, items: [{ device: 'X0', value: 1 }] }, sim, new Map())
    await callTool(ui, 'gx_sim_disconnect', { station: 1 }, sim, new Map())
    expect(sim.calls).toEqual([
      { op: 'read', params: { station: 1, devices: ['X0'] } },
      { op: 'write', params: { station: 1, items: [{ device: 'X0', value: 1 }] } },
      { op: 'close', params: { station: 1 } }
    ])
  })

  it('显式 target=works2 仍走 simWorker', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    await callTool(ui, 'gx_sim_connect', { target: 'works2', station: 2 }, sim, new Map())
    expect(sim.calls).toEqual([{ op: 'open', params: { station: 2 } }])
    expect(createSimulator3GatewayMock).not.toHaveBeenCalled()
  })
})

describe('works3 SLMP 分流（target=works3 → Simulator3Gateway）', () => {
  it('connect 惰性建通道并调 gateway.connect(station)，simWorker/UIA 零调用', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const channels = new Map<number, FakeGateway>()
    const res = await callTool(ui, 'gx_sim_connect', { target: 'works3', station: 1 }, sim, channels)
    expect(fakeGateways).toHaveLength(1)
    expect(fakeGateways[0].connect).toHaveBeenCalledWith(1)
    expect(sim.calls).toHaveLength(0)
    expect(ui.calls).toHaveLength(0)
    expect(resultOf(res).payload).toEqual({ station: 1, host: '127.0.0.1', port: 5511, alive: true })
  })

  it('read/write 复用同站通道（不新建 gateway），参数透传', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const channels = new Map<number, FakeGateway>()
    await callTool(ui, 'gx_sim_connect', { target: 'works3', station: 1 }, sim, channels)
    const gw = fakeGateways[0]
    gw.readDevices.mockResolvedValue({ results: [{ device: 'X0', value: 1 }] })
    gw.writeItems.mockResolvedValue({ written: 1 })
    await callTool(ui, 'gx_sim_read', { target: 'works3', station: 1, devices: ['X0'] }, sim, channels)
    await callTool(
      ui,
      'gx_sim_write',
      { target: 'works3', station: 1, items: [{ device: 'X0', value: 1 }] },
      sim,
      channels
    )
    expect(fakeGateways).toHaveLength(1)
    expect(gw.readDevices).toHaveBeenCalledWith(1, ['X0'])
    expect(gw.writeItems).toHaveBeenCalledWith(1, [{ device: 'X0', value: 1 }])
  })

  it('disconnect 移除通道；随后 read 报「尚未连接」且 isError', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const channels = new Map<number, FakeGateway>()
    await callTool(ui, 'gx_sim_connect', { target: 'works3', station: 1 }, sim, channels)
    const gw = fakeGateways[0]
    const res = await callTool(ui, 'gx_sim_disconnect', { target: 'works3', station: 1 }, sim, channels)
    expect(gw.disconnect).toHaveBeenCalledWith(1)
    expect(resultOf(res).payload).toEqual({ station: 1, closed: true })
    expect(channels.size).toBe(0)

    const res2 = await callTool(
      ui,
      'gx_sim_read',
      { target: 'works3', station: 1, devices: ['X0'] },
      sim,
      channels
    )
    expect(res2.isError).toBe(true)
    expect(res2.content[0].text).toMatch(/尚未连接 Simulator3/)
  })

  it('同站重复 connect 复用同一 gateway（幂等重建由 gateway 内部处理）', async () => {
    const sim = new FakeWorker()
    const channels = new Map<number, FakeGateway>()
    await callTool(new FakeWorker(), 'gx_sim_connect', { target: 'works3', station: 1 }, sim, channels)
    await callTool(new FakeWorker(), 'gx_sim_connect', { target: 'works3', station: 1 }, sim, channels)
    expect(fakeGateways).toHaveLength(1)
    expect(fakeGateways[0].connect).toHaveBeenCalledTimes(2)
  })

  it('无效 target 报错且不碰 simWorker / gateway', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const res = await callTool(ui, 'gx_sim_connect', { target: 'works4' }, sim, new Map())
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/works2|works3/)
    expect(sim.calls).toHaveLength(0)
    expect(fakeGateways).toHaveLength(0)
  })
})

describe('gx_sim_start 与 closeAllWorks3Channels', () => {
  it('gx_sim_start target=works3 不进 works3 通道也不碰 simWorker（UIA 侧处理）', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    const before = fakeGateways.length
    await callTool(ui, 'gx_sim_start', { target: 'works3' }, sim, new Map())
    expect(sim.calls).toHaveLength(0)
    expect(fakeGateways.length).toBe(before)
  })

  it('closeAllWorks3Channels dispose 全部默认通道并清空', async () => {
    const ui = new FakeWorker()
    const sim = new FakeWorker()
    await callTool(ui, 'gx_sim_connect', { target: 'works3', station: 0 }, sim) // 默认表
    await callTool(ui, 'gx_sim_connect', { target: 'works3', station: 1 }, sim)
    const created = fakeGateways.slice(-2)
    closeAllWorks3Channels()
    expect(created[0].dispose).toHaveBeenCalledTimes(1)
    expect(created[1].dispose).toHaveBeenCalledTimes(1)
    const res = await callTool(ui, 'gx_sim_read', { target: 'works3', station: 0, devices: ['X0'] }, sim)
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/尚未连接 Simulator3/)
  })
})
