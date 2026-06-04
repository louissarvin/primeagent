// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";

import {PrimeAgentDiamond} from "../../src/core/PrimeAgentDiamond.sol";
import {DiamondInit} from "../../src/core/DiamondInit.sol";
import {Erc7715PolicyAuditFacet} from "../../src/modules/Erc7715PolicyAuditFacet.sol";
import {IErc7715PolicyAuditFacet} from "../../src/interfaces/IErc7715PolicyAuditFacet.sol";
import {LibPolicy} from "../../src/libraries/LibPolicy.sol";
import {LibRiskPresets} from "../../src/libraries/LibRiskPresets.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {PositionNFT} from "../../src/core/PositionNFT.sol";

/// @title PresetHashMonotonicHandler
/// @notice Drives the facet through install / update / revoke permutations with random
///         presetHash values. The handler PRE-FILTERS the presetHash to belong to the
///         canonical set so the facet accepts the call; the invariant then reads back
///         the stored value and asserts it is still canonical.
contract PresetHashMonotonicHandler is Test {
    PrimeAgentDiamond public immutable diamond;
    PositionNFT public immutable nft;
    address public immutable factory;
    address public immutable nftOwner;

    uint256[3] public seededTokenIds;

    uint256 public installCalls;
    uint256 public updateCalls;
    uint256 public rejectedCalls;

    constructor(
        PrimeAgentDiamond diamond_,
        PositionNFT nft_,
        address factory_,
        address nftOwner_,
        uint256[3] memory tokenIds_
    ) {
        diamond = diamond_;
        nft = nft_;
        factory = factory_;
        nftOwner = nftOwner_;
        seededTokenIds = tokenIds_;
    }

    function _pickToken(uint256 seed) internal view returns (uint256) {
        return seededTokenIds[seed % seededTokenIds.length];
    }

    /// @dev Pick one of the 6 canonical values (custom + 5 presets).
    function _pickCanonicalHash(uint256 seed) internal pure returns (bytes32) {
        uint256 idx = seed % 6;
        if (idx == 0) return LibRiskPresets.PRESET_CUSTOM;
        bytes32[5] memory hashes = LibRiskPresets.canonicalHashes();
        return hashes[idx - 1];
    }

    function _samplePolicy(uint256 tokenId, bytes32 presetHash)
        internal
        view
        returns (LibPolicy.Policy memory p)
    {
        p.tokenId = tokenId;
        p.permissionContextHash = keccak256(abi.encode("ph", tokenId, block.timestamp, presetHash));
        address[] memory ac = new address[](1);
        ac[0] = address(0xC0FFEE);
        p.allowedContracts = ac;
        bytes4[] memory ss = new bytes4[](1);
        ss[0] = bytes4(0xDEADBEEF);
        p.allowedSelectors = ss;
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        p.presetHash = presetHash;
    }

    /// @notice Try to rotate the preset hash to a random canonical value via V2 update.
    function rotatePresetHashCanonical(uint256 tokenSeed, uint256 hashSeed) external {
        uint256 tokenId = _pickToken(tokenSeed);
        bytes32 hashV = _pickCanonicalHash(hashSeed);
        LibPolicy.Policy memory p = _samplePolicy(tokenId, hashV);
        vm.prank(nftOwner);
        try IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(tokenId, p) {
            ++updateCalls;
        } catch {}
    }

    /// @notice Try to rotate with a NON-canonical hash. The facet MUST reject; if it ever
    ///         succeeds, the invariant below would observe a foreign hash in the storage.
    function tryRotateWithNonCanonical(uint256 tokenSeed, bytes32 hashV) external {
        // Force the hash to be outside the canonical set by re-rolling whenever the fuzz
        // hands us a canonical value (very rare collision).
        if (LibRiskPresets.isCanonicalPresetHash(hashV)) {
            hashV = keccak256(abi.encodePacked(hashV, "noncanonical"));
            if (LibRiskPresets.isCanonicalPresetHash(hashV)) return;
        }
        uint256 tokenId = _pickToken(tokenSeed);
        LibPolicy.Policy memory p = _samplePolicy(tokenId, hashV);
        vm.prank(nftOwner);
        try IErc7715PolicyAuditFacet(address(diamond)).updatePermissionV2(tokenId, p) {
            revert("facet must reject non-canonical preset hash");
        } catch {
            ++rejectedCalls;
        }
    }
}

/// @title PresetHashMonotonicInvariants
/// @notice Feature C / Option B invariant. Asserts that every `presetHash` stored by the
///         audit facet is one of:
///         (a) `LibRiskPresets.PRESET_CUSTOM` (i.e. `bytes32(0)`), OR
///         (b) one of the 5 canonical preset hashes in `LibRiskPresets.canonicalHashes()`.
///         The handler exercises both the legitimate canonical path and a non-canonical
///         path that the facet MUST reject; the invariant is the final read check.
contract PresetHashMonotonicInvariants is StdInvariant, Test {
    PrimeAgentDiamond internal diamond;
    Erc7715PolicyAuditFacet internal auditFacet;
    DiamondInit internal diamondInit;
    PositionNFT internal nft;

    address internal owner = makeAddr("ph.owner");
    address internal factory = makeAddr("ph.factory");
    address internal nftOwner = makeAddr("ph.nftOwner");

    PresetHashMonotonicHandler internal handler;
    uint256[3] internal _tokenIds;

    function setUp() public {
        nft = new PositionNFT("PrimeAgent Position", "PRIME", owner);
        vm.prank(owner);
        nft.setFactory(factory);

        auditFacet = new Erc7715PolicyAuditFacet();
        diamondInit = new DiamondInit();

        bytes4[] memory sel = new bytes4[](11);
        sel[0] = Erc7715PolicyAuditFacet.initAudit.selector;
        sel[1] = Erc7715PolicyAuditFacet.installPermission.selector;
        sel[2] = Erc7715PolicyAuditFacet.revokePermission.selector;
        sel[3] = Erc7715PolicyAuditFacet.getPolicy.selector;
        sel[4] = Erc7715PolicyAuditFacet.permissionContextHash.selector;
        sel[5] = Erc7715PolicyAuditFacet.isPolicyActive.selector;
        sel[6] = Erc7715PolicyAuditFacet.auditFactory.selector;
        sel[7] = Erc7715PolicyAuditFacet.updatePermission.selector;
        sel[8] = Erc7715PolicyAuditFacet.installPermissionV2.selector;
        sel[9] = Erc7715PolicyAuditFacet.updatePermissionV2.selector;
        sel[10] = Erc7715PolicyAuditFacet.getPresetHash.selector;

        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(auditFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: sel
        });
        bytes memory initCall = abi.encodeCall(
            DiamondInit.init,
            (DiamondInit.InitArgs({auditFactory: factory, auditPositionNFT: address(nft)}))
        );
        diamond = new PrimeAgentDiamond(owner, cuts, address(diamondInit), initCall);

        // Mint 3 NFTs and seed each with a canonical preset (balanced / aggressive / custom).
        bytes32[3] memory seedHashes = [
            LibRiskPresets.PRESET_BALANCED,
            LibRiskPresets.PRESET_AGGRESSIVE,
            LibRiskPresets.PRESET_CUSTOM
        ];
        for (uint256 i; i < 3; ++i) {
            vm.prank(factory);
            uint256 tokenId = nft.mintTo(nftOwner, makeAddr(string.concat("vault.ph.", vm.toString(i))));
            _tokenIds[i] = tokenId;

            LibPolicy.Policy memory p = _basePolicy(tokenId, seedHashes[i]);
            vm.prank(factory);
            IErc7715PolicyAuditFacet(address(diamond)).installPermissionV2(tokenId, p);
        }

        handler = new PresetHashMonotonicHandler(diamond, nft, factory, nftOwner, _tokenIds);
        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = handler.rotatePresetHashCanonical.selector;
        selectors[1] = handler.tryRotateWithNonCanonical.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    function _basePolicy(uint256 tokenId, bytes32 presetHash)
        internal
        view
        returns (LibPolicy.Policy memory p)
    {
        p.tokenId = tokenId;
        p.permissionContextHash = keccak256(abi.encode("seed", tokenId, presetHash));
        address[] memory ac = new address[](1);
        ac[0] = address(0xCAFE);
        p.allowedContracts = ac;
        bytes4[] memory ss = new bytes4[](1);
        ss[0] = bytes4(0x12345678);
        p.allowedSelectors = ss;
        p.maxNotionalUsdQ96 = 1_000_000;
        p.dailyCapUsdQ96 = 5_000_000;
        p.expiresAt = uint64(block.timestamp + 30 days);
        p.issuedAt = uint64(block.timestamp);
        p.presetHash = presetHash;
    }

    /// @notice Property: every stored presetHash is one of the 6 canonical values
    ///         (5 presets + custom sentinel).
    function invariant_presetHash_is_always_canonical() public view {
        IErc7715PolicyAuditFacet af = IErc7715PolicyAuditFacet(address(diamond));
        for (uint256 i; i < 3; ++i) {
            bytes32 stored = af.getPresetHash(handler.seededTokenIds(i));
            require(
                LibRiskPresets.isCanonicalPresetHash(stored),
                "stored presetHash must be canonical (custom or one of 5)"
            );
        }
    }

    /// @notice Sanity unit-style assertion executed every round: the registry library is
    ///         a stable source of truth (no surprise drift between runs).
    function invariant_registry_size_is_five_plus_custom() public pure {
        bytes32[5] memory hashes = LibRiskPresets.canonicalHashes();
        // All 5 must be distinct and none equal to the custom sentinel.
        for (uint256 i; i < 5; ++i) {
            require(hashes[i] != LibRiskPresets.PRESET_CUSTOM, "preset must not collide with custom");
            for (uint256 j = i + 1; j < 5; ++j) {
                require(hashes[i] != hashes[j], "preset hashes must be distinct");
            }
            require(LibRiskPresets.isCanonicalPresetHash(hashes[i]), "preset must be canonical");
        }
        require(LibRiskPresets.isCanonicalPresetHash(LibRiskPresets.PRESET_CUSTOM), "custom must be canonical");
    }
}
