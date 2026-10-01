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
exports.GX_BUILD_CONFIRM_KEYS = exports.GX_ST_PASTE_KEYS = exports.GX_ST_COPY_KEYS = exports.GX_ST_SELECT_ALL_KEYS = exports.GX_OUTPUT_ERROR_PATTERN = exports.GX_OUTPUT_GRID_CONTROL_TYPES = exports.GX_PROFILES = void 0;
exports.getGxProfile = getGxProfile;
exports.isGxTarget = isGxTarget;
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
};
/**
 * GX Works2 candidates (待校准 — no live Works2 probe run yet): per MELSOFT
 * documentation the top menu is 转换(C) / Convert(C) with a 全部转换 /
 * Rebuild All item, and Works2 shares the Codejock-drawn shell, so the Works3
 * mechanism/values are mirrored as placeholders. ST injection requires a
 * STRUCTURED project (结构化工程) — simple ladder projects have no ST editor.
 */
const WORKS2_PROFILE = {
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
/**
 * ENTER sent to the FOREGROUND modal rebuild dialog. Calibrated: BM_CLICK and
 * accDoDefaultAction on 确定 merely close the dialog WITHOUT running the
 * build — only ENTER on the foregrounded dialog actually starts the conversion.
 */
exports.GX_BUILD_CONFIRM_KEYS = '{ENTER}';
