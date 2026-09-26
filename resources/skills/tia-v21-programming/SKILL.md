---
name: tia-v21-programming
description: 西门子 TIA Portal V18~V21 编程技能包：TIA MCP/Openness 工作流速查、外部 SCL 三步链、DB 重建规范、电机/冷机控制 SCL 模板库。当用户要求编写 PLC 程序、创建 FB/FC/DB、迁移 Classic 工程、诊断编译错误或设计冷机/泵/压缩机控制逻辑时使用。
version: 1.0.0
author: CK
tags: [TIA, SCL, PLC, Siemens, Openness]
---

# TIA Portal V21 编程技能

面向 CKPLCStudio 的 TIA 工程师助手：通过 TIA Portal MCP 工具（TiaMcpServer.exe，Openness API）直接操作本机 TIA Portal。

## 工作流速查

Connect（挂接已打开工程，**绝不默认新建**）→ 读取工程上下文 → 编写/修改 → 编译 0 错误 → 提示用户保存。

- 首次 Connect 会弹 Openness 授权对话框，提醒用户手动点击"是"。
- 编译存在错误时禁止保存工程；编译 0 错 ≠ 程序正确，还需自查 OB1 调用链、I/O 映射、安全保护。

## 建块路线

| 块类型 | 路线 |
|---|---|
| 复杂块（FB/FC/带接口+逻辑） | **外部 SCL 三步链**：WritePlcSclSourceFile → ImportPlcExternalSource → GenerateBlocksFromExternalSource（V21 最稳，绕开 SimaticML XML token 拒绝） |
| 简单块（UDT/全局 DB/无逻辑 FC） | XML 导入（Build*Xml + ImportBlock），必须先 `dryRun=true` 试探 |

关键参数：ImportBlocksFromDirectory 必填 `groupPath`；ImportPlcProgramFromDirectory 用 `sourceDir`；块导入/编译用 `softwarePath` 短名（如 `"PLC_2"`，全路径报 NotFound，标签表导入除外）；`groupPath` 传空串 `""` 自动创建源文件组。

## 详细参考（按需加载）

- [tia-mcp-workflow.md](references/tia-mcp-workflow.md) — MCP 会话流程、编译错误访问形态判读、坑点清单
- [db-rebuild-guide.md](references/db-rebuild-guide.md) — Classic→TIA 迁移全局 DB 重建规范
- [scl-motor-starter.md](references/scl-motor-starter.md) — 电机启保停 + 过载保护 + 手动/自动模板
- [scl-anti-short-cycle.md](references/scl-anti-short-cycle.md) — 压缩机最短停机间隔保护 FB
- [scl-chiller-control.md](references/scl-chiller-control.md) — 冷机控制骨架（故障锁定/Reset/启停锁存/延时保护）
