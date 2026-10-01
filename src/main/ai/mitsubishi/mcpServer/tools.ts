/**
 * Phase A tool surface of the GX Works stdio MCP bridge.
 *
 * Thin wrappers over GxWindowOps — every tool returns JSON text content and
 * maps thrown errors to `isError: true` results (never raw stack traces).
 * One tool set serves both generations: the optional `target` argument
 * selects GX Works3 (default) or GX Works2; the ops instance is built per
 * call (stateless — every op re-attaches to the running window).
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

export async function callTool(
  worker: PsWorkerLike,
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResult> {
  try {
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
