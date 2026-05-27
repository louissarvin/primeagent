// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IPaymasterRelay {
    event Sponsored(address indexed sender, bytes32 indexed userOpHash, uint256 blockNumber, uint256 newBlockCount);
    event OpsBudgetExceeded(address indexed sender, uint256 blockNumber, uint256 cap);
    event CallerOpsBudgetExceeded(address indexed sender, uint256 blockNumber, uint256 cap);
    event MaxSponsoredOpsPerCallerProposed(address indexed caller, uint256 newPerBlockCap, uint64 effectiveAt);
    event MaxSponsoredOpsPerCallerChanged(address indexed caller, uint256 oldCap, uint256 newCap);
    event MaxSponsoredOpsProposed(uint256 newMax, uint64 effectiveAt);
    event MaxSponsoredOpsChanged(uint256 oldMax, uint256 newMax);
    event SponsoredCallersProposed(bytes32 indexed payloadHash, uint64 effectiveAt);
    event SponsoredCallersChanged(bytes32 indexed payloadHash);
    event DepositToppedUp(address indexed from, uint256 amount);
    event EmergencyUnstaked(address indexed guardian);
    event OwnerWithdrawn(address indexed to, uint256 amount);
    event GuardianChanged(address indexed oldGuardian, address indexed newGuardian);

    error ZeroAddress();
    error ZeroAmount();
    error NotSponsoredCaller(address sender);
    error BudgetExhausted(uint256 blockNumber, uint256 cap);
    error TimelockNotElapsed(uint64 effectiveAt);
    error NoPendingChange();
    error PendingPayloadMismatch();
    error Unauthorized();
    error LengthMismatch();
    error EntryPointCallFailed();

    function TIMELOCK() external view returns (uint256);
    function entryPoint() external view returns (address);
    function guardian() external view returns (address);
    function maxSponsoredOps() external view returns (uint256);
    function sponsoredCallers(address caller) external view returns (bool);
    function opsSponsoredThisBlock(uint256 blockNumber) external view returns (uint256);
    function maxSponsoredOpsPerCaller(address caller) external view returns (uint256);
    function opsSponsoredByCallerThisBlock(address caller, uint256 blockNumber) external view returns (uint256);

    function setGuardian(address newGuardian) external;

    function proposeSetMaxSponsoredOps(uint256 newMax) external;
    function executeSetMaxSponsoredOps(uint256 newMax) external;

    function proposeSetSponsoredCallers(address[] calldata callers, bool[] calldata active) external;
    function executeSetSponsoredCallers(address[] calldata callers, bool[] calldata active) external;

    function proposeSetMaxSponsoredOpsPerCaller(address caller, uint256 newPerBlockCap) external;

    function executeSetMaxSponsoredOpsPerCaller(address caller, uint256 newPerBlockCap) external;

    function topUp() external payable;

    function emergencyUnstake() external;
    function withdrawToOwner(address payable to, uint256 amount) external;
}
