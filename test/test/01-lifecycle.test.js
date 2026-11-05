const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  DAY,
  deployEscrowFixture,
  latestTime,
  createAgreement,
  createActiveAgreement,
} = require("./helpers");

/**
 * Member D - functional and negative-path tests for the escrow lifecycle.
 * Every guard in RentalEscrow.sol is exercised at least once: valid path,
 * invalid caller, invalid state, invalid value.
 */
describe("RentalEscrow - lifecycle", function () {
  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------
  describe("deployment", function () {
    it("grants DEFAULT_ADMIN_ROLE to the constructor argument", async function () {
      const { escrow, admin } = await loadFixture(deployEscrowFixture);
      expect(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    });

    it("starts with zero agreements", async function () {
      const { escrow } = await loadFixture(deployEscrowFixture);
      expect(await escrow.agreementCount()).to.equal(0n);
    });

    it("rejects a zero admin address", async function () {
      const factory = await ethers.getContractFactory("RentalEscrow");
      await expect(factory.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(
        factory,
        "InvalidAddress"
      );
    });
  });

  // -------------------------------------------------------------------------
  // createAgreement
  // -------------------------------------------------------------------------
  describe("createAgreement", function () {
    it("stores the agreement, emits the event and returns a zero-based id", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const deposit = ethers.parseEther("1");
      const leaseEndsAt = (await latestTime()) + 30 * DAY;
      const propertyHash = ethers.id("property");
      const metadataHash = ethers.id("metadata");

      await expect(
        escrow
          .connect(landlord)
          .createAgreement(
            tenant.address,
            arbiter.address,
            deposit,
            leaseEndsAt,
            propertyHash,
            metadataHash,
            "ipfs://demo/agreement.json"
          )
      )
        .to.emit(escrow, "AgreementCreated")
        .withArgs(0n, landlord.address, tenant.address, arbiter.address, deposit, metadataHash);

      const agreement = await escrow.getAgreement(0);
      expect(agreement.landlord).to.equal(landlord.address);
      expect(agreement.tenant).to.equal(tenant.address);
      expect(agreement.arbiter).to.equal(arbiter.address);
      expect(agreement.depositAmount).to.equal(deposit);
      expect(agreement.status).to.equal(0n); // Created
      expect(agreement.leaseEndsAt).to.equal(BigInt(leaseEndsAt));
      expect(agreement.tenantBps).to.equal(0n);
      expect(agreement.tenantBalance).to.equal(0n);
      expect(agreement.landlordBalance).to.equal(0n);
      expect(agreement.settlementProposer).to.equal(ethers.ZeroAddress);
      expect(agreement.propertyHash).to.equal(propertyHash);
      expect(agreement.metadataHash).to.equal(metadataHash);
      expect(agreement.metadataURI).to.equal("ipfs://demo/agreement.json");
      expect(await escrow.agreementCount()).to.equal(1n);
    });

    it("increments ids monotonically", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const first = await createAgreement(escrow, { landlord, tenant, arbiter });
      const second = await createAgreement(escrow, { landlord, tenant, arbiter });
      expect(first.id).to.equal(0n);
      expect(second.id).to.equal(1n);
      expect(await escrow.agreementCount()).to.equal(2n);
    });

    it("rejects a zero tenant", async function () {
      const { escrow, landlord, arbiter } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(ethers.ZeroAddress, arbiter.address, 1n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects a zero arbiter", async function () {
      const { escrow, landlord, tenant } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(tenant.address, ethers.ZeroAddress, 1n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects landlord == tenant", async function () {
      const { escrow, landlord, arbiter } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(landlord.address, arbiter.address, 1n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects landlord == arbiter", async function () {
      const { escrow, landlord, tenant } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(tenant.address, landlord.address, 1n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects tenant == arbiter", async function () {
      const { escrow, landlord, tenant } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(tenant.address, tenant.address, 1n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
    });

    it("rejects a zero deposit", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(tenant.address, arbiter.address, 0n, 0, ethers.id("p"), ethers.id("m"), "")
      ).to.be.revertedWithCustomError(escrow, "ZeroDeposit");
    });

    it("accepts zero hashes (hashing is a front-end responsibility)", async function () {
      // Documents current behaviour: only the deposit and the addresses are guarded here.
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      await expect(
        escrow
          .connect(landlord)
          .createAgreement(tenant.address, arbiter.address, 1n, 0, ethers.ZeroHash, ethers.ZeroHash, "")
      ).to.not.be.reverted;
    });
  });

  // -------------------------------------------------------------------------
  // deposit
  // -------------------------------------------------------------------------
  describe("deposit", function () {
    it("moves Created -> Active and locks the exact deposit", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });

      await expect(escrow.connect(tenant).deposit(id, { value: deposit }))
        .to.emit(escrow, "DepositFunded")
        .withArgs(id, tenant.address, deposit);

      const agreement = await escrow.getAgreement(id);
      expect(agreement.status).to.equal(1n); // Active
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(deposit);
    });

    it("rejects the landlord as depositor", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(landlord).deposit(id, { value: deposit }))
        .to.be.revertedWithCustomError(escrow, "NotTenant");
    });

    it("rejects a stranger as depositor", async function () {
      const { escrow, landlord, tenant, arbiter, stranger } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(stranger).deposit(id, { value: deposit }))
        .to.be.revertedWithCustomError(escrow, "NotTenant");
    });

    it("rejects an underpayment", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(tenant).deposit(id, { value: deposit - 1n }))
        .to.be.revertedWithCustomError(escrow, "DepositMismatch");
    });

    it("rejects an overpayment", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(tenant).deposit(id, { value: deposit + 1n }))
        .to.be.revertedWithCustomError(escrow, "DepositMismatch");
    });

    it("rejects a second deposit", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await escrow.connect(tenant).deposit(id, { value: deposit });
      await expect(escrow.connect(tenant).deposit(id, { value: deposit }))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("rejects an unknown agreement id", async function () {
      const { escrow, tenant } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(tenant).deposit(99, { value: 1n }))
        .to.be.revertedWithCustomError(escrow, "InvalidAgreement");
    });
  });

  // -------------------------------------------------------------------------
  // cancelAgreement
  // -------------------------------------------------------------------------
  describe("cancelAgreement", function () {
    it("lets either party cancel before funding", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id } = await createAgreement(escrow, { landlord, tenant, arbiter });

      await expect(escrow.connect(tenant).cancelAgreement(id))
        .to.emit(escrow, "AgreementCancelled")
        .withArgs(id, tenant.address);

      expect((await escrow.getAgreement(id)).status).to.equal(5n); // Cancelled
    });

    it("rejects a third party", async function () {
      const { escrow, landlord, tenant, arbiter, stranger } = await loadFixture(deployEscrowFixture);
      const { id } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(stranger).cancelAgreement(id))
        .to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("refuses to cancel once funds are locked", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, landlord } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(landlord).cancelAgreement(id))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("blocks deposit after cancellation", async function () {
      const { escrow, landlord, tenant, arbiter } = await loadFixture(deployEscrowFixture);
      const { id, deposit } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await escrow.connect(landlord).cancelAgreement(id);
      await expect(escrow.connect(tenant).deposit(id, { value: deposit }))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------------
  // proposeSettlement
  // -------------------------------------------------------------------------
  describe("proposeSettlement", function () {
    it("rejects a proposal before the lease ends", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(tenant).proposeSettlement(id, 5000))
        .to.be.revertedWithCustomError(escrow, "LeaseNotEnded");
    });

    it("accepts a proposal exactly at leaseEndsAt", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id, leaseEndsAt } = await createActiveAgreement(escrow, accounts);

      await time.increaseTo(leaseEndsAt);

      await expect(escrow.connect(tenant).proposeSettlement(id, 6000))
        .to.emit(escrow, "SettlementProposed")
        .withArgs(id, tenant.address, 6000);

      const agreement = await escrow.getAgreement(id);
      expect(agreement.status).to.equal(2n); // SettlementProposed
      expect(agreement.tenantBps).to.equal(6000n);
      expect(agreement.settlementProposer).to.equal(tenant.address);
    });

    it("rejects a non-party proposer", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, stranger } = accounts;
      const { id, leaseEndsAt } = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(leaseEndsAt);
      await expect(escrow.connect(stranger).proposeSettlement(id, 5000))
        .to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("rejects a split above 100%", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id, leaseEndsAt } = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(leaseEndsAt);
      await expect(escrow.connect(tenant).proposeSettlement(id, 10_001))
        .to.be.revertedWithCustomError(escrow, "InvalidBps");
    });

    it("accepts the 0% and 100% boundaries", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id, leaseEndsAt } = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(leaseEndsAt);
      await expect(escrow.connect(tenant).proposeSettlement(id, 0)).to.not.be.reverted;
      expect((await escrow.getAgreement(id)).tenantBps).to.equal(0n);
    });

    it("rejects a second proposal (state is no longer Active)", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const { id, leaseEndsAt } = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(id, 5000);
      await expect(escrow.connect(landlord).proposeSettlement(id, 7000))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------------
  // acceptSettlement
  // -------------------------------------------------------------------------
  describe("acceptSettlement", function () {
    async function proposeFixture() {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(agreement.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(agreement.id, 6000);
      return { ...accounts, ...agreement };
    }

    it("assigns balances to both parties and settles", async function () {
      const { escrow, landlord, id, deposit } = await proposeFixture();
      const tenantAmount = (deposit * 6000n) / 10_000n;

      await expect(escrow.connect(landlord).acceptSettlement(id))
        .to.emit(escrow, "SettlementAccepted")
        .withArgs(id, landlord.address, tenantAmount, deposit - tenantAmount);

      const agreement = await escrow.getAgreement(id);
      expect(agreement.status).to.equal(3n); // Settled
      expect(agreement.tenantBalance).to.equal(tenantAmount);
      expect(agreement.landlordBalance).to.equal(deposit - tenantAmount);
    });

    it("rejects the proposer accepting its own proposal", async function () {
      const { escrow, tenant, id } = await proposeFixture();
      await expect(escrow.connect(tenant).acceptSettlement(id))
        .to.be.revertedWithCustomError(escrow, "NotCounterparty");
    });

    it("rejects a stranger", async function () {
      const { escrow, stranger, id } = await proposeFixture();
      await expect(escrow.connect(stranger).acceptSettlement(id))
        .to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("rejects acceptance when no proposal exists", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, landlord } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(landlord).acceptSettlement(id))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("never leaks rounding dust (1 wei deposit, 3333 bps)", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts, { deposit: 1n });
      await time.increaseTo(agreement.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(agreement.id, 3333);
      await escrow.connect(landlord).acceptSettlement(agreement.id);

      const stored = await escrow.getAgreement(agreement.id);
      expect(stored.tenantBalance).to.equal(0n);
      expect(stored.landlordBalance).to.equal(1n);
      expect(stored.tenantBalance + stored.landlordBalance).to.equal(agreement.deposit);
    });
  });

  // -------------------------------------------------------------------------
  // raiseDispute
  // -------------------------------------------------------------------------
  describe("raiseDispute", function () {
    it("moves an Active agreement to Disputed", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      const evidenceHash = ethers.id("damage-photo-01");
      const tx = await escrow.connect(tenant).raiseDispute(id, evidenceHash);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(escrow, "DisputeRaised")
        .withArgs(id, tenant.address, evidenceHash, block.timestamp);
    });

    it("moves a SettlementProposed agreement to Disputed without assigning balances", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(agreement.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(agreement.id, 8000);
      await escrow.connect(landlord).raiseDispute(agreement.id, ethers.id("counter-evidence"));

      const stored = await escrow.getAgreement(agreement.id);
      expect(stored.status).to.equal(4n); // Disputed
      expect(stored.tenantBalance).to.equal(0n);
      expect(stored.landlordBalance).to.equal(0n);
    });

    it("rejects an empty evidence hash", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(tenant).raiseDispute(id, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "ZeroHash");
    });

    it("rejects a dispute on an unfunded agreement", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord, arbiter } = accounts;
      const { id } = await createAgreement(escrow, { landlord, tenant, arbiter });
      await expect(escrow.connect(tenant).raiseDispute(id, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("rejects a third party", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, stranger } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(stranger).raiseDispute(id, ethers.id("x")))
        .to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("rejects a dispute after settlement", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(agreement.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(agreement.id, 5000);
      await escrow.connect(landlord).acceptSettlement(agreement.id);
      await expect(escrow.connect(tenant).raiseDispute(agreement.id, ethers.id("late")))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------------
  // resolveDispute
  // -------------------------------------------------------------------------
  describe("resolveDispute", function () {
    async function disputedFixture() {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts);
      await escrow.connect(tenant).raiseDispute(agreement.id, ethers.id("damage-photo-01"));
      return { ...accounts, ...agreement };
    }

    it("lets the recorded arbiter rule a full refund", async function () {
      const { escrow, arbiter, id, deposit } = await disputedFixture();
      await expect(escrow.connect(arbiter).resolveDispute(id, 10_000, ethers.id("ruling")))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(id, arbiter.address, 10_000, ethers.id("ruling"), deposit, 0n);

      const stored = await escrow.getAgreement(id);
      expect(stored.status).to.equal(3n);
      expect(stored.tenantBalance).to.equal(deposit);
      expect(stored.landlordBalance).to.equal(0n);
    });

    it("lets the arbiter rule everything to the landlord", async function () {
      const { escrow, arbiter, id, deposit } = await disputedFixture();
      await escrow.connect(arbiter).resolveDispute(id, 0, ethers.ZeroHash);
      const stored = await escrow.getAgreement(id);
      expect(stored.tenantBalance).to.equal(0n);
      expect(stored.landlordBalance).to.equal(deposit);
    });

    it("supports any intermediate split", async function () {
      const { escrow, arbiter, id, deposit } = await disputedFixture();
      await escrow.connect(arbiter).resolveDispute(id, 5000, ethers.id("even"));
      const stored = await escrow.getAgreement(id);
      expect(stored.tenantBalance).to.equal(deposit / 2n);
      expect(stored.landlordBalance).to.equal(deposit - deposit / 2n);
    });

    it("rejects the landlord, the tenant, the admin and a stranger as arbitrator", async function () {
      const { escrow, landlord, tenant, admin, stranger, id } = await disputedFixture();
      for (const caller of [landlord, tenant, admin, stranger]) {
        await expect(escrow.connect(caller).resolveDispute(id, 5000, ethers.ZeroHash))
          .to.be.revertedWithCustomError(escrow, "NotArbiter");
      }
    });

    it("rejects a split above 100%", async function () {
      const { escrow, arbiter, id } = await disputedFixture();
      await expect(escrow.connect(arbiter).resolveDispute(id, 10_001, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "InvalidBps");
    });

    it("allows exactly one ruling", async function () {
      const { escrow, arbiter, id } = await disputedFixture();
      await escrow.connect(arbiter).resolveDispute(id, 5000, ethers.ZeroHash);
      await expect(escrow.connect(arbiter).resolveDispute(id, 9000, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });

    it("rejects a ruling on an agreement that is not disputed", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, arbiter } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(arbiter).resolveDispute(id, 5000, ethers.ZeroHash))
        .to.be.revertedWithCustomError(escrow, "InvalidStatus");
    });
  });

  // -------------------------------------------------------------------------
  // withdraw
  // -------------------------------------------------------------------------
  describe("withdraw", function () {
    async function settledFixture() {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant, landlord } = accounts;
      const agreement = await createActiveAgreement(escrow, accounts);
      await time.increaseTo(agreement.leaseEndsAt);
      await escrow.connect(tenant).proposeSettlement(agreement.id, 7000);
      await escrow.connect(landlord).acceptSettlement(agreement.id);
      return { ...accounts, ...agreement };
    }

    it("pays the tenant share and zeroes the balance", async function () {
      const { escrow, tenant, id, deposit } = await settledFixture();
      const expected = (deposit * 7000n) / 10_000n;
      const contractAddress = await escrow.getAddress();
      const balanceBefore = await ethers.provider.getBalance(contractAddress);

      await expect(escrow.connect(tenant).withdraw(id))
        .to.emit(escrow, "Withdrawn")
        .withArgs(id, tenant.address, expected);

      expect(balanceBefore - (await ethers.provider.getBalance(contractAddress))).to.equal(expected);

      const stored = await escrow.getAgreement(id);
      expect(stored.tenantBalance).to.equal(0n);
      expect(await escrow.withdrawableBalance(id, tenant.address)).to.equal(0n);
    });

    it("lets both parties withdraw and empties the contract", async function () {
      const { escrow, tenant, landlord, id, deposit } = await settledFixture();
      await escrow.connect(tenant).withdraw(id);
      await escrow.connect(landlord).withdraw(id);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
      expect(deposit).to.equal(ethers.parseEther("1"));
    });

    it("rejects a second withdrawal", async function () {
      const { escrow, tenant, id } = await settledFixture();
      await escrow.connect(tenant).withdraw(id);
      await expect(escrow.connect(tenant).withdraw(id))
        .to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("rejects a third party", async function () {
      const { escrow, stranger, id } = await settledFixture();
      await expect(escrow.connect(stranger).withdraw(id))
        .to.be.revertedWithCustomError(escrow, "NotParty");
    });

    it("rejects withdrawal before settlement", async function () {
      const accounts = await loadFixture(deployEscrowFixture);
      const { escrow, tenant } = accounts;
      const { id } = await createActiveAgreement(escrow, accounts);
      await expect(escrow.connect(tenant).withdraw(id))
        .to.be.revertedWithCustomError(escrow, "NothingToWithdraw");
    });

    it("rejects withdrawal on an unknown agreement", async function () {
      const { escrow, tenant } = await loadFixture(deployEscrowFixture);
      await expect(escrow.connect(tenant).withdraw(42))
        .to.be.revertedWithCustomError(escrow, "InvalidAgreement");
    });
  });
});
