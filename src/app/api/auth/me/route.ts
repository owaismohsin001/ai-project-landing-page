import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

/** Returns the currently signed-in user, or 401 if there is no session. */
export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json({ user });
}
