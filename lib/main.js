import {setupGame} from './connectFour.js';
import $ from 'jquery';

/**
Bind the submit handler to connectFour.setupGame()
*/
$(document).ready(function() {
    console.log("document ready");
    $('#settings').submit(function(event) {
        event.preventDefault();
        event.target.checkValidity();
        setupGame();
    });
});
