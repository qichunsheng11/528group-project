// Grants ORACLE_ROLE to a wallet. Must be signed by the holder of
// DEFAULT_ADMIN_ROLE (the deployer, unless ADMIN_ADDRESS was overridden).
//
// Usage:
//   npm run grant:oracle -- --oracle 0xYourOracleWallet
const hre = require("hardhat");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
  const oracle = argValue("--oracle");
  if (!oracle || !hre.ethers.isAddress(oracle)) {
    throw new Error("Pass a valid oracle address: npm run grant:oracle -- --oracle 0x...");
  }

  const record = require("../deployment_record.json");
  const address = process.env.CONTRACT_ADDRESS || record.contractAddress;
  const [admin] = await hre.ethers.getSigners();

  console.log(`contract=${address} admin=${admin.address} oracle=${oracle}`);

  const escrow = await hre.ethers.getContractAt("RentalEscrow", address, admin);
  const role = await escrow.ORACLE_ROLE();
  const tx = await escrow.grantRole(role, oracle);
  const receipt = await tx.wait();

  console.log(`grantRole mined: tx=${tx.hash} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed}`);
  console.log(`hasRole(ORACLE_ROLE, ${oracle}) = ${await escrow.hasRole(role, oracle)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
