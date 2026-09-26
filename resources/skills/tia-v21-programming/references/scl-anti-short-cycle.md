# SCL 模板：压缩机最短停机间隔保护（anti-short-cycle，FB）

频繁启停会大幅缩短压缩机寿命。启动前检查停机已满 3~5 分钟，未到则拒绝启动。

```scl
FUNCTION_BLOCK "FB_AntiShortCycle" { S7_Optimized_Access := 'TRUE' }
VERSION : 1.0
   VAR_INPUT
      bStartReq      : Bool;   // 上级启动请求（启保停锁存输出）
      bRunning       : Bool;   // 压缩机实际运行反馈
      tMinOffTime    : Time := T#4M; // 最短停机间隔（3~5 分钟）
   END_VAR
   VAR_OUTPUT
      bStartPermit   : Bool;   // 允许启动（串入启动回路）
      bWaiting       : Bool;   // 等待倒计时中（可接 HMI 提示）
   END_VAR
   VAR
      tocOffTimer    : TON;    // 停机计时
      bWasRunning    : Bool;   // 上一周期运行沿检测
   END_VAR

BEGIN
    // 停机瞬间开始计时（运行→停止下降沿触发）
    IF bWasRunning AND NOT bRunning THEN
        ; // TON IN 断开即自动从 0 计时
    END_IF;
    tocOffTimer(IN := NOT bRunning, PT := tMinOffTime);
    bWasRunning := bRunning;

    // 计时未到 → 禁止启动
    bStartPermit := tocOffTimer.Q;   // 停机满 tMinOffTime 后 Q=TRUE
    bWaiting := NOT bRunning AND NOT bStartPermit;
END_FUNCTION_BLOCK
```

## 使用要点

1. `bStartPermit` 必须串在压缩机启动回路（启保停置位条件 AND 本输出），而非仅报警。
2. 首次上电 `NOT bRunning` 即成立，`tocOffTimer` 从 0 计时——等效"上电后等待一个间隔"，对压缩机是安全侧行为。
3. 多压缩机阵列：每台独立背景 DB；轮换启动可在此 FB 上叠加运行时长均衡逻辑。
4. 与故障锁定（见 scl-chiller-control.md）独立生效：故障跳机后即便间隔已到也不允许自动重启。
