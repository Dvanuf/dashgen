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
function flat(o, p, out) {
  if (o !== null && typeof o === 'object') {
    const ks = Object.keys(o);
    if (!ks.length) out[p] = Array.isArray(o) ? '[]' : '{}';
    for (const k of ks) flat(o[k], p ? p + '.' + k : k, out);
  } else out[p] = JSON.stringify(o);
  return out;
}
(async () => {
  const global = await session.open();
  const docs = await global.getDocList();
  const d = docs.filter(x => x.qDocName === CONFIG.appName).pop();
  const app = await global.openDoc(d.qDocId);
  const infos = await app.getAllInfos();
  const bars = [];
  for (const i of infos.filter(i => i.qType === 'barchart')) {
    const p = await (await app.getObject(i.qId)).getProperties();
    bars.push({ id: i.qId, p });
  }
  console.log('Найдено столбчатых диаграмм:', bars.length, bars.map(b => b.id));
  const orig = bars.find(b => b.id.length === 36);
  const copy = bars.find(b => b.id.length !== 36);
  if (orig) fs.writeFileSync('bar_original.json', JSON.stringify(orig.p, null, 2));
  if (copy) fs.writeFileSync('bar_copy.json', JSON.stringify(copy.p, null, 2));
  if (orig && copy) {
    const a = flat(orig.p, '', {}), b = flat(copy.p, '', {});
    console.log('\n=== ТОЛЬКО В КОПИИ (работает) ===');
    Object.keys(b).filter(k => !(k in a)).forEach(k => console.log(k, '=', b[k]));
    console.log('\n=== ОТЛИЧАЮТСЯ ===');
    Object.keys(b).filter(k => k in a && a[k] !== b[k] && !k.startsWith('qInfo.qId')).forEach(k => console.log(k, ':', a[k], '->', b[k]));
    console.log('\n=== ТОЛЬКО В ОРИГИНАЛЕ ===');
    Object.keys(a).filter(k => !(k in b)).forEach(k => console.log(k, '=', a[k]));
  } else console.log('Не нашёл пару (оригинал + копия). Проверьте, что копия сохранена на листе.');
  await session.close();
})().catch(e => { console.error('Ошибка:', e.message || e); process.exit(1); });
