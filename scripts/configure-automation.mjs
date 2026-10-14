import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const project = 'dpwzjmqvsqifbgspoylc',
  workspace = 'ae4d5cfe-1fcd-4300-9385-d368886e8b9c';
const cliArgs = ['--yes', 'supabase@2.120.0'];
function cli(args) {
  // Fixed program/arguments; no provider secrets are passed on the command line or printed.
  const options = {
    cwd: resolve('.'),
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 120000,
  };
  try {
    // Windows requires cmd to launch npm's .cmd shim; all arguments are fixed paths/IDs.
    return process.platform === 'win32'
      ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npx.cmd', ...cliArgs, ...args], options)
      : execFileSync('npx', [...cliArgs, ...args], options);
  } catch {
    throw new Error(
      'Supabase setup failed. Check CLI login and operator permissions; secret-bearing output was withheld.',
    );
  }
}
await mkdir('supabase/.temp', { recursive: true });
const envPath = resolve('supabase/.temp/automation-worker.env'),
  sqlPath = resolve('supabase/.temp/automation-scheduler.sql');
let secret;
try {
  secret = /^AUTOMATION_WORKER_SECRET=([a-f0-9]{64})$/m.exec(await readFile(envPath, 'utf8'))?.[1];
} catch {
  /* First setup. */
}
secret ||= randomBytes(32).toString('hex');
await writeFile(
  envPath,
  `AUTOMATION_WORKER_SECRET=${secret}\nAUTOMATION_WORKSPACE_ID=${workspace}\n`,
  { mode: 0o600 },
);
const template = await readFile('supabase/automation-scheduler.sql', 'utf8');
await writeFile(
  sqlPath,
  template
    .replaceAll('__SECRET__', secret)
    .replaceAll('__WORKSPACE_ID__', workspace)
    .replaceAll('__PROJECT_REF__', project),
  { mode: 0o600 },
);
try {
  cli(['db', 'query', '--linked', '--project-ref', project, '--file', sqlPath]);
  const status = JSON.parse(
    cli([
      'db',
      'query',
      '--linked',
      '--project-ref',
      project,
      '--output',
      'json',
      "select jobname,active from cron.job where jobname='handoffcheck-automation'",
    ]),
  );
  if (!status.rows?.some((row) => row.jobname === 'handoffcheck-automation' && row.active))
    throw new Error('The scheduler job was not installed.');
  cli(['secrets', 'set', '--project-ref', project, '--env-file', envPath]);
  console.log(
    'Automation scheduler installed and private worker credentials saved. Feature toggles remain unchanged.',
  );
} finally {
  await unlink(sqlPath);
}
