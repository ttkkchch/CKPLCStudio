"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOLS = void 0;
exports.closeAllWorks3Channels = closeAllWorks3Channels;
exports.callTool = callTool;
/**
 * Tool surface of the GX Works stdio MCP bridge.
 *
 * Two tool families, one per transport:
 *
 * - UIA tools (gx_attach/write_st/read_st/build/get_output_errors/gx_sim_start)
 *   run through the 64-bit PowerShell UIA worker — thin wrappers over
 *   GxWindowOps. gx_sim_start is UI-only automation (menu click + dialog
 *   shepherding), so it rides the UIA worker even though its name says sim.
 * - Simulation tools (gx_sim_connect/read/write/disconnect): target=works2
 *   (default) routes through a SECOND PsWorker spawned under 32-bit
 *   PowerShell (SysWOW64) because MX Component's ActUtlType is a 32-bit COM
 *   server; target=works3 routes through Simulator3Gateway (SLMP over TCP
 *   127.0.0.1:5511 — pure Node, no COM, no 32-bit requirement). They verify
 *   program BEHAVIOR against the simulator (write inputs -> read outputs),
 *   which compilation alone cannot prove.
 *
 * Every tool returns JSON text content and maps thrown errors to
 * `isError: true` results (never raw stack traces). One tool set serves both
 * generations: the optional `target` argument selects GX Works3 (default) or
 * GX Works2; the ops instance is built per call (stateless — every op
 * re-attaches to the running window).
 *
 * Safety gates (write preview, read-back verification wording) live in the
 * factory assistant prompt; the tools themselves stay mechanical.
 *
 * Pure Node stdlib — compiled standalone into resources/mitsubishi-mcp/.
 */
const locatorMap_1 = require("../core/uia/locatorMap");
const windowOps_1 = require("../core/uia/windowOps");
const simulator3_1 = require("../core/sim/simulator3");
/** Shared per-tool argument: which GX Works generation to operate on. */
const TARGET_ARG = {
    type: 'string',
    enum: ['works3', 'works2'],
    description: '目标平台：works3 = GX Works3（iQ-R/iQ-F 系列，默认）；works2 = GX Works2（Q/L/FX 系列，仅结构化工程的 ST 程序可注入）'
};
/**
 * 仿真工具专用的 target 参数：与 TARGET_ARG 缺省值相反——4 个 gx_sim_* 工具
 * 在 works3 支持加入前一直缺省服务 GX Simulator2，缺省必须保持 works2。
 */
const SIM_TARGET_ARG = {
    type: 'string',
    enum: ['works2', 'works3'],
    description: '目标仿真器：works2 = GX Simulator2（经 MX Component ActUtlType，缺省）；works3 = GX Simulator3（SLMP 直连 127.0.0.1:5511，需先用 gx_sim_start 启动仿真）'
};
exports.TOOLS = [
    {
        name: 'gx_attach',
        description: '连接 GX Works3/GX Works2：找到主窗口并置前台，返回窗口信息。用户必须已手动打开 GX Works 并加载工程；target 选代际（默认 works3），projectHint 用于多个工程窗口时按标题子串选择。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG,
                projectHint: { type: 'string', description: '工程名（标题子串），多窗口时用于选择目标窗口' }
            }
        }
    },
    {
        name: 'gx_write_st',
        description: '向指定块的 ST 编辑器写入程序：剪贴板粘贴 + 写后读回哈希校验。读写回不一致时工具报错=未确认写入，禁止随后编译/保存。写之前必须先出改动预览并征得用户确认。GX Works2 仅结构化工程的 ST 程序有 ST 编辑器。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG,
                blockName: { type: 'string', description: '目标块名（该块的编辑器必须已在 GX Works 中打开为活动编辑器）' },
                stCode: { type: 'string', description: '要写入的完整 ST 源码（整体替换，不是增量）' }
            },
            required: ['blockName', 'stCode']
        }
    },
    {
        name: 'gx_read_st',
        description: '读取指定块 ST 编辑器的当前全部文本（Ctrl+A/Ctrl+C 经剪贴板回读，自动备份恢复用户剪贴板）。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG,
                blockName: { type: 'string', description: '目标块名' }
            },
            required: ['blockName']
        }
    },
    {
        name: 'gx_build',
        description: '触发「全程序编译」（Rebuild All）并轮询输出窗格直到停稳，返回全部输出行与错误行（locale 中性过滤）。编译有错时必须逐条闭环修复，禁止带错保存。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG,
                scope: { type: 'string', enum: ['all'], description: '编译范围，当前仅支持 all' }
            }
        }
    },
    {
        name: 'gx_get_output_errors',
        description: '读取 GX Works 输出窗格（Output）中的错误行，用于编译失败后的定位。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG
            }
        }
    },
    {
        name: 'gx_sim_start',
        description: '启动内置仿真器并自动完成 PLC 写入。target=works3（缺省）：拒绝在 RSimRun3 已运行时点击（「模拟开始」是开关，再点会停止仿真）→ MSAA 点击「程序通用」工具栏的「模拟开始」→ 等 RSimRun3 进程 → 盯梢自动弹出的「写入至可编程控制器」对话框，进度到 100/100% 后自动点「关闭」→ 真实鼠标单击 Simulator3 窗口 SWITCH 面板的「RUN」按钮（该按钮只认真实点击，双击会诱发 error-stop）。target=works2：杀掉已有模拟器进程做干净重启 → ESC 关闭残留对话框 → MSAA 点击「模拟」菜单（杀进程后第一次点击走停止路径，未启动会自动点第二次）→ 盯梢「PLC写入」对话框，100/100% 后自动点「关闭」。两种流程完成后即可 gx_sim_connect 做行为验证。前置条件：GX Works 已打开工程且编译通过。',
        inputSchema: {
            type: 'object',
            properties: {
                target: TARGET_ARG
            }
        }
    },
    {
        name: 'gx_sim_connect',
        description: '连接仿真器。target=works2（缺省）：GX Simulator2，经 MX Component ActUtlType（逻辑站号默认 1），返回 CPU 运行状态（cpuRun）与扫描时间；前置条件：MX Component 已安装且 Communication Setup Utility 已把逻辑站号指向 GX Simulator2。target=works3：GX Simulator3，SLMP 3E 帧直连 127.0.0.1:5511，返回 CPU 运行状态；前置条件：已用 gx_sim_start（target=works3）完成「模拟开始+写入+RUN」。两者均要求模拟已启动且 PLC 写入完成（建议直接用 gx_sim_start 自动完成）。',
        inputSchema: {
            type: 'object',
            properties: {
                target: SIM_TARGET_ARG,
                station: { type: 'number', description: '逻辑站号（默认 1）' }
            }
        }
    },
    {
        name: 'gx_sim_read',
        description: '批量读取仿真器软元件当前值（位软元件返回 0/1，字软元件返回有符号 16 位值）。works3：X 软元件按 nibble 半字节自动解码（每个 X 编号对应半字节中的 1 位），且 X 在仿真 RUN/STOP 切换后会被清零——切换状态后请重写输入再验证。需先 gx_sim_connect。',
        inputSchema: {
            type: 'object',
            properties: {
                target: SIM_TARGET_ARG,
                station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' },
                devices: { type: 'array', items: { type: 'string' }, description: '软元件名列表，如 ["X0","M0","Y10","D100"]' }
            },
            required: ['devices']
        }
    },
    {
        name: 'gx_sim_write',
        description: '批量写入仿真器软元件值（位软元件 0/1，字软元件 -32768..32767）。用于驱动输入条件后观察程序行为，是「写 X → 读 Y」行为验证的核心手段。works3：位写走 SLMP 随机写位帧（命令 1402）；CPU 处于 RUN 时写入会被拒（SLMP 异常，错误信息含 RUN/STOP 指引）——请先在 GX Simulator3 窗口的 SWITCH 面板手动切到 STOP 再写。需先 gx_sim_connect。',
        inputSchema: {
            type: 'object',
            properties: {
                target: SIM_TARGET_ARG,
                station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' },
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            device: { type: 'string', description: '软元件名，如 X0' },
                            value: { type: 'number', description: '写入值（位 0/1，字 -32768..32767）' }
                        },
                        required: ['device', 'value']
                    },
                    description: '写入项列表，如 [{"device":"X0","value":1}]'
                }
            },
            required: ['items']
        }
    },
    {
        name: 'gx_sim_disconnect',
        description: '断开仿真器连接（works2：Close ActUtlType；works3：关闭 SLMP TCP 连接）。',
        inputSchema: {
            type: 'object',
            properties: {
                target: SIM_TARGET_ARG,
                station: { type: 'number', description: '逻辑站号（默认 1，须与 connect 一致）' }
            }
        }
    }
];
function json(value) {
    return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(message) {
    return { content: [{ type: 'text', text: message }], isError: true };
}
function requireString(args, key) {
    const value = args[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`参数 "${key}" 必须是非空字符串`);
    }
    return value;
}
function parseTarget(args) {
    if (args.target === undefined)
        return 'works3';
    if (!(0, locatorMap_1.isGxTarget)(args.target)) {
        throw new Error(`参数 "target" 必须是 'works3' 或 'works2'，收到: ${JSON.stringify(args.target)}`);
    }
    return args.target;
}
function parseStation(args) {
    if (args.station === undefined)
        return 1;
    if (typeof args.station !== 'number' || !Number.isInteger(args.station) || args.station < 0) {
        throw new Error(`参数 "station" 必须是非负整数，收到: ${JSON.stringify(args.station)}`);
    }
    return args.station;
}
/**
 * 仿真工具 target 解析：缺省 works2（兼容既有调用——4 个 gx_sim_* 工具在
 * works3 支持加入前一直服务 GX Simulator2，无 target 时必须原路走 ActUtlType
 * worker）。⚠ 勿复用 parseTarget（其缺省 works3 会造成 works2 回归）。
 */
function parseSimTarget(args) {
    if (args.target === undefined || args.target === 'works2')
        return 'works2';
    if (args.target === 'works3')
        return 'works3';
    throw new Error(`参数 "target" 必须是 'works2' 或 'works3'，收到: ${JSON.stringify(args.target)}`);
}
/**
 * Tools served by the 32-bit MX Component worker instead of GxWindowOps.
 * gx_sim_start is deliberately NOT here: it is pure UI automation (menu click
 * + dialog shepherding) and rides the 64-bit UIA worker.
 */
const SIM_TOOLS = new Set(['gx_sim_connect', 'gx_sim_read', 'gx_sim_write', 'gx_sim_disconnect']);
function parseWriteItems(args) {
    const raw = args.items;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('参数 "items" 必须是非空数组（每项 {device, value}）');
    }
    return raw.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
            throw new Error(`items[${index}] 必须是对象`);
        }
        const item = entry;
        if (typeof item.device !== 'string' || item.device.length === 0) {
            throw new Error(`items[${index}].device 必须是非空字符串`);
        }
        if (typeof item.value !== 'number' || !Number.isInteger(item.value)) {
            throw new Error(`items[${index}].value 必须是整数`);
        }
        return { device: item.device, value: item.value };
    });
}
function parseDeviceList(args) {
    const raw = args.devices;
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new Error('参数 "devices" 必须是非空字符串数组');
    }
    return raw.map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0) {
            throw new Error(`devices[${index}] 必须是非空字符串`);
        }
        return entry;
    });
}
/** works3 未连接时 read/write 的统一错误文案 */
const WORKS3_NOT_CONNECTED = '尚未连接 Simulator3——请先 gx_sim_connect（target=works3）';
/**
 * works3 仿真通道表：station → Simulator3Gateway（SLMP 直连 127.0.0.1:5511）。
 * 跨调用保持：connect 建通道后 read/write 复用；disconnect 时移除。
 */
const DEFAULT_WORKS3_CHANNELS = new Map();
/** 释放全部 works3 仿真通道（entry shutdown 用；不影响 works2 simWorker） */
function closeAllWorks3Channels() {
    for (const gateway of DEFAULT_WORKS3_CHANNELS.values())
        gateway.dispose();
    DEFAULT_WORKS3_CHANNELS.clear();
}
/**
 * works3 仿真调用：经 Simulator3Gateway（SLMP 直连 RSimRun3）。connect 惰性
 * 建通道（同站重复 connect 走 gateway 幂等重建）；read/write 未连接直接报错
 * （不隐式建连——建连语义只归 connect）。
 */
async function works3SimCall(name, args, channels) {
    const station = parseStation(args);
    switch (name) {
        case 'gx_sim_connect': {
            let gateway = channels.get(station);
            if (!gateway) {
                gateway = (0, simulator3_1.createSimulator3Gateway)();
                channels.set(station, gateway);
            }
            return json(await gateway.connect(station));
        }
        case 'gx_sim_disconnect': {
            const gateway = channels.get(station);
            if (!gateway)
                return json({ station, closed: false });
            const result = await gateway.disconnect(station);
            channels.delete(station);
            return json(result);
        }
        case 'gx_sim_read': {
            const gateway = channels.get(station);
            if (!gateway)
                return errorResult(WORKS3_NOT_CONNECTED);
            return json(await gateway.readDevices(station, parseDeviceList(args)));
        }
        case 'gx_sim_write': {
            const gateway = channels.get(station);
            if (!gateway)
                return errorResult(WORKS3_NOT_CONNECTED);
            return json(await gateway.writeItems(station, parseWriteItems(args)));
        }
        default:
            return errorResult(`unknown tool: ${name}`);
    }
}
async function callTool(worker, name, args, simWorker, works3Channels = DEFAULT_WORKS3_CHANNELS) {
    try {
        if (SIM_TOOLS.has(name)) {
            const simTarget = parseSimTarget(args);
            if (simTarget === 'works3') {
                return await works3SimCall(name, args, works3Channels);
            }
            if (!simWorker) {
                throw new Error('仿真工具不可用：32 位 MX Component worker 未初始化（需 32 位 PowerShell 与 MX Component）');
            }
            const station = parseStation(args);
            switch (name) {
                case 'gx_sim_connect': {
                    return json(await simWorker.call('open', { station }));
                }
                case 'gx_sim_read': {
                    return json(await simWorker.call('read', { station, devices: parseDeviceList(args) }));
                }
                case 'gx_sim_write': {
                    return json(await simWorker.call('write', { station, items: parseWriteItems(args) }));
                }
                case 'gx_sim_disconnect': {
                    return json(await simWorker.call('close', { station }));
                }
                default:
                    return errorResult(`unknown tool: ${name}`);
            }
        }
        const ops = new windowOps_1.GxWindowOps(worker, { target: parseTarget(args) });
        switch (name) {
            case 'gx_attach': {
                const hint = typeof args.projectHint === 'string' && args.projectHint.length > 0 ? args.projectHint : undefined;
                return json(await ops.attach(hint));
            }
            case 'gx_write_st': {
                return json(await ops.writeSt({ blockName: requireString(args, 'blockName'), stCode: requireString(args, 'stCode') }));
            }
            case 'gx_read_st': {
                return json(await ops.readSt(requireString(args, 'blockName')));
            }
            case 'gx_build': {
                const scope = typeof args.scope === 'string' && args.scope.length > 0 ? args.scope : 'all';
                return json(await ops.build(scope));
            }
            case 'gx_get_output_errors': {
                return json({ errors: await ops.getOutputErrors() });
            }
            case 'gx_sim_start': {
                return json(await ops.simStart());
            }
            default:
                return errorResult(`unknown tool: ${name}`);
        }
    }
    catch (err) {
        return errorResult(err instanceof Error ? err.message : String(err));
    }
}
