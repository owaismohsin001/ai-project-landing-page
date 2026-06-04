// One-shot: reset a single user's password. Phase-0 helper.
import fs from 'node:fs';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const TARGET_EMAIL = 'umarinfo002@gmail.com';
const NEW_PASSWORD = '12345678';

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
const users = mongoose.connection.collection('users');

const before = await users.findOne({ email: TARGET_EMAIL }, { projection: { email: 1, name: 1 } });
if (!before) { console.error('No user with email', TARGET_EMAIL); process.exit(2); }

const passwordHash = await bcrypt.hash(NEW_PASSWORD, 10);
const res = await users.updateOne(
  { _id: before._id },
  { $set: { passwordHash }, $unset: { resetTokenHash: '', resetTokenExpiry: '' } }
);
console.log('matched=%d modified=%d email=%s name=%s', res.matchedCount, res.modifiedCount, before.email, before.name);

await mongoose.disconnect();
