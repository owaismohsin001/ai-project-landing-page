import { NextResponse } from "next/server";
import { connectToDatabase } from "@/lib/db";
import { Contact } from "@/models/Contact";
import { sendEmail } from "@/lib/email";
import { APP_NAME } from "@/lib/config";

/** Stores an Enterprise enquiry and notifies the sales inbox. */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name ?? "").trim();
    const email = String(body?.email ?? "").trim().toLowerCase();
    const company = String(body?.company ?? "").trim();
    const message = String(body?.message ?? "").trim();

    if (name.length < 2 || !email.includes("@") || message.length < 10) {
      return NextResponse.json(
        {
          error:
            "Please provide your name, a valid email, and a message of at least 10 characters.",
        },
        { status: 400 }
      );
    }

    await connectToDatabase();
    await Contact.create({ name, email, company, message });

    await sendEmail({
      to: "sales@example.com",
      subject: `[${APP_NAME}] New Enterprise enquiry from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\nCompany: ${company || "—"}\n\n${message}`,
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[contact]", err);
    return NextResponse.json(
      { error: "Could not send your message. Please try again." },
      { status: 500 }
    );
  }
}
