import { describe, expect, it } from 'vitest'

import {
  getGxProfile,
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
  focusOk = true
  /** null → readGrid throws (output pane absent); else called per readGrid. */
  readRows: (() => string[]) | null = () => []

  async call<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    this.calls.push({ op, params })
    switch (op) {
      case 'findWindow':
        return {
          windows: this.windows.filter((w) => !params.titleContains || (w.name ?? '').includes(String(params.titleContains)))
        } as T
      case 'setForeground':
        return { foregrounded: true, nowForeground: true } as T
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
        if (keys === GX_ST_COPY_KEYS) this.clipboard = this.editorContent
        return { sent: keys } as T
      }
      case 'focusElement':
        if (!this.focusOk) throw new Error('element not found (focusElement)')
        return { focused: { name: String((params.names as string[])[0]) } } as T
      case 'invokeElement':
        return { pattern: 'invoke' } as T
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
  return new GxWindowOps(fake, { sleep: () => Promise.resolve(), pollMs: 1, settlePolls: 2, buildTimeoutMs: 5000, ...extra })
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
  it('invokes the compile menu chain and settles when output stops changing', async () => {
    const fake = new FakeWorker()
    let n = 0
    fake.readRows = () => {
      n++
      if (n === 1) return ['old output']
      return ['build started', 'error E1 somewhere']
    }
    const result = await makeOps(fake).build('all')
    expect(result.settled).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.errors).toEqual(['error E1 somewhere'])
    expect(fake.calls.filter((c) => c.op === 'invokeElement').length).toBe(2)
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

  it('rejects unsupported scopes', async () => {
    const fake = new FakeWorker()
    await expect(makeOps(fake).build('single' as 'all')).rejects.toThrow("scope=single")
  })
})

describe('GxWindowOps.getOutputErrors', () => {
  it('filters error-ish lines', async () => {
    const fake = new FakeWorker()
    fake.readRows = () => ['info ok', 'Error C1205', '警告 W1', '错误 E3']
    const errors = await makeOps(fake).getOutputErrors()
    expect(errors).toEqual(['Error C1205', '错误 E3'])
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
})
