// electron-builder's NSIS target hardcodes `isWriteUpdateInfo: !this.isPortable`
// (see node_modules/app-builder-lib/out/targets/nsis/NsisTarget.js), so a
// portable-only Windows target never gets a latest.yml generated or uploaded
// automatically, even with `--publish always`. electron-updater's GitHub
// provider requires that file to detect new releases at all (it fetches
// releases/latest/download/latest.yml and 404s without it) — without this
// step, every future publish would produce a release the in-app updater can
// never see, silently.
//
// This replicates electron-builder's own latest.yml schema (verified against
// a real electron-builder-generated one from v1.0.74) and uploads it to the
// release `npm run publish` just created, via the GitHub REST API directly
// (not the gh CLI) using GH_TOKEN, the same credential electron-builder
// itself expects for publishing.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const pkg = require('../package.json');
const version = pkg.version;
const owner = pkg.build.publish.owner;
const repo = pkg.build.publish.repo;
const artifactName = 'VOYD.exe'; // must match build.win.artifactName / build.portable.artifactName
const distDir = path.join(__dirname, '..', 'dist');
const exePath = path.join(distDir, artifactName);

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) {
  console.error('[generate-latest-yml] GH_TOKEN (or GITHUB_TOKEN) is not set — cannot upload latest.yml.');
  process.exit(1);
}

if (!fs.existsSync(exePath)) {
  console.error(`[generate-latest-yml] Expected built artifact not found: ${exePath}`);
  process.exit(1);
}

function apiRequest(method, urlPath, { body, headers = {}, host = 'api.github.com' } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method,
        host,
        path: urlPath,
        headers: {
          'User-Agent': 'voyd-desktop-publish-script',
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          ...headers,
        },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(`${method} ${host}${urlPath} -> ${res.statusCode}: ${data.toString()}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const fileBuf = fs.readFileSync(exePath);
  const sha512 = crypto.createHash('sha512').update(fileBuf).digest('base64');
  const size = fileBuf.length;
  const releaseDate = new Date().toISOString();

  const yml =
    `version: ${version}\n` +
    `files:\n` +
    `  - url: ${artifactName}\n` +
    `    sha512: ${sha512}\n` +
    `    size: ${size}\n` +
    `path: ${artifactName}\n` +
    `sha512: ${sha512}\n` +
    `releaseDate: '${releaseDate}'\n`;

  const tag = `v${version}`;
  console.log(`[generate-latest-yml] Looking up release ${tag} on ${owner}/${repo}...`);
  const releaseRaw = await apiRequest('GET', `/repos/${owner}/${repo}/releases/tags/${tag}`);
  const release = JSON.parse(releaseRaw.toString());

  // If a latest.yml asset already exists on this release (re-run), delete it first — upload doesn't overwrite.
  const existing = (release.assets || []).find(a => a.name === 'latest.yml');
  if (existing) {
    console.log('[generate-latest-yml] Removing existing latest.yml asset before re-upload...');
    await apiRequest('DELETE', `/repos/${owner}/${repo}/releases/assets/${existing.id}`);
  }

  console.log(`[generate-latest-yml] Uploading latest.yml (${size} bytes, sha512 ${sha512.slice(0, 12)}...) to release ${tag}...`);
  await apiRequest('POST', `/repos/${owner}/${repo}/releases/${release.id}/assets?name=latest.yml`, {
    body: yml,
    host: 'uploads.github.com',
    headers: {
      'Content-Type': 'text/yaml',
      'Content-Length': Buffer.byteLength(yml),
    },
  });

  console.log('[generate-latest-yml] latest.yml uploaded successfully.');
}

main().catch(err => {
  console.error('[generate-latest-yml] Failed:', err.message);
  process.exit(1);
});
