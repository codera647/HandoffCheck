import { readFile } from 'node:fs/promises';

const html = await readFile(process.argv[2], 'utf8');
if (!html.includes('<div id="root"></div>') || !/<script[^>]+src="\/assets\/[^\"]+\.js"/.test(html))
  throw new Error('The route did not return the built HandoffCheck app.');
console.log('Built app route verified.');
