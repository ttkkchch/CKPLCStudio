"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUBCOMMAND_BIT_UNITS = exports.SUBCOMMAND_WORD_UNITS = exports.COMMAND_BATCH_WRITE = exports.COMMAND_BATCH_READ = void 0;
exports.wordValuesToBytes = wordValuesToBytes;
exports.bytesToWordValues = bytesToWordValues;
exports.bitValuesToBytes = bitValuesToBytes;
exports.bytesToBitValues = bytesToBitValues;
exports.buildBatchReadRequest = buildBatchReadRequest;
exports.buildBatchWriteRequest = buildBatchWriteRequest;
exports.parseResponse = parseResponse;
/** 请求子头 0x5000（线上字节序：50 00） */
const REQUEST_SUBHEADER = [0x50, 0x00];
/** 响应子头 0xD000（线上字节序：D0 00）。注意：D000H 而非 8000H，依手册与实测帧 */
const RESPONSE_SUBHEADER = [0xd0, 0x00];
/** 批量读命令 0401H（字/位单元由子命令区分） */
exports.COMMAND_BATCH_READ = 0x0401;
/** 批量写命令 1401H（字/位单元由子命令区分） */
exports.COMMAND_BATCH_WRITE = 0x1401;
/** 子命令：字单元 */
exports.SUBCOMMAND_WORD_UNITS = 0x0000;
/** 子命令：位单元 */
exports.SUBCOMMAND_BIT_UNITS = 0x0001;
/** 子头(2) + 网络号(1) + PC号(1) + I/O号(2) + 站号(1) + 数据长度(2) */
const HEADER_LENGTH = 9;
/** 将 u16 数组按小端打包为字节序列（字单元写数据 / 读数据解包的逆操作） */
function wordValuesToBytes(values) {
    const bytes = new Uint8Array(values.length * 2);
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (!Number.isInteger(v) || v < 0 || v > 0xffff) {
            throw new Error(`字软元件值超出 0..0xFFFF：${v}`);
        }
        bytes[i * 2] = v & 0xff;
        bytes[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return bytes;
}
/** 将小端字节序列解包为 u16 数组（字单元读数据） */
function bytesToWordValues(bytes) {
    if (bytes.length % 2 !== 0) {
        throw new Error(`字数据长度必须为偶数，实际 ${bytes.length}`);
    }
    const values = [];
    for (let i = 0; i < bytes.length; i += 2) {
        values.push(bytes[i] | (bytes[i + 1] << 8));
    }
    return values;
}
/**
 * 位单元数据每字节 8 点：按小端位序打包（第 n 点 = 第 n/8 字节的第 n%8 位）。
 * 接受 boolean 数组或 0/1 数组。
 */
function bitValuesToBytes(values) {
    const bytes = new Uint8Array(Math.ceil(values.length / 8));
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        const on = typeof v === 'boolean' ? v : v === 1;
        if (!on && typeof v === 'number' && v !== 0) {
            throw new Error(`位软元件值只能为 true/false 或 0/1，实际 ${v}`);
        }
        if (on) {
            bytes[i >> 3] |= 1 << (i & 7);
        }
    }
    return bytes;
}
/** 位单元读数据解包：每字节 8 点，按小端位序展开为 0/1 数组 */
function bytesToBitValues(bytes, pointCount) {
    const count = pointCount ?? bytes.length * 8;
    const values = [];
    for (let i = 0; i < count; i++) {
        values.push((bytes[i >> 3] >> (i & 7)) & 1);
    }
    return values;
}
function appendU16Le(bytes, value) {
    bytes.push(value & 0xff, (value >> 8) & 0xff);
}
/** 组装公共请求头 + 命令区，extraDataLength 为写数据区字节数（读请求为 0） */
function buildRequestFrame(command, subcommand, device, pointCount, extraDataLength, opts) {
    if (!Number.isInteger(pointCount) || pointCount <= 0 || pointCount > 0xffff) {
        throw new Error(`点数必须为 1..65535，实际 ${pointCount}`);
    }
    if (!Number.isInteger(device.number) || device.number < 0 || device.number > 0xffffff) {
        throw new Error(`软元件编号超出 3 字节可表示范围（0..16777215）：${device.number}`);
    }
    const networkNo = opts?.networkNo ?? 0x00;
    const pcNo = opts?.pcNo ?? 0xff;
    const destIo = opts?.requestDestModuleIo ?? 0x03ff;
    const destStation = opts?.requestDestModuleStationNo ?? 0x00;
    const timer = opts?.monitoringTimer ?? 0x0000;
    // 请求数据长度先占位，追加完数据区后回填
    const frame = [...REQUEST_SUBHEADER];
    frame.push(networkNo, pcNo, destIo & 0xff, (destIo >> 8) & 0xff, destStation);
    frame.push(0x00, 0x00);
    appendU16Le(frame, timer);
    appendU16Le(frame, command);
    appendU16Le(frame, subcommand);
    // 软元件指定 4 字节：编号 3 字节小端 + 代码 1 字节
    frame.push(device.number & 0xff, (device.number >> 8) & 0xff, (device.number >> 16) & 0xff);
    frame.push(device.code & 0xff);
    appendU16Le(frame, pointCount);
    // 请求数据长度 = 从监视定时器字段起到帧末的字节数（含写数据区）
    const dataLength = frame.length - HEADER_LENGTH + extraDataLength;
    frame[7] = dataLength & 0xff;
    frame[8] = (dataLength >> 8) & 0xff;
    return frame;
}
/**
 * 组装批量读请求帧。
 * 字单元：命令 0401H + 子命令 0000H；位单元：命令 0401H + 子命令 0001H。
 */
function buildBatchReadRequest(cmd, device, count, opts) {
    const subcommand = cmd === 'word' ? exports.SUBCOMMAND_WORD_UNITS : exports.SUBCOMMAND_BIT_UNITS;
    return new Uint8Array(buildRequestFrame(exports.COMMAND_BATCH_READ, subcommand, device, count, 0, opts));
}
/**
 * 组装批量写请求帧。
 * 字单元：命令 1401H + 子命令 0000H，values 为 u16 数组或已打包的小端字节序列；
 * 位单元：命令 1401H + 子命令 0001H，values 为 boolean[] / 0-1 数组 / 已打包字节序列
 * （每字节 8 点，小端位序）。
 */
function buildBatchWriteRequest(cmd, device, values, opts) {
    let data;
    let pointCount;
    if (cmd === 'word') {
        if (values instanceof Uint8Array) {
            if (values.length % 2 !== 0) {
                throw new Error(`字单元写数据长度必须为偶数，实际 ${values.length}`);
            }
            data = values;
        }
        else if (values.some((v) => typeof v === 'boolean')) {
            throw new Error('字单元写数据不接受 boolean，请传 u16 数组或 Uint8Array');
        }
        else {
            data = wordValuesToBytes(values);
        }
        // 字单元：每 2 字节 1 点
        pointCount = data.length / 2;
    }
    else {
        if (values instanceof Uint8Array) {
            data = values;
            // 已打包字节：每字节 8 点
            pointCount = data.length * 8;
        }
        else {
            // 位单元点数 = 数组元素个数（手册"点数"即位数，非 8 的倍数时末字节高位闲置）
            pointCount = values.length;
            data = bitValuesToBytes(values);
        }
    }
    if (data.length === 0) {
        throw new Error('写数据不能为空');
    }
    const subcommand = cmd === 'word' ? exports.SUBCOMMAND_WORD_UNITS : exports.SUBCOMMAND_BIT_UNITS;
    const count = pointCount;
    const frame = buildRequestFrame(exports.COMMAND_BATCH_WRITE, subcommand, device, count, data.length, opts);
    for (let i = 0; i < data.length; i++) {
        frame.push(data[i]);
    }
    return new Uint8Array(frame);
}
/** 响应帧最小长度 = 子头(2)+访问路径(5)+长度(2)+结束代码(2) */
const RESPONSE_MIN_LENGTH = 11;
/**
 * 解析 3E 帧二进制响应。校验子头（D000H）与响应数据长度字段和实际字节数一致，
 * 不一致抛错；出错结束代码时 data 缺省。
 */
function parseResponse(bytes) {
    if (bytes.length < RESPONSE_MIN_LENGTH) {
        throw new Error(`响应帧过短：${bytes.length} 字节，至少 ${RESPONSE_MIN_LENGTH} 字节`);
    }
    if (bytes[0] !== RESPONSE_SUBHEADER[0] || bytes[1] !== RESPONSE_SUBHEADER[1]) {
        throw new Error(`响应子头错误：期望 ${RESPONSE_SUBHEADER[0].toString(16)} ${RESPONSE_SUBHEADER[1].toString(16)}（D000H），实际 ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
    }
    const declaredLength = bytes[7] | (bytes[8] << 8);
    const actualLength = bytes.length - HEADER_LENGTH;
    if (declaredLength !== actualLength) {
        throw new Error(`响应数据长度不一致：帧内声明 ${declaredLength} 字节，实际 ${actualLength} 字节`);
    }
    const endCode = bytes[9] | (bytes[10] << 8);
    if (endCode !== 0) {
        return { endCode };
    }
    return { endCode, data: bytes.slice(HEADER_LENGTH + 2) };
}
