/**
 * 三个新技能的测试：陨石天降 / 鹊桥相会 / 苦肉计。
 *
 * 用法：node tools/test-newskills.js [端口]
 */

'use strict';

const { io } = require('socket.io-client');

const PORT = Number(process.argv[2]) || 8080;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LOADOUT = ['meteor', 'bridge', 'sacrifice', 'shield', 'sand', 'crater'];

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log(`  \x1b[0;32m✓\x1b[0m ${m}`); };
const bad = (m) => { fail++; console.log(`  \x1b[0;31m✗\x1b[0m ${m}`); };

function connect() {
    return io(ORIGIN, { transports: ['websocket'], reconnection: false, timeout: 6000 });
}

async function joinReady(roomId, loadout = LOADOUT) {
    const socket = connect();
    const states = [];
    const errors = [];
    socket.on('syncState', (m) => states.push(m));
    socket.on('errMsg', (m) => errors.push(m));

    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('连接超时')), 7000);
        socket.on('connect', () => {
            socket.emit('joinRoom', { roomId, loadout });
            const wait = () => {
                if (states.length) { clearTimeout(t); resolve(); }
                else setTimeout(wait, 25);
            };
            wait();
        });
        socket.on('connect_error', (e) => { clearTimeout(t); reject(new Error(e.message)); });
    });

    const t0 = Date.now();
    while (Date.now() - t0 < 4000) {
        const last = states[states.length - 1];
        if (last && last.state.phase === 'playing') break;
        await sleep(40);
    }

    return {
        socket,
        errors,
        role: states[0].role,
        state: () => states[states.length - 1]?.state,
        close: () => socket.close(),
    };
}

/** 让指定玩家落一子，等状态更新 */
async function place(players, who, r, c, extra = {}) {
    const p = who === 1 ? players.a : players.b;
    const before = p.state();
    p.socket.emit('boardAction', { r, c, ...extra });
    await sleep(260);
    return p.state();
}

async function main() {
    console.log('');
    console.log(`\x1b[1m新技能测试\x1b[0m  ${ORIGIN}`);
    console.log('─'.repeat(58));

    // ══════ 1. 苦肉计 ══════
    console.log('\n\x1b[1m1. 苦肉计（销毁己子 +2 灵力）\x1b[0m');
    const room1 = 'NS' + Date.now().toString(36).slice(-4).toUpperCase();
    const a = await joinReady(room1);
    const b = await joinReady(room1);
    const players = { a, b };

    let s = a.state();
    if (s.phase !== 'playing') bad(`未开局：${s.phase}`);

    // A 先落一子，制造可销毁的目标
    s = await place(players, 1, 7, 7);
    await place(players, 2, 0, 0);
    s = a.state();

    const mpBefore = s.mp[1];
    const target = s.board[7][7];
    a.errors.length = 0;
    a.socket.emit('boardAction', { r: 7, c: 7, skill: 'sacrifice' });
    await sleep(350);
    s = a.state();

    if (s.board[7][7] === 0) ok('★ 己方棋子已销毁');
    else bad(`棋子未销毁（${s.board[7][7]}）`);

    const gained = s.mp[1] - mpBefore;
    if (gained === 2) ok(`★ 灵力 ${mpBefore} → ${s.mp[1]}（+2）`);
    else bad(`灵力变化 ${mpBefore} → ${s.mp[1]}（期望 +2）`);

    // 瞬发技能会记 skillUsedThisTurn，但仍允许落子（区别于「行动型」直接结束回合）
    if (s.skillUsedThisTurn && s.currentPlayer === 1) ok('瞬发：技能已记账，本回合仍轮到自己');
    else bad(`瞬发状态异常（used=${s.skillUsedThisTurn} turn=${s.currentPlayer}）`);

    a.close(); b.close();

    // ══════ 2. 鹊桥相会 ══════
    console.log('\n\x1b[1m2. 鹊桥相会（跨空位连五）\x1b[0m');
    const room2 = 'NB' + Date.now().toString(36).slice(-4).toUpperCase();
    const c1 = await joinReady(room2);
    const c2 = await joinReady(room2);
    const pp = { a: c1, b: c2 };

    // 目标：第 7 行摆 2,3,4 三子 + 门在 5 和 10 + 11,12 两子
    // 架桥后从 2 到 12 跨过 6~9 的空档应算 5 连
    let st = c1.state();

    // A: 7,2   B: 0,0
    await place(pp, 1, 7, 2);
    await place(pp, 2, 0, 0);
    // A: 7,3   B: 0,1
    await place(pp, 1, 7, 3);
    await place(pp, 2, 0, 1);
    // A: 7,4   B: 0,2
    await place(pp, 1, 7, 4);
    await place(pp, 2, 0, 2);

    st = c1.state();
    // 此时 A 的灵力应 ≥3
    if (st.mp[1] < 3) {
        bad(`灵力不足（${st.mp[1]}），无法架桥`);
    } else {
        // A 架桥 (7,5)-(7,10)，两次点击
        c1.socket.emit('boardAction', { r: 7, c: 5, skill: 'bridge' });
        await sleep(250);
        let mid = c1.state();
        const hasFirst = (mid.portals || []).length === 0;
        if (hasFirst) ok('第一次点击只记下起点，尚未生效');

        c1.socket.emit('boardAction', { r: 7, c: 10, skill: 'bridge' });
        await sleep(350);
        st = c1.state();

        if ((st.portals || []).length === 1) {
            ok('★ 传送门已架设（一对）');
            const p = st.portals[0];
            ok(`   位置 ${p.a.r},${p.a.c} ⇄ ${p.b.r},${p.b.c}，剩余 ${p.turns} 步`);
        } else {
            bad('传送门未生成');
        }

        if (st.mp[1] === 0 || st.mp[1] === 1) ok(`灵力已扣 3（剩 ${st.mp[1]}）`);
        else bad(`灵力扣除异常（剩 ${st.mp[1]}）`);

        // 架桥后 A 还要落子结束回合 → 落在 7,11
        await place(pp, 1, 7, 11);
        await place(pp, 2, 0, 3);

        // A 落 7,12：左邻 7,11 有子，再往左是门 → 跳到 7,4，接上 7,3,7,2 = 5 连
        st = await place(pp, 1, 7, 12);

        if (st.gameOver) {
            ok('★ 隔着空位连成五连，判定获胜');
            ok(`   状态：${st.statusText}`);
        } else {
            bad(`未判胜（board[7][12]=${st.board[7][12]}，当前回合 ${st.currentPlayer}）`);
            const row = st.board[7].map((v, i) => (v ? i : null)).filter((x) => x !== null);
            console.log(`   第 7 行有子的列：${JSON.stringify(row)}`);
            console.log(`   传送门：${JSON.stringify(st.portals)}`);
        }
    }

    c1.close(); c2.close();

    // ══════ 3. 陨石天降 ══════
    console.log('\n\x1b[1m3. 陨石天降（震退周围 8 格）\x1b[0m');
    const room3 = 'NM' + Date.now().toString(36).slice(-4).toUpperCase();
    const d1 = await joinReady(room3);
    const d2 = await joinReady(room3);
    const pq = { a: d1, b: d2 };

    // 摆一个简单场景：A 在 (7,7) 附近有棋，B 也有
    await place(pq, 1, 7, 6);     // A
    await place(pq, 2, 7, 8);     // B
    await place(pq, 1, 6, 7);     // A
    await place(pq, 2, 8, 7);     // B

    st = d1.state();
    // 轮到 A，砸在中心 (7,7)，四个邻居应被向外震退
    if (st.currentPlayer !== 1) {
        bad(`轮次异常（${st.currentPlayer}）`);
    } else if (st.mp[1] < 2) {
        bad(`灵力不足（${st.mp[1]}）`);
    } else {
        const before = {
            left: st.board[7][6], right: st.board[7][8],
            up: st.board[6][7], down: st.board[8][7],
        };

        d1.socket.emit('boardAction', { r: 7, c: 7, skill: 'meteor' });
        await sleep(450);
        st = d1.state();

        if (st.board[7][7] === 1) ok('★ 陨石落点已占据');
        else bad(`陨石未落子（${st.board[7][7]}）`);

        // 左侧 (7,6) 的 A 子应被推到 (7,5)
        const pushedLeft = st.board[7][5] === before.left && st.board[7][6] === 0;
        const pushedRight = st.board[7][9] === before.right && st.board[7][8] === 0;
        const pushedUp = st.board[5][7] === before.up && st.board[6][7] === 0;
        const pushedDown = st.board[9][7] === before.down && st.board[8][7] === 0;

        if (pushedLeft) ok('★ 左侧敌子被震退 1 格');
        else bad(`左侧未震退（7,6=${st.board[7][6]} 7,5=${st.board[7][5]}）`);
        if (pushedRight) ok('★ 右侧敌子被震退 1 格');
        else bad(`右侧未震退（7,8=${st.board[7][8]} 7,9=${st.board[7][9]}）`);
        if (pushedUp) ok('★ 上方己子被震退 1 格');
        else bad(`上方未震退（6,7=${st.board[6][7]} 5,7=${st.board[5][7]}）`);
        if (pushedDown) ok('★ 下方敌子被震退 1 格');
        else bad(`下方未震退（8,7=${st.board[8][7]} 9,7=${st.board[9][7]}）`);
    }

    d1.close(); d2.close();

    // ══════ 4. 门格可落子 ══════
    console.log('\n\x1b[1m4. 传送门所在格能否落子\x1b[0m');
    const room4 = 'NP' + Date.now().toString(36).slice(-4).toUpperCase();
    const f1 = await joinReady(room4);
    const f2 = await joinReady(room4);
    const pf = { a: f1, b: f2 };

    // 攒灵力到 3 并让回合转回黑方
    await place(pf, 1, 0, 0);
    await place(pf, 2, 1, 1);
    await place(pf, 1, 0, 1);
    await place(pf, 2, 1, 2);

    st = f1.state();
    if (st.currentPlayer === 1 && st.mp[1] >= 3) {
        f1.socket.emit('boardAction', { r: 5, c: 5, skill: 'bridge' });
        await sleep(250);
        f1.socket.emit('boardAction', { r: 5, c: 10, skill: 'bridge' });
        await sleep(380);

        st = f1.state();
        if ((st.portals || []).length === 1) {
            ok('传送门已架设');

            // 直接落在门格上
            f1.errors.length = 0;
            f1.socket.emit('boardAction', { r: 5, c: 5 });
            await sleep(400);
            st = f1.state();

            if (st.board[5][5] === 1) ok('★ 传送门所在格可以正常落子');
            else bad(`门上落子被拒（board=${st.board[5][5]}） 错误=${JSON.stringify(f1.errors)}`);

            // 门还在（落子不该抹掉传送门）
            if ((st.portals || []).length === 1) ok('★ 落子后传送门仍然保留');
            else bad('落子后传送门消失了');
        } else {
            bad('架桥失败，跳过');
        }
    } else {
        bad(`灵力不足（${st?.mp?.[1]}），跳过`);
    }

    f1.close(); f2.close();

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