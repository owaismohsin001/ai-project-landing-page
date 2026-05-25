// One-off cleanup — clears the `workspace` and `workspaceStatus` fields on
// any User doc whose AWS resources have been destroyed out-of-band (via
// `terraform destroy` rather than the dashboard's DELETE /api/workspace).
//
// Safe to re-run: if everything is already clean it just reports 0 updates.

import fs from "node:fs";
import path from "node:path";
import { MongoClient } from "mongodb";

// Lightweight .env.local loader — avoids a dotenv dep just for this script.
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i);
    if (!m) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI not set — source .env.local first.");
  process.exit(1);
}

const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db();
  const users = db.collection("users");

  const before = await users
    .find(
      { $or: [{ workspaceStatus: { $exists: true } }, { workspace: { $exists: true } }] },
      { projection: { _id: 1, workspaceStatus: 1, "workspace.publicDns": 1 } }
    )
    .toArray();

  console.log(`found ${before.length} user(s) with workspace state to clear:`);
  for (const u of before) {
    console.log(
      `  ${u._id}  status=${u.workspaceStatus ?? "—"}  dns=${u.workspace?.publicDns ?? "—"}`
    );
  }
  if (before.length === 0) process.exit(0);

  const result = await users.updateMany(
    { _id: { $in: before.map((u) => u._id) } },
    { $unset: { workspaceStatus: "", workspaceError: "", workspace: "" } }
  );
  console.log(`cleared ${result.modifiedCount} doc(s)`);
} finally {
  await client.close();
}
