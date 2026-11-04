const hre = require("hardhat");

async function main() {
  console.log("=========================================");
  console.log("WorkChain 스마트 컨트랙트 로컬 배포 시작...");
  console.log("=========================================");

  const [deployer] = await hre.ethers.getSigners();
  console.log("배포자(고용주) 테스트 계정 주소:", deployer.address);

  // 1. MockKRWT (가상 원화 토큰) 배포
  const MockKRWT = await hre.ethers.getContractFactory("MockKRWT");
  const krwt = await MockKRWT.deploy();
  await krwt.waitForDeployment();
  const krwtAddress = await krwt.getAddress();
  console.log("✓ MockKRWT 배포 완료:", krwtAddress);

  // 2. LaborEscrow (에스크로 & 온체인 이력 컨트랙트) 배포
  const LaborEscrow = await hre.ethers.getContractFactory("LaborEscrow");
  const escrow = await LaborEscrow.deploy(krwtAddress);
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("✓ LaborEscrow 배포 완료:", escrowAddress);

  console.log("=========================================");
  console.log("배포 성공! 주소 복사 (프론트엔드 연동용):");
  console.log(`NEXT_PUBLIC_KRWT_ADDRESS="${krwtAddress}"`);
  console.log(`NEXT_PUBLIC_ESCROW_ADDRESS="${escrowAddress}"`);
  console.log("=========================================");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});