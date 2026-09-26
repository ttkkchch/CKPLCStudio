# TIA MCP 工作流与坑点清单（V21 实测）

## 会话模型

1. **Connect**：TIA 已打开时，新起 TiaMcpServer 进程 Connect 自动绑定已开工程，无需重启 TIA。
2. **挂接已开工程**：绝不默认新建工程；未开工程时先询问用户。
3. **读取上下文**：写操作前先扫描块清单/变量表，避免盲目写入。
4. **编译 → 保存**：0 错误才允许保存；保存前把改动点逐条告知用户。

## 编译错误访问形态判读

| 错误形态 | 含义 |
|---|---|
| `Tag "DB"."名"`（名带引号） | 字面成员名访问——DB 里缺这个名字的成员 |
| `Tag "DB".名.组件`（名无引号） | 路径访问——`名` 必须是含 `组件` 的 STRUCT |
| `DATE_AND_TIME` 类型取 `.YEAR` | 非法：DT 类型无组件访问，需拆字节（DBB 年/月/日…）或改用 DTL |

## MCP 参数速查

- `ImportBlocksFromDirectory`：必填 **groupPath**（不是 folderPath）。
- `ImportPlcProgramFromDirectory`：参数名是 **sourceDir**。
- 块导入/编译：`softwarePath` 用短名（如 `"PLC_2"`），全路径报 NotFound；标签表导入可用全路径。
- 外部 SCL：`groupPath` 传空串 `""` 会自动创建源文件组；传不存在的组名（如 "外部源文件"）报 NotFound。
- 硬件目录枚举（SearchHardwareCatalog 等）可能超过 60s：MCP 客户端已配 longRunning + 300s 超时，耐心等待勿重试。

## 经验教训

- 同一时间只允许一个"写手"（TIA MCP 直驱 或 PLC Studio 聊天壳），避免并发写冲突。
- 未处理 Openness 授权对话框会让 Connect 一直阻塞。
- 编译 0 错误不代表逻辑正确：必须检查 OB1 是否调用 FB、I/O 是否映射、安全保护是否完善。
- 单位换算（冷量 kW/RT、COP）在数据层统一处理，避免物理性错误。
