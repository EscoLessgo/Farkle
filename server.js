import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { calculateScore, hasPossibleMoves, isScoringSelection, DEFAULT_RULES } from './public/rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.enable("trust proxy");
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        allowedHeaders: ["my-custom-header"],
        credentials: true
    }
});

app.use(express.static(join(__dirname, 'public')));
app.use('/libs', express.static(join(__dirname, 'node_modules')));

class GameState {
    constructor(roomCode, rules = DEFAULT_RULES) {
        this.roomCode = roomCode;
        this.players = [];
        this.spectators = []; // New spectator list
        this.currentPlayerIndex = 0;
        this.rules = { ...rules };

        this.roundAccumulatedScore = 0;
        this.diceCountToRoll = 6;
        this.currentDice = [];
        this.isFinalRound = false;
        this.finalRoundTriggeredBy = null;
        this.farkleCount = 0;

        // High Stakes State
        this.previousPlayerLeftoverDice = 0;
        this.canHighStakes = false;

        this.gameStatus = 'waiting';
        this.winner = null;
        this.hostId = null; // Track Host
    }

    addPlayer(id, name, reconnectToken) {
        if (this.players.length >= 10) return false;
        // Assign host if first player (or if host left and this is first new joiner, though logic handles host migration on leave)
        if (this.players.length === 0) {
            this.hostId = id;
        }
        this.players.push({
            id,
            name,
            score: 0,
            connected: true,
            farkles: 0,
            hasOpened: false,
            reconnectToken: reconnectToken || null,
            missedTurns: 0
        });
        return true;
    }

    addSpectator(id) {
        if (!this.spectators.includes(id)) {
            this.spectators.push(id);
        }
    }

    removePlayer(id) {
        const p = this.players.find(p => p.id === id);
        if (p) {
            p.connected = false;
            // If host left, reassign host to next connected player
            if (this.hostId === id) {
                const nextHost = this.players.find(pl => pl.connected && pl.id !== id);
                this.hostId = nextHost ? nextHost.id : null;
            }
        }
        this.spectators = this.spectators.filter(s => s !== id);
    }

    start() {
        if (this.players.length >= 2) {
            this.gameStatus = 'playing';
            this.currentPlayerIndex = 0;
            this.resetRound();
            return true;
        }
        return false;
    }

    resetRound() {
        this.roundAccumulatedScore = 0;
        this.diceCountToRoll = 6;
        this.currentDice = [];
        this.canHighStakes = false;

        if (this.rules.highStakes && this.previousPlayerLeftoverDice > 0 && this.previousPlayerLeftoverDice < 6) {
            this.canHighStakes = true;
        } else {
            this.previousPlayerLeftoverDice = 0;
        }
    }

    getCurrentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    roll(playerId, useHighStakes = false) {
        if (this.gameStatus !== 'playing') return { error: "Game not active" };
        const player = this.getCurrentPlayer();
        if (player.id !== playerId) return { error: "Not your turn" };

        let scoreFromSelection = 0;
        let isFirstRollOfTurn = (this.currentDice.length === 0 && this.roundAccumulatedScore === 0);

        if (this.currentDice.length > 0) {
            // Re-rolling 
            const selected = this.currentDice.filter(d => d.selected);
            if (selected.length === 0) return { error: "Must select dice to re-roll" };

            const values = selected.map(d => d.value);
            if (!isScoringSelection(values, this.rules)) return { error: "Invalid selection" };

            scoreFromSelection = calculateScore(values, this.rules);
            this.roundAccumulatedScore += scoreFromSelection;

            const remaining = this.currentDice.length - selected.length;
            this.diceCountToRoll = remaining === 0 ? 6 : remaining;

            if (remaining === 0) {
                if (this.rules.hotDiceBonus) {
                    this.roundAccumulatedScore += 1000;
                }
            }

        } else {
            // First Roll
            if (useHighStakes && this.canHighStakes) {
                console.log(`[Game ${this.roomCode}] Player ${playerId} chose High Stakes! Rolling ${this.previousPlayerLeftoverDice} dice.`);
                this.diceCountToRoll = this.previousPlayerLeftoverDice;
                this.roundAccumulatedScore = 0;
                this.highStakesAttempt = true;
            } else {
                this.diceCountToRoll = 6;
                this.highStakesAttempt = false;
            }
        }

        const newDice = [];
        for (let i = 0; i < this.diceCountToRoll; i++) {
            newDice.push({
                id: Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
                value: Math.floor(Math.random() * 6) + 1,
                selected: false
            });
        }
        this.currentDice = newDice;

        const rolledValues = newDice.map(d => d.value);
        let farkle = false;
        if (!hasPossibleMoves(rolledValues, this.rules)) {
            farkle = true;
        }

        if (this.rules.toxicTwos) {
            const twoCount = rolledValues.filter(v => v === 2).length;
            if (twoCount >= 4) {
                console.log(`[Game ${this.roomCode}] Toxic Twos triggered!`);
                farkle = true;
            }
        }

        if (farkle && isFirstRollOfTurn && this.rules.noFarkleFirstRoll) {
            let attempts = 0;
            while (farkle && attempts < 10) {
                console.log(`[Game ${this.roomCode}] First Roll Farkle prevented (Rule Active). Rerolling.`);
                for (let d of newDice) d.value = Math.floor(Math.random() * 6) + 1;
                const newVals = newDice.map(d => d.value);
                farkle = !hasPossibleMoves(newVals, this.rules);
                if (this.rules.toxicTwos && newVals.filter(v => v === 2).length >= 4) farkle = true;
                attempts++;
            }
        }

        if (farkle) {
            this.farkleCount++;
        } else {
            this.farkleCount = 0;
            if (this.highStakesAttempt) {
                console.log(`[Game ${this.roomCode}] High Stakes Successful! Adding 1000 bonus.`);
                this.roundAccumulatedScore += 1000;
                this.highStakesAttempt = false;
            }
        }

        return {
            success: true,
            dice: newDice,
            farkle,
            roundScore: this.roundAccumulatedScore,
            hotDice: (this.diceCountToRoll === 6 && !farkle && !isFirstRollOfTurn)
        };
    }

    toggleSelection(playerId, dieId) {
        if (this.gameStatus !== 'playing') return;
        const die = this.currentDice.find(d => d.id == dieId);
        if (die) die.selected = !die.selected;
        return true;
    }

    syncSelections(playerId, selectedIds) {
        if (this.gameStatus !== 'playing') return;
        const setIds = new Set(selectedIds.map(String));
        this.currentDice.forEach(die => die.selected = setIds.has(String(die.id)));
    }

    bank(playerId) {
        if (this.gameStatus !== 'playing') return;
        const player = this.players[this.currentPlayerIndex];
        if (player.id !== playerId) return;

        const selected = this.currentDice.filter(d => d.selected);
        const values = selected.map(d => d.value);

        let scoreToAdd = 0;
        if (selected.length > 0) {
            if (isScoringSelection(values, this.rules)) {
                scoreToAdd = calculateScore(values, this.rules);
            } else {
                return { error: "Invalid selection" };
            }
        } else if (this.currentDice.length > 0 && this.roundAccumulatedScore === 0) {
            return { error: "Cannot bank 0" };
        }

        const potentialTotal = this.roundAccumulatedScore + scoreToAdd;

        if (!player.hasOpened) {
            if (potentialTotal < this.rules.openingScore) {
                return { error: `Must score at least ${this.rules.openingScore} to open.` };
            }
        }

        if (this.rules.welfareMode) {
            const projectedScore = player.score + potentialTotal;
            if (projectedScore > 10000) {
                const lowest = this.players.reduce((prev, curr) => (prev.score < curr.score) ? prev : curr);
                lowest.score += potentialTotal;
                this.roundAccumulatedScore = 0;
                this.nextTurn();
                return { success: true, message: "Welfare Wipeout! Points given to lowest." };
            }
        }

        this.roundAccumulatedScore = potentialTotal;
        player.score += this.roundAccumulatedScore;
        player.hasOpened = true;
        this.farkleCount = 0;
        const remainingDiceCount = this.currentDice ? (this.currentDice.length - selected.length) : 0;
        this.previousPlayerLeftoverDice = (remainingDiceCount > 0 && remainingDiceCount < 6) ? remainingDiceCount : 0;

        this.checkWinCondition();

        if (this.gameStatus !== 'finished') {
            this.nextTurn();
        }

        return { success: true };
    }

    farkle() {
        if (this.farkleCount >= 3) {
            const penalty = this.rules.threeFarklesPenalty || 1000;
            console.log(`[Game ${this.roomCode}] Player penalty for 3 farkles: -${penalty}`);
            this.players[this.currentPlayerIndex].score -= penalty;
            this.farkleCount = 0;
        }

        this.previousPlayerLeftoverDice = 0;
        this.roundAccumulatedScore = 0;
        this.nextTurn();
    }

    nextTurn() {
        let attempts = 0;
        let p;

        do {
            this.currentPlayerIndex = (this.currentPlayerIndex + 1) % this.players.length;
            p = this.players[this.currentPlayerIndex];

            if (!p.connected) {
                p.missedTurns = (p.missedTurns || 0) + 1;
                console.log(`[Game ${this.roomCode}] Player ${p.name} missed turn ${p.missedTurns}/3`);
                if (p.missedTurns >= 3) {
                    console.log(`[Game ${this.roomCode}] Kicking ${p.name} for inactivity.`);
                    // Remove from array. 
                    // Adjust index if needed since we are modifying array while iterating? 
                    // We are just rotating index, so splicing at index implies current index is now next player.
                    // But we are in a loop looking for connected player.
                    this.players.splice(this.currentPlayerIndex, 1);
                    // Decrement index so next loop increment hits the correct next player
                    this.currentPlayerIndex--;

                    // Check if empty
                    if (this.players.length === 0) {
                        this.gameStatus = 'waiting';
                        this.resetRound();
                        return;
                    }
                }
            } else {
                // If connected, reset missed turns? usually yes.
                p.missedTurns = 0;
            }

            attempts++;
        } while ((!p || !p.connected) && attempts < this.players.length + 5);
        // +5 safety buffer for splicing logic

        if (this.players.length < 2 && this.gameStatus === 'playing') {
            // Not enough players to continue? Or just wait?
            // Usually wait or keep playing solo? For now, keep state but maybe warn.
        }

        this.resetRound();

        if (this.isFinalRound && this.currentPlayerIndex === this.finalRoundTriggeredBy) {
            this.endGame();
        }
    }

    checkWinCondition() {
        const p = this.players[this.currentPlayerIndex];
        const winTarget = this.rules.winScore || 10000;
        if (p.score >= winTarget && !this.isFinalRound) {
            this.isFinalRound = true;
            this.finalRoundTriggeredBy = this.currentPlayerIndex;
        }
    }

    endGame() {
        this.gameStatus = 'finished';
        const sorted = [...this.players].sort((a, b) => b.score - a.score);
        this.winner = sorted[0];
        if (sorted.length > 1 && sorted[0].score === sorted[1].score) {
            this.winner = 'tie';
        }
    }

    getState() {
        return {
            roomCode: this.roomCode,
            players: this.players,
            spectatorCount: this.spectators.length,
            currentPlayerIndex: this.currentPlayerIndex,
            roundAccumulatedScore: this.roundAccumulatedScore,
            diceCountToRoll: this.diceCountToRoll,
            currentDice: this.currentDice,
            gameStatus: this.gameStatus,
            winner: this.winner,
            isFinalRound: this.isFinalRound,
            canHighStakes: this.canHighStakes,
            rules: this.rules,
            hostId: this.hostId
        };
    }
}

// Game definitions moved to bottom of file

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    socket.emit('room_list', getRoomList());

    socket.on('get_room_list', () => {
        socket.emit('room_list', getRoomList());
    });

    socket.on('join_game', (data) => {
        try {
            const requestedRoom = data?.roomCode;
            const isSpectator = data?.spectator === true;

            let roomCode = requestedRoom && games.has(requestedRoom) ? requestedRoom : 'Classic 1';
            let game = games.get(roomCode);

            // Checking if already in as player (Reconnect Logic)
            let existingPlayer = null;

            // Check by reconnectToken first
            const token = data?.reconnectToken;
            if (token) {
                existingPlayer = game.players.find(p => p.reconnectToken === token && !p.connected);
                if (existingPlayer) {
                    console.log(`[Game ${roomCode}] Player Reconnected: ${existingPlayer.name}`);
                    existingPlayer.id = socket.id; // Update socket ID
                    existingPlayer.connected = true;
                    existingPlayer.missedTurns = 0; // Reset AFK counter
                    socket.join(roomCode);

                    // Restore host if needed
                    if (!game.hostId || !game.players.find(p => p.id === game.hostId && p.connected)) {
                        game.hostId = existingPlayer.id;
                    }

                    socket.emit('joined', { playerId: socket.id, state: game.getState(), isSpectator: false });
                    io.to(roomCode).emit('game_state_update', game.getState());
                    return;
                }
            }

            // Fallback: Check strictly by socket ID (unlikely on refresh, but good for same-session re-joins)
            existingPlayer = game.players.find(p => p.id === socket.id);
            if (existingPlayer) {
                existingPlayer.connected = true;
                socket.join(roomCode);
                socket.emit('joined', { playerId: socket.id, state: game.getState(), isSpectator: false });
                io.to(roomCode).emit('game_state_update', game.getState());
                return;
            }

            if (isSpectator) {
                game.addSpectator(socket.id);
                socket.join(roomCode);
                socket.emit('joined', { playerId: socket.id, state: game.getState(), isSpectator: true });
                // Don't necessarily need to broadcast state update for spectator join, but good for count update
                io.to(roomCode).emit('game_state_update', game.getState());
                return;
            }

            let name = data?.name;
            if (!name) {
                for (let i = 1; i <= 10; i++) {
                    let candidate = `Player ${i}`;
                    if (!game.players.some(p => p.name === candidate)) {
                        name = candidate;
                        break;
                    }
                }
            }

            if (game.players.length >= 10) {
                socket.emit('error', 'Room Full');
                return;
            }

            game.addPlayer(socket.id, name, data?.reconnectToken);
            socket.join(roomCode);
            socket.emit('joined', { playerId: socket.id, state: game.getState(), isSpectator: false });
            io.to(roomCode).emit('game_state_update', game.getState());
            io.emit('room_list', getRoomList());

            if (game.gameStatus === 'waiting' && game.players.length >= 2) {
                game.start();
                io.to(roomCode).emit('game_start', game.getState());
            }
        } catch (err) {
            console.error("Error in join_game:", err);
            socket.emit('error', "Server Error");
        }
    });

    socket.on('leave_game', () => {
        // Handle leaving for players and spectators
        for (const game of games.values()) {
            if (game.spectators.includes(socket.id)) {
                game.removePlayer(socket.id); // removes from spectators too
                socket.leave(game.roomCode);
                continue;
            }
            const p = game.players.find(p => p.id === socket.id);
            if (p) {
                p.connected = false;
                if (game.gameStatus === 'waiting') {
                    game.players = game.players.filter(pl => pl.id !== socket.id);
                }
                const activeCount = game.players.filter(p => p.connected).length;
                if (activeCount === 0) {
                    game.players = [];
                    game.gameStatus = 'waiting';
                    game.resetRound();
                }
                socket.leave(game.roomCode);
                io.emit('room_list', getRoomList());
                io.to(game.roomCode).emit('game_state_update', game.getState());
            }
        }
    });

    socket.on('roll', ({ roomCode, confirmedSelections, useHighStakes }) => {
        const game = games.get(roomCode);
        if (!game) return;
        // Verify player is not spectator
        if (game.spectators.includes(socket.id)) return;

        if (confirmedSelections && Array.isArray(confirmedSelections)) {
            game.syncSelections(socket.id, confirmedSelections);
        }

        const result = game.roll(socket.id, useHighStakes);
        if (result.error) {
            socket.emit('error', result.error);
        } else {
            io.to(roomCode).emit('roll_result', {
                dice: result.dice,
                farkle: result.farkle,
                hotDice: result.hotDice,
                state: game.getState()
            });

            if (result.farkle) {
                const delay = (game.rules.category === 'speed') ? 1000 : 2500;
                setTimeout(() => {
                    game.farkle();
                    io.to(roomCode).emit('game_state_update', game.getState());
                }, delay);
            }
        }
    });

    socket.on('toggle_die', ({ roomCode, dieId }) => {
        const game = games.get(roomCode);
        if (game) {
            if (game.spectators.includes(socket.id)) return;
            game.toggleSelection(socket.id, dieId);
            io.to(roomCode).emit('game_state_update', game.getState());
        }
    });

    socket.on('bank', ({ roomCode, confirmedSelections }) => {
        const game = games.get(roomCode);
        if (game) {
            if (game.spectators.includes(socket.id)) return;
            if (confirmedSelections && Array.isArray(confirmedSelections)) {
                game.syncSelections(socket.id, confirmedSelections);
            }
            const res = game.bank(socket.id);
            if (res && res.error) {
                socket.emit('error', res.error);
            } else {
                io.to(roomCode).emit('game_state_update', game.getState());
            }
        }
    });

    socket.on('restart', ({ roomCode }) => {
        const game = games.get(roomCode);
        if (game && game.gameStatus === 'finished') {
            // Only players can restart? Or anyone?
            // Host only restriction
            const gameHost = game.hostId;
            if (gameHost !== socket.id) {
                socket.emit('error', "Only Host can restart");
                return;
            }

            game.gameStatus = 'playing';
            game.players.forEach(p => { p.score = 0; p.farkles = 0; p.hasOpened = false; });
            game.currentPlayerIndex = 0;
            game.resetRound();
            game.isFinalRound = false;
            game.winner = null;
            io.to(roomCode).emit('game_start', game.getState());
        }
    });

    socket.on('force_next_turn', ({ roomCode }) => {
        const game = games.get(roomCode);
        if (game && game.gameStatus === 'playing') {
            if (game.hostId !== socket.id) return; // Only host
            game.nextTurn();
            io.to(roomCode).emit('game_state_update', game.getState());
        }
    });

    socket.on('debug_restart_preserve', ({ roomCode }) => {
        const game = games.get(roomCode);
        if (game) {
            if (game.hostId !== socket.id) return; // Only host
            game.gameStatus = 'playing';
            game.players.forEach(p => p.score = 0);
            game.currentPlayerIndex = 0;
            game.resetRound();
            game.isFinalRound = false;
            game.winner = null;
            io.to(roomCode).emit('game_start', game.getState());
        }
    });

    socket.on('disconnect', () => {
        // console.log('Client disconnected:', socket.id);
        for (const game of games.values()) {
            if (game.spectators.includes(socket.id)) {
                game.removePlayer(socket.id); // Handles s removing
                continue;
            }
            const player = game.players.find(p => p.id === socket.id);
            if (player) {
                player.connected = false;
                const activeCount = game.players.filter(p => p.connected).length;
                if (activeCount === 0) {
                    game.players = [];
                    game.gameStatus = 'waiting';
                    game.resetRound();
                }
                io.emit('room_list', getRoomList());
                if (game.gameStatus === 'waiting') {
                    game.players = game.players.filter(pl => pl.id !== socket.id);
                    io.emit('room_list', getRoomList());
                }
            }
        }
    });
});

// --- Setup Games ---
const games = new Map();

// 1. Speed Run Mode (6000 pts)
// 1. Speed Run Mode
games.set('Speed 1', new GameState('Speed 1', {
    ...DEFAULT_RULES,
    winScore: 5000,
    openingScore: 0,
    category: 'speed',
    description: "Blitz • 5k Win • No Opening Req"
}));
games.set('Speed 2', new GameState('Speed 2', {
    ...DEFAULT_RULES,
    winScore: 7500,
    openingScore: 500,
    category: 'speed',
    description: "Race • 7.5k Win • Standard"
}));

// 2. Casual Standard
games.set('Classic 1', new GameState('Classic 1', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 500,
    category: 'casual',
    description: "Standard • 10k Win • 500 Open"
}));
games.set('Classic 2', new GameState('Classic 2', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 0,
    threeFarklesPenalty: 500, // Reduced penalty
    category: 'casual',
    description: "Friendly • 10k Win • No Open"
}));
games.set('Classic 3', new GameState('Classic 3', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 1000,
    category: 'casual',
    description: "Pro • 10k Win • 1000 Open"
}));

// 3. Casual House Rules (Custom Logic)
games.set('House 1', new GameState('House 1', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 500,
    enableThreePairs: true,
    threePairs: 750,
    enable4Straight: true,
    fourStraight: 500,
    enable5Straight: true,
    fiveStraight: 1000,
    category: 'casual',
    description: "Combo King • Pairs & Runs"
}));
games.set('House 2', new GameState('House 2', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 500,
    highStakes: true,
    toxicTwos: true,
    category: 'casual',
    description: "Risky • High Stakes & Toxic 2s"
}));
games.set('House 3', new GameState('House 3', {
    ...DEFAULT_RULES,
    winScore: 10000,
    openingScore: 500,
    welfareMode: true,
    enableSixOnesInstantWin: true,
    category: 'casual',
    description: "Chaos • Welfare & Instant Win"
}));

function getRoomList() {
    return Array.from(games.values()).map(g => ({
        name: g.roomCode,
        count: g.players.filter(p => p.connected).length,
        spectators: g.spectators.length,
        max: 10,
        status: g.gameStatus,
        category: g.rules.category || 'casual',
        rulesSummary: g.rules.description || 'Standard'
    }));
}

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
