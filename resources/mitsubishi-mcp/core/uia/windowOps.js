"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GxWindowOps = void 0;
exports.normalizeEditorText = normalizeEditorText;
/**
 * High-level GX Works3 / GX Works2 window operations built on the PS UIA
 * worker.
 *
 * The orchestration logic lives here (so it is unit-testable with a mock
 * worker); the PS script only provides primitives (find/focus/invoke,
 * clipboard, SendKeys, grid reading). All platform differences (window title,
 * menu names, structured-project constraint) come from the per-target
 * profile in locatorMap — one class serves both generations.
 *
 * ⚠ 待校准 (Phase 0): editor focusing and menu navigation depend on the real
 * GX Works UI tree; the strategies below are best-effort defaults pending a
 * live calibration run. Pure Node stdlib — compiled standalone.
 */
const node_crypto_1 = require("node:crypto");
const locatorMap_1 = require("./locatorMap");
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Editors normalize line endings and may append a trailing newline on select-all copy.
 */
function normalizeEditorText(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}
/**
 * Sentinel overwriting the clipboard BEFORE the select-all+copy round-trip:
 * when keyboard focus is NOT in a text control, the copy writes NOTHING and
 * the sentinel survives the read-back — catching the false-MATCH where the
 * clipboard still simply holds the pasted code (observed live on works2:
 * focus landed on the project-tree item, the build then compiled stale code).
 */
function makeVerifySentinel() {
    return `gx-ckplcstudio-verify:${Date.now()}:${Math.random().toString(36).slice(2)}`;
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
    dialogWaitMs;
    profile;
    constructor(worker, options = {}) {
        this.worker = worker;
        this.sleep = options.sleep ?? defaultSleep;
        this.pollMs = options.pollMs ?? 800;
        this.settlePolls = options.settlePolls ?? 2;
        this.buildTimeoutMs = options.buildTimeoutMs ?? 120_000;
        this.dialogWaitMs = options.dialogWaitMs ?? 3_000;
        this.profile = (0, locatorMap_1.getGxProfile)(options.target ?? 'works3');
    }
    /** Liveness probe (also warms up the PS worker). */
    async ping() {
        return this.worker.call('ping');
    }
    /**
     * Find the GX Works main window and bring it to the foreground.
     * `projectHint` narrows by title substring when several GX windows exist.
     */
    async attach(projectHint) {
        const { displayName, titleContains } = this.profile;
        const res = await this.worker.call('findWindow', {
            titleContains
        });
        const windows = res.windows ?? [];
        if (windows.length === 0) {
            throw new Error(`未找到 ${displayName} 主窗口——请先手动打开 ${displayName} 并加载工程`);
        }
        let picked = windows[0];
        if (projectHint) {
            const hit = windows.find((w) => (w.name ?? '').includes(projectHint));
            if (!hit) {
                throw new Error(`发现 ${windows.length} 个 ${displayName} 窗口，但没有标题包含 "${projectHint}" 的窗口；` +
                    `实际标题: ${windows.map((w) => w.name).join(' ; ')}`);
            }
            picked = hit;
        }
        const handle = picked.handle;
        if (!handle) {
            throw new Error(`${displayName} 主窗口缺少 Win32 句柄（UIA NativeWindowHandle 为 0）`);
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
     * Focus the ST editor of a block. Calibrated works2 path first: the editor
     * is an unnamed RichEdit20W, so (a) when the app's current focus already IS
     * that control, trust it, and (b) otherwise search by class name — the
     * name-based fallback may land on the project-tree item with the same
     * caption. Call sites must treat the keyboard round-trip mismatch as a
     * focusing failure (writeSt also guards it with a clipboard sentinel).
     */
    async focusEditor(handle, blockName) {
        const editorCls = this.profile.editorFocusClassName;
        if (editorCls) {
            try {
                const cur = await this.worker.call('getFocusedElement');
                if (cur.info?.className === editorCls)
                    return cur.info;
            }
            catch {
                /* focused-element probe unavailable — fall through to searching */
            }
        }
        const attempts = [];
        if (editorCls)
            attempts.push({ classNames: [editorCls] });
        attempts.push({ names: [blockName], controlTypes: ['Document', 'Edit'] }, { names: [blockName], controlTypes: ['TabItem'] }, { names: [blockName] });
        let lastError = '';
        for (const attempt of attempts) {
            try {
                const res = await this.worker.call('focusElement', {
                    rootHandle: handle,
                    names: attempt.names,
                    controlTypes: attempt.controlTypes,
                    classNames: attempt.classNames
                });
                return res.focused;
            }
            catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
            }
        }
        throw new Error(`未找到块 "${blockName}" 的编辑器（请确认该块已在 ${this.profile.displayName} 中打开为活动编辑器）` +
            `${this.profile.stRequiresStructuredProject ? '；GX Works2 仅结构化工程的 ST 程序有 ST 编辑器，请确认工程类型与 POU 语言' : ''}` +
            `；最后一次查找: ${lastError}`);
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
            const sentinel = makeVerifySentinel();
            await this.worker.call('clipboardWrite', { text: sentinel });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_SELECT_ALL_KEYS });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_COPY_KEYS });
            const got = await this.worker.call('clipboardRead');
            const want = normalizeEditorText(params.stCode);
            const have = normalizeEditorText(got.text);
            if (got.text === sentinel) {
                throw new Error(`ST 写入失败：复制回读未发生（剪贴板哨兵未被覆盖）——键盘焦点大概率不在 "${params.blockName}" 的` +
                    `ST 编辑器内，请确认该块的编辑器已打开并处于活动状态`);
            }
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
            const sentinel = makeVerifySentinel();
            await this.worker.call('clipboardWrite', { text: sentinel });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_SELECT_ALL_KEYS });
            await this.worker.call('sendKeys', { keys: locatorMap_1.GX_ST_COPY_KEYS });
            const got = await this.worker.call('clipboardRead');
            if (got.text === sentinel) {
                throw new Error(`ST 读取失败：复制回读未发生（剪贴板哨兵未被覆盖）——键盘焦点大概率不在 "${blockName}" 的 ST 编辑器内`);
            }
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
     * Trigger "compile all programs" and poll results until they settle.
     *
     * Calibrated flow (GX Works3 1.128J, 2026-10-01): the UI is Codejock-drawn —
     * the UIA tree has zero MenuItems, so the menu click goes through MSAA
     * (accDoDefaultAction with a min BFS depth to skip same-caption toolbar
     * buttons). The modal rebuild dialog MUST be confirmed with ENTER on the
     * FOREGROUND dialog: BM_CLICK / accDoDefaultAction on 确定 only close the
     * dialog without running the build. Completion detection is stability-based:
     * rows and the per-program status-bar text must stay unchanged for
     * `settlePolls` consecutive polls (Works3 keeps the Output list empty on a
     * clean build, so the status bar is the "something is happening" signal).
     *
     * Works2 (calibrated live 1.635M, 2026-10-01): the confirm dialog is an
     * OWNED TOP-LEVEL #32770 (title = main frame title, 是(Y) default) — ENTER
     * confirmed live twice. Results land ONLY in the VSFlexGrid8N grid (the
     * native status bar carries no compile info), so settle detection is
     * rows-only there and errors are classified by the 结果 cell via the
     * profile's outputErrorPattern.
     */
    async build(scope) {
        if (scope !== 'all') {
            throw new Error(`暂不支持 scope=${scope}（当前仅支持 'all' 全程序编译）`);
        }
        const win = await this.attach();
        const baseline = (await this.readBuildSnapshot(win.handle)) ?? { rows: [], statusBarText: undefined, dockTabNames: undefined };
        const baselineRows = baseline.rows;
        const baselineStatus = baseline.statusBarText ?? '';
        const item = this.profile.locators.compileAllMenuItem;
        const itemName = (asNames(item.names) ?? [''])[0];
        const click = await this.worker.call('msaaClickMenu', {
            rootHandle: win.handle,
            itemName,
            toolbarClassName: this.profile.msaa.toolbarClassName,
            minSegments: this.profile.msaa.minMenuPathSegments
        });
        if (!click.clicked) {
            throw new Error(`MSAA 菜单点击失败（${click.path}）——未触发 ${itemName}；` +
                `请确认 ${this.profile.displayName} 已打开工程且窗口未最小化`);
        }
        const dialog = await this.findCompileDialog(win.handle);
        if (!dialog || !dialog.handle) {
            throw new Error(`已点击编译菜单（${click.path}）但未出现「${itemName}」对话框` +
                `（${this.profile.msaa.compileDialogClassName ?? '对话框类名未配置'}）——` +
                `请确认 ${this.profile.displayName} 版本受支持`);
        }
        // Refuse to send ENTER unless the dialog really owns the foreground —
        // otherwise the keystroke could land in an arbitrary window.
        const fgOk = await this.setForegroundVerified(dialog.handle);
        if (!fgOk) {
            throw new Error(`无法将「${itemName}」对话框置前——已放弃发送 ENTER（避免按键落入错误窗口），请重试`);
        }
        await this.worker.call('sendKeys', { keys: locatorMap_1.GX_BUILD_CONFIRM_KEYS });
        if (this.profile.msaa.compileDialogScope === 'top-level') {
            // Works2 (live-calibrated): ENTER must CLOSE the confirm dialog and run
            // the compile. A dialog that stays visible means the keystroke never
            // triggered 是(Y) (e.g. it landed in a child MDI container) — hard-fail
            // instead of returning the PREVIOUS build's stale grid rows.
            const closeDeadline = Date.now() + this.dialogWaitMs;
            let closed = false;
            while (Date.now() < closeDeadline) {
                await this.sleep(150);
                if (!(await this.findDialogOnce(win.handle))) {
                    closed = true;
                    break;
                }
            }
            if (!closed) {
                throw new Error(`「${itemName}」确认对话框在 ENTER 后未关闭——编译可能未执行（对话框可能失焦）。请重试`);
            }
        }
        let prevRows = baselineRows.join('\n');
        let prevStatus = baselineStatus;
        let stableCount = 0;
        let readFailures = 0;
        let lastRows = baselineRows;
        let lastStatus = baselineStatus;
        let lastTabs = baseline.dockTabNames;
        const deadline = Date.now() + this.buildTimeoutMs;
        while (Date.now() < deadline) {
            await this.sleep(this.pollMs);
            const snap = await this.readBuildSnapshot(win.handle);
            if (snap === null) {
                readFailures++;
                if (readFailures >= 2) {
                    return {
                        errors: [],
                        outputLines: [],
                        settled: false,
                        changed: false,
                        outputUnavailable: true,
                        menuPath: click.path
                    };
                }
                continue;
            }
            readFailures = 0;
            const rowsText = snap.rows.join('\n');
            const status = snap.statusBarText ?? '';
            if (rowsText === prevRows && status === prevStatus) {
                stableCount++;
            }
            else {
                stableCount = 0;
                prevRows = rowsText;
                prevStatus = status;
                lastRows = snap.rows;
                lastStatus = status;
                lastTabs = snap.dockTabNames;
            }
            if (stableCount >= this.settlePolls)
                break;
        }
        return {
            errors: lastRows.filter((line) => this.outputErrorPattern().test(line)),
            outputLines: lastRows,
            settled: stableCount >= this.settlePolls,
            changed: prevRows !== baselineRows.join('\n') || prevStatus !== baselineStatus,
            statusBarText: lastStatus || undefined,
            dockTabNames: lastTabs,
            menuPath: click.path
        };
    }
    /** Read the Output pane and keep only error-ish lines. */
    async getOutputErrors() {
        const win = await this.attach();
        const lines = (await this.tryReadOutputLines(win.handle)) ?? [];
        return lines.filter((line) => this.outputErrorPattern().test(line));
    }
    /** Per-generation error classifier (works2 classifies by the 结果 cell). */
    outputErrorPattern() {
        return this.profile.outputErrorPattern ?? locatorMap_1.GX_OUTPUT_ERROR_PATTERN;
    }
    /** One build-poll sample: output rows + per-program status bar + dock tabs. */
    async readBuildSnapshot(handle) {
        const rows = await this.tryReadOutputLines(handle);
        if (rows === null)
            return null;
        const statusBarText = await this.readStatusBarText(handle);
        const dockTabNames = await this.readDockTabNames(handle);
        return { rows, statusBarText, dockTabNames };
    }
    async readStatusBarText(handle) {
        const cls = this.profile.msaa.statusBarClassName;
        if (!cls)
            return undefined;
        try {
            const res = await this.worker.call('findElements', {
                rootHandle: handle,
                classNames: [cls],
                maxResults: 1
            });
            return res.elements?.[0]?.name;
        }
        catch {
            return undefined;
        }
    }
    async readDockTabNames(handle) {
        const cls = this.profile.msaa.dockContainerClassName;
        if (!cls)
            return undefined;
        try {
            const res = await this.worker.call('findElements', {
                rootHandle: handle,
                classNames: [cls],
                maxResults: 8
            });
            return (res.elements ?? []).map((e) => e.name ?? '').filter((n) => n.length > 0);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Poll briefly for the modal rebuild dialog. Works3: a main-window CHILD
     * (found via UIA descendants). Works2: an OWNED TOP-LEVEL window — the
     * worker's findDialog must run its pid-filtered top-level class scan
     * (compileDialogScope='top-level') or the ENTER would land in one of the
     * empty-titled child #32770 MDI containers instead.
     */
    async findCompileDialog(handle) {
        const cls = this.profile.msaa.compileDialogClassName;
        if (!cls)
            return null;
        const deadline = Date.now() + this.dialogWaitMs;
        while (true) {
            const dlg = await this.findDialogOnce(handle);
            if (dlg)
                return dlg;
            if (Date.now() >= deadline)
                return null;
            await this.sleep(200);
        }
    }
    /** One findDialog attempt (null when nothing matches right now). */
    async findDialogOnce(handle) {
        const cls = this.profile.msaa.compileDialogClassName;
        if (!cls)
            return null;
        try {
            const res = await this.worker.call('findDialog', {
                rootHandle: handle,
                className: cls,
                search: this.profile.msaa.compileDialogScope === 'top-level' ? 'top-level' : undefined
            });
            return (res.dialogs ?? [])[0] ?? null;
        }
        catch {
            /* transient UIA hiccup — callers poll until their deadline */
            return null;
        }
    }
    /** Bring `handle` to the foreground and VERIFY it owns the foreground. */
    async setForegroundVerified(handle) {
        let fg = await this.worker.call('setForeground', { handle });
        if (!fg.nowForeground) {
            await this.sleep(200);
            fg = await this.worker.call('setForeground', { handle });
        }
        return fg.nowForeground;
    }
    /**
     * Read Output rows; null when nothing confidently readable exists (pane
     * closed or ambiguous candidates) so callers can distinguish "no output"
     * from "cannot read". Calibrated channels: works3 reads the SysListView32
     * report list through UIA (empty rows on a clean build); works2 reads the
     * VSFlexGrid8N ActiveX grid through MSAA (rows always include the header,
     * classified by the 结果 cell). The generic readGrid path remains as the
     * last-resort fallback.
     */
    async tryReadOutputLines(handle) {
        const listCls = this.profile.msaa.outputListClassName;
        if (listCls) {
            try {
                const res = await this.worker.call('readOutputList', {
                    rootHandle: handle,
                    className: listCls,
                    reader: this.profile.msaa.outputListReader,
                    maxRows: 400
                });
                const lists = res.lists ?? [];
                // Prefer the headered report list; a single candidate is trusted too.
                const best = lists.find((l) => l.hasHeader) ?? (lists.length === 1 ? lists[0] : undefined);
                if (best)
                    return best.rows ?? [];
                if (lists.length > 0)
                    return null; // lists exist but none confidently the Output one
                // no SysListView32 at all → try the generic grid reader
            }
            catch {
                /* fall through to the generic grid reader */
            }
        }
        try {
            const res = await this.worker.call('readGrid', {
                rootHandle: handle,
                paneNames: asNames(this.profile.locators.outputPane.names),
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
