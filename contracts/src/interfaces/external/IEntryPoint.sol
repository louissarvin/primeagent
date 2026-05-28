// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IEntryPoint {
    function depositTo(address account) external payable;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function withdrawTo(address payable withdrawAddress, uint256 withdrawAmount) external;
    function balanceOf(address account) external view returns (uint256);
}
