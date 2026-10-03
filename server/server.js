'use strict';
const api = require('./api');
const store = require('./store');

try { require('./seed'); } catch (_) {}
// 首次启动若无数据则自动播种
if (store.all('matches').length === 0) {
  require('./seed').reset(true);
  console.log('[server] auto-seeded');
}
const port = Number(process.env.PORT || 4173);
api.createServer().listen(port, () => console.log(`赛事切片策划系统: http://localhost:${port}`));
