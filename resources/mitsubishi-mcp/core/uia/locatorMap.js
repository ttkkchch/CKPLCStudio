"use strict";
/**
 * UI locator table for GX Works3 — the ONLY place that knows control names.
 *
 * ⚠ 待校准 (Phase 0): candidate names below are derived from GX Works3 menu
 * documentation, NOT from a live AutomationId/Name inspection. Before Phase A
 * ships to real users, run the calibration procedure (psWorker `listChildren`
 * / `findElements` probes against a real GX Works3 install, zh-CN and en-US)
 * and tighten the candidates. Keep this file data-only so calibration never
 * touches logic.
 *
 * Matching rules (see windowOps): `names` are OR'd as exact UIA Name matches,
 * first hit wins; `controlType` narrows the search when given.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GX_ST_PASTE_KEYS = exports.GX_ST_COPY_KEYS = exports.GX_ST_SELECT_ALL_KEYS = exports.GX_OUTPUT_ERROR_PATTERN = exports.GX_OUTPUT_GRID_CONTROL_TYPES = exports.GX_LOCATORS = exports.GX_MAIN_WINDOW_TITLE = void 0;
/**
 * Title substring used to find the GX Works3 main window. The frame title is
 * "<project> - [<view>] - GX Works3" (locale-independent suffix).
 */
exports.GX_MAIN_WINDOW_TITLE = 'GX Works3';
exports.GX_LOCATORS = {
    /** Main frame window (matched by title substring, not exact Name). */
    mainWindow: {
        names: ['GX Works3'],
        controlType: 'Window'
    },
    /** Top-level menu hosting compile commands ("转换/编译" family). */
    compileMenu: {
        names: ['转换/编译', 'Compile', '変換/コンパイル'],
        controlType: 'MenuItem'
    },
    /** Compile-all command inside the compile menu. */
    compileAllMenuItem: {
        names: ['全程序编译', '编译所有程序', 'Compile All Programs', '全プログラムコンパイル'],
        controlType: 'MenuItem'
    },
    /** Dockable Output window pane that receives build diagnostics. */
    outputPane: {
        names: ['输出', 'Output', '出力'],
        controlType: 'Window'
    }
};
/** Control types accepted when locating the Output window grid. */
exports.GX_OUTPUT_GRID_CONTROL_TYPES = ['DataGrid', 'Table', 'Custom'];
/**
 * Locale-neutral error-line heuristic for Output text (待校准: confirm the
 * exact prefixes GX Works3 emits, e.g. "エラー" / "错误" / "Error").
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
