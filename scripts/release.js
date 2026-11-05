#!/usr/bin/env node
// Релизный конвейер Dashgen: bump версии → сборка DMG → архив в releases/ → RELEASES.md → тег.
// Использование: npm run release -- [patch|minor|major|X.Y.Z] «описание версии»
//   npm run release              → patch (0.2.0 → 0.2.1)
//   npm run release -- minor     → 0.2.0 → 0.3.0
//   npm run release -- 1.0.0     → точная версия
// DMG (~120 МБ) в GitHub не попадает (лимит файла 100 МБ): архив хранится локально
// в releases/vX.Y.Z/, в git — версия, RELEASES.md и тег vX.Y.Z (код любой версии восстановим).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const bumpArg = args[0] && !/^\d/.test(args[0]) && ['patch', 'minor', 'major'].includes(args[0]) ? args[0] : null;
const explicit = args[0] && /^\d+\.\d+\.\d+$/.test(args[0]) ? args[0] : null;
const note = args.find(a => a !== args[0] || (!bumpArg && !explicit)) || '';

function sh(cmd) {
  console.log('$ ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

// 1. Версия
const pkgPath = path.join(ROOT, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const oldV = pkg.version;
let newV = explicit;
if (!newV) {
  const [maj, min, pat] = oldV.split('.').map(Number);
  const b = bumpArg || 'patch';
  newV = b === 'major' ? `${maj + 1}.0.0` : b === 'minor' ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}
pkg.version = newV;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`Версия: ${oldV} → ${newV}`);

// 2. Сборка DMG
sh('npx electron-builder --mac dir dmg');
const dmgSrc = path.join(ROOT, 'dist', `Dashgen-${newV}-arm64.dmg`);
if (!fs.existsSync(dmgSrc)) {
  console.error('DMG не собран, релиз прерван (версия в package.json: ' + newV + ')');
  process.exit(1);
}

// 3. Архив установщика
const relDir = path.join(ROOT, 'releases', 'v' + newV);
fs.mkdirSync(relDir, { recursive: true });
fs.copyFileSync(dmgSrc, path.join(relDir, `Dashgen-${newV}-arm64.dmg`));
console.log('Установщик: releases/v' + newV + '/Dashgen-' + newV + '-arm64.dmg');

// 4. RELEASES.md — журнал версий (старые установщики остаются в releases/)
const relMd = path.join(ROOT, 'RELEASES.md');
const line = `- **v${newV}** (${new Date().toLocaleDateString('ru')}) — установщик: releases/v${newV}/. ${note || ''}\n`;
fs.appendFileSync(relMd, line);

// 5. Git: коммит версии + тег (без DMG)
sh('git add package.json package-lock.json RELEASES.md');
sh(`git commit -m "Версия ${newV}${note ? ': ' + note : ''}"`);
sh(`git tag v${newV}`);
sh('git pull --rebase origin main || true');
sh('git push');
sh('git push origin v' + newV);
console.log('Релиз v' + newV + ' готов: DMG в releases/v' + newV + '/, тег v' + newV + ' запушен.');
