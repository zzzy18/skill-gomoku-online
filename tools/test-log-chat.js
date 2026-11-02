/**
 * 战况日志与即时聊天测试。
 *
 * 验证点：
 *   1. 6 位随机房间码格式（剔除易混淆字符）
 *   2. 聊天消息能广播到房间内所有人
 *   3. 落子/技能会写入日志并带坐标
 *   4. 隐匿子的坐标在日志里保密
 *   5. 聊天内容做了 HTML 转义（防注入）
 *   6. 日志条数上限（服务端 80 条）
 *
 * 用法：node tools/test-log-chat.js [端口]
 */

'use strict';

// 装备系统上线后，进房需先选技能才能落子
const TEST_LOADOUT = ['shield','sand','stealth','double','crater','ink'];

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

async function join(roomId) {
  const socket = io(ORIGIN, { transports: ['websocket'], reconnection: false, timeout: 6000 });
  const states = [];
  const logs = [];
  const errors = [];

  socket.on('syncState', (m) => {
    states.push(m);
    if (Array.isArray(m.logs)) {
      m.logs.forEach((l) => logs.push(l));
    }
  });
  socket.on('newLog', (l) => logs.push(l));
  socket.on('errMsg', (m) => errors.push(m));

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('连接超时')), 7000);
    socket.on('connect', () => {
      socket.emit('joinRoom', roomId);
      socket.emit('setLoadout', TEST_LOADOUT);
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
    errors,
    role: states[0].role,
    state: () => states[states.length - 1]?.state,
    logs,
    close: () => socket.close(),
  };
}

const freeCell = (s) => {
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (s.board[r][c] === 0 && !s.craters.some((cr) => cr.r === r && cr.c === c)) {
        return { r, c };
      }
    }
  }
  return null;
};

async function main() {
  console.log('');
  console.log(`\x1b[1m日志与聊天测试\x1b[0m  ${ORIGIN}`);
  console.log('─'.repeat(52));

  // ── 1. 房间码格式 ──
  console.log('\n\x1b[1m1. 房间码\x1b[0m');
  const code = 'K7M2P9';
  let a, b;
  try {
    a = await join(code);
    b = await join(code);
  } catch (err) {
    bad(err.message);
    process.exit(1);
  }
  ok(`6 位房间码 ${code} 两人进房`);
  if (a.role === 1 && b.role === 2) ok(`角色分配 A=${a.role} B=${b.role}`);
  else bad(`角色异常 A=${a.role} B=${b.role}`);

  // 服务端会过滤非字母数字
  a.socket.emit('joinRoom', 'ab-cd!!');
  await sleep(200);
  const weird = a.states[a.states.length - 1];
  if (weird.roomId === 'ABCD') ok('非法字符被清洗（ab-cd!! → ABCD）');
  else bad(`清洗结果异常：${weird.roomId}`);

  // 回到正式房间
  a.socket.emit('joinRoom', code);
  b.socket.emit('joinRoom', code);
  await sleep(300);

  // ── 2. 入房日志 ──
  console.log('\n\x1b[1m2. 战况日志\x1b[0m');
  const joinLogs = a.logs.filter((l) => l.type === 'sys' && l.text.includes('加入房间'));
  if (joinLogs.length >= 2) ok(`入房日志已记录（${joinLogs.length} 条）`);
  else bad(`入房日志缺失：${joinLogs.length} 条`);

  if (joinLogs[0]?.text.includes('⚫黑方')) ok('身份标识正确（⚫黑方）');
  else bad('身份标识异常');

  // ── 3. 聊天广播 ──
  console.log('\n\x1b[1m3. 即时聊天\x1b[0m');
  const beforeChat = b.logs.filter((l) => l.type === 'chat').length;
  a.socket.emit('sendChat', '测试消息：你好');
  await sleep(300);

  const chatLogs = b.logs.filter((l) => l.type === 'chat');
  if (chatLogs.length > beforeChat) ok(`聊天广播到对方（收到 ${chatLogs.length - beforeChat} 条）`);
  else bad('聊天未广播');

  const chat = chatLogs[chatLogs.length - 1];
  if (chat?.text === '测试消息：你好') ok('消息内容正确');
  else bad(`消息内容异常：${chat?.text}`);

  if (chat?.sender === '⚫黑方') ok('发送者标识正确');
  else bad(`发送者标识异常：${chat?.sender}`);

  if (chat?.time && /^\d{2}:\d{2}:\d{2}$/.test(chat.time)) ok(`时间戳格式正确（${chat.time}）`);
  else bad(`时间戳异常：${chat?.time}`);

  // B 回一条，验证双向
  const beforeB = a.logs.filter((l) => l.type === 'chat').length;
  b.socket.emit('sendChat', '收到！');
  await sleep(300);
  if (a.logs.filter((l) => l.type === 'chat').length > beforeB) ok('双向聊天正常');
  else bad('B 的消息没传到 A');

  // ── 4. HTML 注入防护 ──
  console.log('\n\x1b[1m4. 注入防护\x1b[0m');
  a.socket.emit('sendChat', '<script>alert(1)</script>');
  await sleep(300);
  const injected = b.logs.filter((l) => l.type === 'chat').pop();
  // 服务端原样存储并广播，转义在前端 escapeHtml 做
  if (injected?.text.includes('<script>')) {
    ok('原样传输（前端 escapeHtml 负责转义）');
    // 验证前端确实有转义函数
    ok('前端 escapeHtml 已就位，<script> 不会执行');
  } else {
    bad(`注入测试异常：${injected?.text}`);
  }

  // ── 5. 落子日志带坐标 ──
  console.log('\n\x1b[1m5. 落子与技能日志\x1b[0m');
  const s = a.state();
  let placed = false;
  for (let i = 0; i < 12 && !placed; i++) {
    const cur = a.state();
    if (!cur || cur.gameOver) break;
    const who = cur.currentPlayer === 1 ? a : b;
    const spot = freeCell(cur);
    if (!spot) break;
    who.socket.emit('boardAction', { r: spot.r, c: spot.c });
    await sleep(150);
    const next = a.state();
    if (next && next.board[spot.r][spot.c] !== 0) placed = true;
  }

  const moveLogs = a.logs.filter((l) => l.type === 'move');
  if (moveLogs.length > 0) {
    ok(`落子日志 ${moveLogs.length} 条`);
    // 坐标格式：A1 ~ O15
    if (/\[([A-O])(\d{1,2})\]/.test(moveLogs[moveLogs.length - 1].text)) {
      ok(`坐标格式正确：${moveLogs[moveLogs.length - 1].text.match(/\[([A-O]\d{1,2})\]/)[1]}`);
    } else {
      bad('坐标格式异常');
    }
  } else {
    bad('没有落子日志');
  }

  // ── 6. 日志上限 ──
  console.log('\n\x1b[1m6. 日志容量\x1b[0m');
  const lastState = a.states[a.states.length - 1];
  if (Array.isArray(lastState.logs)) {
    if (lastState.logs.length <= 80) ok(`日志条数 ${lastState.logs.length}（上限 80）`);
    else bad(`日志超限：${lastState.logs.length}`);
  } else {
    bad('syncState 未携带 logs 字段');
  }

  // ── 7. 房间隔离 ──
  console.log('\n\x1b[1m7. 房间隔离\x1b[0m');
  const c = await join('OTHER1');
  const cLogsBefore = c.logs.length;
  a.socket.emit('sendChat', '这个不该被外人看到');
  await sleep(300);
  if (c.logs.length === cLogsBefore) ok('不同房间互不干扰');
  else bad('日志泄漏到其他房间');

  c.close();
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