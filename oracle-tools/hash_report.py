#!/usr/bin/env python3
"""
Rental Deposit Escrow — Oracle report hashing utility.

Usage:
    python3 hash_report.py <report_file> [--json]

Examples:
    python3 hash_report.py inspection_passed.txt
    python3 hash_report.py inspection_failed.txt --json

Output:
    default: prints the 0x-prefixed bytes32 hash only
    --json:  prints a JSON object with file, size, sha256, bytes32, timestamp
"""

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def compute_report_hash(report_path: str) -> dict:
    """Read a report file, compute SHA-256, return bytes32 hex string and metadata."""
    path = Path(report_path)
    if not path.exists():
        print(f"Error: file not found: {report_path}", file=sys.stderr)
        sys.exit(1)

    raw = path.read_bytes()
    if len(raw) == 0:
        print("Error: report file is empty", file=sys.stderr)
        sys.exit(1)

    digest = hashlib.sha256(raw).digest()
    bytes32_hex = "0x" + digest.hex()

    return {
        "file": str(path.resolve()),
        "size_bytes": len(raw),
        "algorithm": "SHA-256",
        "sha256": bytes32_hex,
        "bytes32": bytes32_hex,
        "computed_at": datetime.now(timezone.utc).isoformat(),
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    report_file = sys.argv[1]
    as_json = "--json" in sys.argv

    result = compute_report_hash(report_file)

    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print(result["bytes32"])


if __name__ == "__main__":
    main()
