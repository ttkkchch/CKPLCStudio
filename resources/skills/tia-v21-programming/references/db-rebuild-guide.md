# Classic→TIA 迁移：全局 DB 重建规范

照抄真实 DB 导出（SimaticML）的关键属性，实测 V21 编译 0 错。

## 必守属性

- `MemoryLayout = Standard`
- 编号方式 `Number`、`AutoNumber = false`（保留原 Classic DB 号，避免程序引用漂移）
- 成员 `Remanence = "Retain"`（保持 Classic 的掉电保持语义）
- 成员名用偏移风格（如 `DBX45.0` 含点合法，与 Classic 符号表对齐）
- Excel/原工程中的中文注释放三处：`Member/Comment` + `MultiLanguageText Lang="zh-CN"`

## 迁移固有矛盾（Classic→TIA）

同一成员类型无法同时满足两种访问形态。典型：FC14（时钟设置）对 `"DB10".DBB0` 双重要求——Network1 要 DT 整体传参、Network2 要 STRUCT 组件拆解。

**解法**：微改程序本身而非 DB 结构。例如让 DT 实参改用 DB 内另一段预留区（如 DBB16 起的 SettingTime 写区），原 DBB0 保持字节型成员。

## 重建流程

1. 从原工程导出真实 DB 的 SimaticML（含全部成员+偏移+注释）作为基准。
2. 逐成员核对类型/偏移/保持属性，禁止"顺手优化"。
3. XML 导入先 `dryRun=true` 试探，确认后再实导。
4. 导入后全量编译，按 [tia-mcp-workflow.md](tia-mcp-workflow.md) 判读错误形态，逐个回修。
5. 迁移不改逻辑：只修类型矛盾，不动控制流程。
