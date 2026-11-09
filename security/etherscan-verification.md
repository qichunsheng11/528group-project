# Etherscan verification (Sepolia)

The deployed contract can be verified **byte-for-byte**, not just "similar match".
The compiler settings below were reverse-engineered from the CBOR metadata embedded
in the deployed runtime code and confirmed to reproduce it exactly (7,324 bytes,
metadata hash `de1df1bf…449f`).

## Target

| Item | Value |
|---|---|
| Address | `0x61Fdc579feFd9aa45613f9D8681B342676FC2585` |
| Contract name | `RentalEscrow` |
| Compiler | `v0.8.24+commit.e11b9ed9` |
| Optimization | Enabled, **200** runs |
| EVM version | **shanghai** |
| License | MIT |
| Constructor argument | `admin` = `0x24fc1A20d4b0443055AFB81AdA6D908C91987b35` |

Why `shanghai` and not the Hardhat default: the team compiled the deployed build in
Remix (single file `RentalEscrow.sol`, no directory prefix). Recompiling with
`evmVersion = shanghai`, optimizer 200, and the source path `RentalEscrow.sol`
reproduces the on-chain runtime code exactly — code **and** metadata.

## Steps

1. Open <https://sepolia.etherscan.io/address/0x61Fdc579feFd9aa45613f9D8681B342676FC2585#code>
2. Click **Verify and Publish**
3. Compiler Type: **Solidity (Standard-Json-Input)**
4. Compiler Version: **v0.8.24+commit.e11b9ed9**
5. License: **MIT License (MIT)**
6. Paste the whole content of [`etherscan-standard-json.json`](./etherscan-standard-json.json)
7. If asked for constructor arguments, paste the content of
   [`constructor-args.txt`](./constructor-args.txt)
8. Submit and wait for the "Successfully verified" page

## Reproduce locally

```bash
npm run compile
node -e "
const fs=require('fs'),solc=require('solc');
const out=JSON.parse(solc.compile(fs.readFileSync('security/etherscan-standard-json.json','utf8')));
const rt=out.contracts['RentalEscrow.sol'].RentalEscrow.evm.deployedBytecode.object;
console.log('runtime bytes:', rt.length/2);
"
```

`7324` means the local build is identical to what is deployed. Any other number means
the settings drifted (usually `evmVersion`).
