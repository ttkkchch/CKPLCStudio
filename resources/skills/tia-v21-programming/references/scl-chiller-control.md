# SCL 模板：冷机控制骨架（故障锁定 / Reset / 启停锁存 / 启动延时）

冷机（冷水机组）安全控制四要素。所有输出行为以"故障后必须人工重新给启动命令"为最高原则。

```scl
FUNCTION_BLOCK "FB_ChillerControl" { S7_Optimized_Access := 'TRUE' }
VERSION : 1.0
   VAR_INPUT
      bStartCmd         : Bool;  // 启动命令（HMI/上位机，脉冲）
      bStopCmd          : Bool;  // 停止命令
      bResetCmd         : Bool;  // 故障复位命令（脉冲）
      bWaterFlowOK      : Bool;  // 冷冻水流证明（流量开关）
      bChwPumpRunning   : Bool;  // 冷冻泵运行反馈（联锁）
      bCwpRunning       : Bool;  // 冷却泵运行反馈（联锁）
      bChillerFault     : Bool;  // 机组本体故障（高压/低压/油压等汇总）
      bAntiShortOK      : Bool;  // anti-short-cycle 允许（见对应 FB）
   END_VAR
   VAR_OUTPUT
      bRunLatch         : Bool;  // 运行命令输出
      bFaultActive      : Bool;  // 故障激活中（锁定）
      bStartupDelay     : Bool;  // 启动延时进行中
      bReadyToStart     : Bool;  // 就绪（可启动）
   END_VAR
   VAR
      bFaultLatched     : Bool;  // 故障锁存
      tStartDelay       : TON;   // 启动延时保护
      rSetpoint         : Real := 7.0; // 冷冻水出水设定 ℃
   END_VAR

BEGIN
    // ================= 故障检测与锁定 =================
    // 水流丢失/泵停/机组故障 → 跳机
    bFaultActive := bFaultLatched;

    IF (NOT bWaterFlowOK AND bRunLatch)
       OR (bRunLatch AND (NOT bChwPumpRunning OR NOT bCwpRunning))
       OR bChillerFault THEN
        bFaultLatched := TRUE;
        bRunLatch := FALSE;             // 立即跳机
    END_IF;

    // ================= Reset 复位 =================
    // 仅人工 Reset 且故障源已消失才解锁；解锁后仍需重新给启动命令
    IF bResetCmd AND NOT bChillerFault AND bWaterFlowOK
       AND bChwPumpRunning AND bCwpRunning THEN
        bFaultLatched := FALSE;
    END_IF;

    // ================= 就绪判定 =================
    bReadyToStart := NOT bFaultLatched
                 AND bWaterFlowOK
                 AND bChwPumpRunning AND bCwpRunning
                 AND bAntiShortOK;

    // ================= 启停命令锁存 =================
    // 故障锁定期间禁止置位运行锁存——防止自动重启
    IF bStopCmd THEN
        bRunLatch := FALSE;
    ELSIF bStartCmd AND bReadyToStart THEN
        bRunLatch := TRUE;
    ELSIF NOT bReadyToStart THEN
        bRunLatch := FALSE;             // 联锁消失即停（除复位后待启动）
    END_IF;

    // ================= 启动延时保护 =================
    // 就绪后延时 10s 再输出，躲开泵启停瞬态与流量开关抖动
    tStartDelay(IN := bRunLatch, PT := T#10S);
    bStartupDelay := bRunLatch AND NOT tStartDelay.Q;
END_FUNCTION_BLOCK
```

## 安全规约（不可妥协）

1. **故障跳机后必须重新给启动命令**才允许重启；锁定期间禁止置位运行锁存。
2. **水流证明**必须参与启动与运行双重联锁；仅靠延时躲抖动不够，流量开关持续断开必须跳机。
3. 压缩机串接 anti-short-cycle（3~5 分钟，见对应 FB）。
4. 冷量/能耗单位换算（kW、RT、COP）在数据层统一处理，避免物理性错误。
5. 机组本体故障（bChillerFault）复位后必须由机组控制面板确认内部无锁存，PLC 侧 Reset 只解锁 PLC 联锁。

## HMI 建议暴露

故障锁存状态、Reset 按钮（脉冲型）、anti-short 倒计时、启动延时倒计时、出水温度设定。
