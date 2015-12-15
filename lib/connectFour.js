/*
connectFour.js
This is the model of the game, all logic is here and no DOM manipulation.
*/

// Object representing an instance of the game
var instance = {
    turn: 0, // integer indicating whos turn it is
    players: [], // array of player names
    xSize: 7, // default value, will in practice be overruled
    ySize: 6, // default value, will in practice be overruled
    board: [] // will be set as a matrix representing the board
};

var EMPTY = "_"; // string denoting empty space in the board

// The player whose turn it is drops a token in column `col`
// TODO: should probably return the row it is placed in or 
// false if no empty slot available in this col
export function makeMove(col) {
    let player = instance.players[instance.turn];
    let row = nextEmptyRow(col);
    if (row === false) {
        alert("ERROR, no more space in this column!");
    } else {
        instance.board[row][col] = instance.turn;
        console.log(player, " drops a token in ", col);
    }
    logBoard();
}

/**
    Return the next empty slot if it exists
    Otherwise, return false
*/
function nextEmptyRow(col) {
    // TODO: double check why not ySize - 1 
    for (let i = instance.ySize; i >= 0; i--) {
        if (instance.board[i][col] === EMPTY) {
            return i;
        }
    }
    return false;
}

function logBoard() {
    console.log(instance.board);
    let str = "";
    for (let m = 0; m < instance.xSize; m++) {
        for (let n = 0; n < instance.ySize; n++) {
            str += instance.board[m][n] + " ";
        }
        str += "\n";
    }
    console.log(str);
}


// Set next player's turn in model and return her/his name (so that view can update)
export function nextTurn() {
    let nbrPlayers = instance.players.length;
    instance.turn = (instance.turn + 1) % nbrPlayers;
    return instance.players[instance.turn];
}

export function setup(playerNames, xSize, ySize) {
    console.log("setting up the game.");

    instance.players = playerNames;
    instance.xSize = xSize;
    instance.ySize = ySize;

    // Initiate the board as an array of arrays -> matrix
    // row-major layout
    instance.board = new Array(xSize);
    for (let i = 0; i < xSize; i++) {
        // The + before ySize is required to coerce ySize to int,
        // even though it is supposed to be an int
        instance.board[i] = new Array(+ySize);
    }

    resetBoard();

    // Draw a random player to start
    instance.turn = Math.floor(Math.random() * instance.players.length);
    console.log(instance);
}


// Sets the whole board to be empty
function resetBoard() {
    for (let m = 0; m < instance.xSize; m++) {
        for (let n = 0; n < instance.ySize; n++) {
            instance.board[m][n] = EMPTY;
        }
    }
}
