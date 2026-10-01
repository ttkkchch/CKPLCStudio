/**
 * UI locator tables for GX Works3 / GX Works2 — the ONLY place that knows
 * control names.
 *
 * Works3 values are CALIBRATED live (GX Works3 1.128J zh-CN, 2026-10-01 — see
 * the "Phase 0 校准实测记录" section in .trae/documents/mitsubishi-gxworks3-support-plan.md).
 * Works2 values are best-effort placeholders (same MELSOFT Codejock shell, no
 * live probe run yet — 待校准). Keep this file data-only so calibration never
 * touches logic.
 *
 * MSAA matching rule: menu names are StartsWith PREFIXES against IAccessible
 * names (menu items carry accelerator suffixes like 全部转换(R)). UIA matching
 * (windowOps focusElement etc.) stays exact-name OR'd.
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

/** MSAA bridge parameters (menu navigation + native class names). */
export interface GxMsaaLocators {
  /** ClassName of the Codejock toolbars; the real menu bar is one of them. */
  readonly toolbarClassName: string
  /** Modal rebuild dialog (main-window CHILD, not top-level; works3: #32770). */
  readonly compileDialogClassName?: string
  /** Status bar class whose UIA Name carries per-program convert results. */
  readonly statusBarClassName?: string
  /** Bottom dock tabbed container class; its UIA Name = current active tab. */
  readonly dockContainerClassName?: string
  /** Output pane's report list (works3: SysListView32; empty rows on success). */
  readonly outputListClassName?: string
  /**
   * Menu hits must be at least this many MSAA BFS path segments deep —
   * toolbar buttons share captions with menu items (全部转换) but sit at 2-3
   * segments while menu items are >=4 (root>转换(C)>转换(C)>全部转换(R)).
   */
  readonly minMenuPathSegments: number
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
    /**
     * Top-level menu hosting compile commands (MSAA StartsWith prefix;
     * reserved for the open-menu-root-then-leaf fallback on Works2).
     */
    compileMenu: GxUiLocator
    /** Compile-all command inside the compile menu (MSAA StartsWith prefix). */
    compileAllMenuItem: GxUiLocator
    /** Dockable Output window pane that receives build diagnostics. */
    outputPane: GxUiLocator
  }
  /** MSAA/native-class parameters driving windowOps.build(). */
  readonly msaa: GxMsaaLocators
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
    // Calibrated 1.128J zh-CN: top menu 转换(C) — the '(' distinguishes the
    // menu root from 转换结果(N)/转换+RUN(B) under the same StartsWith rule.
    compileMenu: { names: ['转换('] },
    // Calibrated: 全部转换(R) inside 转换(C); MSAA BFS + accDoDefaultAction
    // clicks it without physically expanding the menu.
    compileAllMenuItem: { names: ['全部转换'] },
    // Bottom dock pane content sits under XTPDockingPaneTabbedContainer →
    // Afx:00300000:0 → #32770; pane lookup kept for the generic grid fallback.
    outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
  },
  msaa: {
    toolbarClassName: 'XTPToolBar',
    compileDialogClassName: '#32770',
    statusBarClassName: 'XTPStatusBar',
    dockContainerClassName: 'XTPDockingPaneTabbedContainer',
    outputListClassName: 'SysListView32',
    minMenuPathSegments: 4
  },
  stRequiresStructuredProject: false
}

/**
 * GX Works2 candidates (待校准 — no live Works2 probe run yet): per MELSOFT
 * documentation the top menu is 转换(C) / Convert(C) with a 全部转换 /
 * Rebuild All item, and Works2 shares the Codejock-drawn shell, so the Works3
 * mechanism/values are mirrored as placeholders. ST injection requires a
 * STRUCTURED project (结构化工程) — simple ladder projects have no ST editor.
 */
const WORKS2_PROFILE: GxPlatformProfile = {
  target: 'works2',
  displayName: 'GX Works2',
  // Frame title: "<project> - [<view>] - GX Works2".
  titleContains: 'GX Works2',
  locators: {
    mainWindow: { names: ['GX Works2'], controlType: 'Window' },
    compileMenu: { names: ['转换(', 'Convert('] },
    compileAllMenuItem: { names: ['全部转换', 'Rebuild All'] },
    outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
  },
  msaa: {
    toolbarClassName: 'XTPToolBar',
    compileDialogClassName: '#32770',
    minMenuPathSegments: 4
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

/** Control types accepted when locating the Output window grid (readGrid fallback). */
export const GX_OUTPUT_GRID_CONTROL_TYPES = ['DataGrid', 'Table', 'Custom', 'List'] as const

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

/**
 * ENTER sent to the FOREGROUND modal rebuild dialog. Calibrated: BM_CLICK and
 * accDoDefaultAction on 确定 merely close the dialog WITHOUT running the
 * build — only ENTER on the foregrounded dialog actually starts the conversion.
 */
export const GX_BUILD_CONFIRM_KEYS = '{ENTER}'
