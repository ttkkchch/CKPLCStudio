"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GxWindowOps = void 0;
exports.normalizeEditorText = normalizeEditorText;
/**
 * High-level GX Works3 window operations built on the PS UIA worker.
 *
 * The orchestration logic lives here (so it is unit-testable with a mock
 * worker); the PS script only provides primitives (find/focus/invoke,
 * clipboard, SendKeys, grid reading).
 *
 * ⚠ 待校准 (Phase 0): editor focusing and menu navigation depend on the real
 * GX Works3 UI tree; the strategies below are best-effort defaults pending a
 * live calibration run. Pure Node stdlib — compiled standalone.
 */
const node_crypto_1 = require("node:crypto");
const locatorMap_1 = require("./locatorMap");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Editors normalize line endings and may append a trailing newline on select-all copy. */
function normalizeEditorText(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}
function shortHash(text) {
    return (0, node_crypto_1.createHash)('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}
function asNames(names) {
    return names && names.length > 0 ? [...names] : undefined;
}
class GxWindowOps {
    worker;
    sleep;
    pollMs;
    settlePolls;
    buildTimeoutMs;
    constructor(worker, options = {}) {
        this.worker = worker;
        this.sleep = options.sleep ?? defaultSleep;
        this.pollMs = options.pollMs ?? 800;
        this.settlePolls = options.settlePolls ?? 2;
        this.buildTimeoutMs = options.buildTimeoutMs ?? 120_000;
    }
    /** Liveness probe (also warms up the PS worker). */
    async ping() {
        return this.worker.call('ping');
    }
    /**
     * Find the GX Works3 main window and bring it to the foreground.
     * `projectHint` narrows by title substring when several GX windows exist.
     */
    async attach(projectHint) {
        const res = await this.worker.call('findWindow', {
            titleContains: locatorMap_1.GX_MAIN_WINDOW_TITLE
        });
        const windows = res.windows ?? [];
        if (windows.length === 0) {
            throw new Error('未找到 GX Works3 主窗口——请先手动打开 GX Works3 并加载工程');
        }
        let picked = windows[0];
        if (projectHint) {
            const hit = windows.find((w) => (w.name ?? '').includes(projectHint));
            if (!hit) {
                throw new Error(`发现 ${windows.length} 个 GX Works3 窗口，但没有标题包含 "${projectHint}" 的窗口；` +
                    `实际标题: ${windows.map((w) => w.name).join(' ; ')}`);
            }
            picked = hit;
        }
        const handle = picked.handle;
        if (!handle) {
            throw new Error('GX Works3 主窗口缺少 Win32 句柄（UIA NativeWindowHandle 为 0）');
        }
        // Foreground is best-effort: Windows foreground-lock may refuse the first try.
        let fg = await this.worker.call('setForeground', { handle });
        if (!fg.nowForeground) {
            await this.sleep(200);
            fg = await this.worker.call('setForeground', { handle });
        }
        return { handle, title: picked.name ?? '', className: picked.className };
    }
    /**
     * Focus the ST editor of a block. Strategy (待校准): Document/Edit control
     * named after the block first, then a TabItem, then any element with the
     * name. The bare-name fallback may land on the project tree item — call
     * sites must treat keyboard round-trip mismatch as a focusing failure.
     */
    async focusEditor(handle, blockName) {
        const attempts = [
            { names: [blockName], controlTypes: ['Document', 'Edit'] },
            { names: [blockName], controlTypes: ['TabItem'] },
            { names: [blockName] }
        ];
        let lastError = '';
        for (const attempt of attempts) {
            try {
                const res = await this.worker.call('focusElement', {
                    rootHandle: handle,
                    names: attempt.names,
                    controlTypes: attempt.controlTypes
                });
                return res.focused;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }
        throw new Error(`未找到块 "${blockName}" 的编辑器（请确认该块已在 GX Works3 中打开为活动编辑器）；最后一次查找: ${lastError}`);
    }
    /**
     * Write ST code into a block editor via clipboard paste and verify by
     * reading back with a hash comparison. Backs up and restores the user
     * clipboard (best-effort).
     *
     * 禁止在读写回不一致时继续编译/保存——调用方必须将 throw 视为未写入。
     */
    async writeSt(params) {
        const win = await this.attach();
        let clipboardBackup = null;
        try {
            const r = await this.worker.call('clipboardRead');
            clipboardBackup = r.text;
        }
        catch {
            /* keep null — restore skipped */
        }
        try {
            await this.focusEditor(win.handle, params.blockName);
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_SELECT_ALL_KEYS });
            await this.worker.call('clipboardWrite', { text: params.stCode });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_PASTE_KEYS });
            await this.sleep(150);
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_SELECT_ALL_KEYS });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_COPY_KEYS });
            const got = await this.worker.call('clipboardRead');
            const want = normalizeEditorText(params.stCode);
            const have = normalizeEditorText(got.text);
            if (have !== want) {
                throw new Error(`ST 写后读回不一致（未确认写入，禁止编译/保存）: 期望 ${want.length} 字符 sha256:${shortHash(want)}，` +
                    `实际 ${have.length} 字符 sha256:${shortHash(have)} —— 常见原因: 焦点不在目标编辑器`);
            }
            return { ok: true, chars: want.length, hash: shortHash(want) };
        }
        finally {
            if (clipboardBackup !== null) {
                try {
                    await this.worker.call('clipboardWrite', { text: clipboardBackup });
                }
                catch {
                    /* best-effort restore */
                }
            }
        }
    }
    /** Select all in the focused editor and read it back via clipboard. */
    async readSt(blockName) {
        const win = await this.attach();
        let clipboardBackup = null;
        try {
            const r = await this.worker.call('clipboardRead');
            clipboardBackup = r.text;
        }
        catch {
            /* keep null */
        }
        try {
            await this.focusEditor(win.handle, blockName);
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_SELECT_ALL_KEYS });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_COPY_KEYS });
            const got = await this.worker.call('clipboardRead');
            return { text: got.text };
        }
        finally {
            if (clipboardBackup !== null) {
                try {
                    await this.worker.call('clipboardWrite', { text: clipboardBackup });
                }
                catch {
                    /* best-effort */
                }
            }
        }
    }
    /**
     * Trigger "compile all programs" and poll the Output pane until it settles.
     * Completion detection is output-stability based (locale-neutral); exact
     * completion markers are 待校准.
     */
    async build(scope) {
        if (scope !== 'all') {
            throw new Error(`暂不支持 scope=${scope}（当前仅支持 'all' 全程序编译）`);
        }
        const win = await this.attach();
        const baseline = (await this.tryReadOutputLines(win.handle)) ?? [];
        const menu = locatorMap_1.GX_LOCATORS.compileMenu;
        await this.worker.call('invokeElement', {
            rootHandle: win.handle,
            names: asNames(menu.names),
            controlTypes: menu.controlType ? [menu.controlType] : undefined
        });
        await this.sleep(300);
        const item = locatorMap_1.GX_LOCATORS.compileAllMenuItem;
        await this.worker.call('invokeElement', {
            rootHandle: win.handle,
            names: asNames(item.names),
            controlTypes: item.controlType ? [item.controlType] : undefined
        });
        const baselineText = baseline.join('\n');
        let prev = baselineText;
        let stableCount = 0;
        let readFailures = 0;
        let last = baseline;
        const deadline = Date.now() + this.buildTimeoutMs;
        while (Date.now() < deadline) {
            await this.sleep(this.pollMs);
            const linesOrNull = await this.tryReadOutputLines(win.handle);
            if (linesOrNull === null) {
                readFailures++;
                if (readFailures >= 2) {
                    return {
                        errors: [],
                        outputLines: [],
                        settled: false,
                        changed: false,
                        outputUnavailable: true
                    };
                }
                continue;
            }
            readFailures = 0;
            const cur = linesOrNull.join('\n');
            if (cur === prev) {
                stableCount++;
            }
            else {
                stableCount = 0;
                prev = cur;
                last = linesOrNull;
            }
            if (stableCount >= this.settlePolls)
                break;
        }
        return {
            errors: last.filter((line) => locatorMap_1.GX_OUTPUT_ERROR_PATTERN.test(line)),
            outputLines: last,
            settled: stableCount >= this.settlePolls,
            changed: prev !== baselineText
        };
    }
    /** Read the Output pane and keep only error-ish lines (待校准 pattern). */
    async getOutputErrors() {
        const win = await this.attach();
        const lines = (await this.tryReadOutputLines(win.handle)) ?? [];
        return lines.filter((line) => locatorMap_1.GX_OUTPUT_ERROR_PATTERN.test(line));
    }
    /**
     * Read Output lines; resolves null when the pane/grid is absent (docking
     * layout differences) so callers can distinguish "no output" from
     * "cannot read".
     */
    async tryReadOutputLines(handle) {
        try {
            const res = await this.worker.call('readGrid', {
                rootHandle: handle,
                paneNames: asNames(locatorMap_1.GX_LOCATORS.outputPane.names),
                gridControlTypes: [...locatorMap_1.GX_OUTPUT_GRID_CONTROL_TYPES],
                maxRows: 400
            });
            return res.rows ?? [];
        }
        catch {
            return null;
        }
    }
}
exports.GxWindowOps = GxWindowOps;
