// Import dependencies
import express from 'express';
import { createServer } from 'http';
import { MongoClient } from 'mongodb';
import { dirname, join } from 'path';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';

// Import classes
import LiveGames from './utils/liveGames.js';
import Players from './utils/players.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const publicPath = join(__dirname, '../public');

// MongoDB setup
const url = "mongodb://root:example@localhost:27017/";
const client = new MongoClient(url);
let db;

// Initialize app and server
const app = express();
const server = createServer(app);
const io = new Server(server);
const games = new LiveGames();
const players = new Players();

app.use(express.static(publicPath));

// Starting server on port 3000
server.listen(3000, () => {
    console.log("Server started on port 3000");
});

// Database helper function
async function getDatabase() {
    if (!db) {
        await client.connect();
        db = client.db("kahootDB");
    }
    return db;
}

// Socket.io connections
io.on('connection', (socket) => {
    // Host joins
    socket.on('host-join', async (data) => {
        try {
            const db = await getDatabase();
            const result = await db.collection('kahootGames').findOne({ id: parseInt(data.id) });

            if (result) {
                const gamePin = Math.floor(Math.random() * 90000) + 10000;
                games.addGame(gamePin, socket.id, false, { playersAnswered: 0, questionLive: false, gameid: data.id, question: 1 });
                
                const game = games.getGame(socket.id);
                socket.join(game.pin);
                
                console.log('Game Created with pin:', game.pin);
                socket.emit('showGamePin', { pin: game.pin });
            } else {
                socket.emit('noGameFound');
            }
        } catch (error) {
            console.error("Error in 'host-join':", error);
            socket.emit('error', 'Database error');
        }
    });

    // Host joins game view
    socket.on('host-join-game', async (data) => {
        const oldHostId = data.id;
        const game = games.getGame(oldHostId);
        
        if (game) {
            game.hostId = socket.id;
            socket.join(game.pin);

            players.getPlayers(oldHostId).forEach(player => {
                if (player.hostId === oldHostId) player.hostId = socket.id;
            });

            try {
                const db = await getDatabase();
                const result = await db.collection("kahootGames").findOne({ id: parseInt(game.gameData['gameid']) });
                if (result) {
                    const { question, answers, correct } = result.questions[0];
                    socket.emit('gameQuestions', {
                        q1: question,
                        a1: answers[0],
                        a2: answers[1],
                        a3: answers[2],
                        a4: answers[3],
                        correct,
                        playersInGame: players.getPlayers(oldHostId).length
                    });
                }
            } catch (error) {
                console.error("Error in 'host-join-game':", error);
            }
            
            io.to(game.pin).emit('gameStartedPlayer');
            game.gameData.questionLive = true;
        } else {
            socket.emit('noGameFound');
        }
    });

    // Player joins game
    socket.on('player-join', (params) => {
        const game = games.games.find(g => g.pin === params.pin);
        
        if (game) {
            const hostId = game.hostId;
            players.addPlayer(hostId, socket.id, params.name, { score: 0, answer: 0 });
            socket.join(params.pin);
            
            io.to(params.pin).emit('updatePlayerLobby', players.getPlayers(hostId));
            console.log('Player connected to game');
        } else {
            socket.emit('noGameFound');
        }
    });

    // Handling player answer
    socket.on('playerAnswer', async (num) => {
        const player = players.getPlayer(socket.id);
        const hostId = player.hostId;
        const game = games.getGame(hostId);

        if (game.gameData.questionLive) {
            player.gameData.answer = num;
            game.gameData.playersAnswered += 1;

            try {
                const db = await getDatabase();
                const result = await db.collection("kahootGames").findOne({ id: parseInt(game.gameData.gameid) });
                
                if (result) {
                    const correctAnswer = result.questions[game.gameData.question - 1].correct;
                    
                    if (num === correctAnswer) {
                        player.gameData.score += 100;
                        socket.emit('answerResult', true);
                    }
                    
                    if (game.gameData.playersAnswered === players.getPlayers(hostId).length) {
                        game.gameData.questionLive = false;
                        io.to(game.pin).emit('questionOver', players.getPlayers(hostId), correctAnswer);
                    } else {
                        io.to(game.pin).emit('updatePlayersAnswered', {
                            playersInGame: players.getPlayers(hostId).length,
                            playersAnswered: game.gameData.playersAnswered
                        });
                    }
                }
            } catch (error) {
                console.error("Error in 'playerAnswer':", error);
            }
        }
    });

    // Time up event handler
    socket.on('timeUp', async () => {
        const game = games.getGame(socket.id);
        game.gameData.questionLive = false;
        const playerData = players.getPlayers(game.hostId);

        try {
            const db = await getDatabase();
            const result = await db.collection("kahootGames").findOne({ id: parseInt(game.gameData.gameid) });
            
            if (result) {
                const correctAnswer = result.questions[game.gameData.question - 1].correct;
                io.to(game.pin).emit('questionOver', playerData, correctAnswer);
            }
        } catch (error) {
            console.error("Error in 'timeUp':", error);
        }
    });

    // Start game
    socket.on('startGame', () => {
        const game = games.getGame(socket.id);
        game.gameLive = true;
        socket.emit('gameStarted', game.hostId);
    });

    // Get game names data from database
    socket.on('requestDbNames', async () => {
        try {
            const db = await getDatabase();
            const res = await db.collection("kahootGames").find().toArray();
            socket.emit('gameNamesData', res);
        } catch (error) {
            console.error("Error in 'requestDbNames':", error);
        }
    });

    // New quiz creation
    socket.on('newQuiz', async (data) => {
        try {
            const db = await getDatabase();
            const result = await db.collection('kahootGames').find({}).toArray();
            const num = result.length;
            data.id = num === 0 ? 1 : result[num - 1].id + 1;

            await db.collection("kahootGames").insertOne(data);
            socket.emit('startGameFromCreator', num);
        } catch (error) {
            console.error("Error in 'newQuiz':", error);
        }
    });

    // Handle disconnections
    socket.on('disconnect', () => {
        const game = games.getGame(socket.id);
        
        if (game) {
            if (!game.gameLive) {
                games.removeGame(socket.id);
                players.getPlayers(game.hostId).forEach(player => players.removePlayer(player.playerId));
                
                io.to(game.pin).emit('hostDisconnect');
                socket.leave(game.pin);
                console.log('Game ended with pin:', game.pin);
            }
        } else {
            const player = players.getPlayer(socket.id);
            if (player) {
                const hostId = player.hostId;
                const game = games.getGame(hostId);
                const pin = game.pin;

                players.removePlayer(socket.id);
                io.to(pin).emit('updatePlayerLobby', players.getPlayers(hostId));
                socket.leave(pin);
            }
        }
    });
});

// Handle MongoDB connection close on process exit
process.on('exit', () => {
    client.close();
});
