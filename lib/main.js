import {
    setupGame
}
from './connectFour.js';
import $ from 'jquery';

$(document).ready(function() {
    console.info("document ready");
    /**
    Bind the submit handler to connectFour.setupGame()
    */
    $('#settings').submit(function(event) {
        event.preventDefault();
        event.target.checkValidity();
        setupGame();
    });

    
    
});
