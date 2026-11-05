# Rental Deposit Escrow with an Inspection Oracle

**CDS528 Group Assignment — Blockchain DeFi Smart Contract Development**
Lingnan University

> **Repository:** `https://github.com/<OWNER>/528group-project`
> **Live demo (Sepolia):** [`0x61Fdc579feFd9aa45613f9D8681B342676FC2585`](https://sepolia.etherscan.io/address/0x61Fdc579feFd9aa45613f9D8681B342676FC2585)
> **Chain:** Ethereum Sepolia (chainId `11155111`)

---

## 1. The problem

A rental deposit is money held by somebody who is not its owner. In Hong Kong the
landlord holds it, so the tenant depends on the landlord's honesty and on a slow
small-claims process. Three things go wrong repeatedly:

1. **Custody risk** — the deposit sits in the landlord's account; return is a favour, not a right.
2. **Evidence risk** — the check-out inspection is a paper form signed by interested parties.
   Whoever holds the form can also edit it.
3. **Deadlock risk** — when the two sides disagree there is no neutral, cheap, fast arbiter.

A database cannot fix this, because the database owner is one of the parties. What
the parties lack is a **shared state machine with an independent source of facts**.
That is exactly what a smart contract plus a permissioned inspection oracle provides:
the deposit is held by code, the state transitions are visible to both sides, and the
inspection result can only be written by a wallet that the contract has authorised —
while the split of the money stays in human hands.

**Scope:** one property, one deposit, one lease, one inspection, one optional dispute.
Not a marketplace, not a rental search engine, not a payment rail.

## 2. Architecture

```
        ┌──────────────┐   createAgreement    ┌────────────────────────────┐
        │   Landlord   │─────────────────────▶│                            │
        └──────┬───────┘                      │                            │
               │ deposit (exact amount)       │      RentalEscrow.sol      │
        ┌──────▼───────┐                      │   (Sepolia, immutable)     │
        │   Tenant     │─────────────────────▶│                            │
        └──────┬───────┘   propose / accept   │  deposit locked by code    │
               │           raiseDispute       │  balances assigned on rule │
               │                              └───────┬────────────┬───────┘
        ┌──────▼───────┐   resolveDispute             │            │
        │   Arbiter    │──────────────────────────────┘            │
        └──────────────┘   (fixed at creation)                     │ recordInspection
                                                                   │ (facts only)
        ┌──────────────┐   SHA-256 report hash              ┌──────▼───────┐
        │ Off-chain    │───────────────────────────────────▶│    Oracle    │
        │ report file  │                                    │ ORACLE_ROLE  │
        └──────────────┘                                    └──────────────┘

        Front-end: single-file dApp (EscrowKey.html) ── MetaMask ── Sepolia RPC
        Oracle tooling: Python scripts (oracle-tools/) ── JSON-RPC ── Sepolia
```

### On-chain vs off-chain partitioning

| Concern | Where | Why |
|---|---|---|
| Deposit custody, state transitions, split arithmetic | **On-chain** | Trust-critical; must be atomic and public |
| House name, address, tenancy PDF, inspection photos | **Off-chain** (`metadataURI`, `metadataHash`, `reportHash`) | Cheap, private, unbounded size; anchored by hash |
| Inspection decision (pass / fail) | **On-chain bool + report hash** | The contract consumes the fact, not the file |
| Deposit allocation | **On-chain**, decided by parties or arbiter | The oracle is never allowed to move money |
| Event history, UI, notifications | **Off-chain** rebuild from logs | Storage on-chain is expensive |

### State machine

```
Created ──deposit──▶ Active ──proposeSettlement──▶ SettlementProposed ──acceptSettlement──▶ Settled
   │                   │  └────────────raiseDispute─────────────┐
   │                   └────────raiseDispute──▶ Disputed ──resolveDispute──▶ Settled
   └──cancelAgreement──▶ Cancelled

Inspection lane (independent): writable only in Active / SettlementProposed / Disputed.
It never changes the status and never changes a balance.
```

### Roles

| Role | Granted | Can do | Cannot do |
|---|---|---|---|
| `landlord` (per agreement) | recorded in `createAgreement` | create, propose/accept settlement, raise dispute, withdraw its share | deposit, rule a dispute |
| `tenant` (per agreement) | recorded in `createAgreement` | deposit exactly once, propose/accept settlement, raise dispute, withdraw its share | cancel after funding |
| `arbiter` (per agreement) | fixed at creation | issue exactly one ruling on a dispute | touch an agreement that is not disputed |
| `ORACLE_ROLE` (global) | `grantRole` by admin | write `passed` + `reportHash` | change status, move funds, rule a dispute |
| `DEFAULT_ADMIN_ROLE` (global) | constructor | grant / revoke `ORACLE_ROLE` | move user funds, rule a dispute |

This separation is the core design claim: **the party that supplies facts is not the
party that moves money.** Section 6 shows a test that proves it.

## 3. Repository layout

```
.
├── contracts/
│   ├── RentalEscrow.sol            # the escrow + inspection lane (canonical source)
│   └── test/ReentrantTenant.sol    # test-only attacker used by the reentrancy test
├── test/
│   ├── helpers.js                  # fixtures, account cast, time helpers
│   ├── 01-lifecycle.test.js        # functional + negative paths
│   └── 02-security.test.js         # access control, oracle lane, reentrancy, invariants
├── scripts/
│   ├── deploy.js                   # reproducible Sepolia deployment
│   └── grant-oracle.js             # grantRole(ORACLE_ROLE, ...)
├── 智能合约/                        # Member B's original artefacts (ABI, bytecode, integration doc)
├── oracle-tools/                   # Member C's Python oracle tooling (hash + record evidence)
├── EscrowKey.html                  # Member A's single-file dApp
├── security/slither-raw.txt        # full static-analysis output used in the report
├── deployment_record.json          # address, tx hashes, block numbers
└── hardhat.config.js
```

`contracts/RentalEscrow.sol` is byte-identical to `智能合约/RentalEscrow.sol`. The
Hardhat project compiles from `contracts/`; the ABI consumed by the dApp and the
Python tools is `智能合约/RentalEscrow.abi.json`.

## 4. Quick start

**Prerequisites:** Node.js ≥ 18, npm, Python ≥ 3.10, MetaMask (browser), a Sepolia RPC URL.

```bash
# 1. dependencies
npm install

# 2. compile (solc 0.8.24, optimizer enabled, 200 runs)
npm run compile

# 3. run the full test suite (69 tests)
npm test

# 4. optional: gas report
npm run gas
```

### Deploy to Sepolia

```bash
cp .env.example .env         # then edit .env: SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY
npm run compile
npm run deploy:sepolia       # prints address + tx hash, refreshes deployment_record.json

# grant the oracle wallet its role (must be signed by DEFAULT_ADMIN_ROLE)
npm run grant:oracle -- --oracle 0xYourOracleWallet
```

`.env` is git-ignored. No private key is ever hard-coded in this repository.

### Run the dApp

The dApp is a single HTML file that talks to Sepolia through MetaMask. Serve it over
HTTP (opening it with `file://` blocks some wallet APIs):

```bash
python -m http.server 8765
# then open http://localhost:8765/EscrowKey.html
```

1. Connect MetaMask and switch to Sepolia.
2. **Protocol** page: confirm the contract address (`0x61Fdc...2585`).
3. **New agreement**: landlord creates; the tenant address and the arbiter address are
   both required at creation.
4. **Deposit**: the tenant sends the exact deposit amount.
5. **Oracle** page: paste the SHA-256 of the inspection report (see below) and record
   `Passed` / `Failed`. This never releases the deposit.
6. **Settlement** or **Dispute**: the parties split the deposit, or the arbiter rules.
7. **Withdraw**: each side pulls its own balance.

### Record inspection evidence from the CLI

```bash
cd oracle-tools
pip install -r requirements.txt
cp .env.example .env          # ORACLE_PRIVATE_KEY + SEPOLIA_RPC_URL

python hash_report.py sample_report_passed.txt       # → 0x12ad87...
python sepolia_inspection.py --check                 # network + role + bytecode
python sepolia_inspection.py --agreement-id 0 --status passed --report sample_report_passed.txt
```

Hash convention: **SHA-256 of the file's original bytes**, printed as `0x` + 64 hex
characters. No second hashing, no re-encoding. Anyone holding the file can recompute it.

## 5. Live deployment (Sepolia)

| Item | Value |
|---|---|
| Contract | `0x61Fdc579feFd9aa45613f9D8681B342676FC2585` |
| Network / chainId | Sepolia / `11155111` |
| Compiler | solc `0.8.24`, optimizer `200` runs |
| Admin (`DEFAULT_ADMIN_ROLE`) | `0x24fc1A20d4b0443055AFB81AdA6D908C91987b35` |
| Oracle (`ORACLE_ROLE`) | `0x78806E756B9E43012E369B99932f04299d32076D` |
| Deployer / deploy tx | see `deployment_record.json` |

On-chain evidence (verified with `eth_getLogs` from the deployment block):

| Event | Count |
|---|---|
| `AgreementCreated` | 4 (ids 0–3) |
| `DepositFunded` | 4 |
| `InspectionRecorded` | 4 (Passed, Failed, Passed, Failed) |
| `RoleGranted` / `RoleRevoked` | 1 / 1 (oracle rotation) |

> **Documentation note.** `deployment_record.json` was written before the oracle wallet
> was rotated. The live `ORACLE_ROLE` holder is `0x7880…076D` (granted at block
> 12048905); the earlier wallet `0xD6109fB5…` had its role revoked at block 12048904.
> The README and the report use the live values.

## 6. Testing (R4)

```bash
npm test        # 69 passing
```

| Group | What it pins down |
|---|---|
| `createAgreement` | id monotonicity, zero-address guards, landlord ≠ tenant ≠ arbiter, zero deposit |
| `deposit` | exact-amount rule (under/over pay rejected), single deposit, tenant-only |
| `cancelAgreement` | party-only, unfunded-only, cannot cancel locked funds |
| `proposeSettlement` / `acceptSettlement` | `LeaseNotEnded` boundary, bps ∈ [0, 10000], proposer cannot self-approve, no rounding leak |
| `raiseDispute` / `resolveDispute` | evidence hash required, arbiter-only, exactly one ruling, full / even / intermediate splits |
| `withdraw` | pull pattern, zero balance, third party, double withdrawal |
| `inspection lane` | role gate, zero hash, status gate (`{Active, SettlementProposed, Disputed}`), overwrite semantics, **no effect on status or balances** |
| `reentrancy` | a malicious tenant contract re-enters `withdraw()` and gets nothing extra |
| `invariants` | `tenantBalance + landlordBalance == depositAmount` for 8 different bps values; contract balance always equals what it still owes |

Evidence that the oracle cannot move money (verbatim from the suite):

```
√ never changes status, balances or the amount the tenant can withdraw
√ the admin cannot move user funds
√ the admin cannot rule a dispute
√ a malicious tenant cannot drain the escrow through receive()
```

## 7. Security review (R4)

`python -m slither . --filter-paths "contracts/test"` → 15 results, 4 detector families.
Full output: [`security/slither-raw.txt`](security/slither-raw.txt).

| Detector | Finding | Triage |
|---|---|---|
| `uninitialized-local` | `amount` in `withdraw()` | **False positive.** Assigned on every branch before use; Slither cannot see through the if/else-if/else revert. |
| `timestamp` | `block.timestamp < leaseEndsAt` | **Accepted.** Lease boundaries are day-granularity; a miner's ±15 s drift cannot flip a month-long lease. |
| `low-level-calls` | `call{value:}` in `withdraw()` | **Intentional.** Pull-payment pattern; balance is zeroed before the call and the function is `nonReentrant`. |
| `solc-version` / `assembly` | inherited from OpenZeppelin dependencies | Informational; OZ 5.x is pinned and audited upstream. |

### Top three threats and how the design mitigates them

1. **Reentrancy on withdrawal** (`withdraw` is the only ETH exit).
   *Mitigation:* checks-effects-interactions (balance zeroed before the external
   call), `ReentrancyGuard` from OpenZeppelin, pull-payment instead of push.
   *Proof:* `contracts/test/ReentrantTenant.sol` + the reentrancy test — the attacker
   re-enters once and receives exactly one payout.
2. **Oracle or admin abuse** (the oracle is the most privileged off-chain actor).
   *Mitigation:* `ORACLE_ROLE` is a global role that can only write
   `(bool passed, bytes32 reportHash)`; it cannot change status, cannot assign
   balances, and cannot withdraw. The admin can only grant/revoke the role. Settlement
   authority stays with the parties and the recorded arbiter.
   *Proof:* the inspection-lane tests and "the admin cannot move user funds".
3. **Funds locked forever / denial of settlement** (state-machine griefing).
   *Mitigation:* every funded agreement has a unilateral escape: either party may
   `raiseDispute` at any time while Active or SettlementProposed, and the arbiter must
   be a fixed, reachable address supplied at creation. `cancelAgreement` is
   deliberately restricted to the unfunded state so nobody can cancel away locked money.
   *Residual risk (documented, not fixed):* there is **no timeout** that settles a
   case if the counterparty refuses to act *and* the arbiter disappears. Because the
   contract is immutable and has no pause, such an agreement would stay locked. This is
   the price of "immutable for simplicity"; the production fix is a staked arbiter with
   a fallback ruling deadline (see §9).

## 8. Ops stance (R5)

- **Immutable by design**: no proxy, no upgrade path, no pause. Rationale: the only
  thing worse than a bug in an escrow is an admin key that can freeze withdrawals.
  Withdrawal paths must never be blockable.
- **Reproducible deploy**: `npm run compile && npm run deploy:sepolia`, one script,
  no manual steps, environment-driven configuration.
- **Verification**: source verification on Etherscan is tracked as an open item — see §9.
- **Key management**: deployer, admin and oracle are separate wallets; keys live in
  `.env` only (git-ignored) and in the course team's password manager.

## 9. Known limitations

| Limitation | Impact | Planned fix |
|---|---|---|
| No settlement timeout | Counterparty + arbiter can both stall; deposit stays locked | Arbiter staking + a `finalizeAfter` deadline that defaults to a 50/50 split |
| Oracle is a single trusted key | A compromised oracle can write a false fact (but still cannot move money) | Multi-oracle quorum, or an attestation scheme with a dispute window |
| `metadataURI` stored as a string | Unbounded calldata cost for long URIs | Emit it in the event only, keep a hash on-chain |
| Source not yet verified on Etherscan | Graders must trust the repo bytecode | Verify with solc 0.8.24 / optimizer 200 / matching source path |
| No end-to-end settlement recorded on Sepolia yet | Only deposit + inspection are demonstrated live | Run one full lifecycle (create → deposit → inspect → settle → withdraw) and archive the tx hashes |

## 10. Team and contributions

| Member | Scope | Artefacts |
|---|---|---|
| A | Front-end / dApp, wallet flows, page architecture | `EscrowKey.html` |
| B | Smart contract, ABI freeze, deployment script | `contracts/RentalEscrow.sol`, `智能合约/`, `scripts/` |
| C | Inspection oracle tooling, on-chain evidence | `oracle-tools/`, `deployment_record.json` |
| D | Testing, security review, documentation, delivery | `test/`, `security/`, this README, report, slides |

## 11. References and licences

- OpenZeppelin Contracts v5 — `AccessControl`, `ReentrancyGuard` (MIT).
  <https://github.com/OpenZeppelin/openzeppelin-contracts>
- Ethereum Developer Portal — tutorials on Solidity, testing, security.
  <https://ethereum.org/developers/tutorials/>
- Slither — static analysis framework for Solidity (AGPL-3.0).
  <https://github.com/crytic/slither>
- Hardhat — Ethereum development environment (MIT). <https://hardhat.org>
- Buterin, V. (2014). *Ethereum white paper*.
- Wood, G. (2014). *Ethereum: A secure decentralised generalised transaction ledger*.
- Nakamoto, S. (2008). *Bitcoin: A peer-to-peer electronic cash system*.
- Szabo, N. (1997). Formalizing and securing relationships on public networks.
  *First Monday, 2*(9).

This project is released under the MIT licence (see `LICENSE`).

### AI-assisted development disclosure

Parts of the test suite, the Hardhat scaffolding and this README were drafted with an
AI assistant and then reviewed, executed and corrected by the team. Every claim in
§5 and §6 is reproducible from the commands in §4; the AI did not author the contract
logic, which was written and frozen by Member B before this review.

---

### Rubric map

| Criterion | Where |
|---|---|
| R1 Problem statement | §1 |
| R2 Solution design | §2 (partitioning, state machine, roles) |
| R3 Implementation | §2, §7 (events, access control, gas: packed struct, `calldata`, no unbounded loops) |
| R4 Testing & security | §6, §7, `test/`, `security/slither-raw.txt` |
| R5 Deployment & DevOps | §5, §8, `scripts/` |
| R6 Documentation | this file, §4 quick start, §11 citations |
