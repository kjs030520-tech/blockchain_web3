// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockKRWT
 * @dev 테스트용 원화(KRW) 연동 가상 스테이블코인 (1 KRWT = 1 KRW)
 */
contract MockKRWT is ERC20, Ownable {
    uint8 private constant _DECIMALS = 18;

    constructor() ERC20("Mock Korean Won Tether", "KRWT") Ownable(msg.sender) {
        // 배포자에게 기본 10,000,000 KRWT(1천만 원 상당) 발행
        _mint(msg.sender, 10_000_000 * 10 ** _DECIMALS);
    }

    /**
     * @dev 테스트 시 누구나 무료로 가상 원화를 충전할 수 있는 함수 (Faucet)
     */
    function faucet(address to, uint256 amount) external {
        _mint(to, amount);
    }
}