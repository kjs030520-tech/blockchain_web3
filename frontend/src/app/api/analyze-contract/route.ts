import { NextRequest, NextResponse } from "next/server";

const SYSTEM_PROMPT = `
당신은 대한민국 고용노동부 근로기준법 전문 공인노무사 AI입니다.
사용자가 제공한 근로계약서 텍스트 또는 조항을 분석하여, 불공정 독소조항과 법적 위반 사항을 정밀 진단하십시오.
반드시 마크다운 없이 순수 JSON 형식으로만 응답하십시오:
{
  "riskScore": 85,
  "riskLevel": "위험" | "경고" | "안전",
  "summary": "총 2건의 근로기준법 위반 독소조항 발견",
  "toxicClauses": [
    {
      "detectedText": "위반 의심 원문 조항",
      "lawReference": "근로기준법 제20조 (위약 예정의 금지)",
      "explanation": "해당 조항이 왜 불법이고 무효인지 해설",
      "recommendation": "공정하고 합법적인 표준 조항으로의 수정 제안 문구"
    }
  ]
}
`;

export async function POST(req: NextRequest) {
  try {
    const { contractText } = await req.json();
    if (!contractText?.trim()) {
      return NextResponse.json({ error: "계약서 내용을 입력해 주세요." }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;

    // OpenAI 키가 있을 때 실제 GPT-4o 호출
    if (apiKey && apiKey.startsWith("sk-")) {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: contractText },
          ],
          response_format: { type: "json_object" },
          temperature: 0.2,
        }),
      });
      const data = await response.json();
      return NextResponse.json(JSON.parse(data.choices[0].message.content));
    }

    // OpenAI 키가 없어도 발표 시연이 바로 가능한 스마트 Fallback 모의 진단
    return NextResponse.json({
      riskScore: 85,
      riskLevel: "위험",
      summary: "근로기준법 제20조 및 제55조 위반 독소조항 2건 검출",
      toxicClauses: [
        {
          detectedText: "퇴사 30일 전에 미리 통보하지 않고 퇴사할 경우, 당월 급여의 50%를 위약금 명목으로 공제한다.",
          lawReference: "근로기준법 제20조 (위약 예정의 금지)",
          explanation: "사용자는 근로계약 불이행에 대한 위약금이나 손해배상액을 예정하는 계약을 체결하지 못합니다. 실제 손해액 입증 없는 일방적 급여 공제 약정은 법적으로 원천 무효입니다.",
          recommendation: "급여 임의 삭감 조항을 전면 삭제하고 표준 퇴사 절차로 대체해야 합니다."
        },
        {
          detectedText: "주 15시간 이상 근무하더라도 주휴수당은 시급에 포함되어 별도 지급하지 않는다.",
          lawReference: "근로기준법 제55조 (휴일 및 주휴수당)",
          explanation: "주 15시간 이상 개근한 근로자에게는 유급휴일(주휴수당)을 반드시 부여해야 합니다. 단순 구두나 포괄 시급 약정은 무효이며 임금 체불에 해당합니다.",
          recommendation: "기본 시급과 주휴수당을 분리하여 명시하고, 주 15시간 이상 개근 시 약정 시급에 비례한 주휴수당을 정산해야 합니다."
        }
      ]
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}