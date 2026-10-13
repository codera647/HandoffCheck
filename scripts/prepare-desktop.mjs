import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';

let production = {};
try {
  production = JSON.parse(await readFile('desktop/production.json', 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const env = { ...loadEnv('production', process.cwd(), 'VITE_'), ...process.env };
const config = {
  appUrl: env.HANDOFFCHECK_APP_URL || production.appUrl,
  supabaseUrl: env.VITE_SUPABASE_URL || production.supabaseUrl,
  publishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY || production.publishableKey,
};
const address = new URL(config.appUrl);
if (
  address.protocol !== 'https:' ||
  address.username ||
  address.password ||
  address.pathname !== '/' ||
  address.search ||
  address.hash
)
  throw new Error('HANDOFFCHECK_APP_URL must be the canonical HTTPS production origin.');
if (
  !/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(config.supabaseUrl) ||
  !/^sb_publishable_[A-Za-z0-9_-]+$/.test(config.publishableKey)
)
  throw new Error('Desktop builds require the public Supabase URL and publishable key.');
await mkdir('desktop/generated', { recursive: true });
await writeFile('desktop/generated/config.json', JSON.stringify(config, null, 2) + '\n');
console.log('Desktop configuration prepared for ' + address.origin);
