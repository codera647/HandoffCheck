import { readFile } from 'node:fs/promises';

const result = JSON.parse(await readFile(process.argv[2], 'utf8'));
const deployment = result.deployment;
if (
  result.status !== 'ok' ||
  deployment?.readyState !== 'READY' ||
  deployment.target !== 'production'
)
  throw new Error('Vercel did not return a ready production deployment.');
const url = new URL(deployment.url);
if (
  url.protocol !== 'https:' ||
  url.origin !== deployment.url ||
  !/^handoffcheck-[a-z0-9]+-codera647s-projects\.vercel\.app$/.test(url.hostname)
)
  throw new Error('Vercel returned an unexpected deployment URL.');
console.log(url.origin);
