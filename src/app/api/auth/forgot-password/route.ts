import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { User } from "@/models/User";
import { generateToken, hashToken } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { APP_NAME, APP_URL } from "@/lib/config";

/**
 * Starts the password-reset flow. Always responds the same way so the
 * endpoint cannot be used to discover which emails have accounts.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email ?? "").trim().toLowerCase();

    if (email) {
      await connectToDatabase();
      const user = await User.findOne({ email });

      if (user) {
        const token = generateToken();
        user.resetTokenHash = hashToken(token);
        user.resetTokenExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await user.save();

        const link = `${APP_URL}/reset-password?token=${token}&email=${encodeURIComponent(
          email
        )}`;
        await sendEmail({
          to: email,
          subject: `Reset your ${APP_NAME} password`,
          text: `We received a request to reset your password.\n\nUse the link below within the next hour:\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[forgot-password]", err);
    // Still generic, even on failure.
    return NextResponse.json({ ok: true });
  }
}
