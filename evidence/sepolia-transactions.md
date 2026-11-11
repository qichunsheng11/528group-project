# Archived Sepolia transactions (report Tables 2-4)

Contract `0x61Fdc579feFd9aa45613f9D8681B342676FC2585`, chainId `11155111`.
Full hashes are kept here so the report's tables can be checked against
Sepolia Etherscan without relying on screenshots. Machine-readable receipts:
[`oracle_trials_evidence.json`](oracle_trials_evidence.json).

## Deployment and ORACLE_ROLE rotation (report Table 2)

| Event | Block | Transaction |
|---|---|---|
| Deployment; admin `DEFAULT_ADMIN_ROLE` -> `0x24fc1A20d4b0443055AFB81AdA6D908C91987b35` | 12047570 | `0xeb37524def731fec7fca96a9a718cb5d123bd0024130074cad2ac6960e43fdcc` |
| First ORACLE_ROLE grant -> `0xD6109fB570846EB41AaFc72c0C473517A0d5EBd9` | 12047571 | `0xd7ba7d5c339c7b24af5e9671fd871e6635b56fcd0ffc39d1ee88d339c3d933ee` |
| Revoke from `0xD6109fB570846EB41AaFc72c0C473517A0d5EBd9` | 12048904 | `0x50c0f7515fce95065d75dbb03b3c40935ead198ec9ccc2fe50fcbd1b660fa12b` |
| Grant to current Oracle `0x78806E756B9E43012E369B99932f04299d32076D` | 12048905 | `0xde6365ceadbfa74a683754db12ae95f09576a7666fc4da9e807aedffbfb0df70` |

`RoleGranted` therefore fires three times (constructor admin grant + two
ORACLE_ROLE grants) and `RoleRevoked` once.

## Six inspection receipts (report Table 3 + agreement 5)

All six receipts were re-checked against a public Sepolia RPC on 2026-11-11:
status = 1 in every case, recorder = the current Oracle
`0x78806E756B9E43012E369B99932f04299d32076D`.

| Agreement | Result | Block | Report-hash source | `recordInspection` transaction |
|---|---|---|---|---|
| 0 | Passed | 12056103 | `sample_report_passed.txt` digest | `0x448dc84fbad8b599d98a73b674141be6be20b07b037561e9b8b184ea555bb27f` |
| 1 | Failed | 12056109 | `sample_report_failed.txt` digest | `0xb2288e389244849a02fddc3f5c38e99c6138aba9d2539c8e87cc97f33974d699` |
| 2 | Passed | 12060042 | `sample_report_passed.txt` digest | `0xee4d51a45335a31616311d3e8077b6f76ca15ee084602d77bfd02393caeadf61` |
| 3 | Failed | 12060046 | `sample_report_failed.txt` digest | `0x1eab82e4c54c402df845c89fa0b045c334ebb83aa51c3bad61809835123d00bb` |
| 4 | Passed | 12068470 | `sample_report_passed.txt` digest | `0x9264ad4fb5bce54c4919b3040a63bf8f04ed26cec689172310e16664f0619f8f` |
| 5 | Passed | 12070270 | `keccak256` test digest (see below) | `0x86e52598e1d4babad4736be3119fca5abc1225a12394f82a35b2ea3b965489bd` |

Agreements 0-4 reused the two synthetic sample reports in `oracle-tools/`, so
their digests repeat. Agreement 4, previously recorded only in the report, was
confirmed on chain: `InspectionRecorded` with `agreementId = 4`, `passed = true`
and `reportHash = 0x12ad87614a233ff07eeedcfa98ee394e2e95dbd5a86fd63f09f2695f571224f9`
in block 12068470. Agreement 5 used
`keccak256("inspection report for agreement 5")` =
`0x475f768f4eae7ac9edd9cec5c319c2f9ccbb1bce9a80984a93bfacfcd40e6db3`,
which is **not** one of the two sample SHA-256 digests.

## Agreement-5 lifecycle and permission checks (report Table 4)

| Step | Action | Actor | Outcome / revert reason | Transaction / block |
|---|---|---|---|---|
| 0 | `createAgreement` (expired lease) | Landlord | success | `0x7de05a5f95cacde3f1dd1f3585dec0c0cbcf0d58ab0610c78ffccde0cff4fea4` / 12070268 |
| 1 | `deposit` 0.01 ETH | Tenant | success | `0x55669cde8ef5d8162cabb9f7a90ce56b3185daedb6691c489028ca2776520fe4` / 12070269 |
| 2 | `recordInspection` (Passed) | Oracle | success | `0x86e52598e1d4babad4736be3119fca5abc1225a12394f82a35b2ea3b965489bd` / 12070270 |
| 3 | `proposeSettlement` (10000 bps) | Landlord | success | `0x8a9281cd288784c42fbf73c94b7019606617616bb7003a03c04b3cbdec4dde2c` / 12070271 |
| 4 | `acceptSettlement` | Tenant | success | `0xfc1f2380417c9f0ae402b86b51244f5ad64d59d9ae2cf5684bf0709a85eed772` / 12070272 |
| 5a | `resolveDispute` attempt | Oracle | reverted `InvalidStatus` (agreement already `Settled`) | `0x503f8f01a092a4c76076e31a0e4b6049022170b459372a64ec7218663960282e` / 12070273 |
| 5b | `withdraw` attempt | Oracle | reverted `NotParty` | `0xc5c4ada8820bf30c37f10b41c7bae85fe0efd83f7030c1b840b153068c4fe20a` / 12070274 |
| 5c | `withdraw` assigned balance | Tenant | success | `0x40bf657c8a14f1e3f7452994b4d1052a274dca46300cd50cc84653fda2fc7719` / 12070275 |

Step 5a fails the **status** guard, so it does not by itself prove the
arbiter-only rule. `NotArbiter` on a genuinely `Disputed` agreement is covered
by `test/02-security.test.js`. Step 5b is a valid party check: `withdraw` reads
`msg.sender`, not `ORACLE_ROLE`.
