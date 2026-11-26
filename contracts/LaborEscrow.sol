// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * @title LaborEscrow
 * @dev 에스크로 급여 예치, OTP 출퇴근 시간 기록, 주휴수당 자동 정산, 온체인 경력 조회를 처리하는 단일 컨트랙트
 */
contract LaborEscrow is ReentrancyGuard {
    IERC20 public immutable paymentToken;

    enum ContractStatus { None, Funded, Completed, Disputed }

    struct ContractInfo {
        // Slot 1 (32 bytes)
        address employer;
        uint40 createdAt;
        uint40 completedAt;
        bool isHolidayPayEligible;
        ContractStatus status;
        // Slot 2 (32 bytes)
        address worker;
        uint64 contractId;
        uint32 accumulatedMinutes;
        // Slot 3 (24 bytes)
        uint96 hourlyWage;
        uint96 totalEscrowFunded;
        // Slot 4 (12 bytes)
        uint96 settledAmount;
        // Slot 5 (32 bytes)
        bytes32 contractHash;
        // Slot 6+
        string jobTitle;
    }

    struct WorkerHistoryView {
        uint256 contractId;
        address employer;
        string jobTitle;
        uint256 totalWorkedHours;
        uint256 totalWorkedMinutes;
        uint256 settledWage;
        uint256 completedDate;
        bytes32 contractHash;
    }

    address public immutable aiSigner;
    mapping(bytes32 => bool) public registeredHashes;
    uint256 public nextContractId = 1;
    mapping(uint256 => ContractInfo) public contracts;
    mapping(address => uint256[]) private workerContracts;

    event ContractFunded(uint256 indexed contractId, address indexed employer, address indexed worker, bytes32 contractHash, string jobTitle, uint256 escrowAmount);
    event HoursRecorded(uint256 indexed contractId, uint256 addedMinutes, uint256 totalMinutes, bool isHolidayPayEligible);
    event WageSettled(uint256 indexed contractId, address indexed worker, uint256 workerPayout, uint256 employerRefund);
    event DisputeRaised(uint256 indexed contractId, string reasonCode);

    constructor(address _paymentToken, address _aiSigner) {
        require(_paymentToken != address(0), "Invalid token address");
        require(_aiSigner != address(0), "Invalid AI signer");
        paymentToken = IERC20(_paymentToken);
        aiSigner = _aiSigner;
    }

    function createAndFundContract(
        address _worker,
        bytes32 _contractHash,
        string calldata _jobTitle,
        uint256 _hourlyWage,
        uint256 _expectedHours,
        bytes calldata _aiSignature
    ) external nonReentrant returns (uint256) {
        require(_worker != address(0), "Worker address cannot be zero");
        require(_worker != msg.sender, "Employer and worker must be different");
        require(_contractHash != bytes32(0), "Invalid contract hash");
        require(_hourlyWage > 0, "Hourly wage must be greater than zero");
        require(_expectedHours > 0, "Expected hours must be greater than zero");
        require(!registeredHashes[_contractHash], "Contract already registered");

        bytes32 payloadHash = keccak256(
            abi.encodePacked(_contractHash, msg.sender, _hourlyWage, _expectedHours)
        );
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(payloadHash);
        require(ECDSA.recover(ethSignedHash, _aiSignature) == aiSigner, "Unverified contract");

        registeredHashes[_contractHash] = true;

        uint256 baseWage = _expectedHours * _hourlyWage;
        uint256 escrowAmount = baseWage + (baseWage / 5); 

        require(
            paymentToken.transferFrom(msg.sender, address(this), escrowAmount),
            "Escrow deposit transfer failed"
        );

        uint256 contractId = nextContractId++;

        require(_hourlyWage <= type(uint96).max, "Wage overflow");
        require(escrowAmount <= type(uint96).max, "Escrow overflow");

        contracts[contractId] = ContractInfo({
            employer: msg.sender,
            createdAt: uint40(block.timestamp),
            completedAt: 0,
            isHolidayPayEligible: false,
            status: ContractStatus.Funded,
            worker: _worker,
            contractId: uint64(contractId),
            accumulatedMinutes: 0,
            hourlyWage: uint96(_hourlyWage),
            totalEscrowFunded: uint96(escrowAmount),
            settledAmount: 0,
            contractHash: _contractHash,
            jobTitle: _jobTitle
        });

        workerContracts[_worker].push(contractId);

        emit ContractFunded(contractId, msg.sender, _worker, _contractHash, _jobTitle, escrowAmount);
        return contractId;
    }

    function recordVerifiedHours(uint256 _contractId, uint256 _minutesToAdd) external {
        ContractInfo storage c = contracts[_contractId];
        require(c.status == ContractStatus.Funded, "Contract is not active");
        require(msg.sender == c.employer || msg.sender == c.worker, "Only parties can record hours");
        require(_minutesToAdd > 0, "Minutes must be positive");

        c.accumulatedMinutes += uint32(_minutesToAdd);

        if (c.accumulatedMinutes >= 900) { // 주 15시간 이상 개근 시
            c.isHolidayPayEligible = true;
        }

        emit HoursRecorded(_contractId, _minutesToAdd, c.accumulatedMinutes, c.isHolidayPayEligible);
    }

    function settleWage(
        uint256 _contractId,
        uint256 _totalMinutes,
        bytes calldata _serverSignature
    ) external nonReentrant {
        ContractInfo storage c = contracts[_contractId];
        require(c.status == ContractStatus.Funded, "Contract is not active");
        require(msg.sender == c.employer || msg.sender == c.worker, "Only parties can trigger settlement");

        // 서버가 확정한 (contractId, totalMinutes) 서명 검증
        bytes32 payloadHash = keccak256(
            abi.encodePacked("SETTLE", _contractId, _totalMinutes)
        );
        bytes32 ethSignedHash = MessageHashUtils.toEthSignedMessageHash(payloadHash);
        require(ECDSA.recover(ethSignedHash, _serverSignature) == aiSigner, "Invalid settlement signature");

        c.accumulatedMinutes = uint32(_totalMinutes);
        c.isHolidayPayEligible = (_totalMinutes >= 900);

        uint256 earnedWage = (_totalMinutes * c.hourlyWage) / 60;
        uint256 holidayPay = c.isHolidayPayEligible ? (earnedWage / 5) : 0;

        uint256 totalWorkerPayout = earnedWage + holidayPay;
        if (totalWorkerPayout > c.totalEscrowFunded) {
            totalWorkerPayout = c.totalEscrowFunded;
        }

        uint256 refundToEmployer = c.totalEscrowFunded - totalWorkerPayout;

        c.settledAmount = uint96(totalWorkerPayout);
        c.completedAt = uint40(block.timestamp);
        c.status = ContractStatus.Completed;

        if (totalWorkerPayout > 0) {
            require(paymentToken.transfer(c.worker, totalWorkerPayout), "Worker payout transfer failed");
        }
        if (refundToEmployer > 0) {
            require(paymentToken.transfer(c.employer, refundToEmployer), "Employer refund transfer failed");
        }

        emit WageSettled(_contractId, c.worker, totalWorkerPayout, refundToEmployer);
    }

    function raiseDispute(uint256 _contractId, string calldata _reasonCode) external {
        ContractInfo storage c = contracts[_contractId];
        require(c.status == ContractStatus.Funded, "Contract not eligible for dispute");
        require(msg.sender == c.employer || msg.sender == c.worker, "Only parties can raise dispute");

        c.status = ContractStatus.Disputed;
        emit DisputeRaised(_contractId, _reasonCode);
    }

    function getWorkerHistory(address _worker) external view returns (WorkerHistoryView[] memory) {
        uint256[] memory cIds = workerContracts[_worker];
        uint256 completedCount = 0;
        for (uint256 i = 0; i < cIds.length; i++) {
            if (contracts[cIds[i]].status == ContractStatus.Completed) {
                completedCount++;
            }
        }

        WorkerHistoryView[] memory history = new WorkerHistoryView[](completedCount);
        uint256 index = 0;
        for (uint256 i = 0; i < cIds.length; i++) {
            ContractInfo storage c = contracts[cIds[i]];
            if (c.status == ContractStatus.Completed) {
                history[index] = WorkerHistoryView({
                    contractId: c.contractId,
                    employer: c.employer,
                    jobTitle: c.jobTitle,
                    totalWorkedHours: c.accumulatedMinutes / 60,
                    totalWorkedMinutes: c.accumulatedMinutes,
                    settledWage: c.settledAmount,
                    completedDate: c.completedAt,
                    contractHash: c.contractHash
                });
                index++;
            }
        }
        return history;
    }

    function getContract(uint256 _contractId) external view returns (ContractInfo memory) {
        return contracts[_contractId];
    }
}