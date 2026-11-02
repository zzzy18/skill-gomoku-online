const TEST_LOADOUT = ['shield','sand','stealth','double','crater','ink'];
/** 验证铁索连环：1 费、可在灵力=1 时使用 */
const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const room = 'S' + Date.now().toString(36).slice(-4).toUpperCase();

function mk() {
  const s = io('http://127.0.0.1:8080', { transports:['websocket'], reconnection:false });
  const st = [];
  s.on('syncState', m => st.push(m));
  return new Promise((res, rej) => {
    s.on('connect', () => { s.emit('joinRoom', room);
    s.emit('setLoadout', TEST_LOADOUT);
      const w = () => st.length ? res({s, snap:()=>st[st.length-1], role:st[0].role}) : setTimeout(w,20); w(); });
    s.on('connect_error', e => rej(new Error(e.message)));
  });
}

(async () => {
  const a = await mk(), b = await mk();
  console.log('初始灵力 A=' + a.snap().state.mp[1] + '  B=' + a.snap().state.mp[2]);

  if (a.snap().state.mp[1] !== 1) { console.log('✗ 先手初始灵力应为 1'); process.exit(1); }
  console.log('✓ 先手初始 1 点 / 后手 2 点');

  // A 有 1 点灵力，理论上能直接用铁索
  const st = a.snap().state;
  if (st.currentPlayer !== 1) { console.log('不轮到 A，测试无效'); process.exit(1); }

  // A 先落一子（有子才能加盾）
  a.s.emit('boardAction', { r: 7, c: 7 });
  await sleep(200);
  // B 落一子
  b.s.emit('boardAction', { r: 6, c: 6 });
  await sleep(200);

  const s2 = a.snap().state;
  console.log('各落一子后 A 灵力=' + s2.mp[1] + '  轮到: ' + s2.currentPlayer);

  // 等轮到 A
  for (let i = 0; i < 10 && a.snap().state.currentPlayer !== 1; i++) {
    if (a.snap().state.currentPlayer === 2) b.s.emit('boardAction', { r: 5 + i, c: 5 + i });
    else a.s.emit('boardAction', { r: 4 + i, c: 4 + i });
    await sleep(160);
  }

  const s3 = a.snap().state;
  console.log('轮到 A 时 灵力=' + s3.mp[1]);

  if (s3.mp[1] < 1) { console.log('灵力不足 ' + s3.mp[1]); process.exit(1); }

  // 给自己的子加盾
  const mpBefore = s3.mp[1];
  a.s.emit('boardAction', { r: 7, c: 7, skill: 'shield' });
  await sleep(300);

  const after = a.snap().state;
  const shielded = after.shields[7][7];
  console.log('');
  console.log('【铁索连环验证】');
  console.log('  灵力   ' + mpBefore + ' → ' + after.mp[1] + (after.mp[1] === mpBefore - 1 ? '  ✓ 只扣 1 点' : '  ✗ 扣了 ' + (mpBefore - after.mp[1]) + ' 点'));
  console.log('  护盾   ' + (shielded ? '✓ 已施加' : '✗ 未施加'));
  console.log('  状态栏 ' + after.statusText);

  a.s.close(); b.s.close();
  process.exit(shielded && after.mp[1] === mpBefore - 1 ? 0 : 1);
})();
