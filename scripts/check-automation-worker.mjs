import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
const secret = /^AUTOMATION_WORKER_SECRET=([a-f0-9]{64})$/m.exec(
  await readFile('supabase/.temp/automation-worker.env', 'utf8'),
)?.[1];
if (!secret) throw new Error('Configure the private scheduler first.');
const url = 'https://dpwzjmqvsqifbgspoylc.supabase.co/functions/v1/automation-worker';
const raw = '{"action":"run"}',
  timestamp = String(Date.now()),
  nonce = randomUUID();
const headers = {
  'Content-Type': 'application/json',
  'x-handoff-timestamp': timestamp,
  'x-handoff-nonce': nonce,
  'x-handoff-signature': createHmac('sha256', secret)
    .update(`${timestamp}\n${nonce}\n${raw}`)
    .digest('hex'),
};
const first = await fetch(url, { method: 'POST', headers, body: raw });
const replay = await fetch(url, { method: 'POST', headers, body: raw });
const unsigned = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: raw,
});
console.log(
  JSON.stringify({ signed: first.status, replay: replay.status, unsigned: unsigned.status }),
);
if (first.status !== 200 || replay.status !== 409 || unsigned.status !== 401) process.exitCode = 1;
