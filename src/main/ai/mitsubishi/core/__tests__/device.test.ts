/**
 * 软元件地址解析测试：全软元件代码表分支 + 进制（八/十/十六）+ 非法输入。
 */
import { describe, expect, it } from 'vitest'
import { parseDevice } from '../device'

describe('parseDevice 基本解析', () => {
  it('解析十进制字软元件 D100', () => {
    expect(parseDevice('D100')).toEqual({
      code: 0xa8,
      name: 'D',
      number: 100,
      unit: 'word'
    })
  })

  it('大小写不敏感且容忍首尾空白', () => {
    expect(parseDevice('d100')).toEqual(parseDevice('D100'))
    expect(parseDevice(' Tc0 ')).toEqual(parseDevice('TC0'))
  })
})

describe('parseDevice 编号进制', () => {
  it('X/Y 八进制：X10 → 8、X17 → 15、Y0 → 0', () => {
    expect(parseDevice('X10').number).toBe(8)
    expect(parseDevice('X17').number).toBe(15)
    expect(parseDevice('Y0').number).toBe(0)
    expect(parseDevice('X10').unit).toBe('bit')
  })

  it('X18 抛错（八进制不含 8/9）', () => {
    expect(() => parseDevice('X18')).toThrow(/八进制/)
    expect(() => parseDevice('Y19')).toThrow(/八进制/)
  })

  it('B/W/SB/SW 十六进制：B1F → 31、W0FF → 255、SB10 → 16、SW10 → 16', () => {
    expect(parseDevice('B1F').number).toBe(31)
    expect(parseDevice('W0FF').number).toBe(255)
    expect(parseDevice('SB10').number).toBe(16)
    expect(parseDevice('SW10').number).toBe(16)
  })

  it('十进制软元件编号含十六进制字母抛错', () => {
    expect(() => parseDevice('D1A')).toThrow(/十进制/)
  })

  it('整体为字母的输入按未知软元件名处理（不拆名回溯）', () => {
    expect(() => parseDevice('DABC')).toThrow(/不支持的软元件 "DABC"/)
  })
})

describe('parseDevice 软元件代码表', () => {
  it('字软元件：D/W/SW/ZR/Z', () => {
    expect(parseDevice('D0').code).toBe(0xa8)
    expect(parseDevice('W0').code).toBe(0xb4)
    expect(parseDevice('SW0').code).toBe(0xb5)
    expect(parseDevice('ZR2048')).toEqual({
      code: 0xb0,
      name: 'ZR',
      number: 2048,
      unit: 'word'
    })
    expect(parseDevice('Z5')).toEqual({ code: 0xcc, name: 'Z', number: 5, unit: 'word' })
  })

  it('位软元件：M/L/B/F/SB/V/S', () => {
    const expected: Array<[string, number]> = [
      ['M100', 0x90],
      ['L200', 0x92],
      ['B0', 0xa0],
      ['F10', 0x93],
      ['SB0', 0xa1],
      ['V0', 0x94],
      ['S10', 0x98] // 步进继电器，代码未证实（多源一致）
    ]
    for (const [addr, code] of expected) {
      const spec = parseDevice(addr)
      expect(spec.code).toBe(code)
      expect(spec.unit).toBe('bit')
    }
  })

  it('定时器四件套：T/TS=0xC1（位）、TC=0xC0（位）、TN=0xC2（字）', () => {
    expect(parseDevice('T10')).toEqual({ code: 0xc1, name: 'T', number: 10, unit: 'bit' })
    expect(parseDevice('TS10').code).toBe(0xc1)
    expect(parseDevice('TC10').code).toBe(0xc0)
    expect(parseDevice('TC10').unit).toBe('bit')
    expect(parseDevice('TN10')).toEqual({ code: 0xc2, name: 'TN', number: 10, unit: 'word' })
  })

  it('计数器四件套：C/CS=0xC4（位）、CC=0xC3（位）、CN=0xC5（字）', () => {
    expect(parseDevice('C10')).toEqual({ code: 0xc4, name: 'C', number: 10, unit: 'bit' })
    expect(parseDevice('CS10').code).toBe(0xc4)
    expect(parseDevice('CC10').code).toBe(0xc3)
    expect(parseDevice('CC10').unit).toBe('bit')
    expect(parseDevice('CN10')).toEqual({ code: 0xc5, name: 'CN', number: 10, unit: 'word' })
  })

  it('累计定时器四件套：ST/STS=0xC7（位）、STC=0xC6（位）、STN=0xC8（字）', () => {
    expect(parseDevice('ST10')).toEqual({ code: 0xc7, name: 'ST', number: 10, unit: 'bit' })
    expect(parseDevice('STS10').code).toBe(0xc7)
    expect(parseDevice('STC10').code).toBe(0xc6)
    expect(parseDevice('STC10').unit).toBe('bit')
    expect(parseDevice('STN10')).toEqual({ code: 0xc8, name: 'STN', number: 10, unit: 'word' })
  })
})

describe('parseDevice 边界与非法输入', () => {
  it('编号上边界 16777215 通过、16777216 抛错', () => {
    expect(parseDevice('D16777215').number).toBe(0xffffff)
    expect(() => parseDevice('D16777216')).toThrow(/3 字节/)
  })

  it('无编号抛错', () => {
    expect(() => parseDevice('D')).toThrow(/缺少编号/)
  })

  it('编号含 G 以上字母（非十六进制字符）抛格式错', () => {
    expect(() => parseDevice('D100G')).toThrow(/格式/)
  })

  it('未知软元件抛错', () => {
    expect(() => parseDevice('Q10')).toThrow(/不支持的软元件/)
    expect(() => parseDevice('ABC123')).toThrow(/不支持的软元件/)
  })

  it('空串与含空格编号抛格式错', () => {
    expect(() => parseDevice('')).toThrow(/格式/)
    expect(() => parseDevice('D 100')).toThrow(/格式/)
  })
})
