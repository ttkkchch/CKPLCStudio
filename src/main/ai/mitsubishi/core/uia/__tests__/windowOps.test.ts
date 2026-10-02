import { describe, expect, it } from 'vitest'

import {
  getGxProfile,
  GX_BUILD_CONFIRM_KEYS,
  GX_OUTPUT_ERROR_PATTERN,
  GX_PROFILES,
  GX_ST_COPY_KEYS,
  GX_ST_PASTE_KEYS,
  GX_ST_SELECT_ALL_KEYS
} from '../locatorMap'
import { GxWindowOps, type ElementInfo, type PsWorkerLike, type WindowOpsOptions } from '../windowOps'

/** Simulates the PowerShell worker semantics used by GxWindowOps. */
class FakeWorker implements PsWorkerLike {
  calls: Array<{ op: string; params: Record<string, unknown> }> = []
  windows: ElementInfo[] = [{ name: 'ProjA - [Prog] - GX Works3', handle: 100, controlType: 'Window' }]
  clipboard = ''
  editorContent = 'old content'
  pasteEnabled = true
  /** false → the select-all+copy writes nothing (focus not in a text control). */
  copyEnabled = true
  /** UIA className reported by the getFocusedElement probe. */
  focusedClassName = ''
  focusOk = true
  /** null → output reads throw (pane absent); else called per output read. */
  readRows: (() => string[]) | null = () => []
  menuClickOk = true
  dialogFound = true
  /** true → the confirm dialog survives ENTER (build must hard-fail on works2). */
  dialogSticks = false
  foregroundOk = true
  /** XTPStatusBar UIA Name per status-bar read (function = dynamic sequence). */
  statusText: string | (() => string) = ''
  dockTabs: string[] = ['输出']
  /** Running simulator process names reported by findProcess. */
  processes: string[] = []
  /** null → legacy dialog behavior; else the per-call top-level dialog list. */
  plcWriteDialogs: (() => ElementInfo[]) | null = null
  /** PLC写入 progress texts per dialogProgress call (function = dynamic). */
  plcWriteTexts: (() => string[]) | null = null
  clickDialogButtonOk = true
  /** >0 → the next N msaaClickMenu ops throw (simulated op timeout). */
  menuClickFailTimes = 0
  /** true → the works3 SWITCH-panel RUN real-mouse click succeeds. */
  realClickOk = true
  /** Hook fired on every MSAA menu click (drives simulated sim start). */
  onMenuClick?: () => void
  /** Hook fired when the dialog button click succeeds. */
  onDialogButtonClick?: () => void

  async call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params })
    switch (op) {
      case 'findWindow':
        return {
          windows: this.windows.filter((w) => !params.titleContains || (w.name ?? '').includes(String(params.titleContains)))
        } as T
      case 'setForeground':
        return { foregrounded: this.foregroundOk, nowForeground: this.foregroundOk } as T
      case 'clipboardRead':
        return { text: this.clipboard } as T
      case 'clipboardWrite':
        this.clipboard = String(params.text)
        return { written: true } as T
      case 'sendKeys': {
        const keys = String(params.keys)
        if (keys === GX_ST_PASTE_KEYS && this.pasteEnabled) {
          // Editors normalize CRLF and may append a trailing newline.
          this.editorContent = this.clipboard.replace(/\r\n/g, '\n') + '\n'
        }
        if (keys === GX_ST_COPY_KEYS && this.copyEnabled) this.clipboard = this.editorContent
        // ENTER on the confirm dialog closes it (unless dialogSticks).
        if (keys === GX_BUILD_CONFIRM_KEYS && !this.dialogSticks) this.dialogFound = false
        return { sent: keys } as T
      }
      case 'getFocusedElement':
        return { info: { className: this.focusedClassName } } as T
      case 'focusElement':
        if (!this.focusOk) throw new Error('element not found (focusElement)')
        return { focused: { name: String((params.names as string[])[0]) } } as T
      case 'msaaClickMenu': {
        const item = String(params.itemName)
        if (this.menuClickFailTimes > 0) {
          this.menuClickFailTimes--
          throw new Error('op "msaaClickMenu" timed out after 20000ms; worker killed')
        }
        this.onMenuClick?.()
        if (!this.menuClickOk) {
          const miss = `NOT-FOUND(123) for ${item}`
          return { clicked: false, result: miss, path: miss, barIndex: 0, strategy: 'root' } as T
        }
        const path = `CLICKED root>转换(C)>转换(C)>${item}(R)`
        return { clicked: true, result: path, path, barIndex: 1, strategy: 'toolbar' } as T
      }
      case 'findDialog': {
        if (this.plcWriteDialogs) {
          const list = this.plcWriteDialogs()
          return { dialogs: list, total: list.length } as T
        }
        if (!this.dialogFound) return { dialogs: [], total: 0 } as T
        return {
          dialogs: [{ handle: 200, name: '全部转换', className: String(params.className), controlType: 'Window' }],
          total: 1
        } as T
      }
      case 'stopProcess': {
        const names = (params.names as string[]) ?? []
        return {
          killed: names.filter((n) => n === 'QuteSimRun').map((n) => `${n}(123)`),
          missing: names.filter((n) => n !== 'QuteSimRun')
        } as T
      }
      case 'findProcess':
        return { running: this.processes.map((name, i) => ({ name, pid: 1000 + i })) } as T
      case 'realClickChild': {
        if (!this.realClickOk) {
          throw new Error(`element not found (realClickChild: ${String(params.childName)})`)
        }
        return { clicked: true, name: String(params.childName), x: 120, y: 80, handle: 900 } as T
      }
      case 'dialogProgress': {
        if (!this.plcWriteTexts) return { texts: [] } as T
        return { texts: this.plcWriteTexts() } as T
      }
      case 'clickDialogButton': {
        if (!this.clickDialogButtonOk) return { clicked: false, result: 'NOT-FOUND(42)' } as T
        this.onDialogButtonClick?.()
        // The confirm dialog closes on its default button, mirroring ENTER.
        if (!this.dialogSticks) this.dialogFound = false
        return { clicked: true, result: 'CLICKED D>c2 [关闭]' } as T
      }
      case 'closeTopDialogs':
        return { closed: 0, titles: [] } as T
      case 'findElements': {
        const cls = (params.classNames as string[] | undefined)?.[0] ?? ''
        if (cls === 'XTPStatusBar') {
          const name = typeof this.statusText === 'function' ? this.statusText() : this.statusText
          return { elements: name ? [{ name, className: cls }] : [], total: name ? 1 : 0 } as T
        }
        if (cls === 'XTPDockingPaneTabbedContainer') {
          return {
            elements: this.dockTabs.map((name) => ({ name, className: cls })),
            total: this.dockTabs.length
          } as T
        }
        return { elements: [], total: 0 } as T
      }
      case 'readOutputList': {
        if (this.readRows === null) throw new Error('readOutputList: window handle no longer valid')
        const rows = this.readRows()
        return { lists: [{ rowCount: rows.length, rows, hasHeader: true }] } as T
      }
      case 'readGrid': {
        if (this.readRows === null) throw new Error('grid element not found (readGrid)')
        const rows = this.readRows()
        return { rows, rowCount: rows.length } as T
      }
      default:
        throw new Error(`no fake handler for op ${op}`)
    }
  }

  writes(): Array<string> {
    return this.calls.filter((c) => c.op === 'clipboardWrite').map((c) => String(c.params.text))
  }
}

function makeOps(fake: FakeWorker, extra: Partial<WindowOpsOptions> = {}): GxWindowOps {
  return new GxWindowOps(fake, {
    sleep: () => Promise.resolve(),
    pollMs: 1,
    settlePolls: 2,
    buildTimeoutMs: 5000,
    dialogWaitMs: 1,
    ...extra
  })
}

describe('locatorMap', () => {
  it('gives every locator of every target at least one candidate name', () => {
    for (const [target, profile] of Object.entries(GX_PROFILES)) {
      for (const [key, locator] of Object.entries(profile.locators)) {
        expect(locator.names.length, `${target}.${key}`).toBeGreaterThan(0)
        for (const name of locator.names) expect(name.length, `${target}.${key}`).toBeGreaterThan(0)
      }
      expect(profile.titleContains.length, target).toBeGreaterThan(0)
    }
  })

  it('profiles the two generations with their window titles and ST constraints', () => {
    expect(getGxProfile('works3').titleContains).toBe('GX Works3')
    expect(getGxProfile('works2').titleContains).toBe('GX Works2')
    expect(getGxProfile('works3').stRequiresStructuredProject).toBe(false)
    expect(getGxProfile('works2').stRequiresStructuredProject).toBe(true)
  })

  it('carries the calibrated MSAA parameters for both generations', () => {
    const w3 = getGxProfile('works3')
    expect(w3.msaa.toolbarClassName).toBe('XTPToolBar')
    expect(w3.msaa.compileDialogClassName).toBe('#32770')
    expect(w3.msaa.statusBarClassName).toBe('XTPStatusBar')
    expect(w3.msaa.dockContainerClassName).toBe('XTPDockingPaneTabbedContainer')
    expect(w3.msaa.outputListClassName).toBe('SysListView32')
    expect(w3.msaa.minMenuPathSegments).toBeGreaterThanOrEqual(4)
    // Calibrated MSAA StartsWith prefixes (1.128J zh-CN).
    expect(w3.locators.compileMenu.names).toContain('转换(')
    expect(w3.locators.compileAllMenuItem.names).toContain('全部转换')
    // Calibrated works2 (GD2/GPPW2 zh-CN, 2026-10-01): 3-segment menu tree,
    // VSFlexGrid8N output grid, native MFC status bar.
    const w2 = getGxProfile('works2')
    expect(w2.msaa.statusBarClassName).toBe('msctls_statusbar32')
    expect(w2.msaa.outputListClassName).toBe('VSFlexGrid8N')
    expect(w2.msaa.minMenuPathSegments).toBe(3)
    expect(w2.locators.compileMenu.names).toContain('转换/编译(')
    expect(w2.locators.compileAllMenuItem.names).toContain('转换(+全部编译)')
    // Calibrated build chain (structured project, 2026-10-01): VSFlexGrid8N is
    // read through MSAA, errors are the exact 结果 cell, status bar has no
    // compile info so settle is rows-only.
    expect(w2.msaa.outputListReader).toBe('msaa-grid')
    expect(w2.outputErrorPattern).toBeInstanceOf(RegExp)
    expect(w2.outputErrorPattern?.test('1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042')).toBe(true)
    expect(w2.outputErrorPattern?.test('No. | 结果 | 数据名 | 分类 | 内容 | 错误代码')).toBe(false)
    expect(w2.outputErrorPattern?.test('1 | CheckWarning | POU_01 | 双线圈 | C9300')).toBe(false)
    // Calibrated works3 (GXW3 1.128J zh-CN, 2026-10-02): LVM reader (UIA/MSAA
    // names come back empty — rows are app-painted), 结果-cell error rule,
    // top-level 全部转换 confirm via the 确定 button, menu bar matched by
    // Win32 window text.
    expect(w3.msaa.outputListReader).toBe('lvm')
    expect(w3.msaa.compileDialogScope).toBe('top-level')
    expect(w3.msaa.menuBarName).toBe('菜单栏')
    expect(w3.msaa.confirmButtonName).toBe('确定')
    expect(
      w3.outputErrorPattern?.test('1 | Error | ProgPou | 转换程序 | 语法有误。请确认错误前后的语法。 | 0x110E1A02')
    ).toBe(true)
    expect(w3.outputErrorPattern?.test('1 | CheckWarning | ProgPou | 二重线圈 | C9300')).toBe(false)
    for (const profile of Object.values(GX_PROFILES)) {
      expect(profile.msaa.toolbarClassName.length).toBeGreaterThan(0)
      expect(profile.msaa.minMenuPathSegments).toBeGreaterThan(0)
    }
  })

  it('keeps the SendKeys constants and the error pattern well-formed', () => {
    expect(GX_ST_SELECT_ALL_KEYS).toBe('^a')
    expect(GX_ST_COPY_KEYS).toBe('^c')
    expect(GX_ST_PASTE_KEYS).toBe('^v')
    expect(GX_OUTPUT_ERROR_PATTERN).toBeInstanceOf(RegExp)
  })
})

describe('GxWindowOps.attach', () => {
  it('finds the main window and brings it to the foreground', async () => {
    const fake = new FakeWorker()
    const ops = makeOps(fake)
    const result = await ops.attach()
    expect(result.handle).toBe(100)
    expect(fake.calls.some((c) => c.op === 'setForeground')).toBe(true)
  })

  it('prefers the window matching the project hint', async () => {
    const fake = new FakeWorker()
    fake.windows = [
      { name: 'Other - GX Works3', handle: 1 },
      { name: 'ProjB - GX Works3', handle: 2 }
    ]
    const result = await makeOps(fake).attach('ProjB')
    expect(result.handle).toBe(2)
  })

  it('fails with an actionable message when no window exists', async () => {
    const fake = new FakeWorker()
    fake.windows = []
    await expect(makeOps(fake).attach()).rejects.toThrow('未找到 GX Works3 主窗口')
  })

  it('fails when no window matches the hint', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'Other - GX Works3', handle: 1 }]
    await expect(makeOps(fake).attach('Nope')).rejects.toThrow('没有标题包含')
  })
})

describe('GxWindowOps.writeSt', () => {
  it('pastes, reads back and verifies the round trip', async () => {
    const fake = new FakeWorker()
    const ops = makeOps(fake)
    const result = await ops.writeSt({ blockName: 'Main', stCode: 'IF x THEN\n  y := TRUE;\nEND_IF;' })
    expect(result.ok).toBe(true)
    expect(result.hash).toMatch(/^[0-9a-f]{12}$/)
    // paste content reached the editor
    expect(fake.editorContent).toContain('y := TRUE;')
    // clipboard restored from the (empty) backup
    expect(fake.writes()[fake.writes().length - 1]).toBe('')
  })

  it('normalizes CRLF and trailing newline', async () => {
    const fake = new FakeWorker()
    const result = await makeOps(fake).writeSt({ blockName: 'Main', stCode: 'a := 1;\r\nb := 2;' })
    expect(result.ok).toBe(true)
    expect(result.chars).toBe('a := 1;\nb := 2;'.length)
  })

  it('throws with hashes when the read-back does not match (paste rejected)', async () => {
    const fake = new FakeWorker()
    fake.pasteEnabled = false
    await expect(makeOps(fake).writeSt({ blockName: 'Main', stCode: 'a := 1;' })).rejects.toThrow(
      /写后读回不一致[\s\S]*sha256/
    )
    expect(fake.writes()[fake.writes().length - 1]).toBe('')
  })

  it('fails when the block editor cannot be focused', async () => {
    const fake = new FakeWorker()
    fake.focusOk = false
    await expect(makeOps(fake).writeSt({ blockName: 'Missing', stCode: 'a;' })).rejects.toThrow('未找到块 "Missing"')
  })
})

describe('GxWindowOps.readSt', () => {
  it('selects all, copies and returns the editor text', async () => {
    const fake = new FakeWorker()
    fake.editorContent = 'PROGRAM Main\nEND_PROGRAM'
    const result = await makeOps(fake).readSt('Main')
    expect(result.text).toBe('PROGRAM Main\nEND_PROGRAM')
  })
})

describe('GxWindowOps.build', () => {
  it('clicks 全部转换 via MSAA, confirms via the 确定 button and settles', async () => {
    const fake = new FakeWorker()
    let n = 0
    fake.readRows = () => {
      n++
      if (n === 1) return ['old output']
      return ['build started', '3 | Error | ProgPou | 转换程序 | 语法有误。 | 0x110E1A02']
    }
    let m = 0
    fake.statusText = () => {
      m++
      return m === 1 ? '' : `'03-MANUAL/程序本体'的转换结果`
    }
    const result = await makeOps(fake).build('all')
    expect(result.settled).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.errors).toEqual(['3 | Error | ProgPou | 转换程序 | 语法有误。 | 0x110E1A02'])
    expect(result.menuPath).toContain('全部转换')
    expect(result.statusBarText).toContain('转换结果')
    expect(result.dockTabNames).toEqual(['输出'])
    expect(result.strayDialogsClosed).toBe(0)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu').length).toBe(1)
    // initial confirm-dialog find + one close-check poll
    expect(fake.calls.filter((c) => c.op === 'findDialog').length).toBe(2)
    // works3 confirms by clicking 确定 — no keyboard synthesis anywhere
    const confirm = fake.calls.find((c) => c.op === 'clickDialogButton')
    expect(confirm?.params.name).toBe('确定')
    expect(fake.calls.some((c) => c.op === 'sendKeys')).toBe(false)
  })

  it('reports outputUnavailable when the Output pane never appears', async () => {
    const fake = new FakeWorker()
    fake.readRows = null
    const result = await makeOps(fake).build('all')
    expect(result.outputUnavailable).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('returns unsettled when the deadline expires', async () => {
    const fake = new FakeWorker()
    let n = 0
    fake.readRows = () => ['line ' + n++]
    const result = await makeOps(fake, { buildTimeoutMs: 5 }).build('all')
    expect(result.settled).toBe(false)
  })

  it('aborts when the MSAA menu click fails (no silent pass)', async () => {
    const fake = new FakeWorker()
    fake.menuClickOk = false
    await expect(makeOps(fake).build('all')).rejects.toThrow(/MSAA 菜单点击失败[\s\S]*NOT-FOUND/)
    expect(fake.calls.some((c) => c.op === 'findDialog')).toBe(false)
    expect(fake.calls.some((c) => c.op === 'sendKeys')).toBe(false)
  })

  it('aborts when the rebuild dialog never appears', async () => {
    const fake = new FakeWorker()
    fake.dialogFound = false
    await expect(makeOps(fake).build('all')).rejects.toThrow(/未出现「全部转换」对话框/)
    expect(fake.calls.some((c) => c.op === 'sendKeys')).toBe(false)
  })

  it('refuses to send ENTER when the dialog cannot take the foreground (works2)', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    fake.foregroundOk = false
    // works3 confirms by button click and never needs the foreground; the
    // ENTER path remains works2-only (calibrated), still guarded by the
    // foreground check.
    await expect(makeOps(fake, { target: 'works2' }).build('all')).rejects.toThrow('无法将「转换(+全部编译)」对话框置前')
    expect(fake.calls.some((c) => c.op === 'sendKeys')).toBe(false)
  })

  it('rejects unsupported scopes', async () => {
    const fake = new FakeWorker()
    await expect(makeOps(fake).build('single' as 'all')).rejects.toThrow("scope=single")
  })
})

describe('GxWindowOps.getOutputErrors', () => {
  it('filters error rows by the calibrated works3 结果-cell rule', async () => {
    const fake = new FakeWorker()
    fake.readRows = () => [
      '1 | Information | ProgPou | 转换程序 | 转换结束。 | 0x00000000',
      '1 | Error | ProgPou | 转换程序 | 语法有误。请确认错误前后的语法。 | 0x110E1A02',
      '2 | CheckWarning | ProgPou | 二重线圈 | C9300'
    ]
    const errors = await makeOps(fake).getOutputErrors()
    expect(errors).toEqual([
      '1 | Error | ProgPou | 转换程序 | 语法有误。请确认错误前后的语法。 | 0x110E1A02'
    ])
  })
})

describe('GxWindowOps target=works2', () => {
  it('attaches to a GX Works2 window when target=works2', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    const result = await makeOps(fake, { target: 'works2' }).attach()
    expect(result.handle).toBe(7)
  })

  it('finds the window by the works2 title substring, not the works3 one', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    const attach = makeOps(fake, { target: 'works2' }).attach()
    await expect(attach).resolves.toBeDefined()
    expect(fake.calls.find((c) => c.op === 'findWindow')?.params.titleContains).toBe('GX Works2')
  })

  it('does not attach to Works2 windows with the default target', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    await expect(makeOps(fake).attach()).rejects.toThrow('未找到 GX Works3 主窗口')
  })

  it('hints at structured projects when the Works2 ST editor is missing', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    fake.focusOk = false
    await expect(
      makeOps(fake, { target: 'works2' }).writeSt({ blockName: 'Main', stCode: 'a;' })
    ).rejects.toThrow(/结构化工程/)
  })

  it('trusts the focused RichEdit20W as the Works2 ST editor without searching', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    fake.focusedClassName = 'RichEdit20W'
    const focused = await makeOps(fake, { target: 'works2' }).focusEditor(7, 'POU_01')
    expect(focused.className).toBe('RichEdit20W')
    expect(fake.calls.some((c) => c.op === 'focusElement')).toBe(false)
  })

  it('detects the false clipboard MATCH when focus is not in a text control', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    // Live-observed failure mode: focus lands on the project-tree item, ^v/^c
    // both no-op and the clipboard still holds the pasted code — the old
    // round-trip reported a bogus MATCH and the build compiled stale code.
    fake.copyEnabled = false
    await expect(
      makeOps(fake, { target: 'works2' }).writeSt({ blockName: 'POU_01', stCode: 'Y10 := M0;' })
    ).rejects.toThrow(/复制回读未发生（剪贴板哨兵未被覆盖）/)
  })

  it('falls back to rows-only settle detection when the status bar cannot be read', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    let n = 0
    fake.readRows = () => {
      n++
      if (n === 1) return ['old']
      return ['done']
    }
    const result = await makeOps(fake, { target: 'works2' }).build('all')
    expect(result.settled).toBe(true)
    expect(result.statusBarText).toBeUndefined()
    expect(result.errors).toEqual([])
    // The VSFlexGrid8N grid is read through the MSAA grid walker, not UIA, and
    // the confirm dialog is located via the top-level scan only (empty-titled
    // child #32770 MDI containers would otherwise swallow the ENTER).
    expect(fake.calls.find((c) => c.op === 'readOutputList')?.params.reader).toBe('msaa-grid')
    expect(fake.calls.find((c) => c.op === 'findDialog')?.params.search).toBe('top-level')
  })

  it('classifies Works2 build errors by the 结果 cell, not the row text', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    // Live-calibrated shape (2026-10-01): header row + warning rows + the
    // C8042 error row joined from grid cell values.
    let n = 0
    fake.readRows = () => {
      n++
      if (n === 1) {
        return []
      }
      return [
        'No. | 结果 | 数据名 | 分类 | 内容 | 错误代码',
        '1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042',
        '2 | CheckWarning | POU_01 | 双线圈/梯形图/一致性检查 | \'M0\'为双线圈。 | C9300'
      ]
    }
    const result = await makeOps(fake, { target: 'works2' }).build('all')
    expect(result.errors).toEqual(['1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042'])
    expect(result.outputLines).toHaveLength(3)
    expect(result.settled).toBe(true)
  })

  it('hard-fails when the Works2 confirm dialog survives ENTER (stale-grid guard)', async () => {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    // Simulates the misrouted-ENTER failure observed live: the dialog stays
    // open, the compile never runs and the grid would keep the PREVIOUS rows.
    fake.dialogSticks = true
    let n = 0
    fake.readRows = () => {
      n++
      if (n === 1) return ['1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042']
      return ['1 | Error | POU_01 | 编译程序 | 没有找到算式。 | C8042']
    }
    await expect(makeOps(fake, { target: 'works2' }).build('all')).rejects.toThrow(/确认对话框在 ENTER 后未关闭/)
  })
})

/** Short sim-start timings so Date.now()-driven loops stay fast in tests. */
const SIM_OPTS: Partial<WindowOpsOptions> = {
  target: 'works2',
  simProcessWaitMs: 30,
  plcWriteTimeoutMs: 200,
  plcWriteGraceMs: 40,
  pollMs: 1
}

function makeSimOps(fake: FakeWorker): GxWindowOps {
  return makeOps(fake, SIM_OPTS)
}

/** Same timings, but the works3 / Simulator3 flow. */
const SIM3_OPTS: Partial<WindowOpsOptions> = { ...SIM_OPTS, target: 'works3' }

describe('GxWindowOps.simStart', () => {
  function makeStartedFake(clicksToStart = 1): FakeWorker {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works2', handle: 7 }]
    let clicks = 0
    let closed = false
    fake.onMenuClick = () => {
      clicks++
      if (clicks >= clicksToStart) fake.processes = ['QuteSimRun']
    }
    fake.onDialogButtonClick = () => {
      closed = true
    }
    fake.plcWriteDialogs = () =>
      clicks >= clicksToStart && !closed ? [{ handle: 300, name: 'PLC写入', className: '#32770', controlType: 'Window' }] : []
    let polls = 0
    fake.plcWriteTexts = () => {
      polls++
      return polls === 1 ? ['模拟写入 52/100%'] : ['模拟写入 100/100%']
    }
    return fake
  }

  it('kills the simulator, starts with one click and closes the write dialog at 100%', async () => {
    const fake = makeStartedFake(1)
    const result = await makeSimOps(fake).simStart()
    expect(result.ok).toBe(true)
    expect(result.killedProcesses).toEqual(['QuteSimRun(123)'])
    expect(result.simClicks).toBe(1)
    expect(result.plcWriteClosedBy).toBe('close-button')
    expect(result.lastProgress).toContain('100/100%')
    expect(result.title).toContain('GX Works2')
    // The menu click goes through the pinned works2 menu bar.
    const menu = fake.calls.find((c) => c.op === 'msaaClickMenu')
    expect(menu?.params.itemName).toBe('模拟')
    expect(menu?.params.menuBarName).toBe('菜单栏')
    expect(menu?.params.minSegments).toBe(2)
    // Clean restart kills BOTH simulator processes before clicking.
    const kill = fake.calls.find((c) => c.op === 'stopProcess')
    expect(kill?.params.names).toEqual(['QuteSimRun', 'SimManager'])
    // The write dialog's 关闭 pushbutton is clicked on the dialog handle.
    const close = fake.calls.find((c) => c.op === 'clickDialogButton')
    expect(close?.params.name).toBe('关闭')
    expect(close?.params.handle).toBe(300)
    // No stray dialogs existed → no ESC was ever sent.
    expect(fake.calls.some((c) => c.op === 'sendKeys')).toBe(false)
  })

  it('clicks a second time when the first click takes the no-op stop path', async () => {
    const fake = makeStartedFake(2)
    const result = await makeSimOps(fake).simStart()
    expect(result.simClicks).toBe(2)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(2)
  })

  it('recovers when the menu click op times out (late modal blocks MSAA) and retries', async () => {
    const fake = makeStartedFake(1)
    // Live-observed (2026-10-02 smoke): a late "simulator disconnected" modal
    // blocks the MSAA calls and the op times out; the worker respawns lazily.
    fake.menuClickFailTimes = 1
    const result = await makeSimOps(fake).simStart()
    expect(result.ok).toBe(true)
    expect(result.simClicks).toBe(2)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(2)
  })

  it('ESC-closes stray dialogs left by the killed simulator before clicking', async () => {
    const fake = makeStartedFake(1)
    let scans = 0
    let closed = false
    fake.onDialogButtonClick = () => {
      closed = true
    }
    fake.plcWriteDialogs = () => {
      scans++
      if (closed) return []
      if (scans === 1) return [{ handle: 400, name: '模拟错误', className: '#32770', controlType: 'Window' }]
      return fake.processes.length > 0 ? [{ handle: 300, name: 'PLC写入', className: '#32770', controlType: 'Window' }] : []
    }
    const result = await makeSimOps(fake).simStart()
    expect(result.strayDialogsClosed).toBe(1)
    expect(fake.calls.some((c) => c.op === 'sendKeys' && c.params.keys === '{ESC}')).toBe(true)
  })

  it('reports not-seen when the write dialog never appears within the grace window', async () => {
    const fake = makeStartedFake(1)
    fake.plcWriteDialogs = () => []
    const result = await makeSimOps(fake).simStart()
    expect(result.plcWriteClosedBy).toBe('not-seen')
    expect(fake.calls.some((c) => c.op === 'clickDialogButton')).toBe(false)
  })

  it('hard-fails with the last progress when the write dialog hangs below 100%', async () => {
    const fake = makeStartedFake(1)
    // Live-observed failure mode: 「处理结束时自动关闭」unchecked and the
    // transfer stuck — the dialog sits open and the simulator stays empty.
    fake.plcWriteTexts = () => ['模拟写入 52/100%']
    await expect(makeSimOps(fake).simStart()).rejects.toThrow(/未完成写入[\s\S]*52\/100%[\s\S]*处理结束时自动关闭/)
  })

  it('hard-fails when the 关闭 pushbutton cannot be clicked at 100%', async () => {
    const fake = makeStartedFake(1)
    fake.clickDialogButtonOk = false
    await expect(makeSimOps(fake).simStart()).rejects.toThrow(/已达 100% 但点击「关闭」失败/)
  })

  it('hard-fails when the MSAA menu click never lands', async () => {
    const fake = makeStartedFake(1)
    fake.menuClickOk = false
    await expect(makeSimOps(fake).simStart()).rejects.toThrow(/MSAA 菜单点击失败/)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(1)
  })

  it('hard-fails when QuteSimRun never starts after all click attempts', async () => {
    const fake = makeStartedFake(1)
    // Menu clicks "succeed" but never bring the simulator up — disable the
    // auto-start hook AND clear the process list.
    fake.onMenuClick = () => {}
    fake.processes = []
    await expect(makeSimOps(fake).simStart()).rejects.toThrow(/始终未启动/)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(3)
    expect(fake.calls.some((c) => c.op === 'dialogProgress')).toBe(false)
  })
})

describe('GxWindowOps.simStart (works3 / Simulator3)', () => {
  function makeStartedFake3(): FakeWorker {
    const fake = new FakeWorker()
    fake.windows = [{ name: 'ProjC - [Main] - GX Works3', handle: 7 }]
    let clicks = 0
    let closed = false
    fake.onMenuClick = () => {
      clicks++
      if (clicks >= 1) fake.processes = ['RSimRun3']
    }
    fake.onDialogButtonClick = () => {
      closed = true
    }
    fake.plcWriteDialogs = () =>
      clicks >= 1 && !closed ? [{ handle: 310, name: '写入至可编程控制器', className: '#32770', controlType: 'Window' }] : []
    let polls = 0
    fake.plcWriteTexts = () => {
      polls++
      return polls === 1 ? ['模拟写入 52/100%'] : ['模拟写入 100/100%']
    }
    return fake
  }

  it('starts with one click, closes the write dialog and real-clicks the RUN switch', async () => {
    const fake = makeStartedFake3()
    const result = await makeOps(fake, SIM3_OPTS).simStart()
    expect(result.ok).toBe(true)
    // works3 never kills a running simulator (no clean-restart semantics).
    expect(result.killedProcesses).toEqual([])
    expect(fake.calls.some((c) => c.op === 'stopProcess')).toBe(false)
    expect(result.simClicks).toBe(1)
    expect(result.plcWriteClosedBy).toBe('close-button')
    expect(result.lastProgress).toContain('100/100%')
    // Pinned works3 click parameters: 模拟开始 on the 程序通用 toolbar.
    const menu = fake.calls.find((c) => c.op === 'msaaClickMenu')
    expect(menu?.params.itemName).toBe('模拟开始')
    expect(menu?.params.menuBarName).toBe('程序通用')
    expect(menu?.params.minSegments).toBe(2)
    // The SWITCH panel RUN button gets a REAL mouse click (synthetic invokes
    // are ignored by that button).
    const run = fake.calls.find((c) => c.op === 'realClickChild')
    expect(run?.params).toEqual({ title: 'GX Simulator3', childName: 'RUN' })
    expect(result.switchClick).toEqual({ windowTitle: 'GX Simulator3', buttonName: 'RUN', x: 120, y: 80 })
    // The write dialog's 关闭 pushbutton is clicked on the dialog handle.
    const close = fake.calls.find((c) => c.op === 'clickDialogButton')
    expect(close?.params.name).toBe('关闭')
    expect(close?.params.handle).toBe(310)
  })

  it('refuses to start when RSimRun3 already runs (模拟开始 is a toggle)', async () => {
    const fake = makeStartedFake3()
    fake.processes = ['RSimRun3']
    await expect(makeOps(fake, SIM3_OPTS).simStart()).rejects.toThrow(/已在运行[\s\S]*开关/)
    expect(fake.calls.some((c) => c.op === 'msaaClickMenu')).toBe(false)
  })

  it('hard-fails with manual-RUN guidance when the panel switch click fails', async () => {
    const fake = makeStartedFake3()
    fake.realClickOk = false
    await expect(makeOps(fake, SIM3_OPTS).simStart()).rejects.toThrow(/手动单击[\s\S]*双击[\s\S]*error-stop/)
  })

  it('hard-fails with the last progress when the works3 write dialog hangs below 100%', async () => {
    const fake = makeStartedFake3()
    fake.plcWriteTexts = () => ['模拟写入 52/100%']
    await expect(makeOps(fake, SIM3_OPTS).simStart()).rejects.toThrow(/未完成写入[\s\S]*52\/100%/)
  })

  it('retries the MSAA click once and hard-fails (no restart double-click on works3)', async () => {
    const fake = makeStartedFake3()
    fake.menuClickOk = false
    await expect(makeOps(fake, SIM3_OPTS).simStart()).rejects.toThrow(/MSAA 点击「模拟开始」失败/)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(2)
  })

  it('hard-fails when RSimRun3 never starts after the retried click', async () => {
    const fake = makeStartedFake3()
    fake.onMenuClick = () => {}
    fake.processes = []
    await expect(makeOps(fake, SIM3_OPTS).simStart()).rejects.toThrow(/未在.*s 内启动/)
    expect(fake.calls.filter((c) => c.op === 'msaaClickMenu')).toHaveLength(2)
    expect(fake.calls.some((c) => c.op === 'dialogProgress')).toBe(false)
  })
})
