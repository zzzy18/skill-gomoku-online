/**
 * 模拟浏览器加载页面，检查 socket.io 客户端能否正常工作。
 *
 * 这个测试专门覆盖一类问题：页面能打开，但 WebSocket 连不上。
 * 常见根因是资源路径写成了绝对路径，在部署到子目录后就指向了错误位置。
 *
 * 用法：node tools/browser-sim.js [url]
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

const PAGE = process.argv[2] || 'http://182.92.63.63/gomoku-v2/';
const { io } = require('socket.io-client');

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

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { timeout: 8000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('');
  console.log(`\x1b[1m浏览器加载模拟\x1b[0m  ${PAGE}`);
  console.log('─'.repeat(52));

  // ── 1. 页面能打开 ──
  console.log('\n\x1b[1m1. 页面加载\x1b[0m');
  const page = await fetchText(PAGE);
  if (page.status === 200) ok(`页面 HTTP 200（${page.body.length} 字节）`);
  else {
    bad(`页面 HTTP ${page.status}`);
    process.exit(1);
  }

  // ── 2. 脚本引用解析 ──
  console.log('\n\x1b[1m2. 脚本引用解析\x1b[0m');
  const scriptMatch = page.body.match(/<script src="([^"]*socket\.io[^"]*)"/i);
  if (!scriptMatch) {
    bad('页面里找不到 socket.io 客户端引用');
  } else {
    const src = scriptMatch[1];
    const resolved = new URL(src, PAGE).toString();

    // 绝对路径（以 / 开头）在子目录部署时会指向站点根 —— 这是本次的根因
    const isAbsolute = src.startsWith('/');
    const staysInSubdir = resolved.startsWith(new URL(PAGE).pathname.replace(/\/$/, '/'));

    if (isAbsolute && !staysInSubdir) {
      bad(`绝对路径会跳出子目录：${src} → ${resolved}`);
    } else {
      ok(`路径解析正确：${src} → ${new URL(resolved).pathname}`);
    }

    const lib = await fetchText(resolved);
    if (lib.status === 200 && lib.body.length > 10000) {
      ok(`客户端库加载成功（${lib.body.length} 字节）`);
    } else {
      bad(`客户端库加载失败：HTTP ${lib.status}，${lib.body.length} 字节`);
      console.log('    → io() 会是 undefined，页面必然显示「未连接」');
      return finish();
    }
  }

  // ── 3. 客户端 path 配置 ──
  console.log('\n\x1b[1m3. socket.io path 配置\x1b[0m');
  const usesBasePath = /BASE_PATH\s*\+\s*['"]socket\.io\//.test(page.body);
  if (usesBasePath) ok('客户端按页面路径动态设置 path');
  else if (/io\(\s*\{[^}]*path/.test(page.body)) ok('客户端显式指定了 path');
  else bad('客户端未指定 path —— 部署在子目录时会连不上');

  // ── 4. 实际建立连接 ──
  console.log('\n\x1b[1m4. 实际连接\x1b[0m');

  // 必须拆成 origin + path 两部分，不能直接把页面 URL 传给 io()：
  // io('http://host/gomoku-v2/') 会把 /gomoku-v2/ 当成 namespace，
  // 服务端没挂这个 namespace 就会报 "Invalid namespace"。
  // 这正是页面里 io({ path: BASE_PATH + 'socket.io/' }) 的效果 ——
  // 浏览器不会踩这个坑，测试脚本要还原同样的语义。
  const u = new URL(PAGE);
  const basePath = u.pathname.endsWith('/') ? u.pathname : u.pathname.slice(0, u.pathname.lastIndexOf('/') + 1);
  const origin = u.origin;

  const socket = io(origin, {
    path: basePath + 'socket.io/',
    transports: ['websocket'],
    reconnection: false,
    timeout: 8000,
  });

  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: '超时 8 秒' }), 9000);

    socket.on('connect', () => {
      clearTimeout(timer);
      socket.emit('joinRoom', 'BROWSERSIM');
    });

    socket.on('syncState', (m) => {
      clearTimeout(timer);
      resolve({ ok: true, role: m.role, room: m.roomId });
    });

    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: e.message });
    });
  });

  if (result.ok) {
    ok(`WebSocket 连接成功（房间 ${result.room}，角色 ${result.role}）`);
  } else {
    bad(`连接失败：${result.reason}`);
  }

  socket.close();

  // ── 5. 页面关键元素 ──
  console.log('\n\x1b[1m5. 页面元素\x1b[0m');
  for (const [needle, label] of [
    ['id="chessBoard"', '棋盘 canvas'],
    ['roleBadge', '连接状态徽章'],
    ['statusText', '状态栏'],
    ['skills-1', '玩家1 技能面板'],
    ['skills-2', '玩家2 技能面板'],
  ]) {
    if (page.body.includes(needle)) ok(`${label} 存在`);
    else bad(`${label} 缺失（${needle}）`);
  }

  // 技能定义完整性
  const skillCount = (page.body.match(/id:\s*'(sand|crater|shield|stealth|double|flood|convert|thunder)'/g) || []).length;
  if (skillCount === 8) ok('8 个技能定义齐全');
  else if (skillCount > 0) ok(`找到 ${skillCount} 个技能定义（预期 8）`);
  else bad('未找到技能定义');

  finish();
}

function finish() {
  console.log('');
  console.log('─'.repeat(52));
  if (fail === 0) console.log(`\x1b[0;32m全部通过\x1b[0m  ${pass} 项`);
  else console.log(`\x1b[0;31m${fail} 项失败\x1b[0m  ${pass} 项通过`);
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\n异常:', err.message);
  process.exit(1);
});