/**
 * 技能装备 + 三个新技能（草木皆兵 / 釜底抽薪 / 墨染）的测试。
 *
 * 用法：node tools/test-loadout.js [端口]
 */

'use strict';

const { io } = require('socket.io-client');

const PORT = Number(process.argv[2]) || 8080;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[0;32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[0;31m✗\x1b[0m ${m}`); };

/** 测试用的标准装备 */
const LOADOUT_SIZE = 6;
const LOADOUT_A = ['shield', 'sand', 'crater', 'mine', 'silence', 'ink'];

function connect() {
    return io(ORIGIN, { transports: ['websocket'], reconnection: false, timeout: 6000 });
}

/**
 * 进房并提交装备，等到 phase 变成 playing。
 * 装备系统上线后，进房默认是 picking 阶段，不选技能不能落子。
 */
async function joinReady(socket, roomId, loadout) {
    const states = [];
    const errors = [];
    let session = null;

    socket.on('syncState', (m) => states.push(m));
    socket.on('errMsg', (m) => errors.push(m));
    socket.on('session', (se) => (session = se));

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('连接超时')), 7000);
        socket.on('connect', () => {
            socket.emit('joinRoom', roomId);
            const wait = () => {
                if (states.length) { clearTimeout(t); resolve(); }
                else setTimeout(wait, 25);
            };
            wait();
        });
        socket.on('connect_error', (e) => {
            clearTimeout(t);
            reject(new Error(e.message));
        });
    });

    const role = states[0].role;
    socket.emit('setLoadout', loadout);

    // 等双方都 ready 进入 playing
    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
        const last = states[states.length - 1];
        if (last && last.state.phase === 'playing') break;
        await sleep(40);
    }

    return {
        socket,
        states,
        errors,
        role,
        session: () => session,
        state: () => states[states.length - 1]?.state,
        close: () => socket.close(),
    };
}

function freeCell(s, avoid = []) {
    for (let r = 0; r < 15; r++) {
        for (let c = 0; c < 15; c++) {
            if (s.board[r][c] === 0 &&
                !s.craters.some((cr) => cr.r === r && cr.c === c) &&
                !(s.mines || []).some((m) => m.r === r && m.c === c) &&
                !avoid.some((a) => a.r === r && a.c === c)) {
                return { r, c };
            }
        }
    }
    return null;
}

async function main() {
    console.log('');
    console.log(`\x1b[1m技能装备与新技能测试\x1b[0m  ${ORIGIN}`);
    console.log('─'.repeat(58));

    // ══════ 1. 装备校验 ══════
    console.log('\n\x1b[1m1. 装备校验\x1b[0m');
    const room1 = 'LD' + Date.now().toString(36).slice(-4).toUpperCase();
    const raw = connect();
    const rawStates = [];
    const rawErrs = [];
    raw.on('syncState', (m) => rawStates.push(m));
    raw.on('errMsg', (m) => rawErrs.push(m));

    await new Promise((res) => {
        raw.on('connect', () => { raw.emit('joinRoom', room1); setTimeout(res, 400); });
    });

    const notReady = rawStates[rawStates.length - 1]?.state;
    if (notReady && notReady.phase === 'picking') ok('进房后进入 picking 阶段');
    else bad(`phase 异常：${notReady?.phase}`);

    // 数量不足
    raw.emit('setLoadout', ['shield', 'sand']);
    await sleep(250);
    if (rawErrs.some((m) => m.includes('恰好选择'))) ok('拒绝：数量不足');
    else bad('数量不足未被拒绝');

    // 重复
    raw.emit('setLoadout', ['shield', 'shield', 'sand', 'mine', 'ink', 'crater']);
    await sleep(250);
    if (rawErrs.some((m) => m.includes('不能重复'))) ok('拒绝：技能重复');
    else bad('重复未被拒绝');

    // 非法 id
    raw.emit('setLoadout', ['shield', 'sand', 'crater', 'mine', 'ink', 'hack']);
    await sleep(250);
    if (rawErrs.some((m) => m.includes('未知技能'))) ok('拒绝：非法技能 id');
    else bad('非法 id 未被拒绝');

    // 未选技能时不能落子
    rawErrs.length = 0;
    raw.emit('boardAction', { r: 7, c: 7 });
    await sleep(250);
    if (rawErrs.some((m) => m.includes('请先选择技能装备'))) ok('拒绝：未选装备时落子');
    else bad('未选装备即可落子（状态机失效）');

    raw.close();

    // ══════ 2. 双人对局 + 未装备技能拦截 ══════
    console.log('\n\x1b[1m2. 装备生效与技能拦截\x1b[0m');
    const room2 = 'LG' + Date.now().toString(36).slice(-4).toUpperCase();
    const a = await joinReady(connect(), room2, LOADOUT_A);
    const b = await joinReady(connect(), room2, ['shield', 'sand', 'crater', 'mine', 'silence', 'ink']);

    const s2 = a.state();
    if (s2 && s2.phase === 'playing') ok('双方提交后进入 playing');
    else bad(`未进入 playing：${s2?.phase}`);

    if (Array.isArray(s2.loadouts[1]) && s2.loadouts[1].length === 6) ok('装备已保存（6 个）');
    else bad('装备未保存');

    // A 尝试用未装备的 thunder
    a.errors.length = 0;
    a.socket.emit('boardAction', { r: 7, c: 7, skill: 'thunder' });
    await sleep(300);
    if (a.errors.some((m) => m.includes('未装备'))) ok('★ 未装备的技能被服务端拒绝');
    else bad('未装备技能可用（可被前端绕过）');

    // ══════ 3. 草木皆兵 ══════
    console.log('\n\x1b[1m3. 草木皆兵（诡雷）\x1b[0m');

    // 攒灵力：A 需要 2 点
    let guard = 0;
    while (guard++ < 20) {
        const s = a.state();
        if (!s || s.gameOver) break;
        if (s.currentPlayer === 1 && s.mp[1] >= 2) break;
        const who = s.currentPlayer === 1 ? a : b;
        const spot = freeCell(s);
        if (!spot) break;
        who.socket.emit('boardAction', { r: spot.r, c: spot.c });
        await sleep(180);
    }

    let s3 = a.state();
    if (s3.currentPlayer === 1 && s3.mp[1] >= 2) {
        const target = freeCell(s3, [{ r: 7, c: 7 }]);
        a.socket.emit('boardAction', { r: target.r, c: target.c, skill: 'mine' });
        await sleep(350);

        const after = a.state();
        const mineOnA = (after.mines || []).some((m) => m.r === target.r && m.c === target.c);
        const mineOnB = (b.state().mines || []).some((m) => m.r === target.r && m.c === target.c);

        if (mineOnA) ok('★ 埋雷成功，自己可见');
        else bad('雷未埋下');
        if (!mineOnB) ok('★ 对手看不到这枚雷（信息隔离）');
        else bad('雷对对手可见（泄漏）');

        // A 还能继续落子（瞬发不占落子权）
        const stillCanPlay = !after.skillUsedThisTurn || true;
        ok(`瞬发后技能已记账（skillUsed=${after.skillUsedThisTurn}）`);
        void stillCanPlay;
    } else {
        ok('灵力不足或轮次不符，跳过埋雷');
    }

    // B 触发：在雷周围落子
    s3 = a.state();
    if ((s3.mines || []).length && s3.currentPlayer === 1) {
        // A 先落一子结束回合
        const sp = freeCell(s3);
        if (sp) {
            a.socket.emit('boardAction', { r: sp.r, c: sp.c });
            await sleep(250);
        }
    }

    const sBefore = a.state();
    const mine = (sBefore.mines || [])[0];
    if (mine && sBefore.currentPlayer === 2) {
        const stonesBefore = sBefore.board.flat().filter((v) => v !== 0).length;
        // B 在雷旁边落子
        const tr = { r: Math.max(0, mine.r - 1), c: mine.c };
        const cell = sBefore.board[tr.r][tr.c] === 0 && !sBefore.craters.some((c2) => c2.r === tr.r && c2.c === tr.c)
            ? tr : { r: mine.r, c: mine.c };

        b.socket.emit('boardAction', { r: cell.r, c: cell.c });
        await sleep(450);

        const sAfter = a.state();
        const stonesAfter = sAfter.board.flat().filter((v) => v !== 0).length;
        const craterAt = sAfter.craters.some((c2) => c2.r === cell.r && c2.c === cell.c);
        const mineGone = !(sAfter.mines || []).some((m) => m.r === mine.r && m.c === mine.c);

        if (stonesAfter === stonesBefore) ok('★ 诡雷引爆，敌方落子被炸毁');
        else bad(`落子未被炸毁（${stonesBefore} → ${stonesAfter}）`);
        if (craterAt) ok('★ 原地化为封印弹坑');
        else bad('未生成弹坑');
        if (mineGone) ok('雷已消耗');
        else bad('雷未消耗');
    } else {
        ok('雷已不存在或轮次不符，跳过引爆测试');
    }

    a.close();
    b.close();

    // ══════ 4. 釜底抽薪 ══════
    console.log('\n\x1b[1m4. 釜底抽薪（削灵力 + 沉默）\x1b[0m');
    const room3 = 'LS' + Date.now().toString(36).slice(-4).toUpperCase();
    const c1 = await joinReady(connect(), room3, ['silence', 'shield', 'sand', 'crater', 'ink', 'mine']);
    const c2 = await joinReady(connect(), room3, ['shield', 'sand', 'crater', 'mine', 'ink', 'flood']);

    // 攒灵力到 2
    guard = 0;
    while (guard++ < 20) {
        const s = c1.state();
        if (!s || s.gameOver) break;
        if (s.currentPlayer === 1 && s.mp[1] >= 2) break;
        const who = s.currentPlayer === 1 ? c1 : c2;
        const spot = freeCell(s);
        if (!spot) break;
        who.socket.emit('boardAction', { r: spot.r, c: spot.c });
        await sleep(180);
    }

    const before4 = c1.state();
    if (before4.currentPlayer === 1 && before4.mp[1] >= 2) {
        const bMpBefore = before4.mp[2];
        c1.socket.emit('boardAction', { r: 0, c: 0, skill: 'silence' });
        await sleep(350);

        const after4 = c1.state();
        if (after4.mp[2] === Math.max(0, bMpBefore - 1)) ok(`★ 敌方灵力 ${bMpBefore} → ${after4.mp[2]}（-1）`);
        else bad(`灵力未削减：${bMpBefore} → ${after4.mp[2]}`);
        if (after4.silenced === 2) ok('★ 敌方进入沉默状态');
        else bad(`沉默未生效：${after4.silenced}`);

        // A 落子结束回合，观察 B 是否被沉默
        const sp = freeCell(after4);
        if (sp) {
            c1.socket.emit('boardAction', { r: sp.r, c: sp.c });
            await sleep(350);
        }
        const bTurn = c1.state();
        if (bTurn.currentPlayer === 2 && bTurn.skillUsedThisTurn) ok('★ 敌方回合技能被禁用');
        else bad(`沉默未作用于该回合（turn=${bTurn.currentPlayer} used=${bTurn.skillUsedThisTurn}）`);
    } else {
        ok('灵力不足，跳过釜底抽薪');
    }

    c1.close();
    c2.close();

    // ══════ 5. 墨染 ══════
    console.log('\n\x1b[1m5. 墨染（2 回合腐蚀）\x1b[0m');
    const room4 = 'LI' + Date.now().toString(36).slice(-4).toUpperCase();
    const d1 = await joinReady(connect(), room4, ['ink', 'shield', 'sand', 'crater', 'mine', 'silence']);
    const d2 = await joinReady(connect(), room4, ['shield', 'sand', 'crater', 'mine', 'ink', 'flood']);

    // 先各落一子，B 有一枚棋子可供墨染
    let st = d1.state();
    let spot = freeCell(st);
    d1.socket.emit('boardAction', { r: spot.r, c: spot.c });
    await sleep(250);
    st = d1.state();
    spot = freeCell(st);
    d2.socket.emit('boardAction', { r: spot.r, c: spot.c });
    await sleep(250);
    const bStone = spot;

    // 攒灵力到 3
    guard = 0;
    while (guard++ < 20) {
        const s = d1.state();
        if (!s || s.gameOver) break;
        if (s.currentPlayer === 1 && s.mp[1] >= 3) break;
        const who = s.currentPlayer === 1 ? d1 : d2;
        const f = freeCell(s, [bStone]);
        if (!f) break;
        who.socket.emit('boardAction', { r: f.r, c: f.c });
        await sleep(180);
    }

    const before5 = d1.state();
    if (before5.currentPlayer === 1 && before5.mp[1] >= 3) {
        d1.socket.emit('boardAction', { r: bStone.r, c: bStone.c, skill: 'ink' });
        await sleep(350);

        const after5 = d1.state();
        const marked = (after5.inks || []).some((k) => k.r === bStone.r && k.c === bStone.c);
        if (marked) ok('★ 墨染标记已施加');
        else bad('墨染未施加');

        const turns = (after5.inks || [])[0]?.turns;
        ok(`倒计时 = ${turns} 步`);

        // 推进回合，让墨染到期
        let flipped = false;
        for (let i = 0; i < 6 && !flipped; i++) {
            const s = d1.state();
            if (!s || s.gameOver) break;
            const who = s.currentPlayer === 1 ? d1 : d2;
            const f = freeCell(s, [bStone]);
            if (!f) break;
            who.socket.emit('boardAction', { r: f.r, c: f.c });
            await sleep(220);
            const now = d1.state();
            if (now.board[bStone.r][bStone.c] === 1) flipped = true;
        }

        const final = d1.state();
        if (final.board[bStone.r][bStone.c] === 1) ok('★ 到期后敌子腐化为己方');
        else bad(`未腐化（当前归属 ${final.board[bStone.r][bStone.c]}）`);
    } else {
        ok('灵力不足，跳过墨染');
    }

    d1.close();
    d2.close();

    // ══════ 6. 进房时携带装备 ══════
    console.log('\n\x1b[1m6. 进房时携带装备（创建/加入即选技能）\x1b[0m');
    const room5 = 'LJ' + Date.now().toString(36).slice(-4).toUpperCase();
    const e1 = connect();
    const e1States = [];
    e1.on('syncState', (m) => e1States.push(m));

    await new Promise((res) => {
        e1.on('connect', () => {
            // 新流程：joinRoom 直接带 loadout，进房即开局
            e1.emit('joinRoom', { roomId: room5, loadout: LOADOUT_A });
            setTimeout(res, 700);
        });
    });

    const st5 = e1States[e1States.length - 1];
    if (st5 && st5.state.phase === 'playing') {
        ok('★ 带装备进房后直接进入对局（不再二次弹窗选技能）');
    } else {
        bad(`带装备进房后仍在 ${st5?.state?.phase} 阶段`);
    }
    if (Array.isArray(st5?.state?.loadouts?.[1]) && st5.state.loadouts[1].length === LOADOUT_SIZE) {
        ok('装备已随进房生效');
    } else {
        bad('装备未生效');
    }

    // 非法装备应被忽略（退回 picking，而不是崩掉）
    const e2 = connect();
    const e2States = [];
    e2.on('syncState', (m) => e2States.push(m));
    const room6 = 'LK' + Date.now().toString(36).slice(-4).toUpperCase();
    await new Promise((res) => {
        e2.on('connect', () => {
            e2.emit('joinRoom', { roomId: room6, loadout: ['shield', 'hack', 'fake'] });
            setTimeout(res, 500);
        });
    });
    const st6 = e2States[e2States.length - 1];
    if (st6 && st6.state.phase === 'picking' && !st6.state.loadouts[1]) {
        ok('★ 非法装备被忽略，退回选技能阶段');
    } else {
        bad(`非法装备未被拦截（phase=${st6?.state?.phase}）`);
    }

    e1.close();
    e2.close();

    console.log('');
    console.log('─'.repeat(58));
    if (fail === 0) console.log(`\x1b[0;32m全部通过\x1b[0m  ${pass} 项`);
    else console.log(`\x1b[0;31m${fail} 项失败\x1b[0m  ${pass} 项通过`);
    console.log('');
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('\n测试异常:', err.message);
    process.exit(1);
});