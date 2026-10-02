"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GX_SIM_PROCESS_NAMES = exports.GX_BUILD_CONFIRM_KEYS = exports.GX_ST_PASTE_KEYS = exports.GX_ST_COPY_KEYS = exports.GX_ST_SELECT_ALL_KEYS = exports.GX_OUTPUT_ERROR_PATTERN = exports.GX_OUTPUT_GRID_CONTROL_TYPES = exports.GX_PROFILES = exports.GX_SIM3_SWITCH_RUN_BUTTON = exports.GX_SIM3_PANEL_TITLE = exports.GX_SIM3_SIM_PROCESS = exports.GX_SIM3_WRITE_DIALOG_TITLE = exports.GX_SIM3_SIMSTART_ITEM = exports.GX_SIM3_SIMSTART_TOOLBAR = exports.GX_PLC_WRITE_CLOSE_BUTTON = exports.GX_PLC_WRITE_DIALOG_TITLE = void 0;
exports.getGxProfile = getGxProfile;
exports.isGxTarget = isGxTarget;
/**
 * Auto PLC-write dialog shown by works2 when a simulation starts (probe_w2_31,
 * 2026-10-01): a top-level #32770 titled exactly PLC写入. Without 「处理结束时
 * 自动关闭」checked it stays open forever after reaching 100/100% — the
 * simulator then runs an EMPTY program (SM400 scans but the logic never
 * transfers) — so the flow must click its 关闭 pushbutton (MSAA role 43).
 *
 * works3 的 Simulator3 启动同样弹写入对话框（标题不同，见 GX_SIM3_*），关闭
 * 按钮文案相同，故两代共用 GX_PLC_WRITE_CLOSE_BUTTON。
 */
exports.GX_PLC_WRITE_DIALOG_TITLE = 'PLC写入';
exports.GX_PLC_WRITE_CLOSE_BUTTON = '关闭';
// ---- GX Simulator3（works3）仿真流程常量（2026-10-02 真机校准） ----
/** 模拟开始按钮所在工具栏的 UIA Name（msaaClickMenu 的 menuBarName 参数） */
exports.GX_SIM3_SIMSTART_TOOLBAR = '程序通用';
/** 模拟开始命令名（工具栏项，MSAA StartsWith 前缀） */
exports.GX_SIM3_SIMSTART_ITEM = '模拟开始';
/** 启动仿真后自动弹出的写入对话框标题（精确匹配；进度到 100/100% 后点关闭） */
exports.GX_SIM3_WRITE_DIALOG_TITLE = '写入至可编程控制器';
/** GX Simulator3 模拟器进程名 */
exports.GX_SIM3_SIM_PROCESS = 'RSimRun3';
/** 仿真器面板窗口标题（realClickChild 的 title） */
exports.GX_SIM3_PANEL_TITLE = 'GX Simulator3';
/** SWITCH 面板 RUN 按钮名（真实鼠标单击；同面板 STOP 为切换停止） */
exports.GX_SIM3_SWITCH_RUN_BUTTON = 'RUN';
const WORKS3_PROFILE = {
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
        // Calibrated live 2026-10-02: 模拟开始 lives on the 程序通用 toolbar (NOT
        // 菜单栏) — the sim-start click pins menuBarName=程序通用 (see sim
        // locators) so same-caption buttons on other toolbars are never hit.
        simStartMenuItem: { names: [exports.GX_SIM3_SIMSTART_ITEM] },
        // Bottom dock pane content sits under XTPDockingPaneTabbedContainer →
        // Afx:00300000:0 → #32770; pane lookup kept for the generic grid fallback.
        outputPane: { names: ['输出', 'Output', '出力'], controlType: 'Window' }
    },
    msaa: {
        toolbarClassName: 'XTPToolBar',
        compileDialogClassName: '#32770',
        // Calibrated live 2026-10-02: the 全部转换 confirm (title 全部转换, buttons
        // 确定/取消/选项设置/维持/重新分配 + a 执行程序检查 checkbox) is an OWNED
        // TOP-LEVEL #32770, not a frame child — ENTER lands on the 确定 default.
        compileDialogScope: 'top-level',
        statusBarClassName: 'XTPStatusBar',
        dockContainerClassName: 'XTPDockingPaneTabbedContainer',
        outputListClassName: 'SysListView32',
        // Calibrated live 2026-10-02: visible rows are app-painted; only the
        // x86-layout LVM route returns cell text (see outputListReader doc).
        outputListReader: 'lvm',
        // The menu bar XTPToolBar's window text == UIA Name == 菜单栏 (hwnd
        // 0x21376 live); windowOps msaaClickMenu matches it through Win32
        // EnumChildWindows — UIA FindAll(Descendants) over this frame stalls >45s.
        menuBarName: '菜单栏',
        // Confirm via BM_CLICK 确定 — the foreground+ENTER path was refused by
        // the Windows foreground lock live (2026-10-02).
        confirmButtonName: '确定',
        minMenuPathSegments: 4
    },
    /**
     * Calibrated live 2026-10-02: converted-program error rows join as
     * "No | 结果 | 对象名 | 分类 | 内容 | 错误代码", e.g.
     * "1 | Error | ProgPou | 转换程序 | 语法有误。请确认错误前后的语法。 | 0x110E1A02".
     * Same 结果-cell rule as works2: match the exact Error cell so free text
     * containing 错误/エラー (e.g. the 错误代码 header) never classifies.
     */
    outputErrorPattern: /\|\s*Error\s*\|/,
    /**
     * Calibrated live 2026-10-02: the works3 ST editor is a .NET (WinForms)
     * custom control — there is NO classic text hwnd and the UIA tree is a
     * nested Pane stack. The editor host carries the generic WinForms class
     * "WindowsForms10.Window.8.app.<runtime-suffix>" (suffix observed
     * 0.1f550a4_r31_ad1); we match the version-stable PREFIX. The class-search
     * fallback cannot work for works3 (no stable exact name), so the fast path
     * — the app's CURRENT focused element while the editor is the active view —
     * is the only reliable route (focusEditor matches it by prefix).
     */
    editorFocusClassName: 'WindowsForms10.Window.8.app.',
    stRequiresStructuredProject: false,
    // Simulator3 start flow, calibrated live 2026-10-02 (see GxSimLocators doc):
    // 程序通用 toolbar 模拟开始 → 写入至可编程控制器 dialog auto-close at 100%
    // → RSimRun3 process → GX Simulator3 panel RUN button needs a REAL mouse
    // click (synthetic invoke does not flip it).
    sim: {
        simStartToolbarName: exports.GX_SIM3_SIMSTART_TOOLBAR,
        simWriteDialogTitle: exports.GX_SIM3_WRITE_DIALOG_TITLE,
        simWriteCloseButton: exports.GX_PLC_WRITE_CLOSE_BUTTON,
        simProcessName: exports.GX_SIM3_SIM_PROCESS,
        simPanelWindowTitle: exports.GX_SIM3_PANEL_TITLE,
        simSwitchRunButtonName: exports.GX_SIM3_SWITCH_RUN_BUTTON
    }
};
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
const WORKS2_PROFILE = {
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
        // Calibrated sim-start (probe_w2_27/29/30/31, 2026-10-01): a single BFS
        // click on the 模拟-prefixed item of the 菜单栏 XTPToolBar starts/stops the
        // simulator WITHOUT pre-expanding the menu. Clicking twice is expected
        // after a simulator kill: works2 still believes it is simulating, so the
        // first click takes the no-op stop path and only the second starts.
        simStartMenuItem: { names: ['模拟'] },
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
        minMenuPathSegments: 3,
        // Calibrated sim-start: the menu bar is the XTPToolBar whose UIA Name is
        // exactly 菜单栏 — other toolbars have same-caption 模拟 items that would
        // be clicked by mistake when only filtered by class name.
        menuBarName: '菜单栏'
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
};
exports.GX_PROFILES = {
    works3: WORKS3_PROFILE,
    works2: WORKS2_PROFILE
};
function getGxProfile(target) {
    return exports.GX_PROFILES[target];
}
function isGxTarget(value) {
    return value === 'works3' || value === 'works2';
}
/** Control types accepted when locating the Output window grid (readGrid fallback). */
exports.GX_OUTPUT_GRID_CONTROL_TYPES = ['DataGrid', 'Table', 'Custom', 'List'];
/**
 * Locale-neutral error-line heuristic for Output text (works3: 待校准 exact
 * prefixes; works2 overrides this with its profile.outputErrorPattern because
 * its rows are cell joins classified by the 结果 column, see WORKS2_PROFILE).
 */
exports.GX_OUTPUT_ERROR_PATTERN = /error|错误|エラー/i;
/**
 * Clipboard keys used by the ST editor round-trip. SendKeys syntax
 * ("^a" = Ctrl+A, "^v" = Ctrl+V, "^c" = Ctrl+C) — the ST editor does not
 * expose a UIA TextPattern, so paste/read-back via clipboard is the only
 * text channel (researched: community gxworks3-mcp-bridge).
 */
exports.GX_ST_SELECT_ALL_KEYS = '^a';
exports.GX_ST_COPY_KEYS = '^c';
exports.GX_ST_PASTE_KEYS = '^v';
/**
 * ENTER sent to the FOREGROUND modal rebuild dialog. Calibrated: BM_CLICK and
 * accDoDefaultAction on 确定 merely close the dialog WITHOUT running the
 * build — only ENTER on the foregrounded dialog actually starts the conversion.
 */
exports.GX_BUILD_CONFIRM_KEYS = '{ENTER}';
/** Simulator processes killed for a clean restart before works2 gx_sim_start. */
exports.GX_SIM_PROCESS_NAMES = ['QuteSimRun', 'SimManager'];
