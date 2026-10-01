"use strict";
/**
 * 三菱 MC 协议（QnA 兼容 3E 帧）软元件地址解析 —— 纯函数，无任何 I/O。
 *
 * 软元件代码为 QnA 兼容 3E 帧二进制模式的 1 字节代码，依据《MELSEC
 * Communication Protocol Interface / Reference Manual》（三菱官方，SH-080008
 * 及 SLMP 手册 SH-080956）的软元件代码表核对：
 * - X/Y/D/W/B/SW/SB/Z/ZR/SM/SD 等常见代码与官方手册表逐字核对一致
 *   （MELSEC iQ-F User Manual 通信篇 38.2 Device Access 表：9CH/9DH/A0H/B4H/B5H/
 *   CCH/B0H/A1H/91H/A9H 等）。
 * - T/C/ST 的触点/线圈/当前值代码未能在官方手册原文逐字核对（手册表页无法直接
 *   抓取），以下取值与 pymcprotocol、HslCommunication、多篇抓包交叉核对文章
 *   三方一致（规律：线圈代码 = 触点代码 - 1，三组定时器/计数器/累计定时器一致），
 *   标注为"未证实（多源一致）"。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDevice = parseDevice;
/** 编号进制（GX Works 工程惯例） */
const RADIX_DECIMAL = 10;
const RADIX_HEXADECIMAL = 16;
const RADIX_OCTAL = 8;
/**
 * QnA 兼容 3E 帧（二进制）软元件代码表。
 * 代码出处：三菱官方手册核对 / 多源交叉核对（见文件头注释）。
 */
const DEVICE_TABLE = {
    // ---- 字软元件 ----
    D: { code: 0xa8, radix: RADIX_DECIMAL, unit: 'word' }, // 数据寄存器（手册 38.2 表）
    W: { code: 0xb4, radix: RADIX_HEXADECIMAL, unit: 'word' }, // 链接寄存器（手册 38.2 表 B4H）
    SW: { code: 0xb5, radix: RADIX_HEXADECIMAL, unit: 'word' }, // 链接特殊寄存器（手册 38.2 表 B5H）
    ZR: { code: 0xb0, radix: RADIX_DECIMAL, unit: 'word' }, // 文件寄存器（手册 38.2 表 B0H）；GX Works 十进制连续编号，本实现仅支持块 0（编号 < 65536）
    Z: { code: 0xcc, radix: RADIX_DECIMAL, unit: 'word' }, // 变址寄存器（手册 38.2 表 CCH）
    // ---- 位软元件 ----
    X: { code: 0x9c, radix: RADIX_OCTAL, unit: 'bit' }, // 输入继电器（手册 38.2 表 9CH）；编号按 GX Works 八进制惯例
    Y: { code: 0x9d, radix: RADIX_OCTAL, unit: 'bit' }, // 输出继电器（手册 38.2 表 9DH）；编号按 GX Works 八进制惯例
    M: { code: 0x90, radix: RADIX_DECIMAL, unit: 'bit' }, // 内部继电器
    L: { code: 0x92, radix: RADIX_DECIMAL, unit: 'bit' }, // 锁存继电器
    B: { code: 0xa0, radix: RADIX_HEXADECIMAL, unit: 'bit' }, // 链接继电器（手册 38.2 表 A0H）
    F: { code: 0x93, radix: RADIX_DECIMAL, unit: 'bit' }, // 报警器
    SB: { code: 0xa1, radix: RADIX_HEXADECIMAL, unit: 'bit' }, // 链接特殊继电器（手册 38.2 表 A1H）
    V: { code: 0x94, radix: RADIX_DECIMAL, unit: 'bit' }, // 边沿继电器
    S: { code: 0x98, radix: RADIX_DECIMAL, unit: 'bit' }, // 步进继电器（未证实：官方表原文未逐字核对，多源一致）
    // ---- 定时器四件套：触点/线圈 = 位单元，当前值 = 字单元 ----
    // 未证实（多源一致）：TS/TC/TN 与 pymcprotocol、HslCommunication 及抓包文章一致
    T: { code: 0xc1, radix: RADIX_DECIMAL, unit: 'bit' }, // T 触点 = TS
    TS: { code: 0xc1, radix: RADIX_DECIMAL, unit: 'bit' }, // 定时器触点
    TC: { code: 0xc0, radix: RADIX_DECIMAL, unit: 'bit' }, // 定时器线圈
    TN: { code: 0xc2, radix: RADIX_DECIMAL, unit: 'word' }, // 定时器当前值
    // ---- 计数器四件套 ----
    // 未证实（多源一致）：CS/CC/CN 与 pymcprotocol、HslCommunication 及抓包文章一致
    C: { code: 0xc4, radix: RADIX_DECIMAL, unit: 'bit' }, // C 触点 = CS
    CS: { code: 0xc4, radix: RADIX_DECIMAL, unit: 'bit' }, // 计数器触点
    CC: { code: 0xc3, radix: RADIX_DECIMAL, unit: 'bit' }, // 计数器线圈
    CN: { code: 0xc5, radix: RADIX_DECIMAL, unit: 'word' }, // 计数器当前值
    // ---- 累计定时器（iQ-R 命名 ST，对应 Q 系列命名 SS/SC/SN）四件套 ----
    // 未证实（pymcprotocol 将 iQ-R 的 STS/STC/STN 映射到 SS/SC/SN 的 C7/C6/C8）
    ST: { code: 0xc7, radix: RADIX_DECIMAL, unit: 'bit' }, // ST 触点 = STS
    STS: { code: 0xc7, radix: RADIX_DECIMAL, unit: 'bit' }, // 累计定时器触点
    STC: { code: 0xc6, radix: RADIX_DECIMAL, unit: 'bit' }, // 累计定时器线圈
    STN: { code: 0xc8, radix: RADIX_DECIMAL, unit: 'word' } // 累计定时器当前值
};
/** 3E 帧"软元件编号"字段为 3 字节小端（代码占第 4 字节），编号上限 24 位 */
const MAX_DEVICE_NUMBER = 0xffffff;
const OCTAL_DIGITS = /^[0-7]+$/;
const DECIMAL_DIGITS = /^[0-9]+$/;
/**
 * 解析 GX Works 风格软元件地址字符串，如 'D100'、'x10'、'ZR2048'、'TC0'、'B1F'。
 * 大小写不敏感；编号进制按软元件而定：X/Y 八进制（X10 → 8，X17 → 15）、
 * B/W/SB/SW 十六进制（B1F → 31），其余十进制。
 * 非法输入抛出带说明的 Error。
 */
function parseDevice(addr) {
    const normalized = addr.trim().toUpperCase();
    // 软元件名整体吞掉字母（不回溯拆名）、编号尾缀允许十六进制字母（B/W/SB/SW 用），
    // 与 pymcprotocol 的切分语义一致：如 'SB10'→SB+10、'B1F'→B+1F、'DABC'→名为 DABC 未知
    const match = /^([A-Z]+)([0-9A-F]*)$/.exec(normalized);
    if (!match) {
        throw new Error(`无效软元件地址 "${addr}"：应为"软元件名+编号"格式，如 D100、X10、TC0、ZR2048`);
    }
    const name = match[1];
    const digits = match[2];
    const entry = DEVICE_TABLE[name];
    if (!entry) {
        throw new Error(`不支持的软元件 "${name}"（来自 "${addr}"）：3E 帧代码表中无此软元件`);
    }
    if (!digits) {
        throw new Error(`软元件地址 "${addr}" 缺少编号：应为"软元件名+编号"，如 ${name}100`);
    }
    if (entry.radix === RADIX_OCTAL && !OCTAL_DIGITS.test(digits)) {
        throw new Error(`软元件 ${name} 编号为八进制，"${digits}" 含非法数字 8/9（来自 "${addr}"）`);
    }
    if (entry.radix === RADIX_DECIMAL && !DECIMAL_DIGITS.test(digits)) {
        throw new Error(`软元件 ${name} 编号为十进制，"${digits}" 含非十进制字符（来自 "${addr}"）`);
    }
    const number = Number.parseInt(digits, entry.radix);
    if (Number.isNaN(number) || number < 0 || number > MAX_DEVICE_NUMBER) {
        throw new Error(`软元件编号超出 3 字节可表示范围（0..16777215）：${addr}`);
    }
    return { code: entry.code, name, number, unit: entry.unit };
}
