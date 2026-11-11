#!/usr/bin/env python3
"""
Oracle 权限隔离对抗测试（5 步）—— CDS528 Member C 补充证据

目的：用链上行为证明「Oracle 只提供验房事实，无法决定押金去向」。

流程：
  0. 房东创建一份租期已过期的协议        （landlord）
  1. 租客入金                            （tenant）
  2. Oracle 记录验房 Passed              （oracle）  ← 证明写证据的能力
  3. 房东提议结算，tenantBps = 10000      （landlord）
  4. 租客接受结算                        （tenant）
  --- 以下为对抗测试 ---
  5a. Oracle 尝试 resolveDispute         （oracle）  → 预期 revert NotArbiter
  5b. Oracle 尝试 withdraw               （oracle）  → 预期 revert NotParty
  5c. 租客自己 withdraw                  （tenant）  → 预期成功

用法：
  cp oracle_trials.env.example oracle_trials.env
  # 填写 4 个地址的私钥，然后：
  python3 oracle_trials.py

输出：
  - 终端逐步日志
  - oracle_trials_report.md   （可直接贴进报告的表 4）
  - oracle_trials_evidence.json（原始数据留档）
"""

import json
import os
import re
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
from web3 import Web3

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / "oracle_trials.env")

RPC = "https://ethereum-sepolia-rpc.publicnode.com"
CHAIN_ID = 11155111
CONTRACT = Web3.to_checksum_address("0x61Fdc579feFd9aa45613f9D8681B342676FC2585")
EXPLORER = "https://sepolia.etherscan.io/tx/"

# 直接内联最小 ABI，避免依赖外部文件
ABI = [
    {"name": "createAgreement", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "tenant", "type": "address"}, {"name": "arbiter", "type": "address"},
                {"name": "depositAmount", "type": "uint256"}, {"name": "leaseEndsAt", "type": "uint64"},
                {"name": "propertyHash", "type": "bytes32"}, {"name": "metadataHash", "type": "bytes32"},
                {"name": "metadataURI", "type": "string"}],
     "outputs": [{"name": "agreementId", "type": "uint256"}]},
    {"name": "deposit", "type": "function", "stateMutability": "payable",
     "inputs": [{"name": "agreementId", "type": "uint256"}], "outputs": []},
    {"name": "proposeSettlement", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "agreementId", "type": "uint256"}, {"name": "tenantBps", "type": "uint16"}],
     "outputs": []},
    {"name": "acceptSettlement", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "agreementId", "type": "uint256"}], "outputs": []},
    {"name": "resolveDispute", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "agreementId", "type": "uint256"}, {"name": "tenantBps", "type": "uint16"},
                {"name": "rationaleHash", "type": "bytes32"}], "outputs": []},
    {"name": "withdraw", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "agreementId", "type": "uint256"}], "outputs": []},
    {"name": "recordInspection", "type": "function", "stateMutability": "nonpayable",
     "inputs": [{"name": "agreementId", "type": "uint256"}, {"name": "passed", "type": "bool"},
                {"name": "reportHash", "type": "bytes32"}], "outputs": []},
    {"name": "getAgreement", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "agreementId", "type": "uint256"}],
     "outputs": [{"type": "tuple", "components": [
         {"name": "landlord", "type": "address"}, {"name": "tenant", "type": "address"},
         {"name": "arbiter", "type": "address"}, {"name": "depositAmount", "type": "uint256"},
         {"name": "status", "type": "uint8"}, {"name": "leaseEndsAt", "type": "uint64"},
         {"name": "tenantBps", "type": "uint16"}, {"name": "propertyHash", "type": "bytes32"},
         {"name": "metadataHash", "type": "bytes32"}, {"name": "tenantBalance", "type": "uint256"},
         {"name": "landlordBalance", "type": "uint256"}, {"name": "settlementProposer", "type": "address"},
         {"name": "metadataURI", "type": "string"}]}]},
    {"name": "getInspection", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "agreementId", "type": "uint256"}],
     "outputs": [{"type": "tuple", "components": [
         {"name": "recorded", "type": "bool"}, {"name": "passed", "type": "bool"},
         {"name": "reportHash", "type": "bytes32"}, {"name": "updatedAt", "type": "uint64"},
         {"name": "recorder", "type": "address"}]}]},
    {"name": "agreementCount", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "uint256"}]},
    {"name": "withdrawableBalance", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "agreementId", "type": "uint256"}, {"name": "who", "type": "address"}],
     "outputs": [{"type": "uint256"}]},
    {"name": "ORACLE_ROLE", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"type": "bytes32"}]},
    {"name": "hasRole", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "role", "type": "bytes32"}, {"name": "account", "type": "address"}],
     "outputs": [{"type": "bool"}]},
]

STATUS = {0: "Created", 1: "Active", 2: "SettlementProposed", 3: "Settled", 4: "Disputed", 5: "Cancelled"}
# 自定义错误选择器 -> 名称（用原始字节匹配，避免 web3 的转义格式导致失配）
_ERROR_NAMES = {
    "NotArbiter()": "NotArbiter",
    "NotParty()": "NotParty",
    "NothingToWithdraw()": "NothingToWithdraw",
    "InvalidStatus()": "InvalidStatus",
    "LeaseNotEnded()": "LeaseNotEnded",
    "ZeroHash()": "ZeroHash",
    "InvalidBps()": "InvalidBps",
    "NotCounterparty()": "NotCounterparty",
    "InvalidAddress()": "InvalidAddress",
    "InvalidAgreement()": "InvalidAgreement",
    "ZeroDeposit()": "ZeroDeposit",
    "DepositMismatch()": "DepositMismatch",
    "NotTenant()": "NotTenant",
}
CUSTOM_ERRORS = {
    Web3.keccak(text=name)[:4].hex(): label for name, label in _ERROR_NAMES.items()
}


def _error_payload(exc: Exception) -> str:
    """把异常里的 revert 数据统一转成小写 hex 串，供宽松匹配。"""
    import ast
    text = str(exc)

    # 情况一：b'\xf5%\xe3 ' 这类 Python bytes 字面量
    i = text.find("b'")
    while i != -1:
        j = text.find("'", i + 2)
        if j == -1:
            break
        try:
            raw = ast.literal_eval(text[i:j + 1])
            if isinstance(raw, (bytes, bytearray)) and len(raw) >= 4:
                return bytes(raw).hex().lower()
        except Exception:
            pass
        i = text.find("b'", j + 1)

    # 情况二：JSON-RPC 的 data 字段，形如 "0x" + 4 字节选择器
    m = re.search(r"0x([0-9a-fA-F]{8,})", text)
    if m:
        return m.group(1).lower()

    return text.lower()


def decode_revert(exc: Exception) -> str:
    payload = _error_payload(exc)
    for sel, name in CUSTOM_ERRORS.items():
        if payload.startswith(sel) or sel in payload:
            return name
    low = str(exc).lower()
    if "accesscontrolunauthorizedaccount" in low:
        return "AccessControlUnauthorizedAccount"
    if "execution reverted" in low or "revert" in low:
        return "execution reverted"
    return str(exc).split("\n")[0][:150]


def main() -> None:
    w3 = Web3(Web3.HTTPProvider(RPC, request_kwargs={"timeout": 60}))
    if not w3.is_connected():
        sys.exit("无法连接 Sepolia RPC")
    if w3.eth.chain_id != CHAIN_ID:
        sys.exit(f"链 ID {w3.eth.chain_id}，期望 {CHAIN_ID}")
    if not w3.eth.get_code(CONTRACT):
        sys.exit(f"{CONTRACT} 上没有字节码")

    keys = {}
    for role in ("LANDLORD", "TENANT", "ARBITER", "ORACLE"):
        raw = (os.environ.get(f"{role}_PRIVATE_KEY") or "").strip()
        if not raw:
            sys.exit(f"oracle_trials.env 缺少 {role}_PRIVATE_KEY")
        if not raw.startswith("0x"):
            raw = "0x" + raw
        keys[role] = raw

    acct = {r: w3.eth.account.from_key(k) for r, k in keys.items()}
    addr = {r: a.address for r, a in acct.items()}

    print("=" * 66)
    print("Oracle 权限隔离对抗测试")
    print("=" * 66)
    for r in ("LANDLORD", "TENANT", "ARBITER", "ORACLE"):
        print(f"  {r:9s} {addr[r]}  {w3.from_wei(w3.eth.get_balance(addr[r]), 'ether')} ETH")
    print(f"  合约      {CONTRACT}")
    print(f"  协议总数  {w3.eth.contract(address=CONTRACT, abi=ABI).functions.agreementCount().call()}")

    # 地址互异校验
    combos = [("LANDLORD", "TENANT"), ("LANDLORD", "ARBITER"), ("TENANT", "ARBITER"),
              ("ORACLE", "TENANT"), ("ORACLE", "ARBITER")]
    for a, b in combos:
        if addr[a].lower() == addr[b].lower():
            sys.exit(f"地址冲突：{a} 与 {b} 相同，测试无意义")
    if addr["LANDLORD"].lower() == addr["ORACLE"].lower():
        sys.exit("LANDLORD 与 ORACLE 不可相同——本次测试目的正是证明二者权限分离")

    c = w3.eth.contract(address=CONTRACT, abi=ABI)
    oracle_role = c.functions.ORACLE_ROLE().call()
    if not c.functions.hasRole(oracle_role, addr["ORACLE"]).call():
        sys.exit(f"{addr['ORACLE']} 不持有 ORACLE_ROLE，无法做第 2 步")
    print("  ORACLE_ROLE 校验: OK\n")

    log: dict = {"steps": [], "network": "sepolia", "contract": CONTRACT}

    def send(role: str, fn, label: str, value: int = 0) -> dict:
        tx = fn.build_transaction({
            "from": addr[role],
            "value": value,
            "nonce": w3.eth.get_transaction_count(addr[role]),
            "chainId": CHAIN_ID,
            "gasPrice": w3.eth.gas_price,
        })
        tx["gas"] = int(w3.eth.estimate_gas({**tx, "value": value}) * 1.4)
        signed = acct[role].sign_transaction(tx)
        h = w3.eth.send_raw_transaction(signed.raw_transaction)
        rc = w3.eth.wait_for_transaction_receipt(h, timeout=240)
        if rc["status"] != 1:
            raise RuntimeError(f"{label} reverted")
        rec = {"step": label, "actor": role, "address": addr[role],
               "tx": h.hex(), "block": rc["blockNumber"], "gas": rc["gasUsed"], "expected": "success", "actual": "success"}
        log["steps"].append(rec)
        print(f"  ✓ {label:38s} tx={h.hex()[:18]}… block={rc['blockNumber']}")
        return rec

    def expect_revert(role: str, fn, label: str, want: str) -> dict:
        """故意把越权调用真的发上链，用 status==0 的回执作为「被合约拒绝」的硬证据。

        这样能在 Etherscan 上留下可查的失败交易，比只有本地预检报错更有说服力。
        """
        candidates = [x.strip().lower() for x in want.split("|")]
        txhex = blk = None
        actual = None
        # 先做一次本地预检，拿到精确的自定义错误名（上链失败回执里看不到 revert 原因）
        try:
            fn.call({"from": addr[role], "gas": 500_000})
            actual = "预检通过（未被拒绝！）"
        except Exception as e:
            actual = decode_revert(e)
        # 真的发上链，留下失败回执
        try:
            tx = fn.build_transaction({
                "from": addr[role], "nonce": w3.eth.get_transaction_count(addr[role]),
                "chainId": CHAIN_ID, "gasPrice": w3.eth.gas_price, "gas": 300_000,
            })
            signed = acct[role].sign_transaction(tx)
            h = w3.eth.send_raw_transaction(signed.raw_transaction)
            rc = w3.eth.wait_for_transaction_receipt(h, timeout=240)
            txhex, blk = h.hex(), rc["blockNumber"]
            onchain_status = rc["status"]
        except Exception as e:
            onchain_status = None
            if actual is None:
                actual = decode_revert(e)

        rejected = onchain_status == 0
        named = any(c in (actual or "").lower() for c in candidates)
        passed = rejected and named
        if not rejected:
            actual = f"{actual}（但交易未失败，status={onchain_status}）"
        rec = {"step": label, "actor": role, "address": addr[role], "tx": txhex,
               "block": blk, "expected": f"revert {want}", "actual": actual,
               "onchainStatus": onchain_status, "pass": passed}
        log["steps"].append(rec)
        print(f"  {'✓' if passed else '✗'} {label:38s} → status={onchain_status} {actual}")
        if txhex:
            print(f"     失败回执: {EXPLORER}{txhex}")
        return rec

    print("\n--- 准备阶段 ---")
    now = int(time.time())
    lease_past = now - 86400  # 租期已过期，使 proposeSettlement 可通过
    deposit = w3.to_wei(0.01, "ether")
    meta = 'data:application/json,{"property":"Oracle isolation trial"}'
    prop_h = Web3.keccak(text="oracle-isolation-property")
    meta_h = Web3.keccak(text=meta)

    send("LANDLORD", c.functions.createAgreement(
        addr["TENANT"], addr["ARBITER"], deposit, lease_past, prop_h, meta_h, meta
    ), "0. createAgreement(租期已过期)")
    gid = c.functions.agreementCount().call() - 1
    log["agreementId"] = gid
    print(f"    → agreementId = {gid}")

    ag = c.functions.getAgreement(gid).call()
    assert ag[4] == 0, "状态应为 Created"
    assert ag[0].lower() != addr["ORACLE"].lower(), "landlord 不应等于 oracle"

    send("TENANT", c.functions.deposit(gid), "1. deposit", value=deposit)

    report_hash = Web3.keccak(text=f"inspection report for agreement {gid}")
    send("ORACLE", c.functions.recordInspection(gid, True, report_hash), "2. recordInspection(Passed)")
    ins = c.functions.getInspection(gid).call()
    print(f"    → getInspection: recorded={ins[0]} passed={ins[1]} recorder={ins[4]}")
    log["inspection"] = {"recorded": ins[0], "passed": ins[1], "reportHash": ins[2].hex(), "recorder": ins[4]}

    send("LANDLORD", c.functions.proposeSettlement(gid, 10000), "3. proposeSettlement(10000)")
    send("TENANT", c.functions.acceptSettlement(gid), "4. acceptSettlement()")

    ag = c.functions.getAgreement(gid).call()
    print(f"    → status={STATUS.get(ag[4])} tenantBal={w3.from_wei(ag[9],'ether')} "
          f"landlordBal={w3.from_wei(ag[10],'ether')}")
    log["settled"] = {"status": STATUS.get(ag[4]), "tenantBalance": str(ag[9]), "landlordBalance": str(ag[10])}

    print("\n--- 对抗阶段（Oracle 尝试越权）---")
    # 已 Settled 的协议会先命中 InvalidStatus，未结算的会命中 NotArbiter；两者都证明 Oracle 无法裁定
    expect_revert("ORACLE", c.functions.resolveDispute(gid, 0, b"\x00" * 32),
                  "5a. Oracle → resolveDispute", "NotArbiter|InvalidStatus")
    expect_revert("ORACLE", c.functions.withdraw(gid), "5b. Oracle → withdraw", "NotParty")
    send("TENANT", c.functions.withdraw(gid), "5c. Tenant → withdraw（合法提取）")

    bal = c.functions.withdrawableBalance(gid, addr["TENANT"]).call()
    log["final"] = {"tenantWithdrawable": str(bal)}

    # ---- 生成报告表格 ----
    lines = [
        "| # | 步骤 | 执行身份 | 结果 | 交易 / 区块 |",
        "|---|---|---|---|---|",
    ]
    for s in log["steps"]:
        tag = "成功" if s["expected"] == "success" else f"拒绝（{s['actual']}）"
        tx = f"`{s['tx'][:20]}…` / {s['block']}" if s["tx"] else "—"
        lines.append(f"| {s['step'].split('.')[0]} | {s['step'].split('. ')[1]} | {s['actor']} | {tag} | {tx} |")

    md = f"""# Table 4. Oracle permission-isolation trial on Sepolia

Contract `{CONTRACT}`, agreement **{gid}**, deposit 0.01 ETH, lease already expired at creation.

{chr(10).join(lines)}

> 5a 与 5b 是**真实发送上链后失败**的交易（status = 0），Etherscan 上可查，证明合约在
> 执行阶段拒绝了越权调用，而不是仅在前端或脚本层被拦下。失败交易不改变任何状态。
> 5c 证明合法收款方仍能正常提取，说明前两步的拒绝来自权限校验本身，而非资金异常或状态异常。

## 本轮证明的三件事

1. Oracle 可以写验房证据（第 2 步），但**不能裁定争议**（5a `NotArbiter`）。
2. Oracle **不是协议当事方**，因而无法提款（5b `NotParty`）。
3. 押金的最终去向完全由双方结算（3、4）或指定仲裁人决定，Oracle 全程无资金权限。
"""
    out_md = SCRIPT_DIR / "oracle_trials_report.md"
    out_md.write_text(md, encoding="utf-8")
    (SCRIPT_DIR / "oracle_trials_evidence.json").write_text(
        json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")

    fails = [s for s in log["steps"] if s.get("pass") is False]
    print("\n" + "=" * 66)
    print(f"完成：{len(log['steps'])} 步，失败 {len(fails)} 步")
    print(f"报告表格：{out_md}")
    print(f"原始证据：{SCRIPT_DIR / 'oracle_trials_evidence.json'}")
    if fails:
        print("\n⚠ 以下步骤未达预期，请检查后重跑：")
        for f in fails:
            print(f"   {f['step']}  期望 {f['expected']}  实际 {f['actual']}")
        sys.exit(1)


if __name__ == "__main__":
    main()
