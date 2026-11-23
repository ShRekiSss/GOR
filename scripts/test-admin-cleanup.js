// Тест админки и чистоты репозитория (статические инварианты + git).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

let fails = 0;
function check(name, cond) {
  if (cond) console.log('PASS', name);
  else { fails++; console.log('FAIL', name); }
}

const api = read('serverless/src/api.ts');
const app = read('frontend/src/App.jsx');
const gitignore = read('.gitignore');

check('ban удаляет аккаунт безвозвратно',
  /seg\[4\] === 'ban'[\s\S]{0,900}deleteUserAccount\(env, target\)/.test(api));
check('ban требует подтверждения ником',
  /seg\[4\] === 'ban'[\s\S]{0,700}body\.confirm[\s\S]{0,300}victim\.username/.test(api));
check('ban пишет отдельный audit action',
  api.includes("'ban_delete'"));
check('главный админ защищён от других админов',
  api.includes("target === MAIN_ADMIN_ID && me.id !== MAIN_ADMIN_ID"));
check('в UI нет «разбанить»', !app.includes('разбанить'));
check('кнопка бана ведёт в модалку подтверждения',
  app.includes("mode: 'ban', user: u, input: ''"));
check('админка: сортировка и счётчик',
  app.includes('adminSort') && app.includes('Показано {adminFiltered.length}'));
check('.wrangler в gitignore', gitignore.includes('.wrangler/'));

const tracked = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8' });
check('учётные данные wrangler не в git',
  !tracked.includes('serverless/.wrangler/cache/wrangler-account.json'));
check('база и бэкапы не в git', !/\.(db|db-wal|db-shm|exe|zip|tar\.gz)$/m.test(tracked));

console.log(fails ? `ИТОГ: ${fails} ПРОВАЛОВ` : 'ИТОГ: ВСЁ ОК');
process.exit(fails ? 1 : 0);
