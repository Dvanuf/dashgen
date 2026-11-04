const enigma = require('enigma.js');
const WebSocket = require('ws');
const fs = require('fs');
const schema = require('enigma.js/schemas/12.612.0.json');

const src = fs.readFileSync(__dirname + '/build_test_dashboard.js', 'utf8');
const CONFIG = eval('(' + src.match(/const CONFIG = (\{[\s\S]*?\});/)[1] + ')');

const session = enigma.create({
  schema,
  url: `wss://${CONFIG.host}:${CONFIG.port}/app/engineData`,
  createSocket: url => new WebSocket(url, {
    ca: [fs.readFileSync(`${CONFIG.certDir}/root.pem`)],
    cert: fs.readFileSync(`${CONFIG.certDir}/client.pem`),
    key: fs.readFileSync(`${CONFIG.certDir}/client_key.pem`),
    headers: { 'X-Qlik-User': `UserDirectory=${CONFIG.userDirectory}; UserId=${CONFIG.userId}` },
    rejectUnauthorized: CONFIG.rejectUnauthorized
  })
});

async function check(app, id, indent) {
  const obj = await app.getObject(id);
  const l = await obj.getLayout();
  const type = l.visualization || l.qInfo.qType;
  const cube = l.qHyperCube;
  const list = l.qListObject;
  let status = 'OK';
  if (l.qError) status = 'ОШИБКА объекта: ' + JSON.stringify(l.qError);
  else if (cube && cube.qError) status = 'ОШИБКА гиперкуба: ' + JSON.stringify(cube.qError);
  else if (list && list.qError) status = 'ОШИБКА листбокса: ' + JSON.stringify(list.qError);
  else if (cube) status = `OK (строк: ${cube.qSize.qcy}, колонок: ${cube.qSize.qcx})`;
  console.log(`${indent}${type.padEnd(12)} ${(l.title || '').toString().padEnd(32)} ${status}`);
  if (l.qChildList && l.qChildList.qItems) {
    for (const c of l.qChildList.qItems) await check(app, c.qInfo.qId, indent + '   ');
  }
}

(async () => {
  const global = await session.open();
  const docs = await global.getDocList();
  const d = docs.filter(x => x.qDocName === CONFIG.appName).pop();
  if (!d) throw new Error('Приложение не найдено: ' + CONFIG.appName);
  const app = await global.openDoc(d.qDocId);
  const infos = await app.getAllInfos();
  const sheets = infos.filter(i => i.qType === 'sheet');
  console.log('Листов:', sheets.length);
  for (const s of sheets) {
    const sheet = await app.getObject(s.qId);
    const sl = await sheet.getLayout();
    console.log('\nЛист:', sl.qMeta.title, '| ячеек:', (sl.cells || []).length);
    for (const c of sl.cells || []) {
      try { await check(app, c.name, '  '); }
      catch (e) { console.log(`  ${c.type.padEnd(12)} ${c.name}  НЕ ОТКРЫВАЕТСЯ: ${e.message}`); }
    }
  }
  await session.close();
})().catch(e => { console.error('Ошибка:', e.message || e); process.exit(1); });
