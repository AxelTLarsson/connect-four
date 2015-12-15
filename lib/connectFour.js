/*
connectFour.js
This is the model of the game, all logic is here and no DOM manipulation.
*/

// Object representing an instance of the game
var instance = {
    turn: 0,    // integer indicating whos turn it is
    board: {},  // object representing the actual game board
    players: [] // array of player names
};

var board = {
    sizeX: 7, // default value, will in practice be overruled
    sizeY: 6, // default value, will in practice be overruled
    board: [
            []
        ] // a 2D array - matrix representing the board
};

// The player whose turn it is drops a token in column `col`
export function makeMove(col) {
    let player = instance.players[instance.turn];
    console.log(player, " drops a token in ", col);
}

// Set next player's turn in model and return her/his name (so that view can update)
export function nextTurn() {
    let nbrPlayers = instance.players.length;
    instance.turn = (instance.turn + 1) % nbrPlayers;
    return instance.players[instance.turn];
}

export function setup(playerNames, sizeX, sizeY) {
    console.log("setting up the game.");

    instance.players = playerNames;
    instance.sizeX = sizeX;
    instance.sizeY = sizeY;

    instance.board = board;

    // Draw a random player to start
    instance.turn = Math.floor(Math.random() * instance.players.length);
    console.log(instance);
}
