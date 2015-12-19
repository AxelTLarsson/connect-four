/*
main.js
The main JS script, handling the view (manipulating DOM), calling appropiate functions on
the model in connectFour.js, here referenced simply as `game`.
*/

import * as game from './connectFour';
import $ from 'jquery';
import tablesorter from 'tablesorter';
import * as audit from './audit';

$(document).ready(function() {

    /* HTML5 local storage extension to easily handle objects */
    Storage.prototype.setObject = function(key, value) {
        this.setItem(key, JSON.stringify(value));
    }
    Storage.prototype.getObject = function(key) {
        var value = this.getItem(key);
        return value && JSON.parse(value);
    }

    // Restore the log
    audit.restore();
    // Restore old instance
    restoreOldInstance();
    // Fill in highscore list if saved
    updateHighscore();


    /**
    Attach event handler for pressing the `Show audit log` button
    */
    $('#auditButton').click(function() {
        let theLog = audit.restore();

        console.warn("length of log", theLog);
        for (let i = theLog.length - 1; i >= 0; i--) {
            $('#auditLog').append(`<li>${theLog[i]}</li>`);
        }
        $('#auditLog').toggle();
    });

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
        $('#settingsWrapper').hide();
        $('#auditWrapper').hide();
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

        /* When player hovers over a column, that players token will be
        temporarily placed on the next available position in the column */
        $('td').hover(function() {
            let col = $(this).find('.cell').data('x');
            let row = game.nextEmptyRow(col);
            let player = game.currentPlayerId();
            if (row) {
                $(`.index${col}-${row}`).addClass(`hoverCell${player}`);
            }
        }, function() {
            let col = $(this).find('.cell').data('x');
            let row = game.nextEmptyRow(col);
            let player = game.currentPlayerId();
            if (row) {
                $(`.index${col}-${row}`).removeClass(`hoverCell${player}`);
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
                    getById('turn-indicator').innerHTML = `Congratulations: ${game.currentPlayer()} you have won the game!`;
                    // Prevent players from making any more moves
                    $('#game').off();
                    // Change text of reset button to 'Play again'
                    $('#resetButton').text('Play again!');
                    game.updateHighScore(game.currentPlayer());
                    console.info(`${game.currentPlayer()} won the game, deleting instance`);
                    localStorage.removeItem("instance");
                    console.info('Saving highscore object');
                    localStorage.setObject("highscore", game.getHighscore());
                    updateHighscore();

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
        $('#resetButton').remove();
        $('#settingsWrapper').show();
        $('#auditWrapper').show();
        $('#highscoreWrapper').show();
        updateHighscore();
        localStorage.removeItem("instance");
        audit.log("Stored game instance deleted");
    }

    // Update the highscore view and model with the latest from localStorage
    function updateHighscore() {
        let highscore = localStorage.getObject("highscore");
        if (typeof highscore !== "undefined" && highscore) {
            game.restoreHighscore(highscore);

            $('#highscore tbody').empty();
            Object.keys(highscore).forEach(function(name) {
                $('#highscore').append(`<tr><td>${name}</td><td>${highscore[name]}</td></tr>`);
            });
            $('#highscore').tablesorter({sortList: [[1,1], [0,0]]});
            $('#highscore').trigger('update');
        }
        $('#highscore').show();
    }

    // Convenience wrapper for document.create
    function create(type) {
        return document.createElement(type);
    }

    // Convencience wrapper for document.getElementById
    function getById(id) {
        return document.getElementById(id);
    }

    function restoreOldInstance() {
        let oldInstance = localStorage.getObject("instance")
        if (typeof oldInstance !== "undefined" && oldInstance) {
            $('#settingsWrapper').hide();
            game.restoreInstance(oldInstance);
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
        }
    }
});
