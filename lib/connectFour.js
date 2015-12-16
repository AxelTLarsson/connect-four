/*
connectFour.js
This is the model of the game, all logic is here but no DOM manipulation.
*/
export {setup, makeMove, nextTurn}

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
function makeMove(col) {
    let player = instance.players[instance.turn];
    let row = nextEmptyRow(col);
    if (row === false) {
        alert("ERROR, no more space in this column!");
    } else {
        instance.board[row][col] = instance.turn;
        console.log(player, " drops a token in ", col);
        isWin(row, col);
    }
    logBoard();
}

/**
    Return the next empty slot if it exists
    Otherwise, return false
*/
function nextEmptyRow(col) {
    for (let i = instance.ySize-1; i >= 0; i--) {
        if (instance.board[i][col] === EMPTY) {
            return i;
        }
    }
    return false;
}

/**
    Compute wheter a token dropped in `row,col` is a win or not
*/
function isWin(row, col) {
    let player = instance.board[row][col];

    function connection(token, r, c) {
        function sameToken(token, r, c) {
            return instance.board[r][c] == token;
        }

        function withinBoard(r, c) {
            return r >= 0 && r < instance.ySize && c >= 0 && c < instance.xSize;
        }

        return withinBoard(r, c) && sameToken(token, r, c);
    }
    
    // go as far as possible to the left
    let i = row;
    let j = col;
    while (connection(player, i, j)) {
        j--;
    }
    let left = j + 1;
    j = left;
    while (connection(player, i, j)) {
        j++;
    }
    let right = j - 1;

    if ((right-left) >= 3) {
        alert(`Congratulations ${instance.players[player]}, you have won!`);
        return true;
    }

    console.log(`left: ${left}, right: ${right}, diff: ${right - left}, win: ${(right - left) >= 3}`);

}

function logBoard() {
    let str = "";
    for (let m = 0; m < instance.ySize; m++) {
        for (let n = 0; n < instance.xSize; n++) {
            str += instance.board[m][n] + " ";
        }
        str += "\n";
    }
    console.log(str);
}


// Set next player's turn in model and return her/his name (so that view can update)
function nextTurn() {
    let nbrPlayers = instance.players.length;
    instance.turn = (instance.turn + 1) % nbrPlayers;
    return instance.players[instance.turn];
}

function setup(playerNames, xSize, ySize) {
    console.log("setting up the game.");

    instance.players = playerNames;
    instance.xSize = xSize;
    instance.ySize = ySize;

    // Initiate the board as an array of arrays -> matrix
    // row-major layout
    instance.board = new Array(ySize);
    for (let i = 0; i < ySize; i++) {
        // The + before ySize is required to coerce xSize to int,
        // even though it is supposed to be an int
        instance.board[i] = new Array(+xSize);
    }

    console.log(`rows: ${instance.board.length}\ncols: ${instance.board[0].length}`);
    resetBoard();

    // Draw a random player to start
    instance.turn = Math.floor(Math.random() * instance.players.length);
    console.log(instance);
}


// Sets the whole board to be empty
function resetBoard() {
    for (let m = 0; m < instance.ySize; m++) {
        for (let n = 0; n < instance.xSize; n++) {
            instance.board[m][n] = EMPTY;
        }
    }
}
