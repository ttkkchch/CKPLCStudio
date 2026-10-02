/**
 * Tool surface of the GX Works stdio MCP bridge.
 *
 * Two tool families, one per transport:
 *
 * - UIA tools (gx_attach/write_st/read_st/build/get_output_errors) run through
 *   the 64-bit PowerShell UIA worker — thin wrappers over GxWindowOps.
 * - Simulation tools (gx_sim_*) run through a SECOND PsWorker spawned under
 *   32-bit PowerShell (SysWOW64) because MX Component's ActUtlType is a
 *   32-bit COM server. They verify program BEHAVIOR against GX Simulator2
 *   (write inputs -> read outputs), which compilation alone cannot prove.
 *
 * Every tool returns JSON text content and maps thrown errors to
 * `isError: true` results (never raw stack traces). One tool set serves both
 * generations: the optional `target` argument selects GX Works3 (default) or
 * GX Works2; the ops instance is built per call (stateless — every op
 * re-attaches to the running window).
 *
 * Safety gates (write preview, read-back verification wording) live in the
 * factory assistant prompt; the tools themselves stay mechanical.
 *
 * Pure Node stdlib — compiled standalone into resources/mitsubishi-mcp/.
 */
import { isGxTarget, type GxTarget } from '../core/uia/locatorMap'
import { GxWindowOps, type PsWorkerLike } from '../core/uia/windowOps'

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** Shared per-tool argument: which GX Works generation to operate on. */
const TARGET_ARG = {
  type: 'string',
  enum: ['works3', 'works2'],
  description:
    '目标平台：works3 = GX Works3（iQ-R/iQ-F 系列，默认）；works2 = GX Works2（Q/L/FX 系列，仅结构化工程的 ST 程序可注入）'
} as const

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'gx_attach',
    description:
      '连接 GX Works3/GX Works2：找到主窗口并置前台，返回窗口信息。用户必须已手动打开 GX Works 并加载工程；target 选代际（默认 works3），projectHint 用于多个工程窗口时按标题子串选择。',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_ARG,
        projectHint: { type: 'string', description: '工程名（标题子串），多窗口时用于选择目标窗口' }
      }
    }
  },
  {
    name: 'gx_write_st',
    description:
      '向指定块的 ST 编辑器写入程序：剪贴板粘贴 + 写后读回哈希校验。读写回不一致时工具报错=未确认写入，禁止随后编译/保存。写之前必须先出改动预览并征得用户确认。GX Works2 仅结构化工程的 ST 程序有 ST 编辑器。',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_ARG,
        blockName: { type: 'string', description: '目标块名（该块的编辑器必须已在 GX Works 中打开为活动编辑器）' },
        stCode: { type: 'string', description: '要写入的完整 ST 源码（整体替换，不是增量）' }
      },
      required: ['blockName', 'stCode']
    }
  },
  {
    name: 'gx_read_st',
    description:
      '读取指定块 ST 编辑器的当前全部文本（Ctrl+A/Ctrl+C 经剪贴板回读，自动备份恢复用户剪贴板）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_ARG,
        blockName: { type: 'string', description: '目标块名' }
      },
      required: ['blockName']
    }
  },
  {
    name: 'gx_build',
    description:
      '触发「全程序编译」（Rebuild All）并轮询输出窗格直到停稳，返回全部输出行与错误行（locale 中性过滤）。编译有错时必须逐条闭环修复，禁止带错保存。',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_ARG,
        scope: { type: 'string', enum: ['all'], description: '编译范围，当前仅支持 all' }
      }
    }
  },
  {
    name: 'gx_get_output_errors',
    description: '读取 GX Works 输出窗格（Output）中的错误行，用于编译失败后的定位。',
    inputSchema: {
      type: 'object',
      properties: {
        target: TARGET_ARG
      }
    }
  },
  {
    name: 'gx_sim_connect',
    description:
      '连接 GX Simulator2 仿真器（经 MX Component ActUtlType，逻辑站号默认 1）。返回 CPU 运行状态（cpuRun）与扫描时间。前置条件：MX Component 已安装且 Communication Setup Utility 已把逻辑站号指向 GX Simulator2；GX Works2 中已点「调试>模拟开始/停止」且 PLC 写入完成（写入对话框进度到 100% 后必须手动点关闭）。',
    inputSchema: {
      type: 'object',
      properties: {
        station: { type: 'number', description: '逻辑站号（默认 1）' }
      }
    }
  },
  {
    name: 'gx_sim_read',
    description:
      '批量读取仿真器软元件当前值（位软元件返回 0/1，字软元件返回有符号 16 位值）。需先 gx_sim_connect。',
    inputSchema: {
      type: 'object',
      properties: {
        station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' },
        devices: { type: 'array', items: { type: 'string' }, description: '软元件名列表，如 ["X0","M0","Y10","D100"]' }
      },
      required: ['devices']
    }
  },
  {
    name: 'gx_sim_write',
    description:
      '批量写入仿真器软元件值（位软元件 0/1，字软元件 -32768..32767）。用于驱动输入条件后观察程序行为，是「写 X → 读 Y」行为验证的核心手段。需先 gx_sim_connect。',
    inputSchema: {
      type: 'object',
      properties: {
        station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              device: { type: 'string', description: '软元件名，如 X0' },
              value: { type: 'number', description: '写入值（位 0/1，字 -32768..32767）' }
            },
            required: ['device', 'value']
          },
          description: '写入项列表，如 [{"device":"X0","value":1}]'
        }
      },
      required: ['items']
    }
  },
  {
    name: 'gx_sim_disconnect',
    description: '断开 ActUtlType 连接（Close）。',
    inputSchema: {
      type: 'object',
      properties: {
        station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' }
      }
    }
  }
]

export interface ToolCallResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function json(value: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function errorResult(message: string): ToolCallResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`参数 "${key}" 必须是非空字符串`)
  }
  return value
}

function parseTarget(args: Record<string, unknown>): GxTarget {
  if (args.target === undefined) return 'works3'
  if (!isGxTarget(args.target)) {
    throw new Error(`参数 "target" 必须是 'works3' 或 'works2'，收到: ${JSON.stringify(args.target)}`)
  }
  return args.target
}

function parseStation(args: Record<string, unknown>): number {
  if (args.station === undefined) return 1
  if (typeof args.station !== 'number' || !Number.isInteger(args.station) || args.station < 0) {
    throw new Error(`参数 "station" 必须是非负整数，收到: ${JSON.stringify(args.station)}`)
  }
  return args.station
}

/** Tools served by the 32-bit MX Component worker instead of GxWindowOps. */
const SIM_TOOLS = new Set(['gx_sim_connect', 'gx_sim_read', 'gx_sim_write', 'gx_sim_disconnect'])

interface SimWriteItem {
  device: string
  value: number
}

function parseWriteItems(args: Record<string, unknown>): SimWriteItem[] {
  const raw = args.items
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('参数 "items" 必须是非空数组（每项 {device, value}）')
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`items[${index}] 必须是对象`)
    }
    const item = entry as Record<string, unknown>
    if (typeof item.device !== 'string' || item.device.length === 0) {
      throw new Error(`items[${index}].device 必须是非空字符串`)
    }
    if (typeof item.value !== 'number' || !Number.isInteger(item.value)) {
      throw new Error(`items[${index}].value 必须是整数`)
    }
    return { device: item.device, value: item.value }
  })
}

function parseDeviceList(args: Record<string, unknown>): string[] {
  const raw = args.devices
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('参数 "devices" 必须是非空字符串数组')
  }
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new Error(`devices[${index}] 必须是非空字符串`)
    }
    return entry
  })
}

export async function callTool(
  worker: PsWorkerLike,
  name: string,
  args: Record<string, unknown>,
  simWorker?: PsWorkerLike
): Promise<ToolCallResult> {
  try {
    if (SIM_TOOLS.has(name)) {
      if (!simWorker) {
        throw new Error('仿真工具不可用：32 位 MX Component worker 未初始化（需 32 位 PowerShell 与 MX Component）')
      }
      const station = parseStation(args)
      switch (name) {
        case 'gx_sim_connect': {
          return json(await simWorker.call('open', { station }))
        }
        case 'gx_sim_read': {
          return json(await simWorker.call('read', { station, devices: parseDeviceList(args) }))
        }
        case 'gx_sim_write': {
          return json(await simWorker.call('write', { station, items: parseWriteItems(args) }))
        }
        case 'gx_sim_disconnect': {
          return json(await simWorker.call('close', { station }))
        }
        default:
          return errorResult(`unknown tool: ${name}`)
      }
    }
    const ops = new GxWindowOps(worker, { target: parseTarget(args) })
    switch (name) {
      case 'gx_attach': {
        const hint = typeof args.projectHint === 'string' && args.projectHint.length > 0 ? args.projectHint : undefined
        return json(await ops.attach(hint))
      }
      case 'gx_write_st': {
        return json(
          await ops.writeSt({ blockName: requireString(args, 'blockName'), stCode: requireString(args, 'stCode') })
        )
      }
      case 'gx_read_st': {
        return json(await ops.readSt(requireString(args, 'blockName')))
      }
      case 'gx_build': {
        const scope = typeof args.scope === 'string' && args.scope.length > 0 ? args.scope : 'all'
        return json(await ops.build(scope as 'all'))
      }
      case 'gx_get_output_errors': {
        return json({ errors: await ops.getOutputErrors() })
      }
      default:
        return errorResult(`unknown tool: ${name}`)
    }
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err))
  }
}
