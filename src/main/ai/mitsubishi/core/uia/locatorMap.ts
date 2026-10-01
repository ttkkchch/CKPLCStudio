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
  /**
   * Where the compile-confirm dialog lives:
   * - 'child' (default): a main-window child found via UIA descendants
   *   (works3's 全部转换 dialog).
   * - 'top-level': an OWNED TOP-LEVEL window searched by class name in the
   *   same process (works2's 是否执行全部编译？ dialog). Mandatory for works2 —
   *   its frame keeps empty-titled child #32770 MDI containers around, which a
   *   UIA descendants search would hit first and misroute the ENTER into.
   */
  readonly compileDialogScope?: 'child' | 'top-level'
  /** Status bar class whose UIA Name carries per-program convert results. */
  readonly statusBarClassName?: string
  /** Bottom dock tabbed container class; its UIA Name = current active tab. */
  readonly dockContainerClassName?: string
  /** Output pane's report list (works3: SysListView32; empty rows on success). */
  readonly outputListClassName?: string
  /**
   * How to read the output list rows:
   * - 'uia-list' (default): UIA children names / cell text (works3 SysListView32).
   * - 'msaa-grid': MSAA walk of the grid hwnd — rows are the grid children
   *   that own children (works2 VSFlexGrid8N: Row-N PAGETABs), each row joined
   *   from its cells' accValue ("1 | Error | POU_01 | ... | C8042").
   */
  readonly outputListReader?: 'uia-list' | 'msaa-grid'
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
   * Locale-neutral error-line classifier for output rows; overrides
   * GX_OUTPUT_ERROR_PATTERN when set. Works2 rows are "cell | cell" joins whose
   * 结果 cell is exactly Error/CheckWarning/Information — matching the cell
   * (not the free text) avoids false positives from the header row's 错误代码
   * column title.
   */
  readonly outputErrorPattern?: RegExp
  /**
   * Class name of the ST editor control when it carries NO usable name
   * (works2: an unnamed RichEdit20W — the name-based lookup would land on the
   * project-tree item with the same caption). When set, focusEditor first
   * trusts the app's CURRENT focused element if its class matches, then
   * searches by this class name before falling back to name-based attempts.
   */
  readonly editorFocusClassName?: string
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
 * GX Works2 CALIBRATED live (GD2.exe from MELSOFT\GPPW2, zh-CN, 1.635M,
 * structured project + full build chain exercised, 2026-10-01): UIA also
 * exposes ZERO MenuItems; the menu bar is an XTPToolBar whose MSAA root is
 * [MENUBAR] 菜单栏, and the full menu tree is visible via MSAA at 3 segments
 * (BAR>item>popup>leaf) WITHOUT works3's double CHECKBOX/CANVAS wrapping.
 * Build flow (live-verified twice): clicking 转换(+全部编译)(全部程序)(R) pops
 * an OWNED TOP-LEVEL #32770 confirm dialog ("是否执行全部编译？", title = main
 * frame title, 是(Y)/否(N)) — the works3 dialog is a main-window child, so
 * findDialog falls back to a pid-filtered top-level scan. ENTER on the
 * foregrounded dialog (是 = default button) runs the compile. Results land in
 * the VSFlexGrid8N output grid (NOT the status bar — its msctls_statusbar32
 * panes carry no compile info): root LIST → header LISTITEMs + Row-N PAGETABs
 * whose PROPERTYPAGE cells expose accValue text; the 结果 column enum is
 * Error / CheckWarning / Information (live error sample: C8042 没有找到算式。).
 * Direct device access (X0/M0/Y10) compiles without labels in structured ST.
 * ST injection requires a STRUCTURED project.
 */
const WORKS2_PROFILE: GxPlatformProfile = {
  target: 'works2',
  displayName: 'GX Works2',
  // Frame title: "MELSOFT系列 GX Works2" (no project) — contains suffix stands.
  titleContains: 'GX Works2',
  locators: {
    mainWindow: { names: ['GX Works2'], controlType: 'Window' },
    // Calibrated zh-CN: top menu is 转换/编译(C) — NOT works3's 转换(C).
    compileMenu: { names: ['转换/编译(', 'Convert/Compile('] },
    // Calibrated: 转换(+全部编译)(全部程序)(R); the prefix distinguishes it
    // from 转换(+编译)(B) under the same StartsWith rule.
    compileAllMenuItem: { names: ['转换(+全部编译)', 'Convert(+Compile All)'] },
    outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
  },
  msaa: {
    toolbarClassName: 'XTPToolBar',
    compileDialogClassName: '#32770',
    // The confirm dialog is top-level, NOT a frame child (see field doc).
    compileDialogScope: 'top-level',
    statusBarClassName: 'msctls_statusbar32',
    dockContainerClassName: 'XTPDockingPaneTabbedContainer',
    outputListClassName: 'VSFlexGrid8N',
    // VSFlexGrid8N is an MSAA-only ActiveX grid — its row text lives in cell
    // accValue, not UIA names, so rows are read through the MSAA grid walker.
    outputListReader: 'msaa-grid',
    // Menu leaves sit at BAR>item>popup>leaf = 3 segments (no CANVAS layer).
    minMenuPathSegments: 3
  },
  // Result rows join as "1 | Error | POU_01 | 编译程序 | ... | C8042"; match the
  // 结果 cell exactly so the header row (…| 错误代码) and CheckWarning rows
  // never classify as errors.
  outputErrorPattern: /\|\s*Error\s*\|/,
  // The ST editor is an unnamed RichEdit20W; name lookups would focus the
  // project-tree item with the same caption instead (observed live: the
  // clipboard round-trip then false-matches and the build compiles stale code).
  editorFocusClassName: 'RichEdit20W',
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
 * Locale-neutral error-line heuristic for Output text (works3: 待校准 exact
 * prefixes; works2 overrides this with its profile.outputErrorPattern because
 * its rows are cell joins classified by the 结果 column, see WORKS2_PROFILE).
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
