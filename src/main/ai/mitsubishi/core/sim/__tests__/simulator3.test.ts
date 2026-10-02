/**
 * Simulator3 适配层单测：全部走注入的 fake client（不碰真实网络）。
 * 覆盖：nibble 位读解码、SM0 探针与幂等重建、位/字读语义、位项 1402 合并、
 * 连续/非连续字项 1401 合并、负值归一、值域校验、结束代码转译（0x55/0xC05D）、
 * disconnect 幂等与未连接守卫。
 */
import { describe, expect, it } from 'vitest'

import {
  createSimulator3Gateway,
  decodeSim3BitRead,
  sim3EndCodeError
} from '../simulator3'

/** "50 00 FF" 形式的十六进制串 → 纯 Uint8Array（避免 Buffer 池干扰 toEqual） */
function hex(s: string): Uint8Array {
  return Uint8Array.from(
    s
      .trim()
      .split(/\s+/)
      .map((b) => Number.parseInt(b, 16))
  )
}

/** D000H 响应帧：结束代码可指定（0x55 等异常码用例复用） */
function respFrame(endCode: number, payload: number[]): Uint8Array {
  const declared = 2 + payload.length
  return Uint8Array.from([
    0xd0, 0x00, 0x00, 0xff, 0xff, 0x03, 0x00, declared & 0xff, (declared >> 8) & 0xff,
    endCode & 0xff, (endCode >> 8) & 0xff,
    ...payload
  ])
}

const OK = (payload: number[] = []): Uint8Array => respFrame(0, payload)

/** 记录请求帧、按预置队列回响应的 fake client（结构匹配 Simulator3GatewayOptions.clientFactory） */
class FakeClient {
  frames: Uint8Array[] = []
  responses: Uint8Array[] = []
  connectCalls = 0
  closeCalls = 0
  connected = true

  async connect(): Promise<void> {
    this.connectCalls++
  }

  async exchange(frame: Uint8Array): Promise<Uint8Array> {
    this.frames.push(Uint8Array.from(frame))
    const res = this.responses.shift()
    if (!res) throw new Error('fake client: 无预置响应')
    return res
  }

  close(): void {
    this.closeCalls++
  }
}

function makeGateway(fake = new FakeClient()) {
  return { gateway: createSimulator3Gateway({ clientFactory: () => fake }), fake }
}

describe('decodeSim3BitRead（Simulator3 私有 nibble 位读）', () => {
  it('单点 ON：byte0=0x10 → [1]（偶点取 bit4）', () => {
    expect(decodeSim3BitRead(Uint8Array.from([0x10]), 1)).toEqual([1])
  })

  it('点 0 OFF、点 1 ON：byte0=0x01 → [0,1]（奇点取 bit0）', () => {
    expect(decodeSim3BitRead(Uint8Array.from([0x01]), 2)).toEqual([0, 1])
  })

  it('4 点跨两字节：0x11 0x11 → [1,1,1,1]', () => {
    expect(decodeSim3BitRead(Uint8Array.from([0x11, 0x11]), 4)).toEqual([1, 1, 1, 1])
  })

  it('数据不足（4 点需 2 字节实给 1 字节）抛错', () => {
    expect(() => decodeSim3BitRead(Uint8Array.from([0x00]), 4)).toThrow(/不足/)
  })
})

describe('connect（SM0 探针 + 幂等重建）', () => {
  it('SM0=1 → alive:true，首帧为 SM0 位读（点数 1、子命令 0001、SM 代码 0x91）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await expect(gateway.connect(0)).resolves.toEqual({
      station: 0,
      host: '127.0.0.1',
      port: 5511,
      alive: true
    })
    expect(fake.frames[0]).toEqual(
      hex('50 00 00 FF FF 03 00 0C 00 00 00 01 04 01 00 00 00 00 91 01 00')
    )
  })

  it('SM0 读到 0 → 抛探针异常', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x00]))
    await expect(gateway.connect(0)).rejects.toThrow(/SM0|探针/)
  })

  it('重复 connect 先弃旧连接（close 一次、connect 两次）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    expect(fake.connectCalls).toBe(2)
    expect(fake.closeCalls).toBe(1)
  })
})

describe('readDevices', () => {
  it('位读走 nibble 解码（M0 帧逐字节 pin，0x00 → 0）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10])) // SM0 探针
    await gateway.connect(0)
    fake.responses.push(OK([0x00]))
    const { results } = await gateway.readDevices(0, ['M0'])
    expect(results).toEqual([{ device: 'M0', value: 0 }])
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 0C 00 00 00 01 04 01 00 00 00 00 90 01 00')
    )
  })

  it('字读转有符号 int16（0x8000→−32768、0xFFFF→−1），帧为字读 1401+0000', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK([0x00, 0x80]))
    let r = await gateway.readDevices(0, ['D0'])
    expect(r.results).toEqual([{ device: 'D0', value: -32768 }])
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 0C 00 00 00 01 04 00 00 00 00 00 A8 01 00')
    )
    fake.responses.push(OK([0xff, 0xff]))
    r = await gateway.readDevices(0, ['D0'])
    expect(r.results[0].value).toBe(-1)
  })
})

describe('writeItems', () => {
  it('相邻位项合并一帧 1402 随机写（M0=1/M5=0，帧逐字节 pin）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK())
    await expect(
      gateway.writeItems(0, [
        { device: 'M0', value: 1 },
        { device: 'M5', value: 0 }
      ])
    ).resolves.toEqual({ written: 2 })
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 14 00 00 00 02 14 00 00 02 00 00 00 00 90 01 00 05 00 00 90 00 00')
    )
  })

  it('连续同码字项合并一帧 1401 批量写（D0=0x1234/D1=0x5678）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK())
    await expect(
      gateway.writeItems(0, [
        { device: 'D0', value: 0x1234 },
        { device: 'D1', value: 0x5678 }
      ])
    ).resolves.toEqual({ written: 2 })
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 10 00 00 00 01 14 00 00 00 00 00 A8 02 00 34 12 78 56')
    )
  })

  it('非连续字项分两帧（D0 与 D5 各一帧批量写）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK(), OK())
    await expect(
      gateway.writeItems(0, [
        { device: 'D0', value: 1 },
        { device: 'D5', value: 2 }
      ])
    ).resolves.toEqual({ written: 2 })
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 01 14 00 00 00 00 00 A8 01 00 01 00')
    )
    expect(fake.frames[2]).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 01 14 00 00 05 00 00 A8 01 00 02 00')
    )
  })

  it('负值归一为 u16 小端（−1 → 帧数据区 FF FF）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(OK())
    await gateway.writeItems(0, [{ device: 'D0', value: -1 }])
    expect(fake.frames[1]).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 01 14 00 00 00 00 00 A8 01 00 FF FF')
    )
  })

  it('字值越界（−32769/32768/1.5）抛错且不发帧；位值 2 抛错', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    for (const bad of [-32769, 32768, 1.5]) {
      await expect(gateway.writeItems(0, [{ device: 'D0', value: bad }])).rejects.toThrow(
        /-32768\.\.32767/
      )
    }
    await expect(gateway.writeItems(0, [{ device: 'M0', value: 2 }])).rejects.toThrow(/0\/1/)
    expect(fake.frames).toHaveLength(1) // 仅探针帧
  })
})

describe('结束代码转译', () => {
  it('0x55 → 中文文案含 RUN 门控与 STOP 出路（经 gateway 写路径触发）', async () => {
    const { gateway, fake } = makeGateway()
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    fake.responses.push(respFrame(0x55, []))
    await expect(gateway.writeItems(0, [{ device: 'D0', value: 1 }])).rejects.toThrow(
      /RUN[\s\S]*STOP/
    )
  })

  it('0xC05D → 原样十六进制 + 上下文', () => {
    const err = sim3EndCodeError(0xc05d, '写入 D0')
    expect(err.message).toMatch(/0xC05D/)
    expect(err.message).toContain('写入 D0')
  })
})

describe('disconnect / 未连接守卫', () => {
  it('disconnect 幂等：未连接 closed:false，连接后 closed:true 且 close 恰一次，再断仍 closed:false', async () => {
    const { gateway, fake } = makeGateway()
    await expect(gateway.disconnect(0)).resolves.toEqual({ station: 0, closed: false })
    fake.responses.push(OK([0x10]))
    await gateway.connect(0)
    await expect(gateway.disconnect(0)).resolves.toEqual({ station: 0, closed: true })
    expect(fake.closeCalls).toBe(1)
    await expect(gateway.disconnect(0)).resolves.toEqual({ station: 0, closed: false })
    expect(fake.closeCalls).toBe(1)
  })

  it('未连接 read/write 抛「尚未连接」', async () => {
    const { gateway } = makeGateway()
    await expect(gateway.readDevices(0, ['D0'])).rejects.toThrow(/尚未连接/)
    await expect(gateway.writeItems(0, [{ device: 'D0', value: 1 }])).rejects.toThrow(/尚未连接/)
  })
})
