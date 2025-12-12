import { calculateScore } from './rules.js';

class FarkleClient {
    constructor() {
        this.socket = io();
        this.roomCode = null;
        this.playerId = null;
        this.gameState = null;

        // UI Elements
        this.ui = {
            app: document.getElementById('app'),
            diceContainer: document.getElementById('dice-container'),
            rollBtn: document.getElementById('roll-btn'),
            bankBtn: document.getElementById('bank-btn'),
            player1Zone: document.getElementById('player1-zone'),
            player2Zone: document.getElementById('player2-zone'),
            p1Score: document.getElementById('player1-zone')?.querySelector('.total-score'),
            p2Score: document.getElementById('player2-zone')?.querySelector('.total-score'),
            p1Round: document.getElementById('p1-round'),
            p2Round: document.getElementById('p2-round'),
            actionText: document.getElementById('action-text'),
            currentScoreDisplay: document.getElementById('current-score-display'),
            feedback: document.getElementById('feedback-message'),
            rulesBtn: document.getElementById('rules-btn'),
            rulesModal: document.getElementById('rules-modal'),
            setupModal: document.getElementById('setup-modal'),
            gameOverModal: document.getElementById('game-over-modal'),
            startGameBtn: document.getElementById('start-game-btn'),
            playerNameInput: document.getElementById('player-name-input'),
            roomCodeInput: document.getElementById('room-code-input'),
            winnerText: document.getElementById('winner-text'),
            endP1Name: document.getElementById('end-p1-name'),
            endP1Score: document.getElementById('end-p1-score'),
            endP2Name: document.getElementById('end-p2-name'),
            endP2Score: document.getElementById('end-p2-score'),
            restartBtn: document.getElementById('restart-btn')
        };

        this.initListeners();
        this.initSocketEvents();
    }

    initListeners() {
        this.ui.rollBtn.addEventListener('click', () => {
            if (this.canInteract()) {
                this.socket.emit('roll', { roomCode: this.roomCode });
            }
        });

        this.ui.bankBtn.addEventListener('click', () => {
            if (this.canInteract()) {
                this.socket.emit('bank', { roomCode: this.roomCode });
            }
        });

        this.ui.diceContainer.addEventListener('click', (e) => {
            const dieEl = e.target.closest('.die');
            if (dieEl && this.canInteract()) {
                const id = dieEl.dataset.id; // ID is string in dataset
                // Optimistic toggle? No, server is fast enough usually, or toggle locally and wait for correction?
                // Let's toggle locally for responsiveness, then sync.
                // Actually server is simple enough to just emit.
                this.socket.emit('toggle_die', { roomCode: this.roomCode, dieId: id });
            }
        });

        // Modals
        this.ui.rulesBtn.addEventListener('click', () => this.ui.rulesModal.classList.remove('hidden'));
        this.ui.rulesModal.querySelector('.close-modal').addEventListener('click', () => this.ui.rulesModal.classList.add('hidden'));

        this.ui.startGameBtn.addEventListener('click', () => this.joinGame());

        this.ui.restartBtn.addEventListener('click', () => {
            this.socket.emit('restart', { roomCode: this.roomCode });
            this.ui.gameOverModal.classList.add('hidden');
        });
    }

    initSocketEvents() {
        this.socket.on('connect', () => {
            console.log('Connected to server');
        });

        this.socket.on('joined', ({ playerId, state }) => {
            this.playerId = playerId;
            this.updateGameState(state);
            this.ui.setupModal.classList.add('hidden');
            this.showFeedback("Joined Room!", "success");
        });

        this.socket.on('game_state_update', (state) => {
            this.updateGameState(state);
        });

        this.socket.on('game_start', (state) => {
            this.updateGameState(state);
            this.showFeedback("Game Started!", "success");
        });

        this.socket.on('roll_result', (data) => {
            // data contains { dice, farkle, hotDice, state }
            // Animate roll
            this.animateRoll(data.dice).then(() => {
                this.updateGameState(data.state);
                if (data.farkle) {
                    this.showFeedback("FARKLE!", "error");
                }
                if (data.hotDice) {
                    this.showFeedback("HOT DICE!", "success");
                }
            });
        });

        this.socket.on('error', (msg) => {
            alert(msg);
            if (msg === "Game not active" || msg === "Room full") {
                // Maybe show setup again?
            }
        });
    }

    joinGame() {
        const name = this.ui.playerNameInput.value.trim() || 'Player';
        const room = this.ui.roomCodeInput.value.trim() || 'room1';
        this.roomCode = room;

        this.socket.emit('join_game', { roomCode: room, playerName: name });
    }

    canInteract() {
        if (!this.gameState) return false;
        if (this.gameState.gameStatus !== 'playing') return false;
        const currentPlayer = this.gameState.players[this.gameState.currentPlayerIndex];
        return currentPlayer && currentPlayer.id === this.socket.id;
    }

    updateGameState(state) {
        this.gameState = state;
        this.renderPlayers();
        this.renderControls();
        this.renderDice(state.currentDice); // This might snap if animation is playing, but we handle that in roll_result manually
        this.checkGameOver(state);
    }

    renderPlayers() {
        const p1 = this.gameState.players[0] || { name: 'Waiting...', score: 0 };
        const p2 = this.gameState.players[1] || { name: 'Waiting...', score: 0 };

        // P1 Zone
        this.ui.player1Zone.querySelector('.player-name').textContent = p1.name;
        this.ui.p1Score.textContent = p1.score;
        this.ui.p1Round.textContent = (this.gameState.currentPlayerIndex === 0) ? this.gameState.roundAccumulatedScore : 0;

        // P2 Zone
        this.ui.player2Zone.querySelector('.player-name').textContent = p2.name;
        this.ui.p2Score.textContent = p2.score;
        this.ui.p2Round.textContent = (this.gameState.currentPlayerIndex === 1) ? this.gameState.roundAccumulatedScore : 0;

        // Active Highlight
        if (this.gameState.currentPlayerIndex === 0) {
            this.ui.player1Zone.classList.add('active');
            this.ui.player2Zone.classList.remove('active');
        } else {
            this.ui.player1Zone.classList.remove('active');
            this.ui.player2Zone.classList.add('active');
        }

        // If I am one of the players, highlight me?
        // Maybe add a "(You)" label?
        if (p1.id === this.socket.id) this.ui.player1Zone.querySelector('.player-name').textContent = p1.name + " (You)";
        if (p2.id === this.socket.id) this.ui.player2Zone.querySelector('.player-name').textContent = p2.name + " (You)";
    }

    renderDice(diceData) {
        // If we just animated, we don't want to re-render immediately if it causes jump
        // But for toggle updates, we do.
        // We'll trust the simple diffing or just rebuild content if count changes.

        // Simple rebuild
        this.ui.diceContainer.innerHTML = '';
        diceData.forEach(die => {
            const dieEl = document.createElement('div');
            dieEl.className = 'die';
            if (die.selected) dieEl.classList.add('selected');
            dieEl.dataset.id = die.id; // These are numeric from server, but stored as string in dataset

            this.createFaces(dieEl);
            dieEl.dataset.face = die.value;

            this.ui.diceContainer.appendChild(dieEl);
        });
    }

    createFaces(dieEl) {
        for (let i = 1; i <= 6; i++) {
            const face = document.createElement('div');
            face.className = `die-face face-${i}`;
            for (let p = 0; p < i; p++) {
                const pip = document.createElement('div');
                pip.className = 'pip';
                face.appendChild(pip);
            }
            dieEl.appendChild(face);
        }
    }

    animateRoll(diceData) {
        return new Promise((resolve) => {
            this.ui.diceContainer.innerHTML = '';
            diceData.forEach(die => {
                const dieEl = document.createElement('div');
                dieEl.className = 'die rolling';
                dieEl.style.animationDuration = (0.8 + Math.random() * 0.4) + 's';

                this.createFaces(dieEl);
                this.ui.diceContainer.appendChild(dieEl);

                // After animation, set face
                setTimeout(() => {
                    dieEl.classList.remove('rolling');
                    dieEl.style.animationDuration = '';
                    dieEl.dataset.face = die.value;
                    dieEl.dataset.id = die.id;
                }, 1000);
            });

            setTimeout(resolve, 1000);
        });
    }

    renderControls() {
        if (!this.gameState) return;

        const isMyTurn = this.canInteract();
        const selectedDice = this.gameState.currentDice.filter(d => d.selected);
        const selectedScore = calculateScore(selectedDice.map(d => d.value));
        const totalRound = this.gameState.roundAccumulatedScore + selectedScore;

        // Score Display
        this.ui.currentScoreDisplay.textContent = `Selection: ${selectedScore} (Round: ${totalRound})`;

        if (!isMyTurn) {
            this.ui.rollBtn.disabled = true;
            this.ui.bankBtn.disabled = true;

            const currentPlayerName = this.gameState.players[this.gameState.currentPlayerIndex]?.name || "Someone";
            this.ui.actionText.textContent = `Waiting for ${currentPlayerName}...`;
            this.ui.rollBtn.textContent = 'Roll';
        } else {
            this.ui.actionText.textContent = "Your turn";

            // Enable logic based on state
            // Can roll if:
            // 1. Just started turn (no dice yet? Server handles this, sends currentDice empty? No server sends rolled dice usually?)
            // Actually server state for 'currentDice' is persistent.
            // If state.diceCountToRoll > 0 ??

            const hasSelected = selectedDice.length > 0;
            const isValidSelection = selectedScore > 0; // rough check, server validates fully

            // Roll Button
            // If we have selected dice, we can "Roll Remaining"
            // If we haven't rolled yet this turn (dice empty), prompt to roll

            if (this.gameState.currentDice.length === 0) {
                this.ui.rollBtn.disabled = false;
                this.ui.rollBtn.textContent = "Roll Dice";
                this.ui.bankBtn.disabled = true;
            } else {
                // We have dice. Must select to roll again or bank.
                if (hasSelected) {
                    this.ui.rollBtn.disabled = false;
                    this.ui.rollBtn.textContent = "Roll Remaining";
                    this.ui.bankBtn.disabled = false;
                } else {
                    this.ui.rollBtn.disabled = true; // Must select
                    this.ui.bankBtn.disabled = true;
                    this.ui.actionText.textContent = "Select dice to continue";
                }

                if (this.gameState.currentDice.length > 0 && selectedDice.length === this.gameState.currentDice.length) {
                    this.ui.rollBtn.textContent = "Roll Hot Dice!";
                }
            }
        }
    }

    checkGameOver(state) {
        if (state.gameStatus === 'finished') {
            this.ui.gameOverModal.classList.remove('hidden');

            const winner = state.winner;
            let title = "";
            if (winner === 'tie') title = "It's a Tie!";
            else if (winner) title = `${winner.name} Wins!`;

            this.ui.winnerText.textContent = title;

            const p1 = state.players[0];
            const p2 = state.players[1];
            if (p1) {
                this.ui.endP1Name.textContent = p1.name;
                this.ui.endP1Score.textContent = p1.score;
            }
            if (p2) {
                this.ui.endP2Name.textContent = p2.name;
                this.ui.endP2Score.textContent = p2.score;
            }
        } else {
            this.ui.gameOverModal.classList.add('hidden');
        }
    }

    showFeedback(text, type = "info") {
        this.ui.feedback.textContent = text;
        this.ui.feedback.classList.remove('hidden');
        setTimeout(() => {
            this.ui.feedback.classList.add('hidden');
        }, 1500);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new FarkleClient();
});
