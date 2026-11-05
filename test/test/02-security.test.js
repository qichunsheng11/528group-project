const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deployEscrowFixture,
  latestTime,
  createAgreement,
  createActiveAgreement,
} = require("./helpers");

/**
 * Member D - security, access-control and invariant tests.
 * These are the cases the rubric calls "negative tests" plus the two
 * properties the design promises: role separation and value conservation.
 */
describe("RentalEscrow - security & invariants", function () {
  // -------------------------------------------------------------------------
  // Role administration
  // -------------------------------------------------------------------------
  describe("role administration", function () {
    it("only the admin can grant ORACLE_ROLE", async function () {
      const { escrow, landlord, stranger, ORACLE_ROLE } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(landlord).grantRole(ORACLE_ROLE, stranger.address))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
        .withArgs(landlord.address, await escrow.DEFAULT_ADMIN_ROLE());
    });

    it("a revoked oracle can no longer write inspections", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, admin, oracle, ORACLE_ROLE } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      await escrow.connect(admin).revokeRole(ORACLE_ROLE, oracle.address);

      await expect(escrow.connect(oracle).recordInspection(id, true, ethers.id("report")))
        .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount");
    });

    it("the admin cannot move user funds", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, admin, oracle } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      // Even with full admin rights and a valid inspection, the admin gets nothing.
      await escrow.connect(oracle).recordInspection(id, true, ethers.id("report"));
      await expect(escrow.connect(admin).withdraw(id))
        .to.be.revertedWithCustomError(escrow, "NotParty");
      expect(await escrow.withdrawableBalance(id, admin.address)).to.equal(0n);
    });

    it("the admin cannot rule a dispute", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, admin, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await escrow.connect(tenant).raiseDispute(id, ethers.id("evidence"));
      await expect(escrow.connect(admin).resolveDispute(id, 10_000, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "NotArbiter");
    });
  });

  // -------------------------------------------------------------------------
  // Inspection lane: facts only, never allocation
  // -------------------------------------------------------------------------
  describe("inspection lane", function () {
    it("is empty until an authorised oracle records something", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      const inspection = await escrow.getInspection(id);
      expect(inspection.recorded).to.equal(false);
      expect(inspection.passed).to.equal(false);
      expect(inspection.reportHash).to.equal(ethers.ZeroHash);
      expect(inspection.updatedAt).to.equal(0n);
      expect(inspection.recorder).to.equal(ethers.ZeroAddress);
    });

    it("rejects callers without ORACLE_ROLE", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord, admin, stranger, ORACLE_ROLE } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      for (const caller of [tenant, landlord, admin, stranger]) {
        await expect(escrow.connect(caller).recordInspection(id, true, ethers.id("report")))
          .to.be.revertedWithCustomError(escrow, "AccessControlUnauthorizedAccount")
          .withArgs(caller.address, ORACLE_ROLE);
      }
    });

    it("rejects an empty report hash", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(oracle).recordInspection(id, true, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "ZeroHash");
    });

    it("records Passed with hash, timestamp and recorder", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      const reportHash = ethers.id("inspection-report-passed");

      await expect(escrow.connect(oracle).recordInspection(id, true, reportHash))
        .to.emit(escrow, "InspectionRecorded")
        .withArgs(id, oracle.address, true, reportHash);

      const inspection = await escrow.getInspection(id);
      expect(inspection.recorded).to.equal(true);
      expect(inspection.passed).to.equal(true);
      expect(inspection.reportHash).to.equal(reportHash);
      expect(inspection.recorder).to.equal(oracle.address);
      expect(inspection.updatedAt).to.be.greaterThan(0n);
    });

    it("records Failed and can overwrite a previous result", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      await escrow.connect(oracle).recordInspection(id, true, ethers.id("first"));
      const secondHash = ethers.id("second");
      await escrow.connect(oracle).recordInspection(id, false, secondHash);

      const inspection = await escrow.getInspection(id);
      expect(inspection.passed).to.equal(false);
      expect(inspection.reportHash).to.equal(secondHash);
    });

    it("is writable in Active, SettlementProposed and Disputed", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle, tenant, landlord } = accounts;

      // Active
      const active = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(oracle).recordInspection(active.id, true, ethers.id("a")))
        .to.not.be.reverted;

      // SettlementProposed
      const proposed = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(proposed.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(proposed.id, 5000);
      await expect(escrow.connect(oracle).recordInspection(proposed.id, false, ethers.id("b")))
        .to.not.be.reverted;

      // Disputed
      const disputed = await createActiveAgreement(escrow, accounts);
      await escrow.connect(landlord).raiseDispute(disputed.id, ethers.id("e"));
      await expect(escrow.connect(oracle).recordInspection(disputed.id, true, ethers.id("c")))
        .to.not.be.reverted;
    });

    it("is rejected once the agreement is Settled or Cancelled", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle, tenant, landlord, arbiter } = accounts;

      const unfunded = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(oracle).recordInspection(unfunded.id, true, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");

      const cancelled = await createAgreement(escrow, { landlord, tenant, arbiter });
      await escrow.connect(landlord).cancelAgreement(cancelled.id);
      await expect(escrow.connect(oracle).recordInspection(cancelled.id, true, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");

      const settled = await createActiveAgreement(escrow, accounts);
      await escrow.connect(tenant).raiseDispute(settled.id, ethers.id("e"));
      await escrow.connect(arbiter).resolveDispute(settled.id, 5000, ethers.id("r"));
      await expect(escrow.connect(oracle).recordInspection(settled.id, true, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("never changes status, balances or the amount the tenant can withdraw", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, oracle, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);

      const before = await escrow.getAgreement(id);
      // A "failed" inspection must not move a single wei: the oracle supplies
      // facts, the parties (or the arbiter) decide the split.
      await escrow.connect(oracle).recordInspection(id, false, ethers.id("failed-report"));
      const after = await escrow.getAgreement(id);

      expect(after.status).to.equal(before.status);
      expect(after.tenantBalance).to.equal(0n);
      expect(after.landlordBalance).to.equal(0n);
      expect(await escrow.withdrawableBalance(id, tenant.address)).to.equal(0n);
    });

    it("rejects an unknown agreement id", async function () {
      const { escrow, oracle } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(oracle).recordInspection(7, true, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidAgreement");
    });
  });

  // -------------------------------------------------------------------------
  // Reentrancy
  // -------------------------------------------------------------------------
  describe("reentrancy", function () {
    it("a malicious tenant cannot drain the escrow through receive()", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, landlord, arbiter, tenant } = accounts;
      const deposit = ethers.parseEther("1");

      const attackerFactory = await ethers.getContractFactory("ReentrantTenant");
      const attacker = await attackerFactory.deploy(await escrow.getAddress());
      await attacker.waitForDeployment();
      const attackerAddress = await attacker.getAddress();

      const leaseEndsAt = (await latestTime()) + 60;
      await escrow
        .connect(landlord)
        .createAgreement(
          attackerAddress,
          arbiter.address,
          deposit,
          leaseEndsAt,
          ethers.id("p"),
          ethers.id("m"),
          ""
        );

      await attacker.connect(tenant).fund(0, { value: deposit });
      await escrow.connect(landlord).raiseDispute(0, ethers.id("evidence"));
      await escrow.connect(arbiter).resolveDispute(0, 10_000, ethers.id("ruling"));

      const escrowAddress = await escrow.getAddress();
      const escrowBefore = await ethers.provider.getBalance(escrowAddress);

      await attacker.connect(tenant).attack(0);

      expect(escrowBefore - (await ethers.provider.getBalance(escrowAddress))).to.equal(deposit);
      expect(await attacker.reentryAttempts()).to.equal(1n);
      expect((await escrow.getAgreement(0)).tenantBalance).to.equal(0n);
    });
  });

  // -------------------------------------------------------------------------
  // Invariants: value conservation
  // -------------------------------------------------------------------------
  describe("invariants", function () {
    it("tenant + landlord always equals the deposit for any split", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const deposit = ethers.parseEther("1");

      for (const bps of [0, 1, 2500, 3333, 5000, 6667, 9999, 10_000]) {
        const agreement = await createActiveAgreement(escrow, accounts, {
          deposit,
          leaseEndsAt: await latestTime(),
        });
        await escrow.connect(tenant).proposeSettlement(agreement.id, bps);
        await escrow.connect(landlord).acceptSettlement(agreement.id);
        const stored = await escrow.getAgreement(agreement.id);
        expect(stored.tenantBalance + stored.landlordBalance).to.equal(deposit);
      }
    });

    it("the contract never holds more than the funds it still owes", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord, arbiter } = accounts;
      const deposit = ethers.parseEther("1");
      const escrowAddress = await escrow.getAddress();

      const first = await createActiveAgreement(escrow, accounts, { deposit });
      const second = await createActiveAgreement(escrow, accounts, { deposit });
      const third = await createActiveAgreement(escrow, accounts, { deposit });
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(deposit * 3n);

      // 1: agreed split, both withdraw -> 2 ETH left
      await time.increaseTo(first.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(first.id, 4000);
      await escrow.connect(landlord).acceptSettlement(first.id);
      await escrow.connect(tenant).withdraw(first.id);
      await escrow.connect(landlord).withdraw(first.id);
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(deposit * 2n);

      // 2: dispute, arbiter rules 100% to tenant -> tenant withdraws -> 1 ETH left
      await escrow.connect(landlord).raiseDispute(second.id, ethers.id("e"));
      await escrow.connect(arbiter).resolveDispute(second.id, 10_000, ethers.id("r"));
      await escrow.connect(tenant).withdraw(second.id);
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(deposit);

      // 3: still Active, its deposit is exactly what remains locked
      expect((await escrow.getAgreement(third.id)).status).to.equal(1n);
      expect(await ethers.provider.getBalance(escrowAddress)).to.equal(deposit);
    });
  });
});
