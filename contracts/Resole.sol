// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Resole — peer-to-peer second-hand shoes and apparel on BOT Chain
/// @notice Sellers list items at their own price in BOT or USDT; buyers pay the seller directly.
///         Listings are permanent: there is no edit, delete, unlist or re-price function.
///         The contract never holds funds, takes no fee and has no owner.
contract Resole is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Currency { BOT, USDT }
    enum Kind { Shoes, Apparel }

    struct Profile {
        bool exists;
        string name;
        string contact;
    }

    struct Item {
        address seller;
        string title;
        Kind kind;
        string size;
        uint8 condition; // 0 New · 1 Like new · 2 Good · 3 Worn
        string[] photos; // IPFS CIDs
        string description;
        Currency currency;
        uint256 price; // in wei for BOT, in token units for USDT
        address buyer; // zero until sold
        uint64 listedAt;
        uint64 soldAt;
    }

    uint256 public constant MAX_NAME = 32;
    uint256 public constant MAX_CONTACT = 64;
    uint256 public constant MAX_TITLE = 80;
    uint256 public constant MAX_SIZE = 16;
    uint256 public constant MAX_DESCRIPTION = 500;
    uint256 public constant MAX_CID = 100;
    uint256 public constant MAX_PHOTOS = 3;
    uint8 public constant CONDITIONS = 4;

    IERC20 public immutable usdt;
    mapping(address => Profile) public profiles;

    Item[] private _items;
    mapping(address => uint256[]) private _itemsOf;
    mapping(address => uint256[]) private _purchasesOf;

    event ProfileSet(address indexed user, string name);
    event Listed(uint256 indexed id, address indexed seller, Currency currency, uint256 price);
    event Sold(uint256 indexed id, address indexed buyer, address indexed seller, Currency currency, uint256 price);

    error EmptyName();
    error TextTooLong();
    error NoProfile();
    error EmptyTitle();
    error EmptySize();
    error BadCondition();
    error BadPhotoCount();
    error EmptyPhoto();
    error ZeroPrice();
    error UsdtDisabled();
    error ItemNotFound();
    error AlreadySold();
    error OwnItem();
    error WrongAmount();
    error PaymentFailed();

    /// @param usdtToken USDT token on this chain, or address(0) to run BOT-only.
    constructor(IERC20 usdtToken) {
        usdt = usdtToken;
    }

    // ------------------------------------------------------------------
    // Profiles
    // ------------------------------------------------------------------

    /// @notice Create or update your own profile. Old listings keep working after an update.
    function setProfile(string calldata name, string calldata contact) external {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(name).length > MAX_NAME || bytes(contact).length > MAX_CONTACT) revert TextTooLong();
        profiles[msg.sender] = Profile(true, name, contact);
        emit ProfileSet(msg.sender, name);
    }

    // ------------------------------------------------------------------
    // Listing
    // ------------------------------------------------------------------

    function list(
        string calldata title,
        Kind kind,
        string calldata size,
        uint8 condition,
        string[] calldata photos,
        string calldata description,
        Currency currency,
        uint256 price
    ) external returns (uint256 id) {
        if (!profiles[msg.sender].exists) revert NoProfile();
        if (bytes(title).length == 0) revert EmptyTitle();
        if (bytes(size).length == 0) revert EmptySize();
        if (bytes(title).length > MAX_TITLE || bytes(size).length > MAX_SIZE || bytes(description).length > MAX_DESCRIPTION) {
            revert TextTooLong();
        }
        if (condition >= CONDITIONS) revert BadCondition();
        if (photos.length == 0 || photos.length > MAX_PHOTOS) revert BadPhotoCount();
        for (uint256 i; i < photos.length; ++i) {
            if (bytes(photos[i]).length == 0) revert EmptyPhoto();
            if (bytes(photos[i]).length > MAX_CID) revert TextTooLong();
        }
        if (price == 0) revert ZeroPrice();
        if (currency == Currency.USDT && address(usdt) == address(0)) revert UsdtDisabled();

        id = _items.length;
        Item storage item = _items.push();
        item.seller = msg.sender;
        item.title = title;
        item.kind = kind;
        item.size = size;
        item.condition = condition;
        for (uint256 i; i < photos.length; ++i) item.photos.push(photos[i]);
        item.description = description;
        item.currency = currency;
        item.price = price;
        item.listedAt = uint64(block.timestamp);
        _itemsOf[msg.sender].push(id);

        emit Listed(id, msg.sender, currency, price);
    }

    // ------------------------------------------------------------------
    // Buying
    // ------------------------------------------------------------------

    /// @notice Buy an item. BOT items: send exactly `price` as value.
    ///         USDT items: approve this contract for `price` first and send no value.
    ///         Payment goes straight to the seller; the item is marked sold before money moves.
    function buy(uint256 id) external payable nonReentrant {
        if (id >= _items.length) revert ItemNotFound();
        if (!profiles[msg.sender].exists) revert NoProfile();
        Item storage item = _items[id];
        if (item.buyer != address(0)) revert AlreadySold();
        if (item.seller == msg.sender) revert OwnItem();

        item.buyer = msg.sender;
        item.soldAt = uint64(block.timestamp);
        _purchasesOf[msg.sender].push(id);

        address seller = item.seller;
        uint256 price = item.price;
        if (item.currency == Currency.BOT) {
            if (msg.value != price) revert WrongAmount();
            (bool ok, ) = payable(seller).call{value: price}("");
            if (!ok) revert PaymentFailed();
        } else {
            if (msg.value != 0) revert WrongAmount();
            usdt.safeTransferFrom(msg.sender, seller, price);
        }

        emit Sold(id, msg.sender, seller, item.currency, price);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getItem(uint256 id) external view returns (Item memory) {
        if (id >= _items.length) revert ItemNotFound();
        return _items[id];
    }

    /// @notice Up to `count` items starting at `start`, for paging through the shop.
    function getItems(uint256 start, uint256 count) external view returns (Item[] memory page) {
        uint256 total_ = _items.length;
        uint256 end = start >= total_ ? start : (count > total_ - start ? total_ : start + count);
        page = new Item[](end - start);
        for (uint256 i = start; i < end; ++i) page[i - start] = _items[i];
    }

    function total() external view returns (uint256) {
        return _items.length;
    }

    function itemsOf(address seller) external view returns (uint256[] memory) {
        return _itemsOf[seller];
    }

    function purchasesOf(address buyer) external view returns (uint256[] memory) {
        return _purchasesOf[buyer];
    }
}
