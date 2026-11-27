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
      .select("total_minutes, active_check_in_at")
      .eq("contract_id", contractId)
      .maybeSingle();

    return NextResponse.json({
      contractId,
      totalMinutes: data?.total_minutes || 0,
      activeCheckInAt: data?.active_check_in_at || null,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action, contractId } = body;
    const cId = String(contractId || "1");
    const supabase = getSupabase();

    // 1. 고용주: 1회용 6자리 OTP 발급 (유효시간 3분)
    if (action === "issue_otp") {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 180 * 1000;

      const { error } = await supabase.from("workchain_otps").upsert({
        contract_id: cId,
        code,
        expires_at: expiresAt,
        used: false,
      });
      if (error) throw new Error(error.message);

      return NextResponse.json({
        success: true,
        code,
        otpCode: code,
        expiresAt,
      });
    }

    // 2. 근로자: 출근 / 퇴근 OTP 1회용 검증 및 실제 근무 시간 자동 계산
    if (action === "verify_otp") {
      const inputCode = String(body.code ?? body.otpCode ?? "").trim();
      if (!inputCode) {
        return NextResponse.json({ error: "OTP 번호를 입력하세요." }, { status: 400 });
      }

      const { data: otpRow, error: otpErr } = await supabase
        .from("workchain_otps")
        .select("*")
        .eq("contract_id", cId)
        .eq("code", inputCode)
        .eq("used", false)
        .gt("expires_at", Date.now())
        .maybeSingle();

      if (otpErr || !otpRow) {
        return NextResponse.json(
          { error: "유효하지 않거나 이미 사용/만료된 OTP입니다." },
          { status: 400 }
        );
      }

      // 재사용 차단 (출근용 OTP를 퇴근에 재사용 불가)
      const { error: usedErr } = await supabase
        .from("workchain_otps")
        .update({ used: true })
        .eq("contract_id", cId)
        .eq("code", inputCode);
      if (usedErr) throw new Error(usedErr.message);

      const { data: logData } = await supabase
        .from("workchain_logs")
        .select("total_minutes, active_check_in_at")
        .eq("contract_id", cId)
        .maybeSingle();

      const now = new Date();

      // A) 출근 기록이 없으면 -> 출근(Check-In) 처리
      if (!logData?.active_check_in_at) {
        const { error: checkInErr } = await supabase.from("workchain_logs").upsert({
          contract_id: cId,
          total_minutes: Number(logData?.total_minutes || 0),
          active_check_in_at: now.toISOString(),
        });
        if (checkInErr) throw new Error(checkInErr.message);

        return NextResponse.json({
          success: true,
          status: "checked_in",
          checkInAt: now.toISOString(),
          addedMinutes: 0,
          totalMinutes: Number(logData?.total_minutes || 0),
        });
      }

      // B) 이미 출근 중이면 -> 퇴근(Check-Out) 처리 및 경과 시간(분) 누적
      const checkInTime = new Date(logData.active_check_in_at).getTime();
      const diffMinutes = Math.max(1, Math.round((now.getTime() - checkInTime) / 60000));
      const updatedMinutes = Number(logData.total_minutes || 0) + diffMinutes;

      const { error: checkOutErr } = await supabase.from("workchain_logs").upsert({
        contract_id: cId,
        total_minutes: updatedMinutes,
        active_check_in_at: null,
      });
      if (checkOutErr) throw new Error(checkOutErr.message);

      return NextResponse.json({
        success: true,
        status: "checked_out",
        addedMinutes: diffMinutes,
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
        .select("total_minutes, active_check_in_at")
        .eq("contract_id", cId)
        .maybeSingle();

      if (logData?.active_check_in_at) {
        return NextResponse.json(
          { error: "현재 근무 중입니다. 퇴근 OTP 인증을 먼저 완료해 주세요." },
          { status: 400 }
        );
      }

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
    // 4. [시연 전용] 출근 시각을 15시간 전으로 설정 (퇴근 OTP 시 900분 자동 계산 테스트용)
    if (action === "demo_rewind_checkin") {
      const { data: logData } = await supabase
        .from("workchain_logs")
        .select("total_minutes")
        .eq("contract_id", cId)
        .maybeSingle();

      const fifteenHoursAgo = new Date(Date.now() - 15 * 60 * 60 * 1000).toISOString();

      const { error } = await supabase.from("workchain_logs").upsert({
        contract_id: cId,
        total_minutes: Number(logData?.total_minutes || 0),
        active_check_in_at: fifteenHoursAgo,
      });
      if (error) throw new Error(error.message);

      return NextResponse.json({
        success: true,
        checkInAt: fifteenHoursAgo,
      });
    }

    return NextResponse.json({ error: "잘못된 요청입니다." }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}