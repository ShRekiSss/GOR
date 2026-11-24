// Тесты клиентов, залитых на GitHub Releases: состав ассетов, версии,
// контрольные суммы, доступность скачивания и локальные артефакты сборки.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS', name);
  else { fails++; console.log('FAIL', name, extra ?? ''); }
}

const expected = [
  'gor-desktop.exe',
  'gor-linux-amd64.tar.gz',
  'gor-windows-amd64.zip',
  'VAKSA-universal.apk',
  'VAKSA_1.0.4_amd64.AppImage',
  'VAKSA_1.0.4_amd64.deb',
  'VAKSA_1.0.4_x64-setup.exe',
  'VAKSA_1.0.4_x64_en-US.msi',
];

function localArtifacts() {
  const exe = path.join(root, 'build', 'gor.exe');
  check('локальный сервер build/gor.exe собран', fs.existsSync(exe) && fs.statSync(exe).size > 1e6);
  if (fs.existsSync(exe)) {
    check('локальный сервер — PE-файл (MZ)', fs.readFileSync(exe).subarray(0, 2).toString() === 'MZ');
  }
  const index = path.join(root, 'frontend', 'build', 'index.html');
  check('локальный веб-клиент frontend/build есть', fs.existsSync(index));
  if (fs.existsSync(index)) {
    const html = fs.readFileSync(index, 'utf8');
    check('веб-клиент подключает JS/CSS', /static\/js\/main\..*\.js/.test(html) && /static\/css\/main\..*\.css/.test(html));
  }
}

async function releaseAssets() {
  const res = await fetch('https://api.github.com/repos/ShRekiSss/GOR/releases/latest', {
    headers: { 'User-Agent': 'gor-release-test', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('GitHub API: HTTP ' + res.status);
  const release = await res.json();
  const version = JSON.parse(read('frontend/package.json')).version;
  const tauriVersion = JSON.parse(read('desktop/src-tauri/tauri.conf.json')).version;
  const makeVersion = (read('Makefile').match(/VERSION\s*\?=\s*([\d.]+)/) || [])[1];

  check('версии локально согласованы', version === tauriVersion && version === makeVersion,
    `${version} / ${tauriVersion} / ${makeVersion}`);
  check('тег релиза совпадает с версией', release.tag_name === 'v' + version,
    `${release.tag_name} != v${version}`);

  const names = release.assets.map((a) => a.name);
  for (const name of expected) {
    check('ассет ' + name, names.includes(name));
  }
  check('лишних ассетов нет', names.length === expected.length, names.join(', '));

  for (const a of release.assets) {
    check(`${a.name}: размер > 100 КБ`, a.size > 1024 * 100, String(a.size));
    check(`${a.name}: sha256 в API`, /^sha256:[0-9a-f]{64}$/.test(a.digest || ''), a.digest);
    check(`${a.name}: state=uploaded`, a.state === 'uploaded');
    check(`${a.name}: ссылка скачивания`, /^https:\/\/github\.com\/ShRekiSss\/GOR\/releases\/download\//.test(a.browser_download_url));
  }

  // Реальные скачивания: заголовок файла + полная сверка sha256 лёгкого инсталлятора.
  for (const [name, magic] of [['gor-desktop.exe', 'MZ'], ['VAKSA-universal.apk', 'PK']]) {
    const asset = release.assets.find((a) => a.name === name);
    if (!asset) continue;
    const r = await fetch(asset.browser_download_url, {
      headers: { 'User-Agent': 'gor-release-test', Range: 'bytes=0-15' },
    });
    const head = Buffer.from(await r.arrayBuffer());
    check(`${name}: скачивается (${r.status})`, [200, 206].includes(r.status) && head.subarray(0, 2).toString() === magic,
      `status=${r.status} head=${head.subarray(0, 2).toString()}`);
  }

  const setup = release.assets.find((a) => a.name === 'VAKSA_1.0.4_x64-setup.exe');
  if (setup) {
    const r = await fetch(setup.browser_download_url, { headers: { 'User-Agent': 'gor-release-test' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const hash = 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
    check('инсталлятор: sha256 совпадает с GitHub', hash === setup.digest, `${hash} != ${setup.digest}`);
  }

  const head = require('child_process').execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  console.log(`ИНФО: локальный HEAD=${head}, релиз ${release.tag_name} опубликован ${release.published_at} — свежие правки требуют нового тега`);
}

(async () => {
  localArtifacts();
  await releaseAssets();
  console.log(fails ? `ИТОГ: ${fails} ПРОВАЛОВ` : 'ИТОГ: ВСЁ ОК');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
