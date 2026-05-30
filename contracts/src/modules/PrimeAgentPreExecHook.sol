// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC7579Hook} from "../interfaces/external/IERC7579Hook.sol";
import {IErc7715PolicyAuditFacet} from "../interfaces/IErc7715PolicyAuditFacet.sol";
import {IJurisdictionPolicyFacet} from "../interfaces/IJurisdictionPolicyFacet.sol";
import {IPrimeAgentPreExecHook} from "../interfaces/IPrimeAgentPreExecHook.sol";
import {IPrimeAgentCallPolicyValidator} from "../interfaces/IPrimeAgentCallPolicyValidator.sol";
import {LibPolicy} from "../libraries/LibPolicy.sol";

contract PrimeAgentPreExecHook is IERC7579Hook, IPrimeAgentPreExecHook {
    error AlreadyInitialized();
    error NotInitialized();
    error ZeroAddress();
    error ContractNotAllowed(address target);
    error SelectorNotAllowed(bytes4 selector);
    error NotionalCapExceeded(uint256 notionalUsdQ96, uint256 cap);
    error DailyCapExceeded();
    error PolicyExpired();
    error MalformedCallData();
    /// @notice Trading action blocked because the caller's resolved jurisdiction is
    ///         currently paused for this tokenId.
    /// @param tokenId The PositionNFT tokenId.
    /// @param isoCountry The two-byte ISO-3166-1 alpha-2 country code that was paused.
    error PausedForJurisdiction(uint256 tokenId, bytes2 isoCountry);
    /// @notice The `extraData` jurisdiction word is malformed (top 2 bytes are not a
    ///         valid uppercase ISO-3166-1 alpha-2 code OR the remaining 30 bytes are
    ///         non-zero).
    error MalformedJurisdictionExtra();

    bytes32 internal constant HOOK_STORAGE_SLOT = keccak256("primeagent.preexechook.storage");

    struct HookStorage {
        mapping(address kernel => uint256 tokenId) kernelToTokenId;
        mapping(address kernel => address diamond) kernelToDiamond;
        mapping(address kernel => bool installed) installedOf;
        mapping(address kernel => address validator) kernelToValidator;
    }

    function _s() internal pure returns (HookStorage storage s) {
        bytes32 slot = HOOK_STORAGE_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function onInstall(bytes calldata data) external {
        HookStorage storage s = _s();
        if (s.installedOf[msg.sender]) revert AlreadyInitialized();
        uint256 tokenId = 0;
        address diamondAddress = address(0);
        address validatorAddress = address(0);
        if (data.length == 64) {
            (tokenId, diamondAddress) = abi.decode(data, (uint256, address));
        } else {
            (tokenId, diamondAddress, validatorAddress) = abi.decode(data, (uint256, address, address));
        }
        if (diamondAddress == address(0)) revert ZeroAddress();
        s.kernelToTokenId[msg.sender] = tokenId;
        s.kernelToDiamond[msg.sender] = diamondAddress;
        s.kernelToValidator[msg.sender] = validatorAddress;
        s.installedOf[msg.sender] = true;
        emit HookInstalled(msg.sender, tokenId, diamondAddress);
    }

    function onUninstall(bytes calldata) external {
        HookStorage storage s = _s();
        if (!s.installedOf[msg.sender]) revert NotInitialized();
        delete s.kernelToTokenId[msg.sender];
        delete s.kernelToDiamond[msg.sender];
        delete s.kernelToValidator[msg.sender];
        delete s.installedOf[msg.sender];
        emit HookUninstalled(msg.sender);
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == 4;
    }

    function preCheck(
        address, /* msgSender */
        uint256, /* value */
        bytes calldata callData
    )
        external
        returns (bytes memory hookData)
    {
        HookStorage storage s = _s();
        if (!s.installedOf[msg.sender]) revert NotInitialized();

        uint256 tokenId = s.kernelToTokenId[msg.sender];
        address diamondAddress = s.kernelToDiamond[msg.sender];

        (address target,, bytes memory innerData, bool hasIso, bytes2 iso) = _decodeCall(callData);
        bytes4 selector = _selectorOf(innerData);

        // Jurisdiction gate. Legacy callers omit the extra word (`hasIso=false`) and the
        // check is skipped for back-compat. When present, the same Diamond hosts the
        // `JurisdictionPolicyFacet` so we can call it via the existing diamondAddress.
        // The facet's read is a pure storage read; no external trust assumption beyond
        // the Diamond itself, which is also the source of policy state.
        if (hasIso) {
            if (IJurisdictionPolicyFacet(diamondAddress).isPausedForJurisdiction(tokenId, iso)) {
                revert PausedForJurisdiction(tokenId, iso);
            }
        }

        LibPolicy.Policy memory pol = IErc7715PolicyAuditFacet(diamondAddress).getPolicy(tokenId);

        if (pol.expiresAt != 0 && uint64(block.timestamp) >= pol.expiresAt) revert PolicyExpired();

        if (!_listHasAddress(pol.allowedContracts, target)) revert ContractNotAllowed(target);
        if (!_listHasSelector(pol.allowedSelectors, selector)) revert SelectorNotAllowed(selector);

        uint256 notionalUsdQ96 = _notionalFor(selector, innerData);

        if (notionalUsdQ96 > pol.maxNotionalUsdQ96) {
            revert NotionalCapExceeded(notionalUsdQ96, pol.maxNotionalUsdQ96);
        }

        address validatorAddress = s.kernelToValidator[msg.sender];
        bool dailyOk;
        if (validatorAddress != address(0)) {
            (uint256 spentQ96, uint64 windowStart) =
                IPrimeAgentCallPolicyValidator(validatorAddress).getDailySpent(msg.sender);
            dailyOk = _dailyCapHoldsAgainstCounter(pol.dailyCapUsdQ96, spentQ96, windowStart, notionalUsdQ96);
        } else {
            dailyOk = _dailyCapHoldsInMemory(pol, notionalUsdQ96);
        }
        if (!dailyOk) revert DailyCapExceeded();

        emit PreCheckAccepted(msg.sender, tokenId, target, selector, notionalUsdQ96);
        return abi.encode(tokenId, notionalUsdQ96);
    }

    function postCheck(bytes calldata hookData) external {
        hookData;
    }

    function tokenIdOf(address kernel) external view returns (uint256) {
        return _s().kernelToTokenId[kernel];
    }

    function diamondOf(address kernel) external view returns (address) {
        return _s().kernelToDiamond[kernel];
    }

    function isInstalled(address kernel) external view returns (bool) {
        return _s().installedOf[kernel];
    }

    function validatorOf(address kernel) external view returns (address) {
        return _s().kernelToValidator[kernel];
    }

    /// @dev Decodes the canonical ERC-7579 single-call body `(address, uint256, bytes)`.
    ///      Optionally accepts ONE trailing 32-byte `extraData` word that carries a
    ///      2-byte ISO-3166-1 alpha-2 jurisdiction code at the high-order 2 bytes; the
    ///      remaining 30 bytes MUST be zero. Reverts `MalformedCallData` on any other
    ///      layout, `MalformedJurisdictionExtra` if the suffix is present but invalid.
    /// @return target Canonical call target.
    /// @return callValue Canonical call value.
    /// @return innerData Canonical call data body.
    /// @return hasIso True iff the optional ISO extra suffix is present.
    /// @return iso The two-byte uppercase ISO-3166-1 alpha-2 code from the suffix.
    function _decodeCall(bytes calldata callData)
        internal
        pure
        returns (address target, uint256 callValue, bytes memory innerData, bool hasIso, bytes2 iso)
    {
        if (callData.length < 32 * 3) revert MalformedCallData();
        uint256 innerOffset;
        assembly {
            innerOffset := calldataload(add(callData.offset, 64))
        }
        if (innerOffset != 0x60) revert MalformedCallData();
        uint256 addrWord;
        assembly {
            addrWord := calldataload(callData.offset)
        }
        if (addrWord >> 160 != 0) revert MalformedCallData();
        (target, callValue, innerData) = abi.decode(callData, (address, uint256, bytes));
        // Intentional ceiling-to-32 rounding for ABI word alignment. Slither flags the
        // div-before-mul pattern but the truncation is the desired effect.
        // slither-disable-next-line divide-before-multiply
        uint256 paddedInner = ((innerData.length + 31) / 32) * 32;
        uint256 canonicalLen = 96 + 32 + paddedInner;
        if (callData.length == canonicalLen) {
            // Legacy / no jurisdiction extra. Back-compat path.
            return (target, callValue, innerData, false, bytes2(0));
        }
        if (callData.length != canonicalLen + 32) revert MalformedCallData();
        // Read the trailing 32-byte word at the end of the calldata.
        uint256 extraWord;
        assembly {
            extraWord := calldataload(add(callData.offset, canonicalLen))
        }
        // Top 2 bytes = ISO. Remaining 30 bytes (low 240 bits) MUST be zero.
        if ((extraWord & ((1 << 240) - 1)) != 0) revert MalformedJurisdictionExtra();
        iso = bytes2(uint16(extraWord >> 240));
        // Validate ISO is two uppercase ASCII letters A..Z (0x41..0x5A).
        uint8 a = uint8(iso[0]);
        uint8 b = uint8(iso[1]);
        if (!(a >= 0x41 && a <= 0x5A && b >= 0x41 && b <= 0x5A)) {
            revert MalformedJurisdictionExtra();
        }
        hasIso = true;
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
        if (data.length < offset + 32) revert MalformedCallData();
        assembly {
            v := mload(add(add(data, 32), offset))
        }
    }

    function _dailyCapHoldsInMemory(LibPolicy.Policy memory p, uint256 notionalUsdQ96) internal view returns (bool) {
        uint64 nowTs = uint64(block.timestamp);
        uint256 spent =
            (p.dailyWindowStart == 0 || nowTs - p.dailyWindowStart >= 1 days) ? 0 : uint256(p.dailySpentUsdQ96Slot);
        uint256 newSpent = spent + notionalUsdQ96;
        if (newSpent < spent) return false;
        if (newSpent > p.dailyCapUsdQ96) return false;
        return true;
    }

    function _dailyCapHoldsAgainstCounter(
        uint256 dailyCapUsdQ96,
        uint256 spentQ96,
        uint64 windowStart,
        uint256 notionalUsdQ96
    )
        internal
        view
        returns (bool)
    {
        uint64 nowTs = uint64(block.timestamp);
        uint256 spent =
            (windowStart == 0 || nowTs - windowStart >= 1 days) ? 0 : spentQ96;
        uint256 newSpent = spent + notionalUsdQ96;
        if (newSpent < spent) return false;
        if (newSpent > dailyCapUsdQ96) return false;
        return true;
    }
}
