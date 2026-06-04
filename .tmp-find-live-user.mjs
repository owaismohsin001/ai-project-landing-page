// One-shot: find users with a live workspace instance. Phase-0 helper.
import fs from 'node:fs';
import mongoose from 'mongoose';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const uri = process.env.MONGODB_URI;
if (!uri) { console.error('MONGODB_URI not set'); process.exit(1); }

await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
const User = mongoose.connection.collection('users');

const live = await User.find(
  { workspaceStatus: 'ready', 'workspace.url': { $exists: true, $ne: '' } },
  {
    projection: {
      _id: 1, name: 1, email: 1, plan: 1, subscriptionStatus: 1,
      workspaceStatus: 1, 'workspace.url': 1, 'workspace.publicIp': 1,
      'workspace.instanceId': 1, createdAt: 1,
    },
  }
).sort({ createdAt: -1 }).limit(10).toArray();

console.log('matches:', live.length);
for (const u of live) {
  console.log(JSON.stringify({
    id: String(u._id),
    name: u.name,
    email: u.email,
    plan: u.plan,
    subscriptionStatus: u.subscriptionStatus,
    workspaceUrl: u.workspace?.url,
    publicIp: u.workspace?.publicIp,
    instanceId: u.workspace?.instanceId,
    createdAt: u.createdAt,
  }, null, 2));
}

if (live.length === 0) {
  console.log('--- no "ready" users; showing latest 5 regardless of status:');
  const any = await User.find({}, {
    projection: { _id: 1, email: 1, workspaceStatus: 1, 'workspace.url': 1, createdAt: 1 },
  }).sort({ createdAt: -1 }).limit(5).toArray();
  for (const u of any) console.log(JSON.stringify(u));
}

await mongoose.disconnect();
