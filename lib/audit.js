/*
Module for the auditing of the game
*/
export {log, restore}

var theLog = [];

// The logging function
function log(msg) {
    let logMsg = new Date() + ' ' + msg;
    theLog[theLog.length] = logMsg;
    console.log(logMsg);
    save();
}

// Save the log to localStorage
function save() {
    localStorage.setObject('log', theLog);
}

// Retrieve and set the log from localStorage
function restore() {
    let oldLog = localStorage.getObject('log');
    if (typeof oldLog !== 'undefined' && oldLog) {
        theLog = oldLog;
    }
    return theLog;
}
