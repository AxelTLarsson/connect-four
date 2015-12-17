/*
main.js
The main JS script, handling the view (manipulating DOM), calling appropiate functions on
the model in connectFour.js, here referenced simply as `game`.
*/

import * as game from './connectFour';
import $ from 'jquery';

$(document).ready(function() {

    /* HTML5 local storage extension to easily handle objects */
    Storage.prototype.setObject = function(key, value) {
        this.setItem(key, JSON.stringify(value));
    }
    Storage.prototype.getObject = function(key) {
        var value = this.getItem(key);
        return value && JSON.parse(value);
    }

    /**
    If any old instance is saved to persistent storage, restore that
    */
    let oldInstance = localStorage.getObject("instance")
    if (typeof oldInstance !== "undefined" && oldInstance) {
        $('#settings').hide();
        game.restore(oldInstance);
        console.log(oldInstance);
        createBoard(oldInstance.xSize, oldInstance.ySize);
        updateTurnIndicator(game.currentPlayer()); // note: currentPlayer() and not nextTurn()
        // Update board according to the instance
        for (let m = 0; m < oldInstance.ySize; m++) {
            for (let n = 0; n < oldInstance.xSize; n++) {
                let cellId = oldInstance.board[m][n];
                if (cellId !== "_") {
                    getCell(m, n).classList.add(`marker${cellId}`)
                }
            }
        }
        console.info("Previous game instance loaded");
    } else {
        console.info("No previous instance found, starting new game");
    }
    
    /**
    Attach event handler for pressing the `Play` button
    */
    $('#settings').submit(function(event) {
        event.preventDefault();
        event.target.checkValidity();

        let playerNames = [
            getById('player1').value,
            getById('player2').value
        ];

        let xSize = getById('x-size').value;
        let ySize = getById('y-size').value;

        game.setup(playerNames, xSize, ySize);
        createBoard(xSize, ySize);
        updateTurnIndicator(game.nextTurn());
        console.log(game.getInstance());

        $('#settings').hide();


    });

    function updateTurnIndicator(playerName) {
        getById('turn-indicator').innerHTML = playerName + "'s turn";
    }

    function createBoard(x, y) {
        // The game board is realised as a table of size x * y.
        var table = create('table');
        var tbody = create('tbody');
        table.id = 'gameBoard';

        for (let i = 0; i < x; i++) {
            table.appendChild(create('colgroup'));
        }
        table.appendChild(tbody);

        for (let i = 0; i < y; i++) {
            let row = create('tr');
            for (let j = 0; j < x; j++) {
                let cell = create('td');
                let div = create('div');
                // Set some x and y coordinates for the div inside the cell,
                // these will be used to know which column was clicked
                div.dataset.x = j;
                div.dataset.y = i;
                div.className = 'cell';
                div.classList.add(`index${j}-${i}`);
                cell.appendChild(div);
                row.appendChild(cell);
            }
            tbody.appendChild(row);
        }

        let turnIndicator = create('div');
        turnIndicator.id = 'turn-indicator';
        getById('game').appendChild(turnIndicator);
        getById('game').appendChild(table);
        let resetButton = create('button');
        resetButton.appendChild(document.createTextNode("Reset"));
        resetButton.id = "resetButton";
        getById('game').appendChild(resetButton);

        $('#resetButton').on('click', reset);

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

        // Attach event handler for clicking on column = making a move
        $("#game").on("click", "#gameBoard tr td", function(e) {
            let col = $(this).children()[0].dataset.x;
            let row = game.makeMove(col);
            if (row === false) {
                alert("no space in this column");
            } else { // only update if makeMove was somehow succesful
                console.log(`placed in row ${row}`);
                getCell(row, col).classList.add(`marker${game.currentPlayerId()}`);
                if (game.isWon(row, col)) {
                    // Display winner message
                    getById('turn-indicator').innerHTML = `<p id="winMsg">Congratulations: <strong>${game.currentPlayer()}</strong>, you have won the game!</p>`;
                    // Prevent players from making any more moves
                    $('#game').off();
                    // Change text of reset button to "Play again"
                    let playAgain = document.createTextNode("Play again!");
                    let reset = getById('resetButton');
                    reset.replaceChild(playAgain, reset.childNodes[0]);
                } else {
                    updateTurnIndicator(game.nextTurn());
                    // Save instance to persistent storage
                    localStorage.setObject("instance", game.getInstance());
                }
            }
        });
    };

    // Get the DOM element at (row,col)
    function getCell(row, col) {
        return document.getElementsByClassName(`index${col}-${row}`)[0];
    }

    function reset(event) {
        $('#game').off(); // remove click listeners
        $("#gameBoard").remove();
        $('#turn-indicator').remove();
        $("#resetButton").remove();
        $("#settings").show();
        localStorage.removeItem("instance");
        console.info("Stored instance deleted");
    }

    // Convenience wrapper for document.create
    function create(type) {
        return document.createElement(type);
    }

    // Convencience wrapper for document.getElementById
    function getById(id) {
        return document.getElementById(id);
    }

});
