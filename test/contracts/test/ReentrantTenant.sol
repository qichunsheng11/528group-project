// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IRentalEscrow {
    function deposit(uint256 agreementId) external payable;
    function withdraw(uint256 agreementId) external;
}

/**
 * @title ReentrantTenant
 * @notice Test-only helper (Member D, R4). Plays the tenant of an agreement and
 *         tries to re-enter withdraw() from its receive() hook.
 * @dev Used by test/RentalEscrow.reentrancy.test.js to prove that
 *      ReentrancyGuard + checks-effects-interactions stop a recursive drain.
 *      Never deployed to a public network.
 */
contract ReentrantTenant {
    IRentalEscrow public immutable escrow;
    uint256 public agreementId;
    uint256 public reentryAttempts;
    bool private _attacking;

    constructor(address escrowAddress) {
        escrow = IRentalEscrow(escrowAddress);
    }

    /// @notice Tenant side of deposit(): forwards the exact deposit amount.
    function fund(uint256 id) external payable {
        agreementId = id;
        escrow.deposit{value: msg.value}(id);
    }

    /// @notice Starts the withdrawal and re-enters from receive().
    function attack(uint256 id) external {
        agreementId = id;
        _attacking = true;
        escrow.withdraw(id);
        _attacking = false;
    }

    receive() external payable {
        if (_attacking) {
            reentryAttempts += 1;
            // The nested call is expected to fail (ReentrancyGuardReentrantCall,
            // or NothingToWithdraw once the balance was zeroed). Failure is
            // swallowed so the outer call can still complete.
            (bool ok, ) = address(escrow).call(
                abi.encodeWithSignature("withdraw(uint256)", agreementId)
            );
            ok;
        }
    }
}
