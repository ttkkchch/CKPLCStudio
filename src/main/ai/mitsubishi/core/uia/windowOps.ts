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
import { createHash } from 'node:crypto'

import {
  getGxProfile,
  GX_BUILD_CONFIRM_KEYS,
  GX_OUTPUT_ERROR_PATTERN,
  GX_OUTPUT_GRID_CONTROL_TYPES,
  GX_ST_COPY_KEYS,
  GX_ST_PASTE_KEYS,
  GX_ST_SELECT_ALL_KEYS,
  type GxPlatformProfile,
  type GxTarget
} from './locatorMap'

/** Minimal worker surface — tests inject a fake; production passes PsWorker. */
export interface PsWorkerLike {
  call<T = unknown>(op: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>
}

export interface ElementInfo {
  name?: string
  automationId?: string
  controlType?: string
  className?: string
  enabled?: boolean
  handle?: number
  processId?: number
}

export interface AttachResult {
  handle: number
  title: string
  className?: string
}

export interface WriteStResult {
  ok: true
  /** normalized (compared) character count */
  chars: number
  /** first 12 hex chars of the normalized-text sha256 */
  hash: string
}

export interface BuildResult {
  errors: string[]
  outputLines: string[]
  /** output stopped changing for `settlePolls` consecutive polls */
  settled: boolean
  /** any new output appeared compared to the pre-build baseline */
  changed: boolean
  /** output pane/grid never appeared (not opened or locator mismatch) */
  outputUnavailable?: boolean
  /** MSAA menu-click path evidence, e.g. "CLICKED root>转换(C)>转换(C)>全部转换(R)" */
  menuPath?: string
  /** XTPStatusBar UIA Name snapshot (per-program convert results) at settle time */
  statusBarText?: string
  /** bottom dock container UIA Names (each = its current active tab) */
  dockTabNames?: string[]
}

export interface WindowOpsOptions {
  sleep?: (ms: number) => Promise<void>
  /** build-output poll interval (ms) */
  pollMs?: number
  /** consecutive unchanged polls that mark the output settled */
  settlePolls?: number
  /** hard deadline for build polling (ms) */
  buildTimeoutMs?: number
  /** how long to wait for the modal rebuild dialog to appear (ms) */
  dialogWaitMs?: number
  /** GX Works generation to operate on (default 'works3') */
  target?: GxTarget
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Editors normalize line endings and may append a trailing newline on select-all copy. */
export function normalizeEditorText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

function shortHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

function asNames(names: readonly string[] | undefined): string[] | undefined {
  return names && names.length > 0 ? [...names] : undefined
}

export class GxWindowOps {
  private readonly worker: PsWorkerLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pollMs: number
  private readonly settlePolls: number
  private readonly buildTimeoutMs: number
  private readonly dialogWaitMs: number
  private readonly profile: GxPlatformProfile

  constructor(worker: PsWorkerLike, options: WindowOpsOptions = {}) {
    this.worker = worker
    this.sleep = options.sleep ?? defaultSleep
    this.pollMs = options.pollMs ?? 800
    this.settlePolls = options.settlePolls ?? 2
    this.buildTimeoutMs = options.buildTimeoutMs ?? 120_000
    this.dialogWaitMs = options.dialogWaitMs ?? 3_000
    this.profile = getGxProfile(options.target ?? 'works3')
  }

  /** Liveness probe (also warms up the PS worker). */
  async ping(): Promise<{ pid: number; sta: string; version: number }> {
    return this.worker.call('ping')
  }

  /**
   * Find the GX Works main window and bring it to the foreground.
   * `projectHint` narrows by title substring when several GX windows exist.
   */
  async attach(projectHint?: string): Promise<AttachResult> {
    const { displayName, titleContains } = this.profile
    const res = await this.worker.call<{ windows: ElementInfo[] }>('findWindow', {
      titleContains
    })
    const windows = res.windows ?? []
    if (windows.length === 0) {
      throw new Error(`未找到 ${displayName} 主窗口——请先手动打开 ${displayName} 并加载工程`)
    }
    let picked = windows[0]
    if (projectHint) {
      const hit = windows.find((w) => (w.name ?? '').includes(projectHint))
      if (!hit) {
        throw new Error(
          `发现 ${windows.length} 个 ${displayName} 窗口，但没有标题包含 "${projectHint}" 的窗口；` +
            `实际标题: ${windows.map((w) => w.name).join(' ; ')}`
        )
      }
      picked = hit
    }
    const handle = picked.handle
    if (!handle) {
      throw new Error(`${displayName} 主窗口缺少 Win32 句柄（UIA NativeWindowHandle 为 0）`)
    }
    // Foreground is best-effort: Windows foreground-lock may refuse the first try.
    let fg = await this.worker.call<{ foregrounded: boolean; nowForeground: boolean }>('setForeground', { handle })
    if (!fg.nowForeground) {
      await this.sleep(200)
      fg = await this.worker.call('setForeground', { handle })
    }
    return { handle, title: picked.name ?? '', className: picked.className }
  }

  /**
   * Focus the ST editor of a block. Strategy (待校准): Document/Edit control
   * named after the block first, then a TabItem, then any element with the
   * name. The bare-name fallback may land on the project tree item — call
   * sites must treat keyboard round-trip mismatch as a focusing failure.
   */
  async focusEditor(handle: number, blockName: string): Promise<ElementInfo> {
    const attempts: Array<{ names: string[]; controlTypes?: string[] }> = [
      { names: [blockName], controlTypes: ['Document', 'Edit'] },
      { names: [blockName], controlTypes: ['TabItem'] },
      { names: [blockName] }
    ]
    let lastError = ''
    for (const attempt of attempts) {
      try {
        const res = await this.worker.call<{ focused: ElementInfo }>('focusElement', {
          rootHandle: handle,
          names: attempt.names,
          controlTypes: attempt.controlTypes
        })
        return res.focused
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    throw new Error(
      `未找到块 "${blockName}" 的编辑器（请确认该块已在 ${this.profile.displayName} 中打开为活动编辑器）` +
        `${this.profile.stRequiresStructuredProject ? '；GX Works2 仅结构化工程的 ST 程序有 ST 编辑器，请确认工程类型与 POU 语言' : ''}` +
        `；最后一次查找: ${lastError}`
    )
  }

  /**
   * Write ST code into a block editor via clipboard paste and verify by
   * reading back with a hash comparison. Backs up and restores the user
   * clipboard (best-effort).
   *
   * 禁止在读写回不一致时继续编译/保存——调用方必须将 throw 视为未写入。
   */
  async writeSt(params: { blockName: string; stCode: string }): Promise<WriteStResult> {
    const win = await this.attach()
    let clipboardBackup: string | null = null
    try {
      const r = await this.worker.call<{ text: string }>('clipboardRead')
      clipboardBackup = r.text
    } catch {
      /* keep null — restore skipped */
    }
    try {
      await this.focusEditor(win.handle, params.blockName)
      await this.worker.call('sendKeys', { keys: GX_ST_SELECT_ALL_KEYS })
      await this.worker.call('clipboardWrite', { text: params.stCode })
      await this.worker.call('sendKeys', { keys: GX_ST_PASTE_KEYS })
      await this.sleep(150)
      await this.worker.call('sendKeys', { keys: GX_ST_SELECT_ALL_KEYS })
      await this.worker.call('sendKeys', { keys: GX_ST_COPY_KEYS })
      const got = await this.worker.call<{ text: string }>('clipboardRead')
      const want = normalizeEditorText(params.stCode)
      const have = normalizeEditorText(got.text)
      if (have !== want) {
        throw new Error(
          `ST 写后读回不一致（未确认写入，禁止编译/保存）: 期望 ${want.length} 字符 sha256:${shortHash(want)}，` +
            `实际 ${have.length} 字符 sha256:${shortHash(have)} —— 常见原因: 焦点不在目标编辑器`
        )
      }
      return { ok: true, chars: want.length, hash: shortHash(want) }
    } finally {
      if (clipboardBackup !== null) {
        try {
          await this.worker.call('clipboardWrite', { text: clipboardBackup })
        } catch {
          /* best-effort restore */
        }
      }
    }
  }

  /** Select all in the focused editor and read it back via clipboard. */
  async readSt(blockName: string): Promise<{ text: string }> {
    const win = await this.attach()
    let clipboardBackup: string | null = null
    try {
      const r = await this.worker.call<{ text: string }>('clipboardRead')
      clipboardBackup = r.text
    } catch {
      /* keep null */
    }
    try {
      await this.focusEditor(win.handle, blockName)
      await this.worker.call('sendKeys', { keys: GX_ST_SELECT_ALL_KEYS })
      await this.worker.call('sendKeys', { keys: GX_ST_COPY_KEYS })
      const got = await this.worker.call<{ text: string }>('clipboardRead')
      return { text: got.text }
    } finally {
      if (clipboardBackup !== null) {
        try {
          await this.worker.call('clipboardWrite', { text: clipboardBackup })
        } catch {
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
   */
  async build(scope: 'all'): Promise<BuildResult> {
    if (scope !== 'all') {
      throw new Error(`暂不支持 scope=${scope}（当前仅支持 'all' 全程序编译）`)
    }
    const win = await this.attach()
    const baseline =
      (await this.readBuildSnapshot(win.handle)) ?? { rows: [], statusBarText: undefined, dockTabNames: undefined }
    const baselineRows = baseline.rows
    const baselineStatus = baseline.statusBarText ?? ''

    const item = this.profile.locators.compileAllMenuItem
    const click = await this.worker.call<{ clicked: boolean; path: string }>('msaaClickMenu', {
      rootHandle: win.handle,
      itemName: (asNames(item.names) ?? [''])[0],
      toolbarClassName: this.profile.msaa.toolbarClassName,
      minSegments: this.profile.msaa.minMenuPathSegments
    })
    if (!click.clicked) {
      throw new Error(
        `MSAA 菜单点击失败（${click.path}）——未触发 全部转换；` +
          `请确认 ${this.profile.displayName} 已打开工程且窗口未最小化`
      )
    }

    const dialog = await this.findCompileDialog(win.handle)
    if (!dialog || !dialog.handle) {
      throw new Error(
        `已点击编译菜单（${click.path}）但未出现「全部转换」对话框` +
          `（${this.profile.msaa.compileDialogClassName ?? '对话框类名未配置'}）——` +
          `请确认 ${this.profile.displayName} 版本受支持`
      )
    }
    // Refuse to send ENTER unless the dialog really owns the foreground —
    // otherwise the keystroke could land in an arbitrary window.
    const fgOk = await this.setForegroundVerified(dialog.handle)
    if (!fgOk) {
      throw new Error('无法将「全部转换」对话框置前——已放弃发送 ENTER（避免按键落入错误窗口），请重试')
    }
    await this.worker.call('sendKeys', { keys: GX_BUILD_CONFIRM_KEYS })

    let prevRows = baselineRows.join('\n')
    let prevStatus = baselineStatus
    let stableCount = 0
    let readFailures = 0
    let lastRows = baselineRows
    let lastStatus = baselineStatus
    let lastTabs = baseline.dockTabNames
    const deadline = Date.now() + this.buildTimeoutMs

    while (Date.now() < deadline) {
      await this.sleep(this.pollMs)
      const snap = await this.readBuildSnapshot(win.handle)
      if (snap === null) {
        readFailures++
        if (readFailures >= 2) {
          return {
            errors: [],
            outputLines: [],
            settled: false,
            changed: false,
            outputUnavailable: true,
            menuPath: click.path
          }
        }
        continue
      }
      readFailures = 0
      const rowsText = snap.rows.join('\n')
      const status = snap.statusBarText ?? ''
      if (rowsText === prevRows && status === prevStatus) {
        stableCount++
      } else {
        stableCount = 0
        prevRows = rowsText
        prevStatus = status
        lastRows = snap.rows
        lastStatus = status
        lastTabs = snap.dockTabNames
      }
      if (stableCount >= this.settlePolls) break
    }

    return {
      errors: lastRows.filter((line) => GX_OUTPUT_ERROR_PATTERN.test(line)),
      outputLines: lastRows,
      settled: stableCount >= this.settlePolls,
      changed: prevRows !== baselineRows.join('\n') || prevStatus !== baselineStatus,
      statusBarText: lastStatus || undefined,
      dockTabNames: lastTabs,
      menuPath: click.path
    }
  }

  /** Read the Output pane and keep only error-ish lines (待校准 pattern). */
  async getOutputErrors(): Promise<string[]> {
    const win = await this.attach()
    const lines = (await this.tryReadOutputLines(win.handle)) ?? []
    return lines.filter((line) => GX_OUTPUT_ERROR_PATTERN.test(line))
  }

  /** One build-poll sample: output rows + per-program status bar + dock tabs. */
  private async readBuildSnapshot(
    handle: number
  ): Promise<{ rows: string[]; statusBarText?: string; dockTabNames?: string[] } | null> {
    const rows = await this.tryReadOutputLines(handle)
    if (rows === null) return null
    const statusBarText = await this.readStatusBarText(handle)
    const dockTabNames = await this.readDockTabNames(handle)
    return { rows, statusBarText, dockTabNames }
  }

  private async readStatusBarText(handle: number): Promise<string | undefined> {
    const cls = this.profile.msaa.statusBarClassName
    if (!cls) return undefined
    try {
      const res = await this.worker.call<{ elements: ElementInfo[] }>('findElements', {
        rootHandle: handle,
        classNames: [cls],
        maxResults: 1
      })
      return res.elements?.[0]?.name
    } catch {
      return undefined
    }
  }

  private async readDockTabNames(handle: number): Promise<string[] | undefined> {
    const cls = this.profile.msaa.dockContainerClassName
    if (!cls) return undefined
    try {
      const res = await this.worker.call<{ elements: ElementInfo[] }>('findElements', {
        rootHandle: handle,
        classNames: [cls],
        maxResults: 8
      })
      return (res.elements ?? []).map((e) => e.name ?? '').filter((n) => n.length > 0)
    } catch {
      return undefined
    }
  }

  /** Poll briefly for the modal rebuild dialog (a main-window child, not top-level). */
  private async findCompileDialog(handle: number): Promise<ElementInfo | null> {
    const cls = this.profile.msaa.compileDialogClassName
    if (!cls) return null
    const deadline = Date.now() + this.dialogWaitMs
    while (true) {
      try {
        const res = await this.worker.call<{ dialogs: ElementInfo[] }>('findDialog', {
          rootHandle: handle,
          className: cls
        })
        const dlg = (res.dialogs ?? [])[0]
        if (dlg) return dlg
      } catch {
        /* transient UIA hiccup — keep polling until the deadline */
      }
      if (Date.now() >= deadline) return null
      await this.sleep(200)
    }
  }

  /** Bring `handle` to the foreground and VERIFY it owns the foreground. */
  private async setForegroundVerified(handle: number): Promise<boolean> {
    let fg = await this.worker.call<{ foregrounded: boolean; nowForeground: boolean }>('setForeground', { handle })
    if (!fg.nowForeground) {
      await this.sleep(200)
      fg = await this.worker.call('setForeground', { handle })
    }
    return fg.nowForeground
  }

  /**
   * Read Output rows; null when nothing confidently readable exists (pane
   * closed or ambiguous candidates) so callers can distinguish "no output"
   * from "cannot read". Calibrated Works3 channel: the Output pane is a
   * SysListView32 report list (empty rows on a clean build). The generic
   * readGrid path remains as the fallback (Works2 待校准).
   */
  private async tryReadOutputLines(handle: number): Promise<string[] | null> {
    const listCls = this.profile.msaa.outputListClassName
    if (listCls) {
      try {
        const res = await this.worker.call<{
          lists: Array<{ rowCount: number; rows: string[]; hasHeader: boolean }>
        }>('readOutputList', { rootHandle: handle, className: listCls, maxRows: 400 })
        const lists = res.lists ?? []
        // Prefer the headered report list; a single candidate is trusted too.
        const best = lists.find((l) => l.hasHeader) ?? (lists.length === 1 ? lists[0] : undefined)
        if (best) return best.rows ?? []
        if (lists.length > 0) return null // lists exist but none confidently the Output one
        // no SysListView32 at all → try the generic grid reader
      } catch {
        /* fall through to the generic grid reader */
      }
    }
    try {
      const res = await this.worker.call<{ rows: string[] }>('readGrid', {
        rootHandle: handle,
        paneNames: asNames(this.profile.locators.outputPane.names),
        gridControlTypes: [...GX_OUTPUT_GRID_CONTROL_TYPES],
        maxRows: 400
      })
      return res.rows ?? []
    } catch {
      return null
    }
  }
}
