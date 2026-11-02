/**
 * 公网断线重连验证（带超时兜底，不会挂死）
 * 用法：node tools/online-resume.js
 */

'use strict';

const { io } = require('socket.io-client');

const ORIGIN = 'http://182.92.63.63';
const PATH = '/gomoku-v2/socket.io/';
const room = 'OR' + Date.now().toString(36).slice(-4).toUpperCase();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带兜底超时的连接 + 进房 */
function joinRoom(label) {
  return new Promise((resolve) => {
    const s = io(ORIGIN, { path: PATH, transports: ['websocket'], reconnection: false, timeout: 8000 });
    let sess = null;
    let state = null;

    const done = () => resolve({ s, sess: () => sess, state: () => state, ok: !!sess });

    // 兜底：最多 12 秒，无论成败都返回
    const killer = setTimeout(() => {
      console.log(`  [${label}] 超时（connect=${s.connected}）`);
      resolve({ s, sess: () => null, state: () => null, ok: false });
    }, 12000);

    s.on('session', (se) => {
      sess = se;
      clearTimeout(killer);
      setTimeout(done, 300);
    });
    s.on('syncState', (m) => (state = m));
    s.on('connect', () => s.emit('joinRoom', room));
    s.on('connect_error', (e) => {
      console.log(`  [${label}] 连接失败: ${e.message}`);
      clearTimeout(killer);
      resolve({ s, sess: () => null, state: () => null, ok: false });
    });
  });
}

/** 带 token 恢复 */
function resumeRoom(token) {
  return new Promise((resolve) => {
    const s = io(ORIGIN, { path: PATH, transports: ['websocket'], reconnection: false, timeout: 8000 });
    let sess = null;
    let state = null;

    const done = () => resolve({ s, sess: () => sess, state: () => state, ok: !!sess });

    const killer = setTimeout(() => {
      console.log(`  [resume] 超时`);
      resolve({ s, sess: () => null, state: () => null, ok: false });
    }, 12000);

    s.on('session', (se) => {
      sess = se;
      clearTimeout(killer);
      setTimeout(done, 500); // 多等一会，让 syncState 也到达
    });
    s.on('syncState', (m) => (state = m));
    s.on('connect', () => s.emit('resume', { roomId: room, token }));
    s.on('connect_error', (e) => {
      console.log(`  [resume] 连接失败: ${e.message}`);
      clearTimeout(killer);
      resolve({ s, sess: () => null, state: () => null, ok: false });
    });
  });
}

async function main() {
  console.log('');
  console.log(`\x1b[1m公网断线重连验证\x1b[0m  ${ORIGIN}/gomoku-v2/  房间 ${room}`);
  console.log('─'.repeat(52));

  const a = await joinRoom('A');
  if (!a.ok) {
    console.log('✗ A 连接失败，终止');
    process.exit(1);
  }
  console.log(`✓ A 进房 角色=${a.sess().role} token=${a.sess().token.slice(0, 8)}…`);

  const b = await joinRoom('B');
  if (!b.ok) {
    console.log('✗ B 连接失败，终止');
    process.exit(1);
  }
  console.log(`✓ B 进房 角色=${b.sess().role}`);

  // A 落一子
  a.s.emit('boardAction', { r: 7, c: 7 });
  await sleep(400);
  const st1 = a.state();
  const stones = st1 ? st1.state.board.flat().filter((v) => v !== 0).length : 0;
  console.log(`✓ A 落子 (7,7)，棋子数=${stones}`);

  // 断线
  a.s.close();
  await sleep(500);
  console.log(`✓ A 已断线（座位保留期 90 秒）`);

  // 重连
  console.log('');
  console.log('【重连验证】');
  const a2 = await resumeRoom(a.sess().token);
  if (a2.ok) {
    const role = a2.sess().role;
    console.log(`  ★ resume 成功  恢复角色=${role}`);

    const st = a2.state();
    if (st) {
      const kept = st.state.board.flat().filter((v) => v !== 0).length;
      console.log(`  ${kept === stones ? '★' : '✗'} 棋盘保留    ${kept} 颗子（断线前 ${stones}）`);
      console.log(`  · 在线人数   ${st.onlineCount}`);
      console.log(`  · 你的视角   role=${st.role}`);

      // 落子验证座位真的恢复了
      if (st.state.currentPlayer === role) {
        const before = a2.state();
        a2.s.emit('boardAction', { r: 9, c: 9 });
        await sleep(500);
        const after = a2.state();
        const moved = after && after.state.board[9][9] === role;
        console.log(`  ${moved ? '★' : '✗'} 重连后落子  ${moved ? '成功，座位完全恢复' : '失败'}`);
      } else {
        console.log('  · 当前不轮到 A，落子验证跳过');
      }
    } else {
      console.log('  ✗ 未收到状态');
    }
  } else {
    console.log('  ✗ resume 失败');
  }

  // 伪造令牌
  console.log('');
  console.log('【令牌安全】');
  const fake = await resumeRoom('FAKE-TOKEN-XYZ');
  console.log(`  ${!fake.ok ? '★' : '✗'} 伪造令牌 ${!fake.ok ? '被拒绝' : '竟然成功了！'}`);

  a2.s && a2.s.close();
  b.s.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('异常:', e.message);
  process.exit(1);
});