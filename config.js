System.config({
  baseURL: "/",
  defaultJSExtensions: true,
  transpiler: "babel",
  babelOptions: {
    "optional": [
      "runtime",
      "optimisation.modules.system"
    ]
  },
  paths: {
    "github:*": "jspm_packages/github/*",
    "npm:*": "jspm_packages/npm/*"
  },

  depCache: {
    "lib/main.js": [
      "npm:babel-runtime@5.8.34/core-js/object/keys",
      "lib/connectFour.js",
      "github:components/jquery@2.1.4",
      "npm:tablesorter@2.25.0",
      "lib/audit.js"
    ],
    "npm:tablesorter@2.25.0": [
      "npm:tablesorter@2.25.0/dist/js/jquery.tablesorter.combined"
    ],
    "github:components/jquery@2.1.4": [
      "github:components/jquery@2.1.4/jquery"
    ],
    "npm:babel-runtime@5.8.34/core-js/object/keys": [
      "npm:core-js@1.2.6/library/fn/object/keys"
    ],
    "lib/connectFour.js": [
      "lib/audit.js"
    ],
    "npm:tablesorter@2.25.0/dist/js/jquery.tablesorter.combined": [
      "npm:jquery@2.1.4",
      "github:jspm/nodelibs-process@0.1.2"
    ],
    "npm:core-js@1.2.6/library/fn/object/keys": [
      "npm:core-js@1.2.6/library/modules/es6.object.keys",
      "npm:core-js@1.2.6/library/modules/$.core"
    ],
    "npm:jquery@2.1.4": [
      "npm:jquery@2.1.4/dist/jquery"
    ],
    "github:jspm/nodelibs-process@0.1.2": [
      "github:jspm/nodelibs-process@0.1.2/index"
    ],
    "npm:core-js@1.2.6/library/modules/es6.object.keys": [
      "npm:core-js@1.2.6/library/modules/$.to-object",
      "npm:core-js@1.2.6/library/modules/$.object-sap"
    ],
    "github:jspm/nodelibs-process@0.1.2/index": [
      "npm:process@0.11.2"
    ],
    "npm:core-js@1.2.6/library/modules/$.object-sap": [
      "npm:core-js@1.2.6/library/modules/$.export",
      "npm:core-js@1.2.6/library/modules/$.core",
      "npm:core-js@1.2.6/library/modules/$.fails"
    ],
    "npm:core-js@1.2.6/library/modules/$.to-object": [
      "npm:core-js@1.2.6/library/modules/$.defined"
    ],
    "npm:jquery@2.1.4/dist/jquery": [
      "github:jspm/nodelibs-process@0.1.2"
    ],
    "npm:process@0.11.2": [
      "npm:process@0.11.2/browser"
    ],
    "npm:core-js@1.2.6/library/modules/$.export": [
      "npm:core-js@1.2.6/library/modules/$.global",
      "npm:core-js@1.2.6/library/modules/$.core",
      "npm:core-js@1.2.6/library/modules/$.ctx"
    ],
    "npm:core-js@1.2.6/library/modules/$.ctx": [
      "npm:core-js@1.2.6/library/modules/$.a-function"
    ]
  },

  map: {
    "babel": "npm:babel-core@5.8.34",
    "babel-runtime": "npm:babel-runtime@5.8.34",
    "core-js": "npm:core-js@1.2.6",
    "jquery": "github:components/jquery@2.1.4",
    "tablesorter": "npm:tablesorter@2.25.0",
    "github:jspm/nodelibs-assert@0.1.0": {
      "assert": "npm:assert@1.3.0"
    },
    "github:jspm/nodelibs-path@0.1.0": {
      "path-browserify": "npm:path-browserify@0.0.0"
    },
    "github:jspm/nodelibs-process@0.1.2": {
      "process": "npm:process@0.11.2"
    },
    "github:jspm/nodelibs-util@0.1.0": {
      "util": "npm:util@0.10.3"
    },
    "npm:assert@1.3.0": {
      "util": "npm:util@0.10.3"
    },
    "npm:babel-runtime@5.8.34": {
      "process": "github:jspm/nodelibs-process@0.1.2"
    },
    "npm:core-js@1.2.6": {
      "fs": "github:jspm/nodelibs-fs@0.1.2",
      "path": "github:jspm/nodelibs-path@0.1.0",
      "process": "github:jspm/nodelibs-process@0.1.2",
      "systemjs-json": "github:systemjs/plugin-json@0.1.0"
    },
    "npm:inherits@2.0.1": {
      "util": "github:jspm/nodelibs-util@0.1.0"
    },
    "npm:jquery@2.1.4": {
      "process": "github:jspm/nodelibs-process@0.1.2"
    },
    "npm:path-browserify@0.0.0": {
      "process": "github:jspm/nodelibs-process@0.1.2"
    },
    "npm:process@0.11.2": {
      "assert": "github:jspm/nodelibs-assert@0.1.0"
    },
    "npm:tablesorter@2.25.0": {
      "jquery": "npm:jquery@2.1.4",
      "process": "github:jspm/nodelibs-process@0.1.2"
    },
    "npm:util@0.10.3": {
      "inherits": "npm:inherits@2.0.1",
      "process": "github:jspm/nodelibs-process@0.1.2"
    }
  }
});
