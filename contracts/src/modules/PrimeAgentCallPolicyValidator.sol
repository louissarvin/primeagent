// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {PackedUserOperation} from "account-abstraction/interfaces/PackedUserOperation.sol";

import {IERC7579Validator} from "../interfaces/external/IERC7579Validator.sol";
import {IErc7715PolicyAuditFacet} from "../interfaces/IErc7715PolicyAuditFacet.sol";
import {IPrimeAgentCallPolicyValidator} from "../interfaces/IPrimeAgentCallPolicyValidator.sol";
import {LibPolicy} from "../libraries/LibPolicy.sol";

contract PrimeAgentCallPolicyValidator is IERC7579Validator, IPrimeAgentCallPolicyValidator {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAddress();
    error NotDiamond();

    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    bytes32 internal constant REASON_CONTRACT_NOT_ALLOWED = bytes32("ContractNotAllowed");
    bytes32 internal constant REASON_SELECTOR_NOT_ALLOWED = bytes32("SelectorNotAllowed");
    bytes32 internal constant REASON_NOTIONAL_CAP = bytes32("NotionalCapExceeded");
    bytes32 internal constant REASON_DAILY_CAP = bytes32("DailyCapExceeded");
    bytes32 internal constant REASON_POLICY_EXPIRED = bytes32("PolicyExpired");
    bytes32 internal constant REASON_SIGNER_NOT_OWNER = bytes32("SignerNotOwner");
    bytes32 internal constant VALIDATOR_STORAGE_SLOT = keccak256("primeagent.validator.storage");

    struct ValidatorStorage {
        mapping(address kernel => uint256 tokenId) kernelToTokenId;
        mapping(address kernel => address diamond) kernelToDiamond;
        mapping(address kernel => address ownerOf) kernelToOwner;
        mapping(address kernel => bool installed) installedOf;
        mapping(address kernel => uint256 spentQ96) dailySpent;
        mapping(address kernel => uint64 windowStart) dailyWindowStart;
        mapping(address kernel => uint256 maxNotionalUsdQ96) cachedMaxNotional;
        mapping(address kernel => uint256 dailyCapUsdQ96) cachedDailyCap;
        mapping(address kernel => uint64 expiresAt) cachedExpiresAt;
        mapping(address kernel => address[] allowedContracts) cachedAllowedContracts;
        mapping(address kernel => bytes4[] allowedSelectors) cachedAllowedSelectors;
    }

    function _s() internal pure returns (ValidatorStorage storage s) {
        bytes32 slot = VALIDATOR_STORAGE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function onInstall(bytes calldata data) external {
        ValidatorStorage storage s = _s();
        if (s.installedOf[msg.sender]) revert AlreadyInitialized();
        (uint256 tokenId, address diamondAddress, address agentOwner) = abi.decode(data, (uint256, address, address));
        if (diamondAddress == address(0) || agentOwner == address(0)) revert ZeroAddress();
        s.kernelToTokenId[msg.sender] = tokenId;
        s.kernelToDiamond[msg.sender] = diamondAddress;
        s.kernelToOwner[msg.sender] = agentOwner;
        s.installedOf[msg.sender] = true;
        _cachePolicyFromDiamond(s, msg.sender, tokenId, diamondAddress);
        emit ValidatorInstalled(msg.sender, tokenId, diamondAddress, agentOwner);
    }

    function onUninstall(bytes calldata) external {
        ValidatorStorage storage s = _s();
        if (!s.installedOf[msg.sender]) revert NotInitialized();
        delete s.kernelToTokenId[msg.sender];
        delete s.kernelToDiamond[msg.sender];
        delete s.kernelToOwner[msg.sender];
        delete s.installedOf[msg.sender];
        delete s.dailySpent[msg.sender];
        delete s.dailyWindowStart[msg.sender];
        delete s.cachedMaxNotional[msg.sender];
        delete s.cachedDailyCap[msg.sender];
        delete s.cachedExpiresAt[msg.sender];
        delete s.cachedAllowedContracts[msg.sender];
        delete s.cachedAllowedSelectors[msg.sender];
        emit ValidatorUninstalled(msg.sender);
    }

    function syncPolicy(address kernel) external {
        ValidatorStorage storage s = _s();
        if (!s.installedOf[kernel]) revert NotInitialized();
        address diamondAddress = s.kernelToDiamond[kernel];
        if (msg.sender != diamondAddress) revert NotDiamond();
        uint256 tokenId = s.kernelToTokenId[kernel];
        _cachePolicyFromDiamond(s, kernel, tokenId, diamondAddress);
        emit PolicyCacheSynced(kernel, tokenId);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 1;
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash
    )
        external
        returns (uint256 validationData)
    {
        ValidatorStorage storage s = _s();
        if (!s.installedOf[msg.sender]) revert NotInitialized();

        uint256 tokenId = s.kernelToTokenId[msg.sender];
        address agentOwner = s.kernelToOwner[msg.sender];

        address signer = userOpHash.toEthSignedMessageHash().recover(userOp.signature);
        if (signer == address(0) || signer != agentOwner) {
            emit UserOpRejected(msg.sender, tokenId, REASON_SIGNER_NOT_OWNER);
            return SIG_VALIDATION_FAILED;
        }

        uint64 expiresAt = s.cachedExpiresAt[msg.sender];
        if (expiresAt != 0 && uint64(block.timestamp) >= expiresAt) {
            emit UserOpRejected(msg.sender, tokenId, REASON_POLICY_EXPIRED);
            return SIG_VALIDATION_FAILED;
        }

        (address target, bytes4 selector, uint256 notionalUsdQ96, bool decodeOk) =
            _decodeUserOpCall(userOp.callData);
        if (!decodeOk) {
            emit UserOpRejected(msg.sender, tokenId, REASON_CONTRACT_NOT_ALLOWED);
            return SIG_VALIDATION_FAILED;
        }

        if (!_listHasAddressStorage(s.cachedAllowedContracts[msg.sender], target)) {
            emit UserOpRejected(msg.sender, tokenId, REASON_CONTRACT_NOT_ALLOWED);
            return SIG_VALIDATION_FAILED;
        }
        if (!_listHasSelectorStorage(s.cachedAllowedSelectors[msg.sender], selector)) {
            emit UserOpRejected(msg.sender, tokenId, REASON_SELECTOR_NOT_ALLOWED);
            return SIG_VALIDATION_FAILED;
        }
        if (notionalUsdQ96 > s.cachedMaxNotional[msg.sender]) {
            emit UserOpRejected(msg.sender, tokenId, REASON_NOTIONAL_CAP);
            return SIG_VALIDATION_FAILED;
        }

        if (!_accruePersistentDaily(s, msg.sender, notionalUsdQ96, s.cachedDailyCap[msg.sender])) {
            emit UserOpRejected(msg.sender, tokenId, REASON_DAILY_CAP);
            return SIG_VALIDATION_FAILED;
        }

        return SIG_VALIDATION_SUCCESS;
    }

    function _cachePolicyFromDiamond(
        ValidatorStorage storage s,
        address kernel,
        uint256 tokenId,
        address diamondAddress
    )
        internal
    {
        LibPolicy.Policy memory pol = IErc7715PolicyAuditFacet(diamondAddress).getPolicy(tokenId);
        s.cachedMaxNotional[kernel] = pol.maxNotionalUsdQ96;
        s.cachedDailyCap[kernel] = pol.dailyCapUsdQ96;
        s.cachedExpiresAt[kernel] = pol.expiresAt;
        delete s.cachedAllowedContracts[kernel];
        delete s.cachedAllowedSelectors[kernel];
        for (uint256 i; i < pol.allowedContracts.length; ++i) {
            s.cachedAllowedContracts[kernel].push(pol.allowedContracts[i]);
        }
        for (uint256 i; i < pol.allowedSelectors.length; ++i) {
            s.cachedAllowedSelectors[kernel].push(pol.allowedSelectors[i]);
        }
    }

    function _listHasAddressStorage(address[] storage list, address target) internal view returns (bool) {
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == target) return true;
        }
        return false;
    }

    function _listHasSelectorStorage(bytes4[] storage list, bytes4 selector) internal view returns (bool) {
        uint256 n = list.length;
        for (uint256 i; i < n; ++i) {
            if (list[i] == selector) return true;
        }
        return false;
    }

    function isValidSignatureWithSender(
        address, /* sender */
        bytes32, /* hash */
        bytes calldata /* signature */
    )
        external
        pure
        returns (bytes4)
    {
        return 0xffffffff;
    }

    function tokenIdOf(address kernel) external view returns (uint256) {
        return _s().kernelToTokenId[kernel];
    }

    function diamondOf(address kernel) external view returns (address) {
        return _s().kernelToDiamond[kernel];
    }

    function ownerOf(address kernel) external view returns (address) {
        return _s().kernelToOwner[kernel];
    }

    function isInstalled(address kernel) external view returns (bool) {
        return _s().installedOf[kernel];
    }

    function getCachedPolicy(address kernel)
        external
        view
        returns (
            uint256 maxNotionalUsdQ96,
            uint256 dailyCapUsdQ96,
            uint64 expiresAt,
            address[] memory allowedContracts,
            bytes4[] memory allowedSelectors
        )
    {
        ValidatorStorage storage s = _s();
        maxNotionalUsdQ96 = s.cachedMaxNotional[kernel];
        dailyCapUsdQ96 = s.cachedDailyCap[kernel];
        expiresAt = s.cachedExpiresAt[kernel];
        allowedContracts = s.cachedAllowedContracts[kernel];
        allowedSelectors = s.cachedAllowedSelectors[kernel];
    }

    function dailySpentOf(address kernel) external view returns (uint256 spentQ96, uint64 windowStart) {
        ValidatorStorage storage s = _s();
        spentQ96 = s.dailySpent[kernel];
        windowStart = s.dailyWindowStart[kernel];
    }

    function getDailySpent(address kernel) external view returns (uint256 spentQ96, uint64 windowStart) {
        ValidatorStorage storage s = _s();
        spentQ96 = s.dailySpent[kernel];
        windowStart = s.dailyWindowStart[kernel];
    }

    function _decodeUserOpCall(bytes calldata callData)
        internal
        pure
        returns (address target, bytes4 selector, uint256 notionalUsdQ96, bool decodeOk)
    {
        bytes memory innerData;

        if (callData.length >= 4) {
            bytes4 outerSel;
            assembly {
                outerSel := calldataload(callData.offset)
            }
            if (outerSel == bytes4(keccak256("execute(address,uint256,bytes)"))) {
                if (callData.length < 4 + 32 * 3) return (address(0), bytes4(0), 0, false);
                bytes calldata args = callData[4:];
                (target,, innerData) = abi.decode(args, (address, uint256, bytes));
                selector = _selectorOf(innerData);
                notionalUsdQ96 = _notionalFor(selector, innerData);
                return (target, selector, notionalUsdQ96, true);
            }
        }

        if (callData.length < 32 * 3) return (address(0), bytes4(0), 0, false);
        (target,, innerData) = abi.decode(callData, (address, uint256, bytes));
        selector = _selectorOf(innerData);
        notionalUsdQ96 = _notionalFor(selector, innerData);
        return (target, selector, notionalUsdQ96, true);
    }

    function _selectorOf(bytes memory innerData) internal pure returns (bytes4 sel) {
        if (innerData.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(innerData, 32))
        }
    }

    function _listHasAddress(address[] memory list, address target) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == target) return true;
        }
        return false;
    }

    function _listHasSelector(bytes4[] memory list, bytes4 selector) internal pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == selector) return true;
        }
        return false;
    }

    function _notionalFor(bytes4 selector, bytes memory innerData) internal pure returns (uint256) {
        if (selector == bytes4(keccak256("swap(address,address,uint256,uint256)"))) {
            return _decodeUintAt(innerData, 4 + 32 * 2);
        }
        if (selector == bytes4(keccak256("openPerp(address,uint256,bool,uint256)"))) {
            return _decodeUintAt(innerData, 4 + 32 * 1);
        }
        return 0;
    }

    function _decodeUintAt(bytes memory data, uint256 offset) internal pure returns (uint256 v) {
        if (data.length < offset + 32) return 0;
        assembly {
            v := mload(add(add(data, 32), offset))
        }
    }

    function _accruePersistentDaily(
        ValidatorStorage storage s,
        address kernel,
        uint256 notionalUsdQ96,
        uint256 capQ96
    )
        internal
        returns (bool)
    {
        uint64 nowTs = uint64(block.timestamp);
        uint64 windowStart = s.dailyWindowStart[kernel];
        uint256 spent;
        if (windowStart == 0 || nowTs - windowStart >= 1 days) {
            spent = 0;
            s.dailyWindowStart[kernel] = nowTs;
        } else {
            spent = s.dailySpent[kernel];
        }
        uint256 newSpent = spent + notionalUsdQ96;
        if (newSpent < spent) return false;
        if (newSpent > capQ96) return false;
        s.dailySpent[kernel] = newSpent;
        return true;
    }
}
