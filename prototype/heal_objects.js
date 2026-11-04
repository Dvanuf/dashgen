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
const SKIP = ['qInfo', 'qMetaDef', 'qHyperCubeDef', 'qListObjectDef', 'qExtendsId', 'qStateName'];
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function fill(t, s) {
  for (const k of Object.keys(s)) {
    if (SKIP.includes(k)) continue;
    if (!(k in t)) t[k] = JSON.parse(JSON.stringify(s[k]));
    else if (isObj(t[k]) && isObj(s[k])) fill(t[k], s[k]);
  }
}
(async () => {
  const global = await session.open();
  const docs = await global.getDocList();
  const d = docs.filter(x => x.qDocName === CONFIG.appName).pop();
  const app = await global.openDoc(d.qDocId);
  const infos = await app.getAllInfos();
  const types = ['barchart', 'linechart', 'table'];
  const byType = {};
  for (const i of infos.filter(i => types.includes(i.qType))) {
    const o = await app.getObject(i.qId);
    const p = await o.getProperties();
    (byType[i.qType] = byType[i.qType] || []).push({ id: i.qId, o, p });
  }
  const templates = {};
  for (const t of types) {
    const list = byType[t] || [];
    const tpl = list.find(x => x.id.length !== 36);
    const targets = list.filter(x => x.id.length === 36);
    if (!tpl) { console.log(t + ': нет копии, созданной в интерфейсе, пропуск'); continue; }
    templates[t] = tpl.p;
    for (const x of targets) {
      fill(x.p, tpl.p);
      await x.o.setProperties(x.p);
      console.log(t + ': дополнен объект ' + (x.p.title || x.id));
    }
  }
  await app.doSave();
  fs.writeFileSync(__dirname + '/templates.json', JSON.stringify(templates, null, 2));
  console.log('Готово. Обновите лист в Hub (Cmd+R). Шаблоны сохранены в templates.json');
  await session.close();
})().catch(e => { console.error('Ошибка:', e.message || e); process.exit(1); });
