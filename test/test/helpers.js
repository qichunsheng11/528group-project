const { ethers } = require("hardhat");

const DAY = 24 * 60 * 60;
const BPS_DENOMINATOR = 10_000n;

/**
 * Deploys RentalEscrow with a fixed cast of roles and grants ORACLE_ROLE.
 * Every test starts from this fixture so cases stay independent.
 */
async function deployEscrowFixture() {
  const [admin, landlord, tenant, arbiter, oracle, stranger] = await ethers.getSigners();
  const factory = await ethers.getContractFactory("RentalEscrow");
  const escrow = await factory.deploy(admin.address);
  await escrow.waitForDeployment();

  const ORACLE_ROLE = await escrow.ORACLE_ROLE();
  await escrow.connect(admin).grantRole(ORACLE_ROLE, oracle.address);

  return { escrow, admin, landlord, tenant, arbiter, oracle, stranger, ORACLE_ROLE };
}

async function latestTime() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}

/** Creates an agreement as `landlord` and returns its id plus the inputs used. */
async function createAgreement(
  escrow,
  { landlord, tenant, arbiter, deposit = ethers.parseEther("1"), leaseEndsAt, metadataURI = "ipfs://demo/agreement.json" } = {}
) {
  const end = leaseEndsAt ?? (await latestTime()) + 30 * DAY;
  const propertyHash = ethers.id("12 Queens Road Central, Flat B");
  const metadataHash = ethers.id("tenancy-agreement-v1");

  const tx = await escrow
    .connect(landlord)
    .createAgreement(
      tenant.address,
      arbiter.address,
      deposit,
      end,
      propertyHash,
      metadataHash,
      metadataURI
    );
  const receipt = await tx.wait();

  const created = receipt.logs
    .map((log) => {
      try {
        return escrow.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === "AgreementCreated");

  return {
    id: created.args.agreementId,
    deposit,
    leaseEndsAt: end,
    propertyHash,
    metadataHash,
    tx,
    receipt,
  };
}

/** Brings an agreement all the way to Active (created + funded). */
async function createActiveAgreement(escrow, accounts, opts = {}) {
  const agreement = await createAgreement(escrow, {
    landlord: accounts.landlord,
    tenant: accounts.tenant,
    arbiter: accounts.arbiter,
    ...opts,
  });
  await escrow.connect(accounts.tenant).deposit(agreement.id, { value: agreement.deposit });
  return agreement;
}

module.exports = {
  DAY,
  BPS_DENOMINATOR,
  deployEscrowFixture,
  latestTime,
  createAgreement,
  createActiveAgreement,
};
