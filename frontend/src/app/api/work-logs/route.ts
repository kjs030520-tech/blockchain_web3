import { NextRequest, NextResponse } from "next/server";
import { ethers } from "ethers";
import { createClient } from "@supabase/supabase-js";

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL 또는 SUPABASE_SERVICE_ROLE_KEY가 누락되었습니다.");
  }
  return createClient(url, key);
}

export async function GET(req: NextRequest) {
  try {
    const contractId = req.nextUrl.searchParams.get("contractId") || "1";
    const supabase = getSupabase();

    const { data } = await supabase
      .from("workchain_logs")
      .select("total_minutes")
      .eq("contract_id", contractId)
      .maybeSingle();

    return NextResponse.json({
      contractId,
      totalMinutes: data?.total_minutes || 0,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, contractId, otpCode } = body;
    const cId = String(contractId || "1");
    const supabase = getSupabase();

    // 1. 고용주: 1회용 6자리 OTP 발급 (유효시간 3분)
    if (action === "generate_otp") {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 3 * 60 * 1000;

      const { error } = await supabase.from("workchain_otps").upsert({
        contract_id: cId,
        code,
        expires_at: expiresAt,
        used: false,
      });
      if (error) throw new Error(error.message);

      return NextResponse.json({ code, expiresInSeconds: 180 });
    }

    // 2. 근로자: OTP 1회용 검증 및 240분 누적
    if (action === "verify_otp") {
      const { data: record, error: fetchErr } = await supabase
        .from("workchain_otps")
        .select("*")
        .eq("contract_id", cId)
        .maybeSingle();

      if (fetchErr) throw new Error(fetchErr.message);
      if (!record) {
        return NextResponse.json({ error: "발급된 OTP가 없습니다." }, { status: 400 });
      }
      if (record.used) {
        return NextResponse.json({ error: "이미 사용된 OTP입니다. 새 번호를 발급받으세요." }, { status: 400 });
      }
      if (Date.now() > Number(record.expires_at)) {
        return NextResponse.json({ error: "OTP 유효시간(3분)이 만료되었습니다." }, { status: 400 });
      }
      if (record.code !== String(otpCode).trim()) {
        return NextResponse.json({ error: "인증번호 6자리가 일치하지 않습니다." }, { status: 400 });
      }

      // 1회 사용 즉시 폐기
      const { error: updateErr } = await supabase
        .from("workchain_otps")
        .update({ used: true })
        .eq("contract_id", cId);
      if (updateErr) throw new Error(updateErr.message);

      // 기존 누적 분 조회 후 +240분 저장
      const { data: logData } = await supabase
        .from("workchain_logs")
        .select("total_minutes")
        .eq("contract_id", cId)
        .maybeSingle();

      const updatedMinutes = (logData?.total_minutes || 0) + 240;

      const { error: upsertErr } = await supabase.from("workchain_logs").upsert({
        contract_id: cId,
        total_minutes: updatedMinutes,
      });
      if (upsertErr) throw new Error(upsertErr.message);

      return NextResponse.json({
        success: true,
        addedMinutes: 240,
        totalMinutes: updatedMinutes,
      });
    }

    // 3. 정산 준비: DB 누적 근무시간에 대해 서버 ECDSA 서명 발급
    if (action === "prepare_settle") {
      const signerPrivateKey = process.env.AI_SIGNER_PRIVATE_KEY;
      if (!signerPrivateKey) {
        return NextResponse.json({ error: "AI_SIGNER_PRIVATE_KEY 누락" }, { status: 500 });
      }

      const { data: logData } = await supabase
        .from("workchain_logs")
        .select("total_minutes")
        .eq("contract_id", cId)
        .maybeSingle();

      const totalMinutes = logData?.total_minutes || 0;
      const payloadHash = ethers.solidityPackedKeccak256(
        ["string", "uint256", "uint256"],
        ["SETTLE", BigInt(cId), BigInt(totalMinutes)]
      );
      const wallet = new ethers.Wallet(signerPrivateKey);
      const signature = await wallet.signMessage(ethers.getBytes(payloadHash));

      return NextResponse.json({
        contractId: cId,
        totalMinutes,
        signature,
      });
    }

    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}