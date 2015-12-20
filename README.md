## Running the app
See the `master` branch for instructions.

## Running the app in dev mode
To run the app locally in development mode:

1. Install `npm`.
2. Install JSPM: `npm install -g jspm`.
3. Clone the repo and enter the dir: `git clone https://github.com/AxelTLarsson/connect-four.git && cd connect-four`.
4. Install dependencies: `npm install && jspm install`.
5. Now the app should be able to be served by any web server, for instance `pyton -m SimpleHTTPServer`.
6. Click the link: [http://localhost:8000](http://localhost:8000) (the port number may need to be adjusted if another web server is used).

## Architecture
The app is written in JavaScript and I am using some ES6 code with the help of the Babel transpiler. The package manager of choice is JSPM, which can handle ES6 modules and does automatic transpilation to ES5 (which is one of the reasons I chose it). JSPM can install packages from npm and github among other places.

The architecture of the app is quite simple. In `lib/main.js` the main logic of the interface is handled via DOM manipulation with JavaScript and JQuery. In `lib/connectFour.js` the logic of the game resides, e.g. the win algorithm resides here. That module does not "know" anything about the UI of the app and it is imported as `game` in `main.js`.

There is also a module `lib/audit.js` which handles the audit log.

Persistent storage is handled with HTML 5 Local Storage via JavaScript and a pair of methods to simplify storing and retrieving JSON (in the standard, Local Storage does string serialisation only).
