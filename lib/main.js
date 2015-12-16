/*
main.js
The main JS script, handling the view (manipulating DOM), calling appropiate functions on
the model in connectFour.js, here referenced simply as `game`.
*/

import * as game from './connectFour';
import $ from 'jquery';

$(document).ready(function() {
    /**
    Attach event handler for pessing the `Play` button
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
                cell.appendChild(div);
                row.appendChild(cell);
            }
            tbody.appendChild(row);
        }

        let turnIndicator = create('div');
        turnIndicator.id = 'turn-indicator';
        getById('game').appendChild(turnIndicator);
        getById('game').appendChild(table);

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
            let row = $(this).children()[0].dataset.y;
            if (game.makeMove(col) === false) {
                // Todo: handle better
            } else { // only update if makeMove was somehow succesful
                updateTurnIndicator(game.nextTurn());
            }
        });
    };

    // Convenience wrapper for document.create
    function create(type) {
        return document.createElement(type);
    }

    // Convencience wrapper for document.getElementById
    function getById(id) {
        return document.getElementById(id);
    }

});
