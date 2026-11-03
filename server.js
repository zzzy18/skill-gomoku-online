const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const SIZE = 15;
const MAX_MP = 8;
const rooms = new Map();

/** 每人可装备的技能数量 */
const LOADOUT_SIZE = 6;

/**
 * 技能定义表 —— 服务端权威。
 *
 * cost: 灵力消耗
 * type: 'instant' 用完本回合仍可落子；'action' 代替本回合落子
 *
 * 前端也有一份同构的表用于渲染，但**校验只认这里**：
 * 客户端传来 skill id 时必须先过 canUseSkill()，
 * 否则改前端就能用未装备的技能。
 */
const SKILL_DEFS = {
    shield:  { cost: 1, type: 'instant' },
    sand:    { cost: 2, type: 'instant' },
    crater:  { cost: 2, type: 'instant' },
    flood:   { cost: 3, type: 'instant' },
    mine:    { cost: 2, type: 'instant' },   // 草木皆兵
    silence: { cost: 2, type: 'instant' },   // 釜底抽薪
    ink:     { cost: 3, type: 'instant' },   // 墨染
    bridge:  { cost: 3, type: 'instant' },   // 鹊桥相会
    sacrifice:{ cost: 0, type: 'instant' },  // 苦肉计
    meteor:  { cost: 2, type: 'action' },    // 陨石天降
    stealth: { cost: 2, type: 'action' },
    double:  { cost: 3, type: 'action' },
    convert: { cost: 4, type: 'action' },
    thunder: { cost: 5, type: 'action' },
};

/** 该角色能否使用这个技能（装备 + 灵力 + 沉默状态） */
function canUseSkill(state, role, skillId) {
    const def = SKILL_DEFS[skillId];
    if (!def) return false;
    const loadout = state.loadouts[role];
    if (!Array.isArray(loadout) || !loadout.includes(skillId)) return false;
    if (state.mp[role] < def.cost) return false;
    if (state.silenced === role) return false;
    return true;
}

/** 断线后座位保留时长：给刷新/闪断留恢复窗口 */
const RESUME_GRACE_MS = 90 * 1000;
/** 房间无活动多久后清理 */
const ROOM_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;

function getTimeStr() {
    const d = new Date();
    return d.toTimeString().split(' ')[0].slice(0, 8);
}

/** 会话令牌：刷新页面后凭它恢复座位 */
function makeToken() {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** 房间活动时间戳，供 TTL 清理使用 */
function touch(room) {
    if (room) room.lastActiveAt = Date.now();
}

/** 定时清理闲置房间（只清「无活动」，有人在对局的不会被清） */
setInterval(() => {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (now - (room.lastActiveAt || 0) > ROOM_TTL_MS) {
            // 清理这个房间所有座位的保活定时器，避免泄漏
            for (const seat of Object.values(room.seats || {})) {
                if (seat && seat.dropTimer) clearTimeout(seat.dropTimer);
            }
            rooms.delete(id);
        }
    }
}, CLEANUP_INTERVAL_MS).unref();

function coordStr(r, c) {
    return `${String.fromCharCode(65 + c)}${r + 1}`;
}

function createInitialState() {
    return {
        board: Array.from({ length: SIZE }, () => Array(SIZE).fill(0)),
        shields: Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
        stealths: Array.from({ length: SIZE }, () => Array(SIZE).fill(false)),
        craters: [], // { r, c, duration, type: 'crater' | 'wind' }
        currentPlayer: 1,
        mp: { 1: 1, 2: 2 }, // 先手1点灵力，后手2点灵力补偿
        skillUsedThisTurn: false,
        doubleStep: 0,
        firstDoubleMove: null,
        lastMove: null,
        gameOver: false,
        // picking：等玩家选技能；playing：对局中；over：已结束
        phase: 'picking',
        loadouts: { 1: null, 2: null },  // 各自装备的 6 个技能 id
        ready: { 1: false, 2: false },
        mines: [],        // { r, c, owner } 诡雷，敌方不可见
        silenced: 0,      // 被沉默的角色，0 表示无
        inks: [],         // { r, c, owner, turns } 墨染标记
        portals: [],      // [{ a:{r,c}, b:{r,c}, owner, turns }] 鹊桥传送门，全场最多一对
        expiredInks: [],  // 到期腐化的位置，广播时播报并清空
        expiredStealths: [], // 到期显形的隐身子，播报后清空
        statusText: '请选择 6 个技能装备，准备开局'
    };
}

function addRoomLog(room, type, text, sender = '') {
    if (!room) return;
    const entry = { id: Date.now() + Math.random(), time: getTimeStr(), type, text, sender };
    room.logs.push(entry);
    if (room.logs.length > 80) room.logs.shift();
    io.to(room.id).emit('newLog', entry);
}

/** 把传送门对做成双向查找表：格子坐标 → 另一端坐标 */
function buildPortalMap(portals) {
    if (!Array.isArray(portals) || !portals.length) return null;
    const map = new Map();
    for (const p of portals) {
        if (!p || !p.a || !p.b) continue;
        map.set(p.a.r + ',' + p.a.c, p.b);
        map.set(p.b.r + ',' + p.b.c, p.a);
    }
    return map;
}

/** 从 from 看向 to，是否沿 (dr,dc) 方向且在前面（含斜线） */
function isAhead(dr, dc, fromR, fromC, toR, toC) {
    const vr = toR - fromR, vc = toC - fromC;
    if (vr === 0 && vc === 0) return false;
    if (dr === 0) return vr === 0 && Math.sign(vc) === dc;
    if (dc === 0) return vc === 0 && Math.sign(vr) === dr;
    return Math.abs(vr) === Math.abs(vc) && Math.sign(vr) === dr && Math.sign(vc) === dc;
}

/**
 * 沿一个方向数连续同色棋子。
 * 遇到传送门就跳到另一端继续（只跳一次），
 * 但要求另一端仍在同一条线的前方，否则视为断开——
 * 两个门不在同一线上时不该把不相干的棋串起来。
 *
 * 门格本身可以落子：
 *   - 门上空着 → 当纯通道跳过（压缩间隔）
 *   - 门上有己方棋子 → 先计数再跳（这枚子也算进连珠）
 *   - 门上有敌方棋子 → 断开
 */
function walkCount(board, r, c, dr, dc, player, portalMap) {
    let n = 0;
    let nr = r + dr, nc = c + dc;
    let jumped = false;

    while (n < 4) {
        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) break;

        const link = portalMap && portalMap.get(nr + ',' + nc);
        if (link && !jumped) {
            if (!isAhead(dr, dc, nr, nc, link.r, link.c)) break;

            // 这一端的门格
            if (board[nr][nc] === player) n++;
            else if (board[nr][nc] !== 0) break; // 门上是敌子，过不去

            jumped = true;

            // 另一端：己方子要计数，空门当通道跳过，敌子则断开
            if (board[link.r][link.c] === player) {
                n++;
            } else if (board[link.r][link.c] !== 0) {
                break;
            }
            nr = link.r + dr;
            nc = link.c + dc;
            continue;
        }

        if (board[nr][nc] !== player) break;
        n++;
        nr += dr; nc += dc;
    }
    return n;
}

function checkWin(board, r, c, player, portals) {
    const dirs = [[1,0], [0,1], [1,1], [1,-1]];
    const portalMap = buildPortalMap(portals);
    for (let [dr, dc] of dirs) {
        let count = 1;
        count += walkCount(board, r, c, dr, dc, player, portalMap);
        count += walkCount(board, r, c, -dr, -dc, player, portalMap);
        if (count >= 5) return true;
    }
    return false;
}

function isBlocked(craters, r, c) {
    return craters.some(cr => cr.r === r && cr.c === c);
}

/** 该格是否是传送门（门占住格子，不能再落子） */
function portalAt(state, r, c) {
    if (!Array.isArray(state.portals)) return false;
    return state.portals.some((p) =>
        (p.a.r === r && p.a.c === c) || (p.b.r === r && p.b.c === c)
    );
}

/**
 * 护盾：只抵挡一次攻击，随后消耗。
 *
 * 永久免疫会让【铁索连环】变成每回合白嫖的无敌（1费+每回合回1灵力），
 * 直接废掉飞沙/水淹/乾坤/雷劫四个技能。改成挡一次后，
 * 玩家需要真的决策「这盾套给谁、什么时候套」，对手也有破解路径。
 *
 * 返回 true 表示攻击被挡下；false 表示可以继续作用。
 */
function absorbHit(state, r, c) {
    if (state.shields[r][c]) {
        state.shields[r][c] = false;
        return true;
    }
    return false;
}

function getClientState(state, viewerRole) {
    const cloned = JSON.parse(JSON.stringify(state));
    if (!cloned.gameOver && (viewerRole === 1 || viewerRole === 2)) {
        for (let r = 0; r < SIZE; r++) {
            for (let c = 0; c < SIZE; c++) {
                if (cloned.stealths[r][c] && cloned.board[r][c] !== viewerRole) {
                    cloned.board[r][c] = 0;
                    cloned.stealths[r][c] = false;
                }
            }
        }
        // 诡雷只有主人自己能看到（观战者保留全部，方便看局）
        cloned.mines = (cloned.mines || []).filter((m) => m.owner === viewerRole);
    }
    return cloned;
}

function broadcastRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;

    // 隐形棋到期显形：nextTurn 只记录下来，这里统一播报（这里才有 room）
    if (room.state.expiredStealths && room.state.expiredStealths.length) {
        for (const pos of room.state.expiredStealths) {
            const who = room.state.board[pos.r][pos.c] === 1 ? '⚫黑方' : '⚪白方';
            addRoomLog(room, 'sys',
                `👁️ ${coordStr(pos.r, pos.c)} 的【🕵️暗度陈仓】隐形棋已到期显形（${who}）`);
        }
        room.state.expiredStealths = [];
    }

    // 墨染腐化播报
    if (room.state.expiredInks && room.state.expiredInks.length) {
        for (const pos of room.state.expiredInks) {
            addRoomLog(room, 'win',
                `☣️ ${coordStr(pos.r, pos.c)} 的棋子被【墨染】腐化，归属${pos.owner === 1 ? '⚫黑方' : '⚪白方'}！`);
        }
        room.state.expiredInks = [];
    }

    // 传送门到期播报
    if (room.state.expiredPortals && room.state.expiredPortals.length) {
        for (const p of room.state.expiredPortals) {
            addRoomLog(room, 'sys',
                `🌉 鹊桥 ${coordStr(p.a.r, p.a.c)} ⇄ ${coordStr(p.b.r, p.b.c)} 已消散`);
        }
        room.state.expiredPortals = [];
    }

    for (const [socketId, role] of Object.entries(room.players)) {
        io.to(socketId).emit('syncState', {
            state: getClientState(room.state, role),
            role,
            roomId,
            onlineCount: Object.keys(room.players).length,
            logs: room.logs
        });
    }
}

/** 隐形棋存在的大回合数（落子后，含本次共 3 次双方各走一步） */
const STEALTH_TURNS = 3;

function nextTurn(state, gainMp = true) {
    if (gainMp) state.mp[state.currentPlayer] = Math.min(MAX_MP, state.mp[state.currentPlayer] + 1);
    state.craters.forEach(cr => cr.duration--);
    state.craters = state.craters.filter(cr => cr.duration > 0);

    // 隐形棋计时：stealths 存的是剩余回合数，归零即自动显形（棋子保留）
    for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
            if (typeof state.stealths[r][c] === 'number' && state.stealths[r][c] > 0) {
                state.stealths[r][c]--;
                if (state.stealths[r][c] <= 0) {
                    state.stealths[r][c] = false; // 显形，棋子仍在盘上
                    if (state.board[r][c] !== 0) {
                        state.expiredStealths = state.expiredStealths || [];
                        state.expiredStealths.push({ r, c });
                    }
                }
            }
        }
    }

    // 墨染计时：到期时若目标仍是敌子，腐化为施法者颜色
    if (Array.isArray(state.inks) && state.inks.length) {
        const keep = [];
        for (const ink of state.inks) {
            ink.turns--;
            if (ink.turns > 0) {
                keep.push(ink);
                continue;
            }
            const victim = 3 - ink.owner;
            if (state.board[ink.r][ink.c] === victim) {
                state.board[ink.r][ink.c] = ink.owner;
                state.expiredInks = state.expiredInks || [];
                state.expiredInks.push({ r: ink.r, c: ink.c, owner: ink.owner });
                if (checkWin(state.board, ink.r, ink.c, ink.owner, state.portals)) {
                    state.gameOver = true;
                    state.statusText =
                        `🎉 ${ink.owner === 1 ? '黑方' : '白方'}通过【墨染】腐化敌子，五子连珠获胜！`;
                }
            }
            // 棋子已被清理/变色 → 墨染自然失效
        }
        state.inks = keep;
    }

    // 传送门计时：turns 初始为 3，本回合结束立刻 -1，
    // 之后每切换一次回合 -1，归零即消失（约 2 个大回合）
    if (Array.isArray(state.portals) && state.portals.length) {
        for (const p of state.portals) p.turns--;
        const expired = state.portals.filter((p) => p.turns <= 0);
        if (expired.length) {
            state.expiredPortals = (state.expiredPortals || []).concat(
                expired.map((p) => ({ a: p.a, b: p.b }))
            );
        }
        state.portals = state.portals.filter((p) => p.turns > 0);
    }

    state.currentPlayer = 3 - state.currentPlayer;
    state.doubleStep = 0;
    state.firstDoubleMove = null;

    // 沉默只作用于被沉默者的那一个回合；轮到别人时自动解除
    if (state.silenced && state.silenced !== state.currentPlayer) state.silenced = 0;
    state.skillUsedThisTurn = state.silenced === state.currentPlayer;

    if (!state.gameOver) {
        state.statusText = state.silenced === state.currentPlayer
            ? `${state.currentPlayer === 1 ? '黑方' : '白方'}回合：被【釜底抽薪】沉默，本回合只能普通落子`
            : `${state.currentPlayer === 1 ? '黑方' : '白方'}回合：请落子或发动技能`;
    }
}

/** 按 token 查找座位（重连恢复用） */
function findSeatByToken(room, token) {
    for (const role of [1, 2]) {
        const seat = room.seats && room.seats[role];
        if (seat && seat.token === token) {
            return { role, seat };
        }
    }
    return null;
}

/** 主动离开当前房间（换房时调用）：释放座位，不保留 */
function leaveCurrentRoom(socket) {
    if (!socket.roomId || !rooms.has(socket.roomId)) return;
    const room = rooms.get(socket.roomId);
    const role = room.players[socket.id];
    delete room.players[socket.id];

    // 主动离开才彻底释放座位（区别于断线的保留策略）
    if (role && room.seats[role] && room.seats[role].socketId === socket.id) {
        if (room.seats[role].dropTimer) clearTimeout(room.seats[role].dropTimer);
        room.seats[role] = null;
    }
    socket.leave(socket.roomId);

    if (Object.keys(room.players).length === 0) {
        rooms.delete(socket.roomId);
    } else {
        addRoomLog(room, 'sys',
            (role === 1 ? '⚫黑方' : (role === 2 ? '⚪白方' : '👀观战玩家')) + ' 离开了房间');
        broadcastRoom(socket.roomId);
    }
}

/**
 * 检查是否该开局：房间里所有在线玩家都选好技能了就开始。
 * 单人也能开（对手随时可中途加入 ready），避免必须等齐人才动不了。
 */
function maybeStartMatch(room) {
    const s = room.state;
    if (s.phase !== 'picking') return false;

    const seated = Object.values(room.players).filter((r) => r === 1 || r === 2);
    if (seated.length === 0) return false;

    const allReady = seated.every((r) => s.ready[r] && Array.isArray(s.loadouts[r]));
    if (!allReady) return false;

    s.phase = 'playing';
    s.statusText = '黑方回合：请落子或发动技能';
    addRoomLog(room, 'sys', '⚔️ 技能装备完成，对局开始！');
    return true;
}

/** 校验并规范化装备列表；不合法返回 null */
function normalizeLoadout(ids) {
    if (!Array.isArray(ids) || ids.length !== LOADOUT_SIZE) return null;
    const uniq = [...new Set(ids)];
    if (uniq.length !== LOADOUT_SIZE) return null;
    if (uniq.some((id) => !SKILL_DEFS[id])) return null;
    return uniq;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', (payload) => {
        // 兼容两种调用：joinRoom('ABC123') 或 joinRoom({ roomId, loadout })
        const rawId = typeof payload === 'string' ? payload : (payload && payload.roomId);
        const wantedLoadout = payload && typeof payload === 'object' ? payload.loadout : null;

        const roomId = String(rawId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
        if (!roomId) return socket.emit('errMsg', '❌ 请输入有效的字母数字房间号！');

        leaveCurrentRoom(socket);

        if (!rooms.has(roomId)) {
            rooms.set(roomId, {
                id: roomId,
                state: createInitialState(),
                players: {},
                seats: {},
                logs: [],
                lastActiveAt: Date.now(),
            });
        }
        const room = rooms.get(roomId);
        touch(room);

        let role = 0;
        const saved = socket.resumeToken && findSeatByToken(room, socket.resumeToken);
        if (saved) {
            role = saved.role;
            clearTimeout(saved.seat.dropTimer);
            saved.seat.dropTimer = null;
            saved.seat.socketId = socket.id;
        } else {
            const taken = Object.values(room.players);
            if (!taken.includes(1)) role = 1;
            else if (!taken.includes(2)) role = 2;
            if (role === 0) {
                for (const r of [1, 2]) {
                    if (room.seats[r] && !Object.values(room.players).includes(r)) {
                        clearTimeout(room.seats[r].dropTimer);
                        room.seats[r].dropTimer = null;
                        room.seats[r].socketId = socket.id;
                        role = r;
                        break;
                    }
                }
            }
        }

        const token = (room.seats[role] && room.seats[role].token) || makeToken();
        room.seats[role] = { token, socketId: socket.id, dropTimer: null };
        room.players[socket.id] = role;
        socket.roomId = roomId;
        socket.join(roomId);

        socket.emit('session', { token, role, roomId });

        const roleLabel = role === 1 ? '⚫黑方' : (role === 2 ? '⚪白方' : '👀观战');
        addRoomLog(room, 'sys',
            saved ? roleLabel + ' 重新连接，恢复座位' : '玩家加入房间 [' + roomId + ']，分配身份：' + roleLabel);

        // 进房时直接带上技能装备（创建/加入房间时选好的）
        const loadout = normalizeLoadout(wantedLoadout);
        if (loadout && (role === 1 || role === 2) && !Array.isArray(room.state.loadouts[role])) {
            room.state.loadouts[role] = loadout;
            room.state.ready[role] = true;
            addRoomLog(room, 'sys', `${roleLabel} 已装备 ${LOADOUT_SIZE} 个技能`);
            maybeStartMatch(room);
        }

        broadcastRoom(roomId);
    });

    // 断线重连：凭 token 恢复座位。
    // 刷新后 socket.io 拿到新连接，按 token 找回原座位，
    // 避免「刷新一下就从玩家变观战」。
    socket.on('resume', (payload) => {
        const rid = String(payload && payload.roomId || '').trim().toUpperCase();
        const tk = payload && payload.token;

        // 失败必须明确告知客户端，否则前端会一直停在“恢复中”
        if (!tk) return socket.emit('resumeFailed', { reason: 'missing-token' });

        const room = rooms.get(rid);
        if (!room) return socket.emit('resumeFailed', { reason: 'room-gone', roomId: rid });

        const found = findSeatByToken(room, tk);
        if (!found) return socket.emit('resumeFailed', { reason: 'token-expired', roomId: rid });

        leaveCurrentRoom(socket);
        clearTimeout(found.seat.dropTimer);
        found.seat.dropTimer = null;
        found.seat.socketId = socket.id;

        room.players[socket.id] = found.role;
        socket.roomId = rid;
        socket.join(rid);
        touch(room);

        socket.emit('session', { token: tk, role: found.role, roomId: rid });
        addRoomLog(room, 'sys',
            (found.role === 1 ? '⚫黑方' : (found.role === 2 ? '⚪白方' : '👀观战')) + ' 断线重连成功');
        broadcastRoom(rid);
    });

    /**
     * 选择技能装备。必须校验：数量、是否重复、id 是否合法。
     * 校验不通过直接拒绝，不能信任客户端。
     */
    socket.on('setLoadout', (ids) => {
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        if (role !== 1 && role !== 2) return socket.emit('errMsg', '❌ 观战者不能选择技能');

        const s = room.state;
        if (s.gameOver) return socket.emit('errMsg', '❌ 对局已结束，请先重开');
        // 已经装备过且对局进行中 → 不许中途换
        // 但「对局已开始 + 自己还没装备」（后进房）要允许补选，
        // 否则先 ready 的一方开局后，后到的人永远选不了技能。
        if (s.phase === 'playing' && Array.isArray(s.loadouts[role])) {
            return socket.emit('errMsg', '❌ 对局已开始，无法更换技能');
        }

        if (!Array.isArray(ids) || ids.length !== LOADOUT_SIZE) {
            return socket.emit('errMsg', `❌ 请恰好选择 ${LOADOUT_SIZE} 个技能`);
        }
        const uniq = [...new Set(ids)];
        if (uniq.length !== LOADOUT_SIZE) return socket.emit('errMsg', '❌ 技能不能重复');
        const bad = uniq.find((id) => !SKILL_DEFS[id]);
        if (bad) return socket.emit('errMsg', `❌ 未知技能：${bad}`);

        s.loadouts[role] = uniq;
        s.ready[role] = true;
        touch(room);
        addRoomLog(room, 'sys',
            `${role === 1 ? '⚫黑方' : '⚪白方'} 已装备 ${LOADOUT_SIZE} 个技能`);

        maybeStartMatch(room);
        broadcastRoom(socket.roomId);
    });

    socket.on('sendChat', (msg) => {
        touch(rooms.get(socket.roomId));
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const cleanMsg = String(msg || '').trim().slice(0, 80);
        if (!cleanMsg) return;
        const role = room.players[socket.id];
        const sender = role === 1 ? '⚫黑方' : (role === 2 ? '⚪白方' : '👀观战');
        addRoomLog(room, 'chat', cleanMsg, sender);
        io.to(socket.roomId).emit('sound', 'chat');
    });

    socket.on('restartRoom', () => {
        touch(rooms.get(socket.roomId));
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        const who = role === 1 ? '⚫黑方' : (role === 2 ? '⚪白方' : '👀观战');

        // 保留双方技能装备：连战不用每次重选。
        // 想换装备可以重新进房，或点「重新选技能」。
        const keepLoadouts = room.state.loadouts || { 1: null, 2: null };
        const keepReady = room.state.ready || { 1: false, 2: false };

        room.state = createInitialState();
        room.state.loadouts = keepLoadouts;
        room.state.ready = keepReady;

        addRoomLog(room, 'sys', `🔄 ${who} 重置了棋局`);
        if (!maybeStartMatch(room)) {
            room.state.statusText = '请选择技能装备，准备开局';
        }
        broadcastRoom(socket.roomId);
        io.to(socket.roomId).emit('sound', 'skill');
    });

    /** 主动退出对局：释放座位并通知房间 */
    socket.on('leaveRoom', () => {
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        if (role === 1 || role === 2) {
            addRoomLog(room, 'sys',
                `${role === 1 ? '⚫黑方' : '⚪白方'} 退出了对局`);
        }
        socket.bridgeFirst = null;
        leaveCurrentRoom(socket);
    });

    /** 重新选技能（对局结束后想换装备） */
    socket.on('resetLoadout', () => {
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        if (role !== 1 && role !== 2) return;

        room.state.loadouts[role] = null;
        room.state.ready[role] = false;
        // 双方都退回选技能阶段
        room.state.phase = 'picking';
        room.state.statusText = '请重新选择 6 个技能装备';
        addRoomLog(room, 'sys',
            `${role === 1 ? '⚫黑方' : '⚪白方'} 请求重新选择技能`);
        broadcastRoom(socket.roomId);
    });

    socket.on('activateDouble', () => {
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        const s = room.state;
        if (s.gameOver || role !== s.currentPlayer) return;
        if (s.phase !== 'playing') return;
        // 天涯海角走独立事件，同样要过装备/灵力/沉默校验
        if (s.skillUsedThisTurn || s.doubleStep !== 0 || !canUseSkill(s, role, 'double')) return;

        s.mp[role] -= 3;
        s.skillUsedThisTurn = true;
        s.doubleStep = 1;
        const pName = role === 1 ? '⚫黑方' : '⚪白方';
        s.statusText = '⚡ 【天涯海角】已发动！请落第一子（不可直接五连）';
        addRoomLog(room, 'skill', `${pName} 消耗 3⚡ 发动了【⚡ 天涯海角】！`);
        broadcastRoom(socket.roomId);
        io.to(socket.roomId).emit('sound', 'skill');
    });

    socket.on('boardAction', ({ r, c, skill }) => {
        touch(rooms.get(socket.roomId));
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        const s = room.state;
        if (!role) return; // 观战者不能操作
        if (s.gameOver || role !== s.currentPlayer) return;
        if (s.phase !== 'playing') return socket.emit('errMsg', '⚠️ 请先选择技能装备，再开始对局');
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;

        const enemy = 3 - role;
        const pName = role === 1 ? '黑方' : '白方';
        const pTag = role === 1 ? '⚫黑方' : '⚪白方';
        const enemyName = enemy === 1 ? '黑方' : '白方';
        const pos = coordStr(r, c);

        // 普通落子说明本回合结束，之前没点完的「鹊桥第一点」作废，
        // 否则下一个回合会被误当成第二次点击。
        if (!skill && socket.bridgeFirst) socket.bridgeFirst = null;

        // 1. 指向性技能处理
        if (skill && !s.skillUsedThisTurn && s.doubleStep === 0) {
            // 服务端权威校验：装备过 / 灵力够 / 未被沉默。
            // 不能只靠前端把按钮置灰，改前端就能绕过。
            if (!canUseSkill(s, role, skill)) {
                const why = s.silenced === role ? '你正处于【釜底抽薪】的沉默状态，本回合无法使用技能'
                    : !(s.loadouts[role] || []).includes(skill) ? '该技能未装备'
                    : '灵力不足';
                return socket.emit('errMsg', '❌ ' + why);
            }

            // 换成别的技能就丢掉「鹊桥第一点」，避免半截状态残留
            if (skill !== 'bridge' && socket.bridgeFirst) socket.bridgeFirst = null;
            if (skill === 'sand' && s.mp[role] >= 2) {
                if (s.board[r][c] !== enemy) return socket.emit('errMsg', '❌ 请选择敌方棋子！');
                if (s.lastMove && s.lastMove.r === r && s.lastMove.c === c) return socket.emit('errMsg', '❌ 规则保护：不能吹走对方刚落下的棋子！');

                // 护盾挡一次：消耗护盾并终止本次攻击，不扣灵力、不消耗回合技能次数
                if (absorbHit(s, r, c)) {
                    addRoomLog(room, 'skill', `🛡️ ${pTag} 的【飞沙走石】被 [${pos}] 的护盾挡下，护盾已消耗！`);
                    s.statusText = '🛡️ 目标棋子的护盾挡下了飞沙走石！护盾已消耗';
                    io.to(socket.roomId).emit('sound', 'skill');
                    return broadcastRoom(socket.roomId);
                }

                let emptyNeighbors = [];
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        let nr = r + dr, nc = c + dc;
                        if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && s.board[nr][nc] === 0 && !isBlocked(s.craters, nr, nc)) {
                            emptyNeighbors.push({ nr, nc });
                        }
                    }
                }

                s.board[r][c] = 0;
                s.stealths[r][c] = false;
                s.craters.push({ r, c, duration: 2, type: 'wind' });
                s.mp[role] -= 2;
                s.skillUsedThisTurn = true;

                if (emptyNeighbors.length > 0) {
                    const target = emptyNeighbors[Math.floor(Math.random() * emptyNeighbors.length)];
                    const toPos = coordStr(target.nr, target.nc);
                    s.board[target.nr][target.nc] = enemy;
                    addRoomLog(room, 'skill', `${pTag} 对 [${pos}] 发动【🌪️飞沙走石】，敌子被吹偏至 [${toPos}]，原位留风眼！`);
                    if (checkWin(s.board, target.nr, target.nc, enemy, s.portals)) {
                        s.gameOver = true;
                        s.statusText = `😱 弄巧成拙！【飞沙走石】把${enemyName}的棋子吹成了五子连珠！${enemyName}获胜！`;
                        addRoomLog(room, 'win', `😱 借风成势！${enemyName}被吹歪的棋子直接连成五子获胜！`);
                        io.to(socket.roomId).emit('sound', 'win');
                        return broadcastRoom(socket.roomId);
                    }
                    s.statusText = `🌪️ ${pName}发动【飞沙走石】将敌子吹歪，原地留下风眼禁区！请继续落子`;
                } else {
                    addRoomLog(room, 'skill', `${pTag} 对 [${pos}] 发动【🌪️飞沙走石】，周围无空位直接吹散！`);
                    s.statusText = `🌪️ 周围无空位，敌子被直接吹散，原地留下风眼禁区！请继续落子`;
                }

                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'crater' && s.mp[role] >= 2) {
                if (s.board[r][c] !== 0 || isBlocked(s.craters, r, c)) return socket.emit('errMsg', '❌ 请选择空位放置路障！');
                s.craters.push({ r, c, duration: 4, type: 'crater' });
                s.mp[role] -= 2; s.skillUsedThisTurn = true;
                s.statusText = `🧱 ${pName}布下【画地为牢】！请继续落子`;
                addRoomLog(room, 'skill', `${pTag} 在 [${pos}] 布下【🧱画地为牢】封印路障！`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'shield' && s.mp[role] >= 1) {
                if (s.board[r][c] !== role || s.shields[r][c]) return socket.emit('errMsg', '❌ 请选择己方未加护盾的棋子！');
                s.shields[r][c] = true;
                s.mp[role] -= 1;
                s.skillUsedThisTurn = true;
                s.statusText = `🛡️ ${pName}加固了【铁索连环】！请继续落子`;
                addRoomLog(room, 'skill', `${pTag} 为 [${pos}] 的棋子套上了【🛡️铁索连环】永久护盾！`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'flood' && s.mp[role] >= 3) {
                // 有护盾的棋子仍可被选中，但会挡下一次（护盾消耗）
                let targets = [];
                let blockedCount = 0;
                for (let col = 0; col < SIZE; col++) {
                    if (s.board[r][col] !== 0) targets.push(col);
                }
                if (targets.length === 0) return socket.emit('errMsg', '❌ 该行没有棋子！');

                const removed = targets.sort(() => Math.random() - 0.5).slice(0, 2);
                removed.forEach(col => {
                    if (absorbHit(s, r, col)) {
                        blockedCount++;
                    } else {
                        s.board[r][col] = 0; s.stealths[r][col] = false;
                    }
                });
                s.mp[role] -= 3; s.skillUsedThisTurn = true;
                s.statusText = `🌊 ${pName}发动【水淹七军】冲散了第 ${r+1} 行！请继续落子`;
                addRoomLog(room, 'skill',
                    `${pTag} 发动【🌊水淹七军】冲走第 ${r+1} 行 ${removed.length - blockedCount} 枚棋子` +
                    (blockedCount ? `（${blockedCount} 枚被护盾挡下）` : ''));
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'convert' && s.mp[role] >= 4) {
                if (s.board[r][c] !== enemy) return socket.emit('errMsg', '❌ 请选择敌方棋子！');
                if (s.lastMove && s.lastMove.r === r && s.lastMove.c === c) return socket.emit('errMsg', '❌ 不能转化对方刚落下的子！');

                // 护盾挡一次
                if (absorbHit(s, r, c)) {
                    addRoomLog(room, 'skill', `🛡️ ${pTag} 的【乾坤挪移】被 [${pos}] 的护盾挡下，护盾已消耗！`);
                    s.statusText = '🛡️ 目标棋子的护盾挡下了乾坤挪移！护盾已消耗';
                    io.to(socket.roomId).emit('sound', 'skill');
                    return broadcastRoom(socket.roomId);
                }

                s.board[r][c] = role; s.stealths[r][c] = false;
                s.mp[role] -= 4; s.lastMove = { r, c, player: role };
                addRoomLog(room, 'skill', `${pTag} 发动【☯️乾坤挪移】将 [${pos}] 的敌子策反为己方！`);
                if (checkWin(s.board, r, c, role, s.portals)) {
                    s.gameOver = true;
                    s.statusText = `🎉 ${pName}通过【乾坤挪移】绝杀获胜！`;
                    addRoomLog(room, 'win', `🎉 ${pTag} 通过【☯️乾坤挪移】完成五连绝杀获胜！`);
                    io.to(socket.roomId).emit('sound', 'win');
                } else {
                    nextTurn(s, true);
                    io.to(socket.roomId).emit('sound', 'skill');
                }
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'thunder' && s.mp[role] >= 5) {
                let count = 0;
                let blockedCount = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        let nr = r + dr, nc = c + dc;
                        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
                        if (s.board[nr][nc] === 0) continue;
                        if (absorbHit(s, nr, nc)) { blockedCount++; continue; }
                        s.board[nr][nc] = 0; s.stealths[nr][nc] = false; count++;
                    }
                }
                s.mp[role] -= 5;
                nextTurn(s, true);
                s.statusText = `🌩️ ${pName}降下【九天雷劫】炸毁一片区域！轮到对方回合`;
                addRoomLog(room, 'skill',
                    `${pTag} 在 [${pos}] 降下【🌩️九天雷劫】，炸毁 ${count} 枚棋子` +
                    (blockedCount ? `，${blockedCount} 枚被护盾挡下` : ''));
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'mine' && s.mp[role] >= 2) {
                if (s.board[r][c] !== 0 || isBlocked(s.craters, r, c)) {
                    return socket.emit('errMsg', '❌ 请选择空位埋雷！');
                }
                if ((s.mines || []).some((m) => m.r === r && m.c === c)) {
                    return socket.emit('errMsg', '❌ 这里已经埋了雷！');
                }
                s.mines.push({ r, c, owner: role });
                s.mp[role] -= 2;
                s.skillUsedThisTurn = true; // 瞬发：本回合仍可继续落子
                s.statusText = `💣 ${pName}秘密埋下一颗诡雷！请继续落子`;
                addRoomLog(room, 'skill', `${pTag} 秘密埋下一颗【💣草木皆兵】诡雷！（坐标保密）`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'silence' && s.mp[role] >= 2) {
                // 削减敌方 1 点灵力，并让敌方下一个回合无法使用技能
                const before = s.mp[enemy];
                s.mp[enemy] = Math.max(0, s.mp[enemy] - 1);
                s.silenced = enemy;
                s.mp[role] -= 2;
                s.skillUsedThisTurn = true;
                s.statusText = `⛓️ ${pName}发动【釜底抽薪】！${enemyName}下回合陷入沉默`;
                addRoomLog(room, 'skill',
                    `${pTag} 发动【⛓️釜底抽薪】，${enemyName}灵力 ${before} → ${s.mp[enemy]}，下回合陷入沉默！`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'ink' && s.mp[role] >= 3) {
                if (s.board[r][c] !== enemy) return socket.emit('errMsg', '❌ 请选择敌方棋子！');
                if (absorbHit(s, r, c)) {
                    addRoomLog(room, 'skill', `🛡️ ${pTag} 的【墨染】被 [${pos}] 的护盾挡下，护盾已消耗！`);
                    s.statusText = '🛡️ 目标棋子的护盾挡下了墨染！护盾已消耗';
                    io.to(socket.roomId).emit('sound', 'skill');
                    return broadcastRoom(socket.roomId);
                }
                if ((s.inks || []).some((k) => k.r === r && k.c === c)) {
                    return socket.emit('errMsg', '❌ 这枚棋子已经被墨染了！');
                }
                // 3 表示还要经过 3 次回合切换才腐化（约 1.5 个大回合）
                s.inks.push({ r, c, owner: role, turns: 3 });
                s.mp[role] -= 3;
                s.skillUsedThisTurn = true;
                s.statusText = `☣️ ${pName}对 [${pos}] 的棋子施加了墨染！请继续落子`;
                addRoomLog(room, 'skill',
                    `${pTag} 对 [${pos}] 的敌子施加【☣️墨染】，3 步内不清理就会腐化！`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'sacrifice') {
                if (s.board[r][c] !== role) return socket.emit('errMsg', '❌ 请选择己方棋子销毁！');
                s.board[r][c] = 0;
                s.stealths[r][c] = false;
                s.shields[r][c] = false;
                const gained = Math.min(MAX_MP, s.mp[role] + 2) - s.mp[role];
                s.mp[role] += gained;
                s.skillUsedThisTurn = true;
                s.statusText = `🩸 ${pName}牺牲一枚棋子，换得 ${gained} 点灵力！请继续落子`;
                addRoomLog(room, 'skill',
                    `${pTag} 发动【🩸苦肉计】，销毁 [${pos}] 的己方棋子，灵力 +${gained}`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'bridge') {
                // 两次点击选两点：第一次记在 socket 上，第二次才真正生效
                if (s.board[r][c] !== 0 || isBlocked(s.craters, r, c)) {
                    return socket.emit('errMsg', '❌ 传送门必须放在空位上！');
                }
                if (portalAt(s, r, c)) return socket.emit('errMsg', '❌ 这里已经有传送门了！');

                if (!socket.bridgeFirst) {
                    socket.bridgeFirst = { r, c };
                    s.statusText = `🌉 已选定第一个传送门 [${pos}]，请点击第二个空位`;
                    return broadcastRoom(socket.roomId);
                }

                const first = socket.bridgeFirst;
                socket.bridgeFirst = null;
                if (first.r === r && first.c === c) {
                    return socket.emit('errMsg', '❌ 两个传送门不能在同一格，请重新选择鹊桥');
                }
                if (Math.abs(first.r - r) <= 1 && Math.abs(first.c - c) <= 1) {
                    return socket.emit('errMsg', '❌ 两个传送门不能相邻，请重新选择鹊桥');
                }

                const p1 = coordStr(first.r, first.c);
                // 全场只保留一对，新的覆盖旧的
                s.portals = [{ a: first, b: { r, c }, owner: role, turns: 3 }];
                s.mp[role] -= 3;
                s.skillUsedThisTurn = true;
                s.statusText = `🌉 ${pName}架起鹊桥：${p1} ⇄ ${pos}，2 回合内视为相邻`;
                addRoomLog(room, 'skill',
                    `${pTag} 发动【🌉鹊桥相会】：${p1} 与 ${pos} 相连，2 回合内视为相邻！`);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
            if (skill === 'meteor') {
                if (s.board[r][c] !== 0 || isBlocked(s.craters, r, c)) {
                    return socket.emit('errMsg', '❌ 陨石需要砸在空位上！');
                }

                s.board[r][c] = role;
                s.stealths[r][c] = false;
                s.shields[r][c] = false;

                // 冲击波：周围 8 格的无护盾棋子向外震退 1 格
                let pushed = 0, stuck = 0;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr, nc = c + dc;
                        if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) continue;
                        if (s.board[nr][nc] === 0) continue;
                        if (s.shields[nr][nc]) { stuck++; continue; }

                        // 震退目标 = 中心 + 2 倍方向
                        const tr = r + dr * 2, tc = c + dc * 2;
                        const blocked = tr < 0 || tr >= SIZE || tc < 0 || tc >= SIZE ||
                            s.board[tr][tc] !== 0 || isBlocked(s.craters, tr, tc) || portalAt(s, tr, tc);
                        if (blocked) { stuck++; continue; }

                        s.board[tr][tc] = s.board[nr][nc];
                        s.stealths[tr][tc] = s.stealths[nr][nc];
                        s.shields[tr][tc] = false;
                        s.board[nr][nc] = 0;
                        s.stealths[nr][nc] = false;
                        pushed++;
                    }
                }

                s.mp[role] -= 2;
                const won = checkWin(s.board, r, c, role, s.portals);
                s.statusText = `☄️ ${pName}召唤陨石砸在 [${pos}]！震退 ${pushed} 枚棋子` +
                    (stuck ? `，${stuck} 枚被挡住` : '');
                addRoomLog(room, 'skill',
                    `${pTag} 在 [${pos}] 落下【☄️陨石天降】，震退 ${pushed} 枚棋子` +
                    (stuck ? `，${stuck} 枚无法震退` : ''));

                if (won) {
                    s.gameOver = true;
                    s.statusText = `🎉 ${pName}借助陨石冲击波完成五连，获胜！`;
                    addRoomLog(room, 'win', `🎉 ${pTag} 的【☄️陨石天降】直接砸出五连，拿下胜利！`);
                    io.to(socket.roomId).emit('sound', 'win');
                    return broadcastRoom(socket.roomId);
                }

                nextTurn(s, true);
                io.to(socket.roomId).emit('sound', 'skill');
                return broadcastRoom(socket.roomId);
            }
        }

        // 2. 踩中敌方隐身子判定
        if (s.board[r][c] === enemy && s.stealths[r][c]) {
            s.stealths[r][c] = false;
            s.doubleStep = 0; s.firstDoubleMove = null;
            nextTurn(s, false);
            s.statusText = `💥 ${pName}踩中了敌方的【暗度陈仓】隐身棋！本回合落子作废且不回能！`;
            addRoomLog(room, 'skill', `💥 ${pTag} 落子 [${pos}] 不慎踩中敌方【🕵️暗度陈仓】隐身雷！行动取消且不回能！`);
            io.to(socket.roomId).emit('sound', 'skill');
            return broadcastRoom(socket.roomId);
        }

        if (s.board[r][c] !== 0 || isBlocked(s.craters, r, c)) {
            return socket.emit('errMsg', '❌ 该位置已有棋子、处于风眼或被路障封印！');
        }
        // 注意：传送门格是允许落子的（门上站子也算连珠节点），
        // 所以这里不再用 portalAt 拦截。

        // 自己的雷占着位置，别让棋子压上去
        if ((s.mines || []).some((m) => m.owner === role && m.r === r && m.c === c)) {
            return socket.emit('errMsg', '❌ 这里埋着你的诡雷，换一个位置吧');
        }

        // 诡雷：敌方在雷自身或其周围 1 格落子都会引爆
        const mineIdx = (s.mines || []).findIndex(
            (m) => m.owner !== role && Math.max(Math.abs(m.r - r), Math.abs(m.c - c)) <= 1
        );
        if (mineIdx >= 0) {
            s.mines.splice(mineIdx, 1); // 雷是一次性的
            // 落点化作封印弹坑
            s.craters.push({ r, c, duration: 2, type: 'crater' });
            s.doubleStep = 0;
            s.firstDoubleMove = null;
            nextTurn(s, false); // 落子作废，且不回灵力
            s.statusText = `💥 ${pName}踩中诡雷！落子被炸毁，[${pos}] 化为封印弹坑`;
            addRoomLog(room, 'skill',
                `💥 ${pTag} 落子 [${pos}] 触发【💣草木皆兵】诡雷！棋子被炸毁，原地封印 2 回合`);
            io.to(socket.roomId).emit('sound', 'skill');
            return broadcastRoom(socket.roomId);
        }

        // 3. 【天涯海角】第一子与第二子判定
        if (s.doubleStep === 1) {
            s.board[r][c] = role;
            if (checkWin(s.board, r, c, role, s.portals)) {
                s.board[r][c] = 0;
                return socket.emit('errMsg', '⚠️ 【天涯海角】期间不可直接连成五子获胜！');
            }
            s.firstDoubleMove = { r, c };
            s.lastMove = { r, c, player: role };
            s.doubleStep = 2;
            s.statusText = `⚡ 请落第二子！（必须与第一子相距至少 4 格，且不可直接绝杀）`;
            addRoomLog(room, 'move', `${pTag} 【天涯海角·第一子】落于 [${pos}]`);
            io.to(socket.roomId).emit('sound', 'place');
            return broadcastRoom(socket.roomId);
        }

        if (s.doubleStep === 2) {
            const dist = Math.max(Math.abs(r - s.firstDoubleMove.r), Math.abs(c - s.firstDoubleMove.c));
            if (dist < 4) {
                return socket.emit('errMsg', `❌ 距离太近（当前仅隔 ${dist} 格）！【天涯海角】第二子必须下在 4 格以外！`);
            }
            s.board[r][c] = role;
            if (checkWin(s.board, r, c, role, s.portals)) {
                s.board[r][c] = 0;
                return socket.emit('errMsg', '⚠️ 【天涯海角】第二子不可直接绝杀！只能做局或远端防守。');
            }
            s.lastMove = { r, c, player: role };
            addRoomLog(room, 'move', `${pTag} 【天涯海角·第二子】远端落于 [${pos}]`);
            nextTurn(s, true);
            io.to(socket.roomId).emit('sound', 'place');
            return broadcastRoom(socket.roomId);
        }

        // 4. 隐身落子或正常落子
        const isStealth = (skill === 'stealth' && !s.skillUsedThisTurn && s.mp[role] >= 2);
        if (isStealth) {
            s.mp[role] -= 2;
            // 存剩余回合数。落子后紧接着会 nextTurn 减 1，
            // 所以这里 +1 让玩家实际享受到完整的 3 个回合隐形。
            s.stealths[r][c] = STEALTH_TURNS + 1;
            addRoomLog(room, 'skill',
                `${pTag} 发动【🕵️暗度陈仓】落下一枚隐身棋子！（坐标保密，${STEALTH_TURNS} 回合后自动显形）`);
            io.to(socket.roomId).emit('sound', 'skill');
        } else {
            addRoomLog(room, 'move', `${pTag} 落子于 [${pos}]`);
            io.to(socket.roomId).emit('sound', 'place');
        }

        s.board[r][c] = role;
        s.lastMove = { r, c, player: role };

        if (checkWin(s.board, r, c, role, s.portals)) {
            s.stealths[r][c] = false;
            s.gameOver = true;
            s.statusText = `🎉 恭喜！${pName}五子连珠获胜！`;
            addRoomLog(room, 'win', `🎉 恭喜 ${pTag} 在 [${pos}] 连成五子获胜！`);
            io.to(socket.roomId).emit('sound', 'win');
            return broadcastRoom(socket.roomId);
        }

        nextTurn(s, true);
        broadcastRoom(socket.roomId);
    });

    socket.on('disconnect', () => {
        if (socket.roomId && rooms.has(socket.roomId)) {
            const room = rooms.get(socket.roomId);
            const role = room.players[socket.id];
            delete room.players[socket.id];

            // 座位保留一段时间供重连恢复；计时器到点后彻底释放
            if (role && room.seats[role] && room.seats[role].socketId === socket.id) {
                const seat = room.seats[role];
                if (seat.dropTimer) clearTimeout(seat.dropTimer);
                seat.dropTimer = setTimeout(() => {
                    if (rooms.has(socket.roomId) && room.seats[role] &&
                        room.seats[role].socketId === socket.id &&
                        !Object.values(room.players).includes(role)) {
                        room.seats[role] = null;
                        addRoomLog(room, 'sys',
                            (role === 1 ? '⚫黑方' : '⚪白方') + ' 超时未归，座位已释放');
                        broadcastRoom(socket.roomId);
                    }
                }, RESUME_GRACE_MS);
                // timer 持有 room 引用，房间若先被清理也没关系 —— 回调里有 has 检查
                seat.dropTimer.unref();
            }

            // 全员离线且无保活座位 → 立即清房；否则等 TTL
            const anyoneLeft = Object.keys(room.players).length > 0;
            if (!anyoneLeft) {
                const hasLiveSeat = Object.values(room.seats).some(
                    (seat) => seat && seat.dropTimer
                );
                if (!hasLiveSeat) {
                    for (const seat of Object.values(room.seats)) {
                        if (seat && seat.dropTimer) clearTimeout(seat.dropTimer);
                    }
                    rooms.delete(socket.roomId);
                }
            } else {
                addRoomLog(room, 'sys',
                    (role === 1 ? '⚫黑方' : (role === 2 ? '⚪白方' : '👀观战')) +
                    ' 断开了连接（' + Math.round(RESUME_GRACE_MS / 1000) + ' 秒内可重连）');
                broadcastRoom(socket.roomId);
            }
        }
    });
});

server.listen(8080, () => console.log('Skill Gomoku Online running on port 8080'));