## Running the app
The simplest way to test the app is to visit [connect-four.axellarsson.nu](http://connect-four.axellarsson.nu), where the app is running on an Apache web server.

### Running locally
This requires a few more steps than just clicking the above link, but is still pretty easy:

1. Download the [latest release](https://github.com/AxelTLarsson/connect-four/releases/latest) from the release page.
2. Extract the archive.
3. `cd` into it and serve the app via any decent Web Server. A decent example that should be available is `python -m SimpleHTTPServer`.
4. Go to [http://localhost:8000](http://localhost:8000) (modify the port number according to what the Web Server chooses). Play to win!

## Architecture
The app is written in JavaScript and I am using some ES6 code with the help of the Babel transpiler. The package manager of choice is JSPM, which can handle ES6 modules and does automatic transpilation to ES5 (which is one of the reasons I chose it). JSPM can install packages from npm and github among other places.

The architecture of the app is quite simple. In `lib/main.js` the main logic of the interface is handled via DOM manipulation with JavaScript and JQuery. In `lib/connectFour.js` the logic of the game resides, e.g. the win algorithm resides here. That module does not "know" anything about the UI of the app and it is imported as `game` in `main.js`.

There is also a module `lib/audit.js` which handles the audit log.

Persistent storage is handled with HTML 5 Local Storage via JavaScript and a pair of methods to simplify storing and retrieving JSON (in the standard, Local Storage does string serialisation only).

## Branches
The master branch is for releases. This branch has the `index.html` file using the `app.js` bundle as the script source. The bundle is created with `jspm bundle-sfx lib/main.js app.js` and the master branch is only updated when there is a new version to be released.

The `develop` branch is for developing and loads the JavaScript unbundled which is better when developing.
