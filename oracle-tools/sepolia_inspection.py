#!/usr/bin/env python3
"""
Submit SHA-256 inspection evidence to RentalEscrow on Ethereum Sepolia.

Examples:
  python sepolia_inspection.py --check
  python sepolia_inspection.py --check --agreement-id 0
  python sepolia_inspection.py --agreement-id 0 --status passed --report inspection.txt

The script reads and writes through Sepolia JSON-RPC. Etherscan links are only
used for viewing a confirmed transaction; no Etherscan API key is required.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from eth_account import Account
from web3 import Web3


SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent
load_dotenv(SCRIPT_DIR / ".env")

SEPOLIA_CHAIN_ID = 11155111
RPC_URL = os.getenv(
    "SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com"
).strip()
RAW_ORACLE_KEY = (os.getenv("ORACLE_PRIVATE_KEY") or "").strip()
ORACLE_PRIVATE_KEY = (
    RAW_ORACLE_KEY
    if not RAW_ORACLE_KEY or RAW_ORACLE_KEY.startswith("0x")
    else f"0x{RAW_ORACLE_KEY}"
)

VALID_INSPECTION_STATUSES = {1, 2, 4}
STATUS_NAMES = {
    0: "Created",
    1: "Active",
    2: "SettlementProposed",
    3: "Settled",
    4: "Disputed",
    5: "Cancelled",
}


def fail(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_deployment_record() -> dict[str, Any]:
    path = PROJECT_ROOT / "deployment_record.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def load_abi() -> list[dict[str, Any]]:
    candidates = [
        Path(os.getenv("RENTAL_ESCROW_ABI", "")).expanduser()
        if os.getenv("RENTAL_ESCROW_ABI")
        else None,
        PROJECT_ROOT
        / "\u667a\u80fd\u5408\u7ea6"
        / "RentalEscrow.abi.json",
        SCRIPT_DIR / "RentalEscrow.abi.json",
    ]
    for candidate in candidates:
        if candidate and candidate.is_file():
            try:
                abi = json.loads(candidate.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                fail(f"cannot read ABI at {candidate}: {exc}")
            if not isinstance(abi, list) or not abi:
                fail(f"ABI at {candidate} is empty or invalid")
            return abi
    fail(
        "RentalEscrow.abi.json was not found. Keep the oracle-tools folder next "
        "to the smart-contract folder, or set RENTAL_ESCROW_ABI."
    )


def configured_contract_address() -> str:
    address = (os.getenv("CONTRACT_ADDRESS") or "").strip()
    if not address:
        address = str(load_deployment_record().get("contractAddress") or "").strip()
    if not address:
        fail("CONTRACT_ADDRESS is missing from .env and deployment_record.json")
    if not Web3.is_address(address):
        fail(f"CONTRACT_ADDRESS is not a valid EVM address: {address}")
    return Web3.to_checksum_address(address)


def connect() -> tuple[Web3, Any, str, str]:
    if not ORACLE_PRIVATE_KEY:
        fail("ORACLE_PRIVATE_KEY is missing from oracle-tools/.env")
    try:
        oracle_account = Account.from_key(ORACLE_PRIVATE_KEY)
    except ValueError as exc:
        fail(f"ORACLE_PRIVATE_KEY is invalid: {exc}")

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
    if not w3.is_connected():
        fail(f"cannot connect to Sepolia RPC: {RPC_URL}")

    chain_id = w3.eth.chain_id
    if chain_id != SEPOLIA_CHAIN_ID:
        fail(
            f"RPC is chain {chain_id}, expected Sepolia chain {SEPOLIA_CHAIN_ID}. "
            "Check SEPOLIA_RPC_URL."
        )

    contract_address = configured_contract_address()
    if not w3.eth.get_code(contract_address):
        fail(f"no contract bytecode exists at {contract_address} on Sepolia")

    contract = w3.eth.contract(address=contract_address, abi=load_abi())
    return w3, contract, contract_address, oracle_account.address


def compute_report_hash(report_path: Path) -> tuple[bytes, bytes]:
    raw = report_path.read_bytes()
    if not raw:
        fail(f"inspection report is empty: {report_path}")
    return raw, hashlib.sha256(raw).digest()


def agreement_summary(contract: Any, agreement_id: int) -> tuple[int, int]:
    if agreement_id < 0:
        fail("agreement id must be zero or greater")
    count = int(contract.functions.agreementCount().call())
    if agreement_id >= count:
        fail(f"agreement {agreement_id} does not exist; agreementCount is {count}")
    agreement = contract.functions.getAgreement(agreement_id).call()
    status = int(agreement[4])
    deposit_amount = int(agreement[3])
    return status, deposit_amount


def inspection_summary(contract: Any, agreement_id: int) -> dict[str, Any]:
    inspection = contract.functions.getInspection(agreement_id).call()
    return {
        "recorded": bool(inspection[0]),
        "passed": bool(inspection[1]),
        "reportHash": "0x" + bytes(inspection[2]).hex(),
        "updatedAt": int(inspection[3]),
        "recorder": inspection[4],
    }


def send_tx(
    w3: Web3,
    tx_dict: dict[str, Any],
    private_key: str,
    label: str,
) -> tuple[str, Any]:
    account = Account.from_key(private_key)
    tx_dict = dict(tx_dict)
    tx_dict.setdefault("from", account.address)
    tx_dict["nonce"] = w3.eth.get_transaction_count(account.address, "pending")
    tx_dict["chainId"] = w3.eth.chain_id
    if "gas" not in tx_dict:
        tx_dict["gas"] = int(w3.eth.estimate_gas(tx_dict) * 1.35)
    if "gasPrice" not in tx_dict:
        tx_dict["gasPrice"] = w3.eth.gas_price

    signed = account.sign_transaction(tx_dict)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    tx_hex = tx_hash.hex()
    print(f"  [{label}] tx hash: {tx_hex}")
    print(f"  [{label}] waiting for confirmation...")
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if int(receipt["status"]) != 1:
        fail(f"{label} transaction reverted: {tx_hex}")
    print(
        f"  [{label}] confirmed in block {receipt['blockNumber']}, "
        f"gas {receipt['gasUsed']}"
    )
    return tx_hex, receipt


def check_configuration(
    w3: Web3,
    contract: Any,
    contract_address: str,
    oracle_address: str,
    agreement_id: int | None = None,
) -> None:
    print("Configuration")
    print(f"  RPC chain:          Sepolia ({w3.eth.chain_id})")
    print(f"  Contract:           {contract_address}")
    print(f"  Oracle wallet:      {oracle_address}")
    print(f"  Oracle balance:     {w3.from_wei(w3.eth.get_balance(oracle_address), 'ether')} ETH")
    print(
        f"  Agreements onchain: {contract.functions.agreementCount().call()}"
    )

    oracle_role = contract.functions.ORACLE_ROLE().call()
    has_role = contract.functions.hasRole(oracle_role, oracle_address).call()
    print(f"  ORACLE_ROLE:        {'yes' if has_role else 'NO'}")
    if not has_role:
        fail("the configured wallet does not hold ORACLE_ROLE")

    if agreement_id is not None:
        status, deposit_amount = agreement_summary(contract, agreement_id)
        inspection = inspection_summary(contract, agreement_id)
        print(
            f"  Agreement {agreement_id}:       "
            f"{STATUS_NAMES.get(status, status)}, "
            f"deposit {w3.from_wei(deposit_amount, 'ether')} ETH"
        )
        if status not in VALID_INSPECTION_STATUSES:
            print("  Inspection writes:  blocked by current agreement status")
        else:
            print("  Inspection writes:  allowed")
        print(f"  Current inspection: {inspection}")
    print()


def record_inspection(
    w3: Web3,
    contract: Any,
    agreement_id: int,
    passed: bool,
    report_file: Path,
    oracle_private_key: str,
    oracle_address: str,
) -> str:
    status, _ = agreement_summary(contract, agreement_id)
    if status not in VALID_INSPECTION_STATUSES:
        fail(
            f"agreement {agreement_id} is {STATUS_NAMES.get(status, status)}; "
            "inspection writes require Active, SettlementProposed or Disputed"
        )

    raw, report_hash = compute_report_hash(report_file)
    result = "Passed" if passed else "Failed"
    print(f"Record {result} inspection for agreement {agreement_id}")
    print(f"  Report file:  {report_file}")
    print(f"  Report bytes: {len(raw)}")
    print(f"  SHA-256:      0x{report_hash.hex()}")
    print(f"  Oracle:       {oracle_address}")

    tx_hash, _ = send_tx(
        w3,
        contract.functions.recordInspection(
            agreement_id, passed, report_hash
        ).build_transaction({"from": oracle_address}),
        oracle_private_key,
        "recordInspection",
    )
    inspection = inspection_summary(contract, agreement_id)
    if (
        not inspection["recorded"]
        or inspection["passed"] != passed
        or inspection["reportHash"].lower() != "0x" + report_hash.hex()
    ):
        fail(f"on-chain inspection verification failed for {tx_hash}")

    etherscan_url = f"https://sepolia.etherscan.io/tx/{tx_hash}"
    print(f"  Verified inspection: {inspection}")
    print(f"  Etherscan:            {etherscan_url}")
    print()
    return etherscan_url


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Record SHA-256 inspection evidence on RentalEscrow (Sepolia)."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="validate configuration and permissions without sending a transaction",
    )
    parser.add_argument(
        "--agreement-id",
        type=int,
        help="existing agreement ID to inspect",
    )
    parser.add_argument(
        "--status",
        choices=("passed", "failed"),
        help="inspection outcome to record",
    )
    parser.add_argument(
        "--report",
        type=Path,
        help="inspection report file used to compute the SHA-256 commitment",
    )
    args = parser.parse_args()

    if args.report and not args.report.is_file():
        parser.error(f"report file not found: {args.report}")
    if not args.check:
        if args.agreement_id is None:
            parser.error("--agreement-id is required")
        if args.status is None:
            parser.error("--status is required")
        if args.report is None:
            parser.error("--report is required")
    return args


def main() -> None:
    args = parse_args()
    w3, contract, contract_address, oracle_address = connect()
    check_configuration(
        w3,
        contract,
        contract_address,
        oracle_address,
        args.agreement_id,
    )
    if args.check:
        return

    record_inspection(
        w3,
        contract,
        args.agreement_id,
        args.status == "passed",
        args.report.resolve(),
        ORACLE_PRIVATE_KEY,
        oracle_address,
    )


if __name__ == "__main__":
    main()
