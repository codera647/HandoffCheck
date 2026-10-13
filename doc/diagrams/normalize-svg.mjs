import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Mermaid emits gradient definitions for several diagram types. Replace them
// with the configured solid border color to preserve the documented palette.
const directory = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(directory, 'mermaid-config.json'), 'utf8'));
const solidColor = config.themeVariables.primaryBorderColor;
if (!/^#[0-9a-f]{6}$/i.test(solidColor)) {
  throw new Error('Expected a six-digit solid border color.');
}

for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.svg'))) {
  const target = path.join(directory, name);
  let svg = fs.readFileSync(target, 'utf8');
  const ids = [];
  svg = svg.replace(/<(linearGradient|radialGradient)\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g,
    (_definition, _type, id) => { ids.push(id); return ''; });
  for (const id of ids) {
    for (const reference of [`url(#${id})`, `url('#${id}')`, `url("#${id}")`]) {
      svg = svg.split(reference).join(solidColor);
    }
  }
  if (/<(?:linearGradient|radialGradient)\b/i.test(svg)) {
    throw new Error(`Unrecognized gradient definition in ${name}.`);
  }
  fs.writeFileSync(target, svg, 'utf8');
}

console.log('Diagram SVGs use solid colors.');
