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
        expiredStealths: [], // 本轮到期显形的隐身子，播报后清空
        statusText: '黑方回合：请落子或发动技能'
    };
}

function addRoomLog(room, type, text, sender = '') {
    if (!room) return;
    const entry = { id: Date.now() + Math.random(), time: getTimeStr(), type, text, sender };
    room.logs.push(entry);
    if (room.logs.length > 80) room.logs.shift();
    io.to(room.id).emit('newLog', entry);
}

function checkWin(board, r, c, player) {
    const dirs = [[1,0], [0,1], [1,1], [1,-1]];
    for (let [dr, dc] of dirs) {
        let count = 1;
        for (let i = 1; i < 5; i++) {
            let nr = r + dr*i, nc = c + dc*i;
            if (nr>=0 && nr<SIZE && nc>=0 && nc<SIZE && board[nr][nc]===player) count++; else break;
        }
        for (let i = 1; i < 5; i++) {
            let nr = r - dr*i, nc = c - dc*i;
            if (nr>=0 && nr<SIZE && nc>=0 && nc<SIZE && board[nr][nc]===player) count++; else break;
        }
        if (count >= 5) return true;
    }
    return false;
}

function isBlocked(craters, r, c) {
    return craters.some(cr => cr.r === r && cr.c === c);
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

    state.currentPlayer = 3 - state.currentPlayer;
    state.skillUsedThisTurn = false;
    state.doubleStep = 0;
    state.firstDoubleMove = null;
    state.statusText = `${state.currentPlayer === 1 ? '黑方' : '白方'}回合：请落子或发动技能`;
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

io.on('connection', (socket) => {
    socket.on('joinRoom', (roomId) => {
        roomId = String(roomId || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
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
        broadcastRoom(roomId);
    });

    // 断线重连：凭 token 恢复座位。
    // 刷新后 socket.io 拿到新连接，按 token 找回原座位，
    // 避免「刷新一下就从玩家变观战」。
    socket.on('resume', (payload) => {
        const rid = String(payload && payload.roomId || '').trim().toUpperCase();
        const tk = payload && payload.token;
        const room = rooms.get(rid);
        if (!room || !tk) return;

        const found = findSeatByToken(room, tk);
        if (!found) return socket.emit('errMsg', '❌ 会话已过期，请重新加入房间');

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
        room.state = createInitialState();
        addRoomLog(room, 'sys', `🔄 ${who} 重置了棋局，新对局开始！`);
        broadcastRoom(socket.roomId);
        io.to(socket.roomId).emit('sound', 'skill');
    });

    socket.on('activateDouble', () => {
        const room = rooms.get(socket.roomId);
        if (!room) return;
        const role = room.players[socket.id];
        const s = room.state;
        if (s.gameOver || role !== s.currentPlayer || s.skillUsedThisTurn || s.doubleStep !== 0 || s.mp[role] < 3) return;

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
        if (s.gameOver || role !== s.currentPlayer) return;
        if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return;

        const enemy = 3 - role;
        const pName = role === 1 ? '黑方' : '白方';
        const pTag = role === 1 ? '⚫黑方' : '⚪白方';
        const enemyName = enemy === 1 ? '黑方' : '白方';
        const pos = coordStr(r, c);

        // 1. 指向性技能处理
        if (skill && !s.skillUsedThisTurn && s.doubleStep === 0) {
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
                    if (checkWin(s.board, target.nr, target.nc, enemy)) {
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
                if (checkWin(s.board, r, c, role)) {
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

        // 3. 【天涯海角】第一子与第二子判定
        if (s.doubleStep === 1) {
            s.board[r][c] = role;
            if (checkWin(s.board, r, c, role)) {
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
            if (checkWin(s.board, r, c, role)) {
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

        if (checkWin(s.board, r, c, role)) {
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