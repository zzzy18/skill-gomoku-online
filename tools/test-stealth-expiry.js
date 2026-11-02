/**
 * 隐身时效测试：隐形棋 3 回合后自动显形。
 *
 * 用法：node tools/test-stealth-expiry.js [端口]
 */

'use strict';

const { io } = require('socket.io-client');

const PORT = Number(process.argv[2]) || 8080;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass++;
  console.log(`  \x1b[0;32m✓\x1b[0m ${m}`);
};
const bad = (m) => {
  fail++;
  console.log(`  \x1b[0;31m✗\x1b[0m ${m}`);
};

async function join(socket, roomId) {
  const states = [];
  const logs = [];
  let session = null;
  socket.on('syncState', (m) => states.push(m));
  socket.on('newLog', (l) => logs.push(l));
  socket.on('session', (se) => (session = se));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), 7000);
    socket.on('connect', () => {
      socket.emit('joinRoom', roomId);
      const wait = () => {
        if (states.length) {
          clearTimeout(t);
          resolve();
        } else setTimeout(wait, 25);
      };
      wait();
    });
    socket.on('connect_error', (e) => {
      clearTimeout(t);
      reject(new Error(e.message));
    });
  });

  return {
    socket,
    states,
    logs,
    session: () => session,
    state: () => states[states.length - 1]?.state,
    close: () => socket.close(),
  };
}

const connect = () =>
  io(ORIGIN, { transports: ['websocket'], reconnection: false, timeout: 6000 });

/** 找一个空位（避开已有棋子和障碍） */
function freeCell(s, avoid = []) {
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (s.board[r][c] === 0 &&
          !s.craters.some((cr) => cr.r === r && cr.c === c) &&
          !avoid.some((a) => a.r === r && a.c === c)) {
        return { r, c };
      }
    }
  }
  return null;
}

/** 落一手并等状态更新 */
async function place(a, b, avoid, isStealth = false) {
  const s = a.state();
  const who = s.currentPlayer === 1 ? a : b;
  const spot = freeCell(s, avoid);
  if (!spot) return null;
  const before = a.states.length;
  const payload = { r: spot.r, c: spot.c };
  if (isStealth) payload.skill = 'stealth';
  who.socket.emit('boardAction', payload);
  const t0 = Date.now();
  while (Date.now() - t0 < 2500 && a.states.length <= before) await sleep(20);
  return spot;
}

async function main() {
  console.log('');
  console.log(`\x1b[1m隐身时效测试\x1b[0m  ${ORIGIN}`);
  console.log('─'.repeat(52));

  const room = 'ST' + Date.now().toString(36).slice(-4).toUpperCase();
  const a = await join(connect(), room);
  const b = await join(connect(), room);
  ok(`双人进房 ${room}`);

  // 攒灵力到 2，让 A 能放隐身
  for (let i = 0; i < 20; i++) {
    const s = a.state();
    if (!s) break;
    if (s.currentPlayer === 1 && s.mp[1] >= 2) break;
    await place(a, b, []);
    await sleep(60);
  }

  const s0 = a.state();
  if (!s0 || s0.currentPlayer !== 1 || s0.mp[1] < 2) {
    bad(`前置不足：turn=${s0?.currentPlayer} mp=${s0?.mp?.[1]}`);
    a.close();
    b.close();
    process.exit(1);
  }
  ok(`A 攒够灵力（${s0.mp[1]}）`);

  // A 放一枚隐身棋
  const spot = await place(a, b, [], true);
  await sleep(300);
  const s1 = a.state();
  const aSees = s1.board[spot.r][spot.c] === 1;
  const bSees = b.state().board[spot.r][spot.c] !== 0;

  if (aSees && !bSees) ok('★ 隐身棋已放置：本人可见 / 对手不可见');
  else bad(`视野异常：本人可见=${aSees} 对手可见=${bSees}`);

  // 检查倒计时初值（放完后立即 nextTurn，应剩 3）
  const remain = typeof s1.stealths[spot.r][spot.c] === 'number'
    ? s1.stealths[spot.r][spot.c]
    : -1;
  ok(`倒计时初值 = ${remain}（期望 3）`);

  // 逐一推进回合，观察何时显形
  let expiredAt = -1;
  for (let turn = 1; turn <= 6; turn++) {
    await place(a, b, [{ r: spot.r, c: spot.c }]);
    await sleep(150);
    const s = a.state();
    const stillHidden = !!s.stealths[spot.r][spot.c];
    const cnt = typeof s.stealths[spot.r][spot.c] === 'number' ? s.stealths[spot.r][spot.c] : 0;
    console.log(`     第 ${turn} 手后：剩余=${cnt} 隐身=${stillHidden ? '是' : '否'}`);
    if (!stillHidden) {
      expiredAt = turn;
      break;
    }
  }

  if (expiredAt > 0) {
    ok(`★ 第 ${expiredAt} 次落子后显形（期望 3 回合内）`);
  } else {
    bad('6 手后仍未显形，时效机制失效');
  }

  // 显形后棋子必须还在盘上
  const sAfter = a.state();
  if (sAfter.board[spot.r][spot.c] === 1) ok('★ 显形后棋子保留（未被销毁）');
  else bad('显形后棋子消失了');

  // 双方都应能看到
  if (b.state().board[spot.r][spot.c] === 1) ok('★ 显形后对手可见');
  else bad('显形后对手仍看不到');

  // 日志应有显形记录
  const revealLog = a.logs.concat(b.logs).some((l) => l.text && l.text.includes('到期显形'));
  if (revealLog) ok('日志记录了到期显形');
  else bad('日志缺少显形记录');

  a.close();
  b.close();

  console.log('');
  console.log('─'.repeat(52));
  if (fail === 0) console.log(`\x1b[0;32m全部通过\x1b[0m  ${pass} 项`);
  else console.log(`\x1b[0;31m${fail} 项失败\x1b[0m  ${pass} 项通过`);
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n测试异常:', err.message);
  process.exit(1);
});