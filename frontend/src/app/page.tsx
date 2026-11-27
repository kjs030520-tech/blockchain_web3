"use client";

import React, { useState, useEffect } from "react";
import { ethers } from "ethers";
import { 
  ShieldCheck, 
  Clock, 
  Coins, 
  FileText, 
  CheckCircle2, 
  KeyRound, 
  Award, 
  TrendingUp, 
  Sparkles, 
  X, 
  AlertTriangle,
  Upload
} from "lucide-react";

// 스마트 컨트랙트 ABI 인라인 선언
const KRWT_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function faucet(address to, uint256 amount)"
];

const ESCROW_ABI = [
  "function createAndFundContract(address _worker, bytes32 _contractHash, string _jobTitle, uint256 _hourlyWage, uint256 _expectedHours, bytes _aiSignature) returns (uint256)",
  "function recordVerifiedHours(uint256 _contractId, uint256 _minutesToAdd)",
  "function settleWage(uint256 _contractId, uint256 _totalMinutes, bytes _serverSignature)",
  "function getWorkerHistory(address _worker) view returns (tuple(uint256 contractId, address employer, string jobTitle, uint256 totalWorkedHours, uint256 totalWorkedMinutes, uint256 settledWage, uint256 completedDate, bytes32 contractHash)[])",
  "function getContract(uint256 _contractId) view returns (tuple(address employer, uint40 createdAt, uint40 completedAt, bool isHolidayPayEligible, uint8 status, address worker, uint64 contractId, uint32 accumulatedMinutes, uint96 hourlyWage, uint96 totalEscrowFunded, uint96 settledAmount, bytes32 contractHash, string jobTitle))",
  "function nextContractId() view returns (uint256)"
];

const KRWT_ADDR = process.env.NEXT_PUBLIC_KRWT_ADDRESS || "";
const ESCROW_ADDR = process.env.NEXT_PUBLIC_ESCROW_ADDRESS || "";

interface ToxicClause {
  detectedText: string;
  lawReference: string;
  explanation: string;
  recommendation: string;
}

interface ScanResult {
  riskScore: number;
  riskLevel: "위험" | "경고" | "안전";
  summary: string;
  toxicClauses: ToxicClause[];
}

export default function WorkChainHome() {
  const [account, setAccount] = useState<string>("");
  const [balance, setBalance] = useState<string>("0");
  const [activeTab, setActiveTab] = useState<"employer" | "worker">("employer");

  // 고용주 폼 상태
  const [workerAddr, setWorkerAddr] = useState("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
  const [jobTitle, setJobTitle] = useState("카페 바리스타");
  const [hourlyWage, setHourlyWage] = useState("10030");
  const [expectedHours, setExpectedHours] = useState("16");
  const [generatedOtp, setGeneratedOtp] = useState<string | null>(null);
  const [activeCheckInAt, setActiveCheckInAt] = useState<string | null>(null);
  const [contractIdInput, setContractIdInput] = useState("1");
  const [pdfFileName, setPdfFileName] = useState("");
  const [isVerifyingPdf, setIsVerifyingPdf] = useState(false);
  const [verifiedContract, setVerifiedContract] = useState<{
    approved: boolean;
    contractHash: string;
    signature?: string;
    analysis: {
      isCompliant: boolean;
      jobTitle: string;
      hourlyWage: number;
      expectedHours: number;
      violations: string[];
      summary: string;
    };
  } | null>(null);

  // 실시간 계약 상태 정보
  const [activeContractInfo, setActiveContractInfo] = useState<any>(null);
  const [offchainMinutes, setOffchainMinutes] = useState<number>(0);

  // 근로자 상태
  const [inputOtp, setInputOtp] = useState("");
  const [workerHistory, setWorkerHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // AI 스캐너 모달 및 상태
  const [isScannerOpen, setIsScannerOpen] = useState(false);
  const [contractInputText, setContractInputText] = useState("");
  const [isScanning, setIsScanning] = useState(false);
  const [scanResult, setScanResult] = useState<ScanResult | null>(null);

  // 지갑 연결
  const connectWallet = async () => {
    if (typeof window !== "undefined" && (window as any).ethereum) {
      try {
        const provider = new ethers.BrowserProvider((window as any).ethereum);
        const accounts = await provider.send("eth_requestAccounts", []);
        setAccount(accounts[0]);
        loadBalance(accounts[0], provider);
        fetchContractDetails(contractIdInput, provider);
      } catch (err: any) {
        alert("지갑 연결 실패: " + err.message);
      }
    } else {
      alert("메타마스크를 설치해 주세요!");
    }
  };

  useEffect(() => {
    if (typeof window === "undefined" || !(window as any).ethereum) return;
    const eth = (window as any).ethereum;

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length > 0) {
        const nextAcc = accounts[0];
        setAccount(nextAcc);
        const provider = new ethers.BrowserProvider(eth);
        loadBalance(nextAcc, provider);
        fetchContractDetails(contractIdInput, provider);
      } else {
        setAccount("");
        setBalance("0");
      }
    };

    eth.on("accountsChanged", handleAccountsChanged);
    return () => {
      eth.removeListener("accountsChanged", handleAccountsChanged);
    };
  }, [contractIdInput]);

  // 버튼으로 메타마스크 계정 선택창 다시 띄우기
  const switchWallet = async () => {
    if (typeof window === "undefined" || !(window as any).ethereum) return;
    try {
      const eth = (window as any).ethereum;
      await eth.request({
        method: "wallet_requestPermissions",
        params: [{ eth_accounts: {} }],
      });
      await connectWallet();
    } catch (err: any) {
      console.error("계정 전환 취소:", err);
    }
  };
  // KRWT 잔고 조회
  const loadBalance = async (userAddr: string, provider: any) => {
    try {
      const tokenContract = new ethers.Contract(KRWT_ADDR, KRWT_ABI, provider);
      const bal = await tokenContract.balanceOf(userAddr);
      setBalance(ethers.formatEther(bal));
    } catch (e) {
      console.error(e);
    }
  };

  // 진행 중인 계약 실시간 누적 근무 시간 조회
  const fetchContractDetails = async (cId: string, currentProvider?: any) => {
    try {
      // 1) 오프체인 누적 근무시간 조회
      const logRes = await fetch(`/api/work-logs?contractId=${cId}`);
      const logData = logRes.ok ? await logRes.json() : { totalMinutes: 0 };
      const currentOffchain = Number(logData.totalMinutes || 0);
      setOffchainMinutes(currentOffchain);
      setActiveCheckInAt(logData.activeCheckInAt || null);

      if (typeof window === "undefined" || !(window as any).ethereum) return;
      const provider = currentProvider || new ethers.BrowserProvider((window as any).ethereum);
      const escrowContract = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, provider);
      const c = await escrowContract.getContract(cId);

      // ES2020 호환 및 안전한 BigInt 변환
      if (c && Number(c.contractId) > 0) {
        const statusNum = Number(c.status);
        setActiveContractInfo({
          contractId: Number(c.contractId),
          jobTitle: c.jobTitle,
          hourlyWage: c.hourlyWage,
          // 정산 전(1)이면 오프체인 누적 분, 정산 완료(2)면 온체인 확정 분 표시
          accumulatedMinutes: statusNum === 2 ? Number(c.accumulatedMinutes) : currentOffchain,
          isHolidayPayEligible: statusNum === 2 ? c.isHolidayPayEligible : currentOffchain >= 900,
          status: statusNum,
          employer: c.employer,
          worker: c.worker,
        });
      }
    } catch (e) {
      console.error("계약 정보 조회 실패:", e);
    }
  };
  // 무료 테스트 원화 토큰 받기 (Faucet)
  const handleFaucet = async () => {
    if (!account) return alert("지갑을 먼저 연결하세요.");
    setLoading(true);
    setStatusMsg("테스트용 1,000,000 KRWT 충전 중...");
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const tokenContract = new ethers.Contract(KRWT_ADDR, KRWT_ABI, signer);
      const tx = await tokenContract.faucet(account, ethers.parseEther("1000000"));
      await tx.wait();
      setStatusMsg("✓ 1,000,000 KRWT 충전 완료!");
      loadBalance(account, provider);
    } catch (err: any) {
      setStatusMsg("충전 실패: " + err.message);
    } finally {
      setLoading(false);
    }
  };
  // 157행(handleFaucet 닫는 괄호) 아래에 추가
  // 0. PDF 근로계약서 AI 검증 및 전자서명 발급
  const handleVerifyPdf = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!account) {
      alert("지갑을 먼저 연결해 주세요. (서명에 고용주 지갑 주소가 필요합니다)");
      e.target.value = "";
      return;
    }

    setPdfFileName(file.name);
    setIsVerifyingPdf(true);
    setVerifiedContract(null);
    setStatusMsg("AI가 PDF 근로계약서의 근로기준법 준수 여부를 분석 중입니다...");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("employerAddress", account);

      const res = await fetch("/api/verify-contract", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "PDF 검증 요청 실패");
      }

      setVerifiedContract(data);

      if (data.approved) {
        // AI가 추출한 직무명, 시급, 예상 근무시간을 폼에 자동 반영
        setJobTitle(data.analysis.jobTitle);
        setHourlyWage(String(data.analysis.hourlyWage));
        setExpectedHours(String(data.analysis.expectedHours));
        setStatusMsg("✓ AI 근로기준법 검증 통과! 전자서명이 발급되었습니다.");
      } else {
        setStatusMsg("⚠️ 근로기준법 위반 또는 불명확한 조항이 있어 온체인 등록이 차단되었습니다.");
      }
    } catch (err: any) {
      alert("PDF 분석 오류: " + err.message);
      setStatusMsg("PDF 분석 실패: " + err.message);
    } finally {
      setIsVerifyingPdf(false);
    }
  };

  // 1. 고용주: 계약 등록 및 에스크로 예치
  // 1. 고용주: AI 검증 완료된 계약 등록 및 에스크로 예치
  const handleCreateContract = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return alert("지갑을 연결하세요.");
    if (!verifiedContract?.approved || !verifiedContract.signature) {
      return alert("먼저 적법한 PDF 근로계약서를 업로드해 AI 검증을 통과해야 합니다.");
    }

    setLoading(true);
    setStatusMsg("에스크로 계약 승인 및 토큰 예치 진행 중...");
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();

      const wageWei = ethers.parseEther(hourlyWage);
      const baseWage = BigInt(expectedHours) * wageWei;
      const escrowTotal = baseWage + (baseWage / BigInt(5));

      const tokenContract = new ethers.Contract(KRWT_ADDR, KRWT_ABI, signer);
      const escrowContract = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, signer);

      const approveTx = await tokenContract.approve(ESCROW_ADDR, escrowTotal);
      await approveTx.wait();

      const tx = await escrowContract.createAndFundContract(
        workerAddr,
        verifiedContract.contractHash,
        jobTitle,
        wageWei,
        expectedHours,
        verifiedContract.signature
      );
      await tx.wait();

      setStatusMsg("✓ 스마트 컨트랙트 에스크로 예치 성공! (계약 활성화됨)");
      loadBalance(account, provider);
      fetchContractDetails(contractIdInput, provider);
    } catch (err: any) {
      setStatusMsg("계약 생성 실패: " + (err.reason || err.message));
    } finally {
      setLoading(false);
    }
  };

  // 2. 고용주: 6자리 OTP 출퇴근 번호 발급
  // 2. 고용주: 서버에서 1회용 6자리 OTP 발급
  // 2. 고용주: 서버에서 1회용 6자리 OTP 발급 (출근/퇴근 공용)
const handleGenerateOtp = async () => {
  try {
    const res = await fetch("/api/work-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "issue_otp",
        contractId: contractIdInput,
      }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data.error || "OTP 발급 실패");

    setGeneratedOtp(data.code);
    setStatusMsg(`✓ 매장용 1회용 6자리 OTP [${data.code}] 생성됨 (3분 유효)`);
  } catch (err: any) {
    alert("OTP 발급 오류: " + err.message);
  }
};
//시연용 버튼 추가
const handleDemoRewind = async () => {
  setLoading(true);
  try {
    const res = await fetch("/api/work-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "demo_rewind_checkin",
        contractId: contractIdInput,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "시연 시간 설정 실패");

    setStatusMsg("🧪 [시연용] 출근 시각을 16시간 전으로 설정했습니다. 이제 퇴근 OTP를 입력하세요!");
    await fetchContractDetails(contractIdInput);
  } catch (err: any) {
    alert(err.message);
  } finally {
    setLoading(false);
  }
};

  // 3. 근로자: 오프체인 1회용 OTP 인증 (가스비 0원)
  const handleVerifyOtp = async () => {
  if (!account) return alert("지갑을 연결하세요.");
  if (!inputOtp || inputOtp.length !== 6) return alert("6자리 번호를 정확히 입력하세요.");

  setLoading(true);
  setStatusMsg("OTP 인증 확인 중...");
  try {
    const res = await fetch("/api/work-logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "verify_otp",
        contractId: contractIdInput,
        otpCode: inputOtp,
      }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "OTP 인증에 실패했습니다.");
    }

    // 👇 바로 이 자리 (서버에서 data를 받아온 뒤!)
    if (data.status === "checked_in") {
      setStatusMsg(
        `✓ 출근 인증 완료! (${new Date(data.checkInAt).toLocaleTimeString("ko-KR")} 시작 · 퇴근 시 새 OTP를 입력하세요)`
      );
    } else {
      setStatusMsg(
        `✓ 퇴근 인증 완료! (+${data.addedMinutes}분 자동 계산 누적, 총 ${data.totalMinutes}분)`
      );
    }

    setInputOtp("");
    await fetchContractDetails(contractIdInput);
  } catch (err: any) {
    alert("출퇴근 기록 실패: " + err.message);
    setStatusMsg("인증 실패: " + err.message);
  } finally {
    setLoading(false);
  }
};

  // 4. 최종 급여 일괄 정산 (서버 서명 발급 -> 온체인 1회 실행)
  const handleSettleWage = async () => {
    if (!account) return alert("지갑을 연결하세요.");
    setLoading(true);
    setStatusMsg("서버 정산 서명 발급 및 온체인 일괄 정산 실행 중...");
    try {
      const prepRes = await fetch("/api/work-logs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare_settle", contractId: contractIdInput }),
      });
      const prepData = await prepRes.json();
      if (!prepRes.ok) throw new Error(prepData.error);

      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const signer = await provider.getSigner();
      const escrowContract = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, signer);

      const tx = await escrowContract.settleWage(
        contractIdInput,
        prepData.totalMinutes,
        prepData.signature
      );
      await tx.wait();

      setStatusMsg("✓ 일괄 정산 완료! 급여 이체 및 잔여금 환급이 끝났습니다.");
      loadBalance(account, provider);
      fetchContractDetails(contractIdInput, provider);
      handleFetchHistory();
    } catch (err: any) {
      alert("정산 실패: " + (err.reason || err.message));
      setStatusMsg("정산 실패: " + (err.reason || err.message));
    } finally {
      setLoading(false);
    }
  };

  // 5. 근로자: 온체인 근무 이력 직접 조회 (View 함수)
  const handleFetchHistory = async () => {
    if (!account) return alert("지갑을 연결하세요.");
    try {
      const provider = new ethers.BrowserProvider((window as any).ethereum);
      const escrowContract = new ethers.Contract(ESCROW_ADDR, ESCROW_ABI, provider);
      const history = await escrowContract.getWorkerHistory(account);
      setWorkerHistory(history);
      setStatusMsg(`✓ 온체인 이력 ${history.length}건 조회 완료`);
    } catch (err: any) {
      console.error(err);
      setStatusMsg("조회 실패: " + err.message);
    }
  };

  // 6. AI 근로계약서 진단 실행
  const handleRunAiScan = async () => {
    if (!contractInputText.trim()) return alert("계약서 본문 조항을 입력하거나 샘플을 불러오세요.");
    setIsScanning(true);
    try {
      const res = await fetch("/api/analyze-contract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contractText: contractInputText }),
      });
      const data = await res.json();
      setScanResult(data);
    } catch (err: any) {
      alert("AI 진단 중 오류가 발생했습니다: " + err.message);
    } finally {
      setIsScanning(false);
    }
  };

  // 불공정 시연용 샘플 텍스트 로드
  const loadSampleContract = () => {
    setContractInputText(
`[단기 아르바이트 근로계약서 (예시)]
1. 근무지: 알바체인 카페 강남점
2. 약정시급: 10,030원
3. 근무조건: 주 4일, 일 4시간 근무 (주 16시간)
4. 특약사항:
 - 제4조 1항: 근로자가 무단 퇴사하거나 30일 전에 미리 통보하지 않고 퇴사할 경우, 당월 급여의 50%를 위약금 명목으로 공제한다.
 - 제4조 2항: 단기 파트타임 근무이므로 주 15시간 이상 근무하더라도 주휴수당은 시급에 포함된 것으로 간주하여 별도 지급하지 않는다.`
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 p-6 max-w-5xl mx-auto">
      {/* 헤더 */}
      <header className="flex justify-between items-center pb-6 border-b border-slate-200">
        <div>
          <h1 className="text-2xl font-black text-blue-900 flex items-center gap-2">
            <ShieldCheck className="text-blue-600 w-8 h-8" /> WorkChain (알바체인)
          </h1>
          <p className="text-sm text-slate-500 mt-1">스마트 컨트랙트 에스크로 & 6자리 OTP 안심 정산 플랫폼</p>
        </div>
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsScannerOpen(true)}
            className="flex items-center gap-1.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white text-xs font-bold px-3.5 py-2 rounded-lg shadow-sm"
          >
            <Sparkles className="w-4 h-4" /> AI 계약서 진단기
          </button>
          {account ? (
            <div className="flex items-center gap-2">
              <div className="text-right">
                <span className="text-xs bg-blue-100 text-blue-800 px-3 py-1 rounded-full font-mono">
                  {account.slice(0, 6)}...{account.slice(-4)}
                </span>
                <p className="text-xs text-slate-600 mt-1 font-semibold">{Number(balance).toLocaleString()} KRWT</p>
              </div>
              <button
                onClick={switchWallet}
                className="bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs px-2.5 py-2 rounded-lg font-semibold"
              >
                계정 전환
              </button>
            </div>
          ) : (
            <button onClick={connectWallet} className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow">
              메타마스크 지갑 연결
            </button>
          )}
          <button onClick={handleFaucet} className="bg-slate-200 hover:bg-slate-300 text-slate-700 text-xs px-3 py-2 rounded-lg font-medium">
            + 테스트 KRWT 충전
          </button>
        </div>
      </header>

      {/* 상태 알림창 */}
      {statusMsg && (
        <div className="my-4 p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded-lg text-sm flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-blue-600 flex-shrink-0" />
          <span>{statusMsg}</span>
        </div>
      )}

      {/* 탭 네비게이션 */}
      <div className="flex gap-4 my-6">
        <button
          onClick={() => setActiveTab("employer")}
          className={`flex-1 py-3 font-bold rounded-xl border text-center transition ${
            activeTab === "employer" ? "bg-blue-900 text-white border-blue-900 shadow-md" : "bg-white text-slate-600 border-slate-200"
          }`}
        >
          고용주 대시보드 (계약 생성 & OTP 발급)
        </button>
        <button
          onClick={() => setActiveTab("worker")}
          className={`flex-1 py-3 font-bold rounded-xl border text-center transition ${
            activeTab === "worker" ? "bg-blue-900 text-white border-blue-900 shadow-md" : "bg-white text-slate-600 border-slate-200"
          }`}
        >
          근로자 대시보드 (OTP 출퇴근 & 온체인 이력 조회)
        </button>
      </div>

      {/* 실시간 온체인 근무 시간 & 주휴수당 게이지 카드 */}
      <div className="mb-6 p-5 bg-white border border-blue-100 rounded-2xl shadow-sm">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="text-blue-600 w-5 h-5" />
            <h3 className="font-bold text-slate-800 text-sm">
              계약 #{contractIdInput} 실시간 온체인 근무 시간 현황
            </h3>
          </div>
          <button
            onClick={() => fetchContractDetails(contractIdInput)}
            className="text-xs text-blue-600 hover:underline font-semibold"
          >
            새로고침
          </button>
        </div>

        {activeContractInfo ? (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 text-center">
              <div className="p-3 bg-slate-50 rounded-xl">
                <p className="text-xs text-slate-400">누적 근무 시간</p>
                <p className="text-lg font-black text-blue-900 mt-1">
                  {Math.floor(activeContractInfo.accumulatedMinutes / 60)}시간 {activeContractInfo.accumulatedMinutes % 60}분
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <p className="text-xs text-slate-400">주휴수당 충족 (주 15h)</p>
                <p className={`text-sm font-bold mt-1.5 ${activeContractInfo.isHolidayPayEligible ? "text-emerald-600" : "text-amber-500"}`}>
                  {activeContractInfo.isHolidayPayEligible ? "✓ 달성 완료 (+20%)" : `${Math.max(0, 15 - Math.floor(activeContractInfo.accumulatedMinutes / 60))}시간 부족`}
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <p className="text-xs text-slate-400">실시간 누적 급여</p>
                <p className="text-lg font-black text-emerald-600 mt-1 font-mono">
                  {Math.floor((Number(activeContractInfo.accumulatedMinutes) * Number(ethers.formatEther(activeContractInfo.hourlyWage))) / 60).toLocaleString()} KRWT
                </p>
              </div>
              <div className="p-3 bg-slate-50 rounded-xl">
                <p className="text-xs text-slate-400">계약 상태</p>
                <p className="text-sm font-bold mt-1.5 text-slate-700">
                  {activeContractInfo.status === 1 ? "🟢 예치 완료 (근무 중)" : activeContractInfo.status === 2 ? "🏁 정산 완료" : "대기"}
                </p>
              </div>
            </div>

            {/* 주휴수당 프로그레스 바 */}
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1">
                <span>주휴수당 달성률 (목표: 900분 / 15시간)</span>
                <span className="font-bold text-blue-900">
                  {Math.min(100, Math.floor((activeContractInfo.accumulatedMinutes / 900) * 100))}%
                </span>
              </div>
              <div className="w-full bg-slate-100 rounded-full h-3 overflow-hidden">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all duration-500"
                  style={{ width: `${Math.min(100, (activeContractInfo.accumulatedMinutes / 900) * 100)}%` }}
                ></div>
              </div>
            </div>
          </div>
        ) : (
          <div className="py-4 text-center text-xs text-slate-400">
            계약 정보를 불러오는 중입니다... 위의 [새로고침]을 눌러보세요.
          </div>
        )}
      </div>

      {/* 고용주 뷰 */}
      {activeTab === "employer" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* 계약 생성 카드 */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-4">
              <FileText className="text-blue-600" /> 신규 근로계약 등록 & 에스크로 예치
            </h2>
            <form onSubmit={handleCreateContract} className="space-y-4 text-sm">
              {/* PDF 업로드 & AI 검증 영역 */}
              <div className="p-3.5 bg-slate-50 border-2 border-dashed border-slate-300 rounded-xl">
                <label className="block text-xs font-bold text-slate-700 mb-2">
                  1단계: PDF 근로계약서 AI 규정 검증 (필수)
                </label>
                <label className="flex items-center justify-center gap-2 w-full py-2.5 px-3 bg-white border border-slate-300 rounded-lg cursor-pointer hover:bg-slate-100 transition text-xs font-semibold text-slate-700">
                  <Upload className="w-4 h-4 text-blue-600" />
                  <span>{isVerifyingPdf ? "AI가 PDF를 분석 중입니다..." : pdfFileName || "PDF 계약서 파일 선택"}</span>
                  <input
                    type="file"
                    accept="application/pdf"
                    onChange={handleVerifyPdf}
                    disabled={isVerifyingPdf}
                    className="hidden"
                  />
                </label>

                {verifiedContract && (
                  <div
                    className={`mt-3 p-3 rounded-lg text-xs border ${
                      verifiedContract.approved
                        ? "bg-emerald-50 border-emerald-200 text-emerald-900"
                        : "bg-red-50 border-red-200 text-red-900"
                    }`}
                  >
                    <p className="font-bold">
                      {verifiedContract.approved
                        ? "✓ 근로기준법 준수 확인 (전자서명 발급 완료)"
                        : "⛔ 근로기준법 위반 감지 (블록체인 등록 차단)"}
                    </p>
                    <p className="mt-1">{verifiedContract.analysis.summary}</p>
                    {verifiedContract.analysis.violations?.length > 0 && (
                      <ul className="mt-1.5 list-disc list-inside space-y-0.5 text-red-700">
                        {verifiedContract.analysis.violations.map((v, i) => (
                          <li key={i}>{v}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>

              <div>
                <label className="block text-slate-600 mb-1">근로자 지갑 주소</label>
                <input
                  type="text"
                  placeholder="0x..."
                  value={workerAddr}
                  onChange={(e) => setWorkerAddr(e.target.value)}
                  className="w-full p-2.5 border rounded-lg font-mono text-xs"
                  required
                />
              </div>
              <div>
                <label className="block text-slate-600 mb-1">직무명 (AI 자동 추출)</label>
                <input
                  type="text"
                  value={jobTitle}
                  readOnly={!!verifiedContract?.approved}
                  onChange={(e) => setJobTitle(e.target.value)}
                  className="w-full p-2.5 border rounded-lg bg-slate-50"
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-600 mb-1">약정 시급 (KRWT)</label>
                  <input
                    type="number"
                    value={hourlyWage}
                    readOnly={!!verifiedContract?.approved}
                    onChange={(e) => setHourlyWage(e.target.value)}
                    className="w-full p-2.5 border rounded-lg font-semibold bg-slate-50"
                    required
                  />
                </div>
                <div>
                  <label className="block text-slate-600 mb-1">예상 근무시간 (h)</label>
                  <input
                    type="number"
                    value={expectedHours}
                    readOnly={!!verifiedContract?.approved}
                    onChange={(e) => setExpectedHours(e.target.value)}
                    className="w-full p-2.5 border rounded-lg font-semibold bg-slate-50"
                    required
                  />
                </div>
              </div>
              <div className="p-3 bg-slate-50 rounded-lg text-xs text-slate-500">
                💡 총 예치 필요액: 약 {(Number(hourlyWage) * Number(expectedHours) * 1.2).toLocaleString()} KRWT (주휴수당 20% 버퍼 포함)
              </div>
              <button
                type="submit"
                disabled={loading || !verifiedContract?.approved}
                className={`w-full py-3 font-bold rounded-lg shadow transition ${
                  verifiedContract?.approved
                    ? "bg-blue-600 hover:bg-blue-700 text-white"
                    : "bg-slate-300 text-slate-500 cursor-not-allowed"
                }`}
              >
                {loading
                  ? "처리 중..."
                  : verifiedContract?.approved
                  ? "에스크로 예치 및 계약 체결"
                  : "PDF 검증 통과 후 등록 가능"}
              </button>
            </form>
          </div>

          {/* OTP 생성 및 정산 카드 */}
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm text-center">
              <h2 className="text-lg font-bold text-slate-900 flex items-center justify-center gap-2 mb-2">
                <KeyRound className="text-blue-600" /> 매장 6자리 출퇴근 OTP 발급
              </h2>
              <p className="text-xs text-slate-500 mb-4">알바생이 출근했을 때 화면의 번호를 불러주세요.</p>
              {generatedOtp ? (
                <div className="my-4 py-4 bg-blue-50 border-2 border-dashed border-blue-400 rounded-xl">
                  <span className="text-4xl font-mono font-black tracking-widest text-blue-900">{generatedOtp}</span>
                  <p className="text-xs text-blue-600 mt-1">유효시간: 3분</p>
                </div>
              ) : (
                <div className="my-4 py-6 bg-slate-100 rounded-xl text-slate-400 text-sm">생성 버튼을 눌러주세요</div>
              )}
              <button onClick={handleGenerateOtp} className="px-6 py-2.5 bg-slate-900 hover:bg-black text-white font-semibold rounded-lg text-sm">
                새 6자리 OTP 발급
              </button>
            </div>

            <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-2">
                <Coins className="text-amber-500" /> 계약 종료 및 급여 자동 정산
              </h2>
              <div className="flex gap-2 mb-3">
                <input
                  type="number"
                  placeholder="계약 ID"
                  value={contractIdInput}
                  onChange={(e) => setContractIdInput(e.target.value)}
                  className="w-24 p-2 border rounded-lg text-sm text-center font-bold"
                />
                <button
                  onClick={handleSettleWage}
                  disabled={loading}
                  className="flex-1 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-sm shadow"
                >
                  주휴수당 포함 자동 정산 실행
                </button>
              </div>
              <p className="text-xs text-slate-400">누적 근무 시간에 따라 근로자에게 즉시 이체되고 남은 예치금은 환급됩니다.</p>
            </div>
          </div>
        </div>
      )}

      {/* 근로자 뷰 */}
      {activeTab === "worker" && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* OTP 출퇴근 체크인 카드 */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-2">
              <Clock className="text-blue-600" /> 현장 6자리 OTP 출퇴근 체크인
            </h2>
            <p className="text-xs text-slate-500 mb-4">
                출근 시 1회, 퇴근 시 새 OTP로 1회 인증하면 실제 근무 시간이 자동 누적됩니다.
            </p>

  {/* 👇 현재 출근/퇴근 상태 배지 추가 */}
  <div
    className={`mb-4 p-3 rounded-lg text-xs font-semibold border ${
      activeCheckInAt
        ? "bg-emerald-50 text-emerald-800 border-emerald-200"
        : "bg-slate-50 text-slate-600 border-slate-200"
    }`}
  >
    {activeCheckInAt
      ? `🟢 현재 근무 중 (출근 시각: ${new Date(activeCheckInAt).toLocaleTimeString("ko-KR")})`
      : "⚪ 출근 대기 중 (사장님께 출근 OTP를 받아 입력하세요)"}
  </div>

  <div className="space-y-3">
    <div>
      <label className="block text-xs text-slate-500 mb-1">참여 중인 계약 ID</label>
      <input
        type="number"
        value={contractIdInput}
        onChange={(e) => setContractIdInput(e.target.value)}
        className="w-full p-2.5 border rounded-lg text-sm font-bold"
      />
    </div>
    <div>
      <label className="block text-xs text-slate-500 mb-1">인증번호 6자리</label>
      <input
        type="text"
        maxLength={6}
        placeholder="예: 482910"
        value={inputOtp}
        onChange={(e) => setInputOtp(e.target.value)}
        className="w-full p-3 border rounded-lg text-center font-mono text-2xl tracking-widest font-black"
      />
    </div>

    {/* 👇 상태에 따라 바뀌는 출근/퇴근 버튼 */}
    <button
      onClick={handleVerifyOtp}
      disabled={loading}
      className={`w-full py-3 font-bold rounded-lg shadow text-sm transition text-white ${
        activeCheckInAt
          ? "bg-indigo-600 hover:bg-indigo-700"
          : "bg-blue-600 hover:bg-blue-700"
      }`}
    >
      {loading
        ? "처리 중..."
        : activeCheckInAt
        ? "퇴근 OTP 인증 및 근무시간 자동 기록"
        : "출근 OTP 인증 시작"}
    </button>

    <button
      onClick={handleSettleWage}
      disabled={loading}
      className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg shadow text-sm transition"
    >
      💰 급여 직접 정산 청구 (고용주 미정산 시)
    </button>
    <button
      onClick={handleDemoRewind}
      disabled={loading}
      className="w-full py-2 border border-dashed border-amber-400 bg-amber-50 hover:bg-amber-100 text-amber-800 font-semibold rounded-lg text-xs transition"
    >
      🧪 [시연용] 16시간 전 출근으로 시간 경과 적용
    </button>
  </div>
</div>


          {/* 온체인 경력 이력서 조회 카드 */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Award className="text-indigo-600" /> 온체인 근무 이력서 (가스비 0원)
              </h2>
              <button onClick={handleFetchHistory} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-semibold">
                새로고침
              </button>
            </div>
            {workerHistory.length > 0 ? (
              <div className="space-y-3 max-h-72 overflow-y-auto pr-1">
                {workerHistory.map((item, idx) => (
                  <div key={idx} className="p-3 bg-slate-50 border rounded-xl text-xs space-y-1">
                    <div className="flex justify-between items-center font-bold text-slate-800">
                      <span>{item.jobTitle}</span>
                      <span className="text-emerald-600 font-mono">{ethers.formatEther(item.settledWage)} KRWT</span>
                    </div>
                    <p className="text-slate-500">누적 근무: {Number(item.totalWorkedMinutes)}분 ({Number(item.totalWorkedHours)}시간)</p>
                    <p className="text-slate-400 font-mono text-[10px]">고용주: {item.employer.slice(0, 10)}...</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-12 text-center text-slate-400 text-xs">
                정산 완료된 온체인 근무 이력이 없습니다.<br />고용주 화면에서 정산을 실행한 뒤 새로고침을 눌러보세요.
              </div>
            )}
          </div>
        </div>
      )}

      {/* AI 계약서 독소조항 스캐너 모달 */}
      {isScannerOpen && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl max-w-2xl w-full p-6 shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center pb-4 border-b">
              <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Sparkles className="text-purple-600 w-5 h-5" /> AI 근로계약서 독소조항 정밀 진단기
              </h2>
              <button onClick={() => setIsScannerOpen(false)} className="text-slate-400 hover:text-slate-600">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="flex justify-between items-center">
                <label className="text-xs font-semibold text-slate-600">계약서 본문 또는 특약 조항 입력</label>
                <button
                  onClick={loadSampleContract}
                  className="text-xs text-purple-600 hover:text-purple-800 font-semibold underline"
                >
                  📋 (시연용) 불공정 알바 계약서 샘플 불러오기
                </button>
              </div>

              <textarea
                rows={6}
                value={contractInputText}
                onChange={(e) => setContractInputText(e.target.value)}
                placeholder="근로계약서 문구를 붙여넣거나 위의 샘플 버튼을 눌러보세요."
                className="w-full p-3 border rounded-xl text-xs font-mono focus:ring-2 focus:ring-purple-500 focus:outline-none"
              />

              <button
                onClick={handleRunAiScan}
                disabled={isScanning}
                className="w-full py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold rounded-xl text-sm shadow transition"
              >
                {isScanning ? "노동법 판례 분석 중..." : "AI 정밀 법률 스캔 시작"}
              </button>

              {/* 스캔 결과 출력 */}
              {scanResult && (
                <div className="mt-6 space-y-4 border-t pt-4">
                  <div className="flex items-center justify-between p-4 bg-red-50 border border-red-200 rounded-2xl">
                    <div>
                      <span className="text-xs font-bold text-red-600 uppercase tracking-wider">법률 위험도 진단</span>
                      <h4 className="text-base font-extrabold text-red-950 mt-0.5">{scanResult.summary}</h4>
                    </div>
                    <div className="text-right">
                      <span className="text-3xl font-black text-red-600">{scanResult.riskScore}</span>
                      <span className="text-xs text-red-400 block font-bold">/ 100점 (위험)</span>
                    </div>
                  </div>

                  <div className="space-y-3">
                    <h5 className="text-xs font-bold text-slate-700">검출된 불공정 독소조항 상세 분석</h5>
                    {scanResult.toxicClauses.map((clause, idx) => (
                      <div key={idx} className="p-4 bg-slate-50 border border-slate-200 rounded-2xl space-y-2 text-xs">
                        <div className="flex items-center gap-1.5 text-red-600 font-bold">
                          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                          <span>{clause.lawReference}</span>
                        </div>
                        {/* unescaped entity 경고 해결: HTML 엔티티 &quot; 사용 */}
                        <div className="bg-white p-2.5 rounded-lg border text-red-800 font-mono text-[11px] line-through">
                          &quot;{clause.detectedText}&quot;
                        </div>
                        <p className="text-slate-600 leading-relaxed">{clause.explanation}</p>
                        <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-900">
                          <span className="font-bold block mb-0.5">💡 추천 표준 조항:</span>
                          {clause.recommendation}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}