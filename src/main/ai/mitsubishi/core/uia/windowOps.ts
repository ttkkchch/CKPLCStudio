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
  GX_PLC_WRITE_CLOSE_BUTTON,
  GX_PLC_WRITE_DIALOG_TITLE,
  GX_SIM_PROCESS_NAMES,
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
  /** stray confirm dialogs (left by earlier failed runs) closed before this build */
  strayDialogsClosed?: number
}

export interface SimStartResult {
  ok: true
  /** works2 main window title the flow attached to */
  title: string
  /** simulator processes force-killed for a clean restart, as name(pids) */
  killedProcesses: string[]
  /** stray dialogs dismissed with ESC before the menu click */
  strayDialogsClosed: number
  /** 模拟 menu clicks sent (1 = fresh start, 2 = restart after the kill) */
  simClicks: number
  /** MSAA evidence path of the LAST 模拟 menu click */
  simMenuPath: string
  /** how the auto PLC写入 dialog ended */
  plcWriteClosedBy: 'close-button' | 'auto' | 'not-seen'
  /** last progress text observed inside the PLC写入 dialog */
  lastProgress?: string
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
  /** per-click wait for the QuteSimRun process after a 模拟 menu click (ms) */
  simProcessWaitMs?: number
  /** hard deadline for the PLC写入 dialog to finish writing (ms) */
  plcWriteTimeoutMs?: number
  /** how long the PLC写入 dialog may take to first appear (ms) */
  plcWriteGraceMs?: number
  /** GX Works generation to operate on (default 'works3') */
  target?: GxTarget
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Editors normalize line endings and may append a trailing newline on select-all copy.
 */
export function normalizeEditorText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

/**
 * Sentinel overwriting the clipboard BEFORE the select-all+copy round-trip:
 * when keyboard focus is NOT in a text control, the copy writes NOTHING and
 * the sentinel survives the read-back — catching the false-MATCH where the
 * clipboard still simply holds the pasted code (observed live on works2:
 * focus landed on the project-tree item, the build then compiled stale code).
 */
function makeVerifySentinel(): string {
  return `gx-ckplcstudio-verify:${Date.now()}:${Math.random().toString(36).slice(2)}`
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
  private readonly simProcessWaitMs: number
  private readonly plcWriteTimeoutMs: number
  private readonly plcWriteGraceMs: number
  private readonly profile: GxPlatformProfile

  constructor(worker: PsWorkerLike, options: WindowOpsOptions = {}) {
    this.worker = worker
    this.sleep = options.sleep ?? defaultSleep
    this.pollMs = options.pollMs ?? 800
    this.settlePolls = options.settlePolls ?? 2
    this.buildTimeoutMs = options.buildTimeoutMs ?? 120_000
    this.dialogWaitMs = options.dialogWaitMs ?? 3_000
    this.simProcessWaitMs = options.simProcessWaitMs ?? 8_000
    this.plcWriteTimeoutMs = options.plcWriteTimeoutMs ?? 60_000
    this.plcWriteGraceMs = options.plcWriteGraceMs ?? 15_000
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
   * Focus the ST editor of a block. Calibrated works2 path first: the editor
   * is an unnamed RichEdit20W, so (a) when the app's current focus already IS
   * that control, trust it, and (b) otherwise search by class name — the
   * name-based fallback may land on the project-tree item with the same
   * caption. Call sites must treat the keyboard round-trip mismatch as a
   * focusing failure (writeSt also guards it with a clipboard sentinel).
   */
  async focusEditor(handle: number, blockName: string): Promise<ElementInfo> {
    const editorCls = this.profile.editorFocusClassName
    if (editorCls) {
      try {
        const cur = await this.worker.call<{ info?: ElementInfo }>('getFocusedElement')
        // Prefix match: works3's editor host class carries a .NET runtime
        // suffix ("WindowsForms10.Window.8.app.<suffix>") that can drift with
        // the installed runtime — the version-stable prefix is the contract.
        if (cur.info?.className?.startsWith(editorCls)) return cur.info
      } catch {
        /* focused-element probe unavailable — fall through to searching */
      }
    }
    const attempts: Array<{ names?: string[]; controlTypes?: string[]; classNames?: string[] }> = []
    if (editorCls) attempts.push({ classNames: [editorCls] })
    attempts.push(
      { names: [blockName], controlTypes: ['Document', 'Edit'] },
      { names: [blockName], controlTypes: ['TabItem'] },
      { names: [blockName] }
    )
    let lastError = ''
    for (const attempt of attempts) {
      try {
        const res = await this.worker.call<{ focused: ElementInfo }>('focusElement', {
          rootHandle: handle,
          names: attempt.names,
          controlTypes: attempt.controlTypes,
          classNames: attempt.classNames
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
      const sentinel = makeVerifySentinel()
      await this.worker.call('clipboardWrite', { text: sentinel })
      await this.worker.call('sendKeys', { keys: GX_ST_SELECT_ALL_KEYS })
      await this.worker.call('sendKeys', { keys: GX_ST_COPY_KEYS })
      const got = await this.worker.call<{ text: string }>('clipboardRead')
      const want = normalizeEditorText(params.stCode)
      const have = normalizeEditorText(got.text)
      if (got.text === sentinel) {
        throw new Error(
          `ST 写入失败：复制回读未发生（剪贴板哨兵未被覆盖）——键盘焦点大概率不在 "${params.blockName}" 的` +
            `ST 编辑器内，请确认该块的编辑器已打开并处于活动状态`
        )
      }
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
      const sentinel = makeVerifySentinel()
      await this.worker.call('clipboardWrite', { text: sentinel })
      await this.worker.call('sendKeys', { keys: GX_ST_SELECT_ALL_KEYS })
      await this.worker.call('sendKeys', { keys: GX_ST_COPY_KEYS })
      const got = await this.worker.call<{ text: string }>('clipboardRead')
      if (got.text === sentinel) {
        throw new Error(
          `ST 读取失败：复制回读未发生（剪贴板哨兵未被覆盖）——键盘焦点大概率不在 "${blockName}" 的 ST 编辑器内`
        )
      }
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
   *
   * Works2 (calibrated live 1.635M, 2026-10-01): the confirm dialog is an
   * OWNED TOP-LEVEL #32770 (title = main frame title, 是(Y) default) — ENTER
   * confirmed live twice. Results land ONLY in the VSFlexGrid8N grid (the
   * native status bar carries no compile info), so settle detection is
   * rows-only there and errors are classified by the 结果 cell via the
   * profile's outputErrorPattern.
   */
  async build(scope: 'all'): Promise<BuildResult> {
    if (scope !== 'all') {
      throw new Error(`暂不支持 scope=${scope}（当前仅支持 'all' 全程序编译）`)
    }
    const win = await this.attach()
    // MSAA menu clicks bypass modality: a stray confirm dialog left by a
    // previous failed run lets a NEW 全部转换 dialog stack on top, and the
    // confirm/close checks then see the leftover forever (live 2026-10-02,
    // two 全部转换 dialogs stacked). Close every visible titled top-level
    // confirm-class dialog up front — WM_CLOSE = 取消 semantics.
    let strayDialogsClosed = 0
    try {
      const stray = await this.worker.call<{ closed: number }>('closeTopDialogs', {
        rootHandle: win.handle,
        className: this.profile.msaa.compileDialogClassName ?? '#32770'
      })
      strayDialogsClosed = stray.closed ?? 0
    } catch {
      /* best-effort cleanup — the close-check below still guards the flow */
    }
    const baseline =
      (await this.readBuildSnapshot(win.handle)) ?? { rows: [], statusBarText: undefined, dockTabNames: undefined }
    const baselineRows = baseline.rows
    const baselineStatus = baseline.statusBarText ?? ''

    const item = this.profile.locators.compileAllMenuItem
    const itemName = (asNames(item.names) ?? [''])[0]
    const click = await this.worker.call<{ clicked: boolean; path: string }>('msaaClickMenu', {
      rootHandle: win.handle,
      itemName,
      toolbarClassName: this.profile.msaa.toolbarClassName,
      minSegments: this.profile.msaa.minMenuPathSegments
    })
    if (!click.clicked) {
      throw new Error(
        `MSAA 菜单点击失败（${click.path}）——未触发 ${itemName}；` +
          `请确认 ${this.profile.displayName} 已打开工程且窗口未最小化`
      )
    }

    const dialog = await this.findCompileDialog(win.handle)
    if (!dialog || !dialog.handle) {
      throw new Error(
        `已点击编译菜单（${click.path}）但未出现「${itemName}」对话框` +
          `（${this.profile.msaa.compileDialogClassName ?? '对话框类名未配置'}）——` +
          `请确认 ${this.profile.displayName} 版本受支持`
      )
    }
    // Confirm the dialog. Two strategies: click the named default button via
    // the MSAA clickDialogButton op (works3 — the Windows foreground lock
    // refused the foreground+ENTER path when the worker did not own the
    // foreground, live 2026-10-02), or foreground-verified ENTER (works2
    // live-calibrated).
    const confirmButton = this.profile.msaa.confirmButtonName
    if (confirmButton) {
      // Existing MSAA push-button click op (also drives the works2 PLC写入
      // close button): accDoDefaultAction on the button named confirmButton.
      const btnRes = await this.worker.call<{ clicked: boolean; result?: string }>('clickDialogButton', {
        handle: dialog.handle,
        name: confirmButton
      })
      if (!btnRes.clicked) {
        throw new Error(
          `「${itemName}」对话框上未点到「${confirmButton}」按钮（${btnRes.result ?? 'no-result'}）——请确认版本受支持`
        )
      }
    } else {
      // Refuse to send ENTER unless the dialog really owns the foreground —
      // otherwise the keystroke could land in an arbitrary window.
      const fgOk = await this.setForegroundVerified(dialog.handle)
      if (!fgOk) {
        throw new Error(`无法将「${itemName}」对话框置前——已放弃发送 ENTER（避免按键落入错误窗口），请重试`)
      }
      await this.worker.call('sendKeys', { keys: GX_BUILD_CONFIRM_KEYS })
    }

    if (this.profile.msaa.compileDialogScope === 'top-level') {
      // Works2 (live-calibrated): ENTER must CLOSE the confirm dialog and run
      // the compile. A dialog that stays visible means the keystroke never
      // triggered 是(Y) (e.g. it landed in a child MDI container) — hard-fail
      // instead of returning the PREVIOUS build's stale grid rows.
      const closeDeadline = Date.now() + this.dialogWaitMs
      let closed = false
      while (Date.now() < closeDeadline) {
        await this.sleep(150)
        if (!(await this.findDialogOnce(win.handle))) {
          closed = true
          break
        }
      }
      if (!closed) {
        throw new Error(
          `「${itemName}」确认对话框在 ENTER 后未关闭——编译可能未执行（对话框可能失焦）。请重试`
        )
      }
    }

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
            menuPath: click.path,
            strayDialogsClosed
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
      errors: lastRows.filter((line) => this.outputErrorPattern().test(line)),
      outputLines: lastRows,
      settled: stableCount >= this.settlePolls,
      changed: prevRows !== baselineRows.join('\n') || prevStatus !== baselineStatus,
      statusBarText: lastStatus || undefined,
      dockTabNames: lastTabs,
      menuPath: click.path,
      strayDialogsClosed
    }
  }

  /** Read the Output pane and keep only error-ish lines. */
  async getOutputErrors(): Promise<string[]> {
    const win = await this.attach()
    const lines = (await this.tryReadOutputLines(win.handle)) ?? []
    return lines.filter((line) => this.outputErrorPattern().test(line))
  }

  /**
   * Start GX Simulator2 from works2 and shepherd the automatic PLC write to
   * completion (works2 only — works3's Simulator3 flow is uncalibrated).
   *
   * Live-calibrated sequence (probe_w2_27/29/30/31, 2026-10-01):
   * 1. force-kill QuteSimRun/SimManager for a CLEAN restart — works2 then
   *    re-runs the auto PLC write on the next start instead of reusing a
   *    stale (post-kill zeroed) device image;
   * 2. ESC away stray top-level #32770 dialogs left by the kill (they would
   *    swallow the menu click);
   * 3. single-BFS MSAA click on the 模拟-prefixed item of the 菜单栏 toolbar,
   *    WITHOUT pre-expanding the menu (an expanded MSAA tree misleads the
   *    BFS). After a kill works2 still believes it is simulating, so the
   *    first click takes the no-op stop path — if QuteSimRun does not appear
   *    within `simProcessWaitMs`, click once more (verified restart toggle);
   * 4. watch the auto PLC写入 dialog (titled top-level #32770): without
   *    「处理结束时自动关闭」checked it sits at 100/100% forever and the
   *    simulator keeps running an EMPTY program — so once the progress text
   *    reaches 100/100%, click its 关闭 pushbutton (MSAA role 43) and verify
   *    the dialog closes.
   */
  async simStart(): Promise<SimStartResult> {
    if (this.profile.target !== 'works2') {
      throw new Error('gx_sim_start 目前仅支持 target=works2（GX Works3 的 Simulator3 启动流程尚未校准）')
    }
    const item = this.profile.locators.simStartMenuItem
    const menuBarName = this.profile.msaa.menuBarName
    if (!item || !menuBarName) {
      throw new Error(`${this.profile.displayName} profile 缺少仿真启动定位配置（simStartMenuItem/menuBarName）`)
    }
    const win = await this.attach()
    const itemName = (asNames(item.names) ?? [''])[0]

    // 1) Clean restart: kill any running simulator so works2 re-runs the auto
    //    PLC write instead of reusing the post-kill zeroed device image.
    const kill = await this.worker.call<{ killed: string[]; missing: string[] }>('stopProcess', {
      names: [...GX_SIM_PROCESS_NAMES]
    })
    await this.sleep(2000)

    // 2) Stray dialogs would swallow the menu click. They pop in WAVES after
    //    the kill (the disconnect error can lag several seconds), so scan,
    //    settle and scan a second time before clicking.
    let strayDialogsClosed = await this.closeStrayDialogs(win.handle)
    await this.sleep(3000)
    strayDialogsClosed += await this.closeStrayDialogs(win.handle)

    // 3) Start the simulation (double-click toggle after a kill — see above).
    //    A click op itself can time out when a late modal error dialog blocks
    //    the MSAA/UIA calls; the worker respawns lazily, so catch, re-ESC and
    //    retry with a generous per-op timeout.
    let simClicks = 0
    let simMenuPath = ''
    let running = false
    for (const attempt of [1, 2, 3]) {
      let click: { clicked: boolean; path: string }
      try {
        click = await this.worker.call<{ clicked: boolean; path: string }>(
          'msaaClickMenu',
          {
            rootHandle: win.handle,
            itemName,
            menuBarName,
            // Menu-bar BFS: a top menu item sits at 2 segments (root>模拟(S)); a
            // nested leaf at 3. BFS order clicks the shallowest match first.
            minSegments: 2
          },
          45_000
        )
      } catch (err) {
        simClicks = attempt
        simMenuPath = err instanceof Error ? err.message : String(err)
        await this.closeStrayDialogs(win.handle)
        continue
      }
      simClicks = attempt
      simMenuPath = click.path
      if (!click.clicked) {
        throw new Error(
          `MSAA 菜单点击失败（${click.path}）——未触发「${itemName}」菜单项；` +
            `请确认 ${this.profile.displayName} 已打开工程且窗口未最小化`
        )
      }
      running = await this.waitForSimProcess(this.simProcessWaitMs)
      if (running) break
    }
    if (!running) {
      throw new Error(
        `已点击「${itemName}」菜单 ${simClicks} 次但模拟器进程（QuteSimRun）始终未启动（最后一次: ${simMenuPath}）——` +
          `请确认工程支持模拟且通信设置正确`
      )
    }

    // 4) Shepherd the auto PLC write dialog (empty-program guard — see above).
    let plcWriteSeen = false
    let closedBy: SimStartResult['plcWriteClosedBy'] = 'not-seen'
    let lastProgress: string | undefined
    let gonePolls = 0
    const writeDeadline = Date.now() + this.plcWriteTimeoutMs
    const seenGraceDeadline = Date.now() + this.plcWriteGraceMs
    while (true) {
      await this.sleep(this.pollMs)
      const dlg = await this.findPlcWriteDialog(win.handle)
      if (!dlg || !dlg.handle) {
        if (!plcWriteSeen) {
          if (Date.now() >= seenGraceDeadline) break // never appeared — write finished instantly or not needed
          continue
        }
        gonePolls++
        if (gonePolls >= 2) {
          closedBy = 'auto' // vanished without our click (auto-close was checked)
          break
        }
        continue
      }
      plcWriteSeen = true
      gonePolls = 0
      let joined = ''
      try {
        const texts = await this.worker.call<{ texts: string[] }>('dialogProgress', { handle: dlg.handle })
        joined = (texts.texts ?? []).join(' ')
      } catch {
        /* transient MSAA hiccup — the next poll retries */
      }
      if (joined) lastProgress = joined
      if (!/\b100\s*\/\s*100\s*%/.test(joined)) {
        if (Date.now() >= writeDeadline) {
          throw new Error(
            `「${GX_PLC_WRITE_DIALOG_TITLE}」对话框在 ${Math.round(this.plcWriteTimeoutMs / 1000)}s 内未完成写入` +
              `（最后进度: ${lastProgress ?? '不可读'}）——请在对话框中勾选「处理结束时自动关闭」后重试`
          )
        }
        continue
      }
      // Progress complete — let the dialog settle, click 关闭, verify it closes.
      await this.sleep(1500)
      const click = await this.worker.call<{ clicked: boolean; result: string }>('clickDialogButton', {
        handle: dlg.handle,
        name: GX_PLC_WRITE_CLOSE_BUTTON
      })
      if (!click.clicked) {
        throw new Error(
          `「${GX_PLC_WRITE_DIALOG_TITLE}」已达 100% 但点击「${GX_PLC_WRITE_CLOSE_BUTTON}」失败（${click.result}）`
        )
      }
      closedBy = 'close-button'
      const goneDeadline = Date.now() + 5000
      while (await this.findPlcWriteDialog(win.handle)) {
        if (Date.now() >= goneDeadline) {
          throw new Error(`已点击「${GX_PLC_WRITE_CLOSE_BUTTON}」但「${GX_PLC_WRITE_DIALOG_TITLE}」对话框仍未关闭`)
        }
        await this.sleep(300)
      }
      break
    }

    return {
      ok: true,
      title: win.title,
      killedProcesses: kill.killed ?? [],
      strayDialogsClosed,
      simClicks,
      simMenuPath,
      plcWriteClosedBy: closedBy,
      lastProgress
    }
  }

  /** Poll for the simulator runtime process (the start-click success gate). */
  private async waitForSimProcess(waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs
    while (true) {
      const res = await this.worker.call<{ running: Array<{ name: string; pid: number }> }>('findProcess', {
        names: ['QuteSimRun']
      })
      if ((res.running ?? []).length > 0) return true
      if (Date.now() >= deadline) return false
      await this.sleep(500)
    }
  }

  /**
   * ESC away stray titled top-level #32770 dialogs of the works2 process
   * (error popups left by the force-killed simulator). Best-effort: each
   * dialog only receives ESC after it VERIFIABLY owns the foreground, and
   * failures are skipped.
   */
  private async closeStrayDialogs(mainHandle: number): Promise<number> {
    let closed = 0
    try {
      const res = await this.worker.call<{ dialogs: ElementInfo[] }>('findDialog', {
        rootHandle: mainHandle,
        className: '#32770',
        search: 'top-level'
      })
      for (const d of res.dialogs ?? []) {
        if (!d.handle) continue
        try {
          if (!(await this.setForegroundVerified(d.handle))) continue
          await this.worker.call('sendKeys', { keys: '{ESC}' })
          await this.sleep(300)
          closed++
        } catch {
          /* best-effort */
        }
      }
    } catch {
      /* dialog scan unavailable — proceed without dismissing */
    }
    return closed
  }

  /** The auto PLC写入 dialog: a titled top-level #32770 (pid-filtered scan). */
  private async findPlcWriteDialog(mainHandle: number): Promise<ElementInfo | null> {
    try {
      const res = await this.worker.call<{ dialogs: ElementInfo[] }>('findDialog', {
        rootHandle: mainHandle,
        className: '#32770',
        search: 'top-level'
      })
      return (res.dialogs ?? []).find((d) => d.name === GX_PLC_WRITE_DIALOG_TITLE) ?? null
    } catch {
      return null
    }
  }

  /** Per-generation error classifier (works2 classifies by the 结果 cell). */
  private outputErrorPattern(): RegExp {
    return this.profile.outputErrorPattern ?? GX_OUTPUT_ERROR_PATTERN
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

  /**
   * Poll briefly for the modal rebuild dialog. Works3: a main-window CHILD
   * (found via UIA descendants). Works2: an OWNED TOP-LEVEL window — the
   * worker's findDialog must run its pid-filtered top-level class scan
   * (compileDialogScope='top-level') or the ENTER would land in one of the
   * empty-titled child #32770 MDI containers instead.
   */
  private async findCompileDialog(handle: number): Promise<ElementInfo | null> {
    const cls = this.profile.msaa.compileDialogClassName
    if (!cls) return null
    const deadline = Date.now() + this.dialogWaitMs
    while (true) {
      const dlg = await this.findDialogOnce(handle)
      if (dlg) return dlg
      if (Date.now() >= deadline) return null
      await this.sleep(200)
    }
  }

  /** One findDialog attempt (null when nothing matches right now). */
  private async findDialogOnce(handle: number): Promise<ElementInfo | null> {
    const cls = this.profile.msaa.compileDialogClassName
    if (!cls) return null
    try {
      const res = await this.worker.call<{ dialogs: ElementInfo[] }>('findDialog', {
        rootHandle: handle,
        className: cls,
        search: this.profile.msaa.compileDialogScope === 'top-level' ? 'top-level' : undefined
      })
      return (res.dialogs ?? [])[0] ?? null
    } catch {
      /* transient UIA hiccup — callers poll until their deadline */
      return null
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
   * from "cannot read". Calibrated channels: works3 reads the SysListView32
   * report list through cross-process x86-layout LVM (rows are app-painted —
   * UIA/MSAA names are empty, and a UIA FindAll over the frame stalls >45s);
   * works2 reads the VSFlexGrid8N ActiveX grid through MSAA (rows always
   * include the header, classified by the 结果 cell). The generic readGrid
   * path remains as the last-resort fallback.
   */
  private async tryReadOutputLines(handle: number): Promise<string[] | null> {
    const listCls = this.profile.msaa.outputListClassName
    if (listCls) {
      try {
        const res = await this.worker.call<{
          lists: Array<{ rowCount: number; rows: string[]; hasHeader: boolean }>
        }>('readOutputList', {
          rootHandle: handle,
          className: listCls,
          reader: this.profile.msaa.outputListReader,
          maxRows: 400
        })
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
