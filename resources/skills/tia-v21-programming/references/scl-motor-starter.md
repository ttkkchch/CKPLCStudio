# SCL 模板：电机启保停 + 过载保护 + 手动/自动（FB）

通过外部 SCL 三步链导入（WritePlcSclSourceFile → ImportPlcExternalSource → GenerateBlocksFromExternalSource）。

```scl
FUNCTION_BLOCK "FB_MotorStarter" { S7_Optimized_Access := 'TRUE' }
VERSION : 1.0
   VAR_INPUT
      bStartCmd      : Bool;   // 启动命令（点动按钮，脉冲）
      bStopCmd       : Bool;   // 停止命令（常闭信号取反后进入逻辑）
      bFeedback      : Bool;   // 接触器反馈（辅助触点）
      bOverload      : Bool;   // 热继电器过载（TRUE=过载）
      bInterlock     : Bool;   // 外部联锁（水流/风压等，TRUE=允许启动）
      tFaultLock     : Time := T#30S; // 故障锁定时间
   END_VAR
   VAR_OUTPUT
      bRunCmd        : Bool;   // 运行输出（接触器线圈）
      bRunning       : Bool;   // 运行状态（含反馈确认）
      bFault         : Bool;   // 故障指示
   END_VAR
   VAR
      bLatched       : Bool;   // 运行锁存
      bFaultLatched  : Bool;   // 故障锁存（跳机后保持）
      tFaultDelay    : TON;    // 过载确认延时（抗抖动）
      tLockTimer     : TON;    // 故障锁定计时
   END_VAR

BEGIN
    // ---- 过载确认（0.5s 防抖）----
    tFaultDelay(IN := bOverload, PT := T#500MS);
    bFault := tFaultDelay.Q;

    // ---- 故障跳机：锁定，直到人工复位（Stop 按下）----
    IF bFault THEN
        bFaultLatched := TRUE;
        bLatched := FALSE;          // 立即跳机
    END_IF;
    tLockTimer(IN := bFaultLatched, PT := tFaultLock);

    // 故障锁定期间禁止置位运行锁存——防止自动重启
    // 复位条件：锁定时间到 且 用户重新给了停止（或专用 Reset）
    IF bFaultLatched AND NOT tLockTimer.Q AND NOT bStartCmd THEN
        bFaultLatched := FALSE;
    END_IF;

    // ---- 启保停（含联锁与故障禁止）----
    IF bStopCmd OR bFaultLatched OR NOT bInterlock THEN
        bLatched := FALSE;
    ELSIF bStartCmd AND bInterlock AND NOT bFaultLatched THEN
        bLatched := TRUE;
    END_IF;

    bRunCmd := bLatched;
    bRunning := bRunCmd AND bFeedback;

    // 反馈丢失保护：命令给出 2s 内无反馈 → 视为故障
    // （可扩展：tFbWatch TON 计时 bRunCmd AND NOT bFeedback）
END_FUNCTION_BLOCK
```

## 调用检查清单（OB1）

1. FB 必须在 OB1/FC 中调用并赋背景 DB，否则块虽编译通过但不运行。
2. 输入映射核对：按钮/接触器/热继电器通道号与电气图一致。
3. `bStopCmd` 语义：物理常闭按钮在 PLC 里读 1，程序中 `NOT bStopCmd_I` 作停止条件——接错方向会"一上电就停/停不下来"。
