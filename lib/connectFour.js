var gameInstance = {
    turn: 0,
    board: {},
    players: []
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
    var tbody = document.createElement('tbody');
    table.id = 'gameBoard';

    for (let i = 0; i < x; i++) {
        table.appendChild(document.createElement('colgroup'));
    }
    table.appendChild(tbody);

    for (let i = 0; i < y; i++) {
        let row = document.createElement('tr');
        for (let j = 0; j < x; j++) {
            let cell = document.createElement('td');
            let div = document.createElement('div');
            // Set some x and y coordinates for the div inside the cell
            div.dataset.x = j;
            div.dataset.y = i;
            div.className = 'cell';
            cell.appendChild(div);
            row.appendChild(cell);
        }
        tbody.appendChild(row);
    }
    let turnIndicator = document.createElement('div');
    turnIndicator.id = 'turn-indicator';
    document.getElementById('game').appendChild(turnIndicator);
    document.getElementById('game').appendChild(table);

    // Add hover effect on columns
    $("#gameBoard").delegate('td', 'mouseover mouseleave', function(e) {
        if (e.type == 'mouseover') {
            //$(this).parent().addClass("hover");
            $("colgroup").eq($(this).index()).addClass("hover");
        } else {
            //$(this).parent().removeClass("hover");
            $("colgroup").eq($(this).index()).removeClass("hover");
        }
    });

    // Attach event handler for clicking on column
    $("#game").on("click", "#gameBoard tr td", function(e) {
        let col = $(this).children()[0].dataset.x;
        makeMove(gameInstance.turn, col);
    });
};

// Player `player` drops a token in column `col`
function makeMove(player, col) {
    console.log(gameInstance.players[player], " drops a token in ", col);
    nextTurn();
}

// Set next player's turn
function nextTurn() {
    let nbrPlayers = gameInstance.players.length;
    gameInstance.turn = (gameInstance.turn + 1) % nbrPlayers;
    updateTurnIndicator(gameInstance.players[gameInstance.turn]);
}

function updateTurnIndicator(playerName) {
    document.getElementById('turn-indicator').innerHTML = playerName + "'s turn";
}

export function setupGame() {
    console.log("setting up the game.");

    gameInstance.players[0] = document.getElementById('player1').value;
    gameInstance.players[1] = document.getElementById('player2').value;
    gameInstance.sizeX = document.getElementById('x-size').value;
    gameInstance.sizeY = document.getElementById('y-size').value;
    gameInstance.board = board;

    // Draw a random player to start
    gameInstance.turn = Math.floor(Math.random() * gameInstance.players.length);
    console.log(gameInstance);
    createBoard(gameInstance.sizeX, gameInstance.sizeY);
    updateTurnIndicator(gameInstance.players[gameInstance.turn]);
}
