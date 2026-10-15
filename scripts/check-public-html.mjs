import { readFile } from 'node:fs/promises';

const [file, page] = process.argv.slice(2);
const titles = {
  about: 'About HandoffCheck',
  privacy: 'Privacy policy | HandoffCheck',
  terms: 'Terms of service | HandoffCheck',
};
if (!Object.hasOwn(titles, page)) throw new Error('Unknown public page.');
const html = await readFile(file, 'utf8');
if (
  !html.includes(`<title>${titles[page]}</title>`) ||
  !html.includes('<main id="public-content"') ||
  !html.includes('href="/privacy"') ||
  !html.includes('href="/terms"') ||
  !html.includes('mailto:moiz44386@gmail.com') ||
  !/<link[^>]+href="\/assets\/[^\"]+\.css"/.test(html) ||
  html.includes('<div id="root">') ||
  /<script\b/.test(html)
) {
  throw new Error('The route did not return the complete static HandoffCheck public page.');
}
console.log(`Static ${page} page verified.`);
