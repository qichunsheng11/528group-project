#!/usr/bin/env python3
"""
Rental Deposit Escrow — Oracle Demo mode simulator.

Simulates the full Oracle workflow without requiring a deployed contract:
  1. Hash a report file (SHA-256 -> bytes32)
  2. Print the exact transaction parameters that recordInspection expects
  3. Print the InspectionRecorded event that the contract should emit

This mirrors what Member C does in Sepolia mode, except no chain transaction
is submitted. Use it to verify hash consistency and parameter formatting
before running the real call.

Usage:
    python3 demo_inspection.py <agreement_id> <passed|failed> <report_file>

Example:
    python3 demo_inspection.py 1 passed sample_report_passed.txt
    python3 demo_inspection.py 2 failed sample_report_failed.txt
"""

import hashlib
import sys
from datetime import datetime, timezone
from pathlib import Path


DEMO_ORACLE_ADDRESS = "0x5555555555555555555555555555555555555555"


def simulate(agreement_id: int, passed: bool, report_path: str):
    raw = Path(report_path).read_bytes()
    report_hash = "0x" + hashlib.sha256(raw).digest().hex()
    now = int(datetime.now(timezone.utc).timestamp())

    print("=" * 60)
    print("ORACLE DEMO — recordInspection simulation")
    print("=" * 60)
    print(f"  Agreement ID : {agreement_id} (uint256)")
    print(f"  Passed       : {passed} (bool)")
    print(f"  Report file  : {report_path}")
    print(f"  Report size  : {len(raw)} bytes")
    print(f"  Algorithm    : SHA-256")
    print(f"  reportHash   : {report_hash} (bytes32)")
    print(f"  Oracle addr  : {DEMO_ORACLE_ADDRESS}")
    print(f"  Timestamp    : {now} (uint64, block time approximation)")
    print()

    print("- Function call (what you submit on-chain):")
    print(f"    recordInspection({agreement_id}, {str(passed).lower()}, {report_hash})")
    print()

    print("- Event that the contract should emit:")
    print(f"    InspectionRecorded(")
    print(f"      agreementId = {agreement_id}  (indexed, uint256)")
    print(f"      oracle      = {DEMO_ORACLE_ADDRESS}  (indexed, address)")
    print(f"      passed      = {str(passed).lower()}  (bool)")
    print(f"      reportHash  = {report_hash}  (bytes32)")
    print(f"    )")
    print()

    print("- getInspection() return value after this call:")
    print(f"    recorded   = true")
    print(f"    passed     = {str(passed).lower()}")
    print(f"    reportHash = {report_hash}")
    print(f"    updatedAt  = {now}")
    print(f"    recorder   = {DEMO_ORACLE_ADDRESS}")
    print()

    print("NOTE: This is a Demo-mode simulation. No chain transaction was submitted.")
    print("      In Sepolia mode, the same parameters are sent via recordInspection().")


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)

    try:
        agreement_id = int(sys.argv[1])
    except ValueError:
        print(f"Error: agreement_id must be an integer, got '{sys.argv[1]}'", file=sys.stderr)
        sys.exit(1)

    passed_str = sys.argv[2].lower()
    if passed_str not in ("passed", "failed", "true", "false"):
        print(f"Error: second argument must be 'passed' or 'failed', got '{sys.argv[2]}'", file=sys.stderr)
        sys.exit(1)
    passed = passed_str in ("passed", "true")

    report_path = sys.argv[3]
    if not Path(report_path).exists():
        print(f"Error: file not found: {report_path}", file=sys.stderr)
        sys.exit(1)

    simulate(agreement_id, passed, report_path)


if __name__ == "__main__":
    main()
