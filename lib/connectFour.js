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
    table.id = 'gameBoard';

    for (let i = 0; i < y; i++) {
        let row = document.createElement('tr');
        for (let j = 0; j < x; j++) {
            let cell = document.createElement('td');
            let div = document.createElement('div');
            // Set some x and y coordinates for the div inside the cell
            div.dataset.x = j;
            div.dataset.y = i;
            div.className = "cell";
            cell.appendChild(div);
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
