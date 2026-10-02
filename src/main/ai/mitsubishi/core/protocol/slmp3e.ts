/**
 * 三菱 MC 协议 QnA 兼容 3E 帧（二进制，over TCP）编解码纯函数。
 * 只做字节序列 ↔ 结构体转换，不做 TCP 连接（连接层后续另写）。
 *
 * 帧格式依据《MELSEC Communication Protocol Reference Manual》（SH-080008）及
 * SLMP 手册（SH-080956）：
 * - 请求子头 5000H（线上字节 50 00），响应子头 D000H（线上字节 D0 00）
 * - 请求数据长度 = 从"监视定时器"字段起到请求数据末尾的字节数
 * - 响应数据长度 = 从"结束代码"字段起到响应数据末尾的字节数
 * - 软元件指定 4 字节 = 编号 3 字节小端 + 软元件代码 1 字节
 * - 除子头外多字节字段一律小端
 */
import type { DeviceSpec } from '../device'

/** 请求子头 0x5000（线上字节序：50 00） */
const REQUEST_SUBHEADER = [0x50, 0x00] as const
/** 响应子头 0xD000（线上字节序：D0 00）。注意：D000H 而非 8000H，依手册与实测帧 */
const RESPONSE_SUBHEADER = [0xd0, 0x00] as const

/** 批量读命令 0401H（字/位单元由子命令区分） */
export const COMMAND_BATCH_READ = 0x0401
/** 批量写命令 1401H（字/位单元由子命令区分） */
export const COMMAND_BATCH_WRITE = 0x1401

/** 子命令：字单元 */
export const SUBCOMMAND_WORD_UNITS = 0x0000
/** 子命令：位单元 */
export const SUBCOMMAND_BIT_UNITS = 0x0001

/** 子头(2) + 网络号(1) + PC号(1) + I/O号(2) + 站号(1) + 数据长度(2) */
const HEADER_LENGTH = 9

/** 请求帧公共选项（缺省即访问本站 CPU） */
export interface Slmp3eOptions {
  /** 请求目标网络号，默认 0 */
  networkNo?: number
  /** 请求目标 PC 号，默认 0xFF（本站） */
  pcNo?: number
  /** 请求目标模块 I/O 号，默认 0x03FF（CPU 模块） */
  requestDestModuleIo?: number
  /** 请求目标模块站号，默认 0 */
  requestDestModuleStationNo?: number
  /**
   * 监视定时器，单位 250ms；0x0000 表示按手册固定 10s。默认 0x0000。
   */
  monitoringTimer?: number
}

/** 将 u16 数组按小端打包为字节序列（字单元写数据 / 读数据解包的逆操作） */
export function wordValuesToBytes(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 2)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
      throw new Error(`字软元件值超出 0..0xFFFF：${v}`)
    }
    bytes[i * 2] = v & 0xff
    bytes[i * 2 + 1] = (v >> 8) & 0xff
  }
  return bytes
}

/** 将小端字节序列解包为 u16 数组（字单元读数据） */
export function bytesToWordValues(bytes: Uint8Array): number[] {
  if (bytes.length % 2 !== 0) {
    throw new Error(`字数据长度必须为偶数，实际 ${bytes.length}`)
  }
  const values: number[] = []
  for (let i = 0; i < bytes.length; i += 2) {
    values.push(bytes[i] | (bytes[i + 1] << 8))
  }
  return values
}

/**
 * 位单元数据每字节 8 点：按小端位序打包（第 n 点 = 第 n/8 字节的第 n%8 位）。
 * 接受 boolean 数组或 0/1 数组。
 */
export function bitValuesToBytes(values: boolean[] | number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(values.length / 8))
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    const on = typeof v === 'boolean' ? v : v === 1
    if (!on && typeof v === 'number' && v !== 0) {
      throw new Error(`位软元件值只能为 true/false 或 0/1，实际 ${v}`)
    }
    if (on) {
      bytes[i >> 3] |= 1 << (i & 7)
    }
  }
  return bytes
}

/** 位单元读数据解包：每字节 8 点，按小端位序展开为 0/1 数组 */
export function bytesToBitValues(bytes: Uint8Array, pointCount?: number): number[] {
  const count = pointCount ?? bytes.length * 8
  const values: number[] = []
  for (let i = 0; i < count; i++) {
    values.push((bytes[i >> 3] >> (i & 7)) & 1)
  }
  return values
}

function appendU16Le(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff)
}

/** 组装公共请求头 + 命令区，extraDataLength 为写数据区字节数（读请求为 0） */
function buildRequestFrame(
  command: number,
  subcommand: number,
  device: DeviceSpec,
  pointCount: number,
  extraDataLength: number,
  opts?: Slmp3eOptions
): number[] {
  if (!Number.isInteger(pointCount) || pointCount <= 0 || pointCount > 0xffff) {
    throw new Error(`点数必须为 1..65535，实际 ${pointCount}`)
  }
  if (!Number.isInteger(device.number) || device.number < 0 || device.number > 0xffffff) {
    throw new Error(`软元件编号超出 3 字节可表示范围（0..16777215）：${device.number}`)
  }
  const networkNo = opts?.networkNo ?? 0x00
  const pcNo = opts?.pcNo ?? 0xff
  const destIo = opts?.requestDestModuleIo ?? 0x03ff
  const destStation = opts?.requestDestModuleStationNo ?? 0x00
  const timer = opts?.monitoringTimer ?? 0x0000

  // 请求数据长度先占位，追加完数据区后回填
  const frame: number[] = [...REQUEST_SUBHEADER]
  frame.push(networkNo, pcNo, destIo & 0xff, (destIo >> 8) & 0xff, destStation)
  frame.push(0x00, 0x00)
  appendU16Le(frame, timer)
  appendU16Le(frame, command)
  appendU16Le(frame, subcommand)
  // 软元件指定 4 字节：编号 3 字节小端 + 代码 1 字节
  frame.push(device.number & 0xff, (device.number >> 8) & 0xff, (device.number >> 16) & 0xff)
  frame.push(device.code & 0xff)
  appendU16Le(frame, pointCount)
  // 请求数据长度 = 从监视定时器字段起到帧末的字节数（含写数据区）
  const dataLength = frame.length - HEADER_LENGTH + extraDataLength
  frame[7] = dataLength & 0xff
  frame[8] = (dataLength >> 8) & 0xff
  return frame
}

/**
 * 组装批量读请求帧。
 * 字单元：命令 0401H + 子命令 0000H；位单元：命令 0401H + 子命令 0001H。
 */
export function buildBatchReadRequest(
  cmd: 'word' | 'bit',
  device: DeviceSpec,
  count: number,
  opts?: Slmp3eOptions
): Uint8Array {
  const subcommand = cmd === 'word' ? SUBCOMMAND_WORD_UNITS : SUBCOMMAND_BIT_UNITS
  return new Uint8Array(
    buildRequestFrame(COMMAND_BATCH_READ, subcommand, device, count, 0, opts)
  )
}

/**
 * 组装批量写请求帧。
 * 字单元：命令 1401H + 子命令 0000H，values 为 u16 数组或已打包的小端字节序列；
 * 位单元：命令 1401H + 子命令 0001H，values 为 boolean[] / 0-1 数组 / 已打包字节序列
 * （每字节 8 点，小端位序）。
 */
export function buildBatchWriteRequest(
  cmd: 'word' | 'bit',
  device: DeviceSpec,
  values: number[] | boolean[] | Uint8Array,
  opts?: Slmp3eOptions
): Uint8Array {
  let data: Uint8Array
  let pointCount: number
  if (cmd === 'word') {
    if (values instanceof Uint8Array) {
      if (values.length % 2 !== 0) {
        throw new Error(`字单元写数据长度必须为偶数，实际 ${values.length}`)
      }
      data = values
    } else if (values.some((v) => typeof v === 'boolean')) {
      throw new Error('字单元写数据不接受 boolean，请传 u16 数组或 Uint8Array')
    } else {
      data = wordValuesToBytes(values as number[])
    }
    // 字单元：每 2 字节 1 点
    pointCount = data.length / 2
  } else {
    if (values instanceof Uint8Array) {
      data = values
      // 已打包字节：每字节 8 点
      pointCount = data.length * 8
    } else {
      // 位单元点数 = 数组元素个数（手册"点数"即位数，非 8 的倍数时末字节高位闲置）
      pointCount = (values as boolean[] | number[]).length
      data = bitValuesToBytes(values as boolean[] | number[])
    }
  }
  if (data.length === 0) {
    throw new Error('写数据不能为空')
  }
  const subcommand = cmd === 'word' ? SUBCOMMAND_WORD_UNITS : SUBCOMMAND_BIT_UNITS
  const count = pointCount
  const frame = buildRequestFrame(COMMAND_BATCH_WRITE, subcommand, device, count, data.length, opts)
  for (let i = 0; i < data.length; i++) {
    frame.push(data[i])
  }
  return new Uint8Array(frame)
}

/**
 * 随机写（位单位）命令 1402H —— GX Simulator3 实测唯一生效的位写通道
 * （批量位写 1401+0001 不支持，2026-10-02 真机联调，见计划文档
 * 「works3 失败样例 + Simulator3 SLMP 联调实测记录」节）。
 * 标准手册 1402 另含字单位/混合模式，此处仅实现已实测的位单位布局。
 */
export const COMMAND_RANDOM_WRITE_BIT = 0x1402

/** 随机写（位单位）单点条目 */
export interface RandomWriteBitItem {
  device: DeviceSpec
  /** true=ON（数据 0x0001）/ false=OFF（数据 0x0000） */
  on: boolean
}

/**
 * 组装随机写（位单位）请求帧的公共头（子头→子命令为止）。
 * 与 buildRequestFrame 分开：1402 没有"前导软元件指定+点数"字段，
 * 数据区布局不同，不强行复用（既有 28 个帧测试 pin 了原函数字节输出）。
 */
function buildCommandHeader(command: number, subcommand: number, opts?: Slmp3eOptions): number[] {
  const networkNo = opts?.networkNo ?? 0x00
  const pcNo = opts?.pcNo ?? 0xff
  const destIo = opts?.requestDestModuleIo ?? 0x03ff
  const destStation = opts?.requestDestModuleStationNo ?? 0x00
  const timer = opts?.monitoringTimer ?? 0x0000
  const frame: number[] = [...REQUEST_SUBHEADER]
  frame.push(networkNo, pcNo, destIo & 0xff, (destIo >> 8) & 0xff, destStation)
  frame.push(0x00, 0x00)
  appendU16Le(frame, timer)
  appendU16Le(frame, command)
  appendU16Le(frame, subcommand)
  return frame
}

/**
 * 组装随机写（位单位）请求帧：命令 1402H + 子命令 0000H + 点数 n，
 * 每点 = 软元件指定 4 字节（编号 3 字节小端 + 软元件代码 1 字节）
 * + 数据 2 字节（u16 LE，0001=ON / 0000=OFF）。
 * 布局依 2026-10-02 GX Simulator3（R08CPU, 127.0.0.1:5511）实测生效帧
 * （探针 %TEMP%\gx_probe\probe_slmp7.cjs rndWriteBit）。
 */
export function buildRandomWriteBitRequest(
  items: RandomWriteBitItem[],
  opts?: Slmp3eOptions
): Uint8Array {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('写数据不能为空')
  }
  if (items.length > 0xffff) {
    throw new Error(`点数必须为 1..65535，实际 ${items.length}`)
  }
  for (const item of items) {
    if (!Number.isInteger(item.device.number) || item.device.number < 0 || item.device.number > 0xffffff) {
      throw new Error(`软元件编号超出 3 字节可表示范围（0..16777215）：${item.device.number}`)
    }
  }
  // 1402 位单位的子命令固定 0000（位/字单位由数据区自描述，与 1401 的 0001 语义无关）
  const frame = buildCommandHeader(COMMAND_RANDOM_WRITE_BIT, SUBCOMMAND_WORD_UNITS, opts)
  appendU16Le(frame, items.length)
  for (const item of items) {
    const d = item.device
    frame.push(d.number & 0xff, (d.number >> 8) & 0xff, (d.number >> 16) & 0xff, d.code & 0xff)
    frame.push(item.on ? 0x01 : 0x00, 0x00)
  }
  const dataLength = frame.length - HEADER_LENGTH
  frame[7] = dataLength & 0xff
  frame[8] = (dataLength >> 8) & 0xff
  return new Uint8Array(frame)
}

/** 3E 帧响应解析结果 */
export interface Slmp3eResponse {
  /** 结束代码：0x0000 正常，非 0 为 PLC 侧错误码（如 0xC05D 命令错误） */
  endCode: number
  /** 响应数据（成功且有数据时存在；出错时缺省） */
  data?: Uint8Array
}

/** 响应帧最小长度 = 子头(2)+访问路径(5)+长度(2)+结束代码(2) */
const RESPONSE_MIN_LENGTH = 11

/**
 * 解析 3E 帧二进制响应。校验子头（D000H）与响应数据长度字段和实际字节数一致，
 * 不一致抛错；出错结束代码时 data 缺省。
 */
export function parseResponse(bytes: Uint8Array): Slmp3eResponse {
  if (bytes.length < RESPONSE_MIN_LENGTH) {
    throw new Error(`响应帧过短：${bytes.length} 字节，至少 ${RESPONSE_MIN_LENGTH} 字节`)
  }
  if (bytes[0] !== RESPONSE_SUBHEADER[0] || bytes[1] !== RESPONSE_SUBHEADER[1]) {
    throw new Error(
      `响应子头错误：期望 ${RESPONSE_SUBHEADER[0].toString(16)} ${RESPONSE_SUBHEADER[1].toString(16)}（D000H），实际 ${bytes[0].toString(16)} ${bytes[1].toString(16)}`
    )
  }
  const declaredLength = bytes[7] | (bytes[8] << 8)
  const actualLength = bytes.length - HEADER_LENGTH
  if (declaredLength !== actualLength) {
    throw new Error(`响应数据长度不一致：帧内声明 ${declaredLength} 字节，实际 ${actualLength} 字节`)
  }
  const endCode = bytes[9] | (bytes[10] << 8)
  if (endCode !== 0) {
    return { endCode }
  }
  return { endCode, data: bytes.slice(HEADER_LENGTH + 2) }
}
