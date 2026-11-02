# RentalEscrow 合约 · 前端对接说明（最终版，Member B → Member A）

> 最终版（2026-11-02）。依据四份输入定稿：作业要求 PDF、团队分工报告、任务分工图、《528网页框架(2).docx》架构文档；验房接口以 GitHub 冻结 ABI 为准。
> 交付物：`RentalEscrow.sol`（solc 0.8.24，optimizer 200 runs，编译零警告）、`RentalEscrow.abi.json`、`RentalEscrow.bytecode.hex`、`deploy.mjs`。
> 本文函数名/事件名/错误名/选择器均取自编译产物。

## 0. 接口基线与版本说明

- 验房三件套为**冻结接口**（GitHub 已有签名，不得再改）：
  - `recordInspection(uint256,bool,bytes32)`，选择器 `0x75824f08`
  - `getInspection(uint256)` → `(bool recorded, bool passed, bytes32 reportHash, uint64 updatedAt, address recorder)`
  - `event InspectionRecorded(uint256 indexed agreementId, address indexed oracle, bool passed, bytes32 reportHash)`，topic0 `0x94c3affac9099396e1ed58a20829edab90deeda5e5b830199d9ae7c5fd6423af`
- 托管其余接口（create/deposit/结算/争议/提款）沿用分工报告 §4.2，未变更。
- 架构文档第 9 条为硬边界：**Oracle 只提供外部事实，不改变争议逻辑，押金分配仍由双方结算或仲裁人决定**。UI 不得出现"验房通过即自动退款"的暗示。

## 1. 状态机、角色与页面映射

```
Created --deposit--> Active --proposeSettlement--> SettlementProposed --acceptSettlement--> Settled
   |                    |  \----------------------------raiseDispute---------\   |
   |                    +--------------raiseDispute----------> Disputed --resolveDispute--> Settled
   +--cancelAgreement--> Cancelled
验房通道独立：仅 Active / SettlementProposed / Disputed 可写 recordInspection。
```

| AgreementStatus | 值 | 文案 | 架构文档对应 |
| --- | --- | --- | --- |
| Created | 0 | 待入金 | 等待押金 |
| Active | 1 | 托管中 | 押金已锁定 |
| SettlementProposed | 2 | 结算待确认 | 等待对方确认 |
| Settled | 3 | 已结算 | 双方领取资金 |
| Disputed | 4 | 争议中 | 管理员（=仲裁人）裁定 |
| Cancelled | 5 | 已取消 | 押金支付前取消 |

角色与页面：

| 合约角色 | Demo 身份（架构文档） | 页面/入口 |
| --- | --- | --- |
| landlord（协议内地址） | Landlord | New agreement、协议详情、/withdraw |
| tenant（协议内地址） | Tenant | deposit、结算/争议、/withdraw |
| arbiter（协议内地址，创建时固定） | **Arbitrator，即 Dispute 页"管理员"** | Dispute 页裁定入口 |
| ORACLE_ROLE（全局角色） | Oracle | /oracle 页、协议详情验房面板 |
| DEFAULT_ADMIN_ROLE（全局角色） | 部署者 | 仅 grantRole/revokeRole，无页面操作 |

> 注意：架构文档 Dispute 页的"管理员"指协议记录的仲裁人身份，**不是**合约 admin；admin 只授角色、不能裁定或动资金。

## 2. 写函数与按钮启用矩阵

| 函数（规范签名） | 选择器 | 调用者 | payable | 启用条件 / revert | 事件 |
| --- | --- | --- | --- | --- | --- |
| createAgreement(address,address,uint256,uint64,bytes32,bytes32,string) | 0xa04e9a8e | 房东 | 否 | 地址非零且三者互异；押金>0，否则 InvalidAddress / ZeroDeposit | AgreementCreated |
| deposit(uint256) | 0xb6b55f25 | 租客 | 是，value 恰等于 depositAmount | status==0、连接地址==tenant、金额精确，否则 InvalidStatus / NotTenant / DepositMismatch | DepositFunded |
| proposeSettlement(uint256,uint16) | 0x928d1e13 | 房东或租客 | 否 | status==1、是协议方、租期已到、bps≤10000，否则 InvalidStatus / NotParty / LeaseNotEnded / InvalidBps | SettlementProposed |
| acceptSettlement(uint256) | 0x93ee2678 | 另一方 | 否 | status==2、是协议方且非提议人，否则 InvalidStatus / NotParty / NotCounterparty | SettlementAccepted |
| raiseDispute(uint256,bytes32) | 0x636bf26d | 房东或租客 | 否 | status∈{1,2}、是协议方、证据哈希非零，否则 InvalidStatus / NotParty / ZeroHash | DisputeRaised |
| resolveDispute(uint256,uint16,bytes32) | 0xd6da414e | 仲裁人 | 否 | status==4、连接地址==arbiter、bps≤10000，否则 InvalidStatus / NotArbiter / InvalidBps | DisputeResolved |
| cancelAgreement(uint256) | 0x5686b54b | 房东或租客 | 否 | 仅 status==0，否则 InvalidStatus / NotParty | AgreementCancelled |
| withdraw(uint256) | 0x2e1a7d4d | 收款方本人 | 否 | 自己余额>0，否则 NotParty / NothingToWithdraw；nonReentrant | Withdrawn |
| recordInspection(uint256,bool,bytes32) | 0x75824f08 | ORACLE_ROLE | 否 | 角色、哈希非零、status∈{1,2,4}，否则 AccessControlUnauthorizedAccount / ZeroHash / InvalidStatus | InspectionRecorded |

### 2.1 表单字段映射（New agreement 页，架构文档 vs 合约参数）

| 表单字段 | 合约参数 | 说明 |
| --- | --- | --- |
| 房屋名称、地址 | propertyHash / metadataHash + metadataURI | 文本不离链：前端把房屋信息 JSON 化后 keccak256 得 propertyHash，文档哈希得 metadataHash，URI 存 metadataURI |
| 租客地址 | tenant | 必填 |
| 押金 | depositAmount | wei；deposit 时 value 必须精确相等 |
| 租期 | leaseEndsAt | unix 秒（uint64）；proposeSettlement 的 LeaseNotEnded 守卫依据 |
| metadata URI | metadataURI | 链下文档位置 |
| **（表单缺失，需补充）** | arbiter | 合约必需参数：创建时固定仲裁人。前端从 Protocol 页配置读取 Arbitrator 地址，或在表单加只读展示项；缺省会导致 InvalidAddress |

### 2.2 Dispute 页三选一 → resolveDispute 的 bps

| 页面选项 | tenantBps | 语义 |
| --- | --- | --- |
| 全退租客 | 10000 | 租客拿全部押金 |
| 平均分配 | 5000 | 五五开 |
| 全给房东 | 0 | 房东拿全部押金 |

仲裁人也可裁任意中间值；房东份额 = 10000 − tenantBps，合约内自动补剩余，两余额之和恒等于押金。rationaleHash 传裁定书/理由文档的 keccak256（可传 0 若暂无文档，但建议必填）。

## 3. 验房接口专项（冻结 ABI）

- `recordInspection(agreementId, passed, reportHash)`：`passed` 传 JS boolean（true=通过，false=未通过）；`reportHash` 为 `0x`+64 位 hex 非零；整体覆盖当前记录（recorded 置 true、刷新 updatedAt 与 recorder）。
- `getInspection(agreementId)`：`recorded==false` 即架构文档"未请求"，此时不得渲染 passed；`updatedAt` 为秒级时间戳（ethers 返回 BigInt，展示前 Number() 转换）；`recorder` 用于验房面板"记录人"展示与 Oracle 钱包核对。
- `InspectionRecorded` 事件**不含时间字段**：每次更新的时间用 `log.blockNumber → provider.getBlock(n).timestamp` 补齐；协议详情"更新时间"也可直接读 updatedAt。
- 验房历史 = 该事件全量聚合（queryFilter 回溯）；合约只存当前一条。
- /oracle 页：仅列出 status∈{1,2,4} 的协议（其余禁用记录按钮并给理由）；结果输入只允许"通过/未通过"两态。
- Settled/Cancelled 后验房面板只读（写入会 revert InvalidStatus）。

## 4. 只读接口

| 函数 | 返回 | 用途 |
| --- | --- | --- |
| getAgreement(id) | 元组顺序：landlord, tenant, arbiter, depositAmount, status, leaseEndsAt, tenantBps, propertyHash, metadataHash, tenantBalance, landlordBalance, settlementProposer, metadataURI | 详情页/列表页（ethers v6 支持命名访问） |
| getInspection(id) | 见第 3 节 | 验房面板 |
| withdrawableBalance(id, who) | uint256 | /withdraw 页可提金额 |
| agreementCount | uint256 | 列表页遍历 0..count-1 |
| hasRole(role, addr) / ORACLE_ROLE() | bool / bytes32 | Oracle 页与 Protocol 页角色识别 |

## 5. 事件清单与页面分组

| 事件（规范签名） | topic0 | indexed | 页面分组 |
| --- | --- | --- | --- |
| AgreementCreated(uint256,address,address,address,uint256,bytes32) | 0x55b8a7a176119ab660f8bb328bf47de437476c513a8142c69448672c4dc0bb87 | agreementId, landlord, tenant | 时间线 |
| DepositFunded(uint256,address,uint256) | 0xdfaa8c912b5509c72ecaf1be942e001eb4a21e6f8f1fd3676d006d6d9f8e6084 | agreementId, tenant | Activity-存入 |
| SettlementProposed(uint256,address,uint16) | 0x452eba696960982dccc37361af18061d03ea9802de07b8f946ac2c71b2fcd73f | agreementId, proposer | Activity-结算 |
| SettlementAccepted(uint256,address,uint256,uint256) | 0x95cb956b7fff155b7675968d6baf1df90813f0694f911536bc512a80ccdb7a16 | agreementId, acceptor | Activity-结算 |
| DisputeRaised(uint256,address,bytes32,uint256) | 0x4d4d5f95e4c544a9cca49e0dcb84ec89c79b58b16a0000dd84e15e645a3fb184 | agreementId, raiser | Activity-争议 |
| DisputeResolved(uint256,address,uint16,bytes32,uint256,uint256) | 0x435124b18a64b60b18b56b480db0bc541bad1735cdce7c96d34ef28dd97e697b | agreementId, arbiter | Activity-争议 |
| Withdrawn(uint256,address,uint256) | 0xcf7d23a3cbe4e8b36ff82fd1b05b1b17373dc7804b4ebbd6e2356716ef202372 | agreementId, recipient | Activity-提款 |
| InspectionRecorded(uint256,address,bool,bytes32) | 0x94c3affac9099396e1ed58a20829edab90deeda5e5b830199d9ae7c5fd6423af | agreementId, oracle | Activity-验房、时间线、验房面板 |
| AgreementCancelled(uint256,address) | 0xbc4582906f1267fc1f22792d8da00979cfc526d95c149cc6e7c0ef730f592d6e | agreementId, canceller | 时间线 |
| RoleGranted / RoleRevoked(bytes32,address,address) | 0x2f8788117e7eff1d82e926ec794901d17c78024a50270940304540a733656f0d / 0xf6391f5c32d9c69d2a47ea670b442974b53935d1edc7fd64eb21e047a839171b | role, account, sender | Protocol 页授权记录 |
| RoleAdminChanged(bytes32,bytes32,bytes32) | 0xbd79b86ffe0ab8e8776151514217cd7cacd52c909f66475c3af44e129f0b00ff | role, previousAdminRole, newAdminRole | Protocol 页 |

规则：所有重要状态变化进时间线（架构文档第 3 节）；InspectionRecorded 不作为结算动作展示；Activity 五个过滤器 = 存入/结算/争议/提款/验房。

## 6. 错误 → 用户文案映射

| 错误名（选择器） | 建议文案 |
| --- | --- |
| InvalidAddress (0xe6c4247b) | 地址无效或角色冲突（房东/租客/仲裁人需互不相同） |
| InvalidAgreement (0xfe1da89a) | 协议编号不存在 |
| InvalidStatus (0xf525e320) | 当前协议状态不允许该操作 |
| ZeroDeposit (0x56316e87) | 押金金额必须大于 0 |
| DepositMismatch (0xe45a15b0) | 转入金额必须等于约定押金 |
| InvalidBps (0xc6cc5d7f) | 分配比例超出 0–100% 范围 |
| ZeroHash (0xf1ae58d5) | 哈希不能为空 |
| LeaseNotEnded (0x047fdfd8) | 租期未结束，暂不能提议结算 |
| NotTenant (0x94484cb3) | 仅本协议租客可以入金 |
| NotParty (0xc8ee2d1d) | 仅本协议房东或租客可以操作 |
| NotCounterparty (0x89f5ad61) | 提议人不能批准自己的结算方案 |
| NotArbiter (0xccb665a6) | 仅指定仲裁人可以裁定 |
| NothingToWithdraw (0xd0d04f60) | 当前没有可提取余额 |
| TransferFailed (0x90b8ec18) | 链上转账失败，请重试 |
| AccessControlUnauthorizedAccount (0xe2517d3f) | 当前钱包无该角色权限 |
| AccessControlBadConfirmation (0x6697b232) | 角色确认失败 |
| ReentrancyGuardReentrantCall (0x3ee5aeb5) | 检测到重入调用，交易已拒绝 |

捕获：ethers v6 `contract.interface.parseError(e.data).name`；viem `decodeErrorResult({ abi, data: e.data })`。

## 7. 调用示例（ethers v6）

```ts
const c = new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);

// 房东创建：arbiter 从 Protocol 配置取；房屋信息哈希化上链
const tx = await c.createAgreement(tenant, arbiter, ethers.parseEther("0.5"),
  leaseEndsAt, propertyHash, metadataHash, metadataURI);
const rc = await tx.wait();
const id = rc.logs.map(l => c.interface.parseLog(l)).find(l => l?.name === "AgreementCreated")?.args.agreementId;

// 租客入金（value 精确等于 depositAmount）
await c.deposit(id, { value: ag.depositAmount });

// 结算与提款
await c.proposeSettlement(id, 6000);
await c.acceptSettlement(id);
await c.withdraw(id);

// 仲裁（Dispute 页三选一 → bps）
await c.resolveDispute(id, 5000, rationaleHash);   // 10000 全退租客 / 5000 平分 / 0 全给房东

// Oracle 验房（冻结签名）
await c.recordInspection(id, true, reportHash);
const ins = await c.getInspection(id);  // recorded / passed / reportHash / updatedAt / recorder

// 验房事件监听（区块时间补齐）
c.on(c.filters.InspectionRecorded(id), async (_id, oracle, passed, hash, ev) => {
  const blk = await c.runner.provider.getBlock(ev.log.blockNumber);
});
```

## 8. Demo / Sepolia 双模式

- Demo 模式：沿用架构文档现有 localStorage 身份切换；验房状态同样映射为 recorded/passed 两 bool + reportHash + updatedAt（本地时间）+ recorder（演示身份地址）。
- Sepolia 模式：合约地址与 RPC 在 Protocol 页配置；Oracle 操作需持有 ORACLE_ROLE 的钱包（由 admin 在部署后 grantRole）。
- 所有页面状态以合约事件/视图重建，不信任本地缓存（架构文档第 3 节）。

## 9. 部署与运维（B 交付，assign R5）

- `deploy.mjs`：读取环境变量 SEPOLIA_RPC_URL、DEPLOYER_PRIVATE_KEY、可选 ADMIN_ADDRESS（缺省为部署者），一条命令复现部署，打印地址/交易/gas。
- 部署后流程：admin `grantRole(ORACLE_ROLE, C 的钱包)`（C 负责验房交易）→ Etherscan 验证源码 → 地址写入 README 与 Protocol 页。
- 运维立场（报告 §6.2）：MVP 不可变、无代理无暂停；提款路径永不可被阻断。
