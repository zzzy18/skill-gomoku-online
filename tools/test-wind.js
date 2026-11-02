/**
 * 最小验证：只测 sand 的吹歪行为，不做复杂的攒灵力循环。
 * 思路：直接用两个客户端，各自轮流落子，每步都等状态更新。
 */
const { io } = require('socket.io-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const room = 'V' + Date.now().toString(36).slice(-4).toUpperCase();

function mk() {
  const s = io('http://127.0.0.1:8080', { transports:['websocket'], reconnection:false });
  const st = [];
  s.on('syncState', m => st.push(m));
  return new Promise(res => s.on('connect', () => {
    s.emit('joinRoom', room);
    const w = () => st.length ? res({s, st, snap: () => st[st.length-1]}) : setTimeout(w, 20);
    w();
  }));
}

(async () => {
  const a = await mk(), b = await mk();
  const board = () => a.snap().state.board;
  const cnt = () => board().flat().filter(v => v !== 0).length;

  // 轮流落子 8 手（B 落在 7,7 附近，留出周围空间）
  const bSpots = [[7,7],[6,6],[8,8],[7,6]];
  let bi = 0;

  for (let i = 0; i < 8; i++) {
    const snap = a.snap();
    const turn = snap.state.currentPlayer;
    const me = turn === 1 ? a : b;
    const before = cnt();

    let r, c;
    if (turn === 2 && bi < bSpots.length) {
      [r, c] = bSpots[bi++];
      if (board()[r][c] !== 0) { const f = firstFree(); r = f.r; c = f.c; }
    } else {
      const f = firstFree(); r = f.r; c = f.c;
    }

    me.s.emit('boardAction', { r, c });

    // 等棋子数增加
    const t0 = Date.now();
    while (Date.now() - t0 < 2000) {
      await sleep(20);
      if (cnt() > before) break;
    }
  }

  function firstFree() {
    const bd = board();
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++)
      if (bd[r][c] === 0) return { r, c };
    return { r: 0, c: 0 };
  }

  const s = a.snap().state;
  let n1 = 0, n2 = 0;
  for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) {
    if (s.board[r][c] === 1) n1++;
    if (s.board[r][c] === 2) n2++;
  }
  console.log('落子 8 手后 → 黑:' + n1 + ' 白:' + n2 + ' A灵力:' + s.mp[1] + ' 回合:' + s.currentPlayer);

  if (n2 === 0 || s.mp[1] < 2 || s.currentPlayer !== 1) {
    console.log('前置条件不足，跳过');
    process.exit(0);
  }

  // 找一个白子吹
  let target = null;
  for (let r = 0; r < 15 && !target; r++)
    for (let c = 0; c < 15; c++)
      if (s.board[r][c] === 2) { target = { r, c }; break; }

  const before = cnt();
  const mpBefore = s.mp[1];
  a.s.emit('boardAction', { r: target.r, c: target.c, skill: 'sand' });

  const t0 = Date.now();
  while (Date.now() - t0 < 2000) { await sleep(20); if (a.snap().state.mp[1] !== mpBefore) break; }

  const after = a.snap().state;
  const afterCnt = after.board.flat().filter(v => v !== 0).length;
  const wind = after.craters.find(c => c.r === target.r && c.c === target.c);

  console.log('');
  console.log('【吹歪测试】目标 (' + target.r + ',' + target.c + ')');
  console.log('  棋子数 ' + before + ' → ' + afterCnt + (afterCnt === before ? '  ✓ 不变（吹歪非删除）' : '  ✗ 变了'));
  console.log('  灵力   ' + mpBefore + ' → ' + after.mp[1] + (after.mp[1] === mpBefore - 2 ? '  ✓ 扣 2 点' : '  ✗ 未正确扣除'));
  console.log('  风眼   ' + (wind ? '✓ 已留下 type=' + wind.type + ' duration=' + wind.duration : '✗ 未生成'));

  let moved = 0;
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = target.r + dr, nc = target.c + dc;
    if (nr < 0 || nr >= 15 || nc < 0 || nc >= 15) continue;
    if (after.board[nr][nc] === 2) moved++;
  }
  console.log('  周围 8 格内的白子: ' + moved + (moved > 0 ? '  ✓ 敌子被吹到附近' : '  ✗ 附近无敌子'));

  a.s.close(); b.s.close();
  process.exit(0);
})();
