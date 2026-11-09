require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// The Sepolia key is read from .env only. Never commit a private key.
const SEPOLIA_RPC_URL =
  process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      // Pinned to the hardfork used for the live Sepolia deployment.
      // With solc 0.8.24 + optimizer 200 + shanghai the compiled runtime
      // bytecode is byte-identical to the deployed contract (7,324 bytes).
      evmVersion: "shanghai",
    },
  },
  // Compiler settings above match the deployed bytecode:
  // solc 0.8.24, optimizer enabled 200 runs, evmVersion shanghai
  // (see deployment_record.json).
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  networks: {
    hardhat: {
      // Tests run on an in-process chain; no network access needed.
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC_URL,
      chainId: 11155111,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
  mocha: {
    timeout: 120000,
  },
};
