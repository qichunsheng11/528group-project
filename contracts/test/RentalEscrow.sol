// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title RentalEscrow
 * @notice Blockchain based rental deposit escrow with a permissioned inspection
 *         oracle and a single assigned arbiter (CDS528 group assignment, Member B).
 *
 * Roles (report §3.3):
 *  - landlord  : creates the agreement (recorded per agreement, not a global role)
 *  - tenant    : funds the agreement exactly once and withdraws its share
 *  - arbiter   : recorded per agreement; issues exactly one ruling on a dispute
 *  - ORACLE_ROLE : global role; writes Passed/Failed + report hash ONLY,
 *                  never touches status or allocation (report §2.1, §3.4)
 *  - DEFAULT_ADMIN_ROLE : grants/revokes ORACLE_ROLE; cannot move user funds
 *
 * Agreement state machine (report §3.4):
 *   Created -> Active -> SettlementProposed -> Settled
 *             |                |
 *             +--> Cancelled   +--> Disputed -> Settled (arbiter ruling)
 *   Inspection lane is independent: writable only in Active /
 *   SettlementProposed / Disputed and never changes status or balances.
 *
 * Security & gas notes (report §4.3, §5.2; assignment R3/R4):
 *  - Pull withdrawals with checks-effects-interactions + ReentrancyGuard.
 *  - Custom errors and `calldata` for read-only dynamic params (gas aware).
 *  - No unbounded loops; history lives in events, not arrays.
 *  - Struct fields ordered to pack status/leaseEndsAt/tenantBps into one slot.
 *  - Immutable by design (report §6.2): no proxy, no pause; withdrawal paths
 *    must never be blocked, so "immutable for simplicity" is the ops rationale.
 *  - OpenZeppelin Contracts (MIT) used for AccessControl and ReentrancyGuard.
 */
contract RentalEscrow is AccessControl, ReentrancyGuard {
    // ---------------------------------------------------------------------
    // Roles & constants
    // ---------------------------------------------------------------------

    /// @notice Global role allowed to record inspection results (report §3.3).
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// @notice Basis-point denominator for settlement splits (100% = 10_000).
    uint16 public constant BPS_DENOMINATOR = 10_000;

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum AgreementStatus {
        Created,            // unfunded: landlord created, tenant has not paid
        Active,             // funded: deposit locked in this contract
        SettlementProposed, // one party stored a bps split, awaiting counterparty
        Settled,            // final balances assigned, withdrawals open
        Disputed,           // handed to the assigned arbiter
        Cancelled           // only reachable before funding
    }

    struct Agreement {
        address landlord;          // slot 1
        address tenant;            // slot 2
        address arbiter;           // slot 3
        uint256 depositAmount;     // slot 4
        AgreementStatus status;    // slot 5 (packed: 8 + 64 + 16 bits)
        uint64 leaseEndsAt;        // slot 5
        uint16 tenantBps;          // slot 5, proposed tenant share in bps
        bytes32 propertyHash;      // slot 6
        bytes32 metadataHash;      // slot 7, integrity anchor for off-chain docs
        uint256 tenantBalance;     // slot 8, withdrawable (pull pattern)
        uint256 landlordBalance;   // slot 9, withdrawable (pull pattern)
        address settlementProposer;// slot 10
        string metadataURI;        // slot 11+, off-chain report location
    }

    /// @notice On-chain inspection record; field order frozen by the GitHub ABI.
    struct Inspection {
        bool recorded;   // false until the first authorized update (= NotRequested)
        bool passed;     // true = Passed, false = Failed
        bytes32 reportHash;
        uint64 updatedAt;
        address recorder;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(uint256 => Agreement) private _agreements;
    mapping(uint256 => Inspection) private _inspections;

    /// @notice Monotonic agreement counter; ids are [0, agreementCount).
    uint256 public agreementCount;

    // ---------------------------------------------------------------------
    // Events (report §4.3)
    // ---------------------------------------------------------------------

    event AgreementCreated(
        uint256 indexed agreementId,
        address indexed landlord,
        address indexed tenant,
        address arbiter,
        uint256 depositAmount,
        bytes32 metadataHash
    );
    event DepositFunded(uint256 indexed agreementId, address indexed tenant, uint256 amount);
    event SettlementProposed(uint256 indexed agreementId, address indexed proposer, uint16 tenantBps);
    event SettlementAccepted(
        uint256 indexed agreementId,
        address indexed acceptor,
        uint256 tenantAmount,
        uint256 landlordAmount
    );
    event DisputeRaised(
        uint256 indexed agreementId,
        address indexed raiser,
        bytes32 evidenceHash,
        uint256 raisedAt
    );
    event DisputeResolved(
        uint256 indexed agreementId,
        address indexed arbiter,
        uint16 tenantBps,
        bytes32 rationaleHash,
        uint256 tenantAmount,
        uint256 landlordAmount
    );
    event Withdrawn(uint256 indexed agreementId, address indexed recipient, uint256 amount);
    event InspectionRecorded(
        uint256 indexed agreementId,
        address indexed oracle,
        bool passed,
        bytes32 reportHash
    );
    event AgreementCancelled(uint256 indexed agreementId, address indexed canceller);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error InvalidAddress();
    error InvalidAgreement();
    error InvalidStatus();
    error ZeroDeposit();
    error DepositMismatch();
    error InvalidBps();
    error ZeroHash();
    error LeaseNotEnded();
    error NotTenant();
    error NotParty();
    error NotCounterparty();
    error NotArbiter();
    error NothingToWithdraw();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    /// @param admin address receiving DEFAULT_ADMIN_ROLE (grants ORACLE_ROLE).
    constructor(address admin) {
        if (admin == address(0)) revert InvalidAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Escrow lifecycle (report §4.2)
    // ---------------------------------------------------------------------

    /**
     * @notice Landlord creates an unfunded agreement.
     * @dev Guard: valid addresses, landlord != tenant, nonzero deposit.
     *      `arbiter` is fixed here at creation (architecture doc: the Dispute
     *      page "administrator" is this Arbitrator identity on Sepolia); the
     *      dApp form must supply it explicitly or from the Protocol config.
     *      House name/address stay off-chain: anchor them via propertyHash
     *      and metadataHash, keep the document at metadataURI.
     */
    function createAgreement(
        address tenant,
        address arbiter,
        uint256 depositAmount,
        uint64 leaseEndsAt,
        bytes32 propertyHash,
        bytes32 metadataHash,
        string calldata metadataURI
    ) external returns (uint256 agreementId) {
        if (tenant == address(0) || arbiter == address(0)) revert InvalidAddress();
        if (tenant == msg.sender || arbiter == msg.sender || arbiter == tenant) revert InvalidAddress();
        if (depositAmount == 0) revert ZeroDeposit();

        agreementId = agreementCount++;
        _agreements[agreementId] = Agreement({
            landlord: msg.sender,
            tenant: tenant,
            arbiter: arbiter,
            depositAmount: depositAmount,
            status: AgreementStatus.Created,
            leaseEndsAt: leaseEndsAt,
            tenantBps: 0,
            propertyHash: propertyHash,
            metadataHash: metadataHash,
            tenantBalance: 0,
            landlordBalance: 0,
            settlementProposer: address(0),
            metadataURI: metadataURI
        });

        emit AgreementCreated(agreementId, msg.sender, tenant, arbiter, depositAmount, metadataHash);
    }

    /**
     * @notice Tenant funds the agreement with the exact deposit; moves it to Active.
     * @dev Guard: status Created, caller is the recorded tenant, exact amount,
     *      single deposit enforced by the Created -> Active transition.
     */
    function deposit(uint256 agreementId) external payable {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.Created) revert InvalidStatus();
        if (msg.sender != ag.tenant) revert NotTenant();
        if (msg.value != ag.depositAmount) revert DepositMismatch();

        ag.status = AgreementStatus.Active;
        emit DepositFunded(agreementId, msg.sender, msg.value);
    }

    /**
     * @notice Either party stores a basis-point split after the lease ends.
     * @param tenantBps tenant share in basis points (landlord gets the rest).
     * @dev Guard: status Active, caller is a party, lease ended, bps <= 10_000.
     */
    function proposeSettlement(uint256 agreementId, uint16 tenantBps) external {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.Active) revert InvalidStatus();
        if (!_isParty(ag, msg.sender)) revert NotParty();
        if (block.timestamp < ag.leaseEndsAt) revert LeaseNotEnded();
        if (tenantBps > BPS_DENOMINATOR) revert InvalidBps();

        ag.settlementProposer = msg.sender;
        ag.tenantBps = tenantBps;
        ag.status = AgreementStatus.SettlementProposed;
        emit SettlementProposed(agreementId, msg.sender, tenantBps);
    }

    /**
     * @notice Counterparty accepts the stored proposal; balances are assigned.
     * @dev Guard: status SettlementProposed, caller is a party and not the
     *      proposer (accepting the exact stored proposal by definition).
     */
    function acceptSettlement(uint256 agreementId) external {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.SettlementProposed) revert InvalidStatus();
        if (!_isParty(ag, msg.sender)) revert NotParty();
        if (msg.sender == ag.settlementProposer) revert NotCounterparty();

        (uint256 tenantAmount, uint256 landlordAmount) = _assignBalances(ag, ag.tenantBps);
        ag.status = AgreementStatus.Settled;
        emit SettlementAccepted(agreementId, msg.sender, tenantAmount, landlordAmount);
    }

    /**
     * @notice Either party hands a funded case to the assigned arbiter.
     * @dev Guard: status Active or SettlementProposed, caller is a party,
     *      evidence hash present (report §4.2).
     */
    function raiseDispute(uint256 agreementId, bytes32 evidenceHash) external {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.Active && ag.status != AgreementStatus.SettlementProposed) {
            revert InvalidStatus();
        }
        if (!_isParty(ag, msg.sender)) revert NotParty();
        if (evidenceHash == bytes32(0)) revert ZeroHash();

        ag.status = AgreementStatus.Disputed;
        emit DisputeRaised(agreementId, msg.sender, evidenceHash, block.timestamp);
    }

    /**
     * @notice Arbiter issues the single final ruling; balances are assigned.
     * @dev Guard: status Disputed (one ruling only), caller is the recorded
     *      arbiter, bps <= 10_000 so the two balances always sum to the deposit.
     *      Dispute-page preset options (architecture doc): full refund to the
     *      tenant = 10_000 bps, even split = 5_000 bps, full amount to the
     *      landlord = 0 bps; the arbiter may also rule any value in between.
     *      The architecture doc's Dispute-page "administrator" is this recorded
     *      arbiter (Arbitrator demo identity); it is not the contract admin.
     */
    function resolveDispute(uint256 agreementId, uint16 tenantBps, bytes32 rationaleHash) external {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.Disputed) revert InvalidStatus();
        if (msg.sender != ag.arbiter) revert NotArbiter();
        if (tenantBps > BPS_DENOMINATOR) revert InvalidBps();

        (uint256 tenantAmount, uint256 landlordAmount) = _assignBalances(ag, tenantBps);
        ag.status = AgreementStatus.Settled;
        emit DisputeResolved(
            agreementId, msg.sender, tenantBps, rationaleHash, tenantAmount, landlordAmount
        );
    }

    /**
     * @notice Either party cancels before any deposit is locked.
     * @dev Guard: status Created only, so locked funds can never be cancelled away.
     */
    function cancelAgreement(uint256 agreementId) external {
        Agreement storage ag = _existing(agreementId);
        if (ag.status != AgreementStatus.Created) revert InvalidStatus();
        if (!_isParty(ag, msg.sender)) revert NotParty();

        ag.status = AgreementStatus.Cancelled;
        emit AgreementCancelled(agreementId, msg.sender);
    }

    /**
     * @notice Pull withdrawal: recipient claims its own assigned balance.
     * @dev Checks-effects-interactions + ReentrancyGuard; balance is zeroed
     *      before the external call (report §5.2 reentrancy mitigation).
     */
    function withdraw(uint256 agreementId) external nonReentrant {
        Agreement storage ag = _existing(agreementId);

        uint256 amount;
        if (msg.sender == ag.tenant) {
            amount = ag.tenantBalance;
            ag.tenantBalance = 0;
        } else if (msg.sender == ag.landlord) {
            amount = ag.landlordBalance;
            ag.landlordBalance = 0;
        } else {
            revert NotParty();
        }
        if (amount == 0) revert NothingToWithdraw();

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit Withdrawn(agreementId, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Inspection lane (report §3.4, §4.2): facts only, never allocation
    // ---------------------------------------------------------------------

    /**
     * @notice Authorized oracle records Passed (true) or Failed (false) with
     *         the report hash. Signature frozen by the GitHub ABI baseline.
     * @dev Guard: ORACLE_ROLE, nonzero hash, and the agreement is Active /
     *      SettlementProposed / Disputed. Settled and Cancelled agreements
     *      reject further updates. The record never changes escrow status or
     *      balances; a bool argument cannot carry an invalid result, so no
     *      result-value guard is needed.
     */
    function recordInspection(
        uint256 agreementId,
        bool passed,
        bytes32 reportHash
    ) external onlyRole(ORACLE_ROLE) {
        Agreement storage ag = _existing(agreementId);
        if (reportHash == bytes32(0)) revert ZeroHash();
        if (
            ag.status != AgreementStatus.Active
            && ag.status != AgreementStatus.SettlementProposed
            && ag.status != AgreementStatus.Disputed
        ) {
            revert InvalidStatus();
        }

        _inspections[agreementId] = Inspection({
            recorded: true,
            passed: passed,
            reportHash: reportHash,
            updatedAt: uint64(block.timestamp),
            recorder: msg.sender
        });

        emit InspectionRecorded(agreementId, msg.sender, passed, reportHash);
    }

    /**
     * @notice Current inspection record; `recorded == false` before the first
     *         authorized update (the frozen ABI's NotRequested equivalent).
     * @dev Read-only; every historical update remains in InspectionRecorded
     *      events, whose block timestamp supplies the per-update time.
     */
    function getInspection(uint256 agreementId) external view returns (Inspection memory) {
        return _inspections[agreementId];
    }

    // ---------------------------------------------------------------------
    // Views for the dApp (report §3.5)
    // ---------------------------------------------------------------------

    function getAgreement(uint256 agreementId) external view returns (Agreement memory) {
        return _existing(agreementId);
    }

    /// @notice Withdrawable balance of `who` for one agreement (pull pattern).
    function withdrawableBalance(uint256 agreementId, address who) external view returns (uint256) {
        Agreement storage ag = _existing(agreementId);
        if (who == ag.tenant) return ag.tenantBalance;
        if (who == ag.landlord) return ag.landlordBalance;
        return 0;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _existing(uint256 agreementId) private view returns (Agreement storage) {
        if (agreementId >= agreementCount) revert InvalidAgreement();
        return _agreements[agreementId];
    }

    function _isParty(Agreement storage ag, address who) private view returns (bool) {
        return who == ag.landlord || who == ag.tenant;
    }

    /// @dev Splits the deposit by bps; landlord receives the remainder so the
    ///      two balances always sum exactly to depositAmount (no rounding leak).
    function _assignBalances(Agreement storage ag, uint16 tenantBps)
        private
        returns (uint256 tenantAmount, uint256 landlordAmount)
    {
        tenantAmount = (ag.depositAmount * tenantBps) / BPS_DENOMINATOR;
        landlordAmount = ag.depositAmount - tenantAmount;
        ag.tenantBalance += tenantAmount;
        ag.landlordBalance += landlordAmount;
    }
}
