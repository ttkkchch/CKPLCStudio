/**
 * GX Simulator3 适配层（works3 仿真器 SLMP 私有行为封装）。
 *
 * 2026-10-02 真机联调实测结论（R08CPU, RSimRun3 监听 127.0.0.1:5511，见
 * 计划文档「works3 失败样例 + Simulator3 SLMP 联调实测记录」节）：
 * - 位读响应数据为 Simulator3 私有 nibble 编码（标准 3E 是每字节 8 点小端位序）
 * - 批量位写 1401+0001 不支持 → 位写走 1402 随机写（实测唯一生效通路）
 * - CPU RUN 中一切写拒绝（endCode 0x55），读正常；写仅 STOP 可用
 * - 字通道与标准 3E 零偏差；有符号字值由 tools 层语义决定（此处读回转 int16）
 */
import { parseDevice, type DeviceSpec } from '../device'
import {
  buildBatchReadRequest,
  buildBatchWriteRequest,
  buildRandomWriteBitRequest,
  bytesToWordValues,
  parseResponse,
  wordValuesToBytes
} from '../protocol/slmp3e'
import { SlmpClient } from './slmpClient'

/**
 * Simulator3 私有位读 nibble 解码：每点 1 nibble，点 n → byte[n/2]，
 * 偶数点=bit4、奇数点=bit0，ON=1（实测 2026-10-02）。
 */
export function decodeSim3BitRead(bytes: Uint8Array, pointCount: number): number[] {
  const need = Math.ceil(pointCount / 2)
  if (bytes.length < need) {
    throw new Error(`位读数据不足：期望至少 ${need} 字节（nibble 编码），实际 ${bytes.length}`)
  }
  const values: number[] = []
  for (let n = 0; n < pointCount; n++) {
    const byte = bytes[n >> 1]
    values.push(n % 2 === 0 ? (byte >> 4) & 1 : byte & 1)
  }
  return values
}

/** 将 u16 转为有符号 int16（Simulator3 字读回语义） */
function toInt16(v: number): number {
  return v >= 0x8000 ? v - 0x10000 : v
}

/** SLMP 结束代码 → 中文错误（0x55 = Simulator3 RUN 门控，给出处） */
export function sim3EndCodeError(endCode: number, context: string): Error {
  if (endCode === 0x55) {
    return new Error(
      `Simulator3 拒绝写入（结束代码 0x55，${context}）：CPU 处于 RUN 状态——写操作仅 STOP 可用，` +
        `请在 GX Simulator3 窗口的 SWITCH 面板点击 STOP 后重试（读不受影响）`
    )
  }
  return new Error(`SLMP 结束代码 0x${endCode.toString(16).padStart(4, '0').toUpperCase()}（${context}）`)
}

export interface Sim3ConnectResult {
  station: number
  host: string
  port: number
  /** SM0 位读探针=1（常 ON，实测连通性证据） */
  alive: boolean
}

export interface Simulator3Gateway {
  /** 建连 + SM0 探针。重复 connect 幂等重建（先弃旧连接）。 */
  connect(station: number): Promise<Sim3ConnectResult>
  /** 逐设备 1 点读：位→0/1（nibble 解码），字→有符号 int16。 */
  readDevices(station: number, devices: string[]): Promise<{ results: Array<{ device: string; value: number }> }>
  /** 位项攒批一帧 1402；连续同码同段字项合并一帧 1401。 */
  writeItems(station: number, items: Array<{ device: string; value: number }>): Promise<{ written: number }>
  /** 关闭连接（幂等；未连接返回 closed:false）。 */
  disconnect(station: number): Promise<{ closed: boolean }>
  /** 无条件释放底层连接（entry shutdown / connect 重建用）。 */
  dispose(): void
}

export interface Simulator3GatewayOptions {
  host?: string
  port?: number
  /** 测试注入（默认新建 SlmpClient） */
  clientFactory?: () => Pick<SlmpClient, 'connect' | 'exchange' | 'close' | 'connected'>
}

interface ClientLike {
  connect(): Promise<void>
  exchange(frame: Uint8Array): Promise<Uint8Array>
  close(): void
  readonly connected: boolean
}

export function createSimulator3Gateway(opts?: Simulator3GatewayOptions): Simulator3Gateway {
  const host = opts?.host ?? '127.0.0.1'
  const port = opts?.port ?? 5511
  const clientFactory = opts?.clientFactory ?? ((): ClientLike => new SlmpClient({ host, port }))
  let client: ClientLike | null = null

  const requireClient = (): void => {
    if (!client) {
      throw new Error('尚未连接 Simulator3——请先 gx_sim_connect（target=works3）')
    }
  }

  /** 发一帧并校验结束代码（0 = OK）；返回响应数据区（可能为空） */
  async function request(frame: Uint8Array, context: string): Promise<Uint8Array> {
    const res = parseResponse(await client!.exchange(frame))
    if (res.endCode !== 0) {
      throw sim3EndCodeError(res.endCode, context)
    }
    return res.data ?? new Uint8Array(0)
  }

  return {
    async connect(station: number): Promise<Sim3ConnectResult> {
      // 幂等重建：旧连接先弃（半开 socket 不可复用）
      if (client) {
        client.close()
        client = null
      }
      client = clientFactory()
      await client.connect()
      // SM0 常 ON 位读探针（实测 SM0=1）；读到 0 视为异常
      const spec = parseDevice('SM0')
      const data = await request(buildBatchReadRequest('bit', spec, 1), '连通性探针 SM0')
      const sm0 = decodeSim3BitRead(data, 1)[0]
      if (sm0 !== 1) {
        throw new Error(`Simulator3 连通性探针异常：SM0 读到 ${sm0}（预期常 ON=1）——请确认已连接 R08CPU 仿真`)
      }
      return { station, host, port, alive: true }
    },

    async readDevices(_station, devices) {
      requireClient()
      const results: Array<{ device: string; value: number }> = []
      for (const device of devices) {
        const spec = parseDevice(device)
        if (spec.unit === 'bit') {
          const data = await request(buildBatchReadRequest('bit', spec, 1), `读取 ${device}`)
          results.push({ device, value: decodeSim3BitRead(data, 1)[0] })
        } else {
          const data = await request(buildBatchReadRequest('word', spec, 1), `读取 ${device}`)
          results.push({ device, value: toInt16(bytesToWordValues(data)[0]) })
        }
      }
      return { results }
    },

    async writeItems(_station, items) {
      requireClient()
      const specs = items.map((item) => ({ item, spec: parseDevice(item.device) }))
      let written = 0
      let i = 0
      while (i < specs.length) {
        const { item, spec } = specs[i]
        if (spec.unit === 'bit') {
          // 位项攒批：相邻位项合并为一帧 1402 随机写（多点独立指定，无需连续编号）
          const batch: Array<{ spec: DeviceSpec; on: boolean }> = []
          let j = i
          while (j < specs.length && specs[j].spec.unit === 'bit') {
            const v = specs[j].item.value
            if (v !== 0 && v !== 1) {
              throw new Error(`位软元件 "${specs[j].item.device}" 的写入值只能为 0/1，实际 ${v}`)
            }
            batch.push({ spec: specs[j].spec, on: v === 1 })
            j++
          }
          await request(
            buildRandomWriteBitRequest(batch.map((b) => ({ device: b.spec, on: b.on }))),
            `写入位软元件 ${batch.map((b) => b.spec.name + b.spec.number).join(',')}`
          )
          written += batch.length
          i = j
        } else {
          // 字项攒 run：同码且编号连续递增的相邻字项合并为一帧批量写（1401+0000）
          if (!Number.isInteger(item.value) || item.value < -32768 || item.value > 32767) {
            throw new Error(`字软元件 "${item.device}" 的写入值须为 -32768..32767，实际 ${item.value}`)
          }
          const run: Array<{ item: { device: string; value: number }; spec: DeviceSpec }> = [
            { item, spec }
          ]
          let j = i + 1
          while (j < specs.length) {
            const next = specs[j]
            if (
              next.spec.unit === 'word' &&
              next.spec.code === spec.code &&
              next.spec.number === run[run.length - 1].spec.number + 1 &&
              Number.isInteger(next.item.value) &&
              next.item.value >= -32768 &&
              next.item.value <= 32767
            ) {
              run.push(next)
              j++
            } else {
              break
            }
          }
          const values = run.map((r) => r.item.value & 0xffff)
          await request(
            buildBatchWriteRequest('word', spec, wordValuesToBytes(values)),
            `写入字软元件 ${run[0].item.device}${run.length > 1 ? `..${run[run.length - 1].item.device}` : ''}`
          )
          written += run.length
          i = j
        }
      }
      return { written }
    },

    async disconnect(station) {
      if (!client) {
        return { station, closed: false }
      }
      client.close()
      client = null
      return { station, closed: true }
    },

    dispose(): void {
      if (client) {
        client.close()
        client = null
      }
    }
  }
}
