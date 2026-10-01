"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GX_ST_PASTE_KEYS = exports.GX_ST_COPY_KEYS = exports.GX_ST_SELECT_ALL_KEYS = exports.GX_OUTPUT_ERROR_PATTERN = exports.GX_OUTPUT_GRID_CONTROL_TYPES = exports.GX_PROFILES = void 0;
exports.getGxProfile = getGxProfile;
exports.isGxTarget = isGxTarget;
const WORKS3_PROFILE = {
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
};
/**
 * GX Works2 candidates (待校准): the top menu is "转换(C)" (zh) / "Convert(C)"
 * (en) / "変換(C)" (ja), the rebuild-all item is "全部转换" / "Rebuild All",
 * and the output pane naming mirrors Works3. ST injection requires a
 * STRUCTURED project (结构化工程) — simple ladder projects have no ST editor.
 */
const WORKS2_PROFILE = {
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
/** Control types accepted when locating the Output window grid. */
exports.GX_OUTPUT_GRID_CONTROL_TYPES = ['DataGrid', 'Table', 'Custom'];
/**
 * Locale-neutral error-line heuristic for Output text (待校准: confirm the
 * exact prefixes each generation emits, e.g. "エラー" / "错误" / "Error").
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
