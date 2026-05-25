import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import { connectToDatabase } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { WorkspaceService } from "@/models/WorkspaceService";
import { User } from "@/models/User";

/**
 * User-defined services exposed under <name>.<userId>.<PLATFORM_DOMAIN>.
 * The traefik-router on the proxy EC2 polls the workspaceservices
 * collection every ~5s so creates/deletes here are live within seconds —
 * no terraform apply, no SSH.
 */

async function requireReadyWorkspace() {
  const session = await getSessionUser();
  if (!session) return { error: "Not signed in.", status: 401 as const };

  await connectToDatabase();
  const user = await User.findById(session.sub).select(
    "workspaceStatus"
  );
  if (!user) return { error: "Not found.", status: 404 as const };
  if (user.workspaceStatus !== "ready") {
    return {
      error: "Workspace is not ready — provision one first.",
      status: 409 as const,
    };
  }
  return { userId: String(user._id) };
}

/** GET — list this user's services. Defaults are NOT returned here. */
export async function GET() {
  const g = await requireReadyWorkspace();
  if ("error" in g) {
    return NextResponse.json({ error: g.error }, { status: g.status });
  }

  const services = await WorkspaceService.find({
    userId: new mongoose.Types.ObjectId(g.userId),
  })
    .select("name port createdAt")
    .sort({ name: 1 })
    .lean();

  return NextResponse.json({ services });
}

/** POST — create one. Body: { name, port }. */
export async function POST(req: NextRequest) {
  const g = await requireReadyWorkspace();
  if ("error" in g) {
    return NextResponse.json({ error: g.error }, { status: g.status });
  }

  let body: { name?: unknown; port?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  const port = Number(body.port);
  if (!name || !Number.isFinite(port)) {
    return NextResponse.json(
      { error: "name (string) and port (number) are required." },
      { status: 400 }
    );
  }

  try {
    const doc = await WorkspaceService.create({
      userId: new mongoose.Types.ObjectId(g.userId),
      name,
      port,
    });
    return NextResponse.json(
      {
        service: {
          _id: String(doc._id),
          name: doc.name,
          port: doc.port,
          createdAt: doc.createdAt,
        },
      },
      { status: 201 }
    );
  } catch (err) {
    // Duplicate key (userId+name) — give a clean 409 instead of leaking
    // the Mongo error.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      return NextResponse.json(
        { error: `A service named "${name}" already exists.` },
        { status: 409 }
      );
    }
    if (err instanceof mongoose.Error.ValidationError) {
      return NextResponse.json(
        { error: Object.values(err.errors)[0]?.message ?? "Validation error." },
        { status: 400 }
      );
    }
    throw err;
  }
}

/** DELETE — body: { name }. Removes one service. */
export async function DELETE(req: NextRequest) {
  const g = await requireReadyWorkspace();
  if ("error" in g) {
    return NextResponse.json({ error: g.error }, { status: g.status });
  }

  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim().toLowerCase() : "";
  if (!name) {
    return NextResponse.json({ error: "name is required." }, { status: 400 });
  }

  const result = await WorkspaceService.deleteOne({
    userId: new mongoose.Types.ObjectId(g.userId),
    name,
  });
  if (result.deletedCount === 0) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ deleted: name });
}
