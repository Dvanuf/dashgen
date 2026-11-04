#!/usr/bin/env node
// CLI Dashgen — единая точка входа.
// Команды:
//   node cli.js check <spec.json>                — валидация spec по схеме
//   node cli.js profile <файл.xlsx|.qvd>         — профиль источника + безопасный профиль для ИИ
//   node cli.js build <spec.json> [--verify]     — сборка приложения в Qlik (+ проверка)
// Опции: --config <путь к config.json>, --sheet <имя листа Excel>
const path = require('path');
const fs = require('fs');

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const configPath = argValue(argv, '--config');
  const sheet = argValue(argv, '--sheet');

  const { loadConfig } = require('./src/config');
  const { loadSpec, validateSpec } = require('./src/spec-validator');
  const { profileSource } = require('./src/sources');

  if (cmd === 'check') {
    const spec = JSON.parse(fs.readFileSync(path.resolve(argv[1]), 'utf8'));
    const result = validateSpec(spec);
    if (result.ok) { console.log('spec.json валиден: схема v1 и ссылки на меры/измерения корректны'); return; }
    console.error('spec.json НЕ валиден:');
    for (const e of result.errors) console.error(' -', e);
    process.exit(1);
  }

  if (cmd === 'profile') {
    const cfg = loadConfig(configPath);
    const filePath = argv[1];
    if (!filePath) throw new Error('Укажите файл: node cli.js profile data.xlsx');
    const type = filePath.toLowerCase().endsWith('.qvd') ? 'qvd' : 'excel';
    const sourceProfile = profileSource(type, filePath, { sheet });
    console.log('=== SourceProfile (локально) ===');
    console.log(JSON.stringify(sourceProfile, null, 2));
    const privacy = require('./src/privacy');
    const safe = privacy.makeSafeProfile(sourceProfile, cfg.privacy);
    console.log('=== Безопасный профиль для ИИ (mode: schema, dry run) ===');
    console.log(JSON.stringify(safe, null, 2));
    console.log('Отправка не выполнена — dry run. Для отправки потребуется подтверждение.');
    return;
  }

  if (cmd === 'build') {
    if (!argv[1]) throw new Error('Укажите spec: node cli.js build spec.json');
    const cfg = loadConfig(configPath);
    const spec = loadSpec(argv[1]);
    const builder = require('./src/builder');
    const result = await builder.build(spec, cfg);
    if (argv.includes('--verify')) {
      const { verify, printReport } = require('./src/verify');
      const report = await verify(cfg, result.appId, spec, result);
      printReport(report);
      if (report.objectErrors.length || report.rowsMatch === false) process.exit(2);
    }
    return;
  }

  console.log('Команды: check <spec.json> | profile <файл.xlsx|.qvd> [--sheet Лист1] | build <spec.json> [--verify]');
  process.exit(cmd ? 1 : 0);
}

main().catch(e => {
  console.error('Ошибка:', e && e.message ? e.message : e);
  process.exit(1);
});
