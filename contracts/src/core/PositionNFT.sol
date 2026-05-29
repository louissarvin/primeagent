// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

contract PositionNFT is ERC721Enumerable, Ownable2Step {
    using Strings for uint256;

    error NotFactory();
    error NotAuthorized();
    error ZeroAddress();
    error TokenDoesNotExist();
    error TbaAlreadyBound();
    error ZeroTba();

    address public factory;
    uint256 public nextTokenId;
    string private _baseTokenURI;

    mapping(uint256 tokenId => address vault) public vaultOf;
    mapping(uint256 tokenId => address tba) public tbaOf;

    event PositionMinted(uint256 indexed tokenId, address indexed to, address vault);
    event PositionBurned(uint256 indexed tokenId);
    event FactorySet(address indexed oldFactory, address indexed newFactory);
    event BaseURISet(string newBaseURI);
    event TbaBound(uint256 indexed tokenId, address indexed tba);

    modifier onlyFactory() {
        if (msg.sender != factory) revert NotFactory();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        address owner_
    )
        ERC721(name_, symbol_)
        Ownable(owner_)
    {
        if (owner_ == address(0)) revert ZeroAddress();
    }

    function mintTo(address to, address vault) external onlyFactory returns (uint256 tokenId) {
        if (to == address(0) || vault == address(0)) revert ZeroAddress();
        unchecked {
            tokenId = nextTokenId++;
        }
        vaultOf[tokenId] = vault;
        emit PositionMinted(tokenId, to, vault);
        _safeMint(to, tokenId);
    }

    function setTba(uint256 tokenId, address tba_) external onlyFactory {
        if (tba_ == address(0)) revert ZeroTba();
        if (tbaOf[tokenId] != address(0)) revert TbaAlreadyBound();
        tbaOf[tokenId] = tba_;
        emit TbaBound(tokenId, tba_);
    }

    function burn(uint256 tokenId) external {
        address holder = _ownerOf(tokenId);
        if (holder == address(0)) revert TokenDoesNotExist();
        if (msg.sender != holder && msg.sender != factory) revert NotAuthorized();
        delete vaultOf[tokenId];
        emit PositionBurned(tokenId);
        _burn(tokenId);
    }

    function setFactory(address newFactory) external onlyOwner {
        if (newFactory == address(0)) revert ZeroAddress();
        emit FactorySet(factory, newFactory);
        factory = newFactory;
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseURISet(newBaseURI);
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        string memory base = _baseTokenURI;
        if (bytes(base).length == 0) return "";
        return string(abi.encodePacked(base, tokenId.toString()));
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    )
        internal
        override(ERC721Enumerable)
        returns (address)
    {
        return super._update(to, tokenId, auth);
    }

    function _increaseBalance(address account, uint128 amount) internal override(ERC721Enumerable) {
        super._increaseBalance(account, amount);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
