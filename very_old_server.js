import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { calculateScore, hasPossibleMoves, isScoringSelection, SCORING_RULES } from './public/rules.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// Game State Storage
// Map<roomCode, GameState>
const games = new Map();

class GameState {
    constructor(roomCode) {
        this.roomCode = roomCode;
        this.players = []; // { id, name, score, connected }
        this.currentPlayerIndex = 0;

        // Turn State
        this.roundAccumulatedScore = 0;
        this.diceCountToRoll = 6;
        this.currentDice = []; // { id, value, selected }
        this.isFinalRound = false;
        this.finalRoundTriggeredBy = null;

        this.gameStatus = 'waiting'; // waiting, playing, finished
        this.winner = null;

        // Timer/Turn limits could be added here
    }

    addPlayer(id, name) {
        if (this.players.length >= 2) return false;
        this.players.push({ id, name, score: 0, connected: true });
        return true;
    }

    removePlayer(id) {
        const p = this.players.find(p => p.id === id);
        if (p) p.connected = false;
        // In this simple version, we don't remove them fully so they can reconnect?
        // Or we just reset if someone leaves.
    }

    start() {
        if (this.players.length === 2) {
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
    }

    getCurrentPlayer() {
        return this.players[this.currentPlayerIndex];
    }

    roll(playerId) {
        if (this.gameStatus !== 'playing') return { error: "Game not active" };
        if (this.getCurrentPlayer().id !== playerId) return { error: "Not your turn" };

        // If rolling remaining, validate current selection first?
        // Actually, 'roll' usually implies we banked the selected ones temporarily or we are just rolling.
        // In the client logic: "Bank" means keep points permanently.
        // "Roll Remaining" means we hold selected dice (add to round score) and roll others.

        // Logic:
        // If currentDice is empty, it's a fresh roll (start of turn).
        // If currentDice has items, user must have selected some scoring dice to continue.

        let scoreFromSelection = 0;
        if (this.currentDice.length > 0) {
            const selected = this.currentDice.filter(d => d.selected);
            if (selected.length === 0) return { error: "Must select dice to re-roll" };

            // Validate selection
            const values = selected.map(d => d.value);
            if (!isScoringSelection(values)) return { error: "Invalid selection" };

            scoreFromSelection = calculateScore(values);
            this.roundAccumulatedScore += scoreFromSelection;

            this.diceCountToRoll -= selected.length;
            if (this.diceCountToRoll === 0) {
                // Hot dice
                this.diceCountToRoll = 6;
            }
        }

        // Perform Roll
        const newDice = [];
        for (let i = 0; i < this.diceCountToRoll; i++) {
            newDice.push({
                id: Date.now() + i + Math.random(), // unique enough
                value: Math.floor(Math.random() * 6) + 1,
                selected: false
            });
        }
        this.currentDice = newDice;

        // Check Farkle
        const rolledValues = newDice.map(d => d.value);
        let farkle = false;
        if (!hasPossibleMoves(rolledValues)) {
            farkle = true;
            // Handle Farkle state changes after delay? 
            // We'll send the roll result, client shows animation, then client acknowledges or we auto-turn?
            // Safer to just mark it.
        }

        return {
            success: true,
            dice: newDice,
            farkle,
            roundScore: this.roundAccumulatedScore,
            hotDice: (scoreFromSelection > 0 && this.diceCountToRoll === 6) // Just triggered hot dice
        };
    }

    toggleSelection(playerId, dieId) {
        if (this.gameStatus !== 'playing') return;
        if (this.getCurrentPlayer().id !== playerId) return;

        const die = this.currentDice.find(d => d.id == dieId); // fuzzy match for ID types
        if (die) {
            die.selected = !die.selected;
        }
        return true;
    }

    bank(playerId) {
        if (this.gameStatus !== 'playing') return;
        if (this.getCurrentPlayer().id !== playerId) return;

        // Calculate final selection
        const selected = this.currentDice.filter(d => d.selected);
        const values = selected.map(d => d.value);

        // Must have valid selection if dice exist?
        // Or if we just rolled and want to bank immediately? (Usually must select)
        // If we have selected dice, add them.
        let scoreToAdd = 0;
        if (selected.length > 0) {
            if (isScoringSelection(values)) {
                scoreToAdd = calculateScore(values);
            } else {
                return { error: "Invalid selection" };
            }
        } else if (this.currentDice.length > 0 && this.roundAccumulatedScore === 0) {
            // Cannot bank 0 
            return { error: "Cannot bank 0" };
        }

        this.roundAccumulatedScore += scoreToAdd;
        this.players[this.currentPlayerIndex].score += this.roundAccumulatedScore;

        this.checkWinCondition();

        if (this.gameStatus !== 'finished') {
            this.nextTurn();
        }

        return { success: true };
    }

    farkle() {
        this.roundAccumulatedScore = 0;
        this.nextTurn();
    }

    nextTurn() {
        this.currentPlayerIndex = (this.currentPlayerIndex + 1) % 2;
        this.resetRound();

        // Check if we looped back to the person who triggered final round
        if (this.isFinalRound) {
            // If we just finished the turn of the person AFTER the one who triggered it, game over
            // Logic: P1 triggers. P1 turn ends. isFinalRound=true.
            // P2 plays. P2 turn ends. 
            // We need to know who triggered it.

            // Improved logic:
            // When trigger happens, we set 'finalRoundTriggeredBy' = playerIndex.
            // If currentPlayerIndex == finalRoundTriggeredBy, it implies everyone had a chance?
            // No, play continues until...
            // "The other player then gets one more round."
            // So if P1 triggers, we set flag. P2 plays. P2 banks/farkles. P2 turn ends. P1 is next.
            // Check: if next player is the one who triggered, game over.

            if (this.currentPlayerIndex === this.finalRoundTriggeredBy) {
                this.endGame();
            }
        }
    }

    checkWinCondition() {
        const p = this.players[this.currentPlayerIndex];
        if (p.score >= 10000 && !this.isFinalRound) {
            this.isFinalRound = true;
            this.finalRoundTriggeredBy = this.currentPlayerIndex;
            // Game continues for other player
        }
    }

    endGame() {
        this.gameStatus = 'finished';
        const p1 = this.players[0];
        const p2 = this.players[1];
        if (p1.score > p2.score) this.winner = p1;
        else if (p2.score > p1.score) this.winner = p2;
        else this.winner = 'tie';
    }

    getState() {
        return {
            roomCode: this.roomCode,
            players: this.players,
            currentPlayerIndex: this.currentPlayerIndex,
            roundAccumulatedScore: this.roundAccumulatedScore,
            diceCountToRoll: this.diceCountToRoll,
            currentDice: this.currentDice,
            gameStatus: this.gameStatus,
            winner: this.winner,
            isFinalRound: this.isFinalRound
        };
    }
}

io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);

    // Simple room handling
    socket.on('join_game', ({ roomCode, playerName }) => {
        let game = games.get(roomCode);
        if (!game) {
            game = new GameState(roomCode);
            games.set(roomCode, game);
        }

        if (game.gameStatus === 'playing' && !game.players.find(p => p.id === socket.id)) {
            socket.emit('error', 'Game already in progress');
            return;
        }

        // Reconnect logic or new player
        const existingPlayer = game.players.find(p => p.name === playerName); // weak auth
        if (existingPlayer) {
            existingPlayer.id = socket.id; // update socket id
            existingPlayer.connected = true;
        } else {
            if (!game.addPlayer(socket.id, playerName)) {
                socket.emit('error', 'Room full');
                return;
            }
        }

        socket.join(roomCode);
        socket.emit('joined', { playerId: socket.id, state: game.getState() });
        io.to(roomCode).emit('game_state_update', game.getState());

        // Auto-start if full
        if (game.players.length === 2 && game.gameStatus === 'waiting') {
            game.start();
            io.to(roomCode).emit('game_start', game.getState());
        }
    });

    socket.on('roll', ({ roomCode }) => {
        const game = games.get(roomCode);
        if (!game) return;

        const result = game.roll(socket.id);
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
                setTimeout(() => {
                    game.farkle();
                    io.to(roomCode).emit('game_state_update', game.getState());
                }, 2000);
            }
        }
    });

    socket.on('toggle_die', ({ roomCode, dieId }) => {
        const game = games.get(roomCode);
        if (game) {
            game.toggleSelection(socket.id, dieId);
            io.to(roomCode).emit('game_state_update', game.getState());
        }
    });

    socket.on('bank', ({ roomCode }) => {
        const game = games.get(roomCode);
        if (game) {
            const res = game.bank(socket.id);
            if (res && res.error) {
                socket.emit('error', res.error);
            } else {
                io.to(roomCode).emit('game_state_update', game.getState());
            }
        }
    });

    socket.on('restart', ({ roomCode }) => {
        // Allow restart if game over
        const game = games.get(roomCode);
        if (game && game.gameStatus === 'finished') {
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
        // Handle disconnects
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
