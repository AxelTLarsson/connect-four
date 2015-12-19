/*
connectFour.js
This is the model of the game, all logic is here but no DOM manipulation.
*/
export {
    setup, 
    makeMove,
    nextTurn, 
    isWon, 
    currentPlayer, 
    currentPlayerId, 
    getInstance, 
    restoreInstance, 
    updateHighScore, 
    getHighscore, 
    restoreHighscore,
    nextEmptyRow
}

import * as audit from './audit.js';

// Object representing an instance of the game
var instance = {
    turn: 0, // integer indicating whos turn it is
    players: [], // array of player names
    xSize: 7, // default value, will in practice be overruled
    ySize: 6, // default value, will in practice be overruled
    board: [] // will be set as a matrix representing the board
};

var highscore = {};

// Return highscore object so that it can be saved
function getHighscore() {
    return highscore;
}

// Restore the highscore object
function restoreHighscore(oldHighscore) {
    highscore = oldHighscore;
}

// Increment the highscore for player `player`
function updateHighScore(player) {
    if (typeof highscore[player] === "undefined") {
        highscore[player] = 1;
    } else {
        highscore[player] += 1;
    }
    audit.log(`${player} has now won ${highscore[player]} times`);
}

// Return instance object so that it can be saved
function getInstance() {
    return instance;
}

function restoreInstance(oldInstance) {
    instance = oldInstance;
}

var EMPTY = "_"; // string denoting empty space in the board

// The player whose turn it is drops a token in column `col`
// returns the row the token was placed in or
// false if no empty slot available in this col
function makeMove(col) {
    let player = instance.players[instance.turn];
    let row = nextEmptyRow(col);

    if (row === false) {
        return false;
    } else {
        instance.board[row][col] = instance.turn;
        audit.log(player, " drops a token in ", col);
        logBoard();
        return row;
    }
}

// Return the next empty slot if it exists, else false
function nextEmptyRow(col) {
    for (let i = instance.ySize - 1; i >= 0; i--) {
        if (instance.board[i][col] === EMPTY) {
            return i;
        }
    }
    return false;
}


/**
    Compute wheter a token dropped in `row,col` is a win or not
*/
function isWon(row, col) {
    let player = instance.board[row][col];

    // Partially apply connection with player argument
    let predicate = connection.bind(null, player);

    /* Check for horizontal win */
    let leftPos = traverseWhile(predicate, stepLeft, row, col);
    let rightPos = traverseWhile(predicate, stepRight, row, col);
    // > 4 because both step functions will have stepped one step too much
    if ((rightPos.j - leftPos.j) > 4) {
        audit.log("win horizontally!");
        return true;
    }

    /* Check for vertical win */
    let downPos = traverseWhile(predicate, stepDown, row, col);
    let upPos = traverseWhile(predicate, stepUp, row, col);
    // > 4 because both step functions will have stepped one step too much
    if ((upPos.i - downPos.i) > 4) {
        audit.log("win  vertically!");
        return true;
    }

    /* Check for diagonal \ win */
    let downRightPos = traverseWhile(predicate, stepDownRight, row, col);
    let upLeftPos = traverseWhile(predicate, stepUpLeft, row, col);
    // > 4 because both step functions will have stepped one step too much
    if ((upLeftPos.i - downRightPos.i) > 4) {
        audit.log("win diagonally!");
        return true;
    }

    /* Check for diagonal / win */
    let downLeftPos = traverseWhile(predicate, stepDownLeft, row, col);
    let upRightPos = traverseWhile(predicate, stepUpRight, row, col);
    // > 4 because both step functions will have stepped one step too much
    if ((upRightPos.i - downLeftPos.i) > 4) {
        console.log("win diagonally!");
        return true;
    }

    function connection(token, r, c) {
        function sameToken(token, r, c) {
            return instance.board[r][c] == token;
        }

        function withinBoard(r, c) {
            return r >= 0 && r < instance.ySize && c >= 0 && c < instance.xSize;
        }

        return withinBoard(r, c) && sameToken(token, r, c);
    }

    /*
    Traverse the board while predicate `p` holds in direction specified
    by `next` from position (i,j). Return the end position as (i',j')
    */
    function traverseWhile(p, next, i, j) {
        let iEnd = i;
        let jEnd = j;

        while (p(iEnd, jEnd)) {
            let nextPos = next(iEnd, jEnd);
            iEnd = nextPos.i;
            jEnd = nextPos.j;
        }
        return {
            i: iEnd,
            j: jEnd
        };
    }

    function stepLeft(i, j) {
        return {
            i: i,
            j: (+j - 1)
        };
    }

    function stepRight(i, j) {
        return {
            i: i,
            j: (+j + 1)
        };
    }

    function stepUp(i, j) {
        return {
            i: (+i + 1),
            j: j
        };
    }

    function stepDown(i, j) {
        return {
            i: (+i - 1),
            j: j
        };
    }

    function stepUpLeft(i, j) {
        let pos = stepUp(i, j);
        return stepLeft(pos.i, pos.j);
    }

    function stepDownRight(i, j) {
        let pos = stepDown(i, j);
        return stepRight(pos.i, pos.j);
    }

    function stepUpRight(i, j) {
        let pos = stepUp(i, j);
        return stepRight(pos.i, pos.j);
    }

    function stepDownLeft(i, j) {
        let pos = stepDown(i, j);
        return stepLeft(pos.i, pos.j);
    }

    return false;
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
    audit.log("setting up the game.");

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

    audit.log(`rows: ${instance.board.length}\ncols: ${instance.board[0].length}`);
    resetBoard();

    // Draw a random player to start
    instance.turn = Math.floor(Math.random() * instance.players.length);
}


// Sets the whole board to be empty
function resetBoard() {
    for (let m = 0; m < instance.ySize; m++) {
        for (let n = 0; n < instance.xSize; n++) {
            instance.board[m][n] = EMPTY;
        }
    }
}

// Return the name of the current player
function currentPlayer() {
    return instance.players[instance.turn];
}

// Return the id of the current player
function currentPlayerId() {
    return instance.turn;
}
