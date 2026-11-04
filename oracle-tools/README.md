# Oracle tools - Rental Deposit Escrow

Member C's inspection-evidence tools for the RentalEscrow dApp.

The live path uses Ethereum Sepolia JSON-RPC. The script signs and broadcasts a
real `recordInspection(uint256,bool,bytes32)` transaction. Etherscan links show
the confirmed transaction, block, event and arguments; Etherscan is not used as
the data source, and no Etherscan API key is required.

## Files

| File | Purpose |
|---|---|
| `hash_report.py` | Compute the SHA-256 commitment for an inspection report |
| `sepolia_inspection.py` | Validate the Sepolia contract and record real inspection evidence |
| `demo_inspection.py` | Show the exact call without sending a transaction |
| `sample_report_passed.txt` | Sample report with a passed result |
| `sample_report_failed.txt` | Sample report with a failed result |
| `.env.example` | Safe environment-variable template |
| `.env` | Local private key and configuration; never commit or share |

The default contract is taken from `.env`, then from the project's
`deployment_record.json`. The script also loads the final ABI from
`../智能合约/RentalEscrow.abi.json`.

## Setup

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
```

Fill `ORACLE_PRIVATE_KEY` in `.env` with the Sepolia-only Oracle wallet key.
Keep `SEPOLIA_RPC_URL` and `CONTRACT_ADDRESS` set to:

```dotenv
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
CONTRACT_ADDRESS=0x61Fdc579feFd9aa45613f9D8681B342676FC2585
```

No private key should appear in source code, the report, screenshots, or Git.
The script always rejects any RPC network other than Sepolia chain `11155111`.

## Recommended demo flow

1. In the dApp, create an agreement on Sepolia and have the tenant fund it.
2. Run `hash_report.py` on the inspection report.
3. Either paste that SHA-256 value into the dApp Oracle card, or record it with
   `sepolia_inspection.py --agreement-id <id> --status passed --report <file>`.
4. Refresh the dApp Oracle page and then open the Etherscan transaction link.

The current Sepolia contract already contains agreements `0` to `3`, each with
a verified inspection record. They are useful as a fallback demonstration.

## Commands

Check the network, contract bytecode, Oracle role and an optional agreement
without sending a transaction:

```powershell
python sepolia_inspection.py --check
python sepolia_inspection.py --check --agreement-id 0
```

Record against an agreement already created by the dApp:

```powershell
python sepolia_inspection.py --agreement-id 0 --status passed --report path\to\passed-report.txt
python sepolia_inspection.py --agreement-id 0 --status failed --report path\to\failed-report.txt
python sepolia_inspection.py --agreement-id 0 --status passed --report path\to\report.txt
```

The script intentionally operates only on agreements created through the dApp.
It does not create protocols, fund temporary wallets or modify settlement state.

## Hash convention

- Algorithm: SHA-256
- Input: the report file's original bytes
- Output: `0x` plus 64 hexadecimal characters
- Solidity type: `bytes32`
- No second hashing and no text re-encoding

```powershell
python hash_report.py sample_report_passed.txt
python hash_report.py sample_report_passed.txt --json
```

The deployed contract stores the hash but cannot verify which off-chain file it
belongs to. Keep the report file unchanged after hashing so another person can
recompute the same value.

## Current Sepolia evidence

The newest deployed contract
`0x61Fdc579feFd9aa45613f9D8681B342676FC2585` has verified `ORACLE_ROLE`
authorization for
`0x78806E756B9E43012E369B99932f04299d32076D`.

| Result | Agreement | Transaction |
|---|---:|---|
| Passed | 0 | `0x448dc84fbad8b599d98a73b674141be6be20b07b037561e9b8b184ea555bb27f` |
| Failed | 1 | `0xb2288e389244849a02fddc3f5c38e99c6138aba9d2539c8e87cc97f33974d699` |
| Passed | 2 | `0xee4d51a45335a31616311d3e8077b6f76ca15ee084602d77bfd02393caeadf61` |
| Failed | 3 | `0x1eab82e4c54c402df845c89fa0b045c334ebb83aa51c3bad61809835123d00bb` |

Both sample reports have reproducible hashes:

```text
passed: 0x12ad87614a233ff07eeedcfa98ee394e2e95dbd5a86fd63f09f2695f571224f9
failed: 0xf1d4a98c6d4fb15df345d70851d5d98bc1467de48f21973681324b04889ac6b9
```

## Frontend

Open `EscrowKey修改版.html` through a local HTTP server:

```powershell
python -m http.server 8765
```

The page targets Sepolia (`chainId 11155111`) and is prefilled with the current
contract address. Connect MetaMask, allow it to switch to Sepolia, and use the
wallet that holds the role needed for each action. Use the Protocol page only
when changing to another deployment.

The dApp and `sepolia_inspection.py` now use the same final ABI, zero-based
agreement IDs and SHA-256 report-hash convention.
