// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

interface IAgentVault {
    event AdapterSet(address indexed adapter, bool active);
    event PauserSet(address indexed oldPauser, address indexed newPauser);
    
    function pushSideBalance(address token, uint256 amount) external;
    function pullSideBalance(address token, uint256 amount, address to) external;
    function setAdapter(address adapter_, bool active_) external;
    function setPauser(address newPauser) external;
    function isAdapter(address adapter_) external view returns (bool);
    function pauser() external view returns (address);
    function sideBalance(address token) external view returns (uint256);
    function marginEngine() external view returns (address);
    function positionNFT() external view returns (address);
    function tokenId() external view returns (uint256);
    function totalBaseAssets() external view returns (uint256);
}
