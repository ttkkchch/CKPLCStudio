/**
 * UI locator tables for GX Works3 / GX Works2 — the ONLY place that knows
 * control names.
 *
 * ⚠ 待校准 (Phase 0): candidate names below are derived from menu
 * documentation, NOT from a live AutomationId/Name inspection. Before Phase A
 * ships to real users, run the calibration procedure (psWorker `listChildren`
 * / `findElements` probes against a real install of each target, zh-CN and
 * en-US) and tighten the candidates. Keep this file data-only so calibration
 * never touches logic.
 *
 * Matching rules (see windowOps): `names` are OR'd as exact UIA Name matches,
 * first hit wins; `controlType` narrows the search when given.
 */

/** Supported GX Works generations (one MCP bridge serves both via `target`). */
export type GxTarget = 'works3' | 'works2'

export interface GxUiLocator {
  /** Preferred AutomationId when the control exposes one (usually unknown pre-calibration). */
  readonly automationId?: string
  /** Candidate control names across UI locales (zh-CN / en-US / ja-JP). */
  readonly names: readonly string[]
  /** UIA ControlType name (e.g. 'Window', 'MenuItem') used to narrow search. */
  readonly controlType?: string
}

/** Per-generation profile: how to find the window, compile menus and output pane. */
export interface GxPlatformProfile {
  readonly target: GxTarget
  /** Human-facing platform name used in user-visible error messages. */
  readonly displayName: string
  /** Title substring used to find the main window (locale-independent frame suffix). */
  readonly titleContains: string
  readonly locators: {
    /** Main frame window (matched by title substring, not exact Name). */
    mainWindow: GxUiLocator
    /** Top-level menu hosting compile commands. */
    compileMenu: GxUiLocator
    /** Compile-all command inside the compile menu. */
    compileAllMenuItem: GxUiLocator
    /** Dockable Output window pane that receives build diagnostics. */
    outputPane: GxUiLocator
  }
  /**
   * true → the ST editor only exists in structured projects (GX Works2).
   * Simple-ladder projects expose no ST editor to inject into at all.
   */
  readonly stRequiresStructuredProject: boolean
}

const WORKS3_PROFILE: GxPlatformProfile = {
  target: 'works3',
  displayName: 'GX Works3',
  // Frame title: "<project> - [<view>] - GX Works3".
  titleContains: 'GX Works3',
  locators: {
    mainWindow: { names: ['GX Works3'], controlType: 'Window' },
    compileMenu: { names: ['转换/编译', 'Compile', '変換/コンパイル'], controlType: 'MenuItem' },
    compileAllMenuItem: {
      names: ['全程序编译', '编译所有程序', 'Compile All Programs', '全プログラムコンパイル'],
      controlType: 'MenuItem'
    },
    outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
  },
  stRequiresStructuredProject: false
}

/**
 * GX Works2 candidates (待校准): the top menu is "转换(C)" (zh) / "Convert(C)"
 * (en) / "変換(C)" (ja), the rebuild-all item is "全部转换" / "Rebuild All",
 * and the output pane naming mirrors Works3. ST injection requires a
 * STRUCTURED project (结构化工程) — simple ladder projects have no ST editor.
 */
const WORKS2_PROFILE: GxPlatformProfile = {
  target: 'works2',
  displayName: 'GX Works2',
  // Frame title: "<project> - [<view>] - GX Works2".
  titleContains: 'GX Works2',
  locators: {
    mainWindow: { names: ['GX Works2'], controlType: 'Window' },
    compileMenu: { names: ['转换', 'Convert', '変換'], controlType: 'MenuItem' },
    compileAllMenuItem: { names: ['全部转换', 'Rebuild All', '全部変換'], controlType: 'MenuItem' },
    outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
  },
  stRequiresStructuredProject: true
}

export const GX_PROFILES: Record<GxTarget, GxPlatformProfile> = {
  works3: WORKS3_PROFILE,
  works2: WORKS2_PROFILE
}

export function getGxProfile(target: GxTarget): GxPlatformProfile {
  return GX_PROFILES[target]
}

export function isGxTarget(value: unknown): value is GxTarget {
  return value === 'works3' || value === 'works2'
}

/** Control types accepted when locating the Output window grid. */
export const GX_OUTPUT_GRID_CONTROL_TYPES = ['DataGrid', 'Table', 'Custom'] as const

/**
 * Locale-neutral error-line heuristic for Output text (待校准: confirm the
 * exact prefixes each generation emits, e.g. "エラー" / "错误" / "Error").
 */
export const GX_OUTPUT_ERROR_PATTERN = /error|错误|エラー/i

/**
 * Clipboard keys used by the ST editor round-trip. SendKeys syntax
 * ("^a" = Ctrl+A, "^v" = Ctrl+V, "^c" = Ctrl+C) — the ST editor does not
 * expose a UIA TextPattern, so paste/read-back via clipboard is the only
 * text channel (researched: community gxworks3-mcp-bridge).
 */
export const GX_ST_SELECT_ALL_KEYS = '^a'
export const GX_ST_COPY_KEYS = '^c'
export const GX_ST_PASTE_KEYS = '^v'
