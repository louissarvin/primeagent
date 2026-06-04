// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {RhChainSwap} from "../../src/modules/RhChainSwap.sol";
import {IRhChainSwap} from "../../src/interfaces/IRhChainSwap.sol";
import {MockERC20} from "../mocks/MockERC20.sol";

/// @dev Mock ERC20 that attempts to re-enter the swap contract on transfer / transferFrom.
contract ReentrantToken is MockERC20 {
    RhChainSwap public target;
    bool public attackOnTransferFrom;
    bool public attackOnTransfer;
    uint256 public attackTokenId;
    address public attackOtherToken;

    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) {}

    function arm(
        RhChainSwap target_,
        bool onFrom,
        bool onOut,
        uint256 tokenId_,
        address otherToken_
    )
        external
    {
        target = target_;
        attackOnTransferFrom = onFrom;
        attackOnTransfer = onOut;
        attackTokenId = tokenId_;
        attackOtherToken = otherToken_;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (attackOnTransferFrom && address(target) != address(0)) {
            // Try to reenter deposit with a tiny amount; must revert with reentrancy.
            target.deposit(attackTokenId, address(this), 1);
        }
        return super.transferFrom(from, to, amount);
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attackOnTransfer && address(target) != address(0)) {
            target.withdraw(attackTokenId, address(this), 1);
        }
        return super.transfer(to, amount);
    }
}

contract RhChainSwapTest is Test {
    RhChainSwap internal swapContract;

    MockERC20 internal usdg; // 18 decimals (per ADR's WAD-friendly choice for tests)
    MockERC20 internal tsla; // 18 decimals
    MockERC20 internal amzn; // 18 decimals

    address internal admin = makeAddr("admin");
    uint256 internal attestorPk = 0xA77E5701;
    address internal attestorEoa;
    uint256 internal mallPk = 0xB0B;
    address internal mall = vm.addr(0xB0B);

    uint256 internal ownerPk = 0xC0FFEE;
    address internal ownerEoa = vm.addr(0xC0FFEE);

    uint256 internal otherOwnerPk = 0xDECAF;
    address internal otherOwnerEoa = vm.addr(0xDECAF);

    address internal user = makeAddr("user");
    address internal relayer = makeAddr("relayer");

    uint64 internal constant TIMELOCK = 1 hours;
    uint256 internal constant TID = 1;

    bytes32 internal constant PRICE_TYPEHASH = keccak256(
        "Price(uint256 tokenId,address fromToken,address toToken,uint256 amountIn,uint256 minAmountOut,uint256 priceWad,uint64 nonce,uint64 validUntil)"
    );
    bytes32 internal constant WITHDRAW_AUTH_TYPEHASH = keccak256(
        "WithdrawAuth(uint256 tokenId,address token,uint256 amount,address to,uint64 nonce,uint64 validUntil)"
    );
    bytes32 internal constant OWNER_REG_TYPEHASH =
        keccak256("OwnerRegistration(uint256 tokenId,address newOwner,uint64 validUntil)");

    function setUp() public {
        attestorEoa = vm.addr(attestorPk);

        usdg = new MockERC20("USDG", "USDG", 18);
        tsla = new MockERC20("TSLA", "TSLA", 18);
        amzn = new MockERC20("AMZN", "AMZN", 18);

        address[] memory tokens = new address[](3);
        tokens[0] = address(usdg);
        tokens[1] = address(tsla);
        tokens[2] = address(amzn);
        uint8[] memory decs = new uint8[](3);
        decs[0] = 18;
        decs[1] = 18;
        decs[2] = 18;

        swapContract = new RhChainSwap(admin, attestorEoa, TIMELOCK, tokens, decs);

        // Fund the user with deposits.
        usdg.mint(user, 1_000_000 ether);
        tsla.mint(user, 1_000_000 ether);
        vm.startPrank(user);
        usdg.approve(address(swapContract), type(uint256).max);
        tsla.approve(address(swapContract), type(uint256).max);
        amzn.approve(address(swapContract), type(uint256).max);
        vm.stopPrank();

        // Also fund and approve the owner so it can deposit.
        usdg.mint(ownerEoa, 1_000_000 ether);
        tsla.mint(ownerEoa, 1_000_000 ether);
        vm.startPrank(ownerEoa);
        usdg.approve(address(swapContract), type(uint256).max);
        tsla.approve(address(swapContract), type(uint256).max);
        vm.stopPrank();
    }

    // ---------- helpers ----------

    function _signEip712(bytes32 structHash, uint256 pk) internal view returns (bytes memory) {
        bytes32 ds = swapContract.domainSeparator();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", ds, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _priceStructHash(
        uint256 tokenId,
        address fromT,
        address toT,
        uint256 amtIn,
        uint256 minOut,
        uint256 priceWad,
        uint64 nonce,
        uint64 validUntil
    )
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(PRICE_TYPEHASH, tokenId, fromT, toT, amtIn, minOut, priceWad, nonce, validUntil)
        );
    }

    function _withdrawAuthHash(
        uint256 tokenId,
        address token,
        uint256 amount,
        address to,
        uint64 nonce,
        uint64 validUntil
    )
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(WITHDRAW_AUTH_TYPEHASH, tokenId, token, amount, to, nonce, validUntil)
        );
    }

    function _ownerRegHash(
        uint256 tokenId,
        address newOwner,
        uint64 validUntil
    )
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(OWNER_REG_TYPEHASH, tokenId, newOwner, validUntil));
    }

    function _registerFirst(uint256 tokenId, address newOwner) internal {
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(tokenId, newOwner, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        swapContract.registerOwner(tokenId, newOwner, vu, sig, "");
    }

    // =========================================================================
    // Happy path
    // =========================================================================

    function test_deploy_assertsDecimals_andSeedsAllowlist() public view {
        assertTrue(swapContract.allowedTokens(address(usdg)));
        assertTrue(swapContract.allowedTokens(address(tsla)));
        assertTrue(swapContract.allowedTokens(address(amzn)));
        assertEq(swapContract.expectedDecimals(address(usdg)), 18);
        assertEq(swapContract.attestor(), attestorEoa);
        assertEq(swapContract.EMERGENCY_TIMELOCK(), TIMELOCK);
    }

    function test_deposit_creditsBalance() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        assertEq(swapContract.balances(TID, address(usdg)), 100 ether);
        assertEq(usdg.balanceOf(address(swapContract)), 100 ether);
    }

    function test_registerOwner_firstTime_attestorSigOnly() public {
        _registerFirst(TID, ownerEoa);
        assertEq(swapContract.tokenIdOwner(TID), ownerEoa);
    }

    function test_swap_usdgToTsla_creditsCorrectly() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);
        _registerFirst(TID, ownerEoa);

        // priceWad = 0.004e18 (1 USDG = 0.004 TSLA at $250/TSLA)
        uint256 priceWad = 4 * 1e15;
        uint256 amountIn = 250 ether;
        uint256 expectedOut = (amountIn * priceWad) / 1e18; // 1 TSLA

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h =
            _priceStructHash(TID, address(usdg), address(tsla), amountIn, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        uint256 out = swapContract.swap(
            TID, address(usdg), address(tsla), amountIn, 0, priceWad, priceWad, 0, vu, sig
        );

        assertEq(out, expectedOut);
        assertEq(swapContract.balances(TID, address(usdg)), 750 ether);
        assertEq(swapContract.balances(TID, address(tsla)), expectedOut);
        assertEq(swapContract.swapNonces(TID), 1);
    }

    function test_swap_tslaToUsdg_creditsCorrectly() public {
        vm.prank(user);
        swapContract.deposit(TID, address(tsla), 10 ether);
        _registerFirst(TID, ownerEoa);

        // 1 TSLA = 250 USDG → priceWad = 250e18
        uint256 priceWad = 250 ether;
        uint256 amountIn = 2 ether;
        uint256 expectedOut = (amountIn * priceWad) / 1e18; // 500 USDG

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h =
            _priceStructHash(TID, address(tsla), address(usdg), amountIn, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        uint256 out = swapContract.swap(
            TID, address(tsla), address(usdg), amountIn, 0, priceWad, priceWad, 0, vu, sig
        );
        assertEq(out, expectedOut);
        assertEq(swapContract.balances(TID, address(usdg)), expectedOut);
    }

    function test_withdraw_permissionless_goesToRegisteredOwner() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);

        uint256 ownerBefore = usdg.balanceOf(ownerEoa);

        // Permissionless: relayer calls but funds go to ownerEoa.
        vm.prank(relayer);
        swapContract.withdraw(TID, address(usdg), 60 ether);

        assertEq(usdg.balanceOf(ownerEoa), ownerBefore + 60 ether);
        assertEq(usdg.balanceOf(relayer), 0);
        assertEq(swapContract.balances(TID, address(usdg)), 40 ether);
    }

    function test_withdrawWithAuth_succeedsForArbitraryTo_andIncrementsNonce() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _withdrawAuthHash(TID, address(usdg), 40 ether, user, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        uint256 before_ = usdg.balanceOf(user);
        vm.prank(relayer);
        swapContract.withdrawWithAuth(TID, address(usdg), 40 ether, user, 0, vu, sig);
        assertEq(usdg.balanceOf(user), before_ + 40 ether);
        assertEq(swapContract.withdrawNonces(TID), 1);
    }

    // =========================================================================
    // Signature / replay / TTL
    // =========================================================================

    function test_swap_replay_revertsNonceMismatch() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);
        _registerFirst(TID, ownerEoa);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.NonceMismatch.selector, uint64(1), uint64(0)));
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_swap_forgedSig_revertsBadSignature() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, mallPk);
        vm.expectRevert(IRhChainSwap.BadSignature.selector);
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_swap_expired_revertsStalePrice() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        vm.warp(vu + 1);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.StalePrice.selector, vu));
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_swap_ttlTooLong_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 301); // exceeds MAX_PRICE_TTL=300
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.TTLTooLong.selector, uint64(301)));
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_swap_priceAboveMax_revertsPriceOutOfBand() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        uint256 priceWad = 4 * 1e15;
        uint256 maxPriceWad = priceWad - 1;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.PriceOutOfBand.selector, priceWad, maxPriceWad));
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, maxPriceWad, priceWad, 0, vu, sig);
    }

    // =========================================================================
    // Owner registration
    // =========================================================================

    function test_registerOwner_secondTimeWithoutExistingSig_reverts() public {
        _registerFirst(TID, ownerEoa);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, otherOwnerEoa, vu);
        bytes memory aSig = _signEip712(h, attestorPk);

        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.OwnerAlreadyRegistered.selector, TID));
        swapContract.registerOwner(TID, otherOwnerEoa, vu, aSig, "");
    }

    function test_registerOwner_secondTimeWithExistingOwnerSig_succeeds() public {
        _registerFirst(TID, ownerEoa);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, otherOwnerEoa, vu);
        bytes memory aSig = _signEip712(h, attestorPk);
        bytes memory oSig = _signEip712(h, ownerPk);
        swapContract.registerOwner(TID, otherOwnerEoa, vu, aSig, oSig);
        assertEq(swapContract.tokenIdOwner(TID), otherOwnerEoa);
    }

    function test_registerOwner_secondTimeWithForgedExistingSig_reverts() public {
        _registerFirst(TID, ownerEoa);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, otherOwnerEoa, vu);
        bytes memory aSig = _signEip712(h, attestorPk);
        bytes memory forgedOSig = _signEip712(h, mallPk);
        vm.expectRevert(IRhChainSwap.BadSignature.selector);
        swapContract.registerOwner(TID, otherOwnerEoa, vu, aSig, forgedOSig);
    }

    function test_registerOwner_forgedAttestor_reverts() public {
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, ownerEoa, vu);
        bytes memory aSig = _signEip712(h, mallPk);
        vm.expectRevert(IRhChainSwap.BadSignature.selector);
        swapContract.registerOwner(TID, ownerEoa, vu, aSig, "");
    }

    function test_registerOwner_expired_reverts() public {
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, ownerEoa, vu);
        bytes memory aSig = _signEip712(h, attestorPk);
        vm.warp(vu + 1);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.StalePrice.selector, vu));
        swapContract.registerOwner(TID, ownerEoa, vu, aSig, "");
    }

    // =========================================================================
    // Withdrawal safety
    // =========================================================================

    function test_withdraw_noOwner_revertsOwnerNotRegistered() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.OwnerNotRegistered.selector, TID));
        swapContract.withdraw(TID, address(usdg), 10 ether);
    }

    function test_withdrawWithAuth_toZero_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _withdrawAuthHash(TID, address(usdg), 10 ether, address(0), 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.InvalidRecipient.selector, address(0)));
        swapContract.withdrawWithAuth(TID, address(usdg), 10 ether, address(0), 0, vu, sig);
    }

    function test_withdrawWithAuth_toContract_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _withdrawAuthHash(TID, address(usdg), 10 ether, address(swapContract), 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(
            abi.encodeWithSelector(IRhChainSwap.InvalidRecipient.selector, address(swapContract))
        );
        swapContract.withdrawWithAuth(TID, address(usdg), 10 ether, address(swapContract), 0, vu, sig);
    }

    function test_withdraw_moreThanBalance_revertsInsufficient() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 10 ether);
        _registerFirst(TID, ownerEoa);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRhChainSwap.InsufficientBalance.selector, TID, address(usdg), uint256(20 ether), uint256(10 ether)
            )
        );
        swapContract.withdraw(TID, address(usdg), 20 ether);
    }

    function test_withdrawWithAuth_replay_revertsNonceMismatch() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _withdrawAuthHash(TID, address(usdg), 10 ether, user, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        swapContract.withdrawWithAuth(TID, address(usdg), 10 ether, user, 0, vu, sig);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.NonceMismatch.selector, uint64(1), uint64(0)));
        swapContract.withdrawWithAuth(TID, address(usdg), 10 ether, user, 0, vu, sig);
    }

    // =========================================================================
    // Revocation
    // =========================================================================

    function test_swap_afterRevoke_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);
        _registerFirst(TID, ownerEoa);

        vm.prank(admin);
        swapContract.revoke(TID);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.Revoked.selector, TID));
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_withdraw_afterRevoke_stillWorks() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);

        vm.prank(admin);
        swapContract.revoke(TID);
        swapContract.withdraw(TID, address(usdg), 100 ether);
        assertEq(swapContract.balances(TID, address(usdg)), 0);
    }

    function test_withdrawWithAuth_afterRevoke_stillWorks() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);

        vm.prank(admin);
        swapContract.revoke(TID);

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _withdrawAuthHash(TID, address(usdg), 50 ether, user, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        swapContract.withdrawWithAuth(TID, address(usdg), 50 ether, user, 0, vu, sig);
    }

    function test_revoke_nonRole_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user, swapContract.REVOKER_ROLE())
        );
        vm.prank(user);
        swapContract.revoke(TID);
    }

    // =========================================================================
    // Pause / emergency
    // =========================================================================

    function test_swap_whenPaused_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        vm.prank(admin);
        swapContract.pause();

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_registerOwner_whenPaused_stillWorks() public {
        // Depositor lands funds, then the contract is paused before they can register.
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);

        vm.prank(admin);
        swapContract.pause();

        // registerOwner is intentionally exempt from `whenNotPaused` so the depositor
        // is never stranded behind a pause (audit M-2 + M-4).
        _registerFirst(TID, ownerEoa);
        assertEq(swapContract.tokenIdOwner(TID), ownerEoa);

        // Withdraw path remains available during pause once owner is registered.
        uint256 before_ = usdg.balanceOf(ownerEoa);
        swapContract.withdraw(TID, address(usdg), 100 ether);
        assertEq(usdg.balanceOf(ownerEoa), before_ + 100 ether);
        assertEq(swapContract.balances(TID, address(usdg)), 0);
    }

    function test_swap_whenPausedAfterRegistration_stillReverts() public {
        // Sanity: registerOwner being pause-exempt must not weaken swap's pause gate.
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);

        vm.prank(admin);
        swapContract.pause();

        _registerFirst(TID, ownerEoa);

        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_withdraw_whenPaused_stillWorks() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);

        vm.prank(admin);
        swapContract.pause();

        swapContract.withdraw(TID, address(usdg), 100 ether);
        assertEq(swapContract.balances(TID, address(usdg)), 0);
    }

    function test_emergencyWithdraw_beforeTimelock_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);

        vm.prank(admin);
        swapContract.pause();

        uint64 unlockAt = uint64(block.timestamp) + TIMELOCK;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.EmergencyTimelockActive.selector, unlockAt));
        swapContract.emergencyWithdraw(TID, address(usdg));
    }

    function test_emergencyWithdraw_afterTimelock_succeeds() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);

        vm.prank(admin);
        swapContract.pause();

        vm.warp(block.timestamp + TIMELOCK + 1);
        uint256 before_ = usdg.balanceOf(ownerEoa);
        vm.prank(admin);
        swapContract.emergencyWithdraw(TID, address(usdg));
        assertEq(usdg.balanceOf(ownerEoa), before_ + 100 ether);
        assertEq(swapContract.balances(TID, address(usdg)), 0);
    }

    function test_emergencyWithdraw_whenNotPaused_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        _registerFirst(TID, ownerEoa);
        vm.prank(admin);
        vm.expectRevert(IRhChainSwap.NotPaused.selector);
        swapContract.emergencyWithdraw(TID, address(usdg));
    }

    function test_emergencyWithdraw_noOwner_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 100 ether);
        vm.prank(admin);
        swapContract.pause();
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.OwnerNotRegistered.selector, TID));
        swapContract.emergencyWithdraw(TID, address(usdg));
    }

    function test_emergencyWithdraw_zeroBalance_reverts() public {
        _registerFirst(TID, ownerEoa);
        vm.prank(admin);
        swapContract.pause();
        vm.warp(block.timestamp + TIMELOCK + 1);
        vm.prank(admin);
        vm.expectRevert(IRhChainSwap.ZeroAmount.selector);
        swapContract.emergencyWithdraw(TID, address(usdg));
    }

    // =========================================================================
    // Slippage / math
    // =========================================================================

    function test_swap_slippageExceeded_reverts() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 1_000 ether);
        _registerFirst(TID, ownerEoa);
        uint256 priceWad = 4 * 1e15;
        uint256 amountIn = 100 ether;
        uint256 computedOut = (amountIn * priceWad) / 1e18;

        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h =
            _priceStructHash(TID, address(usdg), address(tsla), amountIn, computedOut + 1, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(
            abi.encodeWithSelector(IRhChainSwap.SlippageExceeded.selector, computedOut + 1, computedOut)
        );
        swapContract.swap(
            TID, address(usdg), address(tsla), amountIn, computedOut + 1, priceWad, priceWad, 0, vu, sig
        );
    }

    function test_swap_zeroAmountIn_reverts() public {
        uint64 vu = uint64(block.timestamp + 60);
        uint256 priceWad = 4 * 1e15;
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 0, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(IRhChainSwap.ZeroAmount.selector);
        swapContract.swap(TID, address(usdg), address(tsla), 0, 0, priceWad, priceWad, 0, vu, sig);
    }

    function test_swap_sameToken_reverts() public {
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(usdg), 100 ether, 0, 1e18, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(IRhChainSwap.SameToken.selector);
        swapContract.swap(TID, address(usdg), address(usdg), 100 ether, 0, 1e18, 1e18, 0, vu, sig);
    }

    function test_swap_unallowedToken_reverts() public {
        MockERC20 fake = new MockERC20("FAKE", "F", 18);
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(fake), address(usdg), 100 ether, 0, 1e18, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.NotAllowedToken.selector, address(fake)));
        swapContract.swap(TID, address(fake), address(usdg), 100 ether, 0, 1e18, 1e18, 0, vu, sig);
    }

    function test_deposit_unallowedToken_reverts() public {
        MockERC20 fake = new MockERC20("FAKE", "F", 18);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.NotAllowedToken.selector, address(fake)));
        swapContract.deposit(TID, address(fake), 1);
    }

    function test_deposit_zeroAmount_reverts() public {
        vm.expectRevert(IRhChainSwap.ZeroAmount.selector);
        swapContract.deposit(TID, address(usdg), 0);
    }

    function test_swap_insufficientBalance_reverts() public {
        _registerFirst(TID, ownerEoa);
        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        vm.expectRevert(
            abi.encodeWithSelector(
                IRhChainSwap.InsufficientBalance.selector, TID, address(usdg), uint256(100 ether), uint256(0)
            )
        );
        swapContract.swap(TID, address(usdg), address(tsla), 100 ether, 0, priceWad, priceWad, 0, vu, sig);
    }

    // =========================================================================
    // Decimals
    // =========================================================================

    function test_deploy_wrongDecimals_reverts() public {
        MockERC20 weird = new MockERC20("X", "X", 6);
        address[] memory toks = new address[](1);
        toks[0] = address(weird);
        uint8[] memory decs = new uint8[](1);
        decs[0] = 18;
        vm.expectRevert(
            abi.encodeWithSelector(IRhChainSwap.UnexpectedDecimals.selector, address(weird), uint8(18), uint8(6))
        );
        new RhChainSwap(admin, attestorEoa, TIMELOCK, toks, decs);
    }

    function test_constructor_lengthMismatch_reverts() public {
        address[] memory toks = new address[](1);
        toks[0] = address(usdg);
        uint8[] memory decs = new uint8[](2);
        decs[0] = 18;
        decs[1] = 18;
        vm.expectRevert(IRhChainSwap.LengthMismatch.selector);
        new RhChainSwap(admin, attestorEoa, TIMELOCK, toks, decs);
    }

    function test_constructor_zeroAdmin_reverts() public {
        address[] memory toks = new address[](0);
        uint8[] memory decs = new uint8[](0);
        vm.expectRevert();
        new RhChainSwap(address(0), attestorEoa, TIMELOCK, toks, decs);
    }

    function test_constructor_zeroAttestor_reverts() public {
        address[] memory toks = new address[](0);
        uint8[] memory decs = new uint8[](0);
        vm.expectRevert(IRhChainSwap.ZeroAddress.selector);
        new RhChainSwap(admin, address(0), TIMELOCK, toks, decs);
    }

    // =========================================================================
    // Reentrancy
    // =========================================================================

    function test_deposit_reentrant_reverts() public {
        ReentrantToken evil = new ReentrantToken("R", "R", 18);

        // Allowlist the evil token via admin.
        vm.prank(admin);
        swapContract.setAllowedToken(address(evil), true, 18);

        evil.mint(user, 100 ether);
        vm.prank(user);
        evil.approve(address(swapContract), type(uint256).max);

        evil.arm(swapContract, true, false, TID, address(0));

        vm.prank(user);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        swapContract.deposit(TID, address(evil), 10 ether);
    }

    function test_withdraw_reentrant_reverts() public {
        ReentrantToken evil = new ReentrantToken("R", "R", 18);
        vm.prank(admin);
        swapContract.setAllowedToken(address(evil), true, 18);

        evil.mint(user, 100 ether);
        vm.prank(user);
        evil.approve(address(swapContract), type(uint256).max);

        // Arm AFTER deposit so the deposit itself succeeds.
        vm.prank(user);
        swapContract.deposit(TID, address(evil), 10 ether);
        _registerFirst(TID, ownerEoa);

        evil.arm(swapContract, false, true, TID, address(0));
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        swapContract.withdraw(TID, address(evil), 5 ether);
    }

    // =========================================================================
    // Access control
    // =========================================================================

    function test_setAllowedToken_nonAdmin_reverts() public {
        MockERC20 fake = new MockERC20("F", "F", 18);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user, swapContract.TOKEN_MANAGER_ROLE()
            )
        );
        vm.prank(user);
        swapContract.setAllowedToken(address(fake), true, 18);
    }

    function test_rotateAttestor_nonAdmin_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user, swapContract.ATTESTOR_MANAGER_ROLE()
            )
        );
        vm.prank(user);
        swapContract.rotateAttestor(makeAddr("x"));
    }

    function test_rotateAttestor_zeroAddress_reverts() public {
        vm.prank(admin);
        vm.expectRevert(IRhChainSwap.ZeroAddress.selector);
        swapContract.rotateAttestor(address(0));
    }

    function test_rotateAttestor_succeeds_andOldSigsFail() public {
        address newAtt = vm.addr(0xBEEF);
        vm.prank(admin);
        swapContract.rotateAttestor(newAtt);
        assertEq(swapContract.attestor(), newAtt);

        // Old attestor signature must no longer satisfy registerOwner.
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _ownerRegHash(TID, ownerEoa, vu);
        bytes memory oldSig = _signEip712(h, attestorPk);
        vm.expectRevert(IRhChainSwap.BadSignature.selector);
        swapContract.registerOwner(TID, ownerEoa, vu, oldSig, "");
    }

    function test_pause_nonRole_reverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user, swapContract.PAUSER_ROLE()
            )
        );
        vm.prank(user);
        swapContract.pause();
    }

    function test_pause_unpause_clearsPausedAt() public {
        vm.prank(admin);
        swapContract.pause();
        assertEq(swapContract.pausedAt(), uint64(block.timestamp));
        vm.prank(admin);
        swapContract.unpause();
        assertEq(swapContract.pausedAt(), 0);
    }

    function test_setAllowedToken_disable_thenDepositReverts() public {
        vm.prank(admin);
        swapContract.setAllowedToken(address(usdg), false, 18);
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(IRhChainSwap.NotAllowedToken.selector, address(usdg)));
        swapContract.deposit(TID, address(usdg), 1 ether);
    }

    function test_setAllowedToken_zeroAddress_reverts() public {
        vm.prank(admin);
        vm.expectRevert(IRhChainSwap.ZeroAddress.selector);
        swapContract.setAllowedToken(address(0), true, 18);
    }

    // =========================================================================
    // Views and misc
    // =========================================================================

    function test_getPosition_returnsCanonicalOrder() public {
        vm.prank(user);
        swapContract.deposit(TID, address(usdg), 50 ether);
        vm.prank(user);
        swapContract.deposit(TID, address(tsla), 7 ether);
        _registerFirst(TID, ownerEoa);

        IRhChainSwap.Position memory p = swapContract.getPosition(TID);
        assertEq(p.balances.length, 3);
        assertEq(p.balances[0], 50 ether);
        assertEq(p.balances[1], 7 ether);
        assertEq(p.balances[2], 0);
        assertEq(p.owner, ownerEoa);
        assertEq(p.swapNonce, 0);
        assertEq(p.withdrawNonce, 0);
        assertEq(p.revokedAt, 0);
        assertEq(p.paused, false);
    }

    function test_getAllowedTokens_returnsSeededList() public view {
        address[] memory list = swapContract.getAllowedTokens();
        assertEq(list.length, 3);
        assertEq(list[0], address(usdg));
        assertEq(list[1], address(tsla));
        assertEq(list[2], address(amzn));
    }

    function test_domainSeparator_matchesEip712Spec() public view {
        bytes32 typeHash =
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        bytes32 expected = keccak256(
            abi.encode(
                typeHash,
                keccak256(bytes("PrimeAgentRhChainSwap")),
                keccak256(bytes("1")),
                block.chainid,
                address(swapContract)
            )
        );
        assertEq(swapContract.domainSeparator(), expected);
    }

    function test_revoke_isolation_acrossTokenIds() public {
        vm.prank(user);
        swapContract.deposit(1, address(usdg), 100 ether);
        vm.prank(user);
        swapContract.deposit(2, address(usdg), 50 ether);
        _registerFirst(2, ownerEoa);

        vm.prank(admin);
        swapContract.revoke(1);

        // tokenId 2 swap still works
        _registerFirst(1, ownerEoa); // doesn't matter; swap should succeed for tokenId 2
        // wait we already used tokenId 1 register, do tokenId 2 swap:
        uint256 priceWad = 4 * 1e15;
        uint64 vu = uint64(block.timestamp + 60);
        bytes32 h = _priceStructHash(2, address(usdg), address(tsla), 10 ether, 0, priceWad, 0, vu);
        bytes memory sig = _signEip712(h, attestorPk);
        swapContract.swap(2, address(usdg), address(tsla), 10 ether, 0, priceWad, priceWad, 0, vu, sig);
        assertEq(swapContract.swapNonces(2), 1);
        assertEq(swapContract.revokedAt(1), uint64(block.timestamp));
        assertEq(swapContract.revokedAt(2), 0);
    }
}
