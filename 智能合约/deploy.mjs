// RentalEscrow 部署脚本（Member B 交付物，assignment R5：reproducible deploy）
// 用法（在项目根目录）：
//   npm install ethers
//   SEPOLIA_RPC_URL=https://rpc.sepolia.org \
//   DEPLOYER_PRIVATE_KEY=0x... \
//   [ADMIN_ADDRESS=0x...] \
//   node deploy.mjs
// 说明：
//   - ADMIN_ADDRESS 缺省为部署者地址，接收 DEFAULT_ADMIN_ROLE（负责 grantRole(ORACLE_ROLE, C 的钱包)）。
//   - 私钥只从环境变量读取，切勿写入仓库；.env 需加入 .gitignore。
//   - 部署成功后打印合约地址与交易哈希，用于 README / 报告 §4.5 与 Etherscan 验证。
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const abi = JSON.parse(fs.readFileSync(path.join(here, "RentalEscrow.abi.json"), "utf8"));
const bytecode = fs.readFileSync(path.join(here, "RentalEscrow.bytecode.hex"), "utf8").trim();

const rpc = process.env.SEPOLIA_RPC_URL;
const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!rpc || !key) {
  console.error("缺少环境变量：SEPOLIA_RPC_URL 与 DEPLOYER_PRIVATE_KEY 均为必填。");
  process.exit(1);
}
const admin = process.env.ADMIN_ADDRESS || ethers.computeAddress(key);

const provider = new ethers.JsonRpcProvider(rpc);
const wallet = new ethers.Wallet(key, provider);
const { chainId } = await provider.getNetwork();
console.log(`网络 chainId=${chainId}，部署者=${wallet.address}，admin=${admin}`);

const factory = new ethers.ContractFactory(abi, bytecode, wallet);
const contract = await factory.deploy(admin);
const tx = contract.deploymentTransaction();
console.log(`部署交易已发送：${tx.hash}`);
const receipt = await tx.wait();
console.log(`部署成功：address=${await contract.getAddress()} block=${receipt.blockNumber} gasUsed=${receipt.gasUsed.toString()}`);
console.log("下一步：admin 调用 grantRole(ORACLE_ROLE, <Oracle钱包>)，并在 Etherscan 验证源码。");
