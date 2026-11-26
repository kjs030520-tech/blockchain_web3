import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import https from "https";

function callGeminiApi(apiKey: string, payload: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
        method: "POST",
        family: 4, // IPv6 지연/드롭 방지 (IPv4 강제)
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 30000, // 30초 타임아웃
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`Gemini HTTP ${res.statusCode}: ${data}`));
            } else {
              resolve(parsed);
            }
          } catch (e) {
            reject(new Error(`JSON 파싱 실패: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Gemini API 응답 시간 초과 (30초)"));
    });
    req.on("error", (err) => reject(err));
    req.write(body);
    req.end();
  });
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const employerAddress = formData.get("employerAddress") as string | null;

    if (!file || file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "PDF 파일만 업로드할 수 있습니다." },
        { status: 400 }
      );
    }

    if (!employerAddress || !ethers.isAddress(employerAddress)) {
      return NextResponse.json(
        { error: "유효한 고용주 지갑 주소가 필요합니다." },
        { status: 400 }
      );
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    const signerPrivateKey = process.env.AI_SIGNER_PRIVATE_KEY;
    if (!geminiKey || !signerPrivateKey) {
      return NextResponse.json(
        { error: "서버 환경변수(GEMINI_API_KEY 또는 AI_SIGNER_PRIVATE_KEY)가 누락되었습니다." },
        { status: 500 }
      );
    }

    // 1. PDF 원본 바이너리에서 SHA-256 해시(bytes32) 추출
    const arrayBuffer = await file.arrayBuffer();
    const pdfBuffer = Buffer.from(arrayBuffer);
    const contractHash = ethers.sha256(new Uint8Array(pdfBuffer));
    const base64Pdf = pdfBuffer.toString("base64");

    // 2. Gemini API 호출 (HTTP/1.1 + IPv4)
    const geminiData = await callGeminiApi(geminiKey, {
      contents: [
        {
          role: "user",
          parts: [
            {
              inline_data: {
                mime_type: "application/pdf",
                data: base64Pdf,
              },
            },
            {
              text: `당신은 대한민국 근로기준법 전문 공인노무사 AI입니다. 첨부된 PDF 근로계약서를 분석해 다음 기준으로 적법성을 판별하세요.
1) 최저임금 준수 여부 (시급 기준)
2) 근로기준법 제20조(위약 예정 금지: 지각·결근 시 과도한 벌금·손해배상 공제 조항) 위반 여부
3) 근로기준법 제55조(주 15시간 이상 근로 시 주휴수당 지급 의무) 배제·포기 조항 여부
4) 계약서에 명시된 직무명(jobTitle), 시급(hourlyWage, 원 단위 정수), 예상 총 근로시간(expectedHours, 시간 단위 정수)을 추출하세요.
위반 조항이 하나라도 있거나 시급·근로시간이 불명확하면 isCompliant를 false로 반환하세요.`,
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        thinkingConfig: { thinkingLevel: "LOW" },
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            isCompliant: { type: "BOOLEAN" },
            jobTitle: { type: "STRING" },
            hourlyWage: { type: "INTEGER" },
            expectedHours: { type: "INTEGER" },
            violations: {
              type: "ARRAY",
              items: { type: "STRING" },
            },
            summary: { type: "STRING" },
          },
          required: [
            "isCompliant",
            "jobTitle",
            "hourlyWage",
            "expectedHours",
            "violations",
            "summary",
          ],
        },
      },
    });

    const rawText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const analysis = JSON.parse(rawText);

    // 3. 규정 위반 시 서명 발급 거절
    if (!analysis.isCompliant || analysis.hourlyWage <= 0 || analysis.expectedHours <= 0) {
      return NextResponse.json({
        approved: false,
        contractHash,
        analysis,
      });
    }

    // 4. 규정 통과 시에만 LaborEscrow.sol 규격으로 ECDSA 전자서명 생성
    const hourlyWageWei = ethers.parseUnits(String(analysis.hourlyWage), 18);
    const expectedHoursBigInt = BigInt(analysis.expectedHours);

    const payloadHash = ethers.solidityPackedKeccak256(
      ["bytes32", "address", "uint256", "uint256"],
      [contractHash, employerAddress, hourlyWageWei, expectedHoursBigInt]
    );

    const wallet = new ethers.Wallet(signerPrivateKey);
    const signature = await wallet.signMessage(ethers.getBytes(payloadHash));

    return NextResponse.json({
      approved: true,
      contractHash,
      signature,
      analysis,
    });
  } catch (error: any) {
    console.error("Verify contract error:", error);
    return NextResponse.json(
      { error: error?.message || "서버 내부 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}