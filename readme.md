# WorkChain 프로젝트 초기 세팅 및 실행 가이드

본 가이드는 **AI 독소조항 진단 및 블록체인 에스크로 기반 단기 알바·외주 안심 정산 플랫폼 (WorkChain)**의 기본 개발 환경 구축 및 스마트 컨트랙트 배포 매뉴얼입니다.

---

## 1. 프로젝트 폴더 구조

```text
workchain/
├── contracts/                  # Solidity 스마트 컨트랙트
│   ├── MockKRWT.sol            # 테스트용 가상 원화 스테이블코인 (ERC-20)
│   └── LaborEscrow.sol         # 핵심 에스크로, 근무시간 기록, 정산, 온체인 이력 조회
├── scripts/
│   └── deploy.js               # 컨트랙트 자동 배포 스크립트
├── hardhat.config.js           # Hardhat 빌드 및 테스트넷 네트워크 설정
├── supabase_schema.sql         # Supabase DB 초기 테이블 생성 쿼리
├── .env.example                # 환경변수 템플릿 파일
└── package.json
```

---

## 2. 사전 밑작업 및 환경 세팅 단계

### Step 1. 프로젝트 디렉토리 생성 및 패키지 설치
터미널을 열고 아래 명령어를 순서대로 실행합니다:

```bash
mkdir workchain
cd workchain
npm init -y

# 스마트 컨트랙트 개발 도구 및 OpenZeppelin 표준 라이브러리 설치
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox dotenv
npm install @openzeppelin/contracts
```

### Step 2. 기본 파일 배치
제공된 파일들을 해당 위치에 저장합니다:
* `contracts/MockKRWT.sol`
* `contracts/LaborEscrow.sol`
* `scripts/deploy.js`
* `hardhat.config.js`
* `supabase_schema.sql`
* `.env.example` -> 복사하여 `.env` 생성

### Step 3. 환경변수(.env) 입력
`.env` 파일을 열고 본인의 키 값을 입력합니다:
```env
SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/본인의_ALCHEMY_KEY"
PRIVATE_KEY="메타마스크_지갑_개인키"
```

---

## 3. 스마트 컨트랙트 컴파일 및 배포

### 로컬 환경에서 테스트 (추천)
로컬에서 빠르고 가스비 걱정 없이 테스트하려면 별도 터미널에서 Hardhat 내장 노드를 켭니다:

```bash
# 1번 터미널: 로컬 블록체인 노드 실행 (지갑 주소 20개 자동 생성)
npx hardhat node

# 2번 터미널: 로컬 노드에 컨트랙트 배포
npx hardhat run scripts/deploy.js --network localhost
```

### 이더리움 세폴리아(Sepolia) 테스트넷 배포
세폴리아 테스트넷에 실제 배포하려면:

```bash
npx hardhat run scripts/deploy.js --network sepolia
```

배포가 완료되면 콘솔창에 출력되는 `MockKRWT`와 `LaborEscrow`의 주소를 복사해 둡니다.

---

## 4. 데이터베이스(Supabase) 테이블 생성

1. [Supabase 대시보드](https://supabase.com/)에 접속하여 프로젝트를 생성합니다.
2. 좌측 메뉴의 **SQL Editor**로 이동합니다.
3. 제공된 `supabase_schema.sql` 파일의 내용을 붙여넣고 **Run** 버튼을 눌러 `otp_codes`와 `work_logs` 테이블을 생성합니다.

---

## 5. 스마트 컨트랙트 핵심 기능 명세 요약

* **`createAndFundContract(...)`**: 고용주가 근로계약서 원본의 SHA-256 해시값과 직무명, 시급, 예상 시간을 등록하고, 에스크로 금고에 급여(주휴수당 예비비 포함)를 즉시 예치합니다.
* **`recordVerifiedHours(...)`**: 매장 PC의 6자리 OTP 인증을 통과한 근무 시간을 온체인에 누적하며, 15시간(900분) 이상 달성 시 주휴수당 가산 플래그(`isHolidayPayEligible`)를 자동 활성화합니다.
* **`settleWage(...)`**: 계약 종료 시 실제 인정 근무 시간에 비례한 급여 + 주휴수당을 계산해 근로자 지갑으로 즉시 송금하고 남은 예치금은 고용주에게 환급합니다.
* **`getWorkerHistory(...)`**: 특정 근로자의 지갑 주소를 넣으면 정산 완료된 모든 근무 이력(직무, 총 인정 시간, 지급 급여, 원본 계약 해시)을 가스비 0원(View 함수)으로 한 번에 조회합니다.
