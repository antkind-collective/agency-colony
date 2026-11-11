// Version every script and stylesheet by its CONTENT, not by the deploy (C2,
// 24 Sep 2026).
//
// The build used to stamp one deploy version onto every ?v= in index.html, so
// each deploy changed every asset URL and every visitor re-downloaded all of
// them: ~715kB compressed on Colony, of which SheetJS alone (288kB, ~2.4s) had
// not changed in months. Assets are served `immutable` for a year, so the URL
// is the whole cache key — make it the file's own hash and an unchanged file
// keeps its URL across deploys; only what changed is fetched again.
//
// Each page is hashed against the file THAT HOST SERVES for the path:
// clients.youragency.com rewrites js/*, app.js and styles.css to the stripped
// Circle build (netlify.toml), so the Circle page is hashed against circle/.
//
// Runs after build-circle.mjs in the Netlify build command and edits the two
// pages in place (Netlify's checkout, never a working tree).
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REF = /\b(src|href)="([^"?#]+)\?v=[^"]*"/g;

export function contentVersion(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12);
}

// html: the page; servedPath(ref) → repo path of the file that host serves.
export function versionPage(html, servedPath, read = (p) => readFileSync(p)) {
  const seen = [];
  const out = html.replace(REF, (all, attr, ref) => {
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:')) return all;
    const path = servedPath(ref);
    let bytes;
    try { bytes = read(path); } catch { throw new Error(`hash-assets: ${ref} → ${path} does not exist`); }
    seen.push(ref);
    return `${attr}="${ref}?v=${contentVersion(bytes)}"`;
  });
  const left = [...out.matchAll(REF)].map((m) => m[0]).filter((m) => !/\?v=[0-9a-f]{12}"$/.test(m) && !/"(https?:)?\/\//.test(m));
  if (left.length) throw new Error(`hash-assets: not content-versioned: ${left.join(', ')}`);
  return { html: out, versioned: seen };
}

export const colonyServed = (ref) => ref;
export const circleServed = (ref) => (ref.startsWith('js/') || ref === 'app.js' || ref === 'styles.css' ? `circle/${ref}` : ref);

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [page, served] of [['index.html', colonyServed]]) {
    if (!existsSync(page)) throw new Error(`hash-assets: ${page} is missing — run build-circle.mjs first`);
    const { html, versioned } = versionPage(readFileSync(page, 'utf8'), served);
    if (versioned.length < 5) throw new Error(`hash-assets: only ${versioned.length} assets versioned in ${page} — the pattern is probably broken`);
    writeFileSync(page, html);
    console.log(`hash-assets: ${page}: ${versioned.length} assets content-versioned`);
  }
}
