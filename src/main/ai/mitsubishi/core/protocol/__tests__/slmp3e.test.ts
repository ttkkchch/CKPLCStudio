/**
 * MC 协议 3E 帧编解码测试：请求帧按官方手册样例手工拼期望字节，
 * 响应帧覆盖成功/异常结束代码/长度不一致等分支。
 */
import { describe, expect, it } from 'vitest'
import { parseDevice } from '../../device'
import {
  bitValuesToBytes,
  buildBatchReadRequest,
  buildBatchWriteRequest,
  buildRandomWriteBitRequest,
  bytesToBitValues,
  bytesToWordValues,
  parseResponse,
  wordValuesToBytes
} from '../slmp3e'

/** "50 00 FF" 形式的十六进制串 → Uint8Array */
function hex(s: string): Uint8Array {
  return new Uint8Array(
    s
      .trim()
      .split(/\s+/)
      .map((b) => Number.parseInt(b, 16))
  )
}

describe('buildBatchReadRequest', () => {
  it('读字软元件 D1000×3 点生成手册样例帧', () => {
    const frame = buildBatchReadRequest('word', parseDevice('D1000'), 3)
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0C 00 00 00 01 04 00 00 E8 03 00 A8 03 00')
    )
  })

  it('读位软元件 X10（八进制 → 8）×16 点：子命令 0001H', () => {
    const frame = buildBatchReadRequest('bit', parseDevice('X10'), 16)
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0C 00 00 00 01 04 01 00 08 00 00 9C 10 00')
    )
  })

  it('自定义访问路径与监视定时器逐字段生效', () => {
    const frame = buildBatchReadRequest('word', parseDevice('D1000'), 3, {
      networkNo: 5,
      pcNo: 0x10,
      requestDestModuleIo: 0x03e0,
      requestDestModuleStationNo: 2,
      monitoringTimer: 4
    })
    expect(frame).toEqual(
      hex('50 00 05 10 E0 03 02 0C 00 04 00 01 04 00 00 E8 03 00 A8 03 00')
    )
  })

  it('点数非法（0/负数/非整数/超 65535）抛错', () => {
    const d = parseDevice('D0')
    for (const bad of [0, -1, 3.5, 65536]) {
      expect(() => buildBatchReadRequest('word', d, bad)).toThrow(/点数/)
    }
  })

  it('软元件编号超出 3 字节范围抛错', () => {
    const bad = { code: 0xa8, name: 'D', number: 0x1000000, unit: 'word' as const }
    expect(() => buildBatchReadRequest('word', bad, 1)).toThrow(/3 字节/)
  })
})

describe('buildBatchWriteRequest', () => {
  const d0 = parseDevice('D0')
  const m0 = parseDevice('M0')

  it('写字 D0=[0x1234, 0x5678]：点数 2、小端数据区', () => {
    const frame = buildBatchWriteRequest('word', d0, [0x1234, 0x5678])
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 10 00 00 00 01 14 00 00 00 00 00 A8 02 00 34 12 78 56')
    )
  })

  it('写位 M0=[true,false,true]：点数即位数 3、数据区按位压缩 1 字节', () => {
    const frame = buildBatchWriteRequest('bit', m0, [true, false, true])
    // 数据区 0b101 = 0x05（小端位序：第 n 点 = 字节第 n 位）
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0D 00 00 00 01 14 01 00 00 00 00 90 03 00 05')
    )
  })

  it('写位传已打包字节：点数 = 字节数 × 8', () => {
    const frame = buildBatchWriteRequest('bit', m0, new Uint8Array([0xff, 0x01]))
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 01 14 01 00 00 00 00 90 10 00 FF 01')
    )
  })

  it('写字传已打包小端字节：点数 = 字节数 / 2', () => {
    const frame = buildBatchWriteRequest('word', d0, new Uint8Array([0x34, 0x12]))
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 01 14 00 00 00 00 00 A8 01 00 34 12')
    )
  })

  it('字单元拒绝 boolean 数组', () => {
    expect(() => buildBatchWriteRequest('word', d0, [true, false])).toThrow(/boolean/)
  })

  it('字单元奇数字节 Uint8Array 抛错', () => {
    expect(() => buildBatchWriteRequest('word', d0, new Uint8Array([0x01]))).toThrow(/偶数/)
  })

  it('空写数据抛错', () => {
    expect(() => buildBatchWriteRequest('word', d0, [])).toThrow(/不能为空/)
    expect(() => buildBatchWriteRequest('bit', m0, [])).toThrow(/不能为空/)
  })

  it('字值越界抛错', () => {
    expect(() => buildBatchWriteRequest('word', d0, [0x10000])).toThrow(/0xFFFF/)
  })
})

describe('parseResponse', () => {
  it('正常读响应：结束代码 0、返回数据区', () => {
    const res = parseResponse(hex('D0 00 00 FF FF 03 00 06 00 00 00 34 12 78 56'))
    expect(res.endCode).toBe(0)
    expect(res.data).toBeInstanceOf(Uint8Array)
    expect(Array.from(res.data!)).toEqual([0x34, 0x12, 0x78, 0x56])
  })

  it('写响应（无数据区）：结束代码 0、数据为空', () => {
    const res = parseResponse(hex('D0 00 00 FF FF 03 00 02 00 00 00'))
    expect(res.endCode).toBe(0)
    expect(res.data).toHaveLength(0)
  })

  it('异常结束代码（C05D）时数据缺省', () => {
    const res = parseResponse(hex('D0 00 00 FF FF 03 00 02 00 5D C0'))
    expect(res.endCode).toBe(0xc05d)
    expect(res.data).toBeUndefined()
  })

  it('帧过短抛错', () => {
    expect(() => parseResponse(hex('D0 00 00 FF FF 03 00 02 00 00'))).toThrow(/过短/)
  })

  it('响应子头非 D000H 抛错', () => {
    expect(() => parseResponse(hex('80 00 00 FF FF 03 00 02 00 00 00'))).toThrow(/子头/)
  })

  it('长度字段与实际字节数不一致抛错', () => {
    // 声明 8 字节，实际自结束代码起仅 6 字节
    expect(() => parseResponse(hex('D0 00 00 FF FF 03 00 08 00 00 00 34 12 78 56'))).toThrow(
      /长度不一致/
    )
  })
})

describe('buildRandomWriteBitRequest（1402 位单位随机写，2026-10-02 Simulator3 实测布局）', () => {
  it('单点 X0=ON 生成实测生效帧（探针 probe_slmp7 rndWriteBit 逐字节）', () => {
    const frame = buildRandomWriteBitRequest([{ device: parseDevice('X0'), on: true }])
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 0E 00 00 00 02 14 00 00 01 00 00 00 00 9C 01 00')
    )
  })

  it('多点 M0=ON/M5=OFF：点数 2、每点 6 字节按调用顺序、数据 01 00 / 00 00', () => {
    const frame = buildRandomWriteBitRequest([
      { device: parseDevice('M0'), on: true },
      { device: parseDevice('M5'), on: false }
    ])
    expect(frame).toEqual(
      hex('50 00 00 FF FF 03 00 14 00 00 00 02 14 00 00 02 00 00 00 00 90 01 00 05 00 00 90 00 00')
    )
  })

  it('自定义访问路径与监视定时器逐字段生效', () => {
    const frame = buildRandomWriteBitRequest([{ device: parseDevice('Y5'), on: true }], {
      networkNo: 5,
      pcNo: 0x10,
      requestDestModuleIo: 0x03e0,
      requestDestModuleStationNo: 2,
      monitoringTimer: 4
    })
    // Y5 八进制 → 线性 5；Y 代码 0x9D
    expect(frame).toEqual(
      hex('50 00 05 10 E0 03 02 0E 00 04 00 02 14 00 00 01 00 05 00 00 9D 01 00')
    )
  })

  it('空数组抛错', () => {
    expect(() => buildRandomWriteBitRequest([])).toThrow(/不能为空/)
  })

  it('软元件编号超出 3 字节范围抛错', () => {
    const bad = { code: 0xa8, name: 'D', number: 0x1000000, unit: 'word' as const }
    expect(() => buildRandomWriteBitRequest([{ device: bad, on: true }])).toThrow(/3 字节/)
  })

  it('数据长度字段 = 总长 − 9（多点时回填正确）', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      device: parseDevice(`M${i}`),
      on: i % 2 === 0
    }))
    const frame = buildRandomWriteBitRequest(items)
    const declared = frame[7] | (frame[8] << 8)
    expect(declared).toBe(frame.length - 9)
    expect(declared).toBe(6 + 2 + 10 * 6)
  })
})

describe('数据打包帮助函数', () => {
  it('wordValuesToBytes 小端打包', () => {
    expect(Array.from(wordValuesToBytes([0x1234, 0x5678]))).toEqual([0x34, 0x12, 0x78, 0x56])
  })

  it('wordValuesToBytes 拒绝负数/超界/非整数', () => {
    for (const bad of [-1, 0x10000, 1.5]) {
      expect(() => wordValuesToBytes([bad])).toThrow(/0xFFFF/)
    }
  })

  it('bytesToWordValues 小端解包', () => {
    expect(bytesToWordValues(new Uint8Array([0x34, 0x12]))).toEqual([0x1234])
  })

  it('bytesToWordValues 奇数长度抛错', () => {
    expect(() => bytesToWordValues(new Uint8Array([0x01, 0x02, 0x03]))).toThrow(/偶数/)
  })

  it('字数据打包 → 解包 roundtrip', () => {
    const values = [0, 1, 0x7fff, 0x8000, 0xffff]
    expect(bytesToWordValues(wordValuesToBytes(values))).toEqual(values)
  })

  it('bitValuesToBytes 每字节 8 点小端位序', () => {
    expect(Array.from(bitValuesToBytes([true, false, true]))).toEqual([0x05])
    expect(Array.from(bitValuesToBytes(new Array(16).fill(true)))).toEqual([0xff, 0xff])
    expect(Array.from(bitValuesToBytes([0, 1, 0, 1]))).toEqual([0x0a])
  })

  it('bitValuesToBytes 拒绝非 0/1 数值', () => {
    expect(() => bitValuesToBytes([0, 2])).toThrow(/0\/1/)
  })

  it('bytesToBitValues 解包', () => {
    expect(bytesToBitValues(new Uint8Array([0x05]))).toEqual([1, 0, 1, 0, 0, 0, 0, 0])
    expect(bytesToBitValues(new Uint8Array([0x05]), 3)).toEqual([1, 0, 1])
  })

  it('位数据打包 → 解包 roundtrip', () => {
    const values = [true, false, true, true, false, true, false, true, true, false, true]
    const bytes = bitValuesToBytes(values)
    expect(bytes).toHaveLength(2)
    expect(bytesToBitValues(bytes, values.length)).toEqual(values.map((v) => (v ? 1 : 0)))
  })
})
