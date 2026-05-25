import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { hashPassword, hashToken } from "@/lib/auth";

/** Completes the password-reset flow using a token from the reset email. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();
    const token = String(body?.token ?? "").trim();
    const password = String(body?.password ?? "");

    if (!email || !token) {
      return NextResponse.json(
        { error: "This reset link is invalid." },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    await connectToDatabase();

    const user = await User.findOne({ email });
    const tokenValid =
      user &&
      user.resetTokenHash &&
      user.resetTokenExpiry &&
      user.resetTokenHash === hashToken(token) &&
      user.resetTokenExpiry.getTime() > Date.now();

    if (!user || !tokenValid) {
      return NextResponse.json(
        { error: "This reset link is invalid or has expired." },
        { status: 400 }
      );
    }

    user.passwordHash = await hashPassword(password);
    user.resetTokenHash = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[reset-password]", err);
    return NextResponse.json(
      { error: "Could not reset your password." },
      { status: 500 }
    );
  }
}
