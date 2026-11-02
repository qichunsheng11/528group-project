# Oracle tools — Rental Deposit Escrow

Member C (Oracle) 的哈希计算和演示工具。

## 文件

| 文件 | 用途 |
|---|---|
| `hash_report.py` | 对验房报告算 SHA-256，输出 `bytes32` 哈希 |
| `demo_inspection.py` | 模拟一次完整的 `recordInspection` 调用流程，不实际发链上交易 |
| `sample_report_passed.txt` | 演示用：验房通过的报告 |
| `sample_report_failed.txt` | 演示用：验房未通过的报告 |

## 用法

### 1. 只算哈希

```bash
python3 hash_report.py sample_report_passed.txt
# 输出：0x...

python3 hash_report.py sample_report_passed.txt --json
# 输出 JSON（含文件路径、大小、算法、哈希、时间戳）
```

### 2. 模拟完整的验房上链流程（Demo 模式）

```bash
python3 demo_inspection.py 1 passed sample_report_passed.txt
python3 demo_inspection.py 2 failed sample_report_failed.txt
```

输出包含：
- `recordInspection` 的三个参数（agreementId, passed, reportHash）
- `InspectionRecorded` 事件的四个字段
- `getInspection` 调用后的返回值

## 哈希口径约定

- 算法：SHA-256
- 输入：报告文件的**原始字节**
- 输出：`0x` + 64 hex 字符（共 66 字符），对应 Solidity 的 `bytes32`
- 不做二次 keccak，不做任何编码转换

## Sepolia 模式下的对应操作

Demo 脚本里打印的参数，在 Sepolia 模式下用以下方式提交：

```bash
# 用 cast（Foundry）
cast send <CONTRACT_ADDRESS> "recordInspection(uint256,bool,bytes32)" \
  <AGREEMENT_ID> <true|false> <REPORT_HASH> \
  --rpc-url $SEPOLIA_RPC_URL \
  --private-key $ORACLE_PRIVATE_KEY

# 或用 ethers.js / viem 调用
```
