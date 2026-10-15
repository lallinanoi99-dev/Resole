// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Testnet stand-in for USDT: 6 decimals, anyone can mint to themselves. Never deploy to mainnet.
contract TestUSDT is ERC20 {
    constructor() ERC20("Test Tether USD", "tUSDT") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint up to 10,000 tUSDT per call to the caller.
    function faucet(uint256 amount) external {
        require(amount <= 10_000 * 1e6, "max 10,000 per call");
        _mint(msg.sender, amount);
    }
}
