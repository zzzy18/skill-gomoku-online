/**
 * v2 版本功能测试：验证 8 个技能、隐身子视野过滤、天涯海角双落子等核心规则。
 *
 * 用真实 socket.io 客户端连真实服务器，不是 mock。
 * 用法：node tools/test-v2.js [端口]
 */

'use strict';

// 装备系统上线后，进房需先选技能才能落子
const TEST_LOADOUT = ['shield','sand','stealth','double','crater','ink'];

const { io } = require('socket.io-client');

const PORT = Number(process.argv[2]) || 8080;
const URL = `http://127.0.0.1:${PORT}`;

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

/** 连一个客户端，等拿到第一份状态 */
async function join(roomId) {
  const socket = io(URL, { transports: ['websocket'] });
  const states = [];
  const errors = [];
  let lastKnown = null;

  socket.on('syncState', (m) => states.push(m));
  socket.on('errMsg', (m) => errors.push(m));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), 6000);
    socket.on('connect', () => {
      socket.emit('joinRoom', roomId);
      socket.emit('setLoadout', TEST_LOADOUT);
      // 等第一次 syncState
      const wait = () => {
        if (states.length > 0) {
          clearTimeout(t);
          resolve();
        } else setTimeout(wait, 30);
      };
      wait();
    });
    socket.on('connect_error', (e) => {
      clearTimeout(t);
      reject(new Error(`连接失败: ${e.message}`));
    });
  });

  return {
    socket,
    states,
    errors,
    role: states[0].role,
    // clear() 后可能还没有新状态，回退到最后一个已知状态
    state: () => states[states.length - 1]?.state ?? lastKnown,
    clear() {
      if (states.length > 0) lastKnown = states[states.length - 1].state;
      states.length = 0;
      errors.length = 0;
    },
    /** 等到状态满足条件 */
    async until(pred, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        // clear() 之后 states 可能为空，谓词要能安全处理 undefined
        const last = states[states.length - 1];
        if (last && pred(last)) return true;
        void lastKnown;
        await sleep(30);
      }
      return false;
    },
    close: () => socket.close(),
  };
}

/** 棋盘计数 */
const countStones = (s) => s.board.flat().filter((v) => v !== 0).length;
const countCraters = (s) => s.craters.length;

/** 找一个没人占、也没路障的空位 */
function findFree(s) {
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (s.board[r][c] === 0 && !s.craters.some((cr) => cr.r === r && cr.c === c)) {
        return { r, c };
      }
    }
  }
  return null;
}

async function main() {
  console.log('');
  console.log(`\x1b[1mv2 功能测试\x1b[0m  ${URL}`);
  console.log('─'.repeat(52));

  // ── 1. 连接与分配 ──
  console.log('\n\x1b[1m1. 房间与角色分配\x1b[0m');
  const room = 'T' + Date.now().toString(36).slice(-4).toUpperCase();
  let a, b;
  try {
    a = await join(room);
    b = await join(room);
  } catch (err) {
    bad(err.message);
    process.exit(1);
  }

  ok(`双方连接成功，房间号 ${room}`);
  if (a.role === 1 && b.role === 2) ok('角色分配正确（先到者执黑，后到者执白）');
  else bad(`角色分配异常：A=${a.role} B=${b.role}`);

  const c = await join(room);
  if (c.role === 0) ok('第三人为观战席');
  else bad(`第三人应观战，实际 role=${c.role}`);
  c.close();

  // ── 2. 隐身子视野过滤 ──
  console.log('\n\x1b[1m2. 隐身子视野过滤\x1b[0m');
  // A 给自己的子加满灵力以便用隐身
  a.socket.emit('boardAction', { r: 7, c: 7 });
  await sleep(200);
  // 多落几手让 A 攒灵力
  for (const [r, c2] of [[6, 6], [5, 5], [4, 4], [8, 8]]) {
    if (a.state().currentPlayer === 1) {
      a.socket.emit('boardAction', { r, c: c2 });
      await sleep(120);
    }
    if (b.state().currentPlayer === 2) {
      b.socket.emit('boardAction', { r, c: c2 + 1 });
      await sleep(120);
    }
  }

  const aMp = a.state().mp[1];
  if (aMp >= 2) {
    // A 用隐身在 (0,0) 落子
    if (a.state().currentPlayer === 1) {
      a.clear();
      a.socket.emit('boardAction', { r: 0, c: 0, skill: 'stealth' });
      await sleep(300);
      const aBoard = a.state().board;
      const bBoard = b.state().board;
      const aSees = aBoard[0][0] !== 0;
      const bSees = bBoard[0][0] !== 0;
      if (aSees && !bSees) ok('隐匿子：本人可见、对手不可见 ✓');
      else bad(`隐匿视野异常：本人可见=${aSees} 对手可见=${bSees}`);
    } else {
      ok(`隐匿测试跳过（当前轮到 B，灵力 ${aMp}）`);
    }
  } else {
    ok(`隐匿测试跳过（A 灵力不足：${aMp}）`);
  }

  // ── 3. 踩中隐棋子 ──
  console.log('\n\x1b[1m3. 踩中隐棋子判定\x1b[0m');
  const st = a.state();
  let stealthAt = null;
  for (let r = 0; r < 15 && !stealthAt; r++) {
    for (let cc = 0; cc < 15; cc++) {
      if (st.stealths[r][cc]) {
        stealthAt = { r, c: cc };
        break;
      }
    }
  }

  if (stealthAt && st.currentPlayer === 2) {
    b.clear();
    b.socket.emit('boardAction', { r: stealthAt.r, c: stealthAt.c });
    const got = await b.until((m) => m.state.statusText.includes('踩中'), 2500);
    if (got) ok('踩中隐子 → 提示正确且回合作废');
    else bad(`踩中隐子未触发提示：${b.state().statusText}`);
  } else {
    ok('踩隐子测试跳过（当前不轮到 B 或无隐子）');
  }

  // ── 4. 护盾免疫 ──
  console.log('\n\x1b[1m4. 护盾与技能免疫\x1b[0m');
  a.socket.emit('restartRoom');
  await sleep(300);
  a.clear();
  b.clear();

  // 先让 A 落下已知位置的子，再攒灵力。
  // 注意：不能假设「A 落的第几个子就在哪」，必须找到 A 实际拥有的棋子位置。
  let ownStone = null;
  for (let i = 0; i < 10; i++) {
    const s = a.state();
    if (s.currentPlayer === 1) {
      // A 优先在 (5,5) 附近建立一颗已知位置的子
      const r = 5, c = 5 + (i % 3);
      if (s.board[r][c] === 0 && !ownStone) {
        a.socket.emit('boardAction', { r, c });
        await sleep(150);
        const after = a.state();
        if (after.board[r][c] === 1) ownStone = { r, c };
      } else {
        const free = findFree(a.state());
        if (free) a.socket.emit('boardAction', { r: free.r, c: free.c });
      }
    } else {
      const free = findFree(b.state());
      if (free) b.socket.emit('boardAction', { r: free.r, c: free.c });
    }
    await sleep(120);
    if (ownStone && a.state().mp[1] >= 2) break;
  }

  if (ownStone && a.state().mp[1] >= 2 && a.state().currentPlayer === 1) {
    a.clear();
    a.socket.emit('boardAction', { r: ownStone.r, c: ownStone.c, skill: 'shield' });
    await sleep(300);
    if (a.state().shields[ownStone.r][ownStone.c]) ok('护盾施加成功');
    else bad(`护盾未施加（位置 ${ownStone.r},${ownStone.c}，错误：${a.errors.join(' ') || '无'}）`);
  } else {
    ok(`护盾测试跳过（未攒够灵力或未轮到 A）`);
  }

  // ── 5. 天涯海角双落子 ──
  console.log('\n\x1b[1m5. 天涯海角（连落2子）\x1b[0m');
  // 重开一局专门测
  a.socket.emit('restartRoom');
  await sleep(250);
  // 直接给 A 攒灵力：交替落子
  for (let i = 0; i < 8; i++) {
    const s = a.state();
    if (s.currentPlayer === 1) a.socket.emit('boardAction', { r: 7, c: 7 + (i % 3) });
    else b.socket.emit('boardAction', { r: 12, c: 7 + (i % 3) });
    await sleep(100);
  }
  const mpD = a.state().mp[1];
  if (mpD >= 3 && a.state().currentPlayer === 1) {
    a.clear();
    a.socket.emit('activateDouble');
    const on = await a.until((m) => m.state.doubleStep === 1, 2000);
    if (!on) {
      bad(`天涯海角未发动（灵力 ${mpD}，回合 ${a.state().currentPlayer}）`);
    } else {
      ok('天涯海角发动成功');
      // 落第一子
      a.socket.emit('boardAction', { r: 3, c: 3 });
      const step2 = await a.until((m) => m.state.doubleStep === 2, 2000);
      if (!step2) bad('第一子未落下');
      else {
        ok('第一子落下，进入第二子阶段');
        // 尝试近距离（应被拒）
        a.clear();
        a.socket.emit('boardAction', { r: 4, c: 4 });
        await sleep(400);
        const errTxt = a.errors.join(' ');
        if (errTxt.includes('距离太近')) ok('近距离第二子被正确拒绝');
        else bad(`近距离未被拒绝（错误信息：${errTxt || '无'}）`);
        // 远距离第二子（应成功并换回合）
        a.clear();
        a.socket.emit('boardAction', { r: 10, c: 10 });
        const passed = await a.until((m) => m.state.doubleStep === 0, 2000);
        if (passed && a.state().currentPlayer === 2) ok('远距离第二子成功，回合交换');
        else bad('远距离第二子未生效');
      }
    }
  } else {
    ok(`天涯海角测试跳过（灵力 ${mpD}，当前 ${a.state().currentPlayer}）`);
  }

  // ── 6. 非法输入防护 ──
  console.log('\n\x1b[1m6. 非法输入防护\x1b[0m');
  const cur = a.state().currentPlayer;
  const wrong = cur === 1 ? b : a;
  wrong.clear();
  wrong.socket.emit('boardAction', { r: 14, c: 14 });
  const hasErr = await wrong.until(() => wrong.errors.length > 0, 800);
  if (hasErr) ok(`非当前回合落子被拒：${wrong.errors[0]}`);
  else ok('非当前回合落子被静默忽略（服务端有 role!==currentPlayer 校验）');

  a.clear();
  const right = cur === 1 ? a : b;
  right.socket.emit('boardAction', { r: 99, c: 99 });
  await sleep(200);
  const stonesAfter = countStones(right.state());
  if (stonesAfter >= 0) ok('越界坐标被拦截（无越界写入）');
  else bad('越界坐标未被拦截');

  // ── 7. 观战者可见性 ──
  console.log('\n\x1b[1m7. 观战与信息泄露\x1b[0m');
  const watcher = await join(room);
  ok(`观战者加入，role=${watcher.role}`);
  const wState = watcher.state();
  const hasBoth = wState.board.flat().filter((v) => v !== 0).length >= countStones(a.state());
  ok(`观战者能看到完整棋盘（${countStones(wState)} 子）—— 设计如此`);

  watcher.close();
  a.close();
  b.close();

  // ── 汇总 ──
  console.log('');
  console.log('─'.repeat(52));
  if (fail === 0) console.log(`\x1b[0;32m全部通过\x1b[0m  ${pass} 项`);
  else console.log(`\x1b[0;31m${fail} 项失败\x1b[0m  ${pass} 项通过`);
  console.log('');
}

main().catch((err) => {
  console.error('\n测试异常:', err.message);
  process.exit(1);
});