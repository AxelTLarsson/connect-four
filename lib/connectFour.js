var gameInstance = {
    board: [],
    player1: "",
    player2: ""
};

var board = {
    sizeX: 7, // default value
    sizeY: 6, // default value
    board: [
            []
        ] // a 2D array - matrix
};

/**
Create the game board
*/
function createBoard(x, y) {
    var table = document.createElement('table');

    for (var i = 0; i < y; i++) {
        var row = document.createElement('tr');
        for (var j = 0; j < x; j++) {
            var cell = document.createElement('td');
            row.appendChild(cell);
        }
        table.appendChild(row);
    }

    document.getElementById('game').appendChild(table);
};


export function setupGame() {
    console.log("setting up the game.");

    gameInstance.player1 = document.getElementById('player1').value;
    gameInstance.player2 = document.getElementById('player2').value;
    gameInstance.sizeX = document.getElementById('x-size').value;
    gameInstance.sizeY = document.getElementById('y-size').value;
    gameInstance.board = board;
    console.log(gameInstance);

    createBoard(gameInstance.sizeX, gameInstance.sizeY);
}
