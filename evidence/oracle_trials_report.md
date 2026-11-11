# Table 4. Oracle permission-isolation trial on Sepolia

Contract `0x61Fdc579feFd9aa45613f9D8681B342676FC2585`, agreement **5**, deposit 0.01 ETH, lease already expired at creation.

| # | 步骤 | 执行身份 | 结果 | 交易 / 区块 |
|---|---|---|---|---|
| 0 | createAgreement(租期已过期) | LANDLORD | 成功 | `7de05a5f95cacde3f1dd…` / 12070268 |
| 1 | deposit | TENANT | 成功 | `55669cde8ef5d8162cab…` / 12070269 |
| 2 | recordInspection(Passed) | ORACLE | 成功 | `86e52598e1d4babad473…` / 12070270 |
| 3 | proposeSettlement(10000) | LANDLORD | 成功 | `8a9281cd288784c42fbf…` / 12070271 |
| 4 | acceptSettlement() | TENANT | 成功 | `fc1f2380417c9f0ae402…` / 12070272 |
| 5a | Oracle → resolveDispute | ORACLE | 拒绝（InvalidStatus） | `503f8f01a092a4c76076…` / 12070273 |
| 5b | Oracle → withdraw | ORACLE | 拒绝（NotParty） | `c5c4ada8820bf30c37f1…` / 12070274 |
| 5c | Tenant → withdraw（合法提取） | TENANT | 成功 | `40bf657c8a14f1e3f745…` / 12070275 |

> 5a 与 5b 是**真实发送上链后失败**的交易（status = 0），Etherscan 上可查，证明合约在
> 执行阶段拒绝了越权调用，而不是仅在前端或脚本层被拦下。失败交易不改变任何状态。
> 5c 证明合法收款方仍能正常提取，说明前两步的拒绝来自权限校验本身，而非资金异常或状态异常。

## 本轮证明的三件事

1. Oracle 可以写验房证据（第 2 步）。5a 的调用确实被拒绝，但 revert reason 是 `InvalidStatus`（协议已 Settled，任何人调用都会先撞状态守卫），**不能单独证明 `NotArbiter`**；仲裁人权限由 `test/02-security.test.js` 在 Disputed 状态下验证。
2. Oracle **不是协议当事方**，因而无法提款（5b `NotParty`）。
3. 押金的最终去向完全由双方结算（3、4）或指定仲裁人决定，Oracle 全程无资金权限。
