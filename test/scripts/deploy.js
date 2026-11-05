// Reproducible Sepolia deployment (assignment R5).
// Usage:
//   cp .env.example .env      # fill SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY
//   npm run compile
//   npm run deploy:sepolia
//
// Writes/refreshes deployment_record.json so the README, the report and the
// front-end always point at the same address.
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const admin = process.env.ADMIN_ADDRESS || deployer.address;
  const network = await hre.ethers.provider.getNetwork();

  console.log(`network=${hre.network.name} chainId=${network.chainId}`);
  console.log(`deployer=${deployer.address} admin=${admin}`);

  const factory = await hre.ethers.getContractFactory("RentalEscrow");
  const escrow = await factory.deploy(admin);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  const tx = escrow.deploymentTransaction();
  const receipt = await tx.wait();

  console.log(`RentalEscrow deployed: ${address}`);
  console.log(`tx=${tx.hash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);

  const recordPath = path.join(__dirname, "..", "deployment_record.json");
  const record = {
    network: hre.network.name,
    chainId: Number(network.chainId),
    contractAddress: address,
    deployTx: tx.hash,
    deployBlock: receipt.blockNumber,
    deployGasUsed: receipt.gasUsed.toString(),
    deployerAdmin: admin,
    oracleAddress: process.env.ORACLE_ADDRESS || "",
    solidity: "0.8.24",
    optimizerRuns: 200,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`deployment_record.json updated at ${recordPath}`);
  console.log(
    "Next: grant ORACLE_ROLE to the oracle wallet (`npm run grant:oracle -- --oracle 0x...`), then verify the source on Etherscan."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
