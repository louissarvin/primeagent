// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {BeaconProxy} from "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import {UpgradeableBeacon} from "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";

import {LibPolicy} from "../libraries/LibPolicy.sol";
import {IPrimeAgentFactory} from "../interfaces/IPrimeAgentFactory.sol";
import {IErc7715PolicyAuditFacet} from "../interfaces/IErc7715PolicyAuditFacet.sol";
import {IERC6551Registry} from "../interfaces/external/IERC6551Registry.sol";
import {IEmergencyShutdown} from "../interfaces/IEmergencyShutdown.sol";
import {PositionNFT} from "./PositionNFT.sol";
import {AgentRegistry} from "./AgentRegistry.sol";
import {AgentVault} from "./AgentVault.sol";

contract PrimeAgentFactory is Ownable2Step, ReentrancyGuardTransient, IPrimeAgentFactory {
    error ZeroAddress();
    error PolicyTokenIdMustBeZero();
    error VaultMismatch(address expected, address actual);
    error PermissionInstallFailed(bytes returnData);

    bytes32 public constant TBA_SALT = keccak256("primeagent.v1");

    UpgradeableBeacon public immutable beacon;
    PositionNFT public immutable positionNFT;
    AgentRegistry public immutable agentRegistry;
    IERC6551Registry public immutable erc6551Registry;
    IEmergencyShutdown public immutable emergencyShutdown;
    address public immutable diamond;
    address public immutable tbaImpl;
    address public immutable marginEngine;
    address public immutable primaryAdapter;
    address public immutable secondaryAdapter;

    constructor(
        address owner_,
        address positionNFT_,
        address agentRegistry_,
        address diamond_,
        address agentVaultImpl_,
        address tbaImpl_,
        address marginEngine_,
        address erc6551Registry_,
        address primaryAdapter_,
        address secondaryAdapter_,
        address emergencyShutdown_
    )
        Ownable(owner_)
    {
        if (
            owner_ == address(0) || positionNFT_ == address(0) || agentRegistry_ == address(0)
                || diamond_ == address(0) || agentVaultImpl_ == address(0) || tbaImpl_ == address(0)
                || erc6551Registry_ == address(0)
        ) {
            revert ZeroAddress();
        }

        positionNFT = PositionNFT(positionNFT_);
        agentRegistry = AgentRegistry(agentRegistry_);
        diamond = diamond_;
        tbaImpl = tbaImpl_;
        marginEngine = marginEngine_;
        erc6551Registry = IERC6551Registry(erc6551Registry_);

        primaryAdapter = primaryAdapter_;
        secondaryAdapter = secondaryAdapter_;
        emergencyShutdown = IEmergencyShutdown(emergencyShutdown_);

        beacon = new UpgradeableBeacon(agentVaultImpl_, address(this));
    }

    function setBeaconImpl(address newImpl) external onlyOwner {
        if (newImpl == address(0)) revert ZeroAddress();
        beacon.upgradeTo(newImpl);
    }

    function deployAgent(
        address user,
        address baseAsset,
        LibPolicy.Policy calldata policy,
        string calldata agentURI
    )
        external
        nonReentrant
        returns (uint256 tokenId, address vault, address tba, uint256 agentId)
    {
        if (user == address(0) || baseAsset == address(0)) revert ZeroAddress();
        if (policy.tokenId != 0) revert PolicyTokenIdMustBeZero();

        tokenId = positionNFT.nextTokenId();

        address[] memory initialAdapters;
        if (secondaryAdapter != address(0)) {
            initialAdapters = new address[](1);
            initialAdapters[0] = secondaryAdapter;
        } else {
            initialAdapters = new address[](0);
        }
        address initialPauser = address(emergencyShutdown);
        bytes memory initData = abi.encodeCall(
            AgentVault.initialize,
            (
                baseAsset,
                address(positionNFT),
                tokenId,
                marginEngine,
                primaryAdapter,
                initialAdapters,
                initialPauser,
                "PrimeAgent Vault",
                "pVAULT"
            )
        );
        bytes32 vaultSalt = keccak256(abi.encode("vault", user, tokenId));
        BeaconProxy proxy = new BeaconProxy{salt: vaultSalt}(address(beacon), initData);
        vault = address(proxy);

        uint256 mintedId = positionNFT.mintTo(user, vault);
        if (mintedId != tokenId) revert VaultMismatch(vault, vault); // defensive sanity check

        tba = erc6551Registry.createAccount(tbaImpl, TBA_SALT, block.chainid, address(positionNFT), tokenId);

        positionNFT.setTba(tokenId, tba);

        agentId = agentRegistry.register(agentURI);
        agentRegistry.bindToToken(tokenId, agentId);

        // Feature C / Option B: factory now writes through the V2 selector so the canonical
        // `presetHash` field on the policy is recorded and surfaced via `PolicyInstalledV2`.
        // The legacy `installPermission(uint256, LegacyPolicy)` selector remains available on
        // the facet for off-chain callers that have not migrated.
        LibPolicy.Policy memory installPayload = _stampPolicyTokenId(policy, tokenId);
        (bool ok, bytes memory ret) = diamond.call(
            abi.encodeCall(IErc7715PolicyAuditFacet.installPermissionV2, (tokenId, installPayload))
        );
        if (!ok) revert PermissionInstallFailed(ret);

        emit AgentDeployed(tokenId, user, vault, tba, agentId, policy.permissionContextHash);

        if (secondaryAdapter != address(0)) {
            emit SecondaryAdapterReady(tokenId, secondaryAdapter);
        }

        if (address(emergencyShutdown) != address(0)) {
            emergencyShutdown.registerComponent(vault);
            emit VaultRegistrationPending(vault, address(emergencyShutdown));
        }
    }

    function getCanonicalAdapters() external view returns (address[2] memory adapters) {
        adapters[0] = primaryAdapter;
        adapters[1] = secondaryAdapter;
    }

    function predictTba(uint256 tokenId) external view returns (address) {
        return erc6551Registry.account(tbaImpl, TBA_SALT, block.chainid, address(positionNFT), tokenId);
    }

    function _stampPolicyTokenId(
        LibPolicy.Policy calldata src,
        uint256 newTokenId
    )
        internal
        pure
        returns (LibPolicy.Policy memory dst)
    {
        dst.tokenId = newTokenId;
        dst.permissionContextHash = src.permissionContextHash;
        dst.allowedContracts = src.allowedContracts;
        dst.allowedSelectors = src.allowedSelectors;
        dst.maxNotionalUsdQ96 = src.maxNotionalUsdQ96;
        dst.dailyCapUsdQ96 = src.dailyCapUsdQ96;
        dst.expiresAt = src.expiresAt;
        dst.issuedAt = src.issuedAt;
        dst.dailySpentUsdQ96Slot = src.dailySpentUsdQ96Slot;
        dst.dailyWindowStart = src.dailyWindowStart;
        dst.presetHash = src.presetHash;
    }
}