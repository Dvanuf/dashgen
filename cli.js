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

  // Список приложений сервера (цели для attach)
  if (cmd === 'apps') {
    const cfg = loadConfig(configPath);
    const qrs = require('./src/qrs');
    const apps = await qrs.listApps(cfg);
    for (const a of apps.sort((x, y) => x.name.localeCompare(y.name))) {
      console.log((a.published ? '[опубл.] ' : '         ') + a.id + '  ' + a.name + (a.stream ? '  → ' + a.stream.name : ''));
    }
    console.log('Всего: ' + apps.length);
    return;
  }

  // Правка существующего дашборда: подключение без удаления (reconcile листов из спеки)
  if (cmd === 'patch') {
    if (!argv[1]) throw new Error('Укажите spec: node cli.js patch spec.json --app <id|имя>');
    const cfg = loadConfig(configPath);
    const spec = loadSpec(argv[1]);
    const builder = require('./src/builder');
    const result = await builder.build(spec, cfg, console.log, {
      mode: 'attach',
      target: argValue(argv, '--app'),
      noReload: argv.includes('--no-reload')
    });
    if (argv.includes('--verify')) {
      const { verify, printReport } = require('./src/verify');
      const report = await verify(cfg, result.appId, spec, result);
      printReport(report);
      if (report.objectErrors.length) process.exit(2);
    }
    return;
  }

  // Фиксация правок из Qlik-клиента: фактическое состояние приложения → spec (fixed:true)
  if (cmd === 'sync') {
    if (!argv[1]) throw new Error('Укажите spec: node cli.js sync spec.json --app <id|имя>');
    const cfg = loadConfig(configPath);
    const spec = loadSpec(argv[1]);
    const appId = argValue(argv, '--app') || spec.appId;
    if (!appId) throw new Error('Укажите приложение: --app <id|имя> (или node cli.js apps — список)');
    const { syncBack } = require('./src/sync-back');
    const qrs = require('./src/qrs');
    const resolved = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(appId)
      ? appId : (await qrs.findAppByName(cfg, appId) || {}).id;
    if (!resolved) throw new Error('приложение не найдено: ' + appId);
    const { spec: fixedSpec } = await syncBack(cfg, resolved, spec, console.log);
    const out = argValue(argv, '-o');
    const inPlace = argv.includes('--in-place');
    const outPath = out || (inPlace ? path.resolve(argv[1]) : path.resolve(argv[1]).replace(/\.json$/i, '.fixed.json'));
    fs.writeFileSync(outPath, JSON.stringify(fixedSpec, null, 2));
    console.log('Зафиксированный spec: ' + outPath + (inPlace ? ' (перезаписан исходный)' : ''));
    return;
  }

  console.log('Команды: check <spec.json> | profile <файл.xlsx|.qvd> [--sheet Лист1] | build <spec.json> [--verify] | apps | patch <spec.json> --app <id|имя> [--no-reload] [--verify] | sync <spec.json> --app <id|имя> [--in-place|-o файл]');
  process.exit(cmd ? 1 : 0);
}

main().catch(e => {
  console.error('Ошибка:', e && e.message ? e.message : e);
  process.exit(1);
});
