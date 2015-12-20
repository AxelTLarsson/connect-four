"format global";
(function(global) {

  var defined = {};

  // indexOf polyfill for IE8
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var getOwnPropertyDescriptor = true;
  try {
    Object.getOwnPropertyDescriptor({ a: 0 }, 'a');
  }
  catch(e) {
    getOwnPropertyDescriptor = false;
  }

  var defineProperty;
  (function () {
    try {
      if (!!Object.defineProperty({}, 'a', {}))
        defineProperty = Object.defineProperty;
    }
    catch (e) {
      defineProperty = function(obj, prop, opt) {
        try {
          obj[prop] = opt.value || opt.get.call(obj);
        }
        catch(e) {}
      }
    }
  })();

  function register(name, deps, declare) {
    if (arguments.length === 4)
      return registerDynamic.apply(this, arguments);
    doRegister(name, {
      declarative: true,
      deps: deps,
      declare: declare
    });
  }

  function registerDynamic(name, deps, executingRequire, execute) {
    doRegister(name, {
      declarative: false,
      deps: deps,
      executingRequire: executingRequire,
      execute: execute
    });
  }

  function doRegister(name, entry) {
    entry.name = name;

    // we never overwrite an existing define
    if (!(name in defined))
      defined[name] = entry;

    // we have to normalize dependencies
    // (assume dependencies are normalized for now)
    // entry.normalizedDeps = entry.deps.map(normalize);
    entry.normalizedDeps = entry.deps;
  }


  function buildGroups(entry, groups) {
    groups[entry.groupIndex] = groups[entry.groupIndex] || [];

    if (indexOf.call(groups[entry.groupIndex], entry) != -1)
      return;

    groups[entry.groupIndex].push(entry);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];

      // not in the registry means already linked / ES6
      if (!depEntry || depEntry.evaluated)
        continue;

      // now we know the entry is in our unlinked linkage group
      var depGroupIndex = entry.groupIndex + (depEntry.declarative != entry.declarative);

      // the group index of an entry is always the maximum
      if (depEntry.groupIndex === undefined || depEntry.groupIndex < depGroupIndex) {

        // if already in a group, remove from the old group
        if (depEntry.groupIndex !== undefined) {
          groups[depEntry.groupIndex].splice(indexOf.call(groups[depEntry.groupIndex], depEntry), 1);

          // if the old group is empty, then we have a mixed depndency cycle
          if (groups[depEntry.groupIndex].length == 0)
            throw new TypeError("Mixed dependency cycle detected");
        }

        depEntry.groupIndex = depGroupIndex;
      }

      buildGroups(depEntry, groups);
    }
  }

  function link(name) {
    var startEntry = defined[name];

    startEntry.groupIndex = 0;

    var groups = [];

    buildGroups(startEntry, groups);

    var curGroupDeclarative = !!startEntry.declarative == groups.length % 2;
    for (var i = groups.length - 1; i >= 0; i--) {
      var group = groups[i];
      for (var j = 0; j < group.length; j++) {
        var entry = group[j];

        // link each group
        if (curGroupDeclarative)
          linkDeclarativeModule(entry);
        else
          linkDynamicModule(entry);
      }
      curGroupDeclarative = !curGroupDeclarative; 
    }
  }

  // module binding records
  var moduleRecords = {};
  function getOrCreateModuleRecord(name) {
    return moduleRecords[name] || (moduleRecords[name] = {
      name: name,
      dependencies: [],
      exports: {}, // start from an empty module and extend
      importers: []
    })
  }

  function linkDeclarativeModule(entry) {
    // only link if already not already started linking (stops at circular)
    if (entry.module)
      return;

    var module = entry.module = getOrCreateModuleRecord(entry.name);
    var exports = entry.module.exports;

    var declaration = entry.declare.call(global, function(name, value) {
      module.locked = true;

      if (typeof name == 'object') {
        for (var p in name)
          exports[p] = name[p];
      }
      else {
        exports[name] = value;
      }

      for (var i = 0, l = module.importers.length; i < l; i++) {
        var importerModule = module.importers[i];
        if (!importerModule.locked) {
          for (var j = 0; j < importerModule.dependencies.length; ++j) {
            if (importerModule.dependencies[j] === module) {
              importerModule.setters[j](exports);
            }
          }
        }
      }

      module.locked = false;
      return value;
    });

    module.setters = declaration.setters;
    module.execute = declaration.execute;

    // now link all the module dependencies
    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      var depEntry = defined[depName];
      var depModule = moduleRecords[depName];

      // work out how to set depExports based on scenarios...
      var depExports;

      if (depModule) {
        depExports = depModule.exports;
      }
      else if (depEntry && !depEntry.declarative) {
        depExports = depEntry.esModule;
      }
      // in the module registry
      else if (!depEntry) {
        depExports = load(depName);
      }
      // we have an entry -> link
      else {
        linkDeclarativeModule(depEntry);
        depModule = depEntry.module;
        depExports = depModule.exports;
      }

      // only declarative modules have dynamic bindings
      if (depModule && depModule.importers) {
        depModule.importers.push(module);
        module.dependencies.push(depModule);
      }
      else
        module.dependencies.push(null);

      // run the setter for this dependency
      if (module.setters[i])
        module.setters[i](depExports);
    }
  }

  // An analog to loader.get covering execution of all three layers (real declarative, simulated declarative, simulated dynamic)
  function getModule(name) {
    var exports;
    var entry = defined[name];

    if (!entry) {
      exports = load(name);
      if (!exports)
        throw new Error("Unable to load dependency " + name + ".");
    }

    else {
      if (entry.declarative)
        ensureEvaluated(name, []);

      else if (!entry.evaluated)
        linkDynamicModule(entry);

      exports = entry.module.exports;
    }

    if ((!entry || entry.declarative) && exports && exports.__useDefault)
      return exports['default'];

    return exports;
  }

  function linkDynamicModule(entry) {
    if (entry.module)
      return;

    var exports = {};

    var module = entry.module = { exports: exports, id: entry.name };

    // AMD requires execute the tree first
    if (!entry.executingRequire) {
      for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
        var depName = entry.normalizedDeps[i];
        var depEntry = defined[depName];
        if (depEntry)
          linkDynamicModule(depEntry);
      }
    }

    // now execute
    entry.evaluated = true;
    var output = entry.execute.call(global, function(name) {
      for (var i = 0, l = entry.deps.length; i < l; i++) {
        if (entry.deps[i] != name)
          continue;
        return getModule(entry.normalizedDeps[i]);
      }
      throw new TypeError('Module ' + name + ' not declared as a dependency.');
    }, exports, module);

    if (output)
      module.exports = output;

    // create the esModule object, which allows ES6 named imports of dynamics
    exports = module.exports;
 
    if (exports && exports.__esModule) {
      entry.esModule = exports;
    }
    else {
      entry.esModule = {};
      
      // don't trigger getters/setters in environments that support them
      if ((typeof exports == 'object' || typeof exports == 'function') && exports !== global) {
        if (getOwnPropertyDescriptor) {
          var d;
          for (var p in exports)
            if (d = Object.getOwnPropertyDescriptor(exports, p))
              defineProperty(entry.esModule, p, d);
        }
        else {
          var hasOwnProperty = exports && exports.hasOwnProperty;
          for (var p in exports) {
            if (!hasOwnProperty || exports.hasOwnProperty(p))
              entry.esModule[p] = exports[p];
          }
         }
       }
      entry.esModule['default'] = exports;
      defineProperty(entry.esModule, '__useDefault', {
        value: true
      });
    }
  }

  /*
   * Given a module, and the list of modules for this current branch,
   *  ensure that each of the dependencies of this module is evaluated
   *  (unless one is a circular dependency already in the list of seen
   *  modules, in which case we execute it)
   *
   * Then we evaluate the module itself depth-first left to right 
   * execution to match ES6 modules
   */
  function ensureEvaluated(moduleName, seen) {
    var entry = defined[moduleName];

    // if already seen, that means it's an already-evaluated non circular dependency
    if (!entry || entry.evaluated || !entry.declarative)
      return;

    // this only applies to declarative modules which late-execute

    seen.push(moduleName);

    for (var i = 0, l = entry.normalizedDeps.length; i < l; i++) {
      var depName = entry.normalizedDeps[i];
      if (indexOf.call(seen, depName) == -1) {
        if (!defined[depName])
          load(depName);
        else
          ensureEvaluated(depName, seen);
      }
    }

    if (entry.evaluated)
      return;

    entry.evaluated = true;
    entry.module.execute.call(global);
  }

  // magical execution function
  var modules = {};
  function load(name) {
    if (modules[name])
      return modules[name];

    // node core modules
    if (name.substr(0, 6) == '@node/')
      return require(name.substr(6));

    var entry = defined[name];

    // first we check if this module has already been defined in the registry
    if (!entry)
      throw "Module " + name + " not present.";

    // recursively ensure that the module and all its 
    // dependencies are linked (with dependency group handling)
    link(name);

    // now handle dependency execution in correct order
    ensureEvaluated(name, []);

    // remove from the registry
    defined[name] = undefined;

    // exported modules get __esModule defined for interop
    if (entry.declarative)
      defineProperty(entry.module.exports, '__esModule', { value: true });

    // return the defined module object
    return modules[name] = entry.declarative ? entry.module.exports : entry.esModule;
  };

  return function(mains, depNames, declare) {
    return function(formatDetect) {
      formatDetect(function(deps) {
        var System = {
          _nodeRequire: typeof require != 'undefined' && require.resolve && typeof process != 'undefined' && require,
          register: register,
          registerDynamic: registerDynamic,
          get: load, 
          set: function(name, module) {
            modules[name] = module; 
          },
          newModule: function(module) {
            return module;
          }
        };
        System.set('@empty', {});

        // register external dependencies
        for (var i = 0; i < depNames.length; i++) (function(depName, dep) {
          if (dep && dep.__esModule)
            System.register(depName, [], function(_export) {
              return {
                setters: [],
                execute: function() {
                  for (var p in dep)
                    if (p != '__esModule' && !(typeof p == 'object' && p + '' == 'Module'))
                      _export(p, dep[p]);
                }
              };
            });
          else
            System.registerDynamic(depName, [], false, function() {
              return dep;
            });
        })(depNames[i], arguments[i]);

        // register modules in this bundle
        declare(System);

        // load mains
        var firstLoad = load(mains[0]);
        if (mains.length > 1)
          for (var i = 1; i < mains.length; i++)
            load(mains[i]);

        if (firstLoad.__useDefault)
          return firstLoad['default'];
        else
          return firstLoad;
      });
    };
  };

})(typeof self != 'undefined' ? self : global)
/* (['mainModule'], ['external-dep'], function($__System) {
  System.register(...);
})
(function(factory) {
  if (typeof define && define.amd)
    define(['external-dep'], factory);
  // etc UMD / module pattern
})*/

(['1'], [], function($__System) {

(function(__global) {
  var loader = $__System;
  var indexOf = Array.prototype.indexOf || function(item) {
    for (var i = 0, l = this.length; i < l; i++)
      if (this[i] === item)
        return i;
    return -1;
  }

  var commentRegEx = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg;
  var cjsRequirePre = "(?:^|[^$_a-zA-Z\\xA0-\\uFFFF.])";
  var cjsRequirePost = "\\s*\\(\\s*(\"([^\"]+)\"|'([^']+)')\\s*\\)";
  var fnBracketRegEx = /\(([^\)]*)\)/;
  var wsRegEx = /^\s+|\s+$/g;
  
  var requireRegExs = {};

  function getCJSDeps(source, requireIndex) {

    // remove comments
    source = source.replace(commentRegEx, '');

    // determine the require alias
    var params = source.match(fnBracketRegEx);
    var requireAlias = (params[1].split(',')[requireIndex] || 'require').replace(wsRegEx, '');

    // find or generate the regex for this requireAlias
    var requireRegEx = requireRegExs[requireAlias] || (requireRegExs[requireAlias] = new RegExp(cjsRequirePre + requireAlias + cjsRequirePost, 'g'));

    requireRegEx.lastIndex = 0;

    var deps = [];

    var match;
    while (match = requireRegEx.exec(source))
      deps.push(match[2] || match[3]);

    return deps;
  }

  /*
    AMD-compatible require
    To copy RequireJS, set window.require = window.requirejs = loader.amdRequire
  */
  function require(names, callback, errback, referer) {
    // in amd, first arg can be a config object... we just ignore
    if (typeof names == 'object' && !(names instanceof Array))
      return require.apply(null, Array.prototype.splice.call(arguments, 1, arguments.length - 1));

    // amd require
    if (typeof names == 'string' && typeof callback == 'function')
      names = [names];
    if (names instanceof Array) {
      var dynamicRequires = [];
      for (var i = 0; i < names.length; i++)
        dynamicRequires.push(loader['import'](names[i], referer));
      Promise.all(dynamicRequires).then(function(modules) {
        if (callback)
          callback.apply(null, modules);
      }, errback);
    }

    // commonjs require
    else if (typeof names == 'string') {
      var module = loader.get(names);
      return module.__useDefault ? module['default'] : module;
    }

    else
      throw new TypeError('Invalid require');
  }

  function define(name, deps, factory) {
    if (typeof name != 'string') {
      factory = deps;
      deps = name;
      name = null;
    }
    if (!(deps instanceof Array)) {
      factory = deps;
      deps = ['require', 'exports', 'module'].splice(0, factory.length);
    }

    if (typeof factory != 'function')
      factory = (function(factory) {
        return function() { return factory; }
      })(factory);

    // in IE8, a trailing comma becomes a trailing undefined entry
    if (deps[deps.length - 1] === undefined)
      deps.pop();

    // remove system dependencies
    var requireIndex, exportsIndex, moduleIndex;
    
    if ((requireIndex = indexOf.call(deps, 'require')) != -1) {
      
      deps.splice(requireIndex, 1);

      // only trace cjs requires for non-named
      // named defines assume the trace has already been done
      if (!name)
        deps = deps.concat(getCJSDeps(factory.toString(), requireIndex));
    }

    if ((exportsIndex = indexOf.call(deps, 'exports')) != -1)
      deps.splice(exportsIndex, 1);
    
    if ((moduleIndex = indexOf.call(deps, 'module')) != -1)
      deps.splice(moduleIndex, 1);

    var define = {
      name: name,
      deps: deps,
      execute: function(req, exports, module) {

        var depValues = [];
        for (var i = 0; i < deps.length; i++)
          depValues.push(req(deps[i]));

        module.uri = module.id;

        module.config = function() {};

        // add back in system dependencies
        if (moduleIndex != -1)
          depValues.splice(moduleIndex, 0, module);
        
        if (exportsIndex != -1)
          depValues.splice(exportsIndex, 0, exports);
        
        if (requireIndex != -1) 
          depValues.splice(requireIndex, 0, function(names, callback, errback) {
            if (typeof names == 'string' && typeof callback != 'function')
              return req(names);
            return require.call(loader, names, callback, errback, module.id);
          });

        var output = factory.apply(exportsIndex == -1 ? __global : exports, depValues);

        if (typeof output == 'undefined' && module)
          output = module.exports;

        if (typeof output != 'undefined')
          return output;
      }
    };

    // anonymous define
    if (!name) {
      // already defined anonymously -> throw
      if (lastModule.anonDefine)
        throw new TypeError('Multiple defines for anonymous module');
      lastModule.anonDefine = define;
    }
    // named define
    else {
      // if we don't have any other defines,
      // then let this be an anonymous define
      // this is just to support single modules of the form:
      // define('jquery')
      // still loading anonymously
      // because it is done widely enough to be useful
      if (!lastModule.anonDefine && !lastModule.isBundle) {
        lastModule.anonDefine = define;
      }
      // otherwise its a bundle only
      else {
        // if there is an anonDefine already (we thought it could have had a single named define)
        // then we define it now
        // this is to avoid defining named defines when they are actually anonymous
        if (lastModule.anonDefine && lastModule.anonDefine.name)
          loader.registerDynamic(lastModule.anonDefine.name, lastModule.anonDefine.deps, false, lastModule.anonDefine.execute);

        lastModule.anonDefine = null;
      }

      // note this is now a bundle
      lastModule.isBundle = true;

      // define the module through the register registry
      loader.registerDynamic(name, define.deps, false, define.execute);
    }
  }
  define.amd = {};

  // adds define as a global (potentially just temporarily)
  function createDefine(loader) {
    lastModule.anonDefine = null;
    lastModule.isBundle = false;

    // ensure no NodeJS environment detection
    var oldModule = __global.module;
    var oldExports = __global.exports;
    var oldDefine = __global.define;

    __global.module = undefined;
    __global.exports = undefined;
    __global.define = define;

    return function() {
      __global.define = oldDefine;
      __global.module = oldModule;
      __global.exports = oldExports;
    };
  }

  var lastModule = {
    isBundle: false,
    anonDefine: null
  };

  loader.set('@@amd-helpers', loader.newModule({
    createDefine: createDefine,
    require: require,
    define: define,
    lastModule: lastModule
  }));
  loader.amdDefine = define;
  loader.amdRequire = require;
})(typeof self != 'undefined' ? self : global);

"bundle";
$__System.registerDynamic("2", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var process = module.exports = {};
  var queue = [];
  var draining = false;
  var currentQueue;
  var queueIndex = -1;
  function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
      queue = currentQueue.concat(queue);
    } else {
      queueIndex = -1;
    }
    if (queue.length) {
      drainQueue();
    }
  }
  function drainQueue() {
    if (draining) {
      return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;
    var len = queue.length;
    while (len) {
      currentQueue = queue;
      queue = [];
      while (++queueIndex < len) {
        if (currentQueue) {
          currentQueue[queueIndex].run();
        }
      }
      queueIndex = -1;
      len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
  }
  process.nextTick = function(fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
      for (var i = 1; i < arguments.length; i++) {
        args[i - 1] = arguments[i];
      }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
      setTimeout(drainQueue, 0);
    }
  };
  function Item(fun, array) {
    this.fun = fun;
    this.array = array;
  }
  Item.prototype.run = function() {
    this.fun.apply(null, this.array);
  };
  process.title = 'browser';
  process.browser = true;
  process.env = {};
  process.argv = [];
  process.version = '';
  process.versions = {};
  function noop() {}
  process.on = noop;
  process.addListener = noop;
  process.once = noop;
  process.off = noop;
  process.removeListener = noop;
  process.removeAllListeners = noop;
  process.emit = noop;
  process.binding = function(name) {
    throw new Error('process.binding is not supported');
  };
  process.cwd = function() {
    return '/';
  };
  process.chdir = function(dir) {
    throw new Error('process.chdir is not supported');
  };
  process.umask = function() {
    return 0;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("3", ["2"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('2');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("4", ["3"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__System._nodeRequire ? process : $__require('3');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("5", ["4"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('4');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("6", ["5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(process) {
    (function(global, factory) {
      if (typeof module === "object" && typeof module.exports === "object") {
        module.exports = global.document ? factory(global, true) : function(w) {
          if (!w.document) {
            throw new Error("jQuery requires a window with a document");
          }
          return factory(w);
        };
      } else {
        factory(global);
      }
    }(typeof window !== "undefined" ? window : this, function(window, noGlobal) {
      var arr = [];
      var slice = arr.slice;
      var concat = arr.concat;
      var push = arr.push;
      var indexOf = arr.indexOf;
      var class2type = {};
      var toString = class2type.toString;
      var hasOwn = class2type.hasOwnProperty;
      var support = {};
      var document = window.document,
          version = "2.1.4",
          jQuery = function(selector, context) {
            return new jQuery.fn.init(selector, context);
          },
          rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,
          rmsPrefix = /^-ms-/,
          rdashAlpha = /-([\da-z])/gi,
          fcamelCase = function(all, letter) {
            return letter.toUpperCase();
          };
      jQuery.fn = jQuery.prototype = {
        jquery: version,
        constructor: jQuery,
        selector: "",
        length: 0,
        toArray: function() {
          return slice.call(this);
        },
        get: function(num) {
          return num != null ? (num < 0 ? this[num + this.length] : this[num]) : slice.call(this);
        },
        pushStack: function(elems) {
          var ret = jQuery.merge(this.constructor(), elems);
          ret.prevObject = this;
          ret.context = this.context;
          return ret;
        },
        each: function(callback, args) {
          return jQuery.each(this, callback, args);
        },
        map: function(callback) {
          return this.pushStack(jQuery.map(this, function(elem, i) {
            return callback.call(elem, i, elem);
          }));
        },
        slice: function() {
          return this.pushStack(slice.apply(this, arguments));
        },
        first: function() {
          return this.eq(0);
        },
        last: function() {
          return this.eq(-1);
        },
        eq: function(i) {
          var len = this.length,
              j = +i + (i < 0 ? len : 0);
          return this.pushStack(j >= 0 && j < len ? [this[j]] : []);
        },
        end: function() {
          return this.prevObject || this.constructor(null);
        },
        push: push,
        sort: arr.sort,
        splice: arr.splice
      };
      jQuery.extend = jQuery.fn.extend = function() {
        var options,
            name,
            src,
            copy,
            copyIsArray,
            clone,
            target = arguments[0] || {},
            i = 1,
            length = arguments.length,
            deep = false;
        if (typeof target === "boolean") {
          deep = target;
          target = arguments[i] || {};
          i++;
        }
        if (typeof target !== "object" && !jQuery.isFunction(target)) {
          target = {};
        }
        if (i === length) {
          target = this;
          i--;
        }
        for (; i < length; i++) {
          if ((options = arguments[i]) != null) {
            for (name in options) {
              src = target[name];
              copy = options[name];
              if (target === copy) {
                continue;
              }
              if (deep && copy && (jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)))) {
                if (copyIsArray) {
                  copyIsArray = false;
                  clone = src && jQuery.isArray(src) ? src : [];
                } else {
                  clone = src && jQuery.isPlainObject(src) ? src : {};
                }
                target[name] = jQuery.extend(deep, clone, copy);
              } else if (copy !== undefined) {
                target[name] = copy;
              }
            }
          }
        }
        return target;
      };
      jQuery.extend({
        expando: "jQuery" + (version + Math.random()).replace(/\D/g, ""),
        isReady: true,
        error: function(msg) {
          throw new Error(msg);
        },
        noop: function() {},
        isFunction: function(obj) {
          return jQuery.type(obj) === "function";
        },
        isArray: Array.isArray,
        isWindow: function(obj) {
          return obj != null && obj === obj.window;
        },
        isNumeric: function(obj) {
          return !jQuery.isArray(obj) && (obj - parseFloat(obj) + 1) >= 0;
        },
        isPlainObject: function(obj) {
          if (jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow(obj)) {
            return false;
          }
          if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
            return false;
          }
          return true;
        },
        isEmptyObject: function(obj) {
          var name;
          for (name in obj) {
            return false;
          }
          return true;
        },
        type: function(obj) {
          if (obj == null) {
            return obj + "";
          }
          return typeof obj === "object" || typeof obj === "function" ? class2type[toString.call(obj)] || "object" : typeof obj;
        },
        globalEval: function(code) {
          var script,
              indirect = eval;
          code = jQuery.trim(code);
          if (code) {
            if (code.indexOf("use strict") === 1) {
              script = document.createElement("script");
              script.text = code;
              document.head.appendChild(script).parentNode.removeChild(script);
            } else {
              indirect(code);
            }
          }
        },
        camelCase: function(string) {
          return string.replace(rmsPrefix, "ms-").replace(rdashAlpha, fcamelCase);
        },
        nodeName: function(elem, name) {
          return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
        },
        each: function(obj, callback, args) {
          var value,
              i = 0,
              length = obj.length,
              isArray = isArraylike(obj);
          if (args) {
            if (isArray) {
              for (; i < length; i++) {
                value = callback.apply(obj[i], args);
                if (value === false) {
                  break;
                }
              }
            } else {
              for (i in obj) {
                value = callback.apply(obj[i], args);
                if (value === false) {
                  break;
                }
              }
            }
          } else {
            if (isArray) {
              for (; i < length; i++) {
                value = callback.call(obj[i], i, obj[i]);
                if (value === false) {
                  break;
                }
              }
            } else {
              for (i in obj) {
                value = callback.call(obj[i], i, obj[i]);
                if (value === false) {
                  break;
                }
              }
            }
          }
          return obj;
        },
        trim: function(text) {
          return text == null ? "" : (text + "").replace(rtrim, "");
        },
        makeArray: function(arr, results) {
          var ret = results || [];
          if (arr != null) {
            if (isArraylike(Object(arr))) {
              jQuery.merge(ret, typeof arr === "string" ? [arr] : arr);
            } else {
              push.call(ret, arr);
            }
          }
          return ret;
        },
        inArray: function(elem, arr, i) {
          return arr == null ? -1 : indexOf.call(arr, elem, i);
        },
        merge: function(first, second) {
          var len = +second.length,
              j = 0,
              i = first.length;
          for (; j < len; j++) {
            first[i++] = second[j];
          }
          first.length = i;
          return first;
        },
        grep: function(elems, callback, invert) {
          var callbackInverse,
              matches = [],
              i = 0,
              length = elems.length,
              callbackExpect = !invert;
          for (; i < length; i++) {
            callbackInverse = !callback(elems[i], i);
            if (callbackInverse !== callbackExpect) {
              matches.push(elems[i]);
            }
          }
          return matches;
        },
        map: function(elems, callback, arg) {
          var value,
              i = 0,
              length = elems.length,
              isArray = isArraylike(elems),
              ret = [];
          if (isArray) {
            for (; i < length; i++) {
              value = callback(elems[i], i, arg);
              if (value != null) {
                ret.push(value);
              }
            }
          } else {
            for (i in elems) {
              value = callback(elems[i], i, arg);
              if (value != null) {
                ret.push(value);
              }
            }
          }
          return concat.apply([], ret);
        },
        guid: 1,
        proxy: function(fn, context) {
          var tmp,
              args,
              proxy;
          if (typeof context === "string") {
            tmp = fn[context];
            context = fn;
            fn = tmp;
          }
          if (!jQuery.isFunction(fn)) {
            return undefined;
          }
          args = slice.call(arguments, 2);
          proxy = function() {
            return fn.apply(context || this, args.concat(slice.call(arguments)));
          };
          proxy.guid = fn.guid = fn.guid || jQuery.guid++;
          return proxy;
        },
        now: Date.now,
        support: support
      });
      jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
        class2type["[object " + name + "]"] = name.toLowerCase();
      });
      function isArraylike(obj) {
        var length = "length" in obj && obj.length,
            type = jQuery.type(obj);
        if (type === "function" || jQuery.isWindow(obj)) {
          return false;
        }
        if (obj.nodeType === 1 && length) {
          return true;
        }
        return type === "array" || length === 0 || typeof length === "number" && length > 0 && (length - 1) in obj;
      }
      var Sizzle = (function(window) {
        var i,
            support,
            Expr,
            getText,
            isXML,
            tokenize,
            compile,
            select,
            outermostContext,
            sortInput,
            hasDuplicate,
            setDocument,
            document,
            docElem,
            documentIsHTML,
            rbuggyQSA,
            rbuggyMatches,
            matches,
            contains,
            expando = "sizzle" + 1 * new Date(),
            preferredDoc = window.document,
            dirruns = 0,
            done = 0,
            classCache = createCache(),
            tokenCache = createCache(),
            compilerCache = createCache(),
            sortOrder = function(a, b) {
              if (a === b) {
                hasDuplicate = true;
              }
              return 0;
            },
            MAX_NEGATIVE = 1 << 31,
            hasOwn = ({}).hasOwnProperty,
            arr = [],
            pop = arr.pop,
            push_native = arr.push,
            push = arr.push,
            slice = arr.slice,
            indexOf = function(list, elem) {
              var i = 0,
                  len = list.length;
              for (; i < len; i++) {
                if (list[i] === elem) {
                  return i;
                }
              }
              return -1;
            },
            booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",
            whitespace = "[\\x20\\t\\r\\n\\f]",
            characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",
            identifier = characterEncoding.replace("w", "w#"),
            attributes = "\\[" + whitespace + "*(" + characterEncoding + ")(?:" + whitespace + "*([*^$|!~]?=)" + whitespace + "*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|(" + identifier + "))|)" + whitespace + "*\\]",
            pseudos = ":(" + characterEncoding + ")(?:\\((" + "('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|" + "((?:\\\\.|[^\\\\()[\\]]|" + attributes + ")*)|" + ".*" + ")\\)|)",
            rwhitespace = new RegExp(whitespace + "+", "g"),
            rtrim = new RegExp("^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g"),
            rcomma = new RegExp("^" + whitespace + "*," + whitespace + "*"),
            rcombinators = new RegExp("^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*"),
            rattributeQuotes = new RegExp("=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g"),
            rpseudo = new RegExp(pseudos),
            ridentifier = new RegExp("^" + identifier + "$"),
            matchExpr = {
              "ID": new RegExp("^#(" + characterEncoding + ")"),
              "CLASS": new RegExp("^\\.(" + characterEncoding + ")"),
              "TAG": new RegExp("^(" + characterEncoding.replace("w", "w*") + ")"),
              "ATTR": new RegExp("^" + attributes),
              "PSEUDO": new RegExp("^" + pseudos),
              "CHILD": new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace + "*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace + "*(\\d+)|))" + whitespace + "*\\)|)", "i"),
              "bool": new RegExp("^(?:" + booleans + ")$", "i"),
              "needsContext": new RegExp("^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" + whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i")
            },
            rinputs = /^(?:input|select|textarea|button)$/i,
            rheader = /^h\d$/i,
            rnative = /^[^{]+\{\s*\[native \w/,
            rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,
            rsibling = /[+~]/,
            rescape = /'|\\/g,
            runescape = new RegExp("\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig"),
            funescape = function(_, escaped, escapedWhitespace) {
              var high = "0x" + escaped - 0x10000;
              return high !== high || escapedWhitespace ? escaped : high < 0 ? String.fromCharCode(high + 0x10000) : String.fromCharCode(high >> 10 | 0xD800, high & 0x3FF | 0xDC00);
            },
            unloadHandler = function() {
              setDocument();
            };
        try {
          push.apply((arr = slice.call(preferredDoc.childNodes)), preferredDoc.childNodes);
          arr[preferredDoc.childNodes.length].nodeType;
        } catch (e) {
          push = {apply: arr.length ? function(target, els) {
              push_native.apply(target, slice.call(els));
            } : function(target, els) {
              var j = target.length,
                  i = 0;
              while ((target[j++] = els[i++])) {}
              target.length = j - 1;
            }};
        }
        function Sizzle(selector, context, results, seed) {
          var match,
              elem,
              m,
              nodeType,
              i,
              groups,
              old,
              nid,
              newContext,
              newSelector;
          if ((context ? context.ownerDocument || context : preferredDoc) !== document) {
            setDocument(context);
          }
          context = context || document;
          results = results || [];
          nodeType = context.nodeType;
          if (typeof selector !== "string" || !selector || nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
            return results;
          }
          if (!seed && documentIsHTML) {
            if (nodeType !== 11 && (match = rquickExpr.exec(selector))) {
              if ((m = match[1])) {
                if (nodeType === 9) {
                  elem = context.getElementById(m);
                  if (elem && elem.parentNode) {
                    if (elem.id === m) {
                      results.push(elem);
                      return results;
                    }
                  } else {
                    return results;
                  }
                } else {
                  if (context.ownerDocument && (elem = context.ownerDocument.getElementById(m)) && contains(context, elem) && elem.id === m) {
                    results.push(elem);
                    return results;
                  }
                }
              } else if (match[2]) {
                push.apply(results, context.getElementsByTagName(selector));
                return results;
              } else if ((m = match[3]) && support.getElementsByClassName) {
                push.apply(results, context.getElementsByClassName(m));
                return results;
              }
            }
            if (support.qsa && (!rbuggyQSA || !rbuggyQSA.test(selector))) {
              nid = old = expando;
              newContext = context;
              newSelector = nodeType !== 1 && selector;
              if (nodeType === 1 && context.nodeName.toLowerCase() !== "object") {
                groups = tokenize(selector);
                if ((old = context.getAttribute("id"))) {
                  nid = old.replace(rescape, "\\$&");
                } else {
                  context.setAttribute("id", nid);
                }
                nid = "[id='" + nid + "'] ";
                i = groups.length;
                while (i--) {
                  groups[i] = nid + toSelector(groups[i]);
                }
                newContext = rsibling.test(selector) && testContext(context.parentNode) || context;
                newSelector = groups.join(",");
              }
              if (newSelector) {
                try {
                  push.apply(results, newContext.querySelectorAll(newSelector));
                  return results;
                } catch (qsaError) {} finally {
                  if (!old) {
                    context.removeAttribute("id");
                  }
                }
              }
            }
          }
          return select(selector.replace(rtrim, "$1"), context, results, seed);
        }
        function createCache() {
          var keys = [];
          function cache(key, value) {
            if (keys.push(key + " ") > Expr.cacheLength) {
              delete cache[keys.shift()];
            }
            return (cache[key + " "] = value);
          }
          return cache;
        }
        function markFunction(fn) {
          fn[expando] = true;
          return fn;
        }
        function assert(fn) {
          var div = document.createElement("div");
          try {
            return !!fn(div);
          } catch (e) {
            return false;
          } finally {
            if (div.parentNode) {
              div.parentNode.removeChild(div);
            }
            div = null;
          }
        }
        function addHandle(attrs, handler) {
          var arr = attrs.split("|"),
              i = attrs.length;
          while (i--) {
            Expr.attrHandle[arr[i]] = handler;
          }
        }
        function siblingCheck(a, b) {
          var cur = b && a,
              diff = cur && a.nodeType === 1 && b.nodeType === 1 && (~b.sourceIndex || MAX_NEGATIVE) - (~a.sourceIndex || MAX_NEGATIVE);
          if (diff) {
            return diff;
          }
          if (cur) {
            while ((cur = cur.nextSibling)) {
              if (cur === b) {
                return -1;
              }
            }
          }
          return a ? 1 : -1;
        }
        function createInputPseudo(type) {
          return function(elem) {
            var name = elem.nodeName.toLowerCase();
            return name === "input" && elem.type === type;
          };
        }
        function createButtonPseudo(type) {
          return function(elem) {
            var name = elem.nodeName.toLowerCase();
            return (name === "input" || name === "button") && elem.type === type;
          };
        }
        function createPositionalPseudo(fn) {
          return markFunction(function(argument) {
            argument = +argument;
            return markFunction(function(seed, matches) {
              var j,
                  matchIndexes = fn([], seed.length, argument),
                  i = matchIndexes.length;
              while (i--) {
                if (seed[(j = matchIndexes[i])]) {
                  seed[j] = !(matches[j] = seed[j]);
                }
              }
            });
          });
        }
        function testContext(context) {
          return context && typeof context.getElementsByTagName !== "undefined" && context;
        }
        support = Sizzle.support = {};
        isXML = Sizzle.isXML = function(elem) {
          var documentElement = elem && (elem.ownerDocument || elem).documentElement;
          return documentElement ? documentElement.nodeName !== "HTML" : false;
        };
        setDocument = Sizzle.setDocument = function(node) {
          var hasCompare,
              parent,
              doc = node ? node.ownerDocument || node : preferredDoc;
          if (doc === document || doc.nodeType !== 9 || !doc.documentElement) {
            return document;
          }
          document = doc;
          docElem = doc.documentElement;
          parent = doc.defaultView;
          if (parent && parent !== parent.top) {
            if (parent.addEventListener) {
              parent.addEventListener("unload", unloadHandler, false);
            } else if (parent.attachEvent) {
              parent.attachEvent("onunload", unloadHandler);
            }
          }
          documentIsHTML = !isXML(doc);
          support.attributes = assert(function(div) {
            div.className = "i";
            return !div.getAttribute("className");
          });
          support.getElementsByTagName = assert(function(div) {
            div.appendChild(doc.createComment(""));
            return !div.getElementsByTagName("*").length;
          });
          support.getElementsByClassName = rnative.test(doc.getElementsByClassName);
          support.getById = assert(function(div) {
            docElem.appendChild(div).id = expando;
            return !doc.getElementsByName || !doc.getElementsByName(expando).length;
          });
          if (support.getById) {
            Expr.find["ID"] = function(id, context) {
              if (typeof context.getElementById !== "undefined" && documentIsHTML) {
                var m = context.getElementById(id);
                return m && m.parentNode ? [m] : [];
              }
            };
            Expr.filter["ID"] = function(id) {
              var attrId = id.replace(runescape, funescape);
              return function(elem) {
                return elem.getAttribute("id") === attrId;
              };
            };
          } else {
            delete Expr.find["ID"];
            Expr.filter["ID"] = function(id) {
              var attrId = id.replace(runescape, funescape);
              return function(elem) {
                var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
                return node && node.value === attrId;
              };
            };
          }
          Expr.find["TAG"] = support.getElementsByTagName ? function(tag, context) {
            if (typeof context.getElementsByTagName !== "undefined") {
              return context.getElementsByTagName(tag);
            } else if (support.qsa) {
              return context.querySelectorAll(tag);
            }
          } : function(tag, context) {
            var elem,
                tmp = [],
                i = 0,
                results = context.getElementsByTagName(tag);
            if (tag === "*") {
              while ((elem = results[i++])) {
                if (elem.nodeType === 1) {
                  tmp.push(elem);
                }
              }
              return tmp;
            }
            return results;
          };
          Expr.find["CLASS"] = support.getElementsByClassName && function(className, context) {
            if (documentIsHTML) {
              return context.getElementsByClassName(className);
            }
          };
          rbuggyMatches = [];
          rbuggyQSA = [];
          if ((support.qsa = rnative.test(doc.querySelectorAll))) {
            assert(function(div) {
              docElem.appendChild(div).innerHTML = "<a id='" + expando + "'></a>" + "<select id='" + expando + "-\f]' msallowcapture=''>" + "<option selected=''></option></select>";
              if (div.querySelectorAll("[msallowcapture^='']").length) {
                rbuggyQSA.push("[*^$]=" + whitespace + "*(?:''|\"\")");
              }
              if (!div.querySelectorAll("[selected]").length) {
                rbuggyQSA.push("\\[" + whitespace + "*(?:value|" + booleans + ")");
              }
              if (!div.querySelectorAll("[id~=" + expando + "-]").length) {
                rbuggyQSA.push("~=");
              }
              if (!div.querySelectorAll(":checked").length) {
                rbuggyQSA.push(":checked");
              }
              if (!div.querySelectorAll("a#" + expando + "+*").length) {
                rbuggyQSA.push(".#.+[+~]");
              }
            });
            assert(function(div) {
              var input = doc.createElement("input");
              input.setAttribute("type", "hidden");
              div.appendChild(input).setAttribute("name", "D");
              if (div.querySelectorAll("[name=d]").length) {
                rbuggyQSA.push("name" + whitespace + "*[*^$|!~]?=");
              }
              if (!div.querySelectorAll(":enabled").length) {
                rbuggyQSA.push(":enabled", ":disabled");
              }
              div.querySelectorAll("*,:x");
              rbuggyQSA.push(",.*:");
            });
          }
          if ((support.matchesSelector = rnative.test((matches = docElem.matches || docElem.webkitMatchesSelector || docElem.mozMatchesSelector || docElem.oMatchesSelector || docElem.msMatchesSelector)))) {
            assert(function(div) {
              support.disconnectedMatch = matches.call(div, "div");
              matches.call(div, "[s!='']:x");
              rbuggyMatches.push("!=", pseudos);
            });
          }
          rbuggyQSA = rbuggyQSA.length && new RegExp(rbuggyQSA.join("|"));
          rbuggyMatches = rbuggyMatches.length && new RegExp(rbuggyMatches.join("|"));
          hasCompare = rnative.test(docElem.compareDocumentPosition);
          contains = hasCompare || rnative.test(docElem.contains) ? function(a, b) {
            var adown = a.nodeType === 9 ? a.documentElement : a,
                bup = b && b.parentNode;
            return a === bup || !!(bup && bup.nodeType === 1 && (adown.contains ? adown.contains(bup) : a.compareDocumentPosition && a.compareDocumentPosition(bup) & 16));
          } : function(a, b) {
            if (b) {
              while ((b = b.parentNode)) {
                if (b === a) {
                  return true;
                }
              }
            }
            return false;
          };
          sortOrder = hasCompare ? function(a, b) {
            if (a === b) {
              hasDuplicate = true;
              return 0;
            }
            var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
            if (compare) {
              return compare;
            }
            compare = (a.ownerDocument || a) === (b.ownerDocument || b) ? a.compareDocumentPosition(b) : 1;
            if (compare & 1 || (!support.sortDetached && b.compareDocumentPosition(a) === compare)) {
              if (a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a)) {
                return -1;
              }
              if (b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b)) {
                return 1;
              }
              return sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
            }
            return compare & 4 ? -1 : 1;
          } : function(a, b) {
            if (a === b) {
              hasDuplicate = true;
              return 0;
            }
            var cur,
                i = 0,
                aup = a.parentNode,
                bup = b.parentNode,
                ap = [a],
                bp = [b];
            if (!aup || !bup) {
              return a === doc ? -1 : b === doc ? 1 : aup ? -1 : bup ? 1 : sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
            } else if (aup === bup) {
              return siblingCheck(a, b);
            }
            cur = a;
            while ((cur = cur.parentNode)) {
              ap.unshift(cur);
            }
            cur = b;
            while ((cur = cur.parentNode)) {
              bp.unshift(cur);
            }
            while (ap[i] === bp[i]) {
              i++;
            }
            return i ? siblingCheck(ap[i], bp[i]) : ap[i] === preferredDoc ? -1 : bp[i] === preferredDoc ? 1 : 0;
          };
          return doc;
        };
        Sizzle.matches = function(expr, elements) {
          return Sizzle(expr, null, null, elements);
        };
        Sizzle.matchesSelector = function(elem, expr) {
          if ((elem.ownerDocument || elem) !== document) {
            setDocument(elem);
          }
          expr = expr.replace(rattributeQuotes, "='$1']");
          if (support.matchesSelector && documentIsHTML && (!rbuggyMatches || !rbuggyMatches.test(expr)) && (!rbuggyQSA || !rbuggyQSA.test(expr))) {
            try {
              var ret = matches.call(elem, expr);
              if (ret || support.disconnectedMatch || elem.document && elem.document.nodeType !== 11) {
                return ret;
              }
            } catch (e) {}
          }
          return Sizzle(expr, document, null, [elem]).length > 0;
        };
        Sizzle.contains = function(context, elem) {
          if ((context.ownerDocument || context) !== document) {
            setDocument(context);
          }
          return contains(context, elem);
        };
        Sizzle.attr = function(elem, name) {
          if ((elem.ownerDocument || elem) !== document) {
            setDocument(elem);
          }
          var fn = Expr.attrHandle[name.toLowerCase()],
              val = fn && hasOwn.call(Expr.attrHandle, name.toLowerCase()) ? fn(elem, name, !documentIsHTML) : undefined;
          return val !== undefined ? val : support.attributes || !documentIsHTML ? elem.getAttribute(name) : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
        };
        Sizzle.error = function(msg) {
          throw new Error("Syntax error, unrecognized expression: " + msg);
        };
        Sizzle.uniqueSort = function(results) {
          var elem,
              duplicates = [],
              j = 0,
              i = 0;
          hasDuplicate = !support.detectDuplicates;
          sortInput = !support.sortStable && results.slice(0);
          results.sort(sortOrder);
          if (hasDuplicate) {
            while ((elem = results[i++])) {
              if (elem === results[i]) {
                j = duplicates.push(i);
              }
            }
            while (j--) {
              results.splice(duplicates[j], 1);
            }
          }
          sortInput = null;
          return results;
        };
        getText = Sizzle.getText = function(elem) {
          var node,
              ret = "",
              i = 0,
              nodeType = elem.nodeType;
          if (!nodeType) {
            while ((node = elem[i++])) {
              ret += getText(node);
            }
          } else if (nodeType === 1 || nodeType === 9 || nodeType === 11) {
            if (typeof elem.textContent === "string") {
              return elem.textContent;
            } else {
              for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
                ret += getText(elem);
              }
            }
          } else if (nodeType === 3 || nodeType === 4) {
            return elem.nodeValue;
          }
          return ret;
        };
        Expr = Sizzle.selectors = {
          cacheLength: 50,
          createPseudo: markFunction,
          match: matchExpr,
          attrHandle: {},
          find: {},
          relative: {
            ">": {
              dir: "parentNode",
              first: true
            },
            " ": {dir: "parentNode"},
            "+": {
              dir: "previousSibling",
              first: true
            },
            "~": {dir: "previousSibling"}
          },
          preFilter: {
            "ATTR": function(match) {
              match[1] = match[1].replace(runescape, funescape);
              match[3] = (match[3] || match[4] || match[5] || "").replace(runescape, funescape);
              if (match[2] === "~=") {
                match[3] = " " + match[3] + " ";
              }
              return match.slice(0, 4);
            },
            "CHILD": function(match) {
              match[1] = match[1].toLowerCase();
              if (match[1].slice(0, 3) === "nth") {
                if (!match[3]) {
                  Sizzle.error(match[0]);
                }
                match[4] = +(match[4] ? match[5] + (match[6] || 1) : 2 * (match[3] === "even" || match[3] === "odd"));
                match[5] = +((match[7] + match[8]) || match[3] === "odd");
              } else if (match[3]) {
                Sizzle.error(match[0]);
              }
              return match;
            },
            "PSEUDO": function(match) {
              var excess,
                  unquoted = !match[6] && match[2];
              if (matchExpr["CHILD"].test(match[0])) {
                return null;
              }
              if (match[3]) {
                match[2] = match[4] || match[5] || "";
              } else if (unquoted && rpseudo.test(unquoted) && (excess = tokenize(unquoted, true)) && (excess = unquoted.indexOf(")", unquoted.length - excess) - unquoted.length)) {
                match[0] = match[0].slice(0, excess);
                match[2] = unquoted.slice(0, excess);
              }
              return match.slice(0, 3);
            }
          },
          filter: {
            "TAG": function(nodeNameSelector) {
              var nodeName = nodeNameSelector.replace(runescape, funescape).toLowerCase();
              return nodeNameSelector === "*" ? function() {
                return true;
              } : function(elem) {
                return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
              };
            },
            "CLASS": function(className) {
              var pattern = classCache[className + " "];
              return pattern || (pattern = new RegExp("(^|" + whitespace + ")" + className + "(" + whitespace + "|$)")) && classCache(className, function(elem) {
                return pattern.test(typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== "undefined" && elem.getAttribute("class") || "");
              });
            },
            "ATTR": function(name, operator, check) {
              return function(elem) {
                var result = Sizzle.attr(elem, name);
                if (result == null) {
                  return operator === "!=";
                }
                if (!operator) {
                  return true;
                }
                result += "";
                return operator === "=" ? result === check : operator === "!=" ? result !== check : operator === "^=" ? check && result.indexOf(check) === 0 : operator === "*=" ? check && result.indexOf(check) > -1 : operator === "$=" ? check && result.slice(-check.length) === check : operator === "~=" ? (" " + result.replace(rwhitespace, " ") + " ").indexOf(check) > -1 : operator === "|=" ? result === check || result.slice(0, check.length + 1) === check + "-" : false;
              };
            },
            "CHILD": function(type, what, argument, first, last) {
              var simple = type.slice(0, 3) !== "nth",
                  forward = type.slice(-4) !== "last",
                  ofType = what === "of-type";
              return first === 1 && last === 0 ? function(elem) {
                return !!elem.parentNode;
              } : function(elem, context, xml) {
                var cache,
                    outerCache,
                    node,
                    diff,
                    nodeIndex,
                    start,
                    dir = simple !== forward ? "nextSibling" : "previousSibling",
                    parent = elem.parentNode,
                    name = ofType && elem.nodeName.toLowerCase(),
                    useCache = !xml && !ofType;
                if (parent) {
                  if (simple) {
                    while (dir) {
                      node = elem;
                      while ((node = node[dir])) {
                        if (ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) {
                          return false;
                        }
                      }
                      start = dir = type === "only" && !start && "nextSibling";
                    }
                    return true;
                  }
                  start = [forward ? parent.firstChild : parent.lastChild];
                  if (forward && useCache) {
                    outerCache = parent[expando] || (parent[expando] = {});
                    cache = outerCache[type] || [];
                    nodeIndex = cache[0] === dirruns && cache[1];
                    diff = cache[0] === dirruns && cache[2];
                    node = nodeIndex && parent.childNodes[nodeIndex];
                    while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                      if (node.nodeType === 1 && ++diff && node === elem) {
                        outerCache[type] = [dirruns, nodeIndex, diff];
                        break;
                      }
                    }
                  } else if (useCache && (cache = (elem[expando] || (elem[expando] = {}))[type]) && cache[0] === dirruns) {
                    diff = cache[1];
                  } else {
                    while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                      if ((ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) && ++diff) {
                        if (useCache) {
                          (node[expando] || (node[expando] = {}))[type] = [dirruns, diff];
                        }
                        if (node === elem) {
                          break;
                        }
                      }
                    }
                  }
                  diff -= last;
                  return diff === first || (diff % first === 0 && diff / first >= 0);
                }
              };
            },
            "PSEUDO": function(pseudo, argument) {
              var args,
                  fn = Expr.pseudos[pseudo] || Expr.setFilters[pseudo.toLowerCase()] || Sizzle.error("unsupported pseudo: " + pseudo);
              if (fn[expando]) {
                return fn(argument);
              }
              if (fn.length > 1) {
                args = [pseudo, pseudo, "", argument];
                return Expr.setFilters.hasOwnProperty(pseudo.toLowerCase()) ? markFunction(function(seed, matches) {
                  var idx,
                      matched = fn(seed, argument),
                      i = matched.length;
                  while (i--) {
                    idx = indexOf(seed, matched[i]);
                    seed[idx] = !(matches[idx] = matched[i]);
                  }
                }) : function(elem) {
                  return fn(elem, 0, args);
                };
              }
              return fn;
            }
          },
          pseudos: {
            "not": markFunction(function(selector) {
              var input = [],
                  results = [],
                  matcher = compile(selector.replace(rtrim, "$1"));
              return matcher[expando] ? markFunction(function(seed, matches, context, xml) {
                var elem,
                    unmatched = matcher(seed, null, xml, []),
                    i = seed.length;
                while (i--) {
                  if ((elem = unmatched[i])) {
                    seed[i] = !(matches[i] = elem);
                  }
                }
              }) : function(elem, context, xml) {
                input[0] = elem;
                matcher(input, null, xml, results);
                input[0] = null;
                return !results.pop();
              };
            }),
            "has": markFunction(function(selector) {
              return function(elem) {
                return Sizzle(selector, elem).length > 0;
              };
            }),
            "contains": markFunction(function(text) {
              text = text.replace(runescape, funescape);
              return function(elem) {
                return (elem.textContent || elem.innerText || getText(elem)).indexOf(text) > -1;
              };
            }),
            "lang": markFunction(function(lang) {
              if (!ridentifier.test(lang || "")) {
                Sizzle.error("unsupported lang: " + lang);
              }
              lang = lang.replace(runescape, funescape).toLowerCase();
              return function(elem) {
                var elemLang;
                do {
                  if ((elemLang = documentIsHTML ? elem.lang : elem.getAttribute("xml:lang") || elem.getAttribute("lang"))) {
                    elemLang = elemLang.toLowerCase();
                    return elemLang === lang || elemLang.indexOf(lang + "-") === 0;
                  }
                } while ((elem = elem.parentNode) && elem.nodeType === 1);
                return false;
              };
            }),
            "target": function(elem) {
              var hash = window.location && window.location.hash;
              return hash && hash.slice(1) === elem.id;
            },
            "root": function(elem) {
              return elem === docElem;
            },
            "focus": function(elem) {
              return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
            },
            "enabled": function(elem) {
              return elem.disabled === false;
            },
            "disabled": function(elem) {
              return elem.disabled === true;
            },
            "checked": function(elem) {
              var nodeName = elem.nodeName.toLowerCase();
              return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
            },
            "selected": function(elem) {
              if (elem.parentNode) {
                elem.parentNode.selectedIndex;
              }
              return elem.selected === true;
            },
            "empty": function(elem) {
              for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
                if (elem.nodeType < 6) {
                  return false;
                }
              }
              return true;
            },
            "parent": function(elem) {
              return !Expr.pseudos["empty"](elem);
            },
            "header": function(elem) {
              return rheader.test(elem.nodeName);
            },
            "input": function(elem) {
              return rinputs.test(elem.nodeName);
            },
            "button": function(elem) {
              var name = elem.nodeName.toLowerCase();
              return name === "input" && elem.type === "button" || name === "button";
            },
            "text": function(elem) {
              var attr;
              return elem.nodeName.toLowerCase() === "input" && elem.type === "text" && ((attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text");
            },
            "first": createPositionalPseudo(function() {
              return [0];
            }),
            "last": createPositionalPseudo(function(matchIndexes, length) {
              return [length - 1];
            }),
            "eq": createPositionalPseudo(function(matchIndexes, length, argument) {
              return [argument < 0 ? argument + length : argument];
            }),
            "even": createPositionalPseudo(function(matchIndexes, length) {
              var i = 0;
              for (; i < length; i += 2) {
                matchIndexes.push(i);
              }
              return matchIndexes;
            }),
            "odd": createPositionalPseudo(function(matchIndexes, length) {
              var i = 1;
              for (; i < length; i += 2) {
                matchIndexes.push(i);
              }
              return matchIndexes;
            }),
            "lt": createPositionalPseudo(function(matchIndexes, length, argument) {
              var i = argument < 0 ? argument + length : argument;
              for (; --i >= 0; ) {
                matchIndexes.push(i);
              }
              return matchIndexes;
            }),
            "gt": createPositionalPseudo(function(matchIndexes, length, argument) {
              var i = argument < 0 ? argument + length : argument;
              for (; ++i < length; ) {
                matchIndexes.push(i);
              }
              return matchIndexes;
            })
          }
        };
        Expr.pseudos["nth"] = Expr.pseudos["eq"];
        for (i in {
          radio: true,
          checkbox: true,
          file: true,
          password: true,
          image: true
        }) {
          Expr.pseudos[i] = createInputPseudo(i);
        }
        for (i in {
          submit: true,
          reset: true
        }) {
          Expr.pseudos[i] = createButtonPseudo(i);
        }
        function setFilters() {}
        setFilters.prototype = Expr.filters = Expr.pseudos;
        Expr.setFilters = new setFilters();
        tokenize = Sizzle.tokenize = function(selector, parseOnly) {
          var matched,
              match,
              tokens,
              type,
              soFar,
              groups,
              preFilters,
              cached = tokenCache[selector + " "];
          if (cached) {
            return parseOnly ? 0 : cached.slice(0);
          }
          soFar = selector;
          groups = [];
          preFilters = Expr.preFilter;
          while (soFar) {
            if (!matched || (match = rcomma.exec(soFar))) {
              if (match) {
                soFar = soFar.slice(match[0].length) || soFar;
              }
              groups.push((tokens = []));
            }
            matched = false;
            if ((match = rcombinators.exec(soFar))) {
              matched = match.shift();
              tokens.push({
                value: matched,
                type: match[0].replace(rtrim, " ")
              });
              soFar = soFar.slice(matched.length);
            }
            for (type in Expr.filter) {
              if ((match = matchExpr[type].exec(soFar)) && (!preFilters[type] || (match = preFilters[type](match)))) {
                matched = match.shift();
                tokens.push({
                  value: matched,
                  type: type,
                  matches: match
                });
                soFar = soFar.slice(matched.length);
              }
            }
            if (!matched) {
              break;
            }
          }
          return parseOnly ? soFar.length : soFar ? Sizzle.error(selector) : tokenCache(selector, groups).slice(0);
        };
        function toSelector(tokens) {
          var i = 0,
              len = tokens.length,
              selector = "";
          for (; i < len; i++) {
            selector += tokens[i].value;
          }
          return selector;
        }
        function addCombinator(matcher, combinator, base) {
          var dir = combinator.dir,
              checkNonElements = base && dir === "parentNode",
              doneName = done++;
          return combinator.first ? function(elem, context, xml) {
            while ((elem = elem[dir])) {
              if (elem.nodeType === 1 || checkNonElements) {
                return matcher(elem, context, xml);
              }
            }
          } : function(elem, context, xml) {
            var oldCache,
                outerCache,
                newCache = [dirruns, doneName];
            if (xml) {
              while ((elem = elem[dir])) {
                if (elem.nodeType === 1 || checkNonElements) {
                  if (matcher(elem, context, xml)) {
                    return true;
                  }
                }
              }
            } else {
              while ((elem = elem[dir])) {
                if (elem.nodeType === 1 || checkNonElements) {
                  outerCache = elem[expando] || (elem[expando] = {});
                  if ((oldCache = outerCache[dir]) && oldCache[0] === dirruns && oldCache[1] === doneName) {
                    return (newCache[2] = oldCache[2]);
                  } else {
                    outerCache[dir] = newCache;
                    if ((newCache[2] = matcher(elem, context, xml))) {
                      return true;
                    }
                  }
                }
              }
            }
          };
        }
        function elementMatcher(matchers) {
          return matchers.length > 1 ? function(elem, context, xml) {
            var i = matchers.length;
            while (i--) {
              if (!matchers[i](elem, context, xml)) {
                return false;
              }
            }
            return true;
          } : matchers[0];
        }
        function multipleContexts(selector, contexts, results) {
          var i = 0,
              len = contexts.length;
          for (; i < len; i++) {
            Sizzle(selector, contexts[i], results);
          }
          return results;
        }
        function condense(unmatched, map, filter, context, xml) {
          var elem,
              newUnmatched = [],
              i = 0,
              len = unmatched.length,
              mapped = map != null;
          for (; i < len; i++) {
            if ((elem = unmatched[i])) {
              if (!filter || filter(elem, context, xml)) {
                newUnmatched.push(elem);
                if (mapped) {
                  map.push(i);
                }
              }
            }
          }
          return newUnmatched;
        }
        function setMatcher(preFilter, selector, matcher, postFilter, postFinder, postSelector) {
          if (postFilter && !postFilter[expando]) {
            postFilter = setMatcher(postFilter);
          }
          if (postFinder && !postFinder[expando]) {
            postFinder = setMatcher(postFinder, postSelector);
          }
          return markFunction(function(seed, results, context, xml) {
            var temp,
                i,
                elem,
                preMap = [],
                postMap = [],
                preexisting = results.length,
                elems = seed || multipleContexts(selector || "*", context.nodeType ? [context] : context, []),
                matcherIn = preFilter && (seed || !selector) ? condense(elems, preMap, preFilter, context, xml) : elems,
                matcherOut = matcher ? postFinder || (seed ? preFilter : preexisting || postFilter) ? [] : results : matcherIn;
            if (matcher) {
              matcher(matcherIn, matcherOut, context, xml);
            }
            if (postFilter) {
              temp = condense(matcherOut, postMap);
              postFilter(temp, [], context, xml);
              i = temp.length;
              while (i--) {
                if ((elem = temp[i])) {
                  matcherOut[postMap[i]] = !(matcherIn[postMap[i]] = elem);
                }
              }
            }
            if (seed) {
              if (postFinder || preFilter) {
                if (postFinder) {
                  temp = [];
                  i = matcherOut.length;
                  while (i--) {
                    if ((elem = matcherOut[i])) {
                      temp.push((matcherIn[i] = elem));
                    }
                  }
                  postFinder(null, (matcherOut = []), temp, xml);
                }
                i = matcherOut.length;
                while (i--) {
                  if ((elem = matcherOut[i]) && (temp = postFinder ? indexOf(seed, elem) : preMap[i]) > -1) {
                    seed[temp] = !(results[temp] = elem);
                  }
                }
              }
            } else {
              matcherOut = condense(matcherOut === results ? matcherOut.splice(preexisting, matcherOut.length) : matcherOut);
              if (postFinder) {
                postFinder(null, results, matcherOut, xml);
              } else {
                push.apply(results, matcherOut);
              }
            }
          });
        }
        function matcherFromTokens(tokens) {
          var checkContext,
              matcher,
              j,
              len = tokens.length,
              leadingRelative = Expr.relative[tokens[0].type],
              implicitRelative = leadingRelative || Expr.relative[" "],
              i = leadingRelative ? 1 : 0,
              matchContext = addCombinator(function(elem) {
                return elem === checkContext;
              }, implicitRelative, true),
              matchAnyContext = addCombinator(function(elem) {
                return indexOf(checkContext, elem) > -1;
              }, implicitRelative, true),
              matchers = [function(elem, context, xml) {
                var ret = (!leadingRelative && (xml || context !== outermostContext)) || ((checkContext = context).nodeType ? matchContext(elem, context, xml) : matchAnyContext(elem, context, xml));
                checkContext = null;
                return ret;
              }];
          for (; i < len; i++) {
            if ((matcher = Expr.relative[tokens[i].type])) {
              matchers = [addCombinator(elementMatcher(matchers), matcher)];
            } else {
              matcher = Expr.filter[tokens[i].type].apply(null, tokens[i].matches);
              if (matcher[expando]) {
                j = ++i;
                for (; j < len; j++) {
                  if (Expr.relative[tokens[j].type]) {
                    break;
                  }
                }
                return setMatcher(i > 1 && elementMatcher(matchers), i > 1 && toSelector(tokens.slice(0, i - 1).concat({value: tokens[i - 2].type === " " ? "*" : ""})).replace(rtrim, "$1"), matcher, i < j && matcherFromTokens(tokens.slice(i, j)), j < len && matcherFromTokens((tokens = tokens.slice(j))), j < len && toSelector(tokens));
              }
              matchers.push(matcher);
            }
          }
          return elementMatcher(matchers);
        }
        function matcherFromGroupMatchers(elementMatchers, setMatchers) {
          var bySet = setMatchers.length > 0,
              byElement = elementMatchers.length > 0,
              superMatcher = function(seed, context, xml, results, outermost) {
                var elem,
                    j,
                    matcher,
                    matchedCount = 0,
                    i = "0",
                    unmatched = seed && [],
                    setMatched = [],
                    contextBackup = outermostContext,
                    elems = seed || byElement && Expr.find["TAG"]("*", outermost),
                    dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
                    len = elems.length;
                if (outermost) {
                  outermostContext = context !== document && context;
                }
                for (; i !== len && (elem = elems[i]) != null; i++) {
                  if (byElement && elem) {
                    j = 0;
                    while ((matcher = elementMatchers[j++])) {
                      if (matcher(elem, context, xml)) {
                        results.push(elem);
                        break;
                      }
                    }
                    if (outermost) {
                      dirruns = dirrunsUnique;
                    }
                  }
                  if (bySet) {
                    if ((elem = !matcher && elem)) {
                      matchedCount--;
                    }
                    if (seed) {
                      unmatched.push(elem);
                    }
                  }
                }
                matchedCount += i;
                if (bySet && i !== matchedCount) {
                  j = 0;
                  while ((matcher = setMatchers[j++])) {
                    matcher(unmatched, setMatched, context, xml);
                  }
                  if (seed) {
                    if (matchedCount > 0) {
                      while (i--) {
                        if (!(unmatched[i] || setMatched[i])) {
                          setMatched[i] = pop.call(results);
                        }
                      }
                    }
                    setMatched = condense(setMatched);
                  }
                  push.apply(results, setMatched);
                  if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) {
                    Sizzle.uniqueSort(results);
                  }
                }
                if (outermost) {
                  dirruns = dirrunsUnique;
                  outermostContext = contextBackup;
                }
                return unmatched;
              };
          return bySet ? markFunction(superMatcher) : superMatcher;
        }
        compile = Sizzle.compile = function(selector, match) {
          var i,
              setMatchers = [],
              elementMatchers = [],
              cached = compilerCache[selector + " "];
          if (!cached) {
            if (!match) {
              match = tokenize(selector);
            }
            i = match.length;
            while (i--) {
              cached = matcherFromTokens(match[i]);
              if (cached[expando]) {
                setMatchers.push(cached);
              } else {
                elementMatchers.push(cached);
              }
            }
            cached = compilerCache(selector, matcherFromGroupMatchers(elementMatchers, setMatchers));
            cached.selector = selector;
          }
          return cached;
        };
        select = Sizzle.select = function(selector, context, results, seed) {
          var i,
              tokens,
              token,
              type,
              find,
              compiled = typeof selector === "function" && selector,
              match = !seed && tokenize((selector = compiled.selector || selector));
          results = results || [];
          if (match.length === 1) {
            tokens = match[0] = match[0].slice(0);
            if (tokens.length > 2 && (token = tokens[0]).type === "ID" && support.getById && context.nodeType === 9 && documentIsHTML && Expr.relative[tokens[1].type]) {
              context = (Expr.find["ID"](token.matches[0].replace(runescape, funescape), context) || [])[0];
              if (!context) {
                return results;
              } else if (compiled) {
                context = context.parentNode;
              }
              selector = selector.slice(tokens.shift().value.length);
            }
            i = matchExpr["needsContext"].test(selector) ? 0 : tokens.length;
            while (i--) {
              token = tokens[i];
              if (Expr.relative[(type = token.type)]) {
                break;
              }
              if ((find = Expr.find[type])) {
                if ((seed = find(token.matches[0].replace(runescape, funescape), rsibling.test(tokens[0].type) && testContext(context.parentNode) || context))) {
                  tokens.splice(i, 1);
                  selector = seed.length && toSelector(tokens);
                  if (!selector) {
                    push.apply(results, seed);
                    return results;
                  }
                  break;
                }
              }
            }
          }
          (compiled || compile(selector, match))(seed, context, !documentIsHTML, results, rsibling.test(selector) && testContext(context.parentNode) || context);
          return results;
        };
        support.sortStable = expando.split("").sort(sortOrder).join("") === expando;
        support.detectDuplicates = !!hasDuplicate;
        setDocument();
        support.sortDetached = assert(function(div1) {
          return div1.compareDocumentPosition(document.createElement("div")) & 1;
        });
        if (!assert(function(div) {
          div.innerHTML = "<a href='#'></a>";
          return div.firstChild.getAttribute("href") === "#";
        })) {
          addHandle("type|href|height|width", function(elem, name, isXML) {
            if (!isXML) {
              return elem.getAttribute(name, name.toLowerCase() === "type" ? 1 : 2);
            }
          });
        }
        if (!support.attributes || !assert(function(div) {
          div.innerHTML = "<input/>";
          div.firstChild.setAttribute("value", "");
          return div.firstChild.getAttribute("value") === "";
        })) {
          addHandle("value", function(elem, name, isXML) {
            if (!isXML && elem.nodeName.toLowerCase() === "input") {
              return elem.defaultValue;
            }
          });
        }
        if (!assert(function(div) {
          return div.getAttribute("disabled") == null;
        })) {
          addHandle(booleans, function(elem, name, isXML) {
            var val;
            if (!isXML) {
              return elem[name] === true ? name.toLowerCase() : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
            }
          });
        }
        return Sizzle;
      })(window);
      jQuery.find = Sizzle;
      jQuery.expr = Sizzle.selectors;
      jQuery.expr[":"] = jQuery.expr.pseudos;
      jQuery.unique = Sizzle.uniqueSort;
      jQuery.text = Sizzle.getText;
      jQuery.isXMLDoc = Sizzle.isXML;
      jQuery.contains = Sizzle.contains;
      var rneedsContext = jQuery.expr.match.needsContext;
      var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);
      var risSimple = /^.[^:#\[\.,]*$/;
      function winnow(elements, qualifier, not) {
        if (jQuery.isFunction(qualifier)) {
          return jQuery.grep(elements, function(elem, i) {
            return !!qualifier.call(elem, i, elem) !== not;
          });
        }
        if (qualifier.nodeType) {
          return jQuery.grep(elements, function(elem) {
            return (elem === qualifier) !== not;
          });
        }
        if (typeof qualifier === "string") {
          if (risSimple.test(qualifier)) {
            return jQuery.filter(qualifier, elements, not);
          }
          qualifier = jQuery.filter(qualifier, elements);
        }
        return jQuery.grep(elements, function(elem) {
          return (indexOf.call(qualifier, elem) >= 0) !== not;
        });
      }
      jQuery.filter = function(expr, elems, not) {
        var elem = elems[0];
        if (not) {
          expr = ":not(" + expr + ")";
        }
        return elems.length === 1 && elem.nodeType === 1 ? jQuery.find.matchesSelector(elem, expr) ? [elem] : [] : jQuery.find.matches(expr, jQuery.grep(elems, function(elem) {
          return elem.nodeType === 1;
        }));
      };
      jQuery.fn.extend({
        find: function(selector) {
          var i,
              len = this.length,
              ret = [],
              self = this;
          if (typeof selector !== "string") {
            return this.pushStack(jQuery(selector).filter(function() {
              for (i = 0; i < len; i++) {
                if (jQuery.contains(self[i], this)) {
                  return true;
                }
              }
            }));
          }
          for (i = 0; i < len; i++) {
            jQuery.find(selector, self[i], ret);
          }
          ret = this.pushStack(len > 1 ? jQuery.unique(ret) : ret);
          ret.selector = this.selector ? this.selector + " " + selector : selector;
          return ret;
        },
        filter: function(selector) {
          return this.pushStack(winnow(this, selector || [], false));
        },
        not: function(selector) {
          return this.pushStack(winnow(this, selector || [], true));
        },
        is: function(selector) {
          return !!winnow(this, typeof selector === "string" && rneedsContext.test(selector) ? jQuery(selector) : selector || [], false).length;
        }
      });
      var rootjQuery,
          rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,
          init = jQuery.fn.init = function(selector, context) {
            var match,
                elem;
            if (!selector) {
              return this;
            }
            if (typeof selector === "string") {
              if (selector[0] === "<" && selector[selector.length - 1] === ">" && selector.length >= 3) {
                match = [null, selector, null];
              } else {
                match = rquickExpr.exec(selector);
              }
              if (match && (match[1] || !context)) {
                if (match[1]) {
                  context = context instanceof jQuery ? context[0] : context;
                  jQuery.merge(this, jQuery.parseHTML(match[1], context && context.nodeType ? context.ownerDocument || context : document, true));
                  if (rsingleTag.test(match[1]) && jQuery.isPlainObject(context)) {
                    for (match in context) {
                      if (jQuery.isFunction(this[match])) {
                        this[match](context[match]);
                      } else {
                        this.attr(match, context[match]);
                      }
                    }
                  }
                  return this;
                } else {
                  elem = document.getElementById(match[2]);
                  if (elem && elem.parentNode) {
                    this.length = 1;
                    this[0] = elem;
                  }
                  this.context = document;
                  this.selector = selector;
                  return this;
                }
              } else if (!context || context.jquery) {
                return (context || rootjQuery).find(selector);
              } else {
                return this.constructor(context).find(selector);
              }
            } else if (selector.nodeType) {
              this.context = this[0] = selector;
              this.length = 1;
              return this;
            } else if (jQuery.isFunction(selector)) {
              return typeof rootjQuery.ready !== "undefined" ? rootjQuery.ready(selector) : selector(jQuery);
            }
            if (selector.selector !== undefined) {
              this.selector = selector.selector;
              this.context = selector.context;
            }
            return jQuery.makeArray(selector, this);
          };
      init.prototype = jQuery.fn;
      rootjQuery = jQuery(document);
      var rparentsprev = /^(?:parents|prev(?:Until|All))/,
          guaranteedUnique = {
            children: true,
            contents: true,
            next: true,
            prev: true
          };
      jQuery.extend({
        dir: function(elem, dir, until) {
          var matched = [],
              truncate = until !== undefined;
          while ((elem = elem[dir]) && elem.nodeType !== 9) {
            if (elem.nodeType === 1) {
              if (truncate && jQuery(elem).is(until)) {
                break;
              }
              matched.push(elem);
            }
          }
          return matched;
        },
        sibling: function(n, elem) {
          var matched = [];
          for (; n; n = n.nextSibling) {
            if (n.nodeType === 1 && n !== elem) {
              matched.push(n);
            }
          }
          return matched;
        }
      });
      jQuery.fn.extend({
        has: function(target) {
          var targets = jQuery(target, this),
              l = targets.length;
          return this.filter(function() {
            var i = 0;
            for (; i < l; i++) {
              if (jQuery.contains(this, targets[i])) {
                return true;
              }
            }
          });
        },
        closest: function(selectors, context) {
          var cur,
              i = 0,
              l = this.length,
              matched = [],
              pos = rneedsContext.test(selectors) || typeof selectors !== "string" ? jQuery(selectors, context || this.context) : 0;
          for (; i < l; i++) {
            for (cur = this[i]; cur && cur !== context; cur = cur.parentNode) {
              if (cur.nodeType < 11 && (pos ? pos.index(cur) > -1 : cur.nodeType === 1 && jQuery.find.matchesSelector(cur, selectors))) {
                matched.push(cur);
                break;
              }
            }
          }
          return this.pushStack(matched.length > 1 ? jQuery.unique(matched) : matched);
        },
        index: function(elem) {
          if (!elem) {
            return (this[0] && this[0].parentNode) ? this.first().prevAll().length : -1;
          }
          if (typeof elem === "string") {
            return indexOf.call(jQuery(elem), this[0]);
          }
          return indexOf.call(this, elem.jquery ? elem[0] : elem);
        },
        add: function(selector, context) {
          return this.pushStack(jQuery.unique(jQuery.merge(this.get(), jQuery(selector, context))));
        },
        addBack: function(selector) {
          return this.add(selector == null ? this.prevObject : this.prevObject.filter(selector));
        }
      });
      function sibling(cur, dir) {
        while ((cur = cur[dir]) && cur.nodeType !== 1) {}
        return cur;
      }
      jQuery.each({
        parent: function(elem) {
          var parent = elem.parentNode;
          return parent && parent.nodeType !== 11 ? parent : null;
        },
        parents: function(elem) {
          return jQuery.dir(elem, "parentNode");
        },
        parentsUntil: function(elem, i, until) {
          return jQuery.dir(elem, "parentNode", until);
        },
        next: function(elem) {
          return sibling(elem, "nextSibling");
        },
        prev: function(elem) {
          return sibling(elem, "previousSibling");
        },
        nextAll: function(elem) {
          return jQuery.dir(elem, "nextSibling");
        },
        prevAll: function(elem) {
          return jQuery.dir(elem, "previousSibling");
        },
        nextUntil: function(elem, i, until) {
          return jQuery.dir(elem, "nextSibling", until);
        },
        prevUntil: function(elem, i, until) {
          return jQuery.dir(elem, "previousSibling", until);
        },
        siblings: function(elem) {
          return jQuery.sibling((elem.parentNode || {}).firstChild, elem);
        },
        children: function(elem) {
          return jQuery.sibling(elem.firstChild);
        },
        contents: function(elem) {
          return elem.contentDocument || jQuery.merge([], elem.childNodes);
        }
      }, function(name, fn) {
        jQuery.fn[name] = function(until, selector) {
          var matched = jQuery.map(this, fn, until);
          if (name.slice(-5) !== "Until") {
            selector = until;
          }
          if (selector && typeof selector === "string") {
            matched = jQuery.filter(selector, matched);
          }
          if (this.length > 1) {
            if (!guaranteedUnique[name]) {
              jQuery.unique(matched);
            }
            if (rparentsprev.test(name)) {
              matched.reverse();
            }
          }
          return this.pushStack(matched);
        };
      });
      var rnotwhite = (/\S+/g);
      var optionsCache = {};
      function createOptions(options) {
        var object = optionsCache[options] = {};
        jQuery.each(options.match(rnotwhite) || [], function(_, flag) {
          object[flag] = true;
        });
        return object;
      }
      jQuery.Callbacks = function(options) {
        options = typeof options === "string" ? (optionsCache[options] || createOptions(options)) : jQuery.extend({}, options);
        var memory,
            fired,
            firing,
            firingStart,
            firingLength,
            firingIndex,
            list = [],
            stack = !options.once && [],
            fire = function(data) {
              memory = options.memory && data;
              fired = true;
              firingIndex = firingStart || 0;
              firingStart = 0;
              firingLength = list.length;
              firing = true;
              for (; list && firingIndex < firingLength; firingIndex++) {
                if (list[firingIndex].apply(data[0], data[1]) === false && options.stopOnFalse) {
                  memory = false;
                  break;
                }
              }
              firing = false;
              if (list) {
                if (stack) {
                  if (stack.length) {
                    fire(stack.shift());
                  }
                } else if (memory) {
                  list = [];
                } else {
                  self.disable();
                }
              }
            },
            self = {
              add: function() {
                if (list) {
                  var start = list.length;
                  (function add(args) {
                    jQuery.each(args, function(_, arg) {
                      var type = jQuery.type(arg);
                      if (type === "function") {
                        if (!options.unique || !self.has(arg)) {
                          list.push(arg);
                        }
                      } else if (arg && arg.length && type !== "string") {
                        add(arg);
                      }
                    });
                  })(arguments);
                  if (firing) {
                    firingLength = list.length;
                  } else if (memory) {
                    firingStart = start;
                    fire(memory);
                  }
                }
                return this;
              },
              remove: function() {
                if (list) {
                  jQuery.each(arguments, function(_, arg) {
                    var index;
                    while ((index = jQuery.inArray(arg, list, index)) > -1) {
                      list.splice(index, 1);
                      if (firing) {
                        if (index <= firingLength) {
                          firingLength--;
                        }
                        if (index <= firingIndex) {
                          firingIndex--;
                        }
                      }
                    }
                  });
                }
                return this;
              },
              has: function(fn) {
                return fn ? jQuery.inArray(fn, list) > -1 : !!(list && list.length);
              },
              empty: function() {
                list = [];
                firingLength = 0;
                return this;
              },
              disable: function() {
                list = stack = memory = undefined;
                return this;
              },
              disabled: function() {
                return !list;
              },
              lock: function() {
                stack = undefined;
                if (!memory) {
                  self.disable();
                }
                return this;
              },
              locked: function() {
                return !stack;
              },
              fireWith: function(context, args) {
                if (list && (!fired || stack)) {
                  args = args || [];
                  args = [context, args.slice ? args.slice() : args];
                  if (firing) {
                    stack.push(args);
                  } else {
                    fire(args);
                  }
                }
                return this;
              },
              fire: function() {
                self.fireWith(this, arguments);
                return this;
              },
              fired: function() {
                return !!fired;
              }
            };
        return self;
      };
      jQuery.extend({
        Deferred: function(func) {
          var tuples = [["resolve", "done", jQuery.Callbacks("once memory"), "resolved"], ["reject", "fail", jQuery.Callbacks("once memory"), "rejected"], ["notify", "progress", jQuery.Callbacks("memory")]],
              state = "pending",
              promise = {
                state: function() {
                  return state;
                },
                always: function() {
                  deferred.done(arguments).fail(arguments);
                  return this;
                },
                then: function() {
                  var fns = arguments;
                  return jQuery.Deferred(function(newDefer) {
                    jQuery.each(tuples, function(i, tuple) {
                      var fn = jQuery.isFunction(fns[i]) && fns[i];
                      deferred[tuple[1]](function() {
                        var returned = fn && fn.apply(this, arguments);
                        if (returned && jQuery.isFunction(returned.promise)) {
                          returned.promise().done(newDefer.resolve).fail(newDefer.reject).progress(newDefer.notify);
                        } else {
                          newDefer[tuple[0] + "With"](this === promise ? newDefer.promise() : this, fn ? [returned] : arguments);
                        }
                      });
                    });
                    fns = null;
                  }).promise();
                },
                promise: function(obj) {
                  return obj != null ? jQuery.extend(obj, promise) : promise;
                }
              },
              deferred = {};
          promise.pipe = promise.then;
          jQuery.each(tuples, function(i, tuple) {
            var list = tuple[2],
                stateString = tuple[3];
            promise[tuple[1]] = list.add;
            if (stateString) {
              list.add(function() {
                state = stateString;
              }, tuples[i ^ 1][2].disable, tuples[2][2].lock);
            }
            deferred[tuple[0]] = function() {
              deferred[tuple[0] + "With"](this === deferred ? promise : this, arguments);
              return this;
            };
            deferred[tuple[0] + "With"] = list.fireWith;
          });
          promise.promise(deferred);
          if (func) {
            func.call(deferred, deferred);
          }
          return deferred;
        },
        when: function(subordinate) {
          var i = 0,
              resolveValues = slice.call(arguments),
              length = resolveValues.length,
              remaining = length !== 1 || (subordinate && jQuery.isFunction(subordinate.promise)) ? length : 0,
              deferred = remaining === 1 ? subordinate : jQuery.Deferred(),
              updateFunc = function(i, contexts, values) {
                return function(value) {
                  contexts[i] = this;
                  values[i] = arguments.length > 1 ? slice.call(arguments) : value;
                  if (values === progressValues) {
                    deferred.notifyWith(contexts, values);
                  } else if (!(--remaining)) {
                    deferred.resolveWith(contexts, values);
                  }
                };
              },
              progressValues,
              progressContexts,
              resolveContexts;
          if (length > 1) {
            progressValues = new Array(length);
            progressContexts = new Array(length);
            resolveContexts = new Array(length);
            for (; i < length; i++) {
              if (resolveValues[i] && jQuery.isFunction(resolveValues[i].promise)) {
                resolveValues[i].promise().done(updateFunc(i, resolveContexts, resolveValues)).fail(deferred.reject).progress(updateFunc(i, progressContexts, progressValues));
              } else {
                --remaining;
              }
            }
          }
          if (!remaining) {
            deferred.resolveWith(resolveContexts, resolveValues);
          }
          return deferred.promise();
        }
      });
      var readyList;
      jQuery.fn.ready = function(fn) {
        jQuery.ready.promise().done(fn);
        return this;
      };
      jQuery.extend({
        isReady: false,
        readyWait: 1,
        holdReady: function(hold) {
          if (hold) {
            jQuery.readyWait++;
          } else {
            jQuery.ready(true);
          }
        },
        ready: function(wait) {
          if (wait === true ? --jQuery.readyWait : jQuery.isReady) {
            return;
          }
          jQuery.isReady = true;
          if (wait !== true && --jQuery.readyWait > 0) {
            return;
          }
          readyList.resolveWith(document, [jQuery]);
          if (jQuery.fn.triggerHandler) {
            jQuery(document).triggerHandler("ready");
            jQuery(document).off("ready");
          }
        }
      });
      function completed() {
        document.removeEventListener("DOMContentLoaded", completed, false);
        window.removeEventListener("load", completed, false);
        jQuery.ready();
      }
      jQuery.ready.promise = function(obj) {
        if (!readyList) {
          readyList = jQuery.Deferred();
          if (document.readyState === "complete") {
            setTimeout(jQuery.ready);
          } else {
            document.addEventListener("DOMContentLoaded", completed, false);
            window.addEventListener("load", completed, false);
          }
        }
        return readyList.promise(obj);
      };
      jQuery.ready.promise();
      var access = jQuery.access = function(elems, fn, key, value, chainable, emptyGet, raw) {
        var i = 0,
            len = elems.length,
            bulk = key == null;
        if (jQuery.type(key) === "object") {
          chainable = true;
          for (i in key) {
            jQuery.access(elems, fn, i, key[i], true, emptyGet, raw);
          }
        } else if (value !== undefined) {
          chainable = true;
          if (!jQuery.isFunction(value)) {
            raw = true;
          }
          if (bulk) {
            if (raw) {
              fn.call(elems, value);
              fn = null;
            } else {
              bulk = fn;
              fn = function(elem, key, value) {
                return bulk.call(jQuery(elem), value);
              };
            }
          }
          if (fn) {
            for (; i < len; i++) {
              fn(elems[i], key, raw ? value : value.call(elems[i], i, fn(elems[i], key)));
            }
          }
        }
        return chainable ? elems : bulk ? fn.call(elems) : len ? fn(elems[0], key) : emptyGet;
      };
      jQuery.acceptData = function(owner) {
        return owner.nodeType === 1 || owner.nodeType === 9 || !(+owner.nodeType);
      };
      function Data() {
        Object.defineProperty(this.cache = {}, 0, {get: function() {
            return {};
          }});
        this.expando = jQuery.expando + Data.uid++;
      }
      Data.uid = 1;
      Data.accepts = jQuery.acceptData;
      Data.prototype = {
        key: function(owner) {
          if (!Data.accepts(owner)) {
            return 0;
          }
          var descriptor = {},
              unlock = owner[this.expando];
          if (!unlock) {
            unlock = Data.uid++;
            try {
              descriptor[this.expando] = {value: unlock};
              Object.defineProperties(owner, descriptor);
            } catch (e) {
              descriptor[this.expando] = unlock;
              jQuery.extend(owner, descriptor);
            }
          }
          if (!this.cache[unlock]) {
            this.cache[unlock] = {};
          }
          return unlock;
        },
        set: function(owner, data, value) {
          var prop,
              unlock = this.key(owner),
              cache = this.cache[unlock];
          if (typeof data === "string") {
            cache[data] = value;
          } else {
            if (jQuery.isEmptyObject(cache)) {
              jQuery.extend(this.cache[unlock], data);
            } else {
              for (prop in data) {
                cache[prop] = data[prop];
              }
            }
          }
          return cache;
        },
        get: function(owner, key) {
          var cache = this.cache[this.key(owner)];
          return key === undefined ? cache : cache[key];
        },
        access: function(owner, key, value) {
          var stored;
          if (key === undefined || ((key && typeof key === "string") && value === undefined)) {
            stored = this.get(owner, key);
            return stored !== undefined ? stored : this.get(owner, jQuery.camelCase(key));
          }
          this.set(owner, key, value);
          return value !== undefined ? value : key;
        },
        remove: function(owner, key) {
          var i,
              name,
              camel,
              unlock = this.key(owner),
              cache = this.cache[unlock];
          if (key === undefined) {
            this.cache[unlock] = {};
          } else {
            if (jQuery.isArray(key)) {
              name = key.concat(key.map(jQuery.camelCase));
            } else {
              camel = jQuery.camelCase(key);
              if (key in cache) {
                name = [key, camel];
              } else {
                name = camel;
                name = name in cache ? [name] : (name.match(rnotwhite) || []);
              }
            }
            i = name.length;
            while (i--) {
              delete cache[name[i]];
            }
          }
        },
        hasData: function(owner) {
          return !jQuery.isEmptyObject(this.cache[owner[this.expando]] || {});
        },
        discard: function(owner) {
          if (owner[this.expando]) {
            delete this.cache[owner[this.expando]];
          }
        }
      };
      var data_priv = new Data();
      var data_user = new Data();
      var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
          rmultiDash = /([A-Z])/g;
      function dataAttr(elem, key, data) {
        var name;
        if (data === undefined && elem.nodeType === 1) {
          name = "data-" + key.replace(rmultiDash, "-$1").toLowerCase();
          data = elem.getAttribute(name);
          if (typeof data === "string") {
            try {
              data = data === "true" ? true : data === "false" ? false : data === "null" ? null : +data + "" === data ? +data : rbrace.test(data) ? jQuery.parseJSON(data) : data;
            } catch (e) {}
            data_user.set(elem, key, data);
          } else {
            data = undefined;
          }
        }
        return data;
      }
      jQuery.extend({
        hasData: function(elem) {
          return data_user.hasData(elem) || data_priv.hasData(elem);
        },
        data: function(elem, name, data) {
          return data_user.access(elem, name, data);
        },
        removeData: function(elem, name) {
          data_user.remove(elem, name);
        },
        _data: function(elem, name, data) {
          return data_priv.access(elem, name, data);
        },
        _removeData: function(elem, name) {
          data_priv.remove(elem, name);
        }
      });
      jQuery.fn.extend({
        data: function(key, value) {
          var i,
              name,
              data,
              elem = this[0],
              attrs = elem && elem.attributes;
          if (key === undefined) {
            if (this.length) {
              data = data_user.get(elem);
              if (elem.nodeType === 1 && !data_priv.get(elem, "hasDataAttrs")) {
                i = attrs.length;
                while (i--) {
                  if (attrs[i]) {
                    name = attrs[i].name;
                    if (name.indexOf("data-") === 0) {
                      name = jQuery.camelCase(name.slice(5));
                      dataAttr(elem, name, data[name]);
                    }
                  }
                }
                data_priv.set(elem, "hasDataAttrs", true);
              }
            }
            return data;
          }
          if (typeof key === "object") {
            return this.each(function() {
              data_user.set(this, key);
            });
          }
          return access(this, function(value) {
            var data,
                camelKey = jQuery.camelCase(key);
            if (elem && value === undefined) {
              data = data_user.get(elem, key);
              if (data !== undefined) {
                return data;
              }
              data = data_user.get(elem, camelKey);
              if (data !== undefined) {
                return data;
              }
              data = dataAttr(elem, camelKey, undefined);
              if (data !== undefined) {
                return data;
              }
              return;
            }
            this.each(function() {
              var data = data_user.get(this, camelKey);
              data_user.set(this, camelKey, value);
              if (key.indexOf("-") !== -1 && data !== undefined) {
                data_user.set(this, key, value);
              }
            });
          }, null, value, arguments.length > 1, null, true);
        },
        removeData: function(key) {
          return this.each(function() {
            data_user.remove(this, key);
          });
        }
      });
      jQuery.extend({
        queue: function(elem, type, data) {
          var queue;
          if (elem) {
            type = (type || "fx") + "queue";
            queue = data_priv.get(elem, type);
            if (data) {
              if (!queue || jQuery.isArray(data)) {
                queue = data_priv.access(elem, type, jQuery.makeArray(data));
              } else {
                queue.push(data);
              }
            }
            return queue || [];
          }
        },
        dequeue: function(elem, type) {
          type = type || "fx";
          var queue = jQuery.queue(elem, type),
              startLength = queue.length,
              fn = queue.shift(),
              hooks = jQuery._queueHooks(elem, type),
              next = function() {
                jQuery.dequeue(elem, type);
              };
          if (fn === "inprogress") {
            fn = queue.shift();
            startLength--;
          }
          if (fn) {
            if (type === "fx") {
              queue.unshift("inprogress");
            }
            delete hooks.stop;
            fn.call(elem, next, hooks);
          }
          if (!startLength && hooks) {
            hooks.empty.fire();
          }
        },
        _queueHooks: function(elem, type) {
          var key = type + "queueHooks";
          return data_priv.get(elem, key) || data_priv.access(elem, key, {empty: jQuery.Callbacks("once memory").add(function() {
              data_priv.remove(elem, [type + "queue", key]);
            })});
        }
      });
      jQuery.fn.extend({
        queue: function(type, data) {
          var setter = 2;
          if (typeof type !== "string") {
            data = type;
            type = "fx";
            setter--;
          }
          if (arguments.length < setter) {
            return jQuery.queue(this[0], type);
          }
          return data === undefined ? this : this.each(function() {
            var queue = jQuery.queue(this, type, data);
            jQuery._queueHooks(this, type);
            if (type === "fx" && queue[0] !== "inprogress") {
              jQuery.dequeue(this, type);
            }
          });
        },
        dequeue: function(type) {
          return this.each(function() {
            jQuery.dequeue(this, type);
          });
        },
        clearQueue: function(type) {
          return this.queue(type || "fx", []);
        },
        promise: function(type, obj) {
          var tmp,
              count = 1,
              defer = jQuery.Deferred(),
              elements = this,
              i = this.length,
              resolve = function() {
                if (!(--count)) {
                  defer.resolveWith(elements, [elements]);
                }
              };
          if (typeof type !== "string") {
            obj = type;
            type = undefined;
          }
          type = type || "fx";
          while (i--) {
            tmp = data_priv.get(elements[i], type + "queueHooks");
            if (tmp && tmp.empty) {
              count++;
              tmp.empty.add(resolve);
            }
          }
          resolve();
          return defer.promise(obj);
        }
      });
      var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;
      var cssExpand = ["Top", "Right", "Bottom", "Left"];
      var isHidden = function(elem, el) {
        elem = el || elem;
        return jQuery.css(elem, "display") === "none" || !jQuery.contains(elem.ownerDocument, elem);
      };
      var rcheckableType = (/^(?:checkbox|radio)$/i);
      (function() {
        var fragment = document.createDocumentFragment(),
            div = fragment.appendChild(document.createElement("div")),
            input = document.createElement("input");
        input.setAttribute("type", "radio");
        input.setAttribute("checked", "checked");
        input.setAttribute("name", "t");
        div.appendChild(input);
        support.checkClone = div.cloneNode(true).cloneNode(true).lastChild.checked;
        div.innerHTML = "<textarea>x</textarea>";
        support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
      })();
      var strundefined = typeof undefined;
      support.focusinBubbles = "onfocusin" in window;
      var rkeyEvent = /^key/,
          rmouseEvent = /^(?:mouse|pointer|contextmenu)|click/,
          rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
          rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;
      function returnTrue() {
        return true;
      }
      function returnFalse() {
        return false;
      }
      function safeActiveElement() {
        try {
          return document.activeElement;
        } catch (err) {}
      }
      jQuery.event = {
        global: {},
        add: function(elem, types, handler, data, selector) {
          var handleObjIn,
              eventHandle,
              tmp,
              events,
              t,
              handleObj,
              special,
              handlers,
              type,
              namespaces,
              origType,
              elemData = data_priv.get(elem);
          if (!elemData) {
            return;
          }
          if (handler.handler) {
            handleObjIn = handler;
            handler = handleObjIn.handler;
            selector = handleObjIn.selector;
          }
          if (!handler.guid) {
            handler.guid = jQuery.guid++;
          }
          if (!(events = elemData.events)) {
            events = elemData.events = {};
          }
          if (!(eventHandle = elemData.handle)) {
            eventHandle = elemData.handle = function(e) {
              return typeof jQuery !== strundefined && jQuery.event.triggered !== e.type ? jQuery.event.dispatch.apply(elem, arguments) : undefined;
            };
          }
          types = (types || "").match(rnotwhite) || [""];
          t = types.length;
          while (t--) {
            tmp = rtypenamespace.exec(types[t]) || [];
            type = origType = tmp[1];
            namespaces = (tmp[2] || "").split(".").sort();
            if (!type) {
              continue;
            }
            special = jQuery.event.special[type] || {};
            type = (selector ? special.delegateType : special.bindType) || type;
            special = jQuery.event.special[type] || {};
            handleObj = jQuery.extend({
              type: type,
              origType: origType,
              data: data,
              handler: handler,
              guid: handler.guid,
              selector: selector,
              needsContext: selector && jQuery.expr.match.needsContext.test(selector),
              namespace: namespaces.join(".")
            }, handleObjIn);
            if (!(handlers = events[type])) {
              handlers = events[type] = [];
              handlers.delegateCount = 0;
              if (!special.setup || special.setup.call(elem, data, namespaces, eventHandle) === false) {
                if (elem.addEventListener) {
                  elem.addEventListener(type, eventHandle, false);
                }
              }
            }
            if (special.add) {
              special.add.call(elem, handleObj);
              if (!handleObj.handler.guid) {
                handleObj.handler.guid = handler.guid;
              }
            }
            if (selector) {
              handlers.splice(handlers.delegateCount++, 0, handleObj);
            } else {
              handlers.push(handleObj);
            }
            jQuery.event.global[type] = true;
          }
        },
        remove: function(elem, types, handler, selector, mappedTypes) {
          var j,
              origCount,
              tmp,
              events,
              t,
              handleObj,
              special,
              handlers,
              type,
              namespaces,
              origType,
              elemData = data_priv.hasData(elem) && data_priv.get(elem);
          if (!elemData || !(events = elemData.events)) {
            return;
          }
          types = (types || "").match(rnotwhite) || [""];
          t = types.length;
          while (t--) {
            tmp = rtypenamespace.exec(types[t]) || [];
            type = origType = tmp[1];
            namespaces = (tmp[2] || "").split(".").sort();
            if (!type) {
              for (type in events) {
                jQuery.event.remove(elem, type + types[t], handler, selector, true);
              }
              continue;
            }
            special = jQuery.event.special[type] || {};
            type = (selector ? special.delegateType : special.bindType) || type;
            handlers = events[type] || [];
            tmp = tmp[2] && new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)");
            origCount = j = handlers.length;
            while (j--) {
              handleObj = handlers[j];
              if ((mappedTypes || origType === handleObj.origType) && (!handler || handler.guid === handleObj.guid) && (!tmp || tmp.test(handleObj.namespace)) && (!selector || selector === handleObj.selector || selector === "**" && handleObj.selector)) {
                handlers.splice(j, 1);
                if (handleObj.selector) {
                  handlers.delegateCount--;
                }
                if (special.remove) {
                  special.remove.call(elem, handleObj);
                }
              }
            }
            if (origCount && !handlers.length) {
              if (!special.teardown || special.teardown.call(elem, namespaces, elemData.handle) === false) {
                jQuery.removeEvent(elem, type, elemData.handle);
              }
              delete events[type];
            }
          }
          if (jQuery.isEmptyObject(events)) {
            delete elemData.handle;
            data_priv.remove(elem, "events");
          }
        },
        trigger: function(event, data, elem, onlyHandlers) {
          var i,
              cur,
              tmp,
              bubbleType,
              ontype,
              handle,
              special,
              eventPath = [elem || document],
              type = hasOwn.call(event, "type") ? event.type : event,
              namespaces = hasOwn.call(event, "namespace") ? event.namespace.split(".") : [];
          cur = tmp = elem = elem || document;
          if (elem.nodeType === 3 || elem.nodeType === 8) {
            return;
          }
          if (rfocusMorph.test(type + jQuery.event.triggered)) {
            return;
          }
          if (type.indexOf(".") >= 0) {
            namespaces = type.split(".");
            type = namespaces.shift();
            namespaces.sort();
          }
          ontype = type.indexOf(":") < 0 && "on" + type;
          event = event[jQuery.expando] ? event : new jQuery.Event(type, typeof event === "object" && event);
          event.isTrigger = onlyHandlers ? 2 : 3;
          event.namespace = namespaces.join(".");
          event.namespace_re = event.namespace ? new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)") : null;
          event.result = undefined;
          if (!event.target) {
            event.target = elem;
          }
          data = data == null ? [event] : jQuery.makeArray(data, [event]);
          special = jQuery.event.special[type] || {};
          if (!onlyHandlers && special.trigger && special.trigger.apply(elem, data) === false) {
            return;
          }
          if (!onlyHandlers && !special.noBubble && !jQuery.isWindow(elem)) {
            bubbleType = special.delegateType || type;
            if (!rfocusMorph.test(bubbleType + type)) {
              cur = cur.parentNode;
            }
            for (; cur; cur = cur.parentNode) {
              eventPath.push(cur);
              tmp = cur;
            }
            if (tmp === (elem.ownerDocument || document)) {
              eventPath.push(tmp.defaultView || tmp.parentWindow || window);
            }
          }
          i = 0;
          while ((cur = eventPath[i++]) && !event.isPropagationStopped()) {
            event.type = i > 1 ? bubbleType : special.bindType || type;
            handle = (data_priv.get(cur, "events") || {})[event.type] && data_priv.get(cur, "handle");
            if (handle) {
              handle.apply(cur, data);
            }
            handle = ontype && cur[ontype];
            if (handle && handle.apply && jQuery.acceptData(cur)) {
              event.result = handle.apply(cur, data);
              if (event.result === false) {
                event.preventDefault();
              }
            }
          }
          event.type = type;
          if (!onlyHandlers && !event.isDefaultPrevented()) {
            if ((!special._default || special._default.apply(eventPath.pop(), data) === false) && jQuery.acceptData(elem)) {
              if (ontype && jQuery.isFunction(elem[type]) && !jQuery.isWindow(elem)) {
                tmp = elem[ontype];
                if (tmp) {
                  elem[ontype] = null;
                }
                jQuery.event.triggered = type;
                elem[type]();
                jQuery.event.triggered = undefined;
                if (tmp) {
                  elem[ontype] = tmp;
                }
              }
            }
          }
          return event.result;
        },
        dispatch: function(event) {
          event = jQuery.event.fix(event);
          var i,
              j,
              ret,
              matched,
              handleObj,
              handlerQueue = [],
              args = slice.call(arguments),
              handlers = (data_priv.get(this, "events") || {})[event.type] || [],
              special = jQuery.event.special[event.type] || {};
          args[0] = event;
          event.delegateTarget = this;
          if (special.preDispatch && special.preDispatch.call(this, event) === false) {
            return;
          }
          handlerQueue = jQuery.event.handlers.call(this, event, handlers);
          i = 0;
          while ((matched = handlerQueue[i++]) && !event.isPropagationStopped()) {
            event.currentTarget = matched.elem;
            j = 0;
            while ((handleObj = matched.handlers[j++]) && !event.isImmediatePropagationStopped()) {
              if (!event.namespace_re || event.namespace_re.test(handleObj.namespace)) {
                event.handleObj = handleObj;
                event.data = handleObj.data;
                ret = ((jQuery.event.special[handleObj.origType] || {}).handle || handleObj.handler).apply(matched.elem, args);
                if (ret !== undefined) {
                  if ((event.result = ret) === false) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                }
              }
            }
          }
          if (special.postDispatch) {
            special.postDispatch.call(this, event);
          }
          return event.result;
        },
        handlers: function(event, handlers) {
          var i,
              matches,
              sel,
              handleObj,
              handlerQueue = [],
              delegateCount = handlers.delegateCount,
              cur = event.target;
          if (delegateCount && cur.nodeType && (!event.button || event.type !== "click")) {
            for (; cur !== this; cur = cur.parentNode || this) {
              if (cur.disabled !== true || event.type !== "click") {
                matches = [];
                for (i = 0; i < delegateCount; i++) {
                  handleObj = handlers[i];
                  sel = handleObj.selector + " ";
                  if (matches[sel] === undefined) {
                    matches[sel] = handleObj.needsContext ? jQuery(sel, this).index(cur) >= 0 : jQuery.find(sel, this, null, [cur]).length;
                  }
                  if (matches[sel]) {
                    matches.push(handleObj);
                  }
                }
                if (matches.length) {
                  handlerQueue.push({
                    elem: cur,
                    handlers: matches
                  });
                }
              }
            }
          }
          if (delegateCount < handlers.length) {
            handlerQueue.push({
              elem: this,
              handlers: handlers.slice(delegateCount)
            });
          }
          return handlerQueue;
        },
        props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),
        fixHooks: {},
        keyHooks: {
          props: "char charCode key keyCode".split(" "),
          filter: function(event, original) {
            if (event.which == null) {
              event.which = original.charCode != null ? original.charCode : original.keyCode;
            }
            return event;
          }
        },
        mouseHooks: {
          props: "button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
          filter: function(event, original) {
            var eventDoc,
                doc,
                body,
                button = original.button;
            if (event.pageX == null && original.clientX != null) {
              eventDoc = event.target.ownerDocument || document;
              doc = eventDoc.documentElement;
              body = eventDoc.body;
              event.pageX = original.clientX + (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc && doc.clientLeft || body && body.clientLeft || 0);
              event.pageY = original.clientY + (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc && doc.clientTop || body && body.clientTop || 0);
            }
            if (!event.which && button !== undefined) {
              event.which = (button & 1 ? 1 : (button & 2 ? 3 : (button & 4 ? 2 : 0)));
            }
            return event;
          }
        },
        fix: function(event) {
          if (event[jQuery.expando]) {
            return event;
          }
          var i,
              prop,
              copy,
              type = event.type,
              originalEvent = event,
              fixHook = this.fixHooks[type];
          if (!fixHook) {
            this.fixHooks[type] = fixHook = rmouseEvent.test(type) ? this.mouseHooks : rkeyEvent.test(type) ? this.keyHooks : {};
          }
          copy = fixHook.props ? this.props.concat(fixHook.props) : this.props;
          event = new jQuery.Event(originalEvent);
          i = copy.length;
          while (i--) {
            prop = copy[i];
            event[prop] = originalEvent[prop];
          }
          if (!event.target) {
            event.target = document;
          }
          if (event.target.nodeType === 3) {
            event.target = event.target.parentNode;
          }
          return fixHook.filter ? fixHook.filter(event, originalEvent) : event;
        },
        special: {
          load: {noBubble: true},
          focus: {
            trigger: function() {
              if (this !== safeActiveElement() && this.focus) {
                this.focus();
                return false;
              }
            },
            delegateType: "focusin"
          },
          blur: {
            trigger: function() {
              if (this === safeActiveElement() && this.blur) {
                this.blur();
                return false;
              }
            },
            delegateType: "focusout"
          },
          click: {
            trigger: function() {
              if (this.type === "checkbox" && this.click && jQuery.nodeName(this, "input")) {
                this.click();
                return false;
              }
            },
            _default: function(event) {
              return jQuery.nodeName(event.target, "a");
            }
          },
          beforeunload: {postDispatch: function(event) {
              if (event.result !== undefined && event.originalEvent) {
                event.originalEvent.returnValue = event.result;
              }
            }}
        },
        simulate: function(type, elem, event, bubble) {
          var e = jQuery.extend(new jQuery.Event(), event, {
            type: type,
            isSimulated: true,
            originalEvent: {}
          });
          if (bubble) {
            jQuery.event.trigger(e, null, elem);
          } else {
            jQuery.event.dispatch.call(elem, e);
          }
          if (e.isDefaultPrevented()) {
            event.preventDefault();
          }
        }
      };
      jQuery.removeEvent = function(elem, type, handle) {
        if (elem.removeEventListener) {
          elem.removeEventListener(type, handle, false);
        }
      };
      jQuery.Event = function(src, props) {
        if (!(this instanceof jQuery.Event)) {
          return new jQuery.Event(src, props);
        }
        if (src && src.type) {
          this.originalEvent = src;
          this.type = src.type;
          this.isDefaultPrevented = src.defaultPrevented || src.defaultPrevented === undefined && src.returnValue === false ? returnTrue : returnFalse;
        } else {
          this.type = src;
        }
        if (props) {
          jQuery.extend(this, props);
        }
        this.timeStamp = src && src.timeStamp || jQuery.now();
        this[jQuery.expando] = true;
      };
      jQuery.Event.prototype = {
        isDefaultPrevented: returnFalse,
        isPropagationStopped: returnFalse,
        isImmediatePropagationStopped: returnFalse,
        preventDefault: function() {
          var e = this.originalEvent;
          this.isDefaultPrevented = returnTrue;
          if (e && e.preventDefault) {
            e.preventDefault();
          }
        },
        stopPropagation: function() {
          var e = this.originalEvent;
          this.isPropagationStopped = returnTrue;
          if (e && e.stopPropagation) {
            e.stopPropagation();
          }
        },
        stopImmediatePropagation: function() {
          var e = this.originalEvent;
          this.isImmediatePropagationStopped = returnTrue;
          if (e && e.stopImmediatePropagation) {
            e.stopImmediatePropagation();
          }
          this.stopPropagation();
        }
      };
      jQuery.each({
        mouseenter: "mouseover",
        mouseleave: "mouseout",
        pointerenter: "pointerover",
        pointerleave: "pointerout"
      }, function(orig, fix) {
        jQuery.event.special[orig] = {
          delegateType: fix,
          bindType: fix,
          handle: function(event) {
            var ret,
                target = this,
                related = event.relatedTarget,
                handleObj = event.handleObj;
            if (!related || (related !== target && !jQuery.contains(target, related))) {
              event.type = handleObj.origType;
              ret = handleObj.handler.apply(this, arguments);
              event.type = fix;
            }
            return ret;
          }
        };
      });
      if (!support.focusinBubbles) {
        jQuery.each({
          focus: "focusin",
          blur: "focusout"
        }, function(orig, fix) {
          var handler = function(event) {
            jQuery.event.simulate(fix, event.target, jQuery.event.fix(event), true);
          };
          jQuery.event.special[fix] = {
            setup: function() {
              var doc = this.ownerDocument || this,
                  attaches = data_priv.access(doc, fix);
              if (!attaches) {
                doc.addEventListener(orig, handler, true);
              }
              data_priv.access(doc, fix, (attaches || 0) + 1);
            },
            teardown: function() {
              var doc = this.ownerDocument || this,
                  attaches = data_priv.access(doc, fix) - 1;
              if (!attaches) {
                doc.removeEventListener(orig, handler, true);
                data_priv.remove(doc, fix);
              } else {
                data_priv.access(doc, fix, attaches);
              }
            }
          };
        });
      }
      jQuery.fn.extend({
        on: function(types, selector, data, fn, one) {
          var origFn,
              type;
          if (typeof types === "object") {
            if (typeof selector !== "string") {
              data = data || selector;
              selector = undefined;
            }
            for (type in types) {
              this.on(type, selector, data, types[type], one);
            }
            return this;
          }
          if (data == null && fn == null) {
            fn = selector;
            data = selector = undefined;
          } else if (fn == null) {
            if (typeof selector === "string") {
              fn = data;
              data = undefined;
            } else {
              fn = data;
              data = selector;
              selector = undefined;
            }
          }
          if (fn === false) {
            fn = returnFalse;
          } else if (!fn) {
            return this;
          }
          if (one === 1) {
            origFn = fn;
            fn = function(event) {
              jQuery().off(event);
              return origFn.apply(this, arguments);
            };
            fn.guid = origFn.guid || (origFn.guid = jQuery.guid++);
          }
          return this.each(function() {
            jQuery.event.add(this, types, fn, data, selector);
          });
        },
        one: function(types, selector, data, fn) {
          return this.on(types, selector, data, fn, 1);
        },
        off: function(types, selector, fn) {
          var handleObj,
              type;
          if (types && types.preventDefault && types.handleObj) {
            handleObj = types.handleObj;
            jQuery(types.delegateTarget).off(handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType, handleObj.selector, handleObj.handler);
            return this;
          }
          if (typeof types === "object") {
            for (type in types) {
              this.off(type, selector, types[type]);
            }
            return this;
          }
          if (selector === false || typeof selector === "function") {
            fn = selector;
            selector = undefined;
          }
          if (fn === false) {
            fn = returnFalse;
          }
          return this.each(function() {
            jQuery.event.remove(this, types, fn, selector);
          });
        },
        trigger: function(type, data) {
          return this.each(function() {
            jQuery.event.trigger(type, data, this);
          });
        },
        triggerHandler: function(type, data) {
          var elem = this[0];
          if (elem) {
            return jQuery.event.trigger(type, data, elem, true);
          }
        }
      });
      var rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
          rtagName = /<([\w:]+)/,
          rhtml = /<|&#?\w+;/,
          rnoInnerhtml = /<(?:script|style|link)/i,
          rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
          rscriptType = /^$|\/(?:java|ecma)script/i,
          rscriptTypeMasked = /^true\/(.*)/,
          rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,
          wrapMap = {
            option: [1, "<select multiple='multiple'>", "</select>"],
            thead: [1, "<table>", "</table>"],
            col: [2, "<table><colgroup>", "</colgroup></table>"],
            tr: [2, "<table><tbody>", "</tbody></table>"],
            td: [3, "<table><tbody><tr>", "</tr></tbody></table>"],
            _default: [0, "", ""]
          };
      wrapMap.optgroup = wrapMap.option;
      wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
      wrapMap.th = wrapMap.td;
      function manipulationTarget(elem, content) {
        return jQuery.nodeName(elem, "table") && jQuery.nodeName(content.nodeType !== 11 ? content : content.firstChild, "tr") ? elem.getElementsByTagName("tbody")[0] || elem.appendChild(elem.ownerDocument.createElement("tbody")) : elem;
      }
      function disableScript(elem) {
        elem.type = (elem.getAttribute("type") !== null) + "/" + elem.type;
        return elem;
      }
      function restoreScript(elem) {
        var match = rscriptTypeMasked.exec(elem.type);
        if (match) {
          elem.type = match[1];
        } else {
          elem.removeAttribute("type");
        }
        return elem;
      }
      function setGlobalEval(elems, refElements) {
        var i = 0,
            l = elems.length;
        for (; i < l; i++) {
          data_priv.set(elems[i], "globalEval", !refElements || data_priv.get(refElements[i], "globalEval"));
        }
      }
      function cloneCopyEvent(src, dest) {
        var i,
            l,
            type,
            pdataOld,
            pdataCur,
            udataOld,
            udataCur,
            events;
        if (dest.nodeType !== 1) {
          return;
        }
        if (data_priv.hasData(src)) {
          pdataOld = data_priv.access(src);
          pdataCur = data_priv.set(dest, pdataOld);
          events = pdataOld.events;
          if (events) {
            delete pdataCur.handle;
            pdataCur.events = {};
            for (type in events) {
              for (i = 0, l = events[type].length; i < l; i++) {
                jQuery.event.add(dest, type, events[type][i]);
              }
            }
          }
        }
        if (data_user.hasData(src)) {
          udataOld = data_user.access(src);
          udataCur = jQuery.extend({}, udataOld);
          data_user.set(dest, udataCur);
        }
      }
      function getAll(context, tag) {
        var ret = context.getElementsByTagName ? context.getElementsByTagName(tag || "*") : context.querySelectorAll ? context.querySelectorAll(tag || "*") : [];
        return tag === undefined || tag && jQuery.nodeName(context, tag) ? jQuery.merge([context], ret) : ret;
      }
      function fixInput(src, dest) {
        var nodeName = dest.nodeName.toLowerCase();
        if (nodeName === "input" && rcheckableType.test(src.type)) {
          dest.checked = src.checked;
        } else if (nodeName === "input" || nodeName === "textarea") {
          dest.defaultValue = src.defaultValue;
        }
      }
      jQuery.extend({
        clone: function(elem, dataAndEvents, deepDataAndEvents) {
          var i,
              l,
              srcElements,
              destElements,
              clone = elem.cloneNode(true),
              inPage = jQuery.contains(elem.ownerDocument, elem);
          if (!support.noCloneChecked && (elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem)) {
            destElements = getAll(clone);
            srcElements = getAll(elem);
            for (i = 0, l = srcElements.length; i < l; i++) {
              fixInput(srcElements[i], destElements[i]);
            }
          }
          if (dataAndEvents) {
            if (deepDataAndEvents) {
              srcElements = srcElements || getAll(elem);
              destElements = destElements || getAll(clone);
              for (i = 0, l = srcElements.length; i < l; i++) {
                cloneCopyEvent(srcElements[i], destElements[i]);
              }
            } else {
              cloneCopyEvent(elem, clone);
            }
          }
          destElements = getAll(clone, "script");
          if (destElements.length > 0) {
            setGlobalEval(destElements, !inPage && getAll(elem, "script"));
          }
          return clone;
        },
        buildFragment: function(elems, context, scripts, selection) {
          var elem,
              tmp,
              tag,
              wrap,
              contains,
              j,
              fragment = context.createDocumentFragment(),
              nodes = [],
              i = 0,
              l = elems.length;
          for (; i < l; i++) {
            elem = elems[i];
            if (elem || elem === 0) {
              if (jQuery.type(elem) === "object") {
                jQuery.merge(nodes, elem.nodeType ? [elem] : elem);
              } else if (!rhtml.test(elem)) {
                nodes.push(context.createTextNode(elem));
              } else {
                tmp = tmp || fragment.appendChild(context.createElement("div"));
                tag = (rtagName.exec(elem) || ["", ""])[1].toLowerCase();
                wrap = wrapMap[tag] || wrapMap._default;
                tmp.innerHTML = wrap[1] + elem.replace(rxhtmlTag, "<$1></$2>") + wrap[2];
                j = wrap[0];
                while (j--) {
                  tmp = tmp.lastChild;
                }
                jQuery.merge(nodes, tmp.childNodes);
                tmp = fragment.firstChild;
                tmp.textContent = "";
              }
            }
          }
          fragment.textContent = "";
          i = 0;
          while ((elem = nodes[i++])) {
            if (selection && jQuery.inArray(elem, selection) !== -1) {
              continue;
            }
            contains = jQuery.contains(elem.ownerDocument, elem);
            tmp = getAll(fragment.appendChild(elem), "script");
            if (contains) {
              setGlobalEval(tmp);
            }
            if (scripts) {
              j = 0;
              while ((elem = tmp[j++])) {
                if (rscriptType.test(elem.type || "")) {
                  scripts.push(elem);
                }
              }
            }
          }
          return fragment;
        },
        cleanData: function(elems) {
          var data,
              elem,
              type,
              key,
              special = jQuery.event.special,
              i = 0;
          for (; (elem = elems[i]) !== undefined; i++) {
            if (jQuery.acceptData(elem)) {
              key = elem[data_priv.expando];
              if (key && (data = data_priv.cache[key])) {
                if (data.events) {
                  for (type in data.events) {
                    if (special[type]) {
                      jQuery.event.remove(elem, type);
                    } else {
                      jQuery.removeEvent(elem, type, data.handle);
                    }
                  }
                }
                if (data_priv.cache[key]) {
                  delete data_priv.cache[key];
                }
              }
            }
            delete data_user.cache[elem[data_user.expando]];
          }
        }
      });
      jQuery.fn.extend({
        text: function(value) {
          return access(this, function(value) {
            return value === undefined ? jQuery.text(this) : this.empty().each(function() {
              if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
                this.textContent = value;
              }
            });
          }, null, value, arguments.length);
        },
        append: function() {
          return this.domManip(arguments, function(elem) {
            if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
              var target = manipulationTarget(this, elem);
              target.appendChild(elem);
            }
          });
        },
        prepend: function() {
          return this.domManip(arguments, function(elem) {
            if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
              var target = manipulationTarget(this, elem);
              target.insertBefore(elem, target.firstChild);
            }
          });
        },
        before: function() {
          return this.domManip(arguments, function(elem) {
            if (this.parentNode) {
              this.parentNode.insertBefore(elem, this);
            }
          });
        },
        after: function() {
          return this.domManip(arguments, function(elem) {
            if (this.parentNode) {
              this.parentNode.insertBefore(elem, this.nextSibling);
            }
          });
        },
        remove: function(selector, keepData) {
          var elem,
              elems = selector ? jQuery.filter(selector, this) : this,
              i = 0;
          for (; (elem = elems[i]) != null; i++) {
            if (!keepData && elem.nodeType === 1) {
              jQuery.cleanData(getAll(elem));
            }
            if (elem.parentNode) {
              if (keepData && jQuery.contains(elem.ownerDocument, elem)) {
                setGlobalEval(getAll(elem, "script"));
              }
              elem.parentNode.removeChild(elem);
            }
          }
          return this;
        },
        empty: function() {
          var elem,
              i = 0;
          for (; (elem = this[i]) != null; i++) {
            if (elem.nodeType === 1) {
              jQuery.cleanData(getAll(elem, false));
              elem.textContent = "";
            }
          }
          return this;
        },
        clone: function(dataAndEvents, deepDataAndEvents) {
          dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
          deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;
          return this.map(function() {
            return jQuery.clone(this, dataAndEvents, deepDataAndEvents);
          });
        },
        html: function(value) {
          return access(this, function(value) {
            var elem = this[0] || {},
                i = 0,
                l = this.length;
            if (value === undefined && elem.nodeType === 1) {
              return elem.innerHTML;
            }
            if (typeof value === "string" && !rnoInnerhtml.test(value) && !wrapMap[(rtagName.exec(value) || ["", ""])[1].toLowerCase()]) {
              value = value.replace(rxhtmlTag, "<$1></$2>");
              try {
                for (; i < l; i++) {
                  elem = this[i] || {};
                  if (elem.nodeType === 1) {
                    jQuery.cleanData(getAll(elem, false));
                    elem.innerHTML = value;
                  }
                }
                elem = 0;
              } catch (e) {}
            }
            if (elem) {
              this.empty().append(value);
            }
          }, null, value, arguments.length);
        },
        replaceWith: function() {
          var arg = arguments[0];
          this.domManip(arguments, function(elem) {
            arg = this.parentNode;
            jQuery.cleanData(getAll(this));
            if (arg) {
              arg.replaceChild(elem, this);
            }
          });
          return arg && (arg.length || arg.nodeType) ? this : this.remove();
        },
        detach: function(selector) {
          return this.remove(selector, true);
        },
        domManip: function(args, callback) {
          args = concat.apply([], args);
          var fragment,
              first,
              scripts,
              hasScripts,
              node,
              doc,
              i = 0,
              l = this.length,
              set = this,
              iNoClone = l - 1,
              value = args[0],
              isFunction = jQuery.isFunction(value);
          if (isFunction || (l > 1 && typeof value === "string" && !support.checkClone && rchecked.test(value))) {
            return this.each(function(index) {
              var self = set.eq(index);
              if (isFunction) {
                args[0] = value.call(this, index, self.html());
              }
              self.domManip(args, callback);
            });
          }
          if (l) {
            fragment = jQuery.buildFragment(args, this[0].ownerDocument, false, this);
            first = fragment.firstChild;
            if (fragment.childNodes.length === 1) {
              fragment = first;
            }
            if (first) {
              scripts = jQuery.map(getAll(fragment, "script"), disableScript);
              hasScripts = scripts.length;
              for (; i < l; i++) {
                node = fragment;
                if (i !== iNoClone) {
                  node = jQuery.clone(node, true, true);
                  if (hasScripts) {
                    jQuery.merge(scripts, getAll(node, "script"));
                  }
                }
                callback.call(this[i], node, i);
              }
              if (hasScripts) {
                doc = scripts[scripts.length - 1].ownerDocument;
                jQuery.map(scripts, restoreScript);
                for (i = 0; i < hasScripts; i++) {
                  node = scripts[i];
                  if (rscriptType.test(node.type || "") && !data_priv.access(node, "globalEval") && jQuery.contains(doc, node)) {
                    if (node.src) {
                      if (jQuery._evalUrl) {
                        jQuery._evalUrl(node.src);
                      }
                    } else {
                      jQuery.globalEval(node.textContent.replace(rcleanScript, ""));
                    }
                  }
                }
              }
            }
          }
          return this;
        }
      });
      jQuery.each({
        appendTo: "append",
        prependTo: "prepend",
        insertBefore: "before",
        insertAfter: "after",
        replaceAll: "replaceWith"
      }, function(name, original) {
        jQuery.fn[name] = function(selector) {
          var elems,
              ret = [],
              insert = jQuery(selector),
              last = insert.length - 1,
              i = 0;
          for (; i <= last; i++) {
            elems = i === last ? this : this.clone(true);
            jQuery(insert[i])[original](elems);
            push.apply(ret, elems.get());
          }
          return this.pushStack(ret);
        };
      });
      var iframe,
          elemdisplay = {};
      function actualDisplay(name, doc) {
        var style,
            elem = jQuery(doc.createElement(name)).appendTo(doc.body),
            display = window.getDefaultComputedStyle && (style = window.getDefaultComputedStyle(elem[0])) ? style.display : jQuery.css(elem[0], "display");
        elem.detach();
        return display;
      }
      function defaultDisplay(nodeName) {
        var doc = document,
            display = elemdisplay[nodeName];
        if (!display) {
          display = actualDisplay(nodeName, doc);
          if (display === "none" || !display) {
            iframe = (iframe || jQuery("<iframe frameborder='0' width='0' height='0'/>")).appendTo(doc.documentElement);
            doc = iframe[0].contentDocument;
            doc.write();
            doc.close();
            display = actualDisplay(nodeName, doc);
            iframe.detach();
          }
          elemdisplay[nodeName] = display;
        }
        return display;
      }
      var rmargin = (/^margin/);
      var rnumnonpx = new RegExp("^(" + pnum + ")(?!px)[a-z%]+$", "i");
      var getStyles = function(elem) {
        if (elem.ownerDocument.defaultView.opener) {
          return elem.ownerDocument.defaultView.getComputedStyle(elem, null);
        }
        return window.getComputedStyle(elem, null);
      };
      function curCSS(elem, name, computed) {
        var width,
            minWidth,
            maxWidth,
            ret,
            style = elem.style;
        computed = computed || getStyles(elem);
        if (computed) {
          ret = computed.getPropertyValue(name) || computed[name];
        }
        if (computed) {
          if (ret === "" && !jQuery.contains(elem.ownerDocument, elem)) {
            ret = jQuery.style(elem, name);
          }
          if (rnumnonpx.test(ret) && rmargin.test(name)) {
            width = style.width;
            minWidth = style.minWidth;
            maxWidth = style.maxWidth;
            style.minWidth = style.maxWidth = style.width = ret;
            ret = computed.width;
            style.width = width;
            style.minWidth = minWidth;
            style.maxWidth = maxWidth;
          }
        }
        return ret !== undefined ? ret + "" : ret;
      }
      function addGetHookIf(conditionFn, hookFn) {
        return {get: function() {
            if (conditionFn()) {
              delete this.get;
              return;
            }
            return (this.get = hookFn).apply(this, arguments);
          }};
      }
      (function() {
        var pixelPositionVal,
            boxSizingReliableVal,
            docElem = document.documentElement,
            container = document.createElement("div"),
            div = document.createElement("div");
        if (!div.style) {
          return;
        }
        div.style.backgroundClip = "content-box";
        div.cloneNode(true).style.backgroundClip = "";
        support.clearCloneStyle = div.style.backgroundClip === "content-box";
        container.style.cssText = "border:0;width:0;height:0;top:0;left:-9999px;margin-top:1px;" + "position:absolute";
        container.appendChild(div);
        function computePixelPositionAndBoxSizingReliable() {
          div.style.cssText = "-webkit-box-sizing:border-box;-moz-box-sizing:border-box;" + "box-sizing:border-box;display:block;margin-top:1%;top:1%;" + "border:1px;padding:1px;width:4px;position:absolute";
          div.innerHTML = "";
          docElem.appendChild(container);
          var divStyle = window.getComputedStyle(div, null);
          pixelPositionVal = divStyle.top !== "1%";
          boxSizingReliableVal = divStyle.width === "4px";
          docElem.removeChild(container);
        }
        if (window.getComputedStyle) {
          jQuery.extend(support, {
            pixelPosition: function() {
              computePixelPositionAndBoxSizingReliable();
              return pixelPositionVal;
            },
            boxSizingReliable: function() {
              if (boxSizingReliableVal == null) {
                computePixelPositionAndBoxSizingReliable();
              }
              return boxSizingReliableVal;
            },
            reliableMarginRight: function() {
              var ret,
                  marginDiv = div.appendChild(document.createElement("div"));
              marginDiv.style.cssText = div.style.cssText = "-webkit-box-sizing:content-box;-moz-box-sizing:content-box;" + "box-sizing:content-box;display:block;margin:0;border:0;padding:0";
              marginDiv.style.marginRight = marginDiv.style.width = "0";
              div.style.width = "1px";
              docElem.appendChild(container);
              ret = !parseFloat(window.getComputedStyle(marginDiv, null).marginRight);
              docElem.removeChild(container);
              div.removeChild(marginDiv);
              return ret;
            }
          });
        }
      })();
      jQuery.swap = function(elem, options, callback, args) {
        var ret,
            name,
            old = {};
        for (name in options) {
          old[name] = elem.style[name];
          elem.style[name] = options[name];
        }
        ret = callback.apply(elem, args || []);
        for (name in options) {
          elem.style[name] = old[name];
        }
        return ret;
      };
      var rdisplayswap = /^(none|table(?!-c[ea]).+)/,
          rnumsplit = new RegExp("^(" + pnum + ")(.*)$", "i"),
          rrelNum = new RegExp("^([+-])=(" + pnum + ")", "i"),
          cssShow = {
            position: "absolute",
            visibility: "hidden",
            display: "block"
          },
          cssNormalTransform = {
            letterSpacing: "0",
            fontWeight: "400"
          },
          cssPrefixes = ["Webkit", "O", "Moz", "ms"];
      function vendorPropName(style, name) {
        if (name in style) {
          return name;
        }
        var capName = name[0].toUpperCase() + name.slice(1),
            origName = name,
            i = cssPrefixes.length;
        while (i--) {
          name = cssPrefixes[i] + capName;
          if (name in style) {
            return name;
          }
        }
        return origName;
      }
      function setPositiveNumber(elem, value, subtract) {
        var matches = rnumsplit.exec(value);
        return matches ? Math.max(0, matches[1] - (subtract || 0)) + (matches[2] || "px") : value;
      }
      function augmentWidthOrHeight(elem, name, extra, isBorderBox, styles) {
        var i = extra === (isBorderBox ? "border" : "content") ? 4 : name === "width" ? 1 : 0,
            val = 0;
        for (; i < 4; i += 2) {
          if (extra === "margin") {
            val += jQuery.css(elem, extra + cssExpand[i], true, styles);
          }
          if (isBorderBox) {
            if (extra === "content") {
              val -= jQuery.css(elem, "padding" + cssExpand[i], true, styles);
            }
            if (extra !== "margin") {
              val -= jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
            }
          } else {
            val += jQuery.css(elem, "padding" + cssExpand[i], true, styles);
            if (extra !== "padding") {
              val += jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
            }
          }
        }
        return val;
      }
      function getWidthOrHeight(elem, name, extra) {
        var valueIsBorderBox = true,
            val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
            styles = getStyles(elem),
            isBorderBox = jQuery.css(elem, "boxSizing", false, styles) === "border-box";
        if (val <= 0 || val == null) {
          val = curCSS(elem, name, styles);
          if (val < 0 || val == null) {
            val = elem.style[name];
          }
          if (rnumnonpx.test(val)) {
            return val;
          }
          valueIsBorderBox = isBorderBox && (support.boxSizingReliable() || val === elem.style[name]);
          val = parseFloat(val) || 0;
        }
        return (val + augmentWidthOrHeight(elem, name, extra || (isBorderBox ? "border" : "content"), valueIsBorderBox, styles)) + "px";
      }
      function showHide(elements, show) {
        var display,
            elem,
            hidden,
            values = [],
            index = 0,
            length = elements.length;
        for (; index < length; index++) {
          elem = elements[index];
          if (!elem.style) {
            continue;
          }
          values[index] = data_priv.get(elem, "olddisplay");
          display = elem.style.display;
          if (show) {
            if (!values[index] && display === "none") {
              elem.style.display = "";
            }
            if (elem.style.display === "" && isHidden(elem)) {
              values[index] = data_priv.access(elem, "olddisplay", defaultDisplay(elem.nodeName));
            }
          } else {
            hidden = isHidden(elem);
            if (display !== "none" || !hidden) {
              data_priv.set(elem, "olddisplay", hidden ? display : jQuery.css(elem, "display"));
            }
          }
        }
        for (index = 0; index < length; index++) {
          elem = elements[index];
          if (!elem.style) {
            continue;
          }
          if (!show || elem.style.display === "none" || elem.style.display === "") {
            elem.style.display = show ? values[index] || "" : "none";
          }
        }
        return elements;
      }
      jQuery.extend({
        cssHooks: {opacity: {get: function(elem, computed) {
              if (computed) {
                var ret = curCSS(elem, "opacity");
                return ret === "" ? "1" : ret;
              }
            }}},
        cssNumber: {
          "columnCount": true,
          "fillOpacity": true,
          "flexGrow": true,
          "flexShrink": true,
          "fontWeight": true,
          "lineHeight": true,
          "opacity": true,
          "order": true,
          "orphans": true,
          "widows": true,
          "zIndex": true,
          "zoom": true
        },
        cssProps: {"float": "cssFloat"},
        style: function(elem, name, value, extra) {
          if (!elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style) {
            return;
          }
          var ret,
              type,
              hooks,
              origName = jQuery.camelCase(name),
              style = elem.style;
          name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(style, origName));
          hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
          if (value !== undefined) {
            type = typeof value;
            if (type === "string" && (ret = rrelNum.exec(value))) {
              value = (ret[1] + 1) * ret[2] + parseFloat(jQuery.css(elem, name));
              type = "number";
            }
            if (value == null || value !== value) {
              return;
            }
            if (type === "number" && !jQuery.cssNumber[origName]) {
              value += "px";
            }
            if (!support.clearCloneStyle && value === "" && name.indexOf("background") === 0) {
              style[name] = "inherit";
            }
            if (!hooks || !("set" in hooks) || (value = hooks.set(elem, value, extra)) !== undefined) {
              style[name] = value;
            }
          } else {
            if (hooks && "get" in hooks && (ret = hooks.get(elem, false, extra)) !== undefined) {
              return ret;
            }
            return style[name];
          }
        },
        css: function(elem, name, extra, styles) {
          var val,
              num,
              hooks,
              origName = jQuery.camelCase(name);
          name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(elem.style, origName));
          hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
          if (hooks && "get" in hooks) {
            val = hooks.get(elem, true, extra);
          }
          if (val === undefined) {
            val = curCSS(elem, name, styles);
          }
          if (val === "normal" && name in cssNormalTransform) {
            val = cssNormalTransform[name];
          }
          if (extra === "" || extra) {
            num = parseFloat(val);
            return extra === true || jQuery.isNumeric(num) ? num || 0 : val;
          }
          return val;
        }
      });
      jQuery.each(["height", "width"], function(i, name) {
        jQuery.cssHooks[name] = {
          get: function(elem, computed, extra) {
            if (computed) {
              return rdisplayswap.test(jQuery.css(elem, "display")) && elem.offsetWidth === 0 ? jQuery.swap(elem, cssShow, function() {
                return getWidthOrHeight(elem, name, extra);
              }) : getWidthOrHeight(elem, name, extra);
            }
          },
          set: function(elem, value, extra) {
            var styles = extra && getStyles(elem);
            return setPositiveNumber(elem, value, extra ? augmentWidthOrHeight(elem, name, extra, jQuery.css(elem, "boxSizing", false, styles) === "border-box", styles) : 0);
          }
        };
      });
      jQuery.cssHooks.marginRight = addGetHookIf(support.reliableMarginRight, function(elem, computed) {
        if (computed) {
          return jQuery.swap(elem, {"display": "inline-block"}, curCSS, [elem, "marginRight"]);
        }
      });
      jQuery.each({
        margin: "",
        padding: "",
        border: "Width"
      }, function(prefix, suffix) {
        jQuery.cssHooks[prefix + suffix] = {expand: function(value) {
            var i = 0,
                expanded = {},
                parts = typeof value === "string" ? value.split(" ") : [value];
            for (; i < 4; i++) {
              expanded[prefix + cssExpand[i] + suffix] = parts[i] || parts[i - 2] || parts[0];
            }
            return expanded;
          }};
        if (!rmargin.test(prefix)) {
          jQuery.cssHooks[prefix + suffix].set = setPositiveNumber;
        }
      });
      jQuery.fn.extend({
        css: function(name, value) {
          return access(this, function(elem, name, value) {
            var styles,
                len,
                map = {},
                i = 0;
            if (jQuery.isArray(name)) {
              styles = getStyles(elem);
              len = name.length;
              for (; i < len; i++) {
                map[name[i]] = jQuery.css(elem, name[i], false, styles);
              }
              return map;
            }
            return value !== undefined ? jQuery.style(elem, name, value) : jQuery.css(elem, name);
          }, name, value, arguments.length > 1);
        },
        show: function() {
          return showHide(this, true);
        },
        hide: function() {
          return showHide(this);
        },
        toggle: function(state) {
          if (typeof state === "boolean") {
            return state ? this.show() : this.hide();
          }
          return this.each(function() {
            if (isHidden(this)) {
              jQuery(this).show();
            } else {
              jQuery(this).hide();
            }
          });
        }
      });
      function Tween(elem, options, prop, end, easing) {
        return new Tween.prototype.init(elem, options, prop, end, easing);
      }
      jQuery.Tween = Tween;
      Tween.prototype = {
        constructor: Tween,
        init: function(elem, options, prop, end, easing, unit) {
          this.elem = elem;
          this.prop = prop;
          this.easing = easing || "swing";
          this.options = options;
          this.start = this.now = this.cur();
          this.end = end;
          this.unit = unit || (jQuery.cssNumber[prop] ? "" : "px");
        },
        cur: function() {
          var hooks = Tween.propHooks[this.prop];
          return hooks && hooks.get ? hooks.get(this) : Tween.propHooks._default.get(this);
        },
        run: function(percent) {
          var eased,
              hooks = Tween.propHooks[this.prop];
          if (this.options.duration) {
            this.pos = eased = jQuery.easing[this.easing](percent, this.options.duration * percent, 0, 1, this.options.duration);
          } else {
            this.pos = eased = percent;
          }
          this.now = (this.end - this.start) * eased + this.start;
          if (this.options.step) {
            this.options.step.call(this.elem, this.now, this);
          }
          if (hooks && hooks.set) {
            hooks.set(this);
          } else {
            Tween.propHooks._default.set(this);
          }
          return this;
        }
      };
      Tween.prototype.init.prototype = Tween.prototype;
      Tween.propHooks = {_default: {
          get: function(tween) {
            var result;
            if (tween.elem[tween.prop] != null && (!tween.elem.style || tween.elem.style[tween.prop] == null)) {
              return tween.elem[tween.prop];
            }
            result = jQuery.css(tween.elem, tween.prop, "");
            return !result || result === "auto" ? 0 : result;
          },
          set: function(tween) {
            if (jQuery.fx.step[tween.prop]) {
              jQuery.fx.step[tween.prop](tween);
            } else if (tween.elem.style && (tween.elem.style[jQuery.cssProps[tween.prop]] != null || jQuery.cssHooks[tween.prop])) {
              jQuery.style(tween.elem, tween.prop, tween.now + tween.unit);
            } else {
              tween.elem[tween.prop] = tween.now;
            }
          }
        }};
      Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {set: function(tween) {
          if (tween.elem.nodeType && tween.elem.parentNode) {
            tween.elem[tween.prop] = tween.now;
          }
        }};
      jQuery.easing = {
        linear: function(p) {
          return p;
        },
        swing: function(p) {
          return 0.5 - Math.cos(p * Math.PI) / 2;
        }
      };
      jQuery.fx = Tween.prototype.init;
      jQuery.fx.step = {};
      var fxNow,
          timerId,
          rfxtypes = /^(?:toggle|show|hide)$/,
          rfxnum = new RegExp("^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i"),
          rrun = /queueHooks$/,
          animationPrefilters = [defaultPrefilter],
          tweeners = {"*": [function(prop, value) {
              var tween = this.createTween(prop, value),
                  target = tween.cur(),
                  parts = rfxnum.exec(value),
                  unit = parts && parts[3] || (jQuery.cssNumber[prop] ? "" : "px"),
                  start = (jQuery.cssNumber[prop] || unit !== "px" && +target) && rfxnum.exec(jQuery.css(tween.elem, prop)),
                  scale = 1,
                  maxIterations = 20;
              if (start && start[3] !== unit) {
                unit = unit || start[3];
                parts = parts || [];
                start = +target || 1;
                do {
                  scale = scale || ".5";
                  start = start / scale;
                  jQuery.style(tween.elem, prop, start + unit);
                } while (scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations);
              }
              if (parts) {
                start = tween.start = +start || +target || 0;
                tween.unit = unit;
                tween.end = parts[1] ? start + (parts[1] + 1) * parts[2] : +parts[2];
              }
              return tween;
            }]};
      function createFxNow() {
        setTimeout(function() {
          fxNow = undefined;
        });
        return (fxNow = jQuery.now());
      }
      function genFx(type, includeWidth) {
        var which,
            i = 0,
            attrs = {height: type};
        includeWidth = includeWidth ? 1 : 0;
        for (; i < 4; i += 2 - includeWidth) {
          which = cssExpand[i];
          attrs["margin" + which] = attrs["padding" + which] = type;
        }
        if (includeWidth) {
          attrs.opacity = attrs.width = type;
        }
        return attrs;
      }
      function createTween(value, prop, animation) {
        var tween,
            collection = (tweeners[prop] || []).concat(tweeners["*"]),
            index = 0,
            length = collection.length;
        for (; index < length; index++) {
          if ((tween = collection[index].call(animation, prop, value))) {
            return tween;
          }
        }
      }
      function defaultPrefilter(elem, props, opts) {
        var prop,
            value,
            toggle,
            tween,
            hooks,
            oldfire,
            display,
            checkDisplay,
            anim = this,
            orig = {},
            style = elem.style,
            hidden = elem.nodeType && isHidden(elem),
            dataShow = data_priv.get(elem, "fxshow");
        if (!opts.queue) {
          hooks = jQuery._queueHooks(elem, "fx");
          if (hooks.unqueued == null) {
            hooks.unqueued = 0;
            oldfire = hooks.empty.fire;
            hooks.empty.fire = function() {
              if (!hooks.unqueued) {
                oldfire();
              }
            };
          }
          hooks.unqueued++;
          anim.always(function() {
            anim.always(function() {
              hooks.unqueued--;
              if (!jQuery.queue(elem, "fx").length) {
                hooks.empty.fire();
              }
            });
          });
        }
        if (elem.nodeType === 1 && ("height" in props || "width" in props)) {
          opts.overflow = [style.overflow, style.overflowX, style.overflowY];
          display = jQuery.css(elem, "display");
          checkDisplay = display === "none" ? data_priv.get(elem, "olddisplay") || defaultDisplay(elem.nodeName) : display;
          if (checkDisplay === "inline" && jQuery.css(elem, "float") === "none") {
            style.display = "inline-block";
          }
        }
        if (opts.overflow) {
          style.overflow = "hidden";
          anim.always(function() {
            style.overflow = opts.overflow[0];
            style.overflowX = opts.overflow[1];
            style.overflowY = opts.overflow[2];
          });
        }
        for (prop in props) {
          value = props[prop];
          if (rfxtypes.exec(value)) {
            delete props[prop];
            toggle = toggle || value === "toggle";
            if (value === (hidden ? "hide" : "show")) {
              if (value === "show" && dataShow && dataShow[prop] !== undefined) {
                hidden = true;
              } else {
                continue;
              }
            }
            orig[prop] = dataShow && dataShow[prop] || jQuery.style(elem, prop);
          } else {
            display = undefined;
          }
        }
        if (!jQuery.isEmptyObject(orig)) {
          if (dataShow) {
            if ("hidden" in dataShow) {
              hidden = dataShow.hidden;
            }
          } else {
            dataShow = data_priv.access(elem, "fxshow", {});
          }
          if (toggle) {
            dataShow.hidden = !hidden;
          }
          if (hidden) {
            jQuery(elem).show();
          } else {
            anim.done(function() {
              jQuery(elem).hide();
            });
          }
          anim.done(function() {
            var prop;
            data_priv.remove(elem, "fxshow");
            for (prop in orig) {
              jQuery.style(elem, prop, orig[prop]);
            }
          });
          for (prop in orig) {
            tween = createTween(hidden ? dataShow[prop] : 0, prop, anim);
            if (!(prop in dataShow)) {
              dataShow[prop] = tween.start;
              if (hidden) {
                tween.end = tween.start;
                tween.start = prop === "width" || prop === "height" ? 1 : 0;
              }
            }
          }
        } else if ((display === "none" ? defaultDisplay(elem.nodeName) : display) === "inline") {
          style.display = display;
        }
      }
      function propFilter(props, specialEasing) {
        var index,
            name,
            easing,
            value,
            hooks;
        for (index in props) {
          name = jQuery.camelCase(index);
          easing = specialEasing[name];
          value = props[index];
          if (jQuery.isArray(value)) {
            easing = value[1];
            value = props[index] = value[0];
          }
          if (index !== name) {
            props[name] = value;
            delete props[index];
          }
          hooks = jQuery.cssHooks[name];
          if (hooks && "expand" in hooks) {
            value = hooks.expand(value);
            delete props[name];
            for (index in value) {
              if (!(index in props)) {
                props[index] = value[index];
                specialEasing[index] = easing;
              }
            }
          } else {
            specialEasing[name] = easing;
          }
        }
      }
      function Animation(elem, properties, options) {
        var result,
            stopped,
            index = 0,
            length = animationPrefilters.length,
            deferred = jQuery.Deferred().always(function() {
              delete tick.elem;
            }),
            tick = function() {
              if (stopped) {
                return false;
              }
              var currentTime = fxNow || createFxNow(),
                  remaining = Math.max(0, animation.startTime + animation.duration - currentTime),
                  temp = remaining / animation.duration || 0,
                  percent = 1 - temp,
                  index = 0,
                  length = animation.tweens.length;
              for (; index < length; index++) {
                animation.tweens[index].run(percent);
              }
              deferred.notifyWith(elem, [animation, percent, remaining]);
              if (percent < 1 && length) {
                return remaining;
              } else {
                deferred.resolveWith(elem, [animation]);
                return false;
              }
            },
            animation = deferred.promise({
              elem: elem,
              props: jQuery.extend({}, properties),
              opts: jQuery.extend(true, {specialEasing: {}}, options),
              originalProperties: properties,
              originalOptions: options,
              startTime: fxNow || createFxNow(),
              duration: options.duration,
              tweens: [],
              createTween: function(prop, end) {
                var tween = jQuery.Tween(elem, animation.opts, prop, end, animation.opts.specialEasing[prop] || animation.opts.easing);
                animation.tweens.push(tween);
                return tween;
              },
              stop: function(gotoEnd) {
                var index = 0,
                    length = gotoEnd ? animation.tweens.length : 0;
                if (stopped) {
                  return this;
                }
                stopped = true;
                for (; index < length; index++) {
                  animation.tweens[index].run(1);
                }
                if (gotoEnd) {
                  deferred.resolveWith(elem, [animation, gotoEnd]);
                } else {
                  deferred.rejectWith(elem, [animation, gotoEnd]);
                }
                return this;
              }
            }),
            props = animation.props;
        propFilter(props, animation.opts.specialEasing);
        for (; index < length; index++) {
          result = animationPrefilters[index].call(animation, elem, props, animation.opts);
          if (result) {
            return result;
          }
        }
        jQuery.map(props, createTween, animation);
        if (jQuery.isFunction(animation.opts.start)) {
          animation.opts.start.call(elem, animation);
        }
        jQuery.fx.timer(jQuery.extend(tick, {
          elem: elem,
          anim: animation,
          queue: animation.opts.queue
        }));
        return animation.progress(animation.opts.progress).done(animation.opts.done, animation.opts.complete).fail(animation.opts.fail).always(animation.opts.always);
      }
      jQuery.Animation = jQuery.extend(Animation, {
        tweener: function(props, callback) {
          if (jQuery.isFunction(props)) {
            callback = props;
            props = ["*"];
          } else {
            props = props.split(" ");
          }
          var prop,
              index = 0,
              length = props.length;
          for (; index < length; index++) {
            prop = props[index];
            tweeners[prop] = tweeners[prop] || [];
            tweeners[prop].unshift(callback);
          }
        },
        prefilter: function(callback, prepend) {
          if (prepend) {
            animationPrefilters.unshift(callback);
          } else {
            animationPrefilters.push(callback);
          }
        }
      });
      jQuery.speed = function(speed, easing, fn) {
        var opt = speed && typeof speed === "object" ? jQuery.extend({}, speed) : {
          complete: fn || !fn && easing || jQuery.isFunction(speed) && speed,
          duration: speed,
          easing: fn && easing || easing && !jQuery.isFunction(easing) && easing
        };
        opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration : opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[opt.duration] : jQuery.fx.speeds._default;
        if (opt.queue == null || opt.queue === true) {
          opt.queue = "fx";
        }
        opt.old = opt.complete;
        opt.complete = function() {
          if (jQuery.isFunction(opt.old)) {
            opt.old.call(this);
          }
          if (opt.queue) {
            jQuery.dequeue(this, opt.queue);
          }
        };
        return opt;
      };
      jQuery.fn.extend({
        fadeTo: function(speed, to, easing, callback) {
          return this.filter(isHidden).css("opacity", 0).show().end().animate({opacity: to}, speed, easing, callback);
        },
        animate: function(prop, speed, easing, callback) {
          var empty = jQuery.isEmptyObject(prop),
              optall = jQuery.speed(speed, easing, callback),
              doAnimation = function() {
                var anim = Animation(this, jQuery.extend({}, prop), optall);
                if (empty || data_priv.get(this, "finish")) {
                  anim.stop(true);
                }
              };
          doAnimation.finish = doAnimation;
          return empty || optall.queue === false ? this.each(doAnimation) : this.queue(optall.queue, doAnimation);
        },
        stop: function(type, clearQueue, gotoEnd) {
          var stopQueue = function(hooks) {
            var stop = hooks.stop;
            delete hooks.stop;
            stop(gotoEnd);
          };
          if (typeof type !== "string") {
            gotoEnd = clearQueue;
            clearQueue = type;
            type = undefined;
          }
          if (clearQueue && type !== false) {
            this.queue(type || "fx", []);
          }
          return this.each(function() {
            var dequeue = true,
                index = type != null && type + "queueHooks",
                timers = jQuery.timers,
                data = data_priv.get(this);
            if (index) {
              if (data[index] && data[index].stop) {
                stopQueue(data[index]);
              }
            } else {
              for (index in data) {
                if (data[index] && data[index].stop && rrun.test(index)) {
                  stopQueue(data[index]);
                }
              }
            }
            for (index = timers.length; index--; ) {
              if (timers[index].elem === this && (type == null || timers[index].queue === type)) {
                timers[index].anim.stop(gotoEnd);
                dequeue = false;
                timers.splice(index, 1);
              }
            }
            if (dequeue || !gotoEnd) {
              jQuery.dequeue(this, type);
            }
          });
        },
        finish: function(type) {
          if (type !== false) {
            type = type || "fx";
          }
          return this.each(function() {
            var index,
                data = data_priv.get(this),
                queue = data[type + "queue"],
                hooks = data[type + "queueHooks"],
                timers = jQuery.timers,
                length = queue ? queue.length : 0;
            data.finish = true;
            jQuery.queue(this, type, []);
            if (hooks && hooks.stop) {
              hooks.stop.call(this, true);
            }
            for (index = timers.length; index--; ) {
              if (timers[index].elem === this && timers[index].queue === type) {
                timers[index].anim.stop(true);
                timers.splice(index, 1);
              }
            }
            for (index = 0; index < length; index++) {
              if (queue[index] && queue[index].finish) {
                queue[index].finish.call(this);
              }
            }
            delete data.finish;
          });
        }
      });
      jQuery.each(["toggle", "show", "hide"], function(i, name) {
        var cssFn = jQuery.fn[name];
        jQuery.fn[name] = function(speed, easing, callback) {
          return speed == null || typeof speed === "boolean" ? cssFn.apply(this, arguments) : this.animate(genFx(name, true), speed, easing, callback);
        };
      });
      jQuery.each({
        slideDown: genFx("show"),
        slideUp: genFx("hide"),
        slideToggle: genFx("toggle"),
        fadeIn: {opacity: "show"},
        fadeOut: {opacity: "hide"},
        fadeToggle: {opacity: "toggle"}
      }, function(name, props) {
        jQuery.fn[name] = function(speed, easing, callback) {
          return this.animate(props, speed, easing, callback);
        };
      });
      jQuery.timers = [];
      jQuery.fx.tick = function() {
        var timer,
            i = 0,
            timers = jQuery.timers;
        fxNow = jQuery.now();
        for (; i < timers.length; i++) {
          timer = timers[i];
          if (!timer() && timers[i] === timer) {
            timers.splice(i--, 1);
          }
        }
        if (!timers.length) {
          jQuery.fx.stop();
        }
        fxNow = undefined;
      };
      jQuery.fx.timer = function(timer) {
        jQuery.timers.push(timer);
        if (timer()) {
          jQuery.fx.start();
        } else {
          jQuery.timers.pop();
        }
      };
      jQuery.fx.interval = 13;
      jQuery.fx.start = function() {
        if (!timerId) {
          timerId = setInterval(jQuery.fx.tick, jQuery.fx.interval);
        }
      };
      jQuery.fx.stop = function() {
        clearInterval(timerId);
        timerId = null;
      };
      jQuery.fx.speeds = {
        slow: 600,
        fast: 200,
        _default: 400
      };
      jQuery.fn.delay = function(time, type) {
        time = jQuery.fx ? jQuery.fx.speeds[time] || time : time;
        type = type || "fx";
        return this.queue(type, function(next, hooks) {
          var timeout = setTimeout(next, time);
          hooks.stop = function() {
            clearTimeout(timeout);
          };
        });
      };
      (function() {
        var input = document.createElement("input"),
            select = document.createElement("select"),
            opt = select.appendChild(document.createElement("option"));
        input.type = "checkbox";
        support.checkOn = input.value !== "";
        support.optSelected = opt.selected;
        select.disabled = true;
        support.optDisabled = !opt.disabled;
        input = document.createElement("input");
        input.value = "t";
        input.type = "radio";
        support.radioValue = input.value === "t";
      })();
      var nodeHook,
          boolHook,
          attrHandle = jQuery.expr.attrHandle;
      jQuery.fn.extend({
        attr: function(name, value) {
          return access(this, jQuery.attr, name, value, arguments.length > 1);
        },
        removeAttr: function(name) {
          return this.each(function() {
            jQuery.removeAttr(this, name);
          });
        }
      });
      jQuery.extend({
        attr: function(elem, name, value) {
          var hooks,
              ret,
              nType = elem.nodeType;
          if (!elem || nType === 3 || nType === 8 || nType === 2) {
            return;
          }
          if (typeof elem.getAttribute === strundefined) {
            return jQuery.prop(elem, name, value);
          }
          if (nType !== 1 || !jQuery.isXMLDoc(elem)) {
            name = name.toLowerCase();
            hooks = jQuery.attrHooks[name] || (jQuery.expr.match.bool.test(name) ? boolHook : nodeHook);
          }
          if (value !== undefined) {
            if (value === null) {
              jQuery.removeAttr(elem, name);
            } else if (hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined) {
              return ret;
            } else {
              elem.setAttribute(name, value + "");
              return value;
            }
          } else if (hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null) {
            return ret;
          } else {
            ret = jQuery.find.attr(elem, name);
            return ret == null ? undefined : ret;
          }
        },
        removeAttr: function(elem, value) {
          var name,
              propName,
              i = 0,
              attrNames = value && value.match(rnotwhite);
          if (attrNames && elem.nodeType === 1) {
            while ((name = attrNames[i++])) {
              propName = jQuery.propFix[name] || name;
              if (jQuery.expr.match.bool.test(name)) {
                elem[propName] = false;
              }
              elem.removeAttribute(name);
            }
          }
        },
        attrHooks: {type: {set: function(elem, value) {
              if (!support.radioValue && value === "radio" && jQuery.nodeName(elem, "input")) {
                var val = elem.value;
                elem.setAttribute("type", value);
                if (val) {
                  elem.value = val;
                }
                return value;
              }
            }}}
      });
      boolHook = {set: function(elem, value, name) {
          if (value === false) {
            jQuery.removeAttr(elem, name);
          } else {
            elem.setAttribute(name, name);
          }
          return name;
        }};
      jQuery.each(jQuery.expr.match.bool.source.match(/\w+/g), function(i, name) {
        var getter = attrHandle[name] || jQuery.find.attr;
        attrHandle[name] = function(elem, name, isXML) {
          var ret,
              handle;
          if (!isXML) {
            handle = attrHandle[name];
            attrHandle[name] = ret;
            ret = getter(elem, name, isXML) != null ? name.toLowerCase() : null;
            attrHandle[name] = handle;
          }
          return ret;
        };
      });
      var rfocusable = /^(?:input|select|textarea|button)$/i;
      jQuery.fn.extend({
        prop: function(name, value) {
          return access(this, jQuery.prop, name, value, arguments.length > 1);
        },
        removeProp: function(name) {
          return this.each(function() {
            delete this[jQuery.propFix[name] || name];
          });
        }
      });
      jQuery.extend({
        propFix: {
          "for": "htmlFor",
          "class": "className"
        },
        prop: function(elem, name, value) {
          var ret,
              hooks,
              notxml,
              nType = elem.nodeType;
          if (!elem || nType === 3 || nType === 8 || nType === 2) {
            return;
          }
          notxml = nType !== 1 || !jQuery.isXMLDoc(elem);
          if (notxml) {
            name = jQuery.propFix[name] || name;
            hooks = jQuery.propHooks[name];
          }
          if (value !== undefined) {
            return hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined ? ret : (elem[name] = value);
          } else {
            return hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null ? ret : elem[name];
          }
        },
        propHooks: {tabIndex: {get: function(elem) {
              return elem.hasAttribute("tabindex") || rfocusable.test(elem.nodeName) || elem.href ? elem.tabIndex : -1;
            }}}
      });
      if (!support.optSelected) {
        jQuery.propHooks.selected = {get: function(elem) {
            var parent = elem.parentNode;
            if (parent && parent.parentNode) {
              parent.parentNode.selectedIndex;
            }
            return null;
          }};
      }
      jQuery.each(["tabIndex", "readOnly", "maxLength", "cellSpacing", "cellPadding", "rowSpan", "colSpan", "useMap", "frameBorder", "contentEditable"], function() {
        jQuery.propFix[this.toLowerCase()] = this;
      });
      var rclass = /[\t\r\n\f]/g;
      jQuery.fn.extend({
        addClass: function(value) {
          var classes,
              elem,
              cur,
              clazz,
              j,
              finalValue,
              proceed = typeof value === "string" && value,
              i = 0,
              len = this.length;
          if (jQuery.isFunction(value)) {
            return this.each(function(j) {
              jQuery(this).addClass(value.call(this, j, this.className));
            });
          }
          if (proceed) {
            classes = (value || "").match(rnotwhite) || [];
            for (; i < len; i++) {
              elem = this[i];
              cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : " ");
              if (cur) {
                j = 0;
                while ((clazz = classes[j++])) {
                  if (cur.indexOf(" " + clazz + " ") < 0) {
                    cur += clazz + " ";
                  }
                }
                finalValue = jQuery.trim(cur);
                if (elem.className !== finalValue) {
                  elem.className = finalValue;
                }
              }
            }
          }
          return this;
        },
        removeClass: function(value) {
          var classes,
              elem,
              cur,
              clazz,
              j,
              finalValue,
              proceed = arguments.length === 0 || typeof value === "string" && value,
              i = 0,
              len = this.length;
          if (jQuery.isFunction(value)) {
            return this.each(function(j) {
              jQuery(this).removeClass(value.call(this, j, this.className));
            });
          }
          if (proceed) {
            classes = (value || "").match(rnotwhite) || [];
            for (; i < len; i++) {
              elem = this[i];
              cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : "");
              if (cur) {
                j = 0;
                while ((clazz = classes[j++])) {
                  while (cur.indexOf(" " + clazz + " ") >= 0) {
                    cur = cur.replace(" " + clazz + " ", " ");
                  }
                }
                finalValue = value ? jQuery.trim(cur) : "";
                if (elem.className !== finalValue) {
                  elem.className = finalValue;
                }
              }
            }
          }
          return this;
        },
        toggleClass: function(value, stateVal) {
          var type = typeof value;
          if (typeof stateVal === "boolean" && type === "string") {
            return stateVal ? this.addClass(value) : this.removeClass(value);
          }
          if (jQuery.isFunction(value)) {
            return this.each(function(i) {
              jQuery(this).toggleClass(value.call(this, i, this.className, stateVal), stateVal);
            });
          }
          return this.each(function() {
            if (type === "string") {
              var className,
                  i = 0,
                  self = jQuery(this),
                  classNames = value.match(rnotwhite) || [];
              while ((className = classNames[i++])) {
                if (self.hasClass(className)) {
                  self.removeClass(className);
                } else {
                  self.addClass(className);
                }
              }
            } else if (type === strundefined || type === "boolean") {
              if (this.className) {
                data_priv.set(this, "__className__", this.className);
              }
              this.className = this.className || value === false ? "" : data_priv.get(this, "__className__") || "";
            }
          });
        },
        hasClass: function(selector) {
          var className = " " + selector + " ",
              i = 0,
              l = this.length;
          for (; i < l; i++) {
            if (this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf(className) >= 0) {
              return true;
            }
          }
          return false;
        }
      });
      var rreturn = /\r/g;
      jQuery.fn.extend({val: function(value) {
          var hooks,
              ret,
              isFunction,
              elem = this[0];
          if (!arguments.length) {
            if (elem) {
              hooks = jQuery.valHooks[elem.type] || jQuery.valHooks[elem.nodeName.toLowerCase()];
              if (hooks && "get" in hooks && (ret = hooks.get(elem, "value")) !== undefined) {
                return ret;
              }
              ret = elem.value;
              return typeof ret === "string" ? ret.replace(rreturn, "") : ret == null ? "" : ret;
            }
            return;
          }
          isFunction = jQuery.isFunction(value);
          return this.each(function(i) {
            var val;
            if (this.nodeType !== 1) {
              return;
            }
            if (isFunction) {
              val = value.call(this, i, jQuery(this).val());
            } else {
              val = value;
            }
            if (val == null) {
              val = "";
            } else if (typeof val === "number") {
              val += "";
            } else if (jQuery.isArray(val)) {
              val = jQuery.map(val, function(value) {
                return value == null ? "" : value + "";
              });
            }
            hooks = jQuery.valHooks[this.type] || jQuery.valHooks[this.nodeName.toLowerCase()];
            if (!hooks || !("set" in hooks) || hooks.set(this, val, "value") === undefined) {
              this.value = val;
            }
          });
        }});
      jQuery.extend({valHooks: {
          option: {get: function(elem) {
              var val = jQuery.find.attr(elem, "value");
              return val != null ? val : jQuery.trim(jQuery.text(elem));
            }},
          select: {
            get: function(elem) {
              var value,
                  option,
                  options = elem.options,
                  index = elem.selectedIndex,
                  one = elem.type === "select-one" || index < 0,
                  values = one ? null : [],
                  max = one ? index + 1 : options.length,
                  i = index < 0 ? max : one ? index : 0;
              for (; i < max; i++) {
                option = options[i];
                if ((option.selected || i === index) && (support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null) && (!option.parentNode.disabled || !jQuery.nodeName(option.parentNode, "optgroup"))) {
                  value = jQuery(option).val();
                  if (one) {
                    return value;
                  }
                  values.push(value);
                }
              }
              return values;
            },
            set: function(elem, value) {
              var optionSet,
                  option,
                  options = elem.options,
                  values = jQuery.makeArray(value),
                  i = options.length;
              while (i--) {
                option = options[i];
                if ((option.selected = jQuery.inArray(option.value, values) >= 0)) {
                  optionSet = true;
                }
              }
              if (!optionSet) {
                elem.selectedIndex = -1;
              }
              return values;
            }
          }
        }});
      jQuery.each(["radio", "checkbox"], function() {
        jQuery.valHooks[this] = {set: function(elem, value) {
            if (jQuery.isArray(value)) {
              return (elem.checked = jQuery.inArray(jQuery(elem).val(), value) >= 0);
            }
          }};
        if (!support.checkOn) {
          jQuery.valHooks[this].get = function(elem) {
            return elem.getAttribute("value") === null ? "on" : elem.value;
          };
        }
      });
      jQuery.each(("blur focus focusin focusout load resize scroll unload click dblclick " + "mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " + "change select submit keydown keypress keyup error contextmenu").split(" "), function(i, name) {
        jQuery.fn[name] = function(data, fn) {
          return arguments.length > 0 ? this.on(name, null, data, fn) : this.trigger(name);
        };
      });
      jQuery.fn.extend({
        hover: function(fnOver, fnOut) {
          return this.mouseenter(fnOver).mouseleave(fnOut || fnOver);
        },
        bind: function(types, data, fn) {
          return this.on(types, null, data, fn);
        },
        unbind: function(types, fn) {
          return this.off(types, null, fn);
        },
        delegate: function(selector, types, data, fn) {
          return this.on(types, selector, data, fn);
        },
        undelegate: function(selector, types, fn) {
          return arguments.length === 1 ? this.off(selector, "**") : this.off(types, selector || "**", fn);
        }
      });
      var nonce = jQuery.now();
      var rquery = (/\?/);
      jQuery.parseJSON = function(data) {
        return JSON.parse(data + "");
      };
      jQuery.parseXML = function(data) {
        var xml,
            tmp;
        if (!data || typeof data !== "string") {
          return null;
        }
        try {
          tmp = new DOMParser();
          xml = tmp.parseFromString(data, "text/xml");
        } catch (e) {
          xml = undefined;
        }
        if (!xml || xml.getElementsByTagName("parsererror").length) {
          jQuery.error("Invalid XML: " + data);
        }
        return xml;
      };
      var rhash = /#.*$/,
          rts = /([?&])_=[^&]*/,
          rheaders = /^(.*?):[ \t]*([^\r\n]*)$/mg,
          rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
          rnoContent = /^(?:GET|HEAD)$/,
          rprotocol = /^\/\//,
          rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,
          prefilters = {},
          transports = {},
          allTypes = "*/".concat("*"),
          ajaxLocation = window.location.href,
          ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || [];
      function addToPrefiltersOrTransports(structure) {
        return function(dataTypeExpression, func) {
          if (typeof dataTypeExpression !== "string") {
            func = dataTypeExpression;
            dataTypeExpression = "*";
          }
          var dataType,
              i = 0,
              dataTypes = dataTypeExpression.toLowerCase().match(rnotwhite) || [];
          if (jQuery.isFunction(func)) {
            while ((dataType = dataTypes[i++])) {
              if (dataType[0] === "+") {
                dataType = dataType.slice(1) || "*";
                (structure[dataType] = structure[dataType] || []).unshift(func);
              } else {
                (structure[dataType] = structure[dataType] || []).push(func);
              }
            }
          }
        };
      }
      function inspectPrefiltersOrTransports(structure, options, originalOptions, jqXHR) {
        var inspected = {},
            seekingTransport = (structure === transports);
        function inspect(dataType) {
          var selected;
          inspected[dataType] = true;
          jQuery.each(structure[dataType] || [], function(_, prefilterOrFactory) {
            var dataTypeOrTransport = prefilterOrFactory(options, originalOptions, jqXHR);
            if (typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[dataTypeOrTransport]) {
              options.dataTypes.unshift(dataTypeOrTransport);
              inspect(dataTypeOrTransport);
              return false;
            } else if (seekingTransport) {
              return !(selected = dataTypeOrTransport);
            }
          });
          return selected;
        }
        return inspect(options.dataTypes[0]) || !inspected["*"] && inspect("*");
      }
      function ajaxExtend(target, src) {
        var key,
            deep,
            flatOptions = jQuery.ajaxSettings.flatOptions || {};
        for (key in src) {
          if (src[key] !== undefined) {
            (flatOptions[key] ? target : (deep || (deep = {})))[key] = src[key];
          }
        }
        if (deep) {
          jQuery.extend(true, target, deep);
        }
        return target;
      }
      function ajaxHandleResponses(s, jqXHR, responses) {
        var ct,
            type,
            finalDataType,
            firstDataType,
            contents = s.contents,
            dataTypes = s.dataTypes;
        while (dataTypes[0] === "*") {
          dataTypes.shift();
          if (ct === undefined) {
            ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
          }
        }
        if (ct) {
          for (type in contents) {
            if (contents[type] && contents[type].test(ct)) {
              dataTypes.unshift(type);
              break;
            }
          }
        }
        if (dataTypes[0] in responses) {
          finalDataType = dataTypes[0];
        } else {
          for (type in responses) {
            if (!dataTypes[0] || s.converters[type + " " + dataTypes[0]]) {
              finalDataType = type;
              break;
            }
            if (!firstDataType) {
              firstDataType = type;
            }
          }
          finalDataType = finalDataType || firstDataType;
        }
        if (finalDataType) {
          if (finalDataType !== dataTypes[0]) {
            dataTypes.unshift(finalDataType);
          }
          return responses[finalDataType];
        }
      }
      function ajaxConvert(s, response, jqXHR, isSuccess) {
        var conv2,
            current,
            conv,
            tmp,
            prev,
            converters = {},
            dataTypes = s.dataTypes.slice();
        if (dataTypes[1]) {
          for (conv in s.converters) {
            converters[conv.toLowerCase()] = s.converters[conv];
          }
        }
        current = dataTypes.shift();
        while (current) {
          if (s.responseFields[current]) {
            jqXHR[s.responseFields[current]] = response;
          }
          if (!prev && isSuccess && s.dataFilter) {
            response = s.dataFilter(response, s.dataType);
          }
          prev = current;
          current = dataTypes.shift();
          if (current) {
            if (current === "*") {
              current = prev;
            } else if (prev !== "*" && prev !== current) {
              conv = converters[prev + " " + current] || converters["* " + current];
              if (!conv) {
                for (conv2 in converters) {
                  tmp = conv2.split(" ");
                  if (tmp[1] === current) {
                    conv = converters[prev + " " + tmp[0]] || converters["* " + tmp[0]];
                    if (conv) {
                      if (conv === true) {
                        conv = converters[conv2];
                      } else if (converters[conv2] !== true) {
                        current = tmp[0];
                        dataTypes.unshift(tmp[1]);
                      }
                      break;
                    }
                  }
                }
              }
              if (conv !== true) {
                if (conv && s["throws"]) {
                  response = conv(response);
                } else {
                  try {
                    response = conv(response);
                  } catch (e) {
                    return {
                      state: "parsererror",
                      error: conv ? e : "No conversion from " + prev + " to " + current
                    };
                  }
                }
              }
            }
          }
        }
        return {
          state: "success",
          data: response
        };
      }
      jQuery.extend({
        active: 0,
        lastModified: {},
        etag: {},
        ajaxSettings: {
          url: ajaxLocation,
          type: "GET",
          isLocal: rlocalProtocol.test(ajaxLocParts[1]),
          global: true,
          processData: true,
          async: true,
          contentType: "application/x-www-form-urlencoded; charset=UTF-8",
          accepts: {
            "*": allTypes,
            text: "text/plain",
            html: "text/html",
            xml: "application/xml, text/xml",
            json: "application/json, text/javascript"
          },
          contents: {
            xml: /xml/,
            html: /html/,
            json: /json/
          },
          responseFields: {
            xml: "responseXML",
            text: "responseText",
            json: "responseJSON"
          },
          converters: {
            "* text": String,
            "text html": true,
            "text json": jQuery.parseJSON,
            "text xml": jQuery.parseXML
          },
          flatOptions: {
            url: true,
            context: true
          }
        },
        ajaxSetup: function(target, settings) {
          return settings ? ajaxExtend(ajaxExtend(target, jQuery.ajaxSettings), settings) : ajaxExtend(jQuery.ajaxSettings, target);
        },
        ajaxPrefilter: addToPrefiltersOrTransports(prefilters),
        ajaxTransport: addToPrefiltersOrTransports(transports),
        ajax: function(url, options) {
          if (typeof url === "object") {
            options = url;
            url = undefined;
          }
          options = options || {};
          var transport,
              cacheURL,
              responseHeadersString,
              responseHeaders,
              timeoutTimer,
              parts,
              fireGlobals,
              i,
              s = jQuery.ajaxSetup({}, options),
              callbackContext = s.context || s,
              globalEventContext = s.context && (callbackContext.nodeType || callbackContext.jquery) ? jQuery(callbackContext) : jQuery.event,
              deferred = jQuery.Deferred(),
              completeDeferred = jQuery.Callbacks("once memory"),
              statusCode = s.statusCode || {},
              requestHeaders = {},
              requestHeadersNames = {},
              state = 0,
              strAbort = "canceled",
              jqXHR = {
                readyState: 0,
                getResponseHeader: function(key) {
                  var match;
                  if (state === 2) {
                    if (!responseHeaders) {
                      responseHeaders = {};
                      while ((match = rheaders.exec(responseHeadersString))) {
                        responseHeaders[match[1].toLowerCase()] = match[2];
                      }
                    }
                    match = responseHeaders[key.toLowerCase()];
                  }
                  return match == null ? null : match;
                },
                getAllResponseHeaders: function() {
                  return state === 2 ? responseHeadersString : null;
                },
                setRequestHeader: function(name, value) {
                  var lname = name.toLowerCase();
                  if (!state) {
                    name = requestHeadersNames[lname] = requestHeadersNames[lname] || name;
                    requestHeaders[name] = value;
                  }
                  return this;
                },
                overrideMimeType: function(type) {
                  if (!state) {
                    s.mimeType = type;
                  }
                  return this;
                },
                statusCode: function(map) {
                  var code;
                  if (map) {
                    if (state < 2) {
                      for (code in map) {
                        statusCode[code] = [statusCode[code], map[code]];
                      }
                    } else {
                      jqXHR.always(map[jqXHR.status]);
                    }
                  }
                  return this;
                },
                abort: function(statusText) {
                  var finalText = statusText || strAbort;
                  if (transport) {
                    transport.abort(finalText);
                  }
                  done(0, finalText);
                  return this;
                }
              };
          deferred.promise(jqXHR).complete = completeDeferred.add;
          jqXHR.success = jqXHR.done;
          jqXHR.error = jqXHR.fail;
          s.url = ((url || s.url || ajaxLocation) + "").replace(rhash, "").replace(rprotocol, ajaxLocParts[1] + "//");
          s.type = options.method || options.type || s.method || s.type;
          s.dataTypes = jQuery.trim(s.dataType || "*").toLowerCase().match(rnotwhite) || [""];
          if (s.crossDomain == null) {
            parts = rurl.exec(s.url.toLowerCase());
            s.crossDomain = !!(parts && (parts[1] !== ajaxLocParts[1] || parts[2] !== ajaxLocParts[2] || (parts[3] || (parts[1] === "http:" ? "80" : "443")) !== (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? "80" : "443"))));
          }
          if (s.data && s.processData && typeof s.data !== "string") {
            s.data = jQuery.param(s.data, s.traditional);
          }
          inspectPrefiltersOrTransports(prefilters, s, options, jqXHR);
          if (state === 2) {
            return jqXHR;
          }
          fireGlobals = jQuery.event && s.global;
          if (fireGlobals && jQuery.active++ === 0) {
            jQuery.event.trigger("ajaxStart");
          }
          s.type = s.type.toUpperCase();
          s.hasContent = !rnoContent.test(s.type);
          cacheURL = s.url;
          if (!s.hasContent) {
            if (s.data) {
              cacheURL = (s.url += (rquery.test(cacheURL) ? "&" : "?") + s.data);
              delete s.data;
            }
            if (s.cache === false) {
              s.url = rts.test(cacheURL) ? cacheURL.replace(rts, "$1_=" + nonce++) : cacheURL + (rquery.test(cacheURL) ? "&" : "?") + "_=" + nonce++;
            }
          }
          if (s.ifModified) {
            if (jQuery.lastModified[cacheURL]) {
              jqXHR.setRequestHeader("If-Modified-Since", jQuery.lastModified[cacheURL]);
            }
            if (jQuery.etag[cacheURL]) {
              jqXHR.setRequestHeader("If-None-Match", jQuery.etag[cacheURL]);
            }
          }
          if (s.data && s.hasContent && s.contentType !== false || options.contentType) {
            jqXHR.setRequestHeader("Content-Type", s.contentType);
          }
          jqXHR.setRequestHeader("Accept", s.dataTypes[0] && s.accepts[s.dataTypes[0]] ? s.accepts[s.dataTypes[0]] + (s.dataTypes[0] !== "*" ? ", " + allTypes + "; q=0.01" : "") : s.accepts["*"]);
          for (i in s.headers) {
            jqXHR.setRequestHeader(i, s.headers[i]);
          }
          if (s.beforeSend && (s.beforeSend.call(callbackContext, jqXHR, s) === false || state === 2)) {
            return jqXHR.abort();
          }
          strAbort = "abort";
          for (i in {
            success: 1,
            error: 1,
            complete: 1
          }) {
            jqXHR[i](s[i]);
          }
          transport = inspectPrefiltersOrTransports(transports, s, options, jqXHR);
          if (!transport) {
            done(-1, "No Transport");
          } else {
            jqXHR.readyState = 1;
            if (fireGlobals) {
              globalEventContext.trigger("ajaxSend", [jqXHR, s]);
            }
            if (s.async && s.timeout > 0) {
              timeoutTimer = setTimeout(function() {
                jqXHR.abort("timeout");
              }, s.timeout);
            }
            try {
              state = 1;
              transport.send(requestHeaders, done);
            } catch (e) {
              if (state < 2) {
                done(-1, e);
              } else {
                throw e;
              }
            }
          }
          function done(status, nativeStatusText, responses, headers) {
            var isSuccess,
                success,
                error,
                response,
                modified,
                statusText = nativeStatusText;
            if (state === 2) {
              return;
            }
            state = 2;
            if (timeoutTimer) {
              clearTimeout(timeoutTimer);
            }
            transport = undefined;
            responseHeadersString = headers || "";
            jqXHR.readyState = status > 0 ? 4 : 0;
            isSuccess = status >= 200 && status < 300 || status === 304;
            if (responses) {
              response = ajaxHandleResponses(s, jqXHR, responses);
            }
            response = ajaxConvert(s, response, jqXHR, isSuccess);
            if (isSuccess) {
              if (s.ifModified) {
                modified = jqXHR.getResponseHeader("Last-Modified");
                if (modified) {
                  jQuery.lastModified[cacheURL] = modified;
                }
                modified = jqXHR.getResponseHeader("etag");
                if (modified) {
                  jQuery.etag[cacheURL] = modified;
                }
              }
              if (status === 204 || s.type === "HEAD") {
                statusText = "nocontent";
              } else if (status === 304) {
                statusText = "notmodified";
              } else {
                statusText = response.state;
                success = response.data;
                error = response.error;
                isSuccess = !error;
              }
            } else {
              error = statusText;
              if (status || !statusText) {
                statusText = "error";
                if (status < 0) {
                  status = 0;
                }
              }
            }
            jqXHR.status = status;
            jqXHR.statusText = (nativeStatusText || statusText) + "";
            if (isSuccess) {
              deferred.resolveWith(callbackContext, [success, statusText, jqXHR]);
            } else {
              deferred.rejectWith(callbackContext, [jqXHR, statusText, error]);
            }
            jqXHR.statusCode(statusCode);
            statusCode = undefined;
            if (fireGlobals) {
              globalEventContext.trigger(isSuccess ? "ajaxSuccess" : "ajaxError", [jqXHR, s, isSuccess ? success : error]);
            }
            completeDeferred.fireWith(callbackContext, [jqXHR, statusText]);
            if (fireGlobals) {
              globalEventContext.trigger("ajaxComplete", [jqXHR, s]);
              if (!(--jQuery.active)) {
                jQuery.event.trigger("ajaxStop");
              }
            }
          }
          return jqXHR;
        },
        getJSON: function(url, data, callback) {
          return jQuery.get(url, data, callback, "json");
        },
        getScript: function(url, callback) {
          return jQuery.get(url, undefined, callback, "script");
        }
      });
      jQuery.each(["get", "post"], function(i, method) {
        jQuery[method] = function(url, data, callback, type) {
          if (jQuery.isFunction(data)) {
            type = type || callback;
            callback = data;
            data = undefined;
          }
          return jQuery.ajax({
            url: url,
            type: method,
            dataType: type,
            data: data,
            success: callback
          });
        };
      });
      jQuery._evalUrl = function(url) {
        return jQuery.ajax({
          url: url,
          type: "GET",
          dataType: "script",
          async: false,
          global: false,
          "throws": true
        });
      };
      jQuery.fn.extend({
        wrapAll: function(html) {
          var wrap;
          if (jQuery.isFunction(html)) {
            return this.each(function(i) {
              jQuery(this).wrapAll(html.call(this, i));
            });
          }
          if (this[0]) {
            wrap = jQuery(html, this[0].ownerDocument).eq(0).clone(true);
            if (this[0].parentNode) {
              wrap.insertBefore(this[0]);
            }
            wrap.map(function() {
              var elem = this;
              while (elem.firstElementChild) {
                elem = elem.firstElementChild;
              }
              return elem;
            }).append(this);
          }
          return this;
        },
        wrapInner: function(html) {
          if (jQuery.isFunction(html)) {
            return this.each(function(i) {
              jQuery(this).wrapInner(html.call(this, i));
            });
          }
          return this.each(function() {
            var self = jQuery(this),
                contents = self.contents();
            if (contents.length) {
              contents.wrapAll(html);
            } else {
              self.append(html);
            }
          });
        },
        wrap: function(html) {
          var isFunction = jQuery.isFunction(html);
          return this.each(function(i) {
            jQuery(this).wrapAll(isFunction ? html.call(this, i) : html);
          });
        },
        unwrap: function() {
          return this.parent().each(function() {
            if (!jQuery.nodeName(this, "body")) {
              jQuery(this).replaceWith(this.childNodes);
            }
          }).end();
        }
      });
      jQuery.expr.filters.hidden = function(elem) {
        return elem.offsetWidth <= 0 && elem.offsetHeight <= 0;
      };
      jQuery.expr.filters.visible = function(elem) {
        return !jQuery.expr.filters.hidden(elem);
      };
      var r20 = /%20/g,
          rbracket = /\[\]$/,
          rCRLF = /\r?\n/g,
          rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
          rsubmittable = /^(?:input|select|textarea|keygen)/i;
      function buildParams(prefix, obj, traditional, add) {
        var name;
        if (jQuery.isArray(obj)) {
          jQuery.each(obj, function(i, v) {
            if (traditional || rbracket.test(prefix)) {
              add(prefix, v);
            } else {
              buildParams(prefix + "[" + (typeof v === "object" ? i : "") + "]", v, traditional, add);
            }
          });
        } else if (!traditional && jQuery.type(obj) === "object") {
          for (name in obj) {
            buildParams(prefix + "[" + name + "]", obj[name], traditional, add);
          }
        } else {
          add(prefix, obj);
        }
      }
      jQuery.param = function(a, traditional) {
        var prefix,
            s = [],
            add = function(key, value) {
              value = jQuery.isFunction(value) ? value() : (value == null ? "" : value);
              s[s.length] = encodeURIComponent(key) + "=" + encodeURIComponent(value);
            };
        if (traditional === undefined) {
          traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
        }
        if (jQuery.isArray(a) || (a.jquery && !jQuery.isPlainObject(a))) {
          jQuery.each(a, function() {
            add(this.name, this.value);
          });
        } else {
          for (prefix in a) {
            buildParams(prefix, a[prefix], traditional, add);
          }
        }
        return s.join("&").replace(r20, "+");
      };
      jQuery.fn.extend({
        serialize: function() {
          return jQuery.param(this.serializeArray());
        },
        serializeArray: function() {
          return this.map(function() {
            var elements = jQuery.prop(this, "elements");
            return elements ? jQuery.makeArray(elements) : this;
          }).filter(function() {
            var type = this.type;
            return this.name && !jQuery(this).is(":disabled") && rsubmittable.test(this.nodeName) && !rsubmitterTypes.test(type) && (this.checked || !rcheckableType.test(type));
          }).map(function(i, elem) {
            var val = jQuery(this).val();
            return val == null ? null : jQuery.isArray(val) ? jQuery.map(val, function(val) {
              return {
                name: elem.name,
                value: val.replace(rCRLF, "\r\n")
              };
            }) : {
              name: elem.name,
              value: val.replace(rCRLF, "\r\n")
            };
          }).get();
        }
      });
      jQuery.ajaxSettings.xhr = function() {
        try {
          return new XMLHttpRequest();
        } catch (e) {}
      };
      var xhrId = 0,
          xhrCallbacks = {},
          xhrSuccessStatus = {
            0: 200,
            1223: 204
          },
          xhrSupported = jQuery.ajaxSettings.xhr();
      if (window.attachEvent) {
        window.attachEvent("onunload", function() {
          for (var key in xhrCallbacks) {
            xhrCallbacks[key]();
          }
        });
      }
      support.cors = !!xhrSupported && ("withCredentials" in xhrSupported);
      support.ajax = xhrSupported = !!xhrSupported;
      jQuery.ajaxTransport(function(options) {
        var callback;
        if (support.cors || xhrSupported && !options.crossDomain) {
          return {
            send: function(headers, complete) {
              var i,
                  xhr = options.xhr(),
                  id = ++xhrId;
              xhr.open(options.type, options.url, options.async, options.username, options.password);
              if (options.xhrFields) {
                for (i in options.xhrFields) {
                  xhr[i] = options.xhrFields[i];
                }
              }
              if (options.mimeType && xhr.overrideMimeType) {
                xhr.overrideMimeType(options.mimeType);
              }
              if (!options.crossDomain && !headers["X-Requested-With"]) {
                headers["X-Requested-With"] = "XMLHttpRequest";
              }
              for (i in headers) {
                xhr.setRequestHeader(i, headers[i]);
              }
              callback = function(type) {
                return function() {
                  if (callback) {
                    delete xhrCallbacks[id];
                    callback = xhr.onload = xhr.onerror = null;
                    if (type === "abort") {
                      xhr.abort();
                    } else if (type === "error") {
                      complete(xhr.status, xhr.statusText);
                    } else {
                      complete(xhrSuccessStatus[xhr.status] || xhr.status, xhr.statusText, typeof xhr.responseText === "string" ? {text: xhr.responseText} : undefined, xhr.getAllResponseHeaders());
                    }
                  }
                };
              };
              xhr.onload = callback();
              xhr.onerror = callback("error");
              callback = xhrCallbacks[id] = callback("abort");
              try {
                xhr.send(options.hasContent && options.data || null);
              } catch (e) {
                if (callback) {
                  throw e;
                }
              }
            },
            abort: function() {
              if (callback) {
                callback();
              }
            }
          };
        }
      });
      jQuery.ajaxSetup({
        accepts: {script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},
        contents: {script: /(?:java|ecma)script/},
        converters: {"text script": function(text) {
            jQuery.globalEval(text);
            return text;
          }}
      });
      jQuery.ajaxPrefilter("script", function(s) {
        if (s.cache === undefined) {
          s.cache = false;
        }
        if (s.crossDomain) {
          s.type = "GET";
        }
      });
      jQuery.ajaxTransport("script", function(s) {
        if (s.crossDomain) {
          var script,
              callback;
          return {
            send: function(_, complete) {
              script = jQuery("<script>").prop({
                async: true,
                charset: s.scriptCharset,
                src: s.url
              }).on("load error", callback = function(evt) {
                script.remove();
                callback = null;
                if (evt) {
                  complete(evt.type === "error" ? 404 : 200, evt.type);
                }
              });
              document.head.appendChild(script[0]);
            },
            abort: function() {
              if (callback) {
                callback();
              }
            }
          };
        }
      });
      var oldCallbacks = [],
          rjsonp = /(=)\?(?=&|$)|\?\?/;
      jQuery.ajaxSetup({
        jsonp: "callback",
        jsonpCallback: function() {
          var callback = oldCallbacks.pop() || (jQuery.expando + "_" + (nonce++));
          this[callback] = true;
          return callback;
        }
      });
      jQuery.ajaxPrefilter("json jsonp", function(s, originalSettings, jqXHR) {
        var callbackName,
            overwritten,
            responseContainer,
            jsonProp = s.jsonp !== false && (rjsonp.test(s.url) ? "url" : typeof s.data === "string" && !(s.contentType || "").indexOf("application/x-www-form-urlencoded") && rjsonp.test(s.data) && "data");
        if (jsonProp || s.dataTypes[0] === "jsonp") {
          callbackName = s.jsonpCallback = jQuery.isFunction(s.jsonpCallback) ? s.jsonpCallback() : s.jsonpCallback;
          if (jsonProp) {
            s[jsonProp] = s[jsonProp].replace(rjsonp, "$1" + callbackName);
          } else if (s.jsonp !== false) {
            s.url += (rquery.test(s.url) ? "&" : "?") + s.jsonp + "=" + callbackName;
          }
          s.converters["script json"] = function() {
            if (!responseContainer) {
              jQuery.error(callbackName + " was not called");
            }
            return responseContainer[0];
          };
          s.dataTypes[0] = "json";
          overwritten = window[callbackName];
          window[callbackName] = function() {
            responseContainer = arguments;
          };
          jqXHR.always(function() {
            window[callbackName] = overwritten;
            if (s[callbackName]) {
              s.jsonpCallback = originalSettings.jsonpCallback;
              oldCallbacks.push(callbackName);
            }
            if (responseContainer && jQuery.isFunction(overwritten)) {
              overwritten(responseContainer[0]);
            }
            responseContainer = overwritten = undefined;
          });
          return "script";
        }
      });
      jQuery.parseHTML = function(data, context, keepScripts) {
        if (!data || typeof data !== "string") {
          return null;
        }
        if (typeof context === "boolean") {
          keepScripts = context;
          context = false;
        }
        context = context || document;
        var parsed = rsingleTag.exec(data),
            scripts = !keepScripts && [];
        if (parsed) {
          return [context.createElement(parsed[1])];
        }
        parsed = jQuery.buildFragment([data], context, scripts);
        if (scripts && scripts.length) {
          jQuery(scripts).remove();
        }
        return jQuery.merge([], parsed.childNodes);
      };
      var _load = jQuery.fn.load;
      jQuery.fn.load = function(url, params, callback) {
        if (typeof url !== "string" && _load) {
          return _load.apply(this, arguments);
        }
        var selector,
            type,
            response,
            self = this,
            off = url.indexOf(" ");
        if (off >= 0) {
          selector = jQuery.trim(url.slice(off));
          url = url.slice(0, off);
        }
        if (jQuery.isFunction(params)) {
          callback = params;
          params = undefined;
        } else if (params && typeof params === "object") {
          type = "POST";
        }
        if (self.length > 0) {
          jQuery.ajax({
            url: url,
            type: type,
            dataType: "html",
            data: params
          }).done(function(responseText) {
            response = arguments;
            self.html(selector ? jQuery("<div>").append(jQuery.parseHTML(responseText)).find(selector) : responseText);
          }).complete(callback && function(jqXHR, status) {
            self.each(callback, response || [jqXHR.responseText, status, jqXHR]);
          });
        }
        return this;
      };
      jQuery.each(["ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend"], function(i, type) {
        jQuery.fn[type] = function(fn) {
          return this.on(type, fn);
        };
      });
      jQuery.expr.filters.animated = function(elem) {
        return jQuery.grep(jQuery.timers, function(fn) {
          return elem === fn.elem;
        }).length;
      };
      var docElem = window.document.documentElement;
      function getWindow(elem) {
        return jQuery.isWindow(elem) ? elem : elem.nodeType === 9 && elem.defaultView;
      }
      jQuery.offset = {setOffset: function(elem, options, i) {
          var curPosition,
              curLeft,
              curCSSTop,
              curTop,
              curOffset,
              curCSSLeft,
              calculatePosition,
              position = jQuery.css(elem, "position"),
              curElem = jQuery(elem),
              props = {};
          if (position === "static") {
            elem.style.position = "relative";
          }
          curOffset = curElem.offset();
          curCSSTop = jQuery.css(elem, "top");
          curCSSLeft = jQuery.css(elem, "left");
          calculatePosition = (position === "absolute" || position === "fixed") && (curCSSTop + curCSSLeft).indexOf("auto") > -1;
          if (calculatePosition) {
            curPosition = curElem.position();
            curTop = curPosition.top;
            curLeft = curPosition.left;
          } else {
            curTop = parseFloat(curCSSTop) || 0;
            curLeft = parseFloat(curCSSLeft) || 0;
          }
          if (jQuery.isFunction(options)) {
            options = options.call(elem, i, curOffset);
          }
          if (options.top != null) {
            props.top = (options.top - curOffset.top) + curTop;
          }
          if (options.left != null) {
            props.left = (options.left - curOffset.left) + curLeft;
          }
          if ("using" in options) {
            options.using.call(elem, props);
          } else {
            curElem.css(props);
          }
        }};
      jQuery.fn.extend({
        offset: function(options) {
          if (arguments.length) {
            return options === undefined ? this : this.each(function(i) {
              jQuery.offset.setOffset(this, options, i);
            });
          }
          var docElem,
              win,
              elem = this[0],
              box = {
                top: 0,
                left: 0
              },
              doc = elem && elem.ownerDocument;
          if (!doc) {
            return;
          }
          docElem = doc.documentElement;
          if (!jQuery.contains(docElem, elem)) {
            return box;
          }
          if (typeof elem.getBoundingClientRect !== strundefined) {
            box = elem.getBoundingClientRect();
          }
          win = getWindow(doc);
          return {
            top: box.top + win.pageYOffset - docElem.clientTop,
            left: box.left + win.pageXOffset - docElem.clientLeft
          };
        },
        position: function() {
          if (!this[0]) {
            return;
          }
          var offsetParent,
              offset,
              elem = this[0],
              parentOffset = {
                top: 0,
                left: 0
              };
          if (jQuery.css(elem, "position") === "fixed") {
            offset = elem.getBoundingClientRect();
          } else {
            offsetParent = this.offsetParent();
            offset = this.offset();
            if (!jQuery.nodeName(offsetParent[0], "html")) {
              parentOffset = offsetParent.offset();
            }
            parentOffset.top += jQuery.css(offsetParent[0], "borderTopWidth", true);
            parentOffset.left += jQuery.css(offsetParent[0], "borderLeftWidth", true);
          }
          return {
            top: offset.top - parentOffset.top - jQuery.css(elem, "marginTop", true),
            left: offset.left - parentOffset.left - jQuery.css(elem, "marginLeft", true)
          };
        },
        offsetParent: function() {
          return this.map(function() {
            var offsetParent = this.offsetParent || docElem;
            while (offsetParent && (!jQuery.nodeName(offsetParent, "html") && jQuery.css(offsetParent, "position") === "static")) {
              offsetParent = offsetParent.offsetParent;
            }
            return offsetParent || docElem;
          });
        }
      });
      jQuery.each({
        scrollLeft: "pageXOffset",
        scrollTop: "pageYOffset"
      }, function(method, prop) {
        var top = "pageYOffset" === prop;
        jQuery.fn[method] = function(val) {
          return access(this, function(elem, method, val) {
            var win = getWindow(elem);
            if (val === undefined) {
              return win ? win[prop] : elem[method];
            }
            if (win) {
              win.scrollTo(!top ? val : window.pageXOffset, top ? val : window.pageYOffset);
            } else {
              elem[method] = val;
            }
          }, method, val, arguments.length, null);
        };
      });
      jQuery.each(["top", "left"], function(i, prop) {
        jQuery.cssHooks[prop] = addGetHookIf(support.pixelPosition, function(elem, computed) {
          if (computed) {
            computed = curCSS(elem, prop);
            return rnumnonpx.test(computed) ? jQuery(elem).position()[prop] + "px" : computed;
          }
        });
      });
      jQuery.each({
        Height: "height",
        Width: "width"
      }, function(name, type) {
        jQuery.each({
          padding: "inner" + name,
          content: type,
          "": "outer" + name
        }, function(defaultExtra, funcName) {
          jQuery.fn[funcName] = function(margin, value) {
            var chainable = arguments.length && (defaultExtra || typeof margin !== "boolean"),
                extra = defaultExtra || (margin === true || value === true ? "margin" : "border");
            return access(this, function(elem, type, value) {
              var doc;
              if (jQuery.isWindow(elem)) {
                return elem.document.documentElement["client" + name];
              }
              if (elem.nodeType === 9) {
                doc = elem.documentElement;
                return Math.max(elem.body["scroll" + name], doc["scroll" + name], elem.body["offset" + name], doc["offset" + name], doc["client" + name]);
              }
              return value === undefined ? jQuery.css(elem, type, extra) : jQuery.style(elem, type, value, extra);
            }, type, chainable ? margin : undefined, chainable, null);
          };
        });
      });
      jQuery.fn.size = function() {
        return this.length;
      };
      jQuery.fn.andSelf = jQuery.fn.addBack;
      if (typeof define === "function" && define.amd) {
        define("jquery", [], function() {
          return jQuery;
        });
      }
      var _jQuery = window.jQuery,
          _$ = window.$;
      jQuery.noConflict = function(deep) {
        if (window.$ === jQuery) {
          window.$ = _$;
        }
        if (deep && window.jQuery === jQuery) {
          window.jQuery = _jQuery;
        }
        return jQuery;
      };
      if (typeof noGlobal === strundefined) {
        window.jQuery = window.$ = jQuery;
      }
      return jQuery;
    }));
  })($__require('5'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("7", ["6"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('6');
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("8", ["7", "5"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  "format cjs";
  (function(process) {
    (function(factory) {
      if (typeof define === 'function' && define.amd) {
        define(['jquery'], factory);
      } else if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory($__require('7'));
      } else {
        factory(jQuery);
      }
    }(function($) {
      ;
      (function($) {
        'use strict';
        var ts = $.tablesorter = {
          version: '2.25.0',
          parsers: [],
          widgets: [],
          defaults: {
            theme: 'default',
            widthFixed: false,
            showProcessing: false,
            headerTemplate: '{content}',
            onRenderTemplate: null,
            onRenderHeader: null,
            cancelSelection: true,
            tabIndex: true,
            dateFormat: 'mmddyyyy',
            sortMultiSortKey: 'shiftKey',
            sortResetKey: 'ctrlKey',
            usNumberFormat: true,
            delayInit: false,
            serverSideSorting: false,
            resort: true,
            headers: {},
            ignoreCase: true,
            sortForce: null,
            sortList: [],
            sortAppend: null,
            sortStable: false,
            sortInitialOrder: 'asc',
            sortLocaleCompare: false,
            sortReset: false,
            sortRestart: false,
            emptyTo: 'bottom',
            stringTo: 'max',
            duplicateSpan: true,
            textExtraction: 'basic',
            textAttribute: 'data-text',
            textSorter: null,
            numberSorter: null,
            widgets: [],
            widgetOptions: {zebra: ['even', 'odd']},
            initWidgets: true,
            widgetClass: 'widget-{name}',
            initialized: null,
            tableClass: '',
            cssAsc: '',
            cssDesc: '',
            cssNone: '',
            cssHeader: '',
            cssHeaderRow: '',
            cssProcessing: '',
            cssChildRow: 'tablesorter-childRow',
            cssInfoBlock: 'tablesorter-infoOnly',
            cssNoSort: 'tablesorter-noSort',
            cssIgnoreRow: 'tablesorter-ignoreRow',
            cssIcon: 'tablesorter-icon',
            cssIconNone: '',
            cssIconAsc: '',
            cssIconDesc: '',
            pointerClick: 'click',
            pointerDown: 'mousedown',
            pointerUp: 'mouseup',
            selectorHeaders: '> thead th, > thead td',
            selectorSort: 'th, td',
            selectorRemove: '.remove-me',
            debug: false,
            headerList: [],
            empties: {},
            strings: {},
            parsers: []
          },
          css: {
            table: 'tablesorter',
            cssHasChild: 'tablesorter-hasChildRow',
            childRow: 'tablesorter-childRow',
            colgroup: 'tablesorter-colgroup',
            header: 'tablesorter-header',
            headerRow: 'tablesorter-headerRow',
            headerIn: 'tablesorter-header-inner',
            icon: 'tablesorter-icon',
            processing: 'tablesorter-processing',
            sortAsc: 'tablesorter-headerAsc',
            sortDesc: 'tablesorter-headerDesc',
            sortNone: 'tablesorter-headerUnSorted'
          },
          language: {
            sortAsc: 'Ascending sort applied, ',
            sortDesc: 'Descending sort applied, ',
            sortNone: 'No sort applied, ',
            sortDisabled: 'sorting is disabled',
            nextAsc: 'activate to apply an ascending sort',
            nextDesc: 'activate to apply a descending sort',
            nextNone: 'activate to remove the sort'
          },
          regex: {
            templateContent: /\{content\}/g,
            templateIcon: /\{icon\}/g,
            templateName: /\{name\}/i,
            spaces: /\s+/g,
            nonWord: /\W/g,
            formElements: /(input|select|button|textarea)/i,
            chunk: /(^([+\-]?(?:\d*)(?:\.\d*)?(?:[eE][+\-]?\d+)?)?$|^0x[0-9a-f]+$|\d+)/gi,
            chunks: /(^\\0|\\0$)/,
            hex: /^0x[0-9a-f]+$/i,
            comma: /,/g,
            digitNonUS: /[\s|\.]/g,
            digitNegativeTest: /^\s*\([.\d]+\)/,
            digitNegativeReplace: /^\s*\(([.\d]+)\)/,
            digitTest: /^[\-+(]?\d+[)]?$/,
            digitReplace: /[,.'"\s]/g
          },
          string: {
            max: 1,
            min: -1,
            emptymin: 1,
            emptymax: -1,
            zero: 0,
            none: 0,
            'null': 0,
            top: true,
            bottom: false
          },
          dates: {},
          instanceMethods: {},
          setup: function(table, c) {
            if (!table || !table.tHead || table.tBodies.length === 0 || table.hasInitialized === true) {
              if (c.debug) {
                if (table.hasInitialized) {
                  console.warn('Stopping initialization. Tablesorter has already been initialized');
                } else {
                  console.error('Stopping initialization! No table, thead or tbody', table);
                }
              }
              return;
            }
            var tmp = '',
                $table = $(table),
                meta = $.metadata;
            table.hasInitialized = false;
            table.isProcessing = true;
            table.config = c;
            $.data(table, 'tablesorter', c);
            if (c.debug) {
              console[console.group ? 'group' : 'log']('Initializing tablesorter');
              $.data(table, 'startoveralltimer', new Date());
            }
            c.supportsDataObject = (function(version) {
              version[0] = parseInt(version[0], 10);
              return (version[0] > 1) || (version[0] === 1 && parseInt(version[1], 10) >= 4);
            })($.fn.jquery.split('.'));
            c.emptyTo = c.emptyTo.toLowerCase();
            c.stringTo = c.stringTo.toLowerCase();
            c.last = {
              sortList: [],
              clickedIndex: -1
            };
            if (!/tablesorter\-/.test($table.attr('class'))) {
              tmp = (c.theme !== '' ? ' tablesorter-' + c.theme : '');
            }
            c.table = table;
            c.$table = $table.addClass(ts.css.table + ' ' + c.tableClass + tmp).attr('role', 'grid');
            c.$headers = $table.find(c.selectorHeaders);
            if (!c.namespace) {
              c.namespace = '.tablesorter' + Math.random().toString(16).slice(2);
            } else {
              c.namespace = '.' + c.namespace.replace(ts.regex.nonWord, '');
            }
            c.$table.children().children('tr').attr('role', 'row');
            c.$tbodies = $table.children('tbody:not(.' + c.cssInfoBlock + ')').attr({
              'aria-live': 'polite',
              'aria-relevant': 'all'
            });
            if (c.$table.children('caption').length) {
              tmp = c.$table.children('caption')[0];
              if (!tmp.id) {
                tmp.id = c.namespace.slice(1) + 'caption';
              }
              c.$table.attr('aria-labelledby', tmp.id);
            }
            c.widgetInit = {};
            c.textExtraction = c.$table.attr('data-text-extraction') || c.textExtraction || 'basic';
            ts.buildHeaders(c);
            ts.fixColumnWidth(table);
            ts.addWidgetFromClass(table);
            ts.applyWidgetOptions(table);
            ts.setupParsers(c);
            c.totalRows = 0;
            if (!c.delayInit) {
              ts.buildCache(c);
            }
            ts.bindEvents(table, c.$headers, true);
            ts.bindMethods(c);
            if (c.supportsDataObject && typeof $table.data().sortlist !== 'undefined') {
              c.sortList = $table.data().sortlist;
            } else if (meta && ($table.metadata() && $table.metadata().sortlist)) {
              c.sortList = $table.metadata().sortlist;
            }
            ts.applyWidget(table, true);
            if (c.sortList.length > 0) {
              ts.sortOn(c, c.sortList, {}, !c.initWidgets);
            } else {
              ts.setHeadersCss(c);
              if (c.initWidgets) {
                ts.applyWidget(table, false);
              }
            }
            if (c.showProcessing) {
              $table.unbind('sortBegin' + c.namespace + ' sortEnd' + c.namespace).bind('sortBegin' + c.namespace + ' sortEnd' + c.namespace, function(e) {
                clearTimeout(c.timerProcessing);
                ts.isProcessing(table);
                if (e.type === 'sortBegin') {
                  c.timerProcessing = setTimeout(function() {
                    ts.isProcessing(table, true);
                  }, 500);
                }
              });
            }
            table.hasInitialized = true;
            table.isProcessing = false;
            if (c.debug) {
              console.log('Overall initialization time: ' + ts.benchmark($.data(table, 'startoveralltimer')));
              if (c.debug && console.groupEnd) {
                console.groupEnd();
              }
            }
            $table.triggerHandler('tablesorter-initialized', table);
            if (typeof c.initialized === 'function') {
              c.initialized(table);
            }
          },
          bindMethods: function(c) {
            var $table = c.$table,
                namespace = c.namespace,
                events = ('sortReset update updateRows updateAll updateHeaders addRows updateCell updateComplete ' + 'sorton appendCache updateCache applyWidgetId applyWidgets refreshWidgets destroy mouseup ' + 'mouseleave ').split(' ').join(namespace + ' ');
            $table.unbind(events.replace(ts.regex.spaces, ' ')).bind('sortReset' + namespace, function(e, callback) {
              e.stopPropagation();
              ts.sortReset(this.config, callback);
            }).bind('updateAll' + namespace, function(e, resort, callback) {
              e.stopPropagation();
              ts.updateAll(this.config, resort, callback);
            }).bind('update' + namespace + ' updateRows' + namespace, function(e, resort, callback) {
              e.stopPropagation();
              ts.update(this.config, resort, callback);
            }).bind('updateHeaders' + namespace, function(e, callback) {
              e.stopPropagation();
              ts.updateHeaders(this.config, callback);
            }).bind('updateCell' + namespace, function(e, cell, resort, callback) {
              e.stopPropagation();
              ts.updateCell(this.config, cell, resort, callback);
            }).bind('addRows' + namespace, function(e, $row, resort, callback) {
              e.stopPropagation();
              ts.addRows(this.config, $row, resort, callback);
            }).bind('updateComplete' + namespace, function() {
              this.isUpdating = false;
            }).bind('sorton' + namespace, function(e, list, callback, init) {
              e.stopPropagation();
              ts.sortOn(this.config, list, callback, init);
            }).bind('appendCache' + namespace, function(e, callback, init) {
              e.stopPropagation();
              ts.appendCache(this.config, init);
              if ($.isFunction(callback)) {
                callback(this);
              }
            }).bind('updateCache' + namespace, function(e, callback, $tbodies) {
              e.stopPropagation();
              ts.updateCache(this.config, callback, $tbodies);
            }).bind('applyWidgetId' + namespace, function(e, id) {
              e.stopPropagation();
              ts.applyWidgetId(this, id);
            }).bind('applyWidgets' + namespace, function(e, init) {
              e.stopPropagation();
              ts.applyWidget(this, init);
            }).bind('refreshWidgets' + namespace, function(e, all, dontapply) {
              e.stopPropagation();
              ts.refreshWidgets(this, all, dontapply);
            }).bind('removeWidget' + namespace, function(e, name, refreshing) {
              e.stopPropagation();
              ts.removeWidget(this, name, refreshing);
            }).bind('destroy' + namespace, function(e, removeClasses, callback) {
              e.stopPropagation();
              ts.destroy(this, removeClasses, callback);
            }).bind('resetToLoadState' + namespace, function(e) {
              e.stopPropagation();
              ts.removeWidget(this, true, false);
              c = $.extend(true, ts.defaults, c.originalSettings);
              this.hasInitialized = false;
              ts.setup(this, c);
            });
          },
          bindEvents: function(table, $headers, core) {
            table = $(table)[0];
            var tmp,
                c = table.config,
                namespace = c.namespace,
                downTarget = null;
            if (core !== true) {
              $headers.addClass(namespace.slice(1) + '_extra_headers');
              tmp = $.fn.closest ? $headers.closest('table')[0] : $headers.parents('table')[0];
              if (tmp && tmp.nodeName === 'TABLE' && tmp !== table) {
                $(tmp).addClass(namespace.slice(1) + '_extra_table');
              }
            }
            tmp = (c.pointerDown + ' ' + c.pointerUp + ' ' + c.pointerClick + ' sort keyup ').replace(ts.regex.spaces, ' ').split(' ').join(namespace + ' ');
            $headers.find(c.selectorSort).add($headers.filter(c.selectorSort)).unbind(tmp).bind(tmp, function(e, external) {
              var $cell,
                  cell,
                  temp,
                  $target = $(e.target),
                  type = ' ' + e.type + ' ';
              if (((e.which || e.button) !== 1 && !type.match(' ' + c.pointerClick + ' | sort | keyup ')) || (type === ' keyup ' && e.which !== 13) || (type.match(' ' + c.pointerClick + ' ') && typeof e.which !== 'undefined')) {
                return;
              }
              if (type.match(' ' + c.pointerUp + ' ') && downTarget !== e.target && external !== true) {
                return;
              }
              if (type.match(' ' + c.pointerDown + ' ')) {
                downTarget = e.target;
                temp = $target.jquery.split('.');
                if (temp[0] === '1' && temp[1] < 4) {
                  e.preventDefault();
                }
                return;
              }
              downTarget = null;
              if (ts.regex.formElements.test(e.target.nodeName) || $target.hasClass(c.cssNoSort) || $target.parents('.' + c.cssNoSort).length > 0 || $target.parents('button').length > 0) {
                return !c.cancelSelection;
              }
              if (c.delayInit && ts.isEmptyObject(c.cache)) {
                ts.buildCache(c);
              }
              $cell = $.fn.closest ? $(this).closest('th, td') : /TH|TD/.test(this.nodeName) ? $(this) : $(this).parents('th, td');
              temp = $headers.index($cell);
              c.last.clickedIndex = (temp < 0) ? $cell.attr('data-column') : temp;
              cell = c.$headers[c.last.clickedIndex];
              if (cell && !cell.sortDisabled) {
                ts.initSort(c, cell, e);
              }
            });
            if (c.cancelSelection) {
              $headers.attr('unselectable', 'on').bind('selectstart', false).css({
                'user-select': 'none',
                'MozUserSelect': 'none'
              });
            }
          },
          buildHeaders: function(c) {
            var $temp,
                icon,
                timer,
                indx;
            c.headerList = [];
            c.headerContent = [];
            c.sortVars = [];
            if (c.debug) {
              timer = new Date();
            }
            c.columns = ts.computeColumnIndex(c.$table.children('thead, tfoot').children('tr'));
            icon = c.cssIcon ? '<i class="' + (c.cssIcon === ts.css.icon ? ts.css.icon : c.cssIcon + ' ' + ts.css.icon) + '"></i>' : '';
            c.$headers = $($.map(c.$table.find(c.selectorHeaders), function(elem, index) {
              var configHeaders,
                  header,
                  column,
                  template,
                  tmp,
                  $elem = $(elem);
              if ($elem.parent().hasClass(c.cssIgnoreRow)) {
                return;
              }
              configHeaders = ts.getColumnData(c.table, c.headers, index, true);
              c.headerContent[index] = $elem.html();
              if (c.headerTemplate !== '' && !$elem.find('.' + ts.css.headerIn).length) {
                template = c.headerTemplate.replace(ts.regex.templateContent, $elem.html()).replace(ts.regex.templateIcon, $elem.find('.' + ts.css.icon).length ? '' : icon);
                if (c.onRenderTemplate) {
                  header = c.onRenderTemplate.apply($elem, [index, template]);
                  if (header && typeof header === 'string') {
                    template = header;
                  }
                }
                $elem.html('<div class="' + ts.css.headerIn + '">' + template + '</div>');
              }
              if (c.onRenderHeader) {
                c.onRenderHeader.apply($elem, [index, c, c.$table]);
              }
              column = parseInt($elem.attr('data-column'), 10);
              elem.column = column;
              tmp = ts.getData($elem, configHeaders, 'sortInitialOrder') || c.sortInitialOrder;
              c.sortVars[column] = {
                count: -1,
                order: ts.getOrder(tmp) ? [1, 0, 2] : [0, 1, 2],
                lockedOrder: false
              };
              tmp = ts.getData($elem, configHeaders, 'lockedOrder') || false;
              if (typeof tmp !== 'undefined' && tmp !== false) {
                c.sortVars[column].lockedOrder = true;
                c.sortVars[column].order = ts.getOrder(tmp) ? [1, 1, 1] : [0, 0, 0];
              }
              c.headerList[index] = elem;
              $elem.addClass(ts.css.header + ' ' + c.cssHeader).parent().addClass(ts.css.headerRow + ' ' + c.cssHeaderRow).attr('role', 'row');
              if (c.tabIndex) {
                $elem.attr('tabindex', 0);
              }
              return elem;
            }));
            c.$headerIndexed = [];
            for (indx = 0; indx < c.columns; indx++) {
              if (ts.isEmptyObject(c.sortVars[indx])) {
                c.sortVars[indx] = {};
              }
              $temp = c.$headers.filter('[data-column="' + indx + '"]');
              c.$headerIndexed[indx] = $temp.length ? $temp.not('.sorter-false').length ? $temp.not('.sorter-false').filter(':last') : $temp.filter(':last') : $();
            }
            c.$table.find(c.selectorHeaders).attr({
              scope: 'col',
              role: 'columnheader'
            });
            ts.updateHeader(c);
            if (c.debug) {
              console.log('Built headers:' + ts.benchmark(timer));
              console.log(c.$headers);
            }
          },
          addInstanceMethods: function(methods) {
            $.extend(ts.instanceMethods, methods);
          },
          setupParsers: function(c, $tbodies) {
            var rows,
                list,
                span,
                max,
                colIndex,
                indx,
                header,
                configHeaders,
                noParser,
                parser,
                extractor,
                time,
                tbody,
                len,
                table = c.table,
                tbodyIndex = 0,
                debug = {};
            c.$tbodies = c.$table.children('tbody:not(.' + c.cssInfoBlock + ')');
            tbody = typeof $tbodies === 'undefined' ? c.$tbodies : $tbodies;
            len = tbody.length;
            if (len === 0) {
              return c.debug ? console.warn('Warning: *Empty table!* Not building a parser cache') : '';
            } else if (c.debug) {
              time = new Date();
              console[console.group ? 'group' : 'log']('Detecting parsers for each column');
            }
            list = {
              extractors: [],
              parsers: []
            };
            while (tbodyIndex < len) {
              rows = tbody[tbodyIndex].rows;
              if (rows.length) {
                colIndex = 0;
                max = c.columns;
                for (indx = 0; indx < max; indx++) {
                  header = c.$headerIndexed[colIndex];
                  if (header && header.length) {
                    configHeaders = ts.getColumnData(table, c.headers, colIndex);
                    extractor = ts.getParserById(ts.getData(header, configHeaders, 'extractor'));
                    parser = ts.getParserById(ts.getData(header, configHeaders, 'sorter'));
                    noParser = ts.getData(header, configHeaders, 'parser') === 'false';
                    c.empties[colIndex] = (ts.getData(header, configHeaders, 'empty') || c.emptyTo || (c.emptyToBottom ? 'bottom' : 'top')).toLowerCase();
                    c.strings[colIndex] = (ts.getData(header, configHeaders, 'string') || c.stringTo || 'max').toLowerCase();
                    if (noParser) {
                      parser = ts.getParserById('no-parser');
                    }
                    if (!extractor) {
                      extractor = false;
                    }
                    if (!parser) {
                      parser = ts.detectParserForColumn(c, rows, -1, colIndex);
                    }
                    if (c.debug) {
                      debug['(' + colIndex + ') ' + header.text()] = {
                        parser: parser.id,
                        extractor: extractor ? extractor.id : 'none',
                        string: c.strings[colIndex],
                        empty: c.empties[colIndex]
                      };
                    }
                    list.parsers[colIndex] = parser;
                    list.extractors[colIndex] = extractor;
                    span = header[0].colSpan - 1;
                    if (span > 0) {
                      colIndex += span;
                      max += span;
                      while (span + 1 > 0) {
                        list.parsers[colIndex - span] = parser;
                        list.extractors[colIndex - span] = extractor;
                        span--;
                      }
                    }
                  }
                  colIndex++;
                }
              }
              tbodyIndex += (list.parsers.length) ? len : 1;
            }
            if (c.debug) {
              if (!ts.isEmptyObject(debug)) {
                console[console.table ? 'table' : 'log'](debug);
              } else {
                console.warn('  No parsers detected!');
              }
              console.log('Completed detecting parsers' + ts.benchmark(time));
              if (console.groupEnd) {
                console.groupEnd();
              }
            }
            c.parsers = list.parsers;
            c.extractors = list.extractors;
          },
          addParser: function(parser) {
            var indx,
                len = ts.parsers.length,
                add = true;
            for (indx = 0; indx < len; indx++) {
              if (ts.parsers[indx].id.toLowerCase() === parser.id.toLowerCase()) {
                add = false;
              }
            }
            if (add) {
              ts.parsers.push(parser);
            }
          },
          getParserById: function(name) {
            if (name == 'false') {
              return false;
            }
            var indx,
                len = ts.parsers.length;
            for (indx = 0; indx < len; indx++) {
              if (ts.parsers[indx].id.toLowerCase() === (name.toString()).toLowerCase()) {
                return ts.parsers[indx];
              }
            }
            return false;
          },
          detectParserForColumn: function(c, rows, rowIndex, cellIndex) {
            var cur,
                $node,
                row,
                indx = ts.parsers.length,
                node = false,
                nodeValue = '',
                keepLooking = true;
            while (nodeValue === '' && keepLooking) {
              rowIndex++;
              row = rows[rowIndex];
              if (row && rowIndex < 50) {
                if (row.className.indexOf(ts.cssIgnoreRow) < 0) {
                  node = rows[rowIndex].cells[cellIndex];
                  nodeValue = ts.getElementText(c, node, cellIndex);
                  $node = $(node);
                  if (c.debug) {
                    console.log('Checking if value was empty on row ' + rowIndex + ', column: ' + cellIndex + ': "' + nodeValue + '"');
                  }
                }
              } else {
                keepLooking = false;
              }
            }
            while (--indx >= 0) {
              cur = ts.parsers[indx];
              if (cur && cur.id !== 'text' && cur.is && cur.is(nodeValue, c.table, node, $node)) {
                return cur;
              }
            }
            return ts.getParserById('text');
          },
          getElementText: function(c, node, cellIndex) {
            if (!node) {
              return '';
            }
            var tmp,
                extract = c.textExtraction || '',
                $node = node.jquery ? node : $(node);
            if (typeof extract === 'string') {
              if (extract === 'basic' && typeof(tmp = $node.attr(c.textAttribute)) !== 'undefined') {
                return $.trim(tmp);
              }
              return $.trim(node.textContent || $node.text());
            } else {
              if (typeof extract === 'function') {
                return $.trim(extract($node[0], c.table, cellIndex));
              } else if (typeof(tmp = ts.getColumnData(c.table, extract, cellIndex)) === 'function') {
                return $.trim(tmp($node[0], c.table, cellIndex));
              }
            }
            return $.trim($node[0].textContent || $node.text());
          },
          getParsedText: function(c, cell, colIndex, txt) {
            if (typeof txt === 'undefined') {
              txt = ts.getElementText(c, cell, colIndex);
            }
            var val = '' + txt,
                parser = c.parsers[colIndex],
                extractor = c.extractors[colIndex];
            if (parser) {
              if (extractor && typeof extractor.format === 'function') {
                txt = extractor.format(txt, c.table, cell, colIndex);
              }
              val = parser.id === 'no-parser' ? '' : parser.format('' + txt, c.table, cell, colIndex);
              if (c.ignoreCase && typeof val === 'string') {
                val = val.toLowerCase();
              }
            }
            return val;
          },
          buildCache: function(c, callback, $tbodies) {
            var cache,
                val,
                txt,
                rowIndex,
                colIndex,
                tbodyIndex,
                $tbody,
                $row,
                cols,
                $cells,
                cell,
                cacheTime,
                totalRows,
                rowData,
                prevRowData,
                colMax,
                span,
                cacheIndex,
                hasParser,
                max,
                len,
                index,
                table = c.table,
                parsers = c.parsers;
            c.$tbodies = c.$table.children('tbody:not(.' + c.cssInfoBlock + ')');
            $tbody = typeof $tbodies === 'undefined' ? c.$tbodies : $tbodies, c.cache = {};
            c.totalRows = 0;
            if (!parsers) {
              return c.debug ? console.warn('Warning: *Empty table!* Not building a cache') : '';
            }
            if (c.debug) {
              cacheTime = new Date();
            }
            if (c.showProcessing) {
              ts.isProcessing(table, true);
            }
            for (tbodyIndex = 0; tbodyIndex < $tbody.length; tbodyIndex++) {
              colMax = [];
              cache = c.cache[tbodyIndex] = {normalized: []};
              totalRows = ($tbody[tbodyIndex] && $tbody[tbodyIndex].rows.length) || 0;
              for (rowIndex = 0; rowIndex < totalRows; ++rowIndex) {
                rowData = {
                  child: [],
                  raw: []
                };
                $row = $($tbody[tbodyIndex].rows[rowIndex]);
                cols = [];
                if ($row.hasClass(c.cssChildRow) && rowIndex !== 0) {
                  len = cache.normalized.length - 1;
                  prevRowData = cache.normalized[len][c.columns];
                  prevRowData.$row = prevRowData.$row.add($row);
                  if (!$row.prev().hasClass(c.cssChildRow)) {
                    $row.prev().addClass(ts.css.cssHasChild);
                  }
                  $cells = $row.children('th, td');
                  len = prevRowData.child.length;
                  prevRowData.child[len] = [];
                  cacheIndex = 0;
                  max = c.columns;
                  for (colIndex = 0; colIndex < max; colIndex++) {
                    cell = $cells[colIndex];
                    if (cell) {
                      prevRowData.child[len][colIndex] = ts.getParsedText(c, cell, colIndex);
                      span = $cells[colIndex].colSpan - 1;
                      if (span > 0) {
                        cacheIndex += span;
                        max += span;
                      }
                    }
                    cacheIndex++;
                  }
                  continue;
                }
                rowData.$row = $row;
                rowData.order = rowIndex;
                cacheIndex = 0;
                max = c.columns;
                for (colIndex = 0; colIndex < max; ++colIndex) {
                  cell = $row[0].cells[colIndex];
                  if (cell && cacheIndex < c.columns) {
                    hasParser = typeof parsers[cacheIndex] !== 'undefined';
                    if (!hasParser && c.debug) {
                      console.warn('No parser found for row: ' + rowIndex + ', column: ' + colIndex + '; cell containing: "' + $(cell).text() + '"; does it have a header?');
                    }
                    val = ts.getElementText(c, cell, cacheIndex);
                    rowData.raw[cacheIndex] = val;
                    txt = ts.getParsedText(c, cell, cacheIndex, val);
                    cols[cacheIndex] = txt;
                    if (hasParser && (parsers[cacheIndex].type || '').toLowerCase() === 'numeric') {
                      colMax[cacheIndex] = Math.max(Math.abs(txt) || 0, colMax[cacheIndex] || 0);
                    }
                    span = cell.colSpan - 1;
                    if (span > 0) {
                      index = 0;
                      while (index <= span) {
                        rowData.raw[cacheIndex + index] = c.duplicateSpan || index === 0 ? val : '';
                        cols[cacheIndex + index] = c.duplicateSpan || index === 0 ? val : '';
                        index++;
                      }
                      cacheIndex += span;
                      max += span;
                    }
                  }
                  cacheIndex++;
                }
                cols[c.columns] = rowData;
                cache.normalized.push(cols);
              }
              cache.colMax = colMax;
              c.totalRows += cache.normalized.length;
            }
            if (c.showProcessing) {
              ts.isProcessing(table);
            }
            if (c.debug) {
              len = Math.min(5, c.cache[0].normalized.length);
              console[console.group ? 'group' : 'log']('Building cache for ' + c.totalRows + ' rows (showing ' + len + ' rows in log)' + ts.benchmark(cacheTime));
              val = {};
              for (colIndex = 0; colIndex < c.columns; colIndex++) {
                for (cacheIndex = 0; cacheIndex < len; cacheIndex++) {
                  if (!val['row: ' + cacheIndex]) {
                    val['row: ' + cacheIndex] = {};
                  }
                  val['row: ' + cacheIndex][c.$headerIndexed[colIndex].text()] = c.cache[0].normalized[cacheIndex][colIndex];
                }
              }
              console[console.table ? 'table' : 'log'](val);
              if (console.groupEnd) {
                console.groupEnd();
              }
            }
            if ($.isFunction(callback)) {
              callback(table);
            }
          },
          getColumnText: function(table, column, callback, rowFilter) {
            table = $(table)[0];
            var tbodyIndex,
                rowIndex,
                cache,
                row,
                tbodyLen,
                rowLen,
                raw,
                parsed,
                $cell,
                result,
                hasCallback = typeof callback === 'function',
                allColumns = column === 'all',
                data = {
                  raw: [],
                  parsed: [],
                  $cell: []
                },
                c = table.config;
            if (ts.isEmptyObject(c)) {
              if (c.debug) {
                console.warn('No cache found - aborting getColumnText function!');
              }
            } else {
              tbodyLen = c.$tbodies.length;
              for (tbodyIndex = 0; tbodyIndex < tbodyLen; tbodyIndex++) {
                cache = c.cache[tbodyIndex].normalized;
                rowLen = cache.length;
                for (rowIndex = 0; rowIndex < rowLen; rowIndex++) {
                  row = cache[rowIndex];
                  if (rowFilter && !row[c.columns].$row.is(rowFilter)) {
                    continue;
                  }
                  result = true;
                  parsed = (allColumns) ? row.slice(0, c.columns) : row[column];
                  row = row[c.columns];
                  raw = (allColumns) ? row.raw : row.raw[column];
                  $cell = (allColumns) ? row.$row.children() : row.$row.children().eq(column);
                  if (hasCallback) {
                    result = callback({
                      tbodyIndex: tbodyIndex,
                      rowIndex: rowIndex,
                      parsed: parsed,
                      raw: raw,
                      $row: row.$row,
                      $cell: $cell
                    });
                  }
                  if (result !== false) {
                    data.parsed.push(parsed);
                    data.raw.push(raw);
                    data.$cell.push($cell);
                  }
                }
              }
              return data;
            }
          },
          setHeadersCss: function(c) {
            var $sorted,
                indx,
                column,
                list = c.sortList,
                len = list.length,
                none = ts.css.sortNone + ' ' + c.cssNone,
                css = [ts.css.sortAsc + ' ' + c.cssAsc, ts.css.sortDesc + ' ' + c.cssDesc],
                cssIcon = [c.cssIconAsc, c.cssIconDesc, c.cssIconNone],
                aria = ['ascending', 'descending'],
                $headers = c.$table.find('tfoot tr').children().add($(c.namespace + '_extra_headers')).removeClass(css.join(' '));
            c.$headers.removeClass(css.join(' ')).addClass(none).attr('aria-sort', 'none').find('.' + ts.css.icon).removeClass(cssIcon.join(' ')).addClass(cssIcon[2]);
            for (indx = 0; indx < len; indx++) {
              if (list[indx][1] !== 2) {
                $sorted = c.$headers.filter(function(i) {
                  var include = true,
                      $el = c.$headers.eq(i),
                      col = parseInt($el.attr('data-column'), 10),
                      end = col + c.$headers[i].colSpan;
                  for (; col < end; col++) {
                    include = include ? include || ts.isValueInArray(col, c.sortList) > -1 : false;
                  }
                  return include;
                });
                $sorted = $sorted.not('.sorter-false').filter('[data-column="' + list[indx][0] + '"]' + (len === 1 ? ':last' : ''));
                if ($sorted.length) {
                  for (column = 0; column < $sorted.length; column++) {
                    if (!$sorted[column].sortDisabled) {
                      $sorted.eq(column).removeClass(none).addClass(css[list[indx][1]]).attr('aria-sort', aria[list[indx][1]]).find('.' + ts.css.icon).removeClass(cssIcon[2]).addClass(cssIcon[list[indx][1]]);
                    }
                  }
                  if ($headers.length) {
                    $headers.filter('[data-column="' + list[indx][0] + '"]').removeClass(none).addClass(css[list[indx][1]]);
                  }
                }
              }
            }
            len = c.$headers.length;
            for (indx = 0; indx < len; indx++) {
              ts.setColumnAriaLabel(c, c.$headers.eq(indx));
            }
          },
          setColumnAriaLabel: function(c, $header, nextSort) {
            if ($header.length) {
              var column = parseInt($header.attr('data-column'), 10),
                  tmp = $header.hasClass(ts.css.sortAsc) ? 'sortAsc' : $header.hasClass(ts.css.sortDesc) ? 'sortDesc' : 'sortNone',
                  txt = $.trim($header.text()) + ': ' + ts.language[tmp];
              if ($header.hasClass('sorter-false') || nextSort === false) {
                txt += ts.language.sortDisabled;
              } else {
                nextSort = c.sortVars[column].order[(c.sortVars[column].count + 1) % (c.sortReset ? 3 : 2)];
                txt += ts.language[nextSort === 0 ? 'nextAsc' : nextSort === 1 ? 'nextDesc' : 'nextNone'];
              }
              $header.attr('aria-label', txt);
            }
          },
          updateHeader: function(c) {
            var index,
                isDisabled,
                $header,
                col,
                table = c.table,
                len = c.$headers.length;
            for (index = 0; index < len; index++) {
              $header = c.$headers.eq(index);
              col = ts.getColumnData(table, c.headers, index, true);
              isDisabled = ts.getData($header, col, 'sorter') === 'false' || ts.getData($header, col, 'parser') === 'false';
              ts.setColumnSort(c, $header, isDisabled);
            }
          },
          setColumnSort: function(c, $header, isDisabled) {
            var id = c.table.id;
            $header[0].sortDisabled = isDisabled;
            $header[isDisabled ? 'addClass' : 'removeClass']('sorter-false').attr('aria-disabled', '' + isDisabled);
            if (c.tabIndex) {
              if (isDisabled) {
                $header.removeAttr('tabindex');
              } else {
                $header.attr('tabindex', '0');
              }
            }
            if (id) {
              if (isDisabled) {
                $header.removeAttr('aria-controls');
              } else {
                $header.attr('aria-controls', id);
              }
            }
          },
          updateHeaderSortCount: function(c, list) {
            var col,
                dir,
                group,
                indx,
                primary,
                temp,
                val,
                order,
                sortList = list || c.sortList,
                len = sortList.length;
            c.sortList = [];
            for (indx = 0; indx < len; indx++) {
              val = sortList[indx];
              col = parseInt(val[0], 10);
              if (col < c.columns) {
                if (!c.sortVars[col].order) {
                  order = c.sortVars[col].order = ts.getOrder(c.sortInitialOrder) ? [1, 0, 2] : [0, 1, 2];
                  c.sortVars[col].count = 0;
                }
                order = c.sortVars[col].order;
                dir = ('' + val[1]).match(/^(1|d|s|o|n)/);
                dir = dir ? dir[0] : '';
                switch (dir) {
                  case '1':
                  case 'd':
                    dir = 1;
                    break;
                  case 's':
                    dir = primary || 0;
                    break;
                  case 'o':
                    temp = order[(primary || 0) % (c.sortReset ? 3 : 2)];
                    dir = temp === 0 ? 1 : temp === 1 ? 0 : 2;
                    break;
                  case 'n':
                    dir = order[(++c.sortVars[col].count) % (c.sortReset ? 3 : 2)];
                    break;
                  default:
                    dir = 0;
                    break;
                }
                primary = indx === 0 ? dir : primary;
                group = [col, parseInt(dir, 10) || 0];
                c.sortList.push(group);
                dir = $.inArray(group[1], order);
                c.sortVars[col].count = dir >= 0 ? dir : group[1] % (c.sortReset ? 3 : 2);
              }
            }
          },
          updateAll: function(c, resort, callback) {
            var table = c.table;
            table.isUpdating = true;
            ts.refreshWidgets(table, true, true);
            ts.buildHeaders(c);
            ts.bindEvents(table, c.$headers, true);
            ts.bindMethods(c);
            ts.commonUpdate(c, resort, callback);
          },
          update: function(c, resort, callback) {
            var table = c.table;
            table.isUpdating = true;
            ts.updateHeader(c);
            ts.commonUpdate(c, resort, callback);
          },
          updateHeaders: function(c, callback) {
            c.table.isUpdating = true;
            ts.buildHeaders(c);
            ts.bindEvents(c.table, c.$headers, true);
            ts.resortComplete(c, callback);
          },
          updateCell: function(c, cell, resort, callback) {
            if (ts.isEmptyObject(c.cache)) {
              ts.updateHeader(c);
              ts.commonUpdate(c, resort, callback);
              return;
            }
            c.table.isUpdating = true;
            c.$table.find(c.selectorRemove).remove();
            var tmp,
                indx,
                row,
                icell,
                cache,
                len,
                $tbodies = c.$tbodies,
                $cell = $(cell),
                tbodyIndex = $tbodies.index($.fn.closest ? $cell.closest('tbody') : $cell.parents('tbody').filter(':first')),
                tbcache = c.cache[tbodyIndex],
                $row = $.fn.closest ? $cell.closest('tr') : $cell.parents('tr').filter(':first');
            cell = $cell[0];
            if ($tbodies.length && tbodyIndex >= 0) {
              row = $tbodies.eq(tbodyIndex).find('tr').index($row);
              cache = tbcache.normalized[row];
              len = $row[0].cells.length;
              if (len !== c.columns) {
                icell = 0;
                tmp = false;
                for (indx = 0; indx < len; indx++) {
                  if (!tmp && $row[0].cells[indx] !== cell) {
                    icell += $row[0].cells[indx].colSpan;
                  } else {
                    tmp = true;
                  }
                }
              } else {
                icell = $cell.index();
              }
              tmp = ts.getElementText(c, cell, icell);
              cache[c.columns].raw[icell] = tmp;
              tmp = ts.getParsedText(c, cell, icell, tmp);
              cache[icell] = tmp;
              cache[c.columns].$row = $row;
              if ((c.parsers[icell].type || '').toLowerCase() === 'numeric') {
                tbcache.colMax[icell] = Math.max(Math.abs(tmp) || 0, tbcache.colMax[icell] || 0);
              }
              tmp = resort !== 'undefined' ? resort : c.resort;
              if (tmp !== false) {
                ts.checkResort(c, tmp, callback);
              } else {
                ts.resortComplete(c, callback);
              }
            } else {
              if (c.debug) {
                console.error('updateCell aborted, tbody missing or not within the indicated table');
              }
              c.table.isUpdating = false;
            }
          },
          addRows: function(c, $row, resort, callback) {
            var txt,
                val,
                tbodyIndex,
                rowIndex,
                rows,
                cellIndex,
                len,
                cacheIndex,
                rowData,
                cells,
                cell,
                span,
                valid = typeof $row === 'string' && c.$tbodies.length === 1 && /<tr/.test($row || ''),
                table = c.table;
            if (valid) {
              $row = $($row);
              c.$tbodies.append($row);
            } else if (!$row || !($row instanceof jQuery) || ($.fn.closest ? $row.closest('table')[0] : $row.parents('table')[0]) !== c.table) {
              if (c.debug) {
                console.error('addRows method requires (1) a jQuery selector reference to rows that have already ' + 'been added to the table, or (2) row HTML string to be added to a table with only one tbody');
              }
              return false;
            }
            table.isUpdating = true;
            if (ts.isEmptyObject(c.cache)) {
              ts.updateHeader(c);
              ts.commonUpdate(c, resort, callback);
            } else {
              rows = $row.filter('tr').attr('role', 'row').length;
              tbodyIndex = c.$tbodies.index($row.parents('tbody').filter(':first'));
              if (!(c.parsers && c.parsers.length)) {
                ts.setupParsers(c);
              }
              for (rowIndex = 0; rowIndex < rows; rowIndex++) {
                cacheIndex = 0;
                len = $row[rowIndex].cells.length;
                cells = [];
                rowData = {
                  child: [],
                  raw: [],
                  $row: $row.eq(rowIndex),
                  order: c.cache[tbodyIndex].normalized.length
                };
                for (cellIndex = 0; cellIndex < len; cellIndex++) {
                  cell = $row[rowIndex].cells[cellIndex];
                  txt = ts.getElementText(c, cell, cacheIndex);
                  rowData.raw[cacheIndex] = txt;
                  val = ts.getParsedText(c, cell, cacheIndex, txt);
                  cells[cacheIndex] = val;
                  if ((c.parsers[cacheIndex].type || '').toLowerCase() === 'numeric') {
                    c.cache[tbodyIndex].colMax[cacheIndex] = Math.max(Math.abs(val) || 0, c.cache[tbodyIndex].colMax[cacheIndex] || 0);
                  }
                  span = cell.colSpan - 1;
                  if (span > 0) {
                    cacheIndex += span;
                  }
                  cacheIndex++;
                }
                cells[c.columns] = rowData;
                c.cache[tbodyIndex].normalized.push(cells);
              }
              ts.checkResort(c, resort, callback);
            }
          },
          updateCache: function(c, callback, $tbodies) {
            if (!(c.parsers && c.parsers.length)) {
              ts.setupParsers(c, $tbodies);
            }
            ts.buildCache(c, callback, $tbodies);
          },
          appendCache: function(c, init) {
            var parsed,
                totalRows,
                $tbody,
                $curTbody,
                rowIndex,
                tbodyIndex,
                appendTime,
                table = c.table,
                wo = c.widgetOptions,
                $tbodies = c.$tbodies,
                rows = [],
                cache = c.cache;
            if (ts.isEmptyObject(cache)) {
              return c.appender ? c.appender(table, rows) : table.isUpdating ? c.$table.triggerHandler('updateComplete', table) : '';
            }
            if (c.debug) {
              appendTime = new Date();
            }
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              $tbody = $tbodies.eq(tbodyIndex);
              if ($tbody.length) {
                $curTbody = ts.processTbody(table, $tbody, true);
                parsed = cache[tbodyIndex].normalized;
                totalRows = parsed.length;
                for (rowIndex = 0; rowIndex < totalRows; rowIndex++) {
                  rows.push(parsed[rowIndex][c.columns].$row);
                  if (!c.appender || (c.pager && (!c.pager.removeRows || !wo.pager_removeRows) && !c.pager.ajax)) {
                    $curTbody.append(parsed[rowIndex][c.columns].$row);
                  }
                }
                ts.processTbody(table, $curTbody, false);
              }
            }
            if (c.appender) {
              c.appender(table, rows);
            }
            if (c.debug) {
              console.log('Rebuilt table' + ts.benchmark(appendTime));
            }
            if (!init && !c.appender) {
              ts.applyWidget(table);
            }
            if (table.isUpdating) {
              c.$table.triggerHandler('updateComplete', table);
            }
          },
          commonUpdate: function(c, resort, callback) {
            c.$table.find(c.selectorRemove).remove();
            ts.setupParsers(c);
            ts.buildCache(c);
            ts.checkResort(c, resort, callback);
          },
          initSort: function(c, cell, event) {
            if (c.table.isUpdating) {
              return setTimeout(function() {
                ts.initSort(c, cell, event);
              }, 50);
            }
            var arry,
                indx,
                headerIndx,
                dir,
                temp,
                tmp,
                $header,
                notMultiSort = !event[c.sortMultiSortKey],
                table = c.table,
                len = c.$headers.length,
                col = parseInt($(cell).attr('data-column'), 10),
                order = c.sortVars[col].order;
            c.$table.triggerHandler('sortStart', table);
            c.sortVars[col].count = event[c.sortResetKey] ? 2 : (c.sortVars[col].count + 1) % (c.sortReset ? 3 : 2);
            if (c.sortRestart) {
              for (headerIndx = 0; headerIndx < len; headerIndx++) {
                $header = c.$headers.eq(headerIndx);
                tmp = parseInt($header.attr('data-column'), 10);
                if (col !== tmp && (notMultiSort || $header.hasClass(ts.css.sortNone))) {
                  c.sortVars[tmp].count = -1;
                }
              }
            }
            if (notMultiSort) {
              c.sortList = [];
              c.last.sortList = [];
              if (c.sortForce !== null) {
                arry = c.sortForce;
                for (indx = 0; indx < arry.length; indx++) {
                  if (arry[indx][0] !== col) {
                    c.sortList.push(arry[indx]);
                  }
                }
              }
              dir = order[c.sortVars[col].count];
              if (dir < 2) {
                c.sortList.push([col, dir]);
                if (cell.colSpan > 1) {
                  for (indx = 1; indx < cell.colSpan; indx++) {
                    c.sortList.push([col + indx, dir]);
                    c.sortVars[col + indx].count = $.inArray(dir, order);
                  }
                }
              }
            } else {
              c.sortList = $.extend([], c.last.sortList);
              if (ts.isValueInArray(col, c.sortList) >= 0) {
                for (indx = 0; indx < c.sortList.length; indx++) {
                  tmp = c.sortList[indx];
                  if (tmp[0] === col) {
                    tmp[1] = order[c.sortVars[col].count];
                    if (tmp[1] === 2) {
                      c.sortList.splice(indx, 1);
                      c.sortVars[col].count = -1;
                    }
                  }
                }
              } else {
                dir = order[c.sortVars[col].count];
                if (dir < 2) {
                  c.sortList.push([col, dir]);
                  if (cell.colSpan > 1) {
                    for (indx = 1; indx < cell.colSpan; indx++) {
                      c.sortList.push([col + indx, dir]);
                      c.sortVars[col + indx].count = $.inArray(dir, order);
                    }
                  }
                }
              }
            }
            c.last.sortList = $.extend([], c.sortList);
            if (c.sortList.length && c.sortAppend) {
              arry = $.isArray(c.sortAppend) ? c.sortAppend : c.sortAppend[c.sortList[0][0]];
              if (!ts.isEmptyObject(arry)) {
                for (indx = 0; indx < arry.length; indx++) {
                  if (arry[indx][0] !== col && ts.isValueInArray(arry[indx][0], c.sortList) < 0) {
                    dir = arry[indx][1];
                    temp = ('' + dir).match(/^(a|d|s|o|n)/);
                    if (temp) {
                      tmp = c.sortList[0][1];
                      switch (temp[0]) {
                        case 'd':
                          dir = 1;
                          break;
                        case 's':
                          dir = tmp;
                          break;
                        case 'o':
                          dir = tmp === 0 ? 1 : 0;
                          break;
                        case 'n':
                          dir = (tmp + 1) % (c.sortReset ? 3 : 2);
                          break;
                        default:
                          dir = 0;
                          break;
                      }
                    }
                    c.sortList.push([arry[indx][0], dir]);
                  }
                }
              }
            }
            c.$table.triggerHandler('sortBegin', table);
            setTimeout(function() {
              ts.setHeadersCss(c);
              ts.multisort(c);
              ts.appendCache(c);
              c.$table.triggerHandler('sortBeforeEnd', table);
              c.$table.triggerHandler('sortEnd', table);
            }, 1);
          },
          multisort: function(c) {
            var tbodyIndex,
                sortTime,
                colMax,
                rows,
                table = c.table,
                dir = 0,
                textSorter = c.textSorter || '',
                sortList = c.sortList,
                sortLen = sortList.length,
                len = c.$tbodies.length;
            if (c.serverSideSorting || ts.isEmptyObject(c.cache)) {
              return;
            }
            if (c.debug) {
              sortTime = new Date();
            }
            for (tbodyIndex = 0; tbodyIndex < len; tbodyIndex++) {
              colMax = c.cache[tbodyIndex].colMax;
              rows = c.cache[tbodyIndex].normalized;
              rows.sort(function(a, b) {
                var sortIndex,
                    num,
                    col,
                    order,
                    sort,
                    x,
                    y;
                for (sortIndex = 0; sortIndex < sortLen; sortIndex++) {
                  col = sortList[sortIndex][0];
                  order = sortList[sortIndex][1];
                  dir = order === 0;
                  if (c.sortStable && a[col] === b[col] && sortLen === 1) {
                    return a[c.columns].order - b[c.columns].order;
                  }
                  num = /n/i.test(ts.getSortType(c.parsers, col));
                  if (num && c.strings[col]) {
                    if (typeof(ts.string[c.strings[col]]) === 'boolean') {
                      num = (dir ? 1 : -1) * (ts.string[c.strings[col]] ? -1 : 1);
                    } else {
                      num = (c.strings[col]) ? ts.string[c.strings[col]] || 0 : 0;
                    }
                    sort = c.numberSorter ? c.numberSorter(a[col], b[col], dir, colMax[col], table) : ts['sortNumeric' + (dir ? 'Asc' : 'Desc')](a[col], b[col], num, colMax[col], col, c);
                  } else {
                    x = dir ? a : b;
                    y = dir ? b : a;
                    if (typeof textSorter === 'function') {
                      sort = textSorter(x[col], y[col], dir, col, table);
                    } else if (typeof textSorter === 'object' && textSorter.hasOwnProperty(col)) {
                      sort = textSorter[col](x[col], y[col], dir, col, table);
                    } else {
                      sort = ts['sortNatural' + (dir ? 'Asc' : 'Desc')](a[col], b[col], col, c);
                    }
                  }
                  if (sort) {
                    return sort;
                  }
                }
                return a[c.columns].order - b[c.columns].order;
              });
            }
            if (c.debug) {
              console.log('Applying sort ' + sortList.toString() + ts.benchmark(sortTime));
            }
          },
          resortComplete: function(c, callback) {
            if (c.table.isUpdating) {
              c.$table.triggerHandler('updateComplete', c.table);
            }
            if ($.isFunction(callback)) {
              callback(c.table);
            }
          },
          checkResort: function(c, resort, callback) {
            var sortList = $.isArray(resort) ? resort : c.sortList,
                resrt = typeof resort === 'undefined' ? c.resort : resort;
            if (resrt !== false && !c.serverSideSorting && !c.table.isProcessing) {
              if (sortList.length) {
                ts.sortOn(c, sortList, function() {
                  ts.resortComplete(c, callback);
                }, true);
              } else {
                ts.sortReset(c, function() {
                  ts.resortComplete(c, callback);
                  ts.applyWidget(c.table, false);
                });
              }
            } else {
              ts.resortComplete(c, callback);
              ts.applyWidget(c.table, false);
            }
          },
          sortOn: function(c, list, callback, init) {
            var table = c.table;
            c.$table.triggerHandler('sortStart', table);
            ts.updateHeaderSortCount(c, list);
            ts.setHeadersCss(c);
            if (c.delayInit && ts.isEmptyObject(c.cache)) {
              ts.buildCache(c);
            }
            c.$table.triggerHandler('sortBegin', table);
            ts.multisort(c);
            ts.appendCache(c, init);
            c.$table.triggerHandler('sortBeforeEnd', table);
            c.$table.triggerHandler('sortEnd', table);
            ts.applyWidget(table);
            if ($.isFunction(callback)) {
              callback(table);
            }
          },
          sortReset: function(c, callback) {
            c.sortList = [];
            ts.setHeadersCss(c);
            ts.multisort(c);
            ts.appendCache(c);
            if ($.isFunction(callback)) {
              callback(c.table);
            }
          },
          getSortType: function(parsers, column) {
            return (parsers && parsers[column]) ? parsers[column].type || '' : '';
          },
          getOrder: function(val) {
            return (/^d/i.test(val) || val === 1);
          },
          sortNatural: function(a, b) {
            if (a === b) {
              return 0;
            }
            var aNum,
                bNum,
                aFloat,
                bFloat,
                indx,
                max,
                regex = ts.regex;
            if (regex.hex.test(b)) {
              aNum = parseInt(a.match(regex.hex), 16);
              bNum = parseInt(b.match(regex.hex), 16);
              if (aNum < bNum) {
                return -1;
              }
              if (aNum > bNum) {
                return 1;
              }
            }
            aNum = a.replace(regex.chunk, '\\0$1\\0').replace(regex.chunks, '').split('\\0');
            bNum = b.replace(regex.chunk, '\\0$1\\0').replace(regex.chunks, '').split('\\0');
            max = Math.max(aNum.length, bNum.length);
            for (indx = 0; indx < max; indx++) {
              aFloat = isNaN(aNum[indx]) ? aNum[indx] || 0 : parseFloat(aNum[indx]) || 0;
              bFloat = isNaN(bNum[indx]) ? bNum[indx] || 0 : parseFloat(bNum[indx]) || 0;
              if (isNaN(aFloat) !== isNaN(bFloat)) {
                return isNaN(aFloat) ? 1 : -1;
              }
              if (typeof aFloat !== typeof bFloat) {
                aFloat += '';
                bFloat += '';
              }
              if (aFloat < bFloat) {
                return -1;
              }
              if (aFloat > bFloat) {
                return 1;
              }
            }
            return 0;
          },
          sortNaturalAsc: function(a, b, col, c) {
            if (a === b) {
              return 0;
            }
            var empty = ts.string[(c.empties[col] || c.emptyTo)];
            if (a === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? -1 : 1) : -empty || -1;
            }
            if (b === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? 1 : -1) : empty || 1;
            }
            return ts.sortNatural(a, b);
          },
          sortNaturalDesc: function(a, b, col, c) {
            if (a === b) {
              return 0;
            }
            var empty = ts.string[(c.empties[col] || c.emptyTo)];
            if (a === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? -1 : 1) : empty || 1;
            }
            if (b === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? 1 : -1) : -empty || -1;
            }
            return ts.sortNatural(b, a);
          },
          sortText: function(a, b) {
            return a > b ? 1 : (a < b ? -1 : 0);
          },
          getTextValue: function(val, num, max) {
            if (max) {
              var indx,
                  len = val ? val.length : 0,
                  n = max + num;
              for (indx = 0; indx < len; indx++) {
                n += val.charCodeAt(indx);
              }
              return num * n;
            }
            return 0;
          },
          sortNumericAsc: function(a, b, num, max, col, c) {
            if (a === b) {
              return 0;
            }
            var empty = ts.string[(c.empties[col] || c.emptyTo)];
            if (a === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? -1 : 1) : -empty || -1;
            }
            if (b === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? 1 : -1) : empty || 1;
            }
            if (isNaN(a)) {
              a = ts.getTextValue(a, num, max);
            }
            if (isNaN(b)) {
              b = ts.getTextValue(b, num, max);
            }
            return a - b;
          },
          sortNumericDesc: function(a, b, num, max, col, c) {
            if (a === b) {
              return 0;
            }
            var empty = ts.string[(c.empties[col] || c.emptyTo)];
            if (a === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? -1 : 1) : empty || 1;
            }
            if (b === '' && empty !== 0) {
              return typeof empty === 'boolean' ? (empty ? 1 : -1) : -empty || -1;
            }
            if (isNaN(a)) {
              a = ts.getTextValue(a, num, max);
            }
            if (isNaN(b)) {
              b = ts.getTextValue(b, num, max);
            }
            return b - a;
          },
          sortNumeric: function(a, b) {
            return a - b;
          },
          addWidget: function(widget) {
            ts.widgets.push(widget);
          },
          hasWidget: function($table, name) {
            $table = $($table);
            return $table.length && $table[0].config && $table[0].config.widgetInit[name] || false;
          },
          getWidgetById: function(name) {
            var indx,
                widget,
                len = ts.widgets.length;
            for (indx = 0; indx < len; indx++) {
              widget = ts.widgets[indx];
              if (widget && widget.id && widget.id.toLowerCase() === name.toLowerCase()) {
                return widget;
              }
            }
          },
          applyWidgetOptions: function(table) {
            var indx,
                widget,
                c = table.config,
                len = c.widgets.length;
            if (len) {
              for (indx = 0; indx < len; indx++) {
                widget = ts.getWidgetById(c.widgets[indx]);
                if (widget && widget.options) {
                  c.widgetOptions = $.extend(true, {}, widget.options, c.widgetOptions);
                }
              }
            }
          },
          addWidgetFromClass: function(table) {
            var len,
                indx,
                c = table.config,
                regex = '\\s' + c.widgetClass.replace(ts.regex.templateName, '([\\w-]+)') + '\\s',
                widgetClass = new RegExp(regex, 'g'),
                widget = (' ' + c.table.className + ' ').match(widgetClass);
            if (widget) {
              len = widget.length;
              for (indx = 0; indx < len; indx++) {
                c.widgets.push(widget[indx].replace(widgetClass, '$1'));
              }
            }
          },
          applyWidgetId: function(table, id, init) {
            var applied,
                time,
                name,
                c = table.config,
                wo = c.widgetOptions,
                widget = ts.getWidgetById(id);
            if (widget) {
              name = widget.id;
              applied = false;
              if ($.inArray(name, c.widgets) < 0) {
                c.widgets.push(name);
              }
              if (c.debug) {
                time = new Date();
              }
              if (init || !(c.widgetInit[name])) {
                c.widgetInit[name] = true;
                if (table.hasInitialized) {
                  ts.applyWidgetOptions(table);
                }
                if (typeof widget.init === 'function') {
                  applied = true;
                  if (c.debug) {
                    console[console.group ? 'group' : 'log']('Initializing ' + name + ' widget');
                  }
                  widget.init(table, widget, c, wo);
                }
              }
              if (!init && typeof widget.format === 'function') {
                applied = true;
                if (c.debug) {
                  console[console.group ? 'group' : 'log']('Updating ' + name + ' widget');
                }
                widget.format(table, c, wo, false);
              }
              if (c.debug) {
                if (applied) {
                  console.log('Completed ' + (init ? 'initializing ' : 'applying ') + name + ' widget' + ts.benchmark(time));
                  if (console.groupEnd) {
                    console.groupEnd();
                  }
                }
              }
            }
          },
          applyWidget: function(table, init, callback) {
            table = $(table)[0];
            var indx,
                len,
                names,
                widget,
                time,
                c = table.config,
                widgets = [];
            if (init !== false && table.hasInitialized && (table.isApplyingWidgets || table.isUpdating)) {
              return;
            }
            if (c.debug) {
              time = new Date();
            }
            ts.addWidgetFromClass(table);
            clearTimeout(c.timerReady);
            if (c.widgets.length) {
              table.isApplyingWidgets = true;
              c.widgets = $.grep(c.widgets, function(val, index) {
                return $.inArray(val, c.widgets) === index;
              });
              names = c.widgets || [];
              len = names.length;
              for (indx = 0; indx < len; indx++) {
                widget = ts.getWidgetById(names[indx]);
                if (widget && widget.id) {
                  if (!widget.priority) {
                    widget.priority = 10;
                  }
                  widgets[indx] = widget;
                }
              }
              widgets.sort(function(a, b) {
                return a.priority < b.priority ? -1 : a.priority === b.priority ? 0 : 1;
              });
              len = widgets.length;
              if (c.debug) {
                console[console.group ? 'group' : 'log']('Start ' + (init ? 'initializing' : 'applying') + ' widgets');
              }
              for (indx = 0; indx < len; indx++) {
                widget = widgets[indx];
                if (widget && widget.id) {
                  ts.applyWidgetId(table, widget.id, init);
                }
              }
              if (c.debug && console.groupEnd) {
                console.groupEnd();
              }
              if (!init && typeof callback === 'function') {
                callback(table);
              }
            }
            c.timerReady = setTimeout(function() {
              table.isApplyingWidgets = false;
              $.data(table, 'lastWidgetApplication', new Date());
              c.$table.triggerHandler('tablesorter-ready');
            }, 10);
            if (c.debug) {
              widget = c.widgets.length;
              console.log('Completed ' + (init === true ? 'initializing ' : 'applying ') + widget + ' widget' + (widget !== 1 ? 's' : '') + ts.benchmark(time));
            }
          },
          removeWidget: function(table, name, refreshing) {
            table = $(table)[0];
            var index,
                widget,
                indx,
                len,
                c = table.config;
            if (name === true) {
              name = [];
              len = ts.widgets.length;
              for (indx = 0; indx < len; indx++) {
                widget = ts.widgets[indx];
                if (widget && widget.id) {
                  name.push(widget.id);
                }
              }
            } else {
              name = ($.isArray(name) ? name.join(',') : name || '').toLowerCase().split(/[\s,]+/);
            }
            len = name.length;
            for (index = 0; index < len; index++) {
              widget = ts.getWidgetById(name[index]);
              indx = $.inArray(name[index], c.widgets);
              if (widget && widget.remove) {
                if (c.debug) {
                  console.log((refreshing ? 'Refreshing' : 'Removing') + ' "' + name[index] + '" widget');
                }
                widget.remove(table, c, c.widgetOptions, refreshing);
                c.widgetInit[name[index]] = false;
              }
              if (indx >= 0 && refreshing !== true) {
                c.widgets.splice(indx, 1);
              }
            }
          },
          refreshWidgets: function(table, doAll, dontapply) {
            table = $(table)[0];
            var indx,
                widget,
                c = table.config,
                curWidgets = c.widgets,
                widgets = ts.widgets,
                len = widgets.length,
                list = [],
                callback = function(table) {
                  $(table).triggerHandler('refreshComplete');
                };
            for (indx = 0; indx < len; indx++) {
              widget = widgets[indx];
              if (widget && widget.id && (doAll || $.inArray(widget.id, curWidgets) < 0)) {
                list.push(widget.id);
              }
            }
            ts.removeWidget(table, list.join(','), true);
            if (dontapply !== true) {
              ts.applyWidget(table, doAll || false, callback);
              if (doAll) {
                ts.applyWidget(table, false, callback);
              }
            } else {
              callback(table);
            }
          },
          benchmark: function(diff) {
            return (' ( ' + (new Date().getTime() - diff.getTime()) + 'ms )');
          },
          log: function() {
            console.log(arguments);
          },
          isEmptyObject: function(obj) {
            for (var name in obj) {
              return false;
            }
            return true;
          },
          isValueInArray: function(column, arry) {
            var indx,
                len = arry && arry.length || 0;
            for (indx = 0; indx < len; indx++) {
              if (arry[indx][0] === column) {
                return indx;
              }
            }
            return -1;
          },
          formatFloat: function(str, table) {
            if (typeof str !== 'string' || str === '') {
              return str;
            }
            var num,
                usFormat = table && table.config ? table.config.usNumberFormat !== false : typeof table !== 'undefined' ? table : true;
            if (usFormat) {
              str = str.replace(ts.regex.comma, '');
            } else {
              str = str.replace(ts.regex.digitNonUS, '').replace(ts.regex.comma, '.');
            }
            if (ts.regex.digitNegativeTest.test(str)) {
              str = str.replace(ts.regex.digitNegativeReplace, '-$1');
            }
            num = parseFloat(str);
            return isNaN(num) ? $.trim(str) : num;
          },
          isDigit: function(str) {
            return isNaN(str) ? ts.regex.digitTest.test(str.toString().replace(ts.regex.digitReplace, '')) : str !== '';
          },
          computeColumnIndex: function($rows, c) {
            var i,
                j,
                k,
                l,
                cell,
                cells,
                rowIndex,
                rowSpan,
                colSpan,
                firstAvailCol,
                columns = c && c.columns || 0,
                matrix = [],
                matrixrow = new Array(columns);
            for (i = 0; i < $rows.length; i++) {
              cells = $rows[i].cells;
              for (j = 0; j < cells.length; j++) {
                cell = cells[j];
                rowIndex = cell.parentNode.rowIndex;
                rowSpan = cell.rowSpan || 1;
                colSpan = cell.colSpan || 1;
                if (typeof matrix[rowIndex] === 'undefined') {
                  matrix[rowIndex] = [];
                }
                for (k = 0; k < matrix[rowIndex].length + 1; k++) {
                  if (typeof matrix[rowIndex][k] === 'undefined') {
                    firstAvailCol = k;
                    break;
                  }
                }
                if (columns && cell.cellIndex === firstAvailCol) {} else if (cell.setAttribute) {
                  cell.setAttribute('data-column', firstAvailCol);
                } else {
                  $(cell).attr('data-column', firstAvailCol);
                }
                for (k = rowIndex; k < rowIndex + rowSpan; k++) {
                  if (typeof matrix[k] === 'undefined') {
                    matrix[k] = [];
                  }
                  matrixrow = matrix[k];
                  for (l = firstAvailCol; l < firstAvailCol + colSpan; l++) {
                    matrixrow[l] = 'x';
                  }
                }
              }
            }
            return matrixrow.length;
          },
          fixColumnWidth: function(table) {
            table = $(table)[0];
            var overallWidth,
                percent,
                $tbodies,
                len,
                index,
                c = table.config,
                $colgroup = c.$table.children('colgroup');
            if ($colgroup.length && $colgroup.hasClass(ts.css.colgroup)) {
              $colgroup.remove();
            }
            if (c.widthFixed && c.$table.children('colgroup').length === 0) {
              $colgroup = $('<colgroup class="' + ts.css.colgroup + '">');
              overallWidth = c.$table.width();
              $tbodies = c.$tbodies.find('tr:first').children(':visible');
              len = $tbodies.length;
              for (index = 0; index < len; index++) {
                percent = parseInt(($tbodies.eq(index).width() / overallWidth) * 1000, 10) / 10 + '%';
                $colgroup.append($('<col>').css('width', percent));
              }
              c.$table.prepend($colgroup);
            }
          },
          getData: function(header, configHeader, key) {
            var meta,
                cl4ss,
                val = '',
                $header = $(header);
            if (!$header.length) {
              return '';
            }
            meta = $.metadata ? $header.metadata() : false;
            cl4ss = ' ' + ($header.attr('class') || '');
            if (typeof $header.data(key) !== 'undefined' || typeof $header.data(key.toLowerCase()) !== 'undefined') {
              val += $header.data(key) || $header.data(key.toLowerCase());
            } else if (meta && typeof meta[key] !== 'undefined') {
              val += meta[key];
            } else if (configHeader && typeof configHeader[key] !== 'undefined') {
              val += configHeader[key];
            } else if (cl4ss !== ' ' && cl4ss.match(' ' + key + '-')) {
              val = cl4ss.match(new RegExp('\\s' + key + '-([\\w-]+)'))[1] || '';
            }
            return $.trim(val);
          },
          getColumnData: function(table, obj, indx, getCell, $headers) {
            if (typeof obj === 'undefined' || obj === null) {
              return;
            }
            table = $(table)[0];
            var $header,
                key,
                c = table.config,
                $cells = ($headers || c.$headers),
                $cell = c.$headerIndexed && c.$headerIndexed[indx] || $cells.filter('[data-column="' + indx + '"]:last');
            if (obj[indx]) {
              return getCell ? obj[indx] : obj[$cells.index($cell)];
            }
            for (key in obj) {
              if (typeof key === 'string') {
                $header = $cell.filter(key).add($cell.find(key));
                if ($header.length) {
                  return obj[key];
                }
              }
            }
            return;
          },
          isProcessing: function($table, toggle, $headers) {
            $table = $($table);
            var c = $table[0].config,
                $header = $headers || $table.find('.' + ts.css.header);
            if (toggle) {
              if (typeof $headers !== 'undefined' && c.sortList.length > 0) {
                $header = $header.filter(function() {
                  return this.sortDisabled ? false : ts.isValueInArray(parseFloat($(this).attr('data-column')), c.sortList) >= 0;
                });
              }
              $table.add($header).addClass(ts.css.processing + ' ' + c.cssProcessing);
            } else {
              $table.add($header).removeClass(ts.css.processing + ' ' + c.cssProcessing);
            }
          },
          processTbody: function(table, $tb, getIt) {
            table = $(table)[0];
            if (getIt) {
              table.isProcessing = true;
              $tb.before('<colgroup class="tablesorter-savemyplace"/>');
              return $.fn.detach ? $tb.detach() : $tb.remove();
            }
            var holdr = $(table).find('colgroup.tablesorter-savemyplace');
            $tb.insertAfter(holdr);
            holdr.remove();
            table.isProcessing = false;
          },
          clearTableBody: function(table) {
            $(table)[0].config.$tbodies.children().detach();
          },
          characterEquivalents: {
            'a': '\u00e1\u00e0\u00e2\u00e3\u00e4\u0105\u00e5',
            'A': '\u00c1\u00c0\u00c2\u00c3\u00c4\u0104\u00c5',
            'c': '\u00e7\u0107\u010d',
            'C': '\u00c7\u0106\u010c',
            'e': '\u00e9\u00e8\u00ea\u00eb\u011b\u0119',
            'E': '\u00c9\u00c8\u00ca\u00cb\u011a\u0118',
            'i': '\u00ed\u00ec\u0130\u00ee\u00ef\u0131',
            'I': '\u00cd\u00cc\u0130\u00ce\u00cf',
            'o': '\u00f3\u00f2\u00f4\u00f5\u00f6\u014d',
            'O': '\u00d3\u00d2\u00d4\u00d5\u00d6\u014c',
            'ss': '\u00df',
            'SS': '\u1e9e',
            'u': '\u00fa\u00f9\u00fb\u00fc\u016f',
            'U': '\u00da\u00d9\u00db\u00dc\u016e'
          },
          replaceAccents: function(str) {
            var chr,
                acc = '[',
                eq = ts.characterEquivalents;
            if (!ts.characterRegex) {
              ts.characterRegexArray = {};
              for (chr in eq) {
                if (typeof chr === 'string') {
                  acc += eq[chr];
                  ts.characterRegexArray[chr] = new RegExp('[' + eq[chr] + ']', 'g');
                }
              }
              ts.characterRegex = new RegExp(acc + ']');
            }
            if (ts.characterRegex.test(str)) {
              for (chr in eq) {
                if (typeof chr === 'string') {
                  str = str.replace(ts.characterRegexArray[chr], chr);
                }
              }
            }
            return str;
          },
          restoreHeaders: function(table) {
            var index,
                $cell,
                c = $(table)[0].config,
                $headers = c.$table.find(c.selectorHeaders),
                len = $headers.length;
            for (index = 0; index < len; index++) {
              $cell = $headers.eq(index);
              if ($cell.find('.' + ts.css.headerIn).length) {
                $cell.html(c.headerContent[index]);
              }
            }
          },
          destroy: function(table, removeClasses, callback) {
            table = $(table)[0];
            if (!table.hasInitialized) {
              return;
            }
            ts.removeWidget(table, true, false);
            var events,
                $t = $(table),
                c = table.config,
                debug = c.debug,
                $h = $t.find('thead:first'),
                $r = $h.find('tr.' + ts.css.headerRow).removeClass(ts.css.headerRow + ' ' + c.cssHeaderRow),
                $f = $t.find('tfoot:first > tr').children('th, td');
            if (removeClasses === false && $.inArray('uitheme', c.widgets) >= 0) {
              $t.triggerHandler('applyWidgetId', ['uitheme']);
              $t.triggerHandler('applyWidgetId', ['zebra']);
            }
            $h.find('tr').not($r).remove();
            events = 'sortReset update updateRows updateAll updateHeaders updateCell addRows updateComplete sorton ' + 'appendCache updateCache applyWidgetId applyWidgets refreshWidgets removeWidget destroy mouseup mouseleave ' + 'keypress sortBegin sortEnd resetToLoadState '.split(' ').join(c.namespace + ' ');
            $t.removeData('tablesorter').unbind(events.replace(ts.regex.spaces, ' '));
            c.$headers.add($f).removeClass([ts.css.header, c.cssHeader, c.cssAsc, c.cssDesc, ts.css.sortAsc, ts.css.sortDesc, ts.css.sortNone].join(' ')).removeAttr('data-column').removeAttr('aria-label').attr('aria-disabled', 'true');
            $r.find(c.selectorSort).unbind(('mousedown mouseup keypress '.split(' ').join(c.namespace + ' ')).replace(ts.regex.spaces, ' '));
            ts.restoreHeaders(table);
            $t.toggleClass(ts.css.table + ' ' + c.tableClass + ' tablesorter-' + c.theme, removeClasses === false);
            table.hasInitialized = false;
            delete table.config.cache;
            if (typeof callback === 'function') {
              callback(table);
            }
            if (debug) {
              console.log('tablesorter has been removed');
            }
          }
        };
        $.fn.tablesorter = function(settings) {
          return this.each(function() {
            var table = this,
                c = $.extend(true, {}, ts.defaults, settings, ts.instanceMethods);
            c.originalSettings = settings;
            if (!table.hasInitialized && ts.buildTable && this.nodeName !== 'TABLE') {
              ts.buildTable(table, c);
            } else {
              ts.setup(table, c);
            }
          });
        };
        if (!(window.console && window.console.log)) {
          ts.logs = [];
          console = {};
          console.log = console.warn = console.error = console.table = function() {
            var arg = arguments.length > 1 ? arguments : arguments[0];
            ts.logs.push({
              date: Date.now(),
              log: arg
            });
          };
        }
        ts.addParser({
          id: 'no-parser',
          is: function() {
            return false;
          },
          format: function() {
            return '';
          },
          type: 'text'
        });
        ts.addParser({
          id: 'text',
          is: function() {
            return true;
          },
          format: function(str, table) {
            var c = table.config;
            if (str) {
              str = $.trim(c.ignoreCase ? str.toLocaleLowerCase() : str);
              str = c.sortLocaleCompare ? ts.replaceAccents(str) : str;
            }
            return str;
          },
          type: 'text'
        });
        ts.regex.nondigit = /[^\w,. \-()]/g;
        ts.addParser({
          id: 'digit',
          is: function(str) {
            return ts.isDigit(str);
          },
          format: function(str, table) {
            var num = ts.formatFloat((str || '').replace(ts.regex.nondigit, ''), table);
            return str && typeof num === 'number' ? num : str ? $.trim(str && table.config.ignoreCase ? str.toLocaleLowerCase() : str) : str;
          },
          type: 'numeric'
        });
        ts.regex.currencyReplace = /[+\-,. ]/g;
        ts.regex.currencyTest = /^\(?\d+[\u00a3$\u20ac\u00a4\u00a5\u00a2?.]|[\u00a3$\u20ac\u00a4\u00a5\u00a2?.]\d+\)?$/;
        ts.addParser({
          id: 'currency',
          is: function(str) {
            str = (str || '').replace(ts.regex.currencyReplace, '');
            return ts.regex.currencyTest.test(str);
          },
          format: function(str, table) {
            var num = ts.formatFloat((str || '').replace(ts.regex.nondigit, ''), table);
            return str && typeof num === 'number' ? num : str ? $.trim(str && table.config.ignoreCase ? str.toLocaleLowerCase() : str) : str;
          },
          type: 'numeric'
        });
        ts.regex.urlProtocolTest = /^(https?|ftp|file):\/\//;
        ts.regex.urlProtocolReplace = /(https?|ftp|file):\/\//;
        ts.addParser({
          id: 'url',
          is: function(str) {
            return ts.regex.urlProtocolTest.test(str);
          },
          format: function(str) {
            return str ? $.trim(str.replace(ts.regex.urlProtocolReplace, '')) : str;
          },
          parsed: true,
          type: 'text'
        });
        ts.regex.dash = /-/g;
        ts.regex.isoDate = /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/;
        ts.addParser({
          id: 'isoDate',
          is: function(str) {
            return ts.regex.isoDate.test(str);
          },
          format: function(str, table) {
            var date = str ? new Date(str.replace(ts.regex.dash, '/')) : str;
            return date instanceof Date && isFinite(date) ? date.getTime() : str;
          },
          type: 'numeric'
        });
        ts.regex.percent = /%/g;
        ts.regex.percentTest = /(\d\s*?%|%\s*?\d)/;
        ts.addParser({
          id: 'percent',
          is: function(str) {
            return ts.regex.percentTest.test(str) && str.length < 15;
          },
          format: function(str, table) {
            return str ? ts.formatFloat(str.replace(ts.regex.percent, ''), table) : str;
          },
          type: 'numeric'
        });
        ts.addParser({
          id: 'image',
          is: function(str, table, node, $node) {
            return $node.find('img').length > 0;
          },
          format: function(str, table, cell) {
            return $(cell).find('img').attr(table.config.imgAttr || 'alt') || str;
          },
          parsed: true,
          type: 'text'
        });
        ts.regex.dateReplace = /(\S)([AP]M)$/i;
        ts.regex.usLongDateTest1 = /^[A-Z]{3,10}\.?\s+\d{1,2},?\s+(\d{4})(\s+\d{1,2}:\d{2}(:\d{2})?(\s+[AP]M)?)?$/i;
        ts.regex.usLongDateTest2 = /^\d{1,2}\s+[A-Z]{3,10}\s+\d{4}/i;
        ts.addParser({
          id: 'usLongDate',
          is: function(str) {
            return ts.regex.usLongDateTest1.test(str) || ts.regex.usLongDateTest2.test(str);
          },
          format: function(str, table) {
            var date = str ? new Date(str.replace(ts.regex.dateReplace, '$1 $2')) : str;
            return date instanceof Date && isFinite(date) ? date.getTime() : str;
          },
          type: 'numeric'
        });
        ts.regex.shortDateTest = /(^\d{1,2}[\/\s]\d{1,2}[\/\s]\d{4})|(^\d{4}[\/\s]\d{1,2}[\/\s]\d{1,2})/;
        ts.regex.shortDateReplace = /[\-.,]/g;
        ts.regex.shortDateXXY = /(\d{1,2})[\/\s](\d{1,2})[\/\s](\d{4})/;
        ts.regex.shortDateYMD = /(\d{4})[\/\s](\d{1,2})[\/\s](\d{1,2})/;
        ts.convertFormat = function(dateString, format) {
          dateString = (dateString || '').replace(ts.regex.spaces, ' ').replace(ts.regex.shortDateReplace, '/');
          if (format === 'mmddyyyy') {
            dateString = dateString.replace(ts.regex.shortDateXXY, '$3/$1/$2');
          } else if (format === 'ddmmyyyy') {
            dateString = dateString.replace(ts.regex.shortDateXXY, '$3/$2/$1');
          } else if (format === 'yyyymmdd') {
            dateString = dateString.replace(ts.regex.shortDateYMD, '$1/$2/$3');
          }
          var date = new Date(dateString);
          return date instanceof Date && isFinite(date) ? date.getTime() : '';
        };
        ts.addParser({
          id: 'shortDate',
          is: function(str) {
            str = (str || '').replace(ts.regex.spaces, ' ').replace(ts.regex.shortDateReplace, '/');
            return ts.regex.shortDateTest.test(str);
          },
          format: function(str, table, cell, cellIndex) {
            if (str) {
              var c = table.config,
                  $header = c.$headerIndexed[cellIndex],
                  format = $header.length && $header.data('dateFormat') || ts.getData($header, ts.getColumnData(table, c.headers, cellIndex), 'dateFormat') || c.dateFormat;
              if ($header.length) {
                $header.data('dateFormat', format);
              }
              return ts.convertFormat(str, format) || str;
            }
            return str;
          },
          type: 'numeric'
        });
        ts.regex.timeTest = /^([1-9]|1[0-2]):([0-5]\d)(\s[AP]M)|((?:[01]\d|[2][0-4]):[0-5]\d)$/i;
        ts.regex.timeMatch = /([1-9]|1[0-2]):([0-5]\d)(\s[AP]M)|((?:[01]\d|[2][0-4]):[0-5]\d)/i;
        ts.addParser({
          id: 'time',
          is: function(str) {
            return ts.regex.timeTest.test(str);
          },
          format: function(str, table) {
            var temp,
                timePart = (str || '').match(ts.regex.timeMatch),
                orig = new Date(str),
                time = str && (timePart !== null ? timePart[0] : '00:00 AM'),
                date = time ? new Date('2000/01/01 ' + time.replace(ts.regex.dateReplace, '$1 $2')) : time;
            if (date instanceof Date && isFinite(date)) {
              temp = orig instanceof Date && isFinite(orig) ? orig.getTime() : 0;
              return temp ? parseFloat(date.getTime() + '.' + orig.getTime()) : date.getTime();
            }
            return str;
          },
          type: 'numeric'
        });
        ts.addParser({
          id: 'metadata',
          is: function() {
            return false;
          },
          format: function(str, table, cell) {
            var c = table.config,
                p = (!c.parserMetadataName) ? 'sortValue' : c.parserMetadataName;
            return $(cell).metadata()[p];
          },
          type: 'numeric'
        });
        ts.addWidget({
          id: 'zebra',
          priority: 90,
          format: function(table, c, wo) {
            var $visibleRows,
                $row,
                count,
                isEven,
                tbodyIndex,
                rowIndex,
                len,
                child = new RegExp(c.cssChildRow, 'i'),
                $tbodies = c.$tbodies.add($(c.namespace + '_extra_table').children('tbody:not(.' + c.cssInfoBlock + ')'));
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              count = 0;
              $visibleRows = $tbodies.eq(tbodyIndex).children('tr:visible').not(c.selectorRemove);
              len = $visibleRows.length;
              for (rowIndex = 0; rowIndex < len; rowIndex++) {
                $row = $visibleRows.eq(rowIndex);
                if (!child.test($row[0].className)) {
                  count++;
                }
                isEven = (count % 2 === 0);
                $row.removeClass(wo.zebra[isEven ? 1 : 0]).addClass(wo.zebra[isEven ? 0 : 1]);
              }
            }
          },
          remove: function(table, c, wo, refreshing) {
            if (refreshing) {
              return;
            }
            var tbodyIndex,
                $tbody,
                $tbodies = c.$tbodies,
                toRemove = (wo.zebra || ['even', 'odd']).join(' ');
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              $tbody = ts.processTbody(table, $tbodies.eq(tbodyIndex), true);
              $tbody.children().removeClass(toRemove);
              ts.processTbody(table, $tbody, false);
            }
          }
        });
      })(jQuery);
      ;
      (function($, window, document) {
        'use strict';
        var ts = $.tablesorter || {};
        ts.storage = function(table, key, value, options) {
          table = $(table)[0];
          var cookieIndex,
              cookies,
              date,
              hasStorage = false,
              values = {},
              c = table.config,
              wo = c && c.widgetOptions,
              storageType = (options && options.useSessionStorage) || (wo && wo.storage_useSessionStorage) ? 'sessionStorage' : 'localStorage',
              $table = $(table),
              id = options && options.id || $table.attr(options && options.group || wo && wo.storage_group || 'data-table-group') || wo && wo.storage_tableId || table.id || $('.tablesorter').index($table),
              url = options && options.url || $table.attr(options && options.page || wo && wo.storage_page || 'data-table-page') || wo && wo.storage_fixedUrl || c && c.fixedUrl || window.location.pathname;
          if (storageType in window) {
            try {
              window[storageType].setItem('_tmptest', 'temp');
              hasStorage = true;
              window[storageType].removeItem('_tmptest');
            } catch (error) {
              if (c && c.debug) {
                console.warn(storageType + ' is not supported in this browser');
              }
            }
          }
          if ($.parseJSON) {
            if (hasStorage) {
              values = $.parseJSON(window[storageType][key] || 'null') || {};
            } else {
              cookies = document.cookie.split(/[;\s|=]/);
              cookieIndex = $.inArray(key, cookies) + 1;
              values = (cookieIndex !== 0) ? $.parseJSON(cookies[cookieIndex] || 'null') || {} : {};
            }
          }
          if ((value || value === '') && window.JSON && JSON.hasOwnProperty('stringify')) {
            if (!values[url]) {
              values[url] = {};
            }
            values[url][id] = value;
            if (hasStorage) {
              window[storageType][key] = JSON.stringify(values);
            } else {
              date = new Date();
              date.setTime(date.getTime() + (31536e+6));
              document.cookie = key + '=' + (JSON.stringify(values)).replace(/\"/g, '\"') + '; expires=' + date.toGMTString() + '; path=/';
            }
          } else {
            return values && values[url] ? values[url][id] : '';
          }
        };
      })(jQuery, window, document);
      ;
      (function($) {
        'use strict';
        var ts = $.tablesorter || {};
        ts.themes = {
          'bootstrap': {
            table: 'table table-bordered table-striped',
            caption: 'caption',
            header: 'bootstrap-header',
            sortNone: '',
            sortAsc: '',
            sortDesc: '',
            active: '',
            hover: '',
            icons: '',
            iconSortNone: 'bootstrap-icon-unsorted',
            iconSortAsc: 'icon-chevron-up glyphicon glyphicon-chevron-up',
            iconSortDesc: 'icon-chevron-down glyphicon glyphicon-chevron-down',
            filterRow: '',
            footerRow: '',
            footerCells: '',
            even: '',
            odd: ''
          },
          'jui': {
            table: 'ui-widget ui-widget-content ui-corner-all',
            caption: 'ui-widget-content',
            header: 'ui-widget-header ui-corner-all ui-state-default',
            sortNone: '',
            sortAsc: '',
            sortDesc: '',
            active: 'ui-state-active',
            hover: 'ui-state-hover',
            icons: 'ui-icon',
            iconSortNone: 'ui-icon-carat-2-n-s',
            iconSortAsc: 'ui-icon-carat-1-n',
            iconSortDesc: 'ui-icon-carat-1-s',
            filterRow: '',
            footerRow: '',
            footerCells: '',
            even: 'ui-widget-content',
            odd: 'ui-state-default'
          }
        };
        $.extend(ts.css, {wrapper: 'tablesorter-wrapper'});
        ts.addWidget({
          id: 'uitheme',
          priority: 10,
          format: function(table, c, wo) {
            var i,
                hdr,
                icon,
                time,
                $header,
                $icon,
                $tfoot,
                $h,
                oldtheme,
                oldremove,
                oldIconRmv,
                hasOldTheme,
                themesAll = ts.themes,
                $table = c.$table.add($(c.namespace + '_extra_table')),
                $headers = c.$headers.add($(c.namespace + '_extra_headers')),
                theme = c.theme || 'jui',
                themes = themesAll[theme] || {},
                remove = $.trim([themes.sortNone, themes.sortDesc, themes.sortAsc, themes.active].join(' ')),
                iconRmv = $.trim([themes.iconSortNone, themes.iconSortDesc, themes.iconSortAsc].join(' '));
            if (c.debug) {
              time = new Date();
            }
            if (!$table.hasClass('tablesorter-' + theme) || c.theme !== c.appliedTheme || !wo.uitheme_applied) {
              wo.uitheme_applied = true;
              oldtheme = themesAll[c.appliedTheme] || {};
              hasOldTheme = !$.isEmptyObject(oldtheme);
              oldremove = hasOldTheme ? [oldtheme.sortNone, oldtheme.sortDesc, oldtheme.sortAsc, oldtheme.active].join(' ') : '';
              oldIconRmv = hasOldTheme ? [oldtheme.iconSortNone, oldtheme.iconSortDesc, oldtheme.iconSortAsc].join(' ') : '';
              if (hasOldTheme) {
                wo.zebra[0] = $.trim(' ' + wo.zebra[0].replace(' ' + oldtheme.even, ''));
                wo.zebra[1] = $.trim(' ' + wo.zebra[1].replace(' ' + oldtheme.odd, ''));
                c.$tbodies.children().removeClass([oldtheme.even, oldtheme.odd].join(' '));
              }
              if (themes.even) {
                wo.zebra[0] += ' ' + themes.even;
              }
              if (themes.odd) {
                wo.zebra[1] += ' ' + themes.odd;
              }
              $table.children('caption').removeClass(oldtheme.caption || '').addClass(themes.caption);
              $tfoot = $table.removeClass((c.appliedTheme ? 'tablesorter-' + (c.appliedTheme || '') : '') + ' ' + (oldtheme.table || '')).addClass('tablesorter-' + theme + ' ' + (themes.table || '')).children('tfoot');
              c.appliedTheme = c.theme;
              if ($tfoot.length) {
                $tfoot.children('tr').removeClass(oldtheme.footerRow || '').addClass(themes.footerRow).children('th, td').removeClass(oldtheme.footerCells || '').addClass(themes.footerCells);
              }
              $headers.removeClass((hasOldTheme ? [oldtheme.header, oldtheme.hover, oldremove].join(' ') : '') || '').addClass(themes.header).not('.sorter-false').unbind('mouseenter.tsuitheme mouseleave.tsuitheme').bind('mouseenter.tsuitheme mouseleave.tsuitheme', function(event) {
                $(this)[event.type === 'mouseenter' ? 'addClass' : 'removeClass'](themes.hover || '');
              });
              $headers.each(function() {
                var $this = $(this);
                if (!$this.find('.' + ts.css.wrapper).length) {
                  $this.wrapInner('<div class="' + ts.css.wrapper + '" style="position:relative;height:100%;width:100%"></div>');
                }
              });
              if (c.cssIcon) {
                $headers.find('.' + ts.css.icon).removeClass(hasOldTheme ? [oldtheme.icons, oldIconRmv].join(' ') : '').addClass(themes.icons || '');
              }
              if ($table.hasClass('hasFilters')) {
                $table.children('thead').children('.' + ts.css.filterRow).removeClass(hasOldTheme ? oldtheme.filterRow || '' : '').addClass(themes.filterRow || '');
              }
            }
            for (i = 0; i < c.columns; i++) {
              $header = c.$headers.add($(c.namespace + '_extra_headers')).not('.sorter-false').filter('[data-column="' + i + '"]');
              $icon = (ts.css.icon) ? $header.find('.' + ts.css.icon) : $();
              $h = $headers.not('.sorter-false').filter('[data-column="' + i + '"]:last');
              if ($h.length) {
                $header.removeClass(remove);
                $icon.removeClass(iconRmv);
                if ($h[0].sortDisabled) {
                  $icon.removeClass(themes.icons || '');
                } else {
                  hdr = themes.sortNone;
                  icon = themes.iconSortNone;
                  if ($h.hasClass(ts.css.sortAsc)) {
                    hdr = [themes.sortAsc, themes.active].join(' ');
                    icon = themes.iconSortAsc;
                  } else if ($h.hasClass(ts.css.sortDesc)) {
                    hdr = [themes.sortDesc, themes.active].join(' ');
                    icon = themes.iconSortDesc;
                  }
                  $header.addClass(hdr);
                  $icon.addClass(icon || '');
                }
              }
            }
            if (c.debug) {
              console.log('Applying ' + theme + ' theme' + ts.benchmark(time));
            }
          },
          remove: function(table, c, wo, refreshing) {
            if (!wo.uitheme_applied) {
              return;
            }
            var $table = c.$table,
                theme = c.appliedTheme || 'jui',
                themes = ts.themes[theme] || ts.themes.jui,
                $headers = $table.children('thead').children(),
                remove = themes.sortNone + ' ' + themes.sortDesc + ' ' + themes.sortAsc,
                iconRmv = themes.iconSortNone + ' ' + themes.iconSortDesc + ' ' + themes.iconSortAsc;
            $table.removeClass('tablesorter-' + theme + ' ' + themes.table);
            wo.uitheme_applied = false;
            if (refreshing) {
              return;
            }
            $table.find(ts.css.header).removeClass(themes.header);
            $headers.unbind('mouseenter.tsuitheme mouseleave.tsuitheme').removeClass(themes.hover + ' ' + remove + ' ' + themes.active).filter('.' + ts.css.filterRow).removeClass(themes.filterRow);
            $headers.find('.' + ts.css.icon).removeClass(themes.icons + ' ' + iconRmv);
          }
        });
      })(jQuery);
      ;
      (function($) {
        'use strict';
        var ts = $.tablesorter || {};
        ts.addWidget({
          id: 'columns',
          priority: 30,
          options: {columns: ['primary', 'secondary', 'tertiary']},
          format: function(table, c, wo) {
            var $tbody,
                tbodyIndex,
                $rows,
                rows,
                $row,
                $cells,
                remove,
                indx,
                $table = c.$table,
                $tbodies = c.$tbodies,
                sortList = c.sortList,
                len = sortList.length,
                css = wo && wo.columns || ['primary', 'secondary', 'tertiary'],
                last = css.length - 1;
            remove = css.join(' ');
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              $tbody = ts.processTbody(table, $tbodies.eq(tbodyIndex), true);
              $rows = $tbody.children('tr');
              $rows.each(function() {
                $row = $(this);
                if (this.style.display !== 'none') {
                  $cells = $row.children().removeClass(remove);
                  if (sortList && sortList[0]) {
                    $cells.eq(sortList[0][0]).addClass(css[0]);
                    if (len > 1) {
                      for (indx = 1; indx < len; indx++) {
                        $cells.eq(sortList[indx][0]).addClass(css[indx] || css[last]);
                      }
                    }
                  }
                }
              });
              ts.processTbody(table, $tbody, false);
            }
            rows = wo.columns_thead !== false ? ['thead tr'] : [];
            if (wo.columns_tfoot !== false) {
              rows.push('tfoot tr');
            }
            if (rows.length) {
              $rows = $table.find(rows.join(',')).children().removeClass(remove);
              if (len) {
                for (indx = 0; indx < len; indx++) {
                  $rows.filter('[data-column="' + sortList[indx][0] + '"]').addClass(css[indx] || css[last]);
                }
              }
            }
          },
          remove: function(table, c, wo) {
            var tbodyIndex,
                $tbody,
                $tbodies = c.$tbodies,
                remove = (wo.columns || ['primary', 'secondary', 'tertiary']).join(' ');
            c.$headers.removeClass(remove);
            c.$table.children('tfoot').children('tr').children('th, td').removeClass(remove);
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              $tbody = ts.processTbody(table, $tbodies.eq(tbodyIndex), true);
              $tbody.children('tr').each(function() {
                $(this).children().removeClass(remove);
              });
              ts.processTbody(table, $tbody, false);
            }
          }
        });
      })(jQuery);
      ;
      (function($) {
        'use strict';
        var tsf,
            tsfRegex,
            ts = $.tablesorter || {},
            tscss = ts.css;
        $.extend(tscss, {
          filterRow: 'tablesorter-filter-row',
          filter: 'tablesorter-filter',
          filterDisabled: 'disabled',
          filterRowHide: 'hideme'
        });
        ts.addWidget({
          id: 'filter',
          priority: 50,
          options: {
            filter_childRows: false,
            filter_childByColumn: false,
            filter_childWithSibs: true,
            filter_columnFilters: true,
            filter_columnAnyMatch: true,
            filter_cellFilter: '',
            filter_cssFilter: '',
            filter_defaultFilter: {},
            filter_excludeFilter: {},
            filter_external: '',
            filter_filteredRow: 'filtered',
            filter_formatter: null,
            filter_functions: null,
            filter_hideEmpty: true,
            filter_hideFilters: false,
            filter_ignoreCase: true,
            filter_liveSearch: true,
            filter_onlyAvail: 'filter-onlyAvail',
            filter_placeholder: {
              search: '',
              select: ''
            },
            filter_reset: null,
            filter_saveFilters: false,
            filter_searchDelay: 300,
            filter_searchFiltered: true,
            filter_selectSource: null,
            filter_startsWith: false,
            filter_useParsedData: false,
            filter_serversideFiltering: false,
            filter_defaultAttrib: 'data-value',
            filter_selectSourceSeparator: '|'
          },
          format: function(table, c, wo) {
            if (!c.$table.hasClass('hasFilters')) {
              tsf.init(table, c, wo);
            }
          },
          remove: function(table, c, wo, refreshing) {
            var tbodyIndex,
                $tbody,
                $table = c.$table,
                $tbodies = c.$tbodies,
                events = 'addRows updateCell update updateRows updateComplete appendCache filterReset filterEnd search '.split(' ').join(c.namespace + 'filter ');
            $table.removeClass('hasFilters').unbind(events.replace(ts.regex.spaces, ' ')).find('.' + tscss.filterRow).remove();
            if (refreshing) {
              return;
            }
            for (tbodyIndex = 0; tbodyIndex < $tbodies.length; tbodyIndex++) {
              $tbody = ts.processTbody(table, $tbodies.eq(tbodyIndex), true);
              $tbody.children().removeClass(wo.filter_filteredRow).show();
              ts.processTbody(table, $tbody, false);
            }
            if (wo.filter_reset) {
              $(document).undelegate(wo.filter_reset, 'click' + c.namespace + 'filter');
            }
          }
        });
        tsf = ts.filter = {
          regex: {
            regex: /^\/((?:\\\/|[^\/])+)\/([mig]{0,3})?$/,
            child: /tablesorter-childRow/,
            filtered: /filtered/,
            type: /undefined|number/,
            exact: /(^[\"\'=]+)|([\"\'=]+$)/g,
            operators: /[<>=]/g,
            query: '(q|query)',
            wild01: /\?/g,
            wild0More: /\*/g,
            quote: /\"/g,
            isNeg1: /(>=?\s*-\d)/,
            isNeg2: /(<=?\s*\d)/
          },
          types: {
            or: function(c, data, vars) {
              if ((tsfRegex.orTest.test(data.iFilter) || tsfRegex.orSplit.test(data.filter)) && !tsfRegex.regex.test(data.filter)) {
                var indx,
                    filterMatched,
                    query,
                    regex,
                    data2 = $.extend({}, data),
                    filter = data.filter.split(tsfRegex.orSplit),
                    iFilter = data.iFilter.split(tsfRegex.orSplit),
                    len = filter.length;
                for (indx = 0; indx < len; indx++) {
                  data2.nestedFilters = true;
                  data2.filter = '' + (tsf.parseFilter(c, filter[indx], data) || '');
                  data2.iFilter = '' + (tsf.parseFilter(c, iFilter[indx], data) || '');
                  query = '(' + (tsf.parseFilter(c, data2.filter, data) || '') + ')';
                  try {
                    regex = new RegExp(data.isMatch ? query : '^' + query + '$', c.widgetOptions.filter_ignoreCase ? 'i' : '');
                    filterMatched = regex.test(data2.exact) || tsf.processTypes(c, data2, vars);
                    if (filterMatched) {
                      return filterMatched;
                    }
                  } catch (error) {
                    return null;
                  }
                }
                return filterMatched || false;
              }
              return null;
            },
            and: function(c, data, vars) {
              if (tsfRegex.andTest.test(data.filter)) {
                var indx,
                    filterMatched,
                    result,
                    query,
                    regex,
                    data2 = $.extend({}, data),
                    filter = data.filter.split(tsfRegex.andSplit),
                    iFilter = data.iFilter.split(tsfRegex.andSplit),
                    len = filter.length;
                for (indx = 0; indx < len; indx++) {
                  data2.nestedFilters = true;
                  data2.filter = '' + (tsf.parseFilter(c, filter[indx], data) || '');
                  data2.iFilter = '' + (tsf.parseFilter(c, iFilter[indx], data) || '');
                  query = ('(' + (tsf.parseFilter(c, data2.filter, data) || '') + ')').replace(tsfRegex.wild01, '\\S{1}').replace(tsfRegex.wild0More, '\\S*');
                  try {
                    regex = new RegExp(data.isMatch ? query : '^' + query + '$', c.widgetOptions.filter_ignoreCase ? 'i' : '');
                    result = (regex.test(data2.exact) || tsf.processTypes(c, data2, vars));
                    if (indx === 0) {
                      filterMatched = result;
                    } else {
                      filterMatched = filterMatched && result;
                    }
                  } catch (error) {
                    return null;
                  }
                }
                return filterMatched || false;
              }
              return null;
            },
            regex: function(c, data) {
              if (tsfRegex.regex.test(data.filter)) {
                var matches,
                    regex = data.filter_regexCache[data.index] || tsfRegex.regex.exec(data.filter),
                    isRegex = regex instanceof RegExp;
                try {
                  if (!isRegex) {
                    data.filter_regexCache[data.index] = regex = new RegExp(regex[1], regex[2]);
                  }
                  matches = regex.test(data.exact);
                } catch (error) {
                  matches = false;
                }
                return matches;
              }
              return null;
            },
            operators: function(c, data) {
              if (tsfRegex.operTest.test(data.iFilter) && data.iExact !== '') {
                var cachedValue,
                    result,
                    txt,
                    table = c.table,
                    parsed = data.parsed[data.index],
                    query = ts.formatFloat(data.iFilter.replace(tsfRegex.operators, ''), table),
                    parser = c.parsers[data.index] || {},
                    savedSearch = query;
                if (parsed || parser.type === 'numeric') {
                  txt = $.trim('' + data.iFilter.replace(tsfRegex.operators, ''));
                  result = tsf.parseFilter(c, txt, data, true);
                  query = (typeof result === 'number' && result !== '' && !isNaN(result)) ? result : query;
                }
                if ((parsed || parser.type === 'numeric') && !isNaN(query) && typeof data.cache !== 'undefined') {
                  cachedValue = data.cache;
                } else {
                  txt = isNaN(data.iExact) ? data.iExact.replace(ts.regex.nondigit, '') : data.iExact;
                  cachedValue = ts.formatFloat(txt, table);
                }
                if (tsfRegex.gtTest.test(data.iFilter)) {
                  result = tsfRegex.gteTest.test(data.iFilter) ? cachedValue >= query : cachedValue > query;
                } else if (tsfRegex.ltTest.test(data.iFilter)) {
                  result = tsfRegex.lteTest.test(data.iFilter) ? cachedValue <= query : cachedValue < query;
                }
                if (!result && savedSearch === '') {
                  result = true;
                }
                return result;
              }
              return null;
            },
            notMatch: function(c, data) {
              if (tsfRegex.notTest.test(data.iFilter)) {
                var indx,
                    txt = data.iFilter.replace('!', ''),
                    filter = tsf.parseFilter(c, txt, data) || '';
                if (tsfRegex.exact.test(filter)) {
                  filter = filter.replace(tsfRegex.exact, '');
                  return filter === '' ? true : $.trim(filter) !== data.iExact;
                } else {
                  indx = data.iExact.search($.trim(filter));
                  return filter === '' ? true : !(c.widgetOptions.filter_startsWith ? indx === 0 : indx >= 0);
                }
              }
              return null;
            },
            exact: function(c, data) {
              if (tsfRegex.exact.test(data.iFilter)) {
                var txt = data.iFilter.replace(tsfRegex.exact, ''),
                    filter = tsf.parseFilter(c, txt, data) || '';
                return data.anyMatch ? $.inArray(filter, data.rowArray) >= 0 : filter == data.iExact;
              }
              return null;
            },
            range: function(c, data) {
              if (tsfRegex.toTest.test(data.iFilter)) {
                var result,
                    tmp,
                    range1,
                    range2,
                    table = c.table,
                    index = data.index,
                    parsed = data.parsed[index],
                    query = data.iFilter.split(tsfRegex.toSplit);
                tmp = query[0].replace(ts.regex.nondigit, '') || '';
                range1 = ts.formatFloat(tsf.parseFilter(c, tmp, data), table);
                tmp = query[1].replace(ts.regex.nondigit, '') || '';
                range2 = ts.formatFloat(tsf.parseFilter(c, tmp, data), table);
                if (parsed || c.parsers[index].type === 'numeric') {
                  result = c.parsers[index].format('' + query[0], table, c.$headers.eq(index), index);
                  range1 = (result !== '' && !isNaN(result)) ? result : range1;
                  result = c.parsers[index].format('' + query[1], table, c.$headers.eq(index), index);
                  range2 = (result !== '' && !isNaN(result)) ? result : range2;
                }
                if ((parsed || c.parsers[index].type === 'numeric') && !isNaN(range1) && !isNaN(range2)) {
                  result = data.cache;
                } else {
                  tmp = isNaN(data.iExact) ? data.iExact.replace(ts.regex.nondigit, '') : data.iExact;
                  result = ts.formatFloat(tmp, table);
                }
                if (range1 > range2) {
                  tmp = range1;
                  range1 = range2;
                  range2 = tmp;
                }
                return (result >= range1 && result <= range2) || (range1 === '' || range2 === '');
              }
              return null;
            },
            wild: function(c, data) {
              if (tsfRegex.wildOrTest.test(data.iFilter)) {
                var query = '' + (tsf.parseFilter(c, data.iFilter, data) || '');
                if (!tsfRegex.wildTest.test(query) && data.nestedFilters) {
                  query = data.isMatch ? query : '^(' + query + ')$';
                }
                try {
                  return new RegExp(query.replace(tsfRegex.wild01, '\\S{1}').replace(tsfRegex.wild0More, '\\S*'), c.widgetOptions.filter_ignoreCase ? 'i' : '').test(data.exact);
                } catch (error) {
                  return null;
                }
              }
              return null;
            },
            fuzzy: function(c, data) {
              if (tsfRegex.fuzzyTest.test(data.iFilter)) {
                var indx,
                    patternIndx = 0,
                    len = data.iExact.length,
                    txt = data.iFilter.slice(1),
                    pattern = tsf.parseFilter(c, txt, data) || '';
                for (indx = 0; indx < len; indx++) {
                  if (data.iExact[indx] === pattern[patternIndx]) {
                    patternIndx += 1;
                  }
                }
                return patternIndx === pattern.length;
              }
              return null;
            }
          },
          init: function(table, c, wo) {
            ts.language = $.extend(true, {}, {
              to: 'to',
              or: 'or',
              and: 'and'
            }, ts.language);
            var options,
                string,
                txt,
                $header,
                column,
                filters,
                val,
                fxn,
                noSelect;
            c.$table.addClass('hasFilters');
            c.lastSearch = [];
            wo.filter_searchTimer = null;
            wo.filter_initTimer = null;
            wo.filter_formatterCount = 0;
            wo.filter_formatterInit = [];
            wo.filter_anyColumnSelector = '[data-column="all"],[data-column="any"]';
            wo.filter_multipleColumnSelector = '[data-column*="-"],[data-column*=","]';
            val = '\\{' + tsfRegex.query + '\\}';
            $.extend(tsfRegex, {
              child: new RegExp(c.cssChildRow),
              filtered: new RegExp(wo.filter_filteredRow),
              alreadyFiltered: new RegExp('(\\s+(' + ts.language.or + '|-|' + ts.language.to + ')\\s+)', 'i'),
              toTest: new RegExp('\\s+(-|' + ts.language.to + ')\\s+', 'i'),
              toSplit: new RegExp('(?:\\s+(?:-|' + ts.language.to + ')\\s+)', 'gi'),
              andTest: new RegExp('\\s+(' + ts.language.and + '|&&)\\s+', 'i'),
              andSplit: new RegExp('(?:\\s+(?:' + ts.language.and + '|&&)\\s+)', 'gi'),
              orTest: /\|/,
              orSplit: new RegExp('(?:\\s+(?:' + ts.language.or + ')\\s+|\\|)', 'gi'),
              iQuery: new RegExp(val, 'i'),
              igQuery: new RegExp(val, 'ig'),
              operTest: /^[<>]=?/,
              gtTest: />/,
              gteTest: />=/,
              ltTest: /</,
              lteTest: /<=/,
              notTest: /^\!/,
              wildOrTest: /[\?\*\|]/,
              wildTest: /\?\*/,
              fuzzyTest: /^~/,
              exactTest: /[=\"\|!]/
            });
            val = c.$headers.filter('.filter-false, .parser-false').length;
            if (wo.filter_columnFilters !== false && val !== c.$headers.length) {
              tsf.buildRow(table, c, wo);
            }
            txt = 'addRows updateCell update updateRows updateComplete appendCache filterReset filterEnd search '.split(' ').join(c.namespace + 'filter ');
            c.$table.bind(txt, function(event, filter) {
              val = wo.filter_hideEmpty && $.isEmptyObject(c.cache) && !(c.delayInit && event.type === 'appendCache');
              c.$table.find('.' + tscss.filterRow).toggleClass(wo.filter_filteredRow, val);
              if (!/(search|filter)/.test(event.type)) {
                event.stopPropagation();
                tsf.buildDefault(table, true);
              }
              if (event.type === 'filterReset') {
                c.$table.find('.' + tscss.filter).add(wo.filter_$externalFilters).val('');
                tsf.searching(table, []);
              } else if (event.type === 'filterEnd') {
                tsf.buildDefault(table, true);
              } else {
                filter = event.type === 'search' ? filter : event.type === 'updateComplete' ? c.$table.data('lastSearch') : '';
                if (/(update|add)/.test(event.type) && event.type !== 'updateComplete') {
                  c.lastCombinedFilter = null;
                  c.lastSearch = [];
                }
                tsf.searching(table, filter, true);
              }
              return false;
            });
            if (wo.filter_reset) {
              if (wo.filter_reset instanceof $) {
                wo.filter_reset.click(function() {
                  c.$table.triggerHandler('filterReset');
                });
              } else if ($(wo.filter_reset).length) {
                $(document).undelegate(wo.filter_reset, 'click' + c.namespace + 'filter').delegate(wo.filter_reset, 'click' + c.namespace + 'filter', function() {
                  c.$table.triggerHandler('filterReset');
                });
              }
            }
            if (wo.filter_functions) {
              for (column = 0; column < c.columns; column++) {
                fxn = ts.getColumnData(table, wo.filter_functions, column);
                if (fxn) {
                  $header = c.$headerIndexed[column].removeClass('filter-select');
                  noSelect = !($header.hasClass('filter-false') || $header.hasClass('parser-false'));
                  options = '';
                  if (fxn === true && noSelect) {
                    tsf.buildSelect(table, column);
                  } else if (typeof fxn === 'object' && noSelect) {
                    for (string in fxn) {
                      if (typeof string === 'string') {
                        options += options === '' ? '<option value="">' + ($header.data('placeholder') || $header.attr('data-placeholder') || wo.filter_placeholder.select || '') + '</option>' : '';
                        val = string;
                        txt = string;
                        if (string.indexOf(wo.filter_selectSourceSeparator) >= 0) {
                          val = string.split(wo.filter_selectSourceSeparator);
                          txt = val[1];
                          val = val[0];
                        }
                        options += '<option ' + (txt === val ? '' : 'data-function-name="' + string + '" ') + 'value="' + val + '">' + txt + '</option>';
                      }
                    }
                    c.$table.find('thead').find('select.' + tscss.filter + '[data-column="' + column + '"]').append(options);
                    txt = wo.filter_selectSource;
                    fxn = typeof txt === 'function' ? true : ts.getColumnData(table, txt, column);
                    if (fxn) {
                      tsf.buildSelect(c.table, column, '', true, $header.hasClass(wo.filter_onlyAvail));
                    }
                  }
                }
              }
            }
            tsf.buildDefault(table, true);
            tsf.bindSearch(table, c.$table.find('.' + tscss.filter), true);
            if (wo.filter_external) {
              tsf.bindSearch(table, wo.filter_external);
            }
            if (wo.filter_hideFilters) {
              tsf.hideFilters(c);
            }
            if (c.showProcessing) {
              txt = 'filterStart filterEnd '.split(' ').join(c.namespace + 'filter ');
              c.$table.unbind(txt.replace(ts.regex.spaces, ' ')).bind(txt, function(event, columns) {
                $header = (columns) ? c.$table.find('.' + tscss.header).filter('[data-column]').filter(function() {
                  return columns[$(this).data('column')] !== '';
                }) : '';
                ts.isProcessing(table, event.type === 'filterStart', columns ? $header : '');
              });
            }
            c.filteredRows = c.totalRows;
            txt = 'tablesorter-initialized pagerBeforeInitialized '.split(' ').join(c.namespace + 'filter ');
            c.$table.unbind(txt.replace(ts.regex.spaces, ' ')).bind(txt, function() {
              var wo = this.config.widgetOptions;
              filters = tsf.setDefaults(table, c, wo) || [];
              if (filters.length) {
                if (!(c.delayInit && filters.join('') === '')) {
                  ts.setFilters(table, filters, true);
                }
              }
              c.$table.triggerHandler('filterFomatterUpdate');
              setTimeout(function() {
                if (!wo.filter_initialized) {
                  tsf.filterInitComplete(c);
                }
              }, 100);
            });
            if (c.pager && c.pager.initialized && !wo.filter_initialized) {
              c.$table.triggerHandler('filterFomatterUpdate');
              setTimeout(function() {
                tsf.filterInitComplete(c);
              }, 100);
            }
          },
          formatterUpdated: function($cell, column) {
            var wo = $cell && $cell.closest('table')[0].config.widgetOptions;
            if (wo && !wo.filter_initialized) {
              wo.filter_formatterInit[column] = 1;
            }
          },
          filterInitComplete: function(c) {
            var indx,
                len,
                wo = c.widgetOptions,
                count = 0,
                completed = function() {
                  wo.filter_initialized = true;
                  c.$table.triggerHandler('filterInit', c);
                  tsf.findRows(c.table, c.$table.data('lastSearch') || []);
                };
            if ($.isEmptyObject(wo.filter_formatter)) {
              completed();
            } else {
              len = wo.filter_formatterInit.length;
              for (indx = 0; indx < len; indx++) {
                if (wo.filter_formatterInit[indx] === 1) {
                  count++;
                }
              }
              clearTimeout(wo.filter_initTimer);
              if (!wo.filter_initialized && count === wo.filter_formatterCount) {
                completed();
              } else if (!wo.filter_initialized) {
                wo.filter_initTimer = setTimeout(function() {
                  completed();
                }, 500);
              }
            }
          },
          processFilters: function(filters, encode) {
            var indx,
                mode = encode ? encodeURIComponent : decodeURIComponent,
                len = filters.length;
            for (indx = 0; indx < len; indx++) {
              filters[indx] = mode(filters[indx]);
            }
            return filters;
          },
          setDefaults: function(table, c, wo) {
            var isArray,
                saved,
                indx,
                col,
                $filters,
                filters = ts.getFilters(table) || [];
            if (wo.filter_saveFilters && ts.storage) {
              saved = ts.storage(table, 'tablesorter-filters') || [];
              isArray = $.isArray(saved);
              if (!(isArray && saved.join('') === '' || !isArray)) {
                filters = tsf.processFilters(saved);
              }
            }
            if (filters.join('') === '') {
              $filters = c.$headers.add(wo.filter_$externalFilters).filter('[' + wo.filter_defaultAttrib + ']');
              for (indx = 0; indx <= c.columns; indx++) {
                col = indx === c.columns ? 'all' : indx;
                filters[indx] = $filters.filter('[data-column="' + col + '"]').attr(wo.filter_defaultAttrib) || filters[indx] || '';
              }
            }
            c.$table.data('lastSearch', filters);
            return filters;
          },
          parseFilter: function(c, filter, data, parsed) {
            return parsed || data.parsed[data.index] ? c.parsers[data.index].format(filter, c.table, [], data.index) : filter;
          },
          buildRow: function(table, c, wo) {
            var $filter,
                col,
                column,
                $header,
                makeSelect,
                disabled,
                name,
                ffxn,
                tmp,
                cellFilter = wo.filter_cellFilter,
                columns = c.columns,
                arry = $.isArray(cellFilter),
                buildFilter = '<tr role="row" class="' + tscss.filterRow + ' ' + c.cssIgnoreRow + '">';
            for (column = 0; column < columns; column++) {
              if (c.$headerIndexed[column].length) {
                tmp = c.$headerIndexed[column] && c.$headerIndexed[column][0].colSpan || 0;
                if (tmp > 1) {
                  buildFilter += '<td data-column="' + column + '-' + (column + tmp - 1) + '" colspan="' + tmp + '"';
                } else {
                  buildFilter += '<td data-column="' + column + '"';
                }
                if (arry) {
                  buildFilter += (cellFilter[column] ? ' class="' + cellFilter[column] + '"' : '');
                } else {
                  buildFilter += (cellFilter !== '' ? ' class="' + cellFilter + '"' : '');
                }
                buildFilter += '></td>';
              }
            }
            c.$filters = $(buildFilter += '</tr>').appendTo(c.$table.children('thead').eq(0)).children('td');
            for (column = 0; column < columns; column++) {
              disabled = false;
              $header = c.$headerIndexed[column];
              if ($header && $header.length) {
                $filter = tsf.getColumnElm(c, c.$filters, column);
                ffxn = ts.getColumnData(table, wo.filter_functions, column);
                makeSelect = (wo.filter_functions && ffxn && typeof ffxn !== 'function') || $header.hasClass('filter-select');
                col = ts.getColumnData(table, c.headers, column);
                disabled = ts.getData($header[0], col, 'filter') === 'false' || ts.getData($header[0], col, 'parser') === 'false';
                if (makeSelect) {
                  buildFilter = $('<select>').appendTo($filter);
                } else {
                  ffxn = ts.getColumnData(table, wo.filter_formatter, column);
                  if (ffxn) {
                    wo.filter_formatterCount++;
                    buildFilter = ffxn($filter, column);
                    if (buildFilter && buildFilter.length === 0) {
                      buildFilter = $filter.children('input');
                    }
                    if (buildFilter && (buildFilter.parent().length === 0 || (buildFilter.parent().length && buildFilter.parent()[0] !== $filter[0]))) {
                      $filter.append(buildFilter);
                    }
                  } else {
                    buildFilter = $('<input type="search">').appendTo($filter);
                  }
                  if (buildFilter) {
                    tmp = $header.data('placeholder') || $header.attr('data-placeholder') || wo.filter_placeholder.search || '';
                    buildFilter.attr('placeholder', tmp);
                  }
                }
                if (buildFilter) {
                  name = ($.isArray(wo.filter_cssFilter) ? (typeof wo.filter_cssFilter[column] !== 'undefined' ? wo.filter_cssFilter[column] || '' : '') : wo.filter_cssFilter) || '';
                  buildFilter.addClass(tscss.filter + ' ' + name).attr('data-column', $filter.attr('data-column'));
                  if (disabled) {
                    buildFilter.attr('placeholder', '').addClass(tscss.filterDisabled)[0].disabled = true;
                  }
                }
              }
            }
          },
          bindSearch: function(table, $el, internal) {
            table = $(table)[0];
            $el = $($el);
            if (!$el.length) {
              return;
            }
            var tmp,
                c = table.config,
                wo = c.widgetOptions,
                namespace = c.namespace + 'filter',
                $ext = wo.filter_$externalFilters;
            if (internal !== true) {
              tmp = wo.filter_anyColumnSelector + ',' + wo.filter_multipleColumnSelector;
              wo.filter_$anyMatch = $el.filter(tmp);
              if ($ext && $ext.length) {
                wo.filter_$externalFilters = wo.filter_$externalFilters.add($el);
              } else {
                wo.filter_$externalFilters = $el;
              }
              ts.setFilters(table, c.$table.data('lastSearch') || [], internal === false);
            }
            tmp = ('keypress keyup search change '.split(' ').join(namespace + ' '));
            $el.attr('data-lastSearchTime', new Date().getTime()).unbind(tmp.replace(ts.regex.spaces, ' ')).bind('keyup' + namespace, function(event) {
              $(this).attr('data-lastSearchTime', new Date().getTime());
              if (event.which === 27) {
                this.value = '';
              } else if (wo.filter_liveSearch === false) {
                return;
              } else if (this.value !== '' && ((typeof wo.filter_liveSearch === 'number' && this.value.length < wo.filter_liveSearch) || (event.which !== 13 && event.which !== 8 && (event.which < 32 || (event.which >= 37 && event.which <= 40))))) {
                return;
              }
              tsf.searching(table, true, true);
            }).bind('search change keypress '.split(' ').join(namespace + ' '), function(event) {
              var column = parseInt($(this).attr('data-column'), 10);
              if (wo.filter_initialized && (event.which === 13 || event.type === 'search' || event.type === 'change' && this.value !== c.lastSearch[column])) {
                event.preventDefault();
                $(this).attr('data-lastSearchTime', new Date().getTime());
                tsf.searching(table, false, true);
              }
            });
          },
          searching: function(table, filter, skipFirst) {
            var wo = table.config.widgetOptions;
            clearTimeout(wo.filter_searchTimer);
            if (typeof filter === 'undefined' || filter === true) {
              wo.filter_searchTimer = setTimeout(function() {
                tsf.checkFilters(table, filter, skipFirst);
              }, wo.filter_liveSearch ? wo.filter_searchDelay : 10);
            } else {
              tsf.checkFilters(table, filter, skipFirst);
            }
          },
          checkFilters: function(table, filter, skipFirst) {
            var c = table.config,
                wo = c.widgetOptions,
                filterArray = $.isArray(filter),
                filters = (filterArray) ? filter : ts.getFilters(table, true),
                combinedFilters = (filters || []).join('');
            if ($.isEmptyObject(c.cache)) {
              if (c.delayInit && c.pager && c.pager.initialized) {
                ts.updateCache(c, function() {
                  tsf.checkFilters(table, false, skipFirst);
                });
              }
              return;
            }
            if (filterArray) {
              ts.setFilters(table, filters, false, skipFirst !== true);
              if (!wo.filter_initialized) {
                c.lastCombinedFilter = '';
              }
            }
            if (wo.filter_hideFilters) {
              c.$table.find('.' + tscss.filterRow).triggerHandler(combinedFilters === '' ? 'mouseleave' : 'mouseenter');
            }
            if (c.lastCombinedFilter === combinedFilters && filter !== false) {
              return;
            } else if (filter === false) {
              c.lastCombinedFilter = null;
              c.lastSearch = [];
            }
            filters = filters || [];
            filters = Array.prototype.map ? filters.map(String) : filters.join('\u0000').split('\u0000');
            if (wo.filter_initialized) {
              c.$table.triggerHandler('filterStart', [filters]);
            }
            if (c.showProcessing) {
              setTimeout(function() {
                tsf.findRows(table, filters, combinedFilters);
                return false;
              }, 30);
            } else {
              tsf.findRows(table, filters, combinedFilters);
              return false;
            }
          },
          hideFilters: function(c, $table) {
            var timer,
                $row = ($table || c.$table).find('.' + tscss.filterRow).addClass(tscss.filterRowHide);
            $row.bind('mouseenter mouseleave', function(e) {
              var event = e,
                  $filterRow = $(this);
              clearTimeout(timer);
              timer = setTimeout(function() {
                if (/enter|over/.test(event.type)) {
                  $filterRow.removeClass(tscss.filterRowHide);
                } else {
                  if ($(document.activeElement).closest('tr')[0] !== $filterRow[0]) {
                    if (c.lastCombinedFilter === '') {
                      $filterRow.addClass(tscss.filterRowHide);
                    }
                  }
                }
              }, 200);
            }).find('input, select').bind('focus blur', function(e) {
              var event = e,
                  $row = $(this).closest('tr');
              clearTimeout(timer);
              timer = setTimeout(function() {
                clearTimeout(timer);
                if (ts.getFilters(c.$table).join('') === '') {
                  $row.toggleClass(tscss.filterRowHide, event.type !== 'focus');
                }
              }, 200);
            });
          },
          defaultFilter: function(filter, mask) {
            if (filter === '') {
              return filter;
            }
            var regex = tsfRegex.iQuery,
                maskLen = mask.match(tsfRegex.igQuery).length,
                query = maskLen > 1 ? $.trim(filter).split(/\s/) : [$.trim(filter)],
                len = query.length - 1,
                indx = 0,
                val = mask;
            if (len < 1 && maskLen > 1) {
              query[1] = query[0];
            }
            while (regex.test(val)) {
              val = val.replace(regex, query[indx++] || '');
              if (regex.test(val) && indx < len && (query[indx] || '') !== '') {
                val = mask.replace(regex, val);
              }
            }
            return val;
          },
          getLatestSearch: function($input) {
            if ($input) {
              return $input.sort(function(a, b) {
                return $(b).attr('data-lastSearchTime') - $(a).attr('data-lastSearchTime');
              });
            }
            return $input || $();
          },
          findRange: function(c, val, ignoreRanges) {
            var temp,
                ranges,
                range,
                start,
                end,
                singles,
                i,
                indx,
                len,
                columns = [];
            if (/^[0-9]+$/.test(val)) {
              return [parseInt(val, 10)];
            }
            if (!ignoreRanges && /-/.test(val)) {
              ranges = val.match(/(\d+)\s*-\s*(\d+)/g);
              len = ranges ? ranges.length : 0;
              for (indx = 0; indx < len; indx++) {
                range = ranges[indx].split(/\s*-\s*/);
                start = parseInt(range[0], 10) || 0;
                end = parseInt(range[1], 10) || (c.columns - 1);
                if (start > end) {
                  temp = start;
                  start = end;
                  end = temp;
                }
                if (end >= c.columns) {
                  end = c.columns - 1;
                }
                for (; start <= end; start++) {
                  columns.push(start);
                }
                val = val.replace(ranges[indx], '');
              }
            }
            if (!ignoreRanges && /,/.test(val)) {
              singles = val.split(/\s*,\s*/);
              len = singles.length;
              for (i = 0; i < len; i++) {
                if (singles[i] !== '') {
                  indx = parseInt(singles[i], 10);
                  if (indx < c.columns) {
                    columns.push(indx);
                  }
                }
              }
            }
            if (!columns.length) {
              for (indx = 0; indx < c.columns; indx++) {
                columns.push(indx);
              }
            }
            return columns;
          },
          getColumnElm: function(c, $elements, column) {
            return $elements.filter(function() {
              var cols = tsf.findRange(c, $(this).attr('data-column'));
              return $.inArray(column, cols) > -1;
            });
          },
          multipleColumns: function(c, $input) {
            var wo = c.widgetOptions,
                targets = wo.filter_initialized || !$input.filter(wo.filter_anyColumnSelector).length,
                val = $.trim(tsf.getLatestSearch($input).attr('data-column') || '');
            return tsf.findRange(c, val, !targets);
          },
          processTypes: function(c, data, vars) {
            var ffxn,
                filterMatched = null,
                matches = null;
            for (ffxn in tsf.types) {
              if ($.inArray(ffxn, vars.excludeMatch) < 0 && matches === null) {
                matches = tsf.types[ffxn](c, data, vars);
                if (matches !== null) {
                  filterMatched = matches;
                }
              }
            }
            return filterMatched;
          },
          processRow: function(c, data, vars) {
            var result,
                filterMatched,
                fxn,
                ffxn,
                txt,
                wo = c.widgetOptions,
                showRow = true,
                columnIndex = wo.filter_$anyMatch && wo.filter_$anyMatch.length ? tsf.multipleColumns(c, wo.filter_$anyMatch) : [];
            data.$cells = data.$row.children();
            if (data.anyMatchFlag && columnIndex.length > 1) {
              data.anyMatch = true;
              data.isMatch = true;
              data.rowArray = data.$cells.map(function(i) {
                if ($.inArray(i, columnIndex) > -1) {
                  if (data.parsed[i]) {
                    txt = data.cacheArray[i];
                  } else {
                    txt = data.rawArray[i];
                    txt = $.trim(wo.filter_ignoreCase ? txt.toLowerCase() : txt);
                    if (c.sortLocaleCompare) {
                      txt = ts.replaceAccents(txt);
                    }
                  }
                  return txt;
                }
              }).get();
              data.filter = data.anyMatchFilter;
              data.iFilter = data.iAnyMatchFilter;
              data.exact = data.rowArray.join(' ');
              data.iExact = wo.filter_ignoreCase ? data.exact.toLowerCase() : data.exact;
              data.cache = data.cacheArray.slice(0, -1).join(' ');
              vars.excludeMatch = vars.noAnyMatch;
              filterMatched = tsf.processTypes(c, data, vars);
              if (filterMatched !== null) {
                showRow = filterMatched;
              } else {
                if (wo.filter_startsWith) {
                  showRow = false;
                  columnIndex = Math.min(c.columns, data.rowArray.length);
                  while (!showRow && columnIndex > 0) {
                    columnIndex--;
                    showRow = showRow || data.rowArray[columnIndex].indexOf(data.iFilter) === 0;
                  }
                } else {
                  showRow = (data.iExact + data.childRowText).indexOf(data.iFilter) >= 0;
                }
              }
              data.anyMatch = false;
              if (data.filters.join('') === data.filter) {
                return showRow;
              }
            }
            for (columnIndex = 0; columnIndex < c.columns; columnIndex++) {
              data.filter = data.filters[columnIndex];
              data.index = columnIndex;
              vars.excludeMatch = vars.excludeFilter[columnIndex];
              if (data.filter) {
                data.cache = data.cacheArray[columnIndex];
                if (wo.filter_useParsedData || data.parsed[columnIndex]) {
                  data.exact = data.cache;
                } else {
                  result = data.rawArray[columnIndex] || '';
                  data.exact = c.sortLocaleCompare ? ts.replaceAccents(result) : result;
                }
                data.iExact = !tsfRegex.type.test(typeof data.exact) && wo.filter_ignoreCase ? data.exact.toLowerCase() : data.exact;
                data.isMatch = c.$headerIndexed[data.index].hasClass('filter-match');
                result = showRow;
                ffxn = wo.filter_columnFilters ? c.$filters.add(c.$externalFilters).filter('[data-column="' + columnIndex + '"]').find('select option:selected').attr('data-function-name') || '' : '';
                if (c.sortLocaleCompare) {
                  data.filter = ts.replaceAccents(data.filter);
                }
                if (wo.filter_defaultFilter && tsfRegex.iQuery.test(vars.defaultColFilter[columnIndex])) {
                  data.filter = tsf.defaultFilter(data.filter, vars.defaultColFilter[columnIndex]);
                }
                data.iFilter = wo.filter_ignoreCase ? (data.filter || '').toLowerCase() : data.filter;
                fxn = vars.functions[columnIndex];
                filterMatched = null;
                if (fxn) {
                  if (fxn === true) {
                    filterMatched = data.isMatch ? ('' + data.iExact).search(data.iFilter) >= 0 : data.filter === data.exact;
                  } else if (typeof fxn === 'function') {
                    filterMatched = fxn(data.exact, data.cache, data.filter, columnIndex, data.$row, c, data);
                  } else if (typeof fxn[ffxn || data.filter] === 'function') {
                    txt = ffxn || data.filter;
                    filterMatched = fxn[txt](data.exact, data.cache, data.filter, columnIndex, data.$row, c, data);
                  }
                }
                if (filterMatched === null) {
                  filterMatched = tsf.processTypes(c, data, vars);
                  if (filterMatched !== null) {
                    result = filterMatched;
                  } else {
                    txt = (data.iExact + data.childRowText).indexOf(tsf.parseFilter(c, data.iFilter, data));
                    result = ((!wo.filter_startsWith && txt >= 0) || (wo.filter_startsWith && txt === 0));
                  }
                } else {
                  result = filterMatched;
                }
                showRow = (result) ? showRow : false;
              }
            }
            return showRow;
          },
          findRows: function(table, filters, combinedFilters) {
            if (table.config.lastCombinedFilter === combinedFilters || !table.config.widgetOptions.filter_initialized) {
              return;
            }
            var len,
                norm_rows,
                rowData,
                $rows,
                $row,
                rowIndex,
                tbodyIndex,
                $tbody,
                columnIndex,
                isChild,
                childRow,
                lastSearch,
                showRow,
                showParent,
                time,
                val,
                indx,
                notFiltered,
                searchFiltered,
                query,
                injected,
                res,
                id,
                txt,
                storedFilters = $.extend([], filters),
                c = table.config,
                wo = c.widgetOptions,
                data = {
                  anyMatch: false,
                  filters: filters,
                  filter_regexCache: []
                },
                vars = {
                  noAnyMatch: ['range', 'notMatch', 'operators'],
                  functions: [],
                  excludeFilter: [],
                  defaultColFilter: [],
                  defaultAnyFilter: ts.getColumnData(table, wo.filter_defaultFilter, c.columns, true) || ''
                };
            data.parsed = c.$headers.map(function(columnIndex) {
              return c.parsers && c.parsers[columnIndex] && c.parsers[columnIndex].parsed || ts.getData && ts.getData(c.$headerIndexed[columnIndex], ts.getColumnData(table, c.headers, columnIndex), 'filter') === 'parsed' || $(this).hasClass('filter-parsed');
            }).get();
            for (columnIndex = 0; columnIndex < c.columns; columnIndex++) {
              vars.functions[columnIndex] = ts.getColumnData(table, wo.filter_functions, columnIndex);
              vars.defaultColFilter[columnIndex] = ts.getColumnData(table, wo.filter_defaultFilter, columnIndex) || '';
              vars.excludeFilter[columnIndex] = (ts.getColumnData(table, wo.filter_excludeFilter, columnIndex, true) || '').split(/\s+/);
            }
            if (c.debug) {
              console.log('Filter: Starting filter widget search', filters);
              time = new Date();
            }
            c.filteredRows = 0;
            c.totalRows = 0;
            combinedFilters = (storedFilters || []).join('');
            for (tbodyIndex = 0; tbodyIndex < c.$tbodies.length; tbodyIndex++) {
              $tbody = ts.processTbody(table, c.$tbodies.eq(tbodyIndex), true);
              columnIndex = c.columns;
              norm_rows = c.cache[tbodyIndex].normalized;
              $rows = $($.map(norm_rows, function(el) {
                return el[columnIndex].$row.get();
              }));
              if (combinedFilters === '' || wo.filter_serversideFiltering) {
                $rows.removeClass(wo.filter_filteredRow).not('.' + c.cssChildRow).css('display', '');
              } else {
                $rows = $rows.not('.' + c.cssChildRow);
                len = $rows.length;
                if ((wo.filter_$anyMatch && wo.filter_$anyMatch.length) || typeof filters[c.columns] !== 'undefined') {
                  data.anyMatchFlag = true;
                  data.anyMatchFilter = '' + (filters[c.columns] || wo.filter_$anyMatch && tsf.getLatestSearch(wo.filter_$anyMatch).val() || '');
                  if (wo.filter_columnAnyMatch) {
                    query = data.anyMatchFilter.split(tsfRegex.andSplit);
                    injected = false;
                    for (indx = 0; indx < query.length; indx++) {
                      res = query[indx].split(':');
                      if (res.length > 1) {
                        id = parseInt(res[0], 10) - 1;
                        if (id >= 0 && id < c.columns) {
                          filters[id] = res[1];
                          query.splice(indx, 1);
                          indx--;
                          injected = true;
                        }
                      }
                    }
                    if (injected) {
                      data.anyMatchFilter = query.join(' && ');
                    }
                  }
                }
                searchFiltered = wo.filter_searchFiltered;
                lastSearch = c.lastSearch || c.$table.data('lastSearch') || [];
                if (searchFiltered) {
                  for (indx = 0; indx < columnIndex + 1; indx++) {
                    val = filters[indx] || '';
                    if (!searchFiltered) {
                      indx = columnIndex;
                    }
                    searchFiltered = searchFiltered && lastSearch.length && val.indexOf(lastSearch[indx] || '') === 0 && !tsfRegex.alreadyFiltered.test(val) && !tsfRegex.exactTest.test(val) && !(tsfRegex.isNeg1.test(val) || tsfRegex.isNeg2.test(val)) && !(val !== '' && c.$filters && c.$filters.filter('[data-column="' + indx + '"]').find('select').length && !c.$headerIndexed[indx].hasClass('filter-match'));
                  }
                }
                notFiltered = $rows.not('.' + wo.filter_filteredRow).length;
                if (searchFiltered && notFiltered === 0) {
                  searchFiltered = false;
                }
                if (c.debug) {
                  console.log('Filter: Searching through ' + (searchFiltered && notFiltered < len ? notFiltered : 'all') + ' rows');
                }
                if (data.anyMatchFlag) {
                  if (c.sortLocaleCompare) {
                    data.anyMatchFilter = ts.replaceAccents(data.anyMatchFilter);
                  }
                  if (wo.filter_defaultFilter && tsfRegex.iQuery.test(vars.defaultAnyFilter)) {
                    data.anyMatchFilter = tsf.defaultFilter(data.anyMatchFilter, vars.defaultAnyFilter);
                    searchFiltered = false;
                  }
                  data.iAnyMatchFilter = !(wo.filter_ignoreCase && c.ignoreCase) ? data.anyMatchFilter : data.anyMatchFilter.toLowerCase();
                }
                for (rowIndex = 0; rowIndex < len; rowIndex++) {
                  txt = $rows[rowIndex].className;
                  isChild = rowIndex && tsfRegex.child.test(txt);
                  if (isChild || (searchFiltered && tsfRegex.filtered.test(txt))) {
                    continue;
                  }
                  data.$row = $rows.eq(rowIndex);
                  data.cacheArray = norm_rows[rowIndex];
                  rowData = data.cacheArray[c.columns];
                  data.rawArray = rowData.raw;
                  data.childRowText = '';
                  if (!wo.filter_childByColumn) {
                    txt = '';
                    childRow = rowData.child;
                    for (indx = 0; indx < childRow.length; indx++) {
                      txt += ' ' + childRow[indx].join(' ') || '';
                    }
                    data.childRowText = wo.filter_childRows ? (wo.filter_ignoreCase ? txt.toLowerCase() : txt) : '';
                  }
                  showRow = false;
                  showParent = tsf.processRow(c, data, vars);
                  $row = rowData.$row;
                  val = showParent ? true : false;
                  childRow = rowData.$row.filter(':gt( 0 )');
                  if (wo.filter_childRows && childRow.length) {
                    if (wo.filter_childByColumn) {
                      if (!wo.filter_childWithSibs) {
                        childRow.addClass(wo.filter_filteredRow);
                        $row = $row.eq(0);
                      }
                      for (indx = 0; indx < childRow.length; indx++) {
                        data.$row = childRow.eq(indx);
                        data.cacheArray = rowData.child[indx];
                        data.rawArray = data.cacheArray;
                        val = tsf.processRow(c, data, vars);
                        showRow = showRow || val;
                        if (!wo.filter_childWithSibs && val) {
                          childRow.eq(indx).removeClass(wo.filter_filteredRow);
                        }
                      }
                    }
                    showRow = showRow || showParent;
                  } else {
                    showRow = val;
                  }
                  $row.toggleClass(wo.filter_filteredRow, !showRow)[0].display = showRow ? '' : 'none';
                }
              }
              c.filteredRows += $rows.not('.' + wo.filter_filteredRow).length;
              c.totalRows += $rows.length;
              ts.processTbody(table, $tbody, false);
            }
            c.lastCombinedFilter = combinedFilters;
            c.lastSearch = storedFilters;
            c.$table.data('lastSearch', storedFilters);
            if (wo.filter_saveFilters && ts.storage) {
              ts.storage(table, 'tablesorter-filters', tsf.processFilters(storedFilters, true));
            }
            if (c.debug) {
              console.log('Completed filter widget search' + ts.benchmark(time));
            }
            if (wo.filter_initialized) {
              c.$table.triggerHandler('filterBeforeEnd', c);
              c.$table.triggerHandler('filterEnd', c);
            }
            setTimeout(function() {
              ts.applyWidget(c.table);
            }, 0);
          },
          getOptionSource: function(table, column, onlyAvail) {
            table = $(table)[0];
            var c = table.config,
                wo = c.widgetOptions,
                arry = false,
                source = wo.filter_selectSource,
                last = c.$table.data('lastSearch') || [],
                fxn = typeof source === 'function' ? true : ts.getColumnData(table, source, column);
            if (onlyAvail && last[column] !== '') {
              onlyAvail = false;
            }
            if (fxn === true) {
              arry = source(table, column, onlyAvail);
            } else if (fxn instanceof $ || ($.type(fxn) === 'string' && fxn.indexOf('</option>') >= 0)) {
              return fxn;
            } else if ($.isArray(fxn)) {
              arry = fxn;
            } else if ($.type(source) === 'object' && fxn) {
              arry = fxn(table, column, onlyAvail);
            }
            if (arry === false) {
              arry = tsf.getOptions(table, column, onlyAvail);
            }
            return tsf.processOptions(table, column, arry);
          },
          processOptions: function(table, column, arry) {
            if (!$.isArray(arry)) {
              return false;
            }
            table = $(table)[0];
            var cts,
                txt,
                indx,
                len,
                parsedTxt,
                str,
                c = table.config,
                validColumn = typeof column !== 'undefined' && column !== null && column >= 0 && column < c.columns,
                parsed = [];
            arry = $.grep(arry, function(value, indx) {
              if (value.text) {
                return true;
              }
              return $.inArray(value, arry) === indx;
            });
            if (validColumn && c.$headerIndexed[column].hasClass('filter-select-nosort')) {
              return arry;
            } else {
              len = arry.length;
              for (indx = 0; indx < len; indx++) {
                txt = arry[indx];
                str = txt.text ? txt.text : txt;
                parsedTxt = (validColumn && c.parsers && c.parsers.length && c.parsers[column].format(str, table, [], column) || str).toString();
                parsedTxt = c.widgetOptions.filter_ignoreCase ? parsedTxt.toLowerCase() : parsedTxt;
                if (txt.text) {
                  txt.parsed = parsedTxt;
                  parsed.push(txt);
                } else {
                  parsed.push({
                    text: txt,
                    parsed: parsedTxt
                  });
                }
              }
              cts = c.textSorter || '';
              parsed.sort(function(a, b) {
                var x = a.parsed,
                    y = b.parsed;
                if (validColumn && typeof cts === 'function') {
                  return cts(x, y, true, column, table);
                } else if (validColumn && typeof cts === 'object' && cts.hasOwnProperty(column)) {
                  return cts[column](x, y, true, column, table);
                } else if (ts.sortNatural) {
                  return ts.sortNatural(x, y);
                }
                return true;
              });
              arry = [];
              len = parsed.length;
              for (indx = 0; indx < len; indx++) {
                arry.push(parsed[indx]);
              }
              return arry;
            }
          },
          getOptions: function(table, column, onlyAvail) {
            table = $(table)[0];
            var rowIndex,
                tbodyIndex,
                len,
                row,
                cache,
                indx,
                child,
                childLen,
                c = table.config,
                wo = c.widgetOptions,
                arry = [];
            for (tbodyIndex = 0; tbodyIndex < c.$tbodies.length; tbodyIndex++) {
              cache = c.cache[tbodyIndex];
              len = c.cache[tbodyIndex].normalized.length;
              for (rowIndex = 0; rowIndex < len; rowIndex++) {
                row = cache.row ? cache.row[rowIndex] : cache.normalized[rowIndex][c.columns].$row[0];
                if (onlyAvail && row.className.match(wo.filter_filteredRow)) {
                  continue;
                }
                if (wo.filter_useParsedData || c.parsers[column].parsed || c.$headerIndexed[column].hasClass('filter-parsed')) {
                  arry.push('' + cache.normalized[rowIndex][column]);
                  if (wo.filter_childRows && wo.filter_childByColumn) {
                    childLen = cache.normalized[rowIndex][c.columns].$row.length - 1;
                    for (indx = 0; indx < childLen; indx++) {
                      arry.push('' + cache.normalized[rowIndex][c.columns].child[indx][column]);
                    }
                  }
                } else {
                  arry.push(cache.normalized[rowIndex][c.columns].raw[column]);
                  if (wo.filter_childRows && wo.filter_childByColumn) {
                    childLen = cache.normalized[rowIndex][c.columns].$row.length;
                    for (indx = 1; indx < childLen; indx++) {
                      child = cache.normalized[rowIndex][c.columns].$row.eq(indx).children().eq(column);
                      arry.push('' + ts.getElementText(c, child, column));
                    }
                  }
                }
              }
            }
            return arry;
          },
          buildSelect: function(table, column, arry, updating, onlyAvail) {
            table = $(table)[0];
            column = parseInt(column, 10);
            if (!table.config.cache || $.isEmptyObject(table.config.cache)) {
              return;
            }
            var indx,
                val,
                txt,
                t,
                $filters,
                $filter,
                option,
                c = table.config,
                wo = c.widgetOptions,
                node = c.$headerIndexed[column],
                options = '<option value="">' + (node.data('placeholder') || node.attr('data-placeholder') || wo.filter_placeholder.select || '') + '</option>',
                currentValue = c.$table.find('thead').find('select.' + tscss.filter + '[data-column="' + column + '"]').val();
            if (typeof arry === 'undefined' || arry === '') {
              arry = tsf.getOptionSource(table, column, onlyAvail);
            }
            if ($.isArray(arry)) {
              for (indx = 0; indx < arry.length; indx++) {
                option = arry[indx];
                if (option.text) {
                  option['data-function-name'] = typeof option.value === 'undefined' ? option.text : option.value;
                  options += '<option';
                  for (val in option) {
                    if (option.hasOwnProperty(val) && val !== 'text') {
                      options += ' ' + val + '="' + option[val] + '"';
                    }
                  }
                  if (!option.value) {
                    options += ' value="' + option.text + '"';
                  }
                  options += '>' + option.text + '</option>';
                } else if ('' + option !== '[object Object]') {
                  txt = option = ('' + option).replace(tsfRegex.quote, '&quot;');
                  val = txt;
                  if (txt.indexOf(wo.filter_selectSourceSeparator) >= 0) {
                    t = txt.split(wo.filter_selectSourceSeparator);
                    val = t[0];
                    txt = t[1];
                  }
                  options += option !== '' ? '<option ' + (val === txt ? '' : 'data-function-name="' + option + '" ') + 'value="' + val + '">' + txt + '</option>' : '';
                }
              }
              arry = [];
            }
            $filters = (c.$filters ? c.$filters : c.$table.children('thead')).find('.' + tscss.filter);
            if (wo.filter_$externalFilters) {
              $filters = $filters && $filters.length ? $filters.add(wo.filter_$externalFilters) : wo.filter_$externalFilters;
            }
            $filter = $filters.filter('select[data-column="' + column + '"]');
            if ($filter.length) {
              $filter[updating ? 'html' : 'append'](options);
              if (!$.isArray(arry)) {
                $filter.append(arry).val(currentValue);
              }
              $filter.val(currentValue);
            }
          },
          buildDefault: function(table, updating) {
            var columnIndex,
                $header,
                noSelect,
                c = table.config,
                wo = c.widgetOptions,
                columns = c.columns;
            for (columnIndex = 0; columnIndex < columns; columnIndex++) {
              $header = c.$headerIndexed[columnIndex];
              noSelect = !($header.hasClass('filter-false') || $header.hasClass('parser-false'));
              if (($header.hasClass('filter-select') || ts.getColumnData(table, wo.filter_functions, columnIndex) === true) && noSelect) {
                tsf.buildSelect(table, columnIndex, '', updating, $header.hasClass(wo.filter_onlyAvail));
              }
            }
          }
        };
        tsfRegex = tsf.regex;
        ts.getFilters = function(table, getRaw, setFilters, skipFirst) {
          var i,
              $filters,
              $column,
              cols,
              filters = false,
              c = table ? $(table)[0].config : '',
              wo = c ? c.widgetOptions : '';
          if ((getRaw !== true && wo && !wo.filter_columnFilters) || ($.isArray(setFilters) && setFilters.join('') === c.lastCombinedFilter)) {
            return $(table).data('lastSearch');
          }
          if (c) {
            if (c.$filters) {
              $filters = c.$filters.find('.' + tscss.filter);
            }
            if (wo.filter_$externalFilters) {
              $filters = $filters && $filters.length ? $filters.add(wo.filter_$externalFilters) : wo.filter_$externalFilters;
            }
            if ($filters && $filters.length) {
              filters = setFilters || [];
              for (i = 0; i < c.columns + 1; i++) {
                cols = (i === c.columns ? wo.filter_anyColumnSelector + ',' + wo.filter_multipleColumnSelector : '[data-column="' + i + '"]');
                $column = $filters.filter(cols);
                if ($column.length) {
                  $column = tsf.getLatestSearch($column);
                  if ($.isArray(setFilters)) {
                    if (skipFirst && $column.length > 1) {
                      $column = $column.slice(1);
                    }
                    if (i === c.columns) {
                      cols = $column.filter(wo.filter_anyColumnSelector);
                      $column = cols.length ? cols : $column;
                    }
                    $column.val(setFilters[i]).trigger('change' + c.namespace);
                  } else {
                    filters[i] = $column.val() || '';
                    if (i === c.columns) {
                      $column.slice(1).filter('[data-column*="' + $column.attr('data-column') + '"]').val(filters[i]);
                    } else {
                      $column.slice(1).val(filters[i]);
                    }
                  }
                  if (i === c.columns && $column.length) {
                    wo.filter_$anyMatch = $column;
                  }
                }
              }
            }
          }
          if (filters.length === 0) {
            filters = false;
          }
          return filters;
        };
        ts.setFilters = function(table, filter, apply, skipFirst) {
          var c = table ? $(table)[0].config : '',
              valid = ts.getFilters(table, true, filter, skipFirst);
          if (typeof apply === 'undefined') {
            apply = true;
          }
          if (c && apply) {
            c.lastCombinedFilter = null;
            c.lastSearch = [];
            tsf.searching(c.table, filter, skipFirst);
            c.$table.triggerHandler('filterFomatterUpdate');
          }
          return !!valid;
        };
      })(jQuery);
      ;
      (function($, window) {
        'use strict';
        var ts = $.tablesorter || {};
        $.extend(ts.css, {
          sticky: 'tablesorter-stickyHeader',
          stickyVis: 'tablesorter-sticky-visible',
          stickyHide: 'tablesorter-sticky-hidden',
          stickyWrap: 'tablesorter-sticky-wrapper'
        });
        ts.addHeaderResizeEvent = function(table, disable, settings) {
          table = $(table)[0];
          if (!table.config) {
            return;
          }
          var defaults = {timer: 250},
              options = $.extend({}, defaults, settings),
              c = table.config,
              wo = c.widgetOptions,
              checkSizes = function(triggerEvent) {
                var index,
                    headers,
                    $header,
                    sizes,
                    width,
                    height,
                    len = c.$headers.length;
                wo.resize_flag = true;
                headers = [];
                for (index = 0; index < len; index++) {
                  $header = c.$headers.eq(index);
                  sizes = $header.data('savedSizes') || [0, 0];
                  width = $header[0].offsetWidth;
                  height = $header[0].offsetHeight;
                  if (width !== sizes[0] || height !== sizes[1]) {
                    $header.data('savedSizes', [width, height]);
                    headers.push($header[0]);
                  }
                }
                if (headers.length && triggerEvent !== false) {
                  c.$table.triggerHandler('resize', [headers]);
                }
                wo.resize_flag = false;
              };
          checkSizes(false);
          clearInterval(wo.resize_timer);
          if (disable) {
            wo.resize_flag = false;
            return false;
          }
          wo.resize_timer = setInterval(function() {
            if (wo.resize_flag) {
              return;
            }
            checkSizes();
          }, options.timer);
        };
        ts.addWidget({
          id: 'stickyHeaders',
          priority: 60,
          options: {
            stickyHeaders: '',
            stickyHeaders_attachTo: null,
            stickyHeaders_xScroll: null,
            stickyHeaders_yScroll: null,
            stickyHeaders_offset: 0,
            stickyHeaders_filteredToTop: true,
            stickyHeaders_cloneId: '-sticky',
            stickyHeaders_addResizeEvent: true,
            stickyHeaders_includeCaption: true,
            stickyHeaders_zIndex: 2
          },
          format: function(table, c, wo) {
            if (c.$table.hasClass('hasStickyHeaders') || ($.inArray('filter', c.widgets) >= 0 && !c.$table.hasClass('hasFilters'))) {
              return;
            }
            var index,
                len,
                $t,
                $table = c.$table,
                $attach = $(wo.stickyHeaders_attachTo),
                namespace = c.namespace + 'stickyheaders ',
                $yScroll = $(wo.stickyHeaders_yScroll || wo.stickyHeaders_attachTo || window),
                $xScroll = $(wo.stickyHeaders_xScroll || wo.stickyHeaders_attachTo || window),
                $thead = $table.children('thead:first'),
                $header = $thead.children('tr').not('.sticky-false').children(),
                $tfoot = $table.children('tfoot'),
                $stickyOffset = isNaN(wo.stickyHeaders_offset) ? $(wo.stickyHeaders_offset) : '',
                stickyOffset = $stickyOffset.length ? $stickyOffset.height() || 0 : parseInt(wo.stickyHeaders_offset, 10) || 0,
                $nestedSticky = $table.parent().closest('.' + ts.css.table).hasClass('hasStickyHeaders') ? $table.parent().closest('table.tablesorter')[0].config.widgetOptions.$sticky.parent() : [],
                nestedStickyTop = $nestedSticky.length ? $nestedSticky.height() : 0,
                $stickyTable = wo.$sticky = $table.clone().addClass('containsStickyHeaders ' + ts.css.sticky + ' ' + wo.stickyHeaders + ' ' + c.namespace.slice(1) + '_extra_table').wrap('<div class="' + ts.css.stickyWrap + '">'),
                $stickyWrap = $stickyTable.parent().addClass(ts.css.stickyHide).css({
                  position: $attach.length ? 'absolute' : 'fixed',
                  padding: parseInt($stickyTable.parent().parent().css('padding-left'), 10),
                  top: stickyOffset + nestedStickyTop,
                  left: 0,
                  visibility: 'hidden',
                  zIndex: wo.stickyHeaders_zIndex || 2
                }),
                $stickyThead = $stickyTable.children('thead:first'),
                $stickyCells,
                laststate = '',
                spacing = 0,
                setWidth = function($orig, $clone) {
                  var index,
                      width,
                      border,
                      $cell,
                      $this,
                      $cells = $orig.filter(':visible'),
                      len = $cells.length;
                  for (index = 0; index < len; index++) {
                    $cell = $clone.filter(':visible').eq(index);
                    $this = $cells.eq(index);
                    if ($this.css('box-sizing') === 'border-box') {
                      width = $this.outerWidth();
                    } else {
                      if ($cell.css('border-collapse') === 'collapse') {
                        if (window.getComputedStyle) {
                          width = parseFloat(window.getComputedStyle($this[0], null).width);
                        } else {
                          border = parseFloat($this.css('border-width'));
                          width = $this.outerWidth() - parseFloat($this.css('padding-left')) - parseFloat($this.css('padding-right')) - border;
                        }
                      } else {
                        width = $this.width();
                      }
                    }
                    $cell.css({
                      'width': width,
                      'min-width': width,
                      'max-width': width
                    });
                  }
                },
                resizeHeader = function() {
                  stickyOffset = $stickyOffset.length ? $stickyOffset.height() || 0 : parseInt(wo.stickyHeaders_offset, 10) || 0;
                  spacing = 0;
                  $stickyWrap.css({
                    left: $attach.length ? parseInt($attach.css('padding-left'), 10) || 0 : $table.offset().left - parseInt($table.css('margin-left'), 10) - $xScroll.scrollLeft() - spacing,
                    width: $table.outerWidth()
                  });
                  setWidth($table, $stickyTable);
                  setWidth($header, $stickyCells);
                },
                scrollSticky = function(resizing) {
                  if (!$table.is(':visible')) {
                    return;
                  }
                  nestedStickyTop = $nestedSticky.length ? $nestedSticky.offset().top - $yScroll.scrollTop() + $nestedSticky.height() : 0;
                  var offset = $table.offset(),
                      yWindow = $.isWindow($yScroll[0]),
                      xWindow = $.isWindow($xScroll[0]),
                      scrollTop = ($attach.length ? (yWindow ? $yScroll.scrollTop() : $yScroll.offset().top) : $yScroll.scrollTop()) + stickyOffset + nestedStickyTop,
                      tableHeight = $table.height() - ($stickyWrap.height() + ($tfoot.height() || 0)),
                      isVisible = (scrollTop > offset.top) && (scrollTop < offset.top + tableHeight) ? 'visible' : 'hidden',
                      cssSettings = {visibility: isVisible};
                  if ($attach.length) {
                    cssSettings.top = yWindow ? scrollTop - $attach.offset().top : $attach.scrollTop();
                  }
                  if (xWindow) {
                    cssSettings.left = $table.offset().left - parseInt($table.css('margin-left'), 10) - $xScroll.scrollLeft() - spacing;
                  }
                  if ($nestedSticky.length) {
                    cssSettings.top = (cssSettings.top || 0) + stickyOffset + nestedStickyTop;
                  }
                  $stickyWrap.removeClass(ts.css.stickyVis + ' ' + ts.css.stickyHide).addClass(isVisible === 'visible' ? ts.css.stickyVis : ts.css.stickyHide).css(cssSettings);
                  if (isVisible !== laststate || resizing) {
                    resizeHeader();
                    laststate = isVisible;
                  }
                };
            if ($attach.length && !$attach.css('position')) {
              $attach.css('position', 'relative');
            }
            if ($stickyTable.attr('id')) {
              $stickyTable[0].id += wo.stickyHeaders_cloneId;
            }
            $stickyTable.find('thead:gt(0), tr.sticky-false').hide();
            $stickyTable.find('tbody, tfoot').remove();
            $stickyTable.find('caption').toggle(wo.stickyHeaders_includeCaption);
            $stickyCells = $stickyThead.children().children();
            $stickyTable.css({
              height: 0,
              width: 0,
              margin: 0
            });
            $stickyCells.find('.' + ts.css.resizer).remove();
            $table.addClass('hasStickyHeaders').bind('pagerComplete' + namespace, function() {
              resizeHeader();
            });
            ts.bindEvents(table, $stickyThead.children().children('.' + ts.css.header));
            $table.after($stickyWrap);
            if (c.onRenderHeader) {
              $t = $stickyThead.children('tr').children();
              len = $t.length;
              for (index = 0; index < len; index++) {
                c.onRenderHeader.apply($t.eq(index), [index, c, $stickyTable]);
              }
            }
            $xScroll.add($yScroll).unbind(('scroll resize '.split(' ').join(namespace)).replace(/\s+/g, ' ')).bind('scroll resize '.split(' ').join(namespace), function(event) {
              scrollSticky(event.type === 'resize');
            });
            c.$table.unbind('stickyHeadersUpdate' + namespace).bind('stickyHeadersUpdate' + namespace, function() {
              scrollSticky(true);
            });
            if (wo.stickyHeaders_addResizeEvent) {
              ts.addHeaderResizeEvent(table);
            }
            if ($table.hasClass('hasFilters') && wo.filter_columnFilters) {
              $table.bind('filterEnd' + namespace, function() {
                var $td = $(document.activeElement).closest('td'),
                    column = $td.parent().children().index($td);
                if ($stickyWrap.hasClass(ts.css.stickyVis) && wo.stickyHeaders_filteredToTop) {
                  window.scrollTo(0, $table.position().top);
                  if (column >= 0 && c.$filters) {
                    c.$filters.eq(column).find('a, select, input').filter(':visible').focus();
                  }
                }
              });
              ts.filter.bindSearch($table, $stickyCells.find('.' + ts.css.filter));
              if (wo.filter_hideFilters) {
                ts.filter.hideFilters(c, $stickyTable);
              }
            }
            $table.triggerHandler('stickyHeadersInit');
          },
          remove: function(table, c, wo) {
            var namespace = c.namespace + 'stickyheaders ';
            c.$table.removeClass('hasStickyHeaders').unbind(('pagerComplete filterEnd stickyHeadersUpdate '.split(' ').join(namespace)).replace(/\s+/g, ' ')).next('.' + ts.css.stickyWrap).remove();
            if (wo.$sticky && wo.$sticky.length) {
              wo.$sticky.remove();
            }
            $(window).add(wo.stickyHeaders_xScroll).add(wo.stickyHeaders_yScroll).add(wo.stickyHeaders_attachTo).unbind(('scroll resize '.split(' ').join(namespace)).replace(/\s+/g, ' '));
            ts.addHeaderResizeEvent(table, false);
          }
        });
      })(jQuery, window);
      ;
      (function($, window) {
        'use strict';
        var ts = $.tablesorter || {};
        $.extend(ts.css, {
          resizableContainer: 'tablesorter-resizable-container',
          resizableHandle: 'tablesorter-resizable-handle',
          resizableNoSelect: 'tablesorter-disableSelection',
          resizableStorage: 'tablesorter-resizable'
        });
        $(function() {
          var s = '<style>' + 'body.' + ts.css.resizableNoSelect + ' { -ms-user-select: none; -moz-user-select: -moz-none;' + '-khtml-user-select: none; -webkit-user-select: none; user-select: none; }' + '.' + ts.css.resizableContainer + ' { position: relative; height: 1px; }' + '.' + ts.css.resizableHandle + ' { position: absolute; display: inline-block; width: 8px;' + 'top: 1px; cursor: ew-resize; z-index: 3; user-select: none; -moz-user-select: none; }' + '</style>';
          $(s).appendTo('body');
        });
        ts.resizable = {
          init: function(c, wo) {
            if (c.$table.hasClass('hasResizable')) {
              return;
            }
            c.$table.addClass('hasResizable');
            var noResize,
                $header,
                column,
                storedSizes,
                tmp,
                $table = c.$table,
                $parent = $table.parent(),
                marginTop = parseInt($table.css('margin-top'), 10),
                vars = wo.resizable_vars = {
                  useStorage: ts.storage && wo.resizable !== false,
                  $wrap: $parent,
                  mouseXPosition: 0,
                  $target: null,
                  $next: null,
                  overflow: $parent.css('overflow') === 'auto' || $parent.css('overflow') === 'scroll' || $parent.css('overflow-x') === 'auto' || $parent.css('overflow-x') === 'scroll',
                  storedSizes: []
                };
            ts.resizableReset(c.table, true);
            vars.tableWidth = $table.width();
            vars.fullWidth = Math.abs($parent.width() - vars.tableWidth) < 20;
            if (vars.useStorage && vars.overflow) {
              ts.storage(c.table, 'tablesorter-table-original-css-width', vars.tableWidth);
              tmp = ts.storage(c.table, 'tablesorter-table-resized-width') || 'auto';
              ts.resizable.setWidth($table, tmp, true);
            }
            wo.resizable_vars.storedSizes = storedSizes = (vars.useStorage ? ts.storage(c.table, ts.css.resizableStorage) : []) || [];
            ts.resizable.setWidths(c, wo, storedSizes);
            ts.resizable.updateStoredSizes(c, wo);
            wo.$resizable_container = $('<div class="' + ts.css.resizableContainer + '">').css({top: marginTop}).insertBefore($table);
            for (column = 0; column < c.columns; column++) {
              $header = c.$headerIndexed[column];
              tmp = ts.getColumnData(c.table, c.headers, column);
              noResize = ts.getData($header, tmp, 'resizable') === 'false';
              if (!noResize) {
                $('<div class="' + ts.css.resizableHandle + '">').appendTo(wo.$resizable_container).attr({
                  'data-column': column,
                  'unselectable': 'on'
                }).data('header', $header).bind('selectstart', false);
              }
            }
            ts.resizable.setHandlePosition(c, wo);
            ts.resizable.bindings(c, wo);
          },
          updateStoredSizes: function(c, wo) {
            var column,
                $header,
                len = c.columns,
                vars = wo.resizable_vars;
            vars.storedSizes = [];
            for (column = 0; column < len; column++) {
              $header = c.$headerIndexed[column];
              vars.storedSizes[column] = $header.is(':visible') ? $header.width() : 0;
            }
          },
          setWidth: function($el, width, overflow) {
            $el.css({
              'width': width,
              'min-width': overflow ? width : '',
              'max-width': overflow ? width : ''
            });
          },
          setWidths: function(c, wo, storedSizes) {
            var column,
                $temp,
                vars = wo.resizable_vars,
                $extra = $(c.namespace + '_extra_headers'),
                $col = c.$table.children('colgroup').children('col');
            storedSizes = storedSizes || vars.storedSizes || [];
            if (storedSizes.length) {
              for (column = 0; column < c.columns; column++) {
                ts.resizable.setWidth(c.$headerIndexed[column], storedSizes[column], vars.overflow);
                if ($extra.length) {
                  $temp = $extra.eq(column).add($col.eq(column));
                  ts.resizable.setWidth($temp, storedSizes[column], vars.overflow);
                }
              }
              $temp = $(c.namespace + '_extra_table');
              if ($temp.length && !ts.hasWidget(c.table, 'scroller')) {
                ts.resizable.setWidth($temp, c.$table.outerWidth(), vars.overflow);
              }
            }
          },
          setHandlePosition: function(c, wo) {
            var startPosition,
                hasScroller = ts.hasWidget(c.table, 'scroller'),
                tableHeight = c.$table.height(),
                $handles = wo.$resizable_container.children(),
                handleCenter = Math.floor($handles.width() / 2);
            if (hasScroller) {
              tableHeight = 0;
              c.$table.closest('.' + ts.css.scrollerWrap).children().each(function() {
                var $this = $(this);
                tableHeight += $this.filter('[style*="height"]').length ? $this.height() : $this.children('table').height();
              });
            }
            startPosition = c.$table.position().left;
            $handles.each(function() {
              var $this = $(this),
                  column = parseInt($this.attr('data-column'), 10),
                  columns = c.columns - 1,
                  $header = $this.data('header');
              if (!$header) {
                return;
              }
              if (!$header.is(':visible')) {
                $this.hide();
              } else if (column < columns || column === columns && wo.resizable_addLastColumn) {
                $this.css({
                  display: 'inline-block',
                  height: tableHeight,
                  left: $header.position().left - startPosition + $header.outerWidth() - handleCenter
                });
              }
            });
          },
          toggleTextSelection: function(c, wo, toggle) {
            var namespace = c.namespace + 'tsresize';
            wo.resizable_vars.disabled = toggle;
            $('body').toggleClass(ts.css.resizableNoSelect, toggle);
            if (toggle) {
              $('body').attr('unselectable', 'on').bind('selectstart' + namespace, false);
            } else {
              $('body').removeAttr('unselectable').unbind('selectstart' + namespace);
            }
          },
          bindings: function(c, wo) {
            var namespace = c.namespace + 'tsresize';
            wo.$resizable_container.children().bind('mousedown', function(event) {
              var column,
                  vars = wo.resizable_vars,
                  $extras = $(c.namespace + '_extra_headers'),
                  $header = $(event.target).data('header');
              column = parseInt($header.attr('data-column'), 10);
              vars.$target = $header = $header.add($extras.filter('[data-column="' + column + '"]'));
              vars.target = column;
              vars.$next = event.shiftKey || wo.resizable_targetLast ? $header.parent().children().not('.resizable-false').filter(':last') : $header.nextAll(':not(.resizable-false)').eq(0);
              column = parseInt(vars.$next.attr('data-column'), 10);
              vars.$next = vars.$next.add($extras.filter('[data-column="' + column + '"]'));
              vars.next = column;
              vars.mouseXPosition = event.pageX;
              ts.resizable.updateStoredSizes(c, wo);
              ts.resizable.toggleTextSelection(c, wo, true);
            });
            $(document).bind('mousemove' + namespace, function(event) {
              var vars = wo.resizable_vars;
              if (!vars.disabled || vars.mouseXPosition === 0 || !vars.$target) {
                return;
              }
              if (wo.resizable_throttle) {
                clearTimeout(vars.timer);
                vars.timer = setTimeout(function() {
                  ts.resizable.mouseMove(c, wo, event);
                }, isNaN(wo.resizable_throttle) ? 5 : wo.resizable_throttle);
              } else {
                ts.resizable.mouseMove(c, wo, event);
              }
            }).bind('mouseup' + namespace, function() {
              if (!wo.resizable_vars.disabled) {
                return;
              }
              ts.resizable.toggleTextSelection(c, wo, false);
              ts.resizable.stopResize(c, wo);
              ts.resizable.setHandlePosition(c, wo);
            });
            $(window).bind('resize' + namespace + ' resizeEnd' + namespace, function() {
              ts.resizable.setHandlePosition(c, wo);
            });
            c.$table.bind('columnUpdate' + namespace, function() {
              ts.resizable.setHandlePosition(c, wo);
            }).find('thead:first').add($(c.namespace + '_extra_table').find('thead:first')).bind('contextmenu' + namespace, function() {
              var allowClick = wo.resizable_vars.storedSizes.length === 0;
              ts.resizableReset(c.table);
              ts.resizable.setHandlePosition(c, wo);
              wo.resizable_vars.storedSizes = [];
              return allowClick;
            });
          },
          mouseMove: function(c, wo, event) {
            if (wo.resizable_vars.mouseXPosition === 0 || !wo.resizable_vars.$target) {
              return;
            }
            var column,
                total = 0,
                vars = wo.resizable_vars,
                $next = vars.$next,
                tar = vars.storedSizes[vars.target],
                leftEdge = event.pageX - vars.mouseXPosition;
            if (vars.overflow) {
              if (tar + leftEdge > 0) {
                vars.storedSizes[vars.target] += leftEdge;
                ts.resizable.setWidth(vars.$target, vars.storedSizes[vars.target], true);
                for (column = 0; column < c.columns; column++) {
                  total += vars.storedSizes[column];
                }
                ts.resizable.setWidth(c.$table.add($(c.namespace + '_extra_table')), total);
              }
              if (!$next.length) {
                vars.$wrap[0].scrollLeft = c.$table.width();
              }
            } else if (vars.fullWidth) {
              vars.storedSizes[vars.target] += leftEdge;
              vars.storedSizes[vars.next] -= leftEdge;
              ts.resizable.setWidths(c, wo);
            } else {
              vars.storedSizes[vars.target] += leftEdge;
              ts.resizable.setWidths(c, wo);
            }
            vars.mouseXPosition = event.pageX;
            c.$table.triggerHandler('stickyHeadersUpdate');
          },
          stopResize: function(c, wo) {
            var vars = wo.resizable_vars;
            ts.resizable.updateStoredSizes(c, wo);
            if (vars.useStorage) {
              ts.storage(c.table, ts.css.resizableStorage, vars.storedSizes);
              ts.storage(c.table, 'tablesorter-table-resized-width', c.$table.width());
            }
            vars.mouseXPosition = 0;
            vars.$target = vars.$next = null;
            c.$table.triggerHandler('stickyHeadersUpdate');
          }
        };
        ts.addWidget({
          id: 'resizable',
          priority: 40,
          options: {
            resizable: true,
            resizable_addLastColumn: false,
            resizable_widths: [],
            resizable_throttle: false,
            resizable_targetLast: false,
            resizable_fullWidth: null
          },
          init: function(table, thisWidget, c, wo) {
            ts.resizable.init(c, wo);
          },
          remove: function(table, c, wo, refreshing) {
            if (wo.$resizable_container) {
              var namespace = c.namespace + 'tsresize';
              c.$table.add($(c.namespace + '_extra_table')).removeClass('hasResizable').children('thead').unbind('contextmenu' + namespace);
              wo.$resizable_container.remove();
              ts.resizable.toggleTextSelection(c, wo, false);
              ts.resizableReset(table, refreshing);
              $(document).unbind('mousemove' + namespace + ' mouseup' + namespace);
            }
          }
        });
        ts.resizableReset = function(table, refreshing) {
          $(table).each(function() {
            var index,
                $t,
                c = this.config,
                wo = c && c.widgetOptions,
                vars = wo.resizable_vars;
            if (table && c && c.$headerIndexed.length) {
              if (vars.overflow && vars.tableWidth) {
                ts.resizable.setWidth(c.$table, vars.tableWidth, true);
                if (vars.useStorage) {
                  ts.storage(table, 'tablesorter-table-resized-width', 'auto');
                }
              }
              for (index = 0; index < c.columns; index++) {
                $t = c.$headerIndexed[index];
                if (wo.resizable_widths && wo.resizable_widths[index]) {
                  ts.resizable.setWidth($t, wo.resizable_widths[index], vars.overflow);
                } else if (!$t.hasClass('resizable-false')) {
                  ts.resizable.setWidth($t, '', vars.overflow);
                }
              }
              c.$table.triggerHandler('stickyHeadersUpdate');
              if (ts.storage && !refreshing) {
                ts.storage(this, ts.css.resizableStorage, {});
              }
            }
          });
        };
      })(jQuery, window);
      ;
      (function($) {
        'use strict';
        var ts = $.tablesorter || {};
        ts.addWidget({
          id: 'saveSort',
          priority: 20,
          options: {saveSort: true},
          init: function(table, thisWidget, c, wo) {
            thisWidget.format(table, c, wo, true);
          },
          format: function(table, c, wo, init) {
            var stored,
                time,
                $table = c.$table,
                saveSort = wo.saveSort !== false,
                sortList = {'sortList': c.sortList};
            if (c.debug) {
              time = new Date();
            }
            if ($table.hasClass('hasSaveSort')) {
              if (saveSort && table.hasInitialized && ts.storage) {
                ts.storage(table, 'tablesorter-savesort', sortList);
                if (c.debug) {
                  console.log('saveSort widget: Saving last sort: ' + c.sortList + ts.benchmark(time));
                }
              }
            } else {
              $table.addClass('hasSaveSort');
              sortList = '';
              if (ts.storage) {
                stored = ts.storage(table, 'tablesorter-savesort');
                sortList = (stored && stored.hasOwnProperty('sortList') && $.isArray(stored.sortList)) ? stored.sortList : '';
                if (c.debug) {
                  console.log('saveSort: Last sort loaded: "' + sortList + '"' + ts.benchmark(time));
                }
                $table.bind('saveSortReset', function(event) {
                  event.stopPropagation();
                  ts.storage(table, 'tablesorter-savesort', '');
                });
              }
              if (init && sortList && sortList.length > 0) {
                c.sortList = sortList;
              } else if (table.hasInitialized && sortList && sortList.length > 0) {
                ts.sortOn(c, sortList);
              }
            }
          },
          remove: function(table, c) {
            c.$table.removeClass('hasSaveSort');
            if (ts.storage) {
              ts.storage(table, 'tablesorter-savesort', '');
            }
          }
        });
      })(jQuery);
      return $.tablesorter;
    }));
  })($__require('5'));
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("9", ["8"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = $__require('8');
  global.define = __define;
  return module.exports;
});

(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
(function(global, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = global.document ? factory(global, true) : function(w) {
      if (!w.document) {
        throw new Error("jQuery requires a window with a document");
      }
      return factory(w);
    };
  } else {
    factory(global);
  }
}(typeof window !== "undefined" ? window : this, function(window, noGlobal) {
  var arr = [];
  var slice = arr.slice;
  var concat = arr.concat;
  var push = arr.push;
  var indexOf = arr.indexOf;
  var class2type = {};
  var toString = class2type.toString;
  var hasOwn = class2type.hasOwnProperty;
  var support = {};
  var document = window.document,
      version = "2.1.4",
      jQuery = function(selector, context) {
        return new jQuery.fn.init(selector, context);
      },
      rtrim = /^[\s\uFEFF\xA0]+|[\s\uFEFF\xA0]+$/g,
      rmsPrefix = /^-ms-/,
      rdashAlpha = /-([\da-z])/gi,
      fcamelCase = function(all, letter) {
        return letter.toUpperCase();
      };
  jQuery.fn = jQuery.prototype = {
    jquery: version,
    constructor: jQuery,
    selector: "",
    length: 0,
    toArray: function() {
      return slice.call(this);
    },
    get: function(num) {
      return num != null ? (num < 0 ? this[num + this.length] : this[num]) : slice.call(this);
    },
    pushStack: function(elems) {
      var ret = jQuery.merge(this.constructor(), elems);
      ret.prevObject = this;
      ret.context = this.context;
      return ret;
    },
    each: function(callback, args) {
      return jQuery.each(this, callback, args);
    },
    map: function(callback) {
      return this.pushStack(jQuery.map(this, function(elem, i) {
        return callback.call(elem, i, elem);
      }));
    },
    slice: function() {
      return this.pushStack(slice.apply(this, arguments));
    },
    first: function() {
      return this.eq(0);
    },
    last: function() {
      return this.eq(-1);
    },
    eq: function(i) {
      var len = this.length,
          j = +i + (i < 0 ? len : 0);
      return this.pushStack(j >= 0 && j < len ? [this[j]] : []);
    },
    end: function() {
      return this.prevObject || this.constructor(null);
    },
    push: push,
    sort: arr.sort,
    splice: arr.splice
  };
  jQuery.extend = jQuery.fn.extend = function() {
    var options,
        name,
        src,
        copy,
        copyIsArray,
        clone,
        target = arguments[0] || {},
        i = 1,
        length = arguments.length,
        deep = false;
    if (typeof target === "boolean") {
      deep = target;
      target = arguments[i] || {};
      i++;
    }
    if (typeof target !== "object" && !jQuery.isFunction(target)) {
      target = {};
    }
    if (i === length) {
      target = this;
      i--;
    }
    for (; i < length; i++) {
      if ((options = arguments[i]) != null) {
        for (name in options) {
          src = target[name];
          copy = options[name];
          if (target === copy) {
            continue;
          }
          if (deep && copy && (jQuery.isPlainObject(copy) || (copyIsArray = jQuery.isArray(copy)))) {
            if (copyIsArray) {
              copyIsArray = false;
              clone = src && jQuery.isArray(src) ? src : [];
            } else {
              clone = src && jQuery.isPlainObject(src) ? src : {};
            }
            target[name] = jQuery.extend(deep, clone, copy);
          } else if (copy !== undefined) {
            target[name] = copy;
          }
        }
      }
    }
    return target;
  };
  jQuery.extend({
    expando: "jQuery" + (version + Math.random()).replace(/\D/g, ""),
    isReady: true,
    error: function(msg) {
      throw new Error(msg);
    },
    noop: function() {},
    isFunction: function(obj) {
      return jQuery.type(obj) === "function";
    },
    isArray: Array.isArray,
    isWindow: function(obj) {
      return obj != null && obj === obj.window;
    },
    isNumeric: function(obj) {
      return !jQuery.isArray(obj) && (obj - parseFloat(obj) + 1) >= 0;
    },
    isPlainObject: function(obj) {
      if (jQuery.type(obj) !== "object" || obj.nodeType || jQuery.isWindow(obj)) {
        return false;
      }
      if (obj.constructor && !hasOwn.call(obj.constructor.prototype, "isPrototypeOf")) {
        return false;
      }
      return true;
    },
    isEmptyObject: function(obj) {
      var name;
      for (name in obj) {
        return false;
      }
      return true;
    },
    type: function(obj) {
      if (obj == null) {
        return obj + "";
      }
      return typeof obj === "object" || typeof obj === "function" ? class2type[toString.call(obj)] || "object" : typeof obj;
    },
    globalEval: function(code) {
      var script,
          indirect = eval;
      code = jQuery.trim(code);
      if (code) {
        if (code.indexOf("use strict") === 1) {
          script = document.createElement("script");
          script.text = code;
          document.head.appendChild(script).parentNode.removeChild(script);
        } else {
          indirect(code);
        }
      }
    },
    camelCase: function(string) {
      return string.replace(rmsPrefix, "ms-").replace(rdashAlpha, fcamelCase);
    },
    nodeName: function(elem, name) {
      return elem.nodeName && elem.nodeName.toLowerCase() === name.toLowerCase();
    },
    each: function(obj, callback, args) {
      var value,
          i = 0,
          length = obj.length,
          isArray = isArraylike(obj);
      if (args) {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.apply(obj[i], args);
            if (value === false) {
              break;
            }
          }
        }
      } else {
        if (isArray) {
          for (; i < length; i++) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        } else {
          for (i in obj) {
            value = callback.call(obj[i], i, obj[i]);
            if (value === false) {
              break;
            }
          }
        }
      }
      return obj;
    },
    trim: function(text) {
      return text == null ? "" : (text + "").replace(rtrim, "");
    },
    makeArray: function(arr, results) {
      var ret = results || [];
      if (arr != null) {
        if (isArraylike(Object(arr))) {
          jQuery.merge(ret, typeof arr === "string" ? [arr] : arr);
        } else {
          push.call(ret, arr);
        }
      }
      return ret;
    },
    inArray: function(elem, arr, i) {
      return arr == null ? -1 : indexOf.call(arr, elem, i);
    },
    merge: function(first, second) {
      var len = +second.length,
          j = 0,
          i = first.length;
      for (; j < len; j++) {
        first[i++] = second[j];
      }
      first.length = i;
      return first;
    },
    grep: function(elems, callback, invert) {
      var callbackInverse,
          matches = [],
          i = 0,
          length = elems.length,
          callbackExpect = !invert;
      for (; i < length; i++) {
        callbackInverse = !callback(elems[i], i);
        if (callbackInverse !== callbackExpect) {
          matches.push(elems[i]);
        }
      }
      return matches;
    },
    map: function(elems, callback, arg) {
      var value,
          i = 0,
          length = elems.length,
          isArray = isArraylike(elems),
          ret = [];
      if (isArray) {
        for (; i < length; i++) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      } else {
        for (i in elems) {
          value = callback(elems[i], i, arg);
          if (value != null) {
            ret.push(value);
          }
        }
      }
      return concat.apply([], ret);
    },
    guid: 1,
    proxy: function(fn, context) {
      var tmp,
          args,
          proxy;
      if (typeof context === "string") {
        tmp = fn[context];
        context = fn;
        fn = tmp;
      }
      if (!jQuery.isFunction(fn)) {
        return undefined;
      }
      args = slice.call(arguments, 2);
      proxy = function() {
        return fn.apply(context || this, args.concat(slice.call(arguments)));
      };
      proxy.guid = fn.guid = fn.guid || jQuery.guid++;
      return proxy;
    },
    now: Date.now,
    support: support
  });
  jQuery.each("Boolean Number String Function Array Date RegExp Object Error".split(" "), function(i, name) {
    class2type["[object " + name + "]"] = name.toLowerCase();
  });
  function isArraylike(obj) {
    var length = "length" in obj && obj.length,
        type = jQuery.type(obj);
    if (type === "function" || jQuery.isWindow(obj)) {
      return false;
    }
    if (obj.nodeType === 1 && length) {
      return true;
    }
    return type === "array" || length === 0 || typeof length === "number" && length > 0 && (length - 1) in obj;
  }
  var Sizzle = (function(window) {
    var i,
        support,
        Expr,
        getText,
        isXML,
        tokenize,
        compile,
        select,
        outermostContext,
        sortInput,
        hasDuplicate,
        setDocument,
        document,
        docElem,
        documentIsHTML,
        rbuggyQSA,
        rbuggyMatches,
        matches,
        contains,
        expando = "sizzle" + 1 * new Date(),
        preferredDoc = window.document,
        dirruns = 0,
        done = 0,
        classCache = createCache(),
        tokenCache = createCache(),
        compilerCache = createCache(),
        sortOrder = function(a, b) {
          if (a === b) {
            hasDuplicate = true;
          }
          return 0;
        },
        MAX_NEGATIVE = 1 << 31,
        hasOwn = ({}).hasOwnProperty,
        arr = [],
        pop = arr.pop,
        push_native = arr.push,
        push = arr.push,
        slice = arr.slice,
        indexOf = function(list, elem) {
          var i = 0,
              len = list.length;
          for (; i < len; i++) {
            if (list[i] === elem) {
              return i;
            }
          }
          return -1;
        },
        booleans = "checked|selected|async|autofocus|autoplay|controls|defer|disabled|hidden|ismap|loop|multiple|open|readonly|required|scoped",
        whitespace = "[\\x20\\t\\r\\n\\f]",
        characterEncoding = "(?:\\\\.|[\\w-]|[^\\x00-\\xa0])+",
        identifier = characterEncoding.replace("w", "w#"),
        attributes = "\\[" + whitespace + "*(" + characterEncoding + ")(?:" + whitespace + "*([*^$|!~]?=)" + whitespace + "*(?:'((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\"|(" + identifier + "))|)" + whitespace + "*\\]",
        pseudos = ":(" + characterEncoding + ")(?:\\((" + "('((?:\\\\.|[^\\\\'])*)'|\"((?:\\\\.|[^\\\\\"])*)\")|" + "((?:\\\\.|[^\\\\()[\\]]|" + attributes + ")*)|" + ".*" + ")\\)|)",
        rwhitespace = new RegExp(whitespace + "+", "g"),
        rtrim = new RegExp("^" + whitespace + "+|((?:^|[^\\\\])(?:\\\\.)*)" + whitespace + "+$", "g"),
        rcomma = new RegExp("^" + whitespace + "*," + whitespace + "*"),
        rcombinators = new RegExp("^" + whitespace + "*([>+~]|" + whitespace + ")" + whitespace + "*"),
        rattributeQuotes = new RegExp("=" + whitespace + "*([^\\]'\"]*?)" + whitespace + "*\\]", "g"),
        rpseudo = new RegExp(pseudos),
        ridentifier = new RegExp("^" + identifier + "$"),
        matchExpr = {
          "ID": new RegExp("^#(" + characterEncoding + ")"),
          "CLASS": new RegExp("^\\.(" + characterEncoding + ")"),
          "TAG": new RegExp("^(" + characterEncoding.replace("w", "w*") + ")"),
          "ATTR": new RegExp("^" + attributes),
          "PSEUDO": new RegExp("^" + pseudos),
          "CHILD": new RegExp("^:(only|first|last|nth|nth-last)-(child|of-type)(?:\\(" + whitespace + "*(even|odd|(([+-]|)(\\d*)n|)" + whitespace + "*(?:([+-]|)" + whitespace + "*(\\d+)|))" + whitespace + "*\\)|)", "i"),
          "bool": new RegExp("^(?:" + booleans + ")$", "i"),
          "needsContext": new RegExp("^" + whitespace + "*[>+~]|:(even|odd|eq|gt|lt|nth|first|last)(?:\\(" + whitespace + "*((?:-\\d)?\\d*)" + whitespace + "*\\)|)(?=[^-]|$)", "i")
        },
        rinputs = /^(?:input|select|textarea|button)$/i,
        rheader = /^h\d$/i,
        rnative = /^[^{]+\{\s*\[native \w/,
        rquickExpr = /^(?:#([\w-]+)|(\w+)|\.([\w-]+))$/,
        rsibling = /[+~]/,
        rescape = /'|\\/g,
        runescape = new RegExp("\\\\([\\da-f]{1,6}" + whitespace + "?|(" + whitespace + ")|.)", "ig"),
        funescape = function(_, escaped, escapedWhitespace) {
          var high = "0x" + escaped - 0x10000;
          return high !== high || escapedWhitespace ? escaped : high < 0 ? String.fromCharCode(high + 0x10000) : String.fromCharCode(high >> 10 | 0xD800, high & 0x3FF | 0xDC00);
        },
        unloadHandler = function() {
          setDocument();
        };
    try {
      push.apply((arr = slice.call(preferredDoc.childNodes)), preferredDoc.childNodes);
      arr[preferredDoc.childNodes.length].nodeType;
    } catch (e) {
      push = {apply: arr.length ? function(target, els) {
          push_native.apply(target, slice.call(els));
        } : function(target, els) {
          var j = target.length,
              i = 0;
          while ((target[j++] = els[i++])) {}
          target.length = j - 1;
        }};
    }
    function Sizzle(selector, context, results, seed) {
      var match,
          elem,
          m,
          nodeType,
          i,
          groups,
          old,
          nid,
          newContext,
          newSelector;
      if ((context ? context.ownerDocument || context : preferredDoc) !== document) {
        setDocument(context);
      }
      context = context || document;
      results = results || [];
      nodeType = context.nodeType;
      if (typeof selector !== "string" || !selector || nodeType !== 1 && nodeType !== 9 && nodeType !== 11) {
        return results;
      }
      if (!seed && documentIsHTML) {
        if (nodeType !== 11 && (match = rquickExpr.exec(selector))) {
          if ((m = match[1])) {
            if (nodeType === 9) {
              elem = context.getElementById(m);
              if (elem && elem.parentNode) {
                if (elem.id === m) {
                  results.push(elem);
                  return results;
                }
              } else {
                return results;
              }
            } else {
              if (context.ownerDocument && (elem = context.ownerDocument.getElementById(m)) && contains(context, elem) && elem.id === m) {
                results.push(elem);
                return results;
              }
            }
          } else if (match[2]) {
            push.apply(results, context.getElementsByTagName(selector));
            return results;
          } else if ((m = match[3]) && support.getElementsByClassName) {
            push.apply(results, context.getElementsByClassName(m));
            return results;
          }
        }
        if (support.qsa && (!rbuggyQSA || !rbuggyQSA.test(selector))) {
          nid = old = expando;
          newContext = context;
          newSelector = nodeType !== 1 && selector;
          if (nodeType === 1 && context.nodeName.toLowerCase() !== "object") {
            groups = tokenize(selector);
            if ((old = context.getAttribute("id"))) {
              nid = old.replace(rescape, "\\$&");
            } else {
              context.setAttribute("id", nid);
            }
            nid = "[id='" + nid + "'] ";
            i = groups.length;
            while (i--) {
              groups[i] = nid + toSelector(groups[i]);
            }
            newContext = rsibling.test(selector) && testContext(context.parentNode) || context;
            newSelector = groups.join(",");
          }
          if (newSelector) {
            try {
              push.apply(results, newContext.querySelectorAll(newSelector));
              return results;
            } catch (qsaError) {} finally {
              if (!old) {
                context.removeAttribute("id");
              }
            }
          }
        }
      }
      return select(selector.replace(rtrim, "$1"), context, results, seed);
    }
    function createCache() {
      var keys = [];
      function cache(key, value) {
        if (keys.push(key + " ") > Expr.cacheLength) {
          delete cache[keys.shift()];
        }
        return (cache[key + " "] = value);
      }
      return cache;
    }
    function markFunction(fn) {
      fn[expando] = true;
      return fn;
    }
    function assert(fn) {
      var div = document.createElement("div");
      try {
        return !!fn(div);
      } catch (e) {
        return false;
      } finally {
        if (div.parentNode) {
          div.parentNode.removeChild(div);
        }
        div = null;
      }
    }
    function addHandle(attrs, handler) {
      var arr = attrs.split("|"),
          i = attrs.length;
      while (i--) {
        Expr.attrHandle[arr[i]] = handler;
      }
    }
    function siblingCheck(a, b) {
      var cur = b && a,
          diff = cur && a.nodeType === 1 && b.nodeType === 1 && (~b.sourceIndex || MAX_NEGATIVE) - (~a.sourceIndex || MAX_NEGATIVE);
      if (diff) {
        return diff;
      }
      if (cur) {
        while ((cur = cur.nextSibling)) {
          if (cur === b) {
            return -1;
          }
        }
      }
      return a ? 1 : -1;
    }
    function createInputPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return name === "input" && elem.type === type;
      };
    }
    function createButtonPseudo(type) {
      return function(elem) {
        var name = elem.nodeName.toLowerCase();
        return (name === "input" || name === "button") && elem.type === type;
      };
    }
    function createPositionalPseudo(fn) {
      return markFunction(function(argument) {
        argument = +argument;
        return markFunction(function(seed, matches) {
          var j,
              matchIndexes = fn([], seed.length, argument),
              i = matchIndexes.length;
          while (i--) {
            if (seed[(j = matchIndexes[i])]) {
              seed[j] = !(matches[j] = seed[j]);
            }
          }
        });
      });
    }
    function testContext(context) {
      return context && typeof context.getElementsByTagName !== "undefined" && context;
    }
    support = Sizzle.support = {};
    isXML = Sizzle.isXML = function(elem) {
      var documentElement = elem && (elem.ownerDocument || elem).documentElement;
      return documentElement ? documentElement.nodeName !== "HTML" : false;
    };
    setDocument = Sizzle.setDocument = function(node) {
      var hasCompare,
          parent,
          doc = node ? node.ownerDocument || node : preferredDoc;
      if (doc === document || doc.nodeType !== 9 || !doc.documentElement) {
        return document;
      }
      document = doc;
      docElem = doc.documentElement;
      parent = doc.defaultView;
      if (parent && parent !== parent.top) {
        if (parent.addEventListener) {
          parent.addEventListener("unload", unloadHandler, false);
        } else if (parent.attachEvent) {
          parent.attachEvent("onunload", unloadHandler);
        }
      }
      documentIsHTML = !isXML(doc);
      support.attributes = assert(function(div) {
        div.className = "i";
        return !div.getAttribute("className");
      });
      support.getElementsByTagName = assert(function(div) {
        div.appendChild(doc.createComment(""));
        return !div.getElementsByTagName("*").length;
      });
      support.getElementsByClassName = rnative.test(doc.getElementsByClassName);
      support.getById = assert(function(div) {
        docElem.appendChild(div).id = expando;
        return !doc.getElementsByName || !doc.getElementsByName(expando).length;
      });
      if (support.getById) {
        Expr.find["ID"] = function(id, context) {
          if (typeof context.getElementById !== "undefined" && documentIsHTML) {
            var m = context.getElementById(id);
            return m && m.parentNode ? [m] : [];
          }
        };
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            return elem.getAttribute("id") === attrId;
          };
        };
      } else {
        delete Expr.find["ID"];
        Expr.filter["ID"] = function(id) {
          var attrId = id.replace(runescape, funescape);
          return function(elem) {
            var node = typeof elem.getAttributeNode !== "undefined" && elem.getAttributeNode("id");
            return node && node.value === attrId;
          };
        };
      }
      Expr.find["TAG"] = support.getElementsByTagName ? function(tag, context) {
        if (typeof context.getElementsByTagName !== "undefined") {
          return context.getElementsByTagName(tag);
        } else if (support.qsa) {
          return context.querySelectorAll(tag);
        }
      } : function(tag, context) {
        var elem,
            tmp = [],
            i = 0,
            results = context.getElementsByTagName(tag);
        if (tag === "*") {
          while ((elem = results[i++])) {
            if (elem.nodeType === 1) {
              tmp.push(elem);
            }
          }
          return tmp;
        }
        return results;
      };
      Expr.find["CLASS"] = support.getElementsByClassName && function(className, context) {
        if (documentIsHTML) {
          return context.getElementsByClassName(className);
        }
      };
      rbuggyMatches = [];
      rbuggyQSA = [];
      if ((support.qsa = rnative.test(doc.querySelectorAll))) {
        assert(function(div) {
          docElem.appendChild(div).innerHTML = "<a id='" + expando + "'></a>" + "<select id='" + expando + "-\f]' msallowcapture=''>" + "<option selected=''></option></select>";
          if (div.querySelectorAll("[msallowcapture^='']").length) {
            rbuggyQSA.push("[*^$]=" + whitespace + "*(?:''|\"\")");
          }
          if (!div.querySelectorAll("[selected]").length) {
            rbuggyQSA.push("\\[" + whitespace + "*(?:value|" + booleans + ")");
          }
          if (!div.querySelectorAll("[id~=" + expando + "-]").length) {
            rbuggyQSA.push("~=");
          }
          if (!div.querySelectorAll(":checked").length) {
            rbuggyQSA.push(":checked");
          }
          if (!div.querySelectorAll("a#" + expando + "+*").length) {
            rbuggyQSA.push(".#.+[+~]");
          }
        });
        assert(function(div) {
          var input = doc.createElement("input");
          input.setAttribute("type", "hidden");
          div.appendChild(input).setAttribute("name", "D");
          if (div.querySelectorAll("[name=d]").length) {
            rbuggyQSA.push("name" + whitespace + "*[*^$|!~]?=");
          }
          if (!div.querySelectorAll(":enabled").length) {
            rbuggyQSA.push(":enabled", ":disabled");
          }
          div.querySelectorAll("*,:x");
          rbuggyQSA.push(",.*:");
        });
      }
      if ((support.matchesSelector = rnative.test((matches = docElem.matches || docElem.webkitMatchesSelector || docElem.mozMatchesSelector || docElem.oMatchesSelector || docElem.msMatchesSelector)))) {
        assert(function(div) {
          support.disconnectedMatch = matches.call(div, "div");
          matches.call(div, "[s!='']:x");
          rbuggyMatches.push("!=", pseudos);
        });
      }
      rbuggyQSA = rbuggyQSA.length && new RegExp(rbuggyQSA.join("|"));
      rbuggyMatches = rbuggyMatches.length && new RegExp(rbuggyMatches.join("|"));
      hasCompare = rnative.test(docElem.compareDocumentPosition);
      contains = hasCompare || rnative.test(docElem.contains) ? function(a, b) {
        var adown = a.nodeType === 9 ? a.documentElement : a,
            bup = b && b.parentNode;
        return a === bup || !!(bup && bup.nodeType === 1 && (adown.contains ? adown.contains(bup) : a.compareDocumentPosition && a.compareDocumentPosition(bup) & 16));
      } : function(a, b) {
        if (b) {
          while ((b = b.parentNode)) {
            if (b === a) {
              return true;
            }
          }
        }
        return false;
      };
      sortOrder = hasCompare ? function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var compare = !a.compareDocumentPosition - !b.compareDocumentPosition;
        if (compare) {
          return compare;
        }
        compare = (a.ownerDocument || a) === (b.ownerDocument || b) ? a.compareDocumentPosition(b) : 1;
        if (compare & 1 || (!support.sortDetached && b.compareDocumentPosition(a) === compare)) {
          if (a === doc || a.ownerDocument === preferredDoc && contains(preferredDoc, a)) {
            return -1;
          }
          if (b === doc || b.ownerDocument === preferredDoc && contains(preferredDoc, b)) {
            return 1;
          }
          return sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        }
        return compare & 4 ? -1 : 1;
      } : function(a, b) {
        if (a === b) {
          hasDuplicate = true;
          return 0;
        }
        var cur,
            i = 0,
            aup = a.parentNode,
            bup = b.parentNode,
            ap = [a],
            bp = [b];
        if (!aup || !bup) {
          return a === doc ? -1 : b === doc ? 1 : aup ? -1 : bup ? 1 : sortInput ? (indexOf(sortInput, a) - indexOf(sortInput, b)) : 0;
        } else if (aup === bup) {
          return siblingCheck(a, b);
        }
        cur = a;
        while ((cur = cur.parentNode)) {
          ap.unshift(cur);
        }
        cur = b;
        while ((cur = cur.parentNode)) {
          bp.unshift(cur);
        }
        while (ap[i] === bp[i]) {
          i++;
        }
        return i ? siblingCheck(ap[i], bp[i]) : ap[i] === preferredDoc ? -1 : bp[i] === preferredDoc ? 1 : 0;
      };
      return doc;
    };
    Sizzle.matches = function(expr, elements) {
      return Sizzle(expr, null, null, elements);
    };
    Sizzle.matchesSelector = function(elem, expr) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      expr = expr.replace(rattributeQuotes, "='$1']");
      if (support.matchesSelector && documentIsHTML && (!rbuggyMatches || !rbuggyMatches.test(expr)) && (!rbuggyQSA || !rbuggyQSA.test(expr))) {
        try {
          var ret = matches.call(elem, expr);
          if (ret || support.disconnectedMatch || elem.document && elem.document.nodeType !== 11) {
            return ret;
          }
        } catch (e) {}
      }
      return Sizzle(expr, document, null, [elem]).length > 0;
    };
    Sizzle.contains = function(context, elem) {
      if ((context.ownerDocument || context) !== document) {
        setDocument(context);
      }
      return contains(context, elem);
    };
    Sizzle.attr = function(elem, name) {
      if ((elem.ownerDocument || elem) !== document) {
        setDocument(elem);
      }
      var fn = Expr.attrHandle[name.toLowerCase()],
          val = fn && hasOwn.call(Expr.attrHandle, name.toLowerCase()) ? fn(elem, name, !documentIsHTML) : undefined;
      return val !== undefined ? val : support.attributes || !documentIsHTML ? elem.getAttribute(name) : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
    };
    Sizzle.error = function(msg) {
      throw new Error("Syntax error, unrecognized expression: " + msg);
    };
    Sizzle.uniqueSort = function(results) {
      var elem,
          duplicates = [],
          j = 0,
          i = 0;
      hasDuplicate = !support.detectDuplicates;
      sortInput = !support.sortStable && results.slice(0);
      results.sort(sortOrder);
      if (hasDuplicate) {
        while ((elem = results[i++])) {
          if (elem === results[i]) {
            j = duplicates.push(i);
          }
        }
        while (j--) {
          results.splice(duplicates[j], 1);
        }
      }
      sortInput = null;
      return results;
    };
    getText = Sizzle.getText = function(elem) {
      var node,
          ret = "",
          i = 0,
          nodeType = elem.nodeType;
      if (!nodeType) {
        while ((node = elem[i++])) {
          ret += getText(node);
        }
      } else if (nodeType === 1 || nodeType === 9 || nodeType === 11) {
        if (typeof elem.textContent === "string") {
          return elem.textContent;
        } else {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            ret += getText(elem);
          }
        }
      } else if (nodeType === 3 || nodeType === 4) {
        return elem.nodeValue;
      }
      return ret;
    };
    Expr = Sizzle.selectors = {
      cacheLength: 50,
      createPseudo: markFunction,
      match: matchExpr,
      attrHandle: {},
      find: {},
      relative: {
        ">": {
          dir: "parentNode",
          first: true
        },
        " ": {dir: "parentNode"},
        "+": {
          dir: "previousSibling",
          first: true
        },
        "~": {dir: "previousSibling"}
      },
      preFilter: {
        "ATTR": function(match) {
          match[1] = match[1].replace(runescape, funescape);
          match[3] = (match[3] || match[4] || match[5] || "").replace(runescape, funescape);
          if (match[2] === "~=") {
            match[3] = " " + match[3] + " ";
          }
          return match.slice(0, 4);
        },
        "CHILD": function(match) {
          match[1] = match[1].toLowerCase();
          if (match[1].slice(0, 3) === "nth") {
            if (!match[3]) {
              Sizzle.error(match[0]);
            }
            match[4] = +(match[4] ? match[5] + (match[6] || 1) : 2 * (match[3] === "even" || match[3] === "odd"));
            match[5] = +((match[7] + match[8]) || match[3] === "odd");
          } else if (match[3]) {
            Sizzle.error(match[0]);
          }
          return match;
        },
        "PSEUDO": function(match) {
          var excess,
              unquoted = !match[6] && match[2];
          if (matchExpr["CHILD"].test(match[0])) {
            return null;
          }
          if (match[3]) {
            match[2] = match[4] || match[5] || "";
          } else if (unquoted && rpseudo.test(unquoted) && (excess = tokenize(unquoted, true)) && (excess = unquoted.indexOf(")", unquoted.length - excess) - unquoted.length)) {
            match[0] = match[0].slice(0, excess);
            match[2] = unquoted.slice(0, excess);
          }
          return match.slice(0, 3);
        }
      },
      filter: {
        "TAG": function(nodeNameSelector) {
          var nodeName = nodeNameSelector.replace(runescape, funescape).toLowerCase();
          return nodeNameSelector === "*" ? function() {
            return true;
          } : function(elem) {
            return elem.nodeName && elem.nodeName.toLowerCase() === nodeName;
          };
        },
        "CLASS": function(className) {
          var pattern = classCache[className + " "];
          return pattern || (pattern = new RegExp("(^|" + whitespace + ")" + className + "(" + whitespace + "|$)")) && classCache(className, function(elem) {
            return pattern.test(typeof elem.className === "string" && elem.className || typeof elem.getAttribute !== "undefined" && elem.getAttribute("class") || "");
          });
        },
        "ATTR": function(name, operator, check) {
          return function(elem) {
            var result = Sizzle.attr(elem, name);
            if (result == null) {
              return operator === "!=";
            }
            if (!operator) {
              return true;
            }
            result += "";
            return operator === "=" ? result === check : operator === "!=" ? result !== check : operator === "^=" ? check && result.indexOf(check) === 0 : operator === "*=" ? check && result.indexOf(check) > -1 : operator === "$=" ? check && result.slice(-check.length) === check : operator === "~=" ? (" " + result.replace(rwhitespace, " ") + " ").indexOf(check) > -1 : operator === "|=" ? result === check || result.slice(0, check.length + 1) === check + "-" : false;
          };
        },
        "CHILD": function(type, what, argument, first, last) {
          var simple = type.slice(0, 3) !== "nth",
              forward = type.slice(-4) !== "last",
              ofType = what === "of-type";
          return first === 1 && last === 0 ? function(elem) {
            return !!elem.parentNode;
          } : function(elem, context, xml) {
            var cache,
                outerCache,
                node,
                diff,
                nodeIndex,
                start,
                dir = simple !== forward ? "nextSibling" : "previousSibling",
                parent = elem.parentNode,
                name = ofType && elem.nodeName.toLowerCase(),
                useCache = !xml && !ofType;
            if (parent) {
              if (simple) {
                while (dir) {
                  node = elem;
                  while ((node = node[dir])) {
                    if (ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) {
                      return false;
                    }
                  }
                  start = dir = type === "only" && !start && "nextSibling";
                }
                return true;
              }
              start = [forward ? parent.firstChild : parent.lastChild];
              if (forward && useCache) {
                outerCache = parent[expando] || (parent[expando] = {});
                cache = outerCache[type] || [];
                nodeIndex = cache[0] === dirruns && cache[1];
                diff = cache[0] === dirruns && cache[2];
                node = nodeIndex && parent.childNodes[nodeIndex];
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if (node.nodeType === 1 && ++diff && node === elem) {
                    outerCache[type] = [dirruns, nodeIndex, diff];
                    break;
                  }
                }
              } else if (useCache && (cache = (elem[expando] || (elem[expando] = {}))[type]) && cache[0] === dirruns) {
                diff = cache[1];
              } else {
                while ((node = ++nodeIndex && node && node[dir] || (diff = nodeIndex = 0) || start.pop())) {
                  if ((ofType ? node.nodeName.toLowerCase() === name : node.nodeType === 1) && ++diff) {
                    if (useCache) {
                      (node[expando] || (node[expando] = {}))[type] = [dirruns, diff];
                    }
                    if (node === elem) {
                      break;
                    }
                  }
                }
              }
              diff -= last;
              return diff === first || (diff % first === 0 && diff / first >= 0);
            }
          };
        },
        "PSEUDO": function(pseudo, argument) {
          var args,
              fn = Expr.pseudos[pseudo] || Expr.setFilters[pseudo.toLowerCase()] || Sizzle.error("unsupported pseudo: " + pseudo);
          if (fn[expando]) {
            return fn(argument);
          }
          if (fn.length > 1) {
            args = [pseudo, pseudo, "", argument];
            return Expr.setFilters.hasOwnProperty(pseudo.toLowerCase()) ? markFunction(function(seed, matches) {
              var idx,
                  matched = fn(seed, argument),
                  i = matched.length;
              while (i--) {
                idx = indexOf(seed, matched[i]);
                seed[idx] = !(matches[idx] = matched[i]);
              }
            }) : function(elem) {
              return fn(elem, 0, args);
            };
          }
          return fn;
        }
      },
      pseudos: {
        "not": markFunction(function(selector) {
          var input = [],
              results = [],
              matcher = compile(selector.replace(rtrim, "$1"));
          return matcher[expando] ? markFunction(function(seed, matches, context, xml) {
            var elem,
                unmatched = matcher(seed, null, xml, []),
                i = seed.length;
            while (i--) {
              if ((elem = unmatched[i])) {
                seed[i] = !(matches[i] = elem);
              }
            }
          }) : function(elem, context, xml) {
            input[0] = elem;
            matcher(input, null, xml, results);
            input[0] = null;
            return !results.pop();
          };
        }),
        "has": markFunction(function(selector) {
          return function(elem) {
            return Sizzle(selector, elem).length > 0;
          };
        }),
        "contains": markFunction(function(text) {
          text = text.replace(runescape, funescape);
          return function(elem) {
            return (elem.textContent || elem.innerText || getText(elem)).indexOf(text) > -1;
          };
        }),
        "lang": markFunction(function(lang) {
          if (!ridentifier.test(lang || "")) {
            Sizzle.error("unsupported lang: " + lang);
          }
          lang = lang.replace(runescape, funescape).toLowerCase();
          return function(elem) {
            var elemLang;
            do {
              if ((elemLang = documentIsHTML ? elem.lang : elem.getAttribute("xml:lang") || elem.getAttribute("lang"))) {
                elemLang = elemLang.toLowerCase();
                return elemLang === lang || elemLang.indexOf(lang + "-") === 0;
              }
            } while ((elem = elem.parentNode) && elem.nodeType === 1);
            return false;
          };
        }),
        "target": function(elem) {
          var hash = window.location && window.location.hash;
          return hash && hash.slice(1) === elem.id;
        },
        "root": function(elem) {
          return elem === docElem;
        },
        "focus": function(elem) {
          return elem === document.activeElement && (!document.hasFocus || document.hasFocus()) && !!(elem.type || elem.href || ~elem.tabIndex);
        },
        "enabled": function(elem) {
          return elem.disabled === false;
        },
        "disabled": function(elem) {
          return elem.disabled === true;
        },
        "checked": function(elem) {
          var nodeName = elem.nodeName.toLowerCase();
          return (nodeName === "input" && !!elem.checked) || (nodeName === "option" && !!elem.selected);
        },
        "selected": function(elem) {
          if (elem.parentNode) {
            elem.parentNode.selectedIndex;
          }
          return elem.selected === true;
        },
        "empty": function(elem) {
          for (elem = elem.firstChild; elem; elem = elem.nextSibling) {
            if (elem.nodeType < 6) {
              return false;
            }
          }
          return true;
        },
        "parent": function(elem) {
          return !Expr.pseudos["empty"](elem);
        },
        "header": function(elem) {
          return rheader.test(elem.nodeName);
        },
        "input": function(elem) {
          return rinputs.test(elem.nodeName);
        },
        "button": function(elem) {
          var name = elem.nodeName.toLowerCase();
          return name === "input" && elem.type === "button" || name === "button";
        },
        "text": function(elem) {
          var attr;
          return elem.nodeName.toLowerCase() === "input" && elem.type === "text" && ((attr = elem.getAttribute("type")) == null || attr.toLowerCase() === "text");
        },
        "first": createPositionalPseudo(function() {
          return [0];
        }),
        "last": createPositionalPseudo(function(matchIndexes, length) {
          return [length - 1];
        }),
        "eq": createPositionalPseudo(function(matchIndexes, length, argument) {
          return [argument < 0 ? argument + length : argument];
        }),
        "even": createPositionalPseudo(function(matchIndexes, length) {
          var i = 0;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "odd": createPositionalPseudo(function(matchIndexes, length) {
          var i = 1;
          for (; i < length; i += 2) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "lt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; --i >= 0; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        }),
        "gt": createPositionalPseudo(function(matchIndexes, length, argument) {
          var i = argument < 0 ? argument + length : argument;
          for (; ++i < length; ) {
            matchIndexes.push(i);
          }
          return matchIndexes;
        })
      }
    };
    Expr.pseudos["nth"] = Expr.pseudos["eq"];
    for (i in {
      radio: true,
      checkbox: true,
      file: true,
      password: true,
      image: true
    }) {
      Expr.pseudos[i] = createInputPseudo(i);
    }
    for (i in {
      submit: true,
      reset: true
    }) {
      Expr.pseudos[i] = createButtonPseudo(i);
    }
    function setFilters() {}
    setFilters.prototype = Expr.filters = Expr.pseudos;
    Expr.setFilters = new setFilters();
    tokenize = Sizzle.tokenize = function(selector, parseOnly) {
      var matched,
          match,
          tokens,
          type,
          soFar,
          groups,
          preFilters,
          cached = tokenCache[selector + " "];
      if (cached) {
        return parseOnly ? 0 : cached.slice(0);
      }
      soFar = selector;
      groups = [];
      preFilters = Expr.preFilter;
      while (soFar) {
        if (!matched || (match = rcomma.exec(soFar))) {
          if (match) {
            soFar = soFar.slice(match[0].length) || soFar;
          }
          groups.push((tokens = []));
        }
        matched = false;
        if ((match = rcombinators.exec(soFar))) {
          matched = match.shift();
          tokens.push({
            value: matched,
            type: match[0].replace(rtrim, " ")
          });
          soFar = soFar.slice(matched.length);
        }
        for (type in Expr.filter) {
          if ((match = matchExpr[type].exec(soFar)) && (!preFilters[type] || (match = preFilters[type](match)))) {
            matched = match.shift();
            tokens.push({
              value: matched,
              type: type,
              matches: match
            });
            soFar = soFar.slice(matched.length);
          }
        }
        if (!matched) {
          break;
        }
      }
      return parseOnly ? soFar.length : soFar ? Sizzle.error(selector) : tokenCache(selector, groups).slice(0);
    };
    function toSelector(tokens) {
      var i = 0,
          len = tokens.length,
          selector = "";
      for (; i < len; i++) {
        selector += tokens[i].value;
      }
      return selector;
    }
    function addCombinator(matcher, combinator, base) {
      var dir = combinator.dir,
          checkNonElements = base && dir === "parentNode",
          doneName = done++;
      return combinator.first ? function(elem, context, xml) {
        while ((elem = elem[dir])) {
          if (elem.nodeType === 1 || checkNonElements) {
            return matcher(elem, context, xml);
          }
        }
      } : function(elem, context, xml) {
        var oldCache,
            outerCache,
            newCache = [dirruns, doneName];
        if (xml) {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              if (matcher(elem, context, xml)) {
                return true;
              }
            }
          }
        } else {
          while ((elem = elem[dir])) {
            if (elem.nodeType === 1 || checkNonElements) {
              outerCache = elem[expando] || (elem[expando] = {});
              if ((oldCache = outerCache[dir]) && oldCache[0] === dirruns && oldCache[1] === doneName) {
                return (newCache[2] = oldCache[2]);
              } else {
                outerCache[dir] = newCache;
                if ((newCache[2] = matcher(elem, context, xml))) {
                  return true;
                }
              }
            }
          }
        }
      };
    }
    function elementMatcher(matchers) {
      return matchers.length > 1 ? function(elem, context, xml) {
        var i = matchers.length;
        while (i--) {
          if (!matchers[i](elem, context, xml)) {
            return false;
          }
        }
        return true;
      } : matchers[0];
    }
    function multipleContexts(selector, contexts, results) {
      var i = 0,
          len = contexts.length;
      for (; i < len; i++) {
        Sizzle(selector, contexts[i], results);
      }
      return results;
    }
    function condense(unmatched, map, filter, context, xml) {
      var elem,
          newUnmatched = [],
          i = 0,
          len = unmatched.length,
          mapped = map != null;
      for (; i < len; i++) {
        if ((elem = unmatched[i])) {
          if (!filter || filter(elem, context, xml)) {
            newUnmatched.push(elem);
            if (mapped) {
              map.push(i);
            }
          }
        }
      }
      return newUnmatched;
    }
    function setMatcher(preFilter, selector, matcher, postFilter, postFinder, postSelector) {
      if (postFilter && !postFilter[expando]) {
        postFilter = setMatcher(postFilter);
      }
      if (postFinder && !postFinder[expando]) {
        postFinder = setMatcher(postFinder, postSelector);
      }
      return markFunction(function(seed, results, context, xml) {
        var temp,
            i,
            elem,
            preMap = [],
            postMap = [],
            preexisting = results.length,
            elems = seed || multipleContexts(selector || "*", context.nodeType ? [context] : context, []),
            matcherIn = preFilter && (seed || !selector) ? condense(elems, preMap, preFilter, context, xml) : elems,
            matcherOut = matcher ? postFinder || (seed ? preFilter : preexisting || postFilter) ? [] : results : matcherIn;
        if (matcher) {
          matcher(matcherIn, matcherOut, context, xml);
        }
        if (postFilter) {
          temp = condense(matcherOut, postMap);
          postFilter(temp, [], context, xml);
          i = temp.length;
          while (i--) {
            if ((elem = temp[i])) {
              matcherOut[postMap[i]] = !(matcherIn[postMap[i]] = elem);
            }
          }
        }
        if (seed) {
          if (postFinder || preFilter) {
            if (postFinder) {
              temp = [];
              i = matcherOut.length;
              while (i--) {
                if ((elem = matcherOut[i])) {
                  temp.push((matcherIn[i] = elem));
                }
              }
              postFinder(null, (matcherOut = []), temp, xml);
            }
            i = matcherOut.length;
            while (i--) {
              if ((elem = matcherOut[i]) && (temp = postFinder ? indexOf(seed, elem) : preMap[i]) > -1) {
                seed[temp] = !(results[temp] = elem);
              }
            }
          }
        } else {
          matcherOut = condense(matcherOut === results ? matcherOut.splice(preexisting, matcherOut.length) : matcherOut);
          if (postFinder) {
            postFinder(null, results, matcherOut, xml);
          } else {
            push.apply(results, matcherOut);
          }
        }
      });
    }
    function matcherFromTokens(tokens) {
      var checkContext,
          matcher,
          j,
          len = tokens.length,
          leadingRelative = Expr.relative[tokens[0].type],
          implicitRelative = leadingRelative || Expr.relative[" "],
          i = leadingRelative ? 1 : 0,
          matchContext = addCombinator(function(elem) {
            return elem === checkContext;
          }, implicitRelative, true),
          matchAnyContext = addCombinator(function(elem) {
            return indexOf(checkContext, elem) > -1;
          }, implicitRelative, true),
          matchers = [function(elem, context, xml) {
            var ret = (!leadingRelative && (xml || context !== outermostContext)) || ((checkContext = context).nodeType ? matchContext(elem, context, xml) : matchAnyContext(elem, context, xml));
            checkContext = null;
            return ret;
          }];
      for (; i < len; i++) {
        if ((matcher = Expr.relative[tokens[i].type])) {
          matchers = [addCombinator(elementMatcher(matchers), matcher)];
        } else {
          matcher = Expr.filter[tokens[i].type].apply(null, tokens[i].matches);
          if (matcher[expando]) {
            j = ++i;
            for (; j < len; j++) {
              if (Expr.relative[tokens[j].type]) {
                break;
              }
            }
            return setMatcher(i > 1 && elementMatcher(matchers), i > 1 && toSelector(tokens.slice(0, i - 1).concat({value: tokens[i - 2].type === " " ? "*" : ""})).replace(rtrim, "$1"), matcher, i < j && matcherFromTokens(tokens.slice(i, j)), j < len && matcherFromTokens((tokens = tokens.slice(j))), j < len && toSelector(tokens));
          }
          matchers.push(matcher);
        }
      }
      return elementMatcher(matchers);
    }
    function matcherFromGroupMatchers(elementMatchers, setMatchers) {
      var bySet = setMatchers.length > 0,
          byElement = elementMatchers.length > 0,
          superMatcher = function(seed, context, xml, results, outermost) {
            var elem,
                j,
                matcher,
                matchedCount = 0,
                i = "0",
                unmatched = seed && [],
                setMatched = [],
                contextBackup = outermostContext,
                elems = seed || byElement && Expr.find["TAG"]("*", outermost),
                dirrunsUnique = (dirruns += contextBackup == null ? 1 : Math.random() || 0.1),
                len = elems.length;
            if (outermost) {
              outermostContext = context !== document && context;
            }
            for (; i !== len && (elem = elems[i]) != null; i++) {
              if (byElement && elem) {
                j = 0;
                while ((matcher = elementMatchers[j++])) {
                  if (matcher(elem, context, xml)) {
                    results.push(elem);
                    break;
                  }
                }
                if (outermost) {
                  dirruns = dirrunsUnique;
                }
              }
              if (bySet) {
                if ((elem = !matcher && elem)) {
                  matchedCount--;
                }
                if (seed) {
                  unmatched.push(elem);
                }
              }
            }
            matchedCount += i;
            if (bySet && i !== matchedCount) {
              j = 0;
              while ((matcher = setMatchers[j++])) {
                matcher(unmatched, setMatched, context, xml);
              }
              if (seed) {
                if (matchedCount > 0) {
                  while (i--) {
                    if (!(unmatched[i] || setMatched[i])) {
                      setMatched[i] = pop.call(results);
                    }
                  }
                }
                setMatched = condense(setMatched);
              }
              push.apply(results, setMatched);
              if (outermost && !seed && setMatched.length > 0 && (matchedCount + setMatchers.length) > 1) {
                Sizzle.uniqueSort(results);
              }
            }
            if (outermost) {
              dirruns = dirrunsUnique;
              outermostContext = contextBackup;
            }
            return unmatched;
          };
      return bySet ? markFunction(superMatcher) : superMatcher;
    }
    compile = Sizzle.compile = function(selector, match) {
      var i,
          setMatchers = [],
          elementMatchers = [],
          cached = compilerCache[selector + " "];
      if (!cached) {
        if (!match) {
          match = tokenize(selector);
        }
        i = match.length;
        while (i--) {
          cached = matcherFromTokens(match[i]);
          if (cached[expando]) {
            setMatchers.push(cached);
          } else {
            elementMatchers.push(cached);
          }
        }
        cached = compilerCache(selector, matcherFromGroupMatchers(elementMatchers, setMatchers));
        cached.selector = selector;
      }
      return cached;
    };
    select = Sizzle.select = function(selector, context, results, seed) {
      var i,
          tokens,
          token,
          type,
          find,
          compiled = typeof selector === "function" && selector,
          match = !seed && tokenize((selector = compiled.selector || selector));
      results = results || [];
      if (match.length === 1) {
        tokens = match[0] = match[0].slice(0);
        if (tokens.length > 2 && (token = tokens[0]).type === "ID" && support.getById && context.nodeType === 9 && documentIsHTML && Expr.relative[tokens[1].type]) {
          context = (Expr.find["ID"](token.matches[0].replace(runescape, funescape), context) || [])[0];
          if (!context) {
            return results;
          } else if (compiled) {
            context = context.parentNode;
          }
          selector = selector.slice(tokens.shift().value.length);
        }
        i = matchExpr["needsContext"].test(selector) ? 0 : tokens.length;
        while (i--) {
          token = tokens[i];
          if (Expr.relative[(type = token.type)]) {
            break;
          }
          if ((find = Expr.find[type])) {
            if ((seed = find(token.matches[0].replace(runescape, funescape), rsibling.test(tokens[0].type) && testContext(context.parentNode) || context))) {
              tokens.splice(i, 1);
              selector = seed.length && toSelector(tokens);
              if (!selector) {
                push.apply(results, seed);
                return results;
              }
              break;
            }
          }
        }
      }
      (compiled || compile(selector, match))(seed, context, !documentIsHTML, results, rsibling.test(selector) && testContext(context.parentNode) || context);
      return results;
    };
    support.sortStable = expando.split("").sort(sortOrder).join("") === expando;
    support.detectDuplicates = !!hasDuplicate;
    setDocument();
    support.sortDetached = assert(function(div1) {
      return div1.compareDocumentPosition(document.createElement("div")) & 1;
    });
    if (!assert(function(div) {
      div.innerHTML = "<a href='#'></a>";
      return div.firstChild.getAttribute("href") === "#";
    })) {
      addHandle("type|href|height|width", function(elem, name, isXML) {
        if (!isXML) {
          return elem.getAttribute(name, name.toLowerCase() === "type" ? 1 : 2);
        }
      });
    }
    if (!support.attributes || !assert(function(div) {
      div.innerHTML = "<input/>";
      div.firstChild.setAttribute("value", "");
      return div.firstChild.getAttribute("value") === "";
    })) {
      addHandle("value", function(elem, name, isXML) {
        if (!isXML && elem.nodeName.toLowerCase() === "input") {
          return elem.defaultValue;
        }
      });
    }
    if (!assert(function(div) {
      return div.getAttribute("disabled") == null;
    })) {
      addHandle(booleans, function(elem, name, isXML) {
        var val;
        if (!isXML) {
          return elem[name] === true ? name.toLowerCase() : (val = elem.getAttributeNode(name)) && val.specified ? val.value : null;
        }
      });
    }
    return Sizzle;
  })(window);
  jQuery.find = Sizzle;
  jQuery.expr = Sizzle.selectors;
  jQuery.expr[":"] = jQuery.expr.pseudos;
  jQuery.unique = Sizzle.uniqueSort;
  jQuery.text = Sizzle.getText;
  jQuery.isXMLDoc = Sizzle.isXML;
  jQuery.contains = Sizzle.contains;
  var rneedsContext = jQuery.expr.match.needsContext;
  var rsingleTag = (/^<(\w+)\s*\/?>(?:<\/\1>|)$/);
  var risSimple = /^.[^:#\[\.,]*$/;
  function winnow(elements, qualifier, not) {
    if (jQuery.isFunction(qualifier)) {
      return jQuery.grep(elements, function(elem, i) {
        return !!qualifier.call(elem, i, elem) !== not;
      });
    }
    if (qualifier.nodeType) {
      return jQuery.grep(elements, function(elem) {
        return (elem === qualifier) !== not;
      });
    }
    if (typeof qualifier === "string") {
      if (risSimple.test(qualifier)) {
        return jQuery.filter(qualifier, elements, not);
      }
      qualifier = jQuery.filter(qualifier, elements);
    }
    return jQuery.grep(elements, function(elem) {
      return (indexOf.call(qualifier, elem) >= 0) !== not;
    });
  }
  jQuery.filter = function(expr, elems, not) {
    var elem = elems[0];
    if (not) {
      expr = ":not(" + expr + ")";
    }
    return elems.length === 1 && elem.nodeType === 1 ? jQuery.find.matchesSelector(elem, expr) ? [elem] : [] : jQuery.find.matches(expr, jQuery.grep(elems, function(elem) {
      return elem.nodeType === 1;
    }));
  };
  jQuery.fn.extend({
    find: function(selector) {
      var i,
          len = this.length,
          ret = [],
          self = this;
      if (typeof selector !== "string") {
        return this.pushStack(jQuery(selector).filter(function() {
          for (i = 0; i < len; i++) {
            if (jQuery.contains(self[i], this)) {
              return true;
            }
          }
        }));
      }
      for (i = 0; i < len; i++) {
        jQuery.find(selector, self[i], ret);
      }
      ret = this.pushStack(len > 1 ? jQuery.unique(ret) : ret);
      ret.selector = this.selector ? this.selector + " " + selector : selector;
      return ret;
    },
    filter: function(selector) {
      return this.pushStack(winnow(this, selector || [], false));
    },
    not: function(selector) {
      return this.pushStack(winnow(this, selector || [], true));
    },
    is: function(selector) {
      return !!winnow(this, typeof selector === "string" && rneedsContext.test(selector) ? jQuery(selector) : selector || [], false).length;
    }
  });
  var rootjQuery,
      rquickExpr = /^(?:\s*(<[\w\W]+>)[^>]*|#([\w-]*))$/,
      init = jQuery.fn.init = function(selector, context) {
        var match,
            elem;
        if (!selector) {
          return this;
        }
        if (typeof selector === "string") {
          if (selector[0] === "<" && selector[selector.length - 1] === ">" && selector.length >= 3) {
            match = [null, selector, null];
          } else {
            match = rquickExpr.exec(selector);
          }
          if (match && (match[1] || !context)) {
            if (match[1]) {
              context = context instanceof jQuery ? context[0] : context;
              jQuery.merge(this, jQuery.parseHTML(match[1], context && context.nodeType ? context.ownerDocument || context : document, true));
              if (rsingleTag.test(match[1]) && jQuery.isPlainObject(context)) {
                for (match in context) {
                  if (jQuery.isFunction(this[match])) {
                    this[match](context[match]);
                  } else {
                    this.attr(match, context[match]);
                  }
                }
              }
              return this;
            } else {
              elem = document.getElementById(match[2]);
              if (elem && elem.parentNode) {
                this.length = 1;
                this[0] = elem;
              }
              this.context = document;
              this.selector = selector;
              return this;
            }
          } else if (!context || context.jquery) {
            return (context || rootjQuery).find(selector);
          } else {
            return this.constructor(context).find(selector);
          }
        } else if (selector.nodeType) {
          this.context = this[0] = selector;
          this.length = 1;
          return this;
        } else if (jQuery.isFunction(selector)) {
          return typeof rootjQuery.ready !== "undefined" ? rootjQuery.ready(selector) : selector(jQuery);
        }
        if (selector.selector !== undefined) {
          this.selector = selector.selector;
          this.context = selector.context;
        }
        return jQuery.makeArray(selector, this);
      };
  init.prototype = jQuery.fn;
  rootjQuery = jQuery(document);
  var rparentsprev = /^(?:parents|prev(?:Until|All))/,
      guaranteedUnique = {
        children: true,
        contents: true,
        next: true,
        prev: true
      };
  jQuery.extend({
    dir: function(elem, dir, until) {
      var matched = [],
          truncate = until !== undefined;
      while ((elem = elem[dir]) && elem.nodeType !== 9) {
        if (elem.nodeType === 1) {
          if (truncate && jQuery(elem).is(until)) {
            break;
          }
          matched.push(elem);
        }
      }
      return matched;
    },
    sibling: function(n, elem) {
      var matched = [];
      for (; n; n = n.nextSibling) {
        if (n.nodeType === 1 && n !== elem) {
          matched.push(n);
        }
      }
      return matched;
    }
  });
  jQuery.fn.extend({
    has: function(target) {
      var targets = jQuery(target, this),
          l = targets.length;
      return this.filter(function() {
        var i = 0;
        for (; i < l; i++) {
          if (jQuery.contains(this, targets[i])) {
            return true;
          }
        }
      });
    },
    closest: function(selectors, context) {
      var cur,
          i = 0,
          l = this.length,
          matched = [],
          pos = rneedsContext.test(selectors) || typeof selectors !== "string" ? jQuery(selectors, context || this.context) : 0;
      for (; i < l; i++) {
        for (cur = this[i]; cur && cur !== context; cur = cur.parentNode) {
          if (cur.nodeType < 11 && (pos ? pos.index(cur) > -1 : cur.nodeType === 1 && jQuery.find.matchesSelector(cur, selectors))) {
            matched.push(cur);
            break;
          }
        }
      }
      return this.pushStack(matched.length > 1 ? jQuery.unique(matched) : matched);
    },
    index: function(elem) {
      if (!elem) {
        return (this[0] && this[0].parentNode) ? this.first().prevAll().length : -1;
      }
      if (typeof elem === "string") {
        return indexOf.call(jQuery(elem), this[0]);
      }
      return indexOf.call(this, elem.jquery ? elem[0] : elem);
    },
    add: function(selector, context) {
      return this.pushStack(jQuery.unique(jQuery.merge(this.get(), jQuery(selector, context))));
    },
    addBack: function(selector) {
      return this.add(selector == null ? this.prevObject : this.prevObject.filter(selector));
    }
  });
  function sibling(cur, dir) {
    while ((cur = cur[dir]) && cur.nodeType !== 1) {}
    return cur;
  }
  jQuery.each({
    parent: function(elem) {
      var parent = elem.parentNode;
      return parent && parent.nodeType !== 11 ? parent : null;
    },
    parents: function(elem) {
      return jQuery.dir(elem, "parentNode");
    },
    parentsUntil: function(elem, i, until) {
      return jQuery.dir(elem, "parentNode", until);
    },
    next: function(elem) {
      return sibling(elem, "nextSibling");
    },
    prev: function(elem) {
      return sibling(elem, "previousSibling");
    },
    nextAll: function(elem) {
      return jQuery.dir(elem, "nextSibling");
    },
    prevAll: function(elem) {
      return jQuery.dir(elem, "previousSibling");
    },
    nextUntil: function(elem, i, until) {
      return jQuery.dir(elem, "nextSibling", until);
    },
    prevUntil: function(elem, i, until) {
      return jQuery.dir(elem, "previousSibling", until);
    },
    siblings: function(elem) {
      return jQuery.sibling((elem.parentNode || {}).firstChild, elem);
    },
    children: function(elem) {
      return jQuery.sibling(elem.firstChild);
    },
    contents: function(elem) {
      return elem.contentDocument || jQuery.merge([], elem.childNodes);
    }
  }, function(name, fn) {
    jQuery.fn[name] = function(until, selector) {
      var matched = jQuery.map(this, fn, until);
      if (name.slice(-5) !== "Until") {
        selector = until;
      }
      if (selector && typeof selector === "string") {
        matched = jQuery.filter(selector, matched);
      }
      if (this.length > 1) {
        if (!guaranteedUnique[name]) {
          jQuery.unique(matched);
        }
        if (rparentsprev.test(name)) {
          matched.reverse();
        }
      }
      return this.pushStack(matched);
    };
  });
  var rnotwhite = (/\S+/g);
  var optionsCache = {};
  function createOptions(options) {
    var object = optionsCache[options] = {};
    jQuery.each(options.match(rnotwhite) || [], function(_, flag) {
      object[flag] = true;
    });
    return object;
  }
  jQuery.Callbacks = function(options) {
    options = typeof options === "string" ? (optionsCache[options] || createOptions(options)) : jQuery.extend({}, options);
    var memory,
        fired,
        firing,
        firingStart,
        firingLength,
        firingIndex,
        list = [],
        stack = !options.once && [],
        fire = function(data) {
          memory = options.memory && data;
          fired = true;
          firingIndex = firingStart || 0;
          firingStart = 0;
          firingLength = list.length;
          firing = true;
          for (; list && firingIndex < firingLength; firingIndex++) {
            if (list[firingIndex].apply(data[0], data[1]) === false && options.stopOnFalse) {
              memory = false;
              break;
            }
          }
          firing = false;
          if (list) {
            if (stack) {
              if (stack.length) {
                fire(stack.shift());
              }
            } else if (memory) {
              list = [];
            } else {
              self.disable();
            }
          }
        },
        self = {
          add: function() {
            if (list) {
              var start = list.length;
              (function add(args) {
                jQuery.each(args, function(_, arg) {
                  var type = jQuery.type(arg);
                  if (type === "function") {
                    if (!options.unique || !self.has(arg)) {
                      list.push(arg);
                    }
                  } else if (arg && arg.length && type !== "string") {
                    add(arg);
                  }
                });
              })(arguments);
              if (firing) {
                firingLength = list.length;
              } else if (memory) {
                firingStart = start;
                fire(memory);
              }
            }
            return this;
          },
          remove: function() {
            if (list) {
              jQuery.each(arguments, function(_, arg) {
                var index;
                while ((index = jQuery.inArray(arg, list, index)) > -1) {
                  list.splice(index, 1);
                  if (firing) {
                    if (index <= firingLength) {
                      firingLength--;
                    }
                    if (index <= firingIndex) {
                      firingIndex--;
                    }
                  }
                }
              });
            }
            return this;
          },
          has: function(fn) {
            return fn ? jQuery.inArray(fn, list) > -1 : !!(list && list.length);
          },
          empty: function() {
            list = [];
            firingLength = 0;
            return this;
          },
          disable: function() {
            list = stack = memory = undefined;
            return this;
          },
          disabled: function() {
            return !list;
          },
          lock: function() {
            stack = undefined;
            if (!memory) {
              self.disable();
            }
            return this;
          },
          locked: function() {
            return !stack;
          },
          fireWith: function(context, args) {
            if (list && (!fired || stack)) {
              args = args || [];
              args = [context, args.slice ? args.slice() : args];
              if (firing) {
                stack.push(args);
              } else {
                fire(args);
              }
            }
            return this;
          },
          fire: function() {
            self.fireWith(this, arguments);
            return this;
          },
          fired: function() {
            return !!fired;
          }
        };
    return self;
  };
  jQuery.extend({
    Deferred: function(func) {
      var tuples = [["resolve", "done", jQuery.Callbacks("once memory"), "resolved"], ["reject", "fail", jQuery.Callbacks("once memory"), "rejected"], ["notify", "progress", jQuery.Callbacks("memory")]],
          state = "pending",
          promise = {
            state: function() {
              return state;
            },
            always: function() {
              deferred.done(arguments).fail(arguments);
              return this;
            },
            then: function() {
              var fns = arguments;
              return jQuery.Deferred(function(newDefer) {
                jQuery.each(tuples, function(i, tuple) {
                  var fn = jQuery.isFunction(fns[i]) && fns[i];
                  deferred[tuple[1]](function() {
                    var returned = fn && fn.apply(this, arguments);
                    if (returned && jQuery.isFunction(returned.promise)) {
                      returned.promise().done(newDefer.resolve).fail(newDefer.reject).progress(newDefer.notify);
                    } else {
                      newDefer[tuple[0] + "With"](this === promise ? newDefer.promise() : this, fn ? [returned] : arguments);
                    }
                  });
                });
                fns = null;
              }).promise();
            },
            promise: function(obj) {
              return obj != null ? jQuery.extend(obj, promise) : promise;
            }
          },
          deferred = {};
      promise.pipe = promise.then;
      jQuery.each(tuples, function(i, tuple) {
        var list = tuple[2],
            stateString = tuple[3];
        promise[tuple[1]] = list.add;
        if (stateString) {
          list.add(function() {
            state = stateString;
          }, tuples[i ^ 1][2].disable, tuples[2][2].lock);
        }
        deferred[tuple[0]] = function() {
          deferred[tuple[0] + "With"](this === deferred ? promise : this, arguments);
          return this;
        };
        deferred[tuple[0] + "With"] = list.fireWith;
      });
      promise.promise(deferred);
      if (func) {
        func.call(deferred, deferred);
      }
      return deferred;
    },
    when: function(subordinate) {
      var i = 0,
          resolveValues = slice.call(arguments),
          length = resolveValues.length,
          remaining = length !== 1 || (subordinate && jQuery.isFunction(subordinate.promise)) ? length : 0,
          deferred = remaining === 1 ? subordinate : jQuery.Deferred(),
          updateFunc = function(i, contexts, values) {
            return function(value) {
              contexts[i] = this;
              values[i] = arguments.length > 1 ? slice.call(arguments) : value;
              if (values === progressValues) {
                deferred.notifyWith(contexts, values);
              } else if (!(--remaining)) {
                deferred.resolveWith(contexts, values);
              }
            };
          },
          progressValues,
          progressContexts,
          resolveContexts;
      if (length > 1) {
        progressValues = new Array(length);
        progressContexts = new Array(length);
        resolveContexts = new Array(length);
        for (; i < length; i++) {
          if (resolveValues[i] && jQuery.isFunction(resolveValues[i].promise)) {
            resolveValues[i].promise().done(updateFunc(i, resolveContexts, resolveValues)).fail(deferred.reject).progress(updateFunc(i, progressContexts, progressValues));
          } else {
            --remaining;
          }
        }
      }
      if (!remaining) {
        deferred.resolveWith(resolveContexts, resolveValues);
      }
      return deferred.promise();
    }
  });
  var readyList;
  jQuery.fn.ready = function(fn) {
    jQuery.ready.promise().done(fn);
    return this;
  };
  jQuery.extend({
    isReady: false,
    readyWait: 1,
    holdReady: function(hold) {
      if (hold) {
        jQuery.readyWait++;
      } else {
        jQuery.ready(true);
      }
    },
    ready: function(wait) {
      if (wait === true ? --jQuery.readyWait : jQuery.isReady) {
        return;
      }
      jQuery.isReady = true;
      if (wait !== true && --jQuery.readyWait > 0) {
        return;
      }
      readyList.resolveWith(document, [jQuery]);
      if (jQuery.fn.triggerHandler) {
        jQuery(document).triggerHandler("ready");
        jQuery(document).off("ready");
      }
    }
  });
  function completed() {
    document.removeEventListener("DOMContentLoaded", completed, false);
    window.removeEventListener("load", completed, false);
    jQuery.ready();
  }
  jQuery.ready.promise = function(obj) {
    if (!readyList) {
      readyList = jQuery.Deferred();
      if (document.readyState === "complete") {
        setTimeout(jQuery.ready);
      } else {
        document.addEventListener("DOMContentLoaded", completed, false);
        window.addEventListener("load", completed, false);
      }
    }
    return readyList.promise(obj);
  };
  jQuery.ready.promise();
  var access = jQuery.access = function(elems, fn, key, value, chainable, emptyGet, raw) {
    var i = 0,
        len = elems.length,
        bulk = key == null;
    if (jQuery.type(key) === "object") {
      chainable = true;
      for (i in key) {
        jQuery.access(elems, fn, i, key[i], true, emptyGet, raw);
      }
    } else if (value !== undefined) {
      chainable = true;
      if (!jQuery.isFunction(value)) {
        raw = true;
      }
      if (bulk) {
        if (raw) {
          fn.call(elems, value);
          fn = null;
        } else {
          bulk = fn;
          fn = function(elem, key, value) {
            return bulk.call(jQuery(elem), value);
          };
        }
      }
      if (fn) {
        for (; i < len; i++) {
          fn(elems[i], key, raw ? value : value.call(elems[i], i, fn(elems[i], key)));
        }
      }
    }
    return chainable ? elems : bulk ? fn.call(elems) : len ? fn(elems[0], key) : emptyGet;
  };
  jQuery.acceptData = function(owner) {
    return owner.nodeType === 1 || owner.nodeType === 9 || !(+owner.nodeType);
  };
  function Data() {
    Object.defineProperty(this.cache = {}, 0, {get: function() {
        return {};
      }});
    this.expando = jQuery.expando + Data.uid++;
  }
  Data.uid = 1;
  Data.accepts = jQuery.acceptData;
  Data.prototype = {
    key: function(owner) {
      if (!Data.accepts(owner)) {
        return 0;
      }
      var descriptor = {},
          unlock = owner[this.expando];
      if (!unlock) {
        unlock = Data.uid++;
        try {
          descriptor[this.expando] = {value: unlock};
          Object.defineProperties(owner, descriptor);
        } catch (e) {
          descriptor[this.expando] = unlock;
          jQuery.extend(owner, descriptor);
        }
      }
      if (!this.cache[unlock]) {
        this.cache[unlock] = {};
      }
      return unlock;
    },
    set: function(owner, data, value) {
      var prop,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (typeof data === "string") {
        cache[data] = value;
      } else {
        if (jQuery.isEmptyObject(cache)) {
          jQuery.extend(this.cache[unlock], data);
        } else {
          for (prop in data) {
            cache[prop] = data[prop];
          }
        }
      }
      return cache;
    },
    get: function(owner, key) {
      var cache = this.cache[this.key(owner)];
      return key === undefined ? cache : cache[key];
    },
    access: function(owner, key, value) {
      var stored;
      if (key === undefined || ((key && typeof key === "string") && value === undefined)) {
        stored = this.get(owner, key);
        return stored !== undefined ? stored : this.get(owner, jQuery.camelCase(key));
      }
      this.set(owner, key, value);
      return value !== undefined ? value : key;
    },
    remove: function(owner, key) {
      var i,
          name,
          camel,
          unlock = this.key(owner),
          cache = this.cache[unlock];
      if (key === undefined) {
        this.cache[unlock] = {};
      } else {
        if (jQuery.isArray(key)) {
          name = key.concat(key.map(jQuery.camelCase));
        } else {
          camel = jQuery.camelCase(key);
          if (key in cache) {
            name = [key, camel];
          } else {
            name = camel;
            name = name in cache ? [name] : (name.match(rnotwhite) || []);
          }
        }
        i = name.length;
        while (i--) {
          delete cache[name[i]];
        }
      }
    },
    hasData: function(owner) {
      return !jQuery.isEmptyObject(this.cache[owner[this.expando]] || {});
    },
    discard: function(owner) {
      if (owner[this.expando]) {
        delete this.cache[owner[this.expando]];
      }
    }
  };
  var data_priv = new Data();
  var data_user = new Data();
  var rbrace = /^(?:\{[\w\W]*\}|\[[\w\W]*\])$/,
      rmultiDash = /([A-Z])/g;
  function dataAttr(elem, key, data) {
    var name;
    if (data === undefined && elem.nodeType === 1) {
      name = "data-" + key.replace(rmultiDash, "-$1").toLowerCase();
      data = elem.getAttribute(name);
      if (typeof data === "string") {
        try {
          data = data === "true" ? true : data === "false" ? false : data === "null" ? null : +data + "" === data ? +data : rbrace.test(data) ? jQuery.parseJSON(data) : data;
        } catch (e) {}
        data_user.set(elem, key, data);
      } else {
        data = undefined;
      }
    }
    return data;
  }
  jQuery.extend({
    hasData: function(elem) {
      return data_user.hasData(elem) || data_priv.hasData(elem);
    },
    data: function(elem, name, data) {
      return data_user.access(elem, name, data);
    },
    removeData: function(elem, name) {
      data_user.remove(elem, name);
    },
    _data: function(elem, name, data) {
      return data_priv.access(elem, name, data);
    },
    _removeData: function(elem, name) {
      data_priv.remove(elem, name);
    }
  });
  jQuery.fn.extend({
    data: function(key, value) {
      var i,
          name,
          data,
          elem = this[0],
          attrs = elem && elem.attributes;
      if (key === undefined) {
        if (this.length) {
          data = data_user.get(elem);
          if (elem.nodeType === 1 && !data_priv.get(elem, "hasDataAttrs")) {
            i = attrs.length;
            while (i--) {
              if (attrs[i]) {
                name = attrs[i].name;
                if (name.indexOf("data-") === 0) {
                  name = jQuery.camelCase(name.slice(5));
                  dataAttr(elem, name, data[name]);
                }
              }
            }
            data_priv.set(elem, "hasDataAttrs", true);
          }
        }
        return data;
      }
      if (typeof key === "object") {
        return this.each(function() {
          data_user.set(this, key);
        });
      }
      return access(this, function(value) {
        var data,
            camelKey = jQuery.camelCase(key);
        if (elem && value === undefined) {
          data = data_user.get(elem, key);
          if (data !== undefined) {
            return data;
          }
          data = data_user.get(elem, camelKey);
          if (data !== undefined) {
            return data;
          }
          data = dataAttr(elem, camelKey, undefined);
          if (data !== undefined) {
            return data;
          }
          return;
        }
        this.each(function() {
          var data = data_user.get(this, camelKey);
          data_user.set(this, camelKey, value);
          if (key.indexOf("-") !== -1 && data !== undefined) {
            data_user.set(this, key, value);
          }
        });
      }, null, value, arguments.length > 1, null, true);
    },
    removeData: function(key) {
      return this.each(function() {
        data_user.remove(this, key);
      });
    }
  });
  jQuery.extend({
    queue: function(elem, type, data) {
      var queue;
      if (elem) {
        type = (type || "fx") + "queue";
        queue = data_priv.get(elem, type);
        if (data) {
          if (!queue || jQuery.isArray(data)) {
            queue = data_priv.access(elem, type, jQuery.makeArray(data));
          } else {
            queue.push(data);
          }
        }
        return queue || [];
      }
    },
    dequeue: function(elem, type) {
      type = type || "fx";
      var queue = jQuery.queue(elem, type),
          startLength = queue.length,
          fn = queue.shift(),
          hooks = jQuery._queueHooks(elem, type),
          next = function() {
            jQuery.dequeue(elem, type);
          };
      if (fn === "inprogress") {
        fn = queue.shift();
        startLength--;
      }
      if (fn) {
        if (type === "fx") {
          queue.unshift("inprogress");
        }
        delete hooks.stop;
        fn.call(elem, next, hooks);
      }
      if (!startLength && hooks) {
        hooks.empty.fire();
      }
    },
    _queueHooks: function(elem, type) {
      var key = type + "queueHooks";
      return data_priv.get(elem, key) || data_priv.access(elem, key, {empty: jQuery.Callbacks("once memory").add(function() {
          data_priv.remove(elem, [type + "queue", key]);
        })});
    }
  });
  jQuery.fn.extend({
    queue: function(type, data) {
      var setter = 2;
      if (typeof type !== "string") {
        data = type;
        type = "fx";
        setter--;
      }
      if (arguments.length < setter) {
        return jQuery.queue(this[0], type);
      }
      return data === undefined ? this : this.each(function() {
        var queue = jQuery.queue(this, type, data);
        jQuery._queueHooks(this, type);
        if (type === "fx" && queue[0] !== "inprogress") {
          jQuery.dequeue(this, type);
        }
      });
    },
    dequeue: function(type) {
      return this.each(function() {
        jQuery.dequeue(this, type);
      });
    },
    clearQueue: function(type) {
      return this.queue(type || "fx", []);
    },
    promise: function(type, obj) {
      var tmp,
          count = 1,
          defer = jQuery.Deferred(),
          elements = this,
          i = this.length,
          resolve = function() {
            if (!(--count)) {
              defer.resolveWith(elements, [elements]);
            }
          };
      if (typeof type !== "string") {
        obj = type;
        type = undefined;
      }
      type = type || "fx";
      while (i--) {
        tmp = data_priv.get(elements[i], type + "queueHooks");
        if (tmp && tmp.empty) {
          count++;
          tmp.empty.add(resolve);
        }
      }
      resolve();
      return defer.promise(obj);
    }
  });
  var pnum = (/[+-]?(?:\d*\.|)\d+(?:[eE][+-]?\d+|)/).source;
  var cssExpand = ["Top", "Right", "Bottom", "Left"];
  var isHidden = function(elem, el) {
    elem = el || elem;
    return jQuery.css(elem, "display") === "none" || !jQuery.contains(elem.ownerDocument, elem);
  };
  var rcheckableType = (/^(?:checkbox|radio)$/i);
  (function() {
    var fragment = document.createDocumentFragment(),
        div = fragment.appendChild(document.createElement("div")),
        input = document.createElement("input");
    input.setAttribute("type", "radio");
    input.setAttribute("checked", "checked");
    input.setAttribute("name", "t");
    div.appendChild(input);
    support.checkClone = div.cloneNode(true).cloneNode(true).lastChild.checked;
    div.innerHTML = "<textarea>x</textarea>";
    support.noCloneChecked = !!div.cloneNode(true).lastChild.defaultValue;
  })();
  var strundefined = typeof undefined;
  support.focusinBubbles = "onfocusin" in window;
  var rkeyEvent = /^key/,
      rmouseEvent = /^(?:mouse|pointer|contextmenu)|click/,
      rfocusMorph = /^(?:focusinfocus|focusoutblur)$/,
      rtypenamespace = /^([^.]*)(?:\.(.+)|)$/;
  function returnTrue() {
    return true;
  }
  function returnFalse() {
    return false;
  }
  function safeActiveElement() {
    try {
      return document.activeElement;
    } catch (err) {}
  }
  jQuery.event = {
    global: {},
    add: function(elem, types, handler, data, selector) {
      var handleObjIn,
          eventHandle,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.get(elem);
      if (!elemData) {
        return;
      }
      if (handler.handler) {
        handleObjIn = handler;
        handler = handleObjIn.handler;
        selector = handleObjIn.selector;
      }
      if (!handler.guid) {
        handler.guid = jQuery.guid++;
      }
      if (!(events = elemData.events)) {
        events = elemData.events = {};
      }
      if (!(eventHandle = elemData.handle)) {
        eventHandle = elemData.handle = function(e) {
          return typeof jQuery !== strundefined && jQuery.event.triggered !== e.type ? jQuery.event.dispatch.apply(elem, arguments) : undefined;
        };
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        special = jQuery.event.special[type] || {};
        handleObj = jQuery.extend({
          type: type,
          origType: origType,
          data: data,
          handler: handler,
          guid: handler.guid,
          selector: selector,
          needsContext: selector && jQuery.expr.match.needsContext.test(selector),
          namespace: namespaces.join(".")
        }, handleObjIn);
        if (!(handlers = events[type])) {
          handlers = events[type] = [];
          handlers.delegateCount = 0;
          if (!special.setup || special.setup.call(elem, data, namespaces, eventHandle) === false) {
            if (elem.addEventListener) {
              elem.addEventListener(type, eventHandle, false);
            }
          }
        }
        if (special.add) {
          special.add.call(elem, handleObj);
          if (!handleObj.handler.guid) {
            handleObj.handler.guid = handler.guid;
          }
        }
        if (selector) {
          handlers.splice(handlers.delegateCount++, 0, handleObj);
        } else {
          handlers.push(handleObj);
        }
        jQuery.event.global[type] = true;
      }
    },
    remove: function(elem, types, handler, selector, mappedTypes) {
      var j,
          origCount,
          tmp,
          events,
          t,
          handleObj,
          special,
          handlers,
          type,
          namespaces,
          origType,
          elemData = data_priv.hasData(elem) && data_priv.get(elem);
      if (!elemData || !(events = elemData.events)) {
        return;
      }
      types = (types || "").match(rnotwhite) || [""];
      t = types.length;
      while (t--) {
        tmp = rtypenamespace.exec(types[t]) || [];
        type = origType = tmp[1];
        namespaces = (tmp[2] || "").split(".").sort();
        if (!type) {
          for (type in events) {
            jQuery.event.remove(elem, type + types[t], handler, selector, true);
          }
          continue;
        }
        special = jQuery.event.special[type] || {};
        type = (selector ? special.delegateType : special.bindType) || type;
        handlers = events[type] || [];
        tmp = tmp[2] && new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)");
        origCount = j = handlers.length;
        while (j--) {
          handleObj = handlers[j];
          if ((mappedTypes || origType === handleObj.origType) && (!handler || handler.guid === handleObj.guid) && (!tmp || tmp.test(handleObj.namespace)) && (!selector || selector === handleObj.selector || selector === "**" && handleObj.selector)) {
            handlers.splice(j, 1);
            if (handleObj.selector) {
              handlers.delegateCount--;
            }
            if (special.remove) {
              special.remove.call(elem, handleObj);
            }
          }
        }
        if (origCount && !handlers.length) {
          if (!special.teardown || special.teardown.call(elem, namespaces, elemData.handle) === false) {
            jQuery.removeEvent(elem, type, elemData.handle);
          }
          delete events[type];
        }
      }
      if (jQuery.isEmptyObject(events)) {
        delete elemData.handle;
        data_priv.remove(elem, "events");
      }
    },
    trigger: function(event, data, elem, onlyHandlers) {
      var i,
          cur,
          tmp,
          bubbleType,
          ontype,
          handle,
          special,
          eventPath = [elem || document],
          type = hasOwn.call(event, "type") ? event.type : event,
          namespaces = hasOwn.call(event, "namespace") ? event.namespace.split(".") : [];
      cur = tmp = elem = elem || document;
      if (elem.nodeType === 3 || elem.nodeType === 8) {
        return;
      }
      if (rfocusMorph.test(type + jQuery.event.triggered)) {
        return;
      }
      if (type.indexOf(".") >= 0) {
        namespaces = type.split(".");
        type = namespaces.shift();
        namespaces.sort();
      }
      ontype = type.indexOf(":") < 0 && "on" + type;
      event = event[jQuery.expando] ? event : new jQuery.Event(type, typeof event === "object" && event);
      event.isTrigger = onlyHandlers ? 2 : 3;
      event.namespace = namespaces.join(".");
      event.namespace_re = event.namespace ? new RegExp("(^|\\.)" + namespaces.join("\\.(?:.*\\.|)") + "(\\.|$)") : null;
      event.result = undefined;
      if (!event.target) {
        event.target = elem;
      }
      data = data == null ? [event] : jQuery.makeArray(data, [event]);
      special = jQuery.event.special[type] || {};
      if (!onlyHandlers && special.trigger && special.trigger.apply(elem, data) === false) {
        return;
      }
      if (!onlyHandlers && !special.noBubble && !jQuery.isWindow(elem)) {
        bubbleType = special.delegateType || type;
        if (!rfocusMorph.test(bubbleType + type)) {
          cur = cur.parentNode;
        }
        for (; cur; cur = cur.parentNode) {
          eventPath.push(cur);
          tmp = cur;
        }
        if (tmp === (elem.ownerDocument || document)) {
          eventPath.push(tmp.defaultView || tmp.parentWindow || window);
        }
      }
      i = 0;
      while ((cur = eventPath[i++]) && !event.isPropagationStopped()) {
        event.type = i > 1 ? bubbleType : special.bindType || type;
        handle = (data_priv.get(cur, "events") || {})[event.type] && data_priv.get(cur, "handle");
        if (handle) {
          handle.apply(cur, data);
        }
        handle = ontype && cur[ontype];
        if (handle && handle.apply && jQuery.acceptData(cur)) {
          event.result = handle.apply(cur, data);
          if (event.result === false) {
            event.preventDefault();
          }
        }
      }
      event.type = type;
      if (!onlyHandlers && !event.isDefaultPrevented()) {
        if ((!special._default || special._default.apply(eventPath.pop(), data) === false) && jQuery.acceptData(elem)) {
          if (ontype && jQuery.isFunction(elem[type]) && !jQuery.isWindow(elem)) {
            tmp = elem[ontype];
            if (tmp) {
              elem[ontype] = null;
            }
            jQuery.event.triggered = type;
            elem[type]();
            jQuery.event.triggered = undefined;
            if (tmp) {
              elem[ontype] = tmp;
            }
          }
        }
      }
      return event.result;
    },
    dispatch: function(event) {
      event = jQuery.event.fix(event);
      var i,
          j,
          ret,
          matched,
          handleObj,
          handlerQueue = [],
          args = slice.call(arguments),
          handlers = (data_priv.get(this, "events") || {})[event.type] || [],
          special = jQuery.event.special[event.type] || {};
      args[0] = event;
      event.delegateTarget = this;
      if (special.preDispatch && special.preDispatch.call(this, event) === false) {
        return;
      }
      handlerQueue = jQuery.event.handlers.call(this, event, handlers);
      i = 0;
      while ((matched = handlerQueue[i++]) && !event.isPropagationStopped()) {
        event.currentTarget = matched.elem;
        j = 0;
        while ((handleObj = matched.handlers[j++]) && !event.isImmediatePropagationStopped()) {
          if (!event.namespace_re || event.namespace_re.test(handleObj.namespace)) {
            event.handleObj = handleObj;
            event.data = handleObj.data;
            ret = ((jQuery.event.special[handleObj.origType] || {}).handle || handleObj.handler).apply(matched.elem, args);
            if (ret !== undefined) {
              if ((event.result = ret) === false) {
                event.preventDefault();
                event.stopPropagation();
              }
            }
          }
        }
      }
      if (special.postDispatch) {
        special.postDispatch.call(this, event);
      }
      return event.result;
    },
    handlers: function(event, handlers) {
      var i,
          matches,
          sel,
          handleObj,
          handlerQueue = [],
          delegateCount = handlers.delegateCount,
          cur = event.target;
      if (delegateCount && cur.nodeType && (!event.button || event.type !== "click")) {
        for (; cur !== this; cur = cur.parentNode || this) {
          if (cur.disabled !== true || event.type !== "click") {
            matches = [];
            for (i = 0; i < delegateCount; i++) {
              handleObj = handlers[i];
              sel = handleObj.selector + " ";
              if (matches[sel] === undefined) {
                matches[sel] = handleObj.needsContext ? jQuery(sel, this).index(cur) >= 0 : jQuery.find(sel, this, null, [cur]).length;
              }
              if (matches[sel]) {
                matches.push(handleObj);
              }
            }
            if (matches.length) {
              handlerQueue.push({
                elem: cur,
                handlers: matches
              });
            }
          }
        }
      }
      if (delegateCount < handlers.length) {
        handlerQueue.push({
          elem: this,
          handlers: handlers.slice(delegateCount)
        });
      }
      return handlerQueue;
    },
    props: "altKey bubbles cancelable ctrlKey currentTarget eventPhase metaKey relatedTarget shiftKey target timeStamp view which".split(" "),
    fixHooks: {},
    keyHooks: {
      props: "char charCode key keyCode".split(" "),
      filter: function(event, original) {
        if (event.which == null) {
          event.which = original.charCode != null ? original.charCode : original.keyCode;
        }
        return event;
      }
    },
    mouseHooks: {
      props: "button buttons clientX clientY offsetX offsetY pageX pageY screenX screenY toElement".split(" "),
      filter: function(event, original) {
        var eventDoc,
            doc,
            body,
            button = original.button;
        if (event.pageX == null && original.clientX != null) {
          eventDoc = event.target.ownerDocument || document;
          doc = eventDoc.documentElement;
          body = eventDoc.body;
          event.pageX = original.clientX + (doc && doc.scrollLeft || body && body.scrollLeft || 0) - (doc && doc.clientLeft || body && body.clientLeft || 0);
          event.pageY = original.clientY + (doc && doc.scrollTop || body && body.scrollTop || 0) - (doc && doc.clientTop || body && body.clientTop || 0);
        }
        if (!event.which && button !== undefined) {
          event.which = (button & 1 ? 1 : (button & 2 ? 3 : (button & 4 ? 2 : 0)));
        }
        return event;
      }
    },
    fix: function(event) {
      if (event[jQuery.expando]) {
        return event;
      }
      var i,
          prop,
          copy,
          type = event.type,
          originalEvent = event,
          fixHook = this.fixHooks[type];
      if (!fixHook) {
        this.fixHooks[type] = fixHook = rmouseEvent.test(type) ? this.mouseHooks : rkeyEvent.test(type) ? this.keyHooks : {};
      }
      copy = fixHook.props ? this.props.concat(fixHook.props) : this.props;
      event = new jQuery.Event(originalEvent);
      i = copy.length;
      while (i--) {
        prop = copy[i];
        event[prop] = originalEvent[prop];
      }
      if (!event.target) {
        event.target = document;
      }
      if (event.target.nodeType === 3) {
        event.target = event.target.parentNode;
      }
      return fixHook.filter ? fixHook.filter(event, originalEvent) : event;
    },
    special: {
      load: {noBubble: true},
      focus: {
        trigger: function() {
          if (this !== safeActiveElement() && this.focus) {
            this.focus();
            return false;
          }
        },
        delegateType: "focusin"
      },
      blur: {
        trigger: function() {
          if (this === safeActiveElement() && this.blur) {
            this.blur();
            return false;
          }
        },
        delegateType: "focusout"
      },
      click: {
        trigger: function() {
          if (this.type === "checkbox" && this.click && jQuery.nodeName(this, "input")) {
            this.click();
            return false;
          }
        },
        _default: function(event) {
          return jQuery.nodeName(event.target, "a");
        }
      },
      beforeunload: {postDispatch: function(event) {
          if (event.result !== undefined && event.originalEvent) {
            event.originalEvent.returnValue = event.result;
          }
        }}
    },
    simulate: function(type, elem, event, bubble) {
      var e = jQuery.extend(new jQuery.Event(), event, {
        type: type,
        isSimulated: true,
        originalEvent: {}
      });
      if (bubble) {
        jQuery.event.trigger(e, null, elem);
      } else {
        jQuery.event.dispatch.call(elem, e);
      }
      if (e.isDefaultPrevented()) {
        event.preventDefault();
      }
    }
  };
  jQuery.removeEvent = function(elem, type, handle) {
    if (elem.removeEventListener) {
      elem.removeEventListener(type, handle, false);
    }
  };
  jQuery.Event = function(src, props) {
    if (!(this instanceof jQuery.Event)) {
      return new jQuery.Event(src, props);
    }
    if (src && src.type) {
      this.originalEvent = src;
      this.type = src.type;
      this.isDefaultPrevented = src.defaultPrevented || src.defaultPrevented === undefined && src.returnValue === false ? returnTrue : returnFalse;
    } else {
      this.type = src;
    }
    if (props) {
      jQuery.extend(this, props);
    }
    this.timeStamp = src && src.timeStamp || jQuery.now();
    this[jQuery.expando] = true;
  };
  jQuery.Event.prototype = {
    isDefaultPrevented: returnFalse,
    isPropagationStopped: returnFalse,
    isImmediatePropagationStopped: returnFalse,
    preventDefault: function() {
      var e = this.originalEvent;
      this.isDefaultPrevented = returnTrue;
      if (e && e.preventDefault) {
        e.preventDefault();
      }
    },
    stopPropagation: function() {
      var e = this.originalEvent;
      this.isPropagationStopped = returnTrue;
      if (e && e.stopPropagation) {
        e.stopPropagation();
      }
    },
    stopImmediatePropagation: function() {
      var e = this.originalEvent;
      this.isImmediatePropagationStopped = returnTrue;
      if (e && e.stopImmediatePropagation) {
        e.stopImmediatePropagation();
      }
      this.stopPropagation();
    }
  };
  jQuery.each({
    mouseenter: "mouseover",
    mouseleave: "mouseout",
    pointerenter: "pointerover",
    pointerleave: "pointerout"
  }, function(orig, fix) {
    jQuery.event.special[orig] = {
      delegateType: fix,
      bindType: fix,
      handle: function(event) {
        var ret,
            target = this,
            related = event.relatedTarget,
            handleObj = event.handleObj;
        if (!related || (related !== target && !jQuery.contains(target, related))) {
          event.type = handleObj.origType;
          ret = handleObj.handler.apply(this, arguments);
          event.type = fix;
        }
        return ret;
      }
    };
  });
  if (!support.focusinBubbles) {
    jQuery.each({
      focus: "focusin",
      blur: "focusout"
    }, function(orig, fix) {
      var handler = function(event) {
        jQuery.event.simulate(fix, event.target, jQuery.event.fix(event), true);
      };
      jQuery.event.special[fix] = {
        setup: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix);
          if (!attaches) {
            doc.addEventListener(orig, handler, true);
          }
          data_priv.access(doc, fix, (attaches || 0) + 1);
        },
        teardown: function() {
          var doc = this.ownerDocument || this,
              attaches = data_priv.access(doc, fix) - 1;
          if (!attaches) {
            doc.removeEventListener(orig, handler, true);
            data_priv.remove(doc, fix);
          } else {
            data_priv.access(doc, fix, attaches);
          }
        }
      };
    });
  }
  jQuery.fn.extend({
    on: function(types, selector, data, fn, one) {
      var origFn,
          type;
      if (typeof types === "object") {
        if (typeof selector !== "string") {
          data = data || selector;
          selector = undefined;
        }
        for (type in types) {
          this.on(type, selector, data, types[type], one);
        }
        return this;
      }
      if (data == null && fn == null) {
        fn = selector;
        data = selector = undefined;
      } else if (fn == null) {
        if (typeof selector === "string") {
          fn = data;
          data = undefined;
        } else {
          fn = data;
          data = selector;
          selector = undefined;
        }
      }
      if (fn === false) {
        fn = returnFalse;
      } else if (!fn) {
        return this;
      }
      if (one === 1) {
        origFn = fn;
        fn = function(event) {
          jQuery().off(event);
          return origFn.apply(this, arguments);
        };
        fn.guid = origFn.guid || (origFn.guid = jQuery.guid++);
      }
      return this.each(function() {
        jQuery.event.add(this, types, fn, data, selector);
      });
    },
    one: function(types, selector, data, fn) {
      return this.on(types, selector, data, fn, 1);
    },
    off: function(types, selector, fn) {
      var handleObj,
          type;
      if (types && types.preventDefault && types.handleObj) {
        handleObj = types.handleObj;
        jQuery(types.delegateTarget).off(handleObj.namespace ? handleObj.origType + "." + handleObj.namespace : handleObj.origType, handleObj.selector, handleObj.handler);
        return this;
      }
      if (typeof types === "object") {
        for (type in types) {
          this.off(type, selector, types[type]);
        }
        return this;
      }
      if (selector === false || typeof selector === "function") {
        fn = selector;
        selector = undefined;
      }
      if (fn === false) {
        fn = returnFalse;
      }
      return this.each(function() {
        jQuery.event.remove(this, types, fn, selector);
      });
    },
    trigger: function(type, data) {
      return this.each(function() {
        jQuery.event.trigger(type, data, this);
      });
    },
    triggerHandler: function(type, data) {
      var elem = this[0];
      if (elem) {
        return jQuery.event.trigger(type, data, elem, true);
      }
    }
  });
  var rxhtmlTag = /<(?!area|br|col|embed|hr|img|input|link|meta|param)(([\w:]+)[^>]*)\/>/gi,
      rtagName = /<([\w:]+)/,
      rhtml = /<|&#?\w+;/,
      rnoInnerhtml = /<(?:script|style|link)/i,
      rchecked = /checked\s*(?:[^=]|=\s*.checked.)/i,
      rscriptType = /^$|\/(?:java|ecma)script/i,
      rscriptTypeMasked = /^true\/(.*)/,
      rcleanScript = /^\s*<!(?:\[CDATA\[|--)|(?:\]\]|--)>\s*$/g,
      wrapMap = {
        option: [1, "<select multiple='multiple'>", "</select>"],
        thead: [1, "<table>", "</table>"],
        col: [2, "<table><colgroup>", "</colgroup></table>"],
        tr: [2, "<table><tbody>", "</tbody></table>"],
        td: [3, "<table><tbody><tr>", "</tr></tbody></table>"],
        _default: [0, "", ""]
      };
  wrapMap.optgroup = wrapMap.option;
  wrapMap.tbody = wrapMap.tfoot = wrapMap.colgroup = wrapMap.caption = wrapMap.thead;
  wrapMap.th = wrapMap.td;
  function manipulationTarget(elem, content) {
    return jQuery.nodeName(elem, "table") && jQuery.nodeName(content.nodeType !== 11 ? content : content.firstChild, "tr") ? elem.getElementsByTagName("tbody")[0] || elem.appendChild(elem.ownerDocument.createElement("tbody")) : elem;
  }
  function disableScript(elem) {
    elem.type = (elem.getAttribute("type") !== null) + "/" + elem.type;
    return elem;
  }
  function restoreScript(elem) {
    var match = rscriptTypeMasked.exec(elem.type);
    if (match) {
      elem.type = match[1];
    } else {
      elem.removeAttribute("type");
    }
    return elem;
  }
  function setGlobalEval(elems, refElements) {
    var i = 0,
        l = elems.length;
    for (; i < l; i++) {
      data_priv.set(elems[i], "globalEval", !refElements || data_priv.get(refElements[i], "globalEval"));
    }
  }
  function cloneCopyEvent(src, dest) {
    var i,
        l,
        type,
        pdataOld,
        pdataCur,
        udataOld,
        udataCur,
        events;
    if (dest.nodeType !== 1) {
      return;
    }
    if (data_priv.hasData(src)) {
      pdataOld = data_priv.access(src);
      pdataCur = data_priv.set(dest, pdataOld);
      events = pdataOld.events;
      if (events) {
        delete pdataCur.handle;
        pdataCur.events = {};
        for (type in events) {
          for (i = 0, l = events[type].length; i < l; i++) {
            jQuery.event.add(dest, type, events[type][i]);
          }
        }
      }
    }
    if (data_user.hasData(src)) {
      udataOld = data_user.access(src);
      udataCur = jQuery.extend({}, udataOld);
      data_user.set(dest, udataCur);
    }
  }
  function getAll(context, tag) {
    var ret = context.getElementsByTagName ? context.getElementsByTagName(tag || "*") : context.querySelectorAll ? context.querySelectorAll(tag || "*") : [];
    return tag === undefined || tag && jQuery.nodeName(context, tag) ? jQuery.merge([context], ret) : ret;
  }
  function fixInput(src, dest) {
    var nodeName = dest.nodeName.toLowerCase();
    if (nodeName === "input" && rcheckableType.test(src.type)) {
      dest.checked = src.checked;
    } else if (nodeName === "input" || nodeName === "textarea") {
      dest.defaultValue = src.defaultValue;
    }
  }
  jQuery.extend({
    clone: function(elem, dataAndEvents, deepDataAndEvents) {
      var i,
          l,
          srcElements,
          destElements,
          clone = elem.cloneNode(true),
          inPage = jQuery.contains(elem.ownerDocument, elem);
      if (!support.noCloneChecked && (elem.nodeType === 1 || elem.nodeType === 11) && !jQuery.isXMLDoc(elem)) {
        destElements = getAll(clone);
        srcElements = getAll(elem);
        for (i = 0, l = srcElements.length; i < l; i++) {
          fixInput(srcElements[i], destElements[i]);
        }
      }
      if (dataAndEvents) {
        if (deepDataAndEvents) {
          srcElements = srcElements || getAll(elem);
          destElements = destElements || getAll(clone);
          for (i = 0, l = srcElements.length; i < l; i++) {
            cloneCopyEvent(srcElements[i], destElements[i]);
          }
        } else {
          cloneCopyEvent(elem, clone);
        }
      }
      destElements = getAll(clone, "script");
      if (destElements.length > 0) {
        setGlobalEval(destElements, !inPage && getAll(elem, "script"));
      }
      return clone;
    },
    buildFragment: function(elems, context, scripts, selection) {
      var elem,
          tmp,
          tag,
          wrap,
          contains,
          j,
          fragment = context.createDocumentFragment(),
          nodes = [],
          i = 0,
          l = elems.length;
      for (; i < l; i++) {
        elem = elems[i];
        if (elem || elem === 0) {
          if (jQuery.type(elem) === "object") {
            jQuery.merge(nodes, elem.nodeType ? [elem] : elem);
          } else if (!rhtml.test(elem)) {
            nodes.push(context.createTextNode(elem));
          } else {
            tmp = tmp || fragment.appendChild(context.createElement("div"));
            tag = (rtagName.exec(elem) || ["", ""])[1].toLowerCase();
            wrap = wrapMap[tag] || wrapMap._default;
            tmp.innerHTML = wrap[1] + elem.replace(rxhtmlTag, "<$1></$2>") + wrap[2];
            j = wrap[0];
            while (j--) {
              tmp = tmp.lastChild;
            }
            jQuery.merge(nodes, tmp.childNodes);
            tmp = fragment.firstChild;
            tmp.textContent = "";
          }
        }
      }
      fragment.textContent = "";
      i = 0;
      while ((elem = nodes[i++])) {
        if (selection && jQuery.inArray(elem, selection) !== -1) {
          continue;
        }
        contains = jQuery.contains(elem.ownerDocument, elem);
        tmp = getAll(fragment.appendChild(elem), "script");
        if (contains) {
          setGlobalEval(tmp);
        }
        if (scripts) {
          j = 0;
          while ((elem = tmp[j++])) {
            if (rscriptType.test(elem.type || "")) {
              scripts.push(elem);
            }
          }
        }
      }
      return fragment;
    },
    cleanData: function(elems) {
      var data,
          elem,
          type,
          key,
          special = jQuery.event.special,
          i = 0;
      for (; (elem = elems[i]) !== undefined; i++) {
        if (jQuery.acceptData(elem)) {
          key = elem[data_priv.expando];
          if (key && (data = data_priv.cache[key])) {
            if (data.events) {
              for (type in data.events) {
                if (special[type]) {
                  jQuery.event.remove(elem, type);
                } else {
                  jQuery.removeEvent(elem, type, data.handle);
                }
              }
            }
            if (data_priv.cache[key]) {
              delete data_priv.cache[key];
            }
          }
        }
        delete data_user.cache[elem[data_user.expando]];
      }
    }
  });
  jQuery.fn.extend({
    text: function(value) {
      return access(this, function(value) {
        return value === undefined ? jQuery.text(this) : this.empty().each(function() {
          if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
            this.textContent = value;
          }
        });
      }, null, value, arguments.length);
    },
    append: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.appendChild(elem);
        }
      });
    },
    prepend: function() {
      return this.domManip(arguments, function(elem) {
        if (this.nodeType === 1 || this.nodeType === 11 || this.nodeType === 9) {
          var target = manipulationTarget(this, elem);
          target.insertBefore(elem, target.firstChild);
        }
      });
    },
    before: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this);
        }
      });
    },
    after: function() {
      return this.domManip(arguments, function(elem) {
        if (this.parentNode) {
          this.parentNode.insertBefore(elem, this.nextSibling);
        }
      });
    },
    remove: function(selector, keepData) {
      var elem,
          elems = selector ? jQuery.filter(selector, this) : this,
          i = 0;
      for (; (elem = elems[i]) != null; i++) {
        if (!keepData && elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem));
        }
        if (elem.parentNode) {
          if (keepData && jQuery.contains(elem.ownerDocument, elem)) {
            setGlobalEval(getAll(elem, "script"));
          }
          elem.parentNode.removeChild(elem);
        }
      }
      return this;
    },
    empty: function() {
      var elem,
          i = 0;
      for (; (elem = this[i]) != null; i++) {
        if (elem.nodeType === 1) {
          jQuery.cleanData(getAll(elem, false));
          elem.textContent = "";
        }
      }
      return this;
    },
    clone: function(dataAndEvents, deepDataAndEvents) {
      dataAndEvents = dataAndEvents == null ? false : dataAndEvents;
      deepDataAndEvents = deepDataAndEvents == null ? dataAndEvents : deepDataAndEvents;
      return this.map(function() {
        return jQuery.clone(this, dataAndEvents, deepDataAndEvents);
      });
    },
    html: function(value) {
      return access(this, function(value) {
        var elem = this[0] || {},
            i = 0,
            l = this.length;
        if (value === undefined && elem.nodeType === 1) {
          return elem.innerHTML;
        }
        if (typeof value === "string" && !rnoInnerhtml.test(value) && !wrapMap[(rtagName.exec(value) || ["", ""])[1].toLowerCase()]) {
          value = value.replace(rxhtmlTag, "<$1></$2>");
          try {
            for (; i < l; i++) {
              elem = this[i] || {};
              if (elem.nodeType === 1) {
                jQuery.cleanData(getAll(elem, false));
                elem.innerHTML = value;
              }
            }
            elem = 0;
          } catch (e) {}
        }
        if (elem) {
          this.empty().append(value);
        }
      }, null, value, arguments.length);
    },
    replaceWith: function() {
      var arg = arguments[0];
      this.domManip(arguments, function(elem) {
        arg = this.parentNode;
        jQuery.cleanData(getAll(this));
        if (arg) {
          arg.replaceChild(elem, this);
        }
      });
      return arg && (arg.length || arg.nodeType) ? this : this.remove();
    },
    detach: function(selector) {
      return this.remove(selector, true);
    },
    domManip: function(args, callback) {
      args = concat.apply([], args);
      var fragment,
          first,
          scripts,
          hasScripts,
          node,
          doc,
          i = 0,
          l = this.length,
          set = this,
          iNoClone = l - 1,
          value = args[0],
          isFunction = jQuery.isFunction(value);
      if (isFunction || (l > 1 && typeof value === "string" && !support.checkClone && rchecked.test(value))) {
        return this.each(function(index) {
          var self = set.eq(index);
          if (isFunction) {
            args[0] = value.call(this, index, self.html());
          }
          self.domManip(args, callback);
        });
      }
      if (l) {
        fragment = jQuery.buildFragment(args, this[0].ownerDocument, false, this);
        first = fragment.firstChild;
        if (fragment.childNodes.length === 1) {
          fragment = first;
        }
        if (first) {
          scripts = jQuery.map(getAll(fragment, "script"), disableScript);
          hasScripts = scripts.length;
          for (; i < l; i++) {
            node = fragment;
            if (i !== iNoClone) {
              node = jQuery.clone(node, true, true);
              if (hasScripts) {
                jQuery.merge(scripts, getAll(node, "script"));
              }
            }
            callback.call(this[i], node, i);
          }
          if (hasScripts) {
            doc = scripts[scripts.length - 1].ownerDocument;
            jQuery.map(scripts, restoreScript);
            for (i = 0; i < hasScripts; i++) {
              node = scripts[i];
              if (rscriptType.test(node.type || "") && !data_priv.access(node, "globalEval") && jQuery.contains(doc, node)) {
                if (node.src) {
                  if (jQuery._evalUrl) {
                    jQuery._evalUrl(node.src);
                  }
                } else {
                  jQuery.globalEval(node.textContent.replace(rcleanScript, ""));
                }
              }
            }
          }
        }
      }
      return this;
    }
  });
  jQuery.each({
    appendTo: "append",
    prependTo: "prepend",
    insertBefore: "before",
    insertAfter: "after",
    replaceAll: "replaceWith"
  }, function(name, original) {
    jQuery.fn[name] = function(selector) {
      var elems,
          ret = [],
          insert = jQuery(selector),
          last = insert.length - 1,
          i = 0;
      for (; i <= last; i++) {
        elems = i === last ? this : this.clone(true);
        jQuery(insert[i])[original](elems);
        push.apply(ret, elems.get());
      }
      return this.pushStack(ret);
    };
  });
  var iframe,
      elemdisplay = {};
  function actualDisplay(name, doc) {
    var style,
        elem = jQuery(doc.createElement(name)).appendTo(doc.body),
        display = window.getDefaultComputedStyle && (style = window.getDefaultComputedStyle(elem[0])) ? style.display : jQuery.css(elem[0], "display");
    elem.detach();
    return display;
  }
  function defaultDisplay(nodeName) {
    var doc = document,
        display = elemdisplay[nodeName];
    if (!display) {
      display = actualDisplay(nodeName, doc);
      if (display === "none" || !display) {
        iframe = (iframe || jQuery("<iframe frameborder='0' width='0' height='0'/>")).appendTo(doc.documentElement);
        doc = iframe[0].contentDocument;
        doc.write();
        doc.close();
        display = actualDisplay(nodeName, doc);
        iframe.detach();
      }
      elemdisplay[nodeName] = display;
    }
    return display;
  }
  var rmargin = (/^margin/);
  var rnumnonpx = new RegExp("^(" + pnum + ")(?!px)[a-z%]+$", "i");
  var getStyles = function(elem) {
    if (elem.ownerDocument.defaultView.opener) {
      return elem.ownerDocument.defaultView.getComputedStyle(elem, null);
    }
    return window.getComputedStyle(elem, null);
  };
  function curCSS(elem, name, computed) {
    var width,
        minWidth,
        maxWidth,
        ret,
        style = elem.style;
    computed = computed || getStyles(elem);
    if (computed) {
      ret = computed.getPropertyValue(name) || computed[name];
    }
    if (computed) {
      if (ret === "" && !jQuery.contains(elem.ownerDocument, elem)) {
        ret = jQuery.style(elem, name);
      }
      if (rnumnonpx.test(ret) && rmargin.test(name)) {
        width = style.width;
        minWidth = style.minWidth;
        maxWidth = style.maxWidth;
        style.minWidth = style.maxWidth = style.width = ret;
        ret = computed.width;
        style.width = width;
        style.minWidth = minWidth;
        style.maxWidth = maxWidth;
      }
    }
    return ret !== undefined ? ret + "" : ret;
  }
  function addGetHookIf(conditionFn, hookFn) {
    return {get: function() {
        if (conditionFn()) {
          delete this.get;
          return;
        }
        return (this.get = hookFn).apply(this, arguments);
      }};
  }
  (function() {
    var pixelPositionVal,
        boxSizingReliableVal,
        docElem = document.documentElement,
        container = document.createElement("div"),
        div = document.createElement("div");
    if (!div.style) {
      return;
    }
    div.style.backgroundClip = "content-box";
    div.cloneNode(true).style.backgroundClip = "";
    support.clearCloneStyle = div.style.backgroundClip === "content-box";
    container.style.cssText = "border:0;width:0;height:0;top:0;left:-9999px;margin-top:1px;" + "position:absolute";
    container.appendChild(div);
    function computePixelPositionAndBoxSizingReliable() {
      div.style.cssText = "-webkit-box-sizing:border-box;-moz-box-sizing:border-box;" + "box-sizing:border-box;display:block;margin-top:1%;top:1%;" + "border:1px;padding:1px;width:4px;position:absolute";
      div.innerHTML = "";
      docElem.appendChild(container);
      var divStyle = window.getComputedStyle(div, null);
      pixelPositionVal = divStyle.top !== "1%";
      boxSizingReliableVal = divStyle.width === "4px";
      docElem.removeChild(container);
    }
    if (window.getComputedStyle) {
      jQuery.extend(support, {
        pixelPosition: function() {
          computePixelPositionAndBoxSizingReliable();
          return pixelPositionVal;
        },
        boxSizingReliable: function() {
          if (boxSizingReliableVal == null) {
            computePixelPositionAndBoxSizingReliable();
          }
          return boxSizingReliableVal;
        },
        reliableMarginRight: function() {
          var ret,
              marginDiv = div.appendChild(document.createElement("div"));
          marginDiv.style.cssText = div.style.cssText = "-webkit-box-sizing:content-box;-moz-box-sizing:content-box;" + "box-sizing:content-box;display:block;margin:0;border:0;padding:0";
          marginDiv.style.marginRight = marginDiv.style.width = "0";
          div.style.width = "1px";
          docElem.appendChild(container);
          ret = !parseFloat(window.getComputedStyle(marginDiv, null).marginRight);
          docElem.removeChild(container);
          div.removeChild(marginDiv);
          return ret;
        }
      });
    }
  })();
  jQuery.swap = function(elem, options, callback, args) {
    var ret,
        name,
        old = {};
    for (name in options) {
      old[name] = elem.style[name];
      elem.style[name] = options[name];
    }
    ret = callback.apply(elem, args || []);
    for (name in options) {
      elem.style[name] = old[name];
    }
    return ret;
  };
  var rdisplayswap = /^(none|table(?!-c[ea]).+)/,
      rnumsplit = new RegExp("^(" + pnum + ")(.*)$", "i"),
      rrelNum = new RegExp("^([+-])=(" + pnum + ")", "i"),
      cssShow = {
        position: "absolute",
        visibility: "hidden",
        display: "block"
      },
      cssNormalTransform = {
        letterSpacing: "0",
        fontWeight: "400"
      },
      cssPrefixes = ["Webkit", "O", "Moz", "ms"];
  function vendorPropName(style, name) {
    if (name in style) {
      return name;
    }
    var capName = name[0].toUpperCase() + name.slice(1),
        origName = name,
        i = cssPrefixes.length;
    while (i--) {
      name = cssPrefixes[i] + capName;
      if (name in style) {
        return name;
      }
    }
    return origName;
  }
  function setPositiveNumber(elem, value, subtract) {
    var matches = rnumsplit.exec(value);
    return matches ? Math.max(0, matches[1] - (subtract || 0)) + (matches[2] || "px") : value;
  }
  function augmentWidthOrHeight(elem, name, extra, isBorderBox, styles) {
    var i = extra === (isBorderBox ? "border" : "content") ? 4 : name === "width" ? 1 : 0,
        val = 0;
    for (; i < 4; i += 2) {
      if (extra === "margin") {
        val += jQuery.css(elem, extra + cssExpand[i], true, styles);
      }
      if (isBorderBox) {
        if (extra === "content") {
          val -= jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        }
        if (extra !== "margin") {
          val -= jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      } else {
        val += jQuery.css(elem, "padding" + cssExpand[i], true, styles);
        if (extra !== "padding") {
          val += jQuery.css(elem, "border" + cssExpand[i] + "Width", true, styles);
        }
      }
    }
    return val;
  }
  function getWidthOrHeight(elem, name, extra) {
    var valueIsBorderBox = true,
        val = name === "width" ? elem.offsetWidth : elem.offsetHeight,
        styles = getStyles(elem),
        isBorderBox = jQuery.css(elem, "boxSizing", false, styles) === "border-box";
    if (val <= 0 || val == null) {
      val = curCSS(elem, name, styles);
      if (val < 0 || val == null) {
        val = elem.style[name];
      }
      if (rnumnonpx.test(val)) {
        return val;
      }
      valueIsBorderBox = isBorderBox && (support.boxSizingReliable() || val === elem.style[name]);
      val = parseFloat(val) || 0;
    }
    return (val + augmentWidthOrHeight(elem, name, extra || (isBorderBox ? "border" : "content"), valueIsBorderBox, styles)) + "px";
  }
  function showHide(elements, show) {
    var display,
        elem,
        hidden,
        values = [],
        index = 0,
        length = elements.length;
    for (; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      values[index] = data_priv.get(elem, "olddisplay");
      display = elem.style.display;
      if (show) {
        if (!values[index] && display === "none") {
          elem.style.display = "";
        }
        if (elem.style.display === "" && isHidden(elem)) {
          values[index] = data_priv.access(elem, "olddisplay", defaultDisplay(elem.nodeName));
        }
      } else {
        hidden = isHidden(elem);
        if (display !== "none" || !hidden) {
          data_priv.set(elem, "olddisplay", hidden ? display : jQuery.css(elem, "display"));
        }
      }
    }
    for (index = 0; index < length; index++) {
      elem = elements[index];
      if (!elem.style) {
        continue;
      }
      if (!show || elem.style.display === "none" || elem.style.display === "") {
        elem.style.display = show ? values[index] || "" : "none";
      }
    }
    return elements;
  }
  jQuery.extend({
    cssHooks: {opacity: {get: function(elem, computed) {
          if (computed) {
            var ret = curCSS(elem, "opacity");
            return ret === "" ? "1" : ret;
          }
        }}},
    cssNumber: {
      "columnCount": true,
      "fillOpacity": true,
      "flexGrow": true,
      "flexShrink": true,
      "fontWeight": true,
      "lineHeight": true,
      "opacity": true,
      "order": true,
      "orphans": true,
      "widows": true,
      "zIndex": true,
      "zoom": true
    },
    cssProps: {"float": "cssFloat"},
    style: function(elem, name, value, extra) {
      if (!elem || elem.nodeType === 3 || elem.nodeType === 8 || !elem.style) {
        return;
      }
      var ret,
          type,
          hooks,
          origName = jQuery.camelCase(name),
          style = elem.style;
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (value !== undefined) {
        type = typeof value;
        if (type === "string" && (ret = rrelNum.exec(value))) {
          value = (ret[1] + 1) * ret[2] + parseFloat(jQuery.css(elem, name));
          type = "number";
        }
        if (value == null || value !== value) {
          return;
        }
        if (type === "number" && !jQuery.cssNumber[origName]) {
          value += "px";
        }
        if (!support.clearCloneStyle && value === "" && name.indexOf("background") === 0) {
          style[name] = "inherit";
        }
        if (!hooks || !("set" in hooks) || (value = hooks.set(elem, value, extra)) !== undefined) {
          style[name] = value;
        }
      } else {
        if (hooks && "get" in hooks && (ret = hooks.get(elem, false, extra)) !== undefined) {
          return ret;
        }
        return style[name];
      }
    },
    css: function(elem, name, extra, styles) {
      var val,
          num,
          hooks,
          origName = jQuery.camelCase(name);
      name = jQuery.cssProps[origName] || (jQuery.cssProps[origName] = vendorPropName(elem.style, origName));
      hooks = jQuery.cssHooks[name] || jQuery.cssHooks[origName];
      if (hooks && "get" in hooks) {
        val = hooks.get(elem, true, extra);
      }
      if (val === undefined) {
        val = curCSS(elem, name, styles);
      }
      if (val === "normal" && name in cssNormalTransform) {
        val = cssNormalTransform[name];
      }
      if (extra === "" || extra) {
        num = parseFloat(val);
        return extra === true || jQuery.isNumeric(num) ? num || 0 : val;
      }
      return val;
    }
  });
  jQuery.each(["height", "width"], function(i, name) {
    jQuery.cssHooks[name] = {
      get: function(elem, computed, extra) {
        if (computed) {
          return rdisplayswap.test(jQuery.css(elem, "display")) && elem.offsetWidth === 0 ? jQuery.swap(elem, cssShow, function() {
            return getWidthOrHeight(elem, name, extra);
          }) : getWidthOrHeight(elem, name, extra);
        }
      },
      set: function(elem, value, extra) {
        var styles = extra && getStyles(elem);
        return setPositiveNumber(elem, value, extra ? augmentWidthOrHeight(elem, name, extra, jQuery.css(elem, "boxSizing", false, styles) === "border-box", styles) : 0);
      }
    };
  });
  jQuery.cssHooks.marginRight = addGetHookIf(support.reliableMarginRight, function(elem, computed) {
    if (computed) {
      return jQuery.swap(elem, {"display": "inline-block"}, curCSS, [elem, "marginRight"]);
    }
  });
  jQuery.each({
    margin: "",
    padding: "",
    border: "Width"
  }, function(prefix, suffix) {
    jQuery.cssHooks[prefix + suffix] = {expand: function(value) {
        var i = 0,
            expanded = {},
            parts = typeof value === "string" ? value.split(" ") : [value];
        for (; i < 4; i++) {
          expanded[prefix + cssExpand[i] + suffix] = parts[i] || parts[i - 2] || parts[0];
        }
        return expanded;
      }};
    if (!rmargin.test(prefix)) {
      jQuery.cssHooks[prefix + suffix].set = setPositiveNumber;
    }
  });
  jQuery.fn.extend({
    css: function(name, value) {
      return access(this, function(elem, name, value) {
        var styles,
            len,
            map = {},
            i = 0;
        if (jQuery.isArray(name)) {
          styles = getStyles(elem);
          len = name.length;
          for (; i < len; i++) {
            map[name[i]] = jQuery.css(elem, name[i], false, styles);
          }
          return map;
        }
        return value !== undefined ? jQuery.style(elem, name, value) : jQuery.css(elem, name);
      }, name, value, arguments.length > 1);
    },
    show: function() {
      return showHide(this, true);
    },
    hide: function() {
      return showHide(this);
    },
    toggle: function(state) {
      if (typeof state === "boolean") {
        return state ? this.show() : this.hide();
      }
      return this.each(function() {
        if (isHidden(this)) {
          jQuery(this).show();
        } else {
          jQuery(this).hide();
        }
      });
    }
  });
  function Tween(elem, options, prop, end, easing) {
    return new Tween.prototype.init(elem, options, prop, end, easing);
  }
  jQuery.Tween = Tween;
  Tween.prototype = {
    constructor: Tween,
    init: function(elem, options, prop, end, easing, unit) {
      this.elem = elem;
      this.prop = prop;
      this.easing = easing || "swing";
      this.options = options;
      this.start = this.now = this.cur();
      this.end = end;
      this.unit = unit || (jQuery.cssNumber[prop] ? "" : "px");
    },
    cur: function() {
      var hooks = Tween.propHooks[this.prop];
      return hooks && hooks.get ? hooks.get(this) : Tween.propHooks._default.get(this);
    },
    run: function(percent) {
      var eased,
          hooks = Tween.propHooks[this.prop];
      if (this.options.duration) {
        this.pos = eased = jQuery.easing[this.easing](percent, this.options.duration * percent, 0, 1, this.options.duration);
      } else {
        this.pos = eased = percent;
      }
      this.now = (this.end - this.start) * eased + this.start;
      if (this.options.step) {
        this.options.step.call(this.elem, this.now, this);
      }
      if (hooks && hooks.set) {
        hooks.set(this);
      } else {
        Tween.propHooks._default.set(this);
      }
      return this;
    }
  };
  Tween.prototype.init.prototype = Tween.prototype;
  Tween.propHooks = {_default: {
      get: function(tween) {
        var result;
        if (tween.elem[tween.prop] != null && (!tween.elem.style || tween.elem.style[tween.prop] == null)) {
          return tween.elem[tween.prop];
        }
        result = jQuery.css(tween.elem, tween.prop, "");
        return !result || result === "auto" ? 0 : result;
      },
      set: function(tween) {
        if (jQuery.fx.step[tween.prop]) {
          jQuery.fx.step[tween.prop](tween);
        } else if (tween.elem.style && (tween.elem.style[jQuery.cssProps[tween.prop]] != null || jQuery.cssHooks[tween.prop])) {
          jQuery.style(tween.elem, tween.prop, tween.now + tween.unit);
        } else {
          tween.elem[tween.prop] = tween.now;
        }
      }
    }};
  Tween.propHooks.scrollTop = Tween.propHooks.scrollLeft = {set: function(tween) {
      if (tween.elem.nodeType && tween.elem.parentNode) {
        tween.elem[tween.prop] = tween.now;
      }
    }};
  jQuery.easing = {
    linear: function(p) {
      return p;
    },
    swing: function(p) {
      return 0.5 - Math.cos(p * Math.PI) / 2;
    }
  };
  jQuery.fx = Tween.prototype.init;
  jQuery.fx.step = {};
  var fxNow,
      timerId,
      rfxtypes = /^(?:toggle|show|hide)$/,
      rfxnum = new RegExp("^(?:([+-])=|)(" + pnum + ")([a-z%]*)$", "i"),
      rrun = /queueHooks$/,
      animationPrefilters = [defaultPrefilter],
      tweeners = {"*": [function(prop, value) {
          var tween = this.createTween(prop, value),
              target = tween.cur(),
              parts = rfxnum.exec(value),
              unit = parts && parts[3] || (jQuery.cssNumber[prop] ? "" : "px"),
              start = (jQuery.cssNumber[prop] || unit !== "px" && +target) && rfxnum.exec(jQuery.css(tween.elem, prop)),
              scale = 1,
              maxIterations = 20;
          if (start && start[3] !== unit) {
            unit = unit || start[3];
            parts = parts || [];
            start = +target || 1;
            do {
              scale = scale || ".5";
              start = start / scale;
              jQuery.style(tween.elem, prop, start + unit);
            } while (scale !== (scale = tween.cur() / target) && scale !== 1 && --maxIterations);
          }
          if (parts) {
            start = tween.start = +start || +target || 0;
            tween.unit = unit;
            tween.end = parts[1] ? start + (parts[1] + 1) * parts[2] : +parts[2];
          }
          return tween;
        }]};
  function createFxNow() {
    setTimeout(function() {
      fxNow = undefined;
    });
    return (fxNow = jQuery.now());
  }
  function genFx(type, includeWidth) {
    var which,
        i = 0,
        attrs = {height: type};
    includeWidth = includeWidth ? 1 : 0;
    for (; i < 4; i += 2 - includeWidth) {
      which = cssExpand[i];
      attrs["margin" + which] = attrs["padding" + which] = type;
    }
    if (includeWidth) {
      attrs.opacity = attrs.width = type;
    }
    return attrs;
  }
  function createTween(value, prop, animation) {
    var tween,
        collection = (tweeners[prop] || []).concat(tweeners["*"]),
        index = 0,
        length = collection.length;
    for (; index < length; index++) {
      if ((tween = collection[index].call(animation, prop, value))) {
        return tween;
      }
    }
  }
  function defaultPrefilter(elem, props, opts) {
    var prop,
        value,
        toggle,
        tween,
        hooks,
        oldfire,
        display,
        checkDisplay,
        anim = this,
        orig = {},
        style = elem.style,
        hidden = elem.nodeType && isHidden(elem),
        dataShow = data_priv.get(elem, "fxshow");
    if (!opts.queue) {
      hooks = jQuery._queueHooks(elem, "fx");
      if (hooks.unqueued == null) {
        hooks.unqueued = 0;
        oldfire = hooks.empty.fire;
        hooks.empty.fire = function() {
          if (!hooks.unqueued) {
            oldfire();
          }
        };
      }
      hooks.unqueued++;
      anim.always(function() {
        anim.always(function() {
          hooks.unqueued--;
          if (!jQuery.queue(elem, "fx").length) {
            hooks.empty.fire();
          }
        });
      });
    }
    if (elem.nodeType === 1 && ("height" in props || "width" in props)) {
      opts.overflow = [style.overflow, style.overflowX, style.overflowY];
      display = jQuery.css(elem, "display");
      checkDisplay = display === "none" ? data_priv.get(elem, "olddisplay") || defaultDisplay(elem.nodeName) : display;
      if (checkDisplay === "inline" && jQuery.css(elem, "float") === "none") {
        style.display = "inline-block";
      }
    }
    if (opts.overflow) {
      style.overflow = "hidden";
      anim.always(function() {
        style.overflow = opts.overflow[0];
        style.overflowX = opts.overflow[1];
        style.overflowY = opts.overflow[2];
      });
    }
    for (prop in props) {
      value = props[prop];
      if (rfxtypes.exec(value)) {
        delete props[prop];
        toggle = toggle || value === "toggle";
        if (value === (hidden ? "hide" : "show")) {
          if (value === "show" && dataShow && dataShow[prop] !== undefined) {
            hidden = true;
          } else {
            continue;
          }
        }
        orig[prop] = dataShow && dataShow[prop] || jQuery.style(elem, prop);
      } else {
        display = undefined;
      }
    }
    if (!jQuery.isEmptyObject(orig)) {
      if (dataShow) {
        if ("hidden" in dataShow) {
          hidden = dataShow.hidden;
        }
      } else {
        dataShow = data_priv.access(elem, "fxshow", {});
      }
      if (toggle) {
        dataShow.hidden = !hidden;
      }
      if (hidden) {
        jQuery(elem).show();
      } else {
        anim.done(function() {
          jQuery(elem).hide();
        });
      }
      anim.done(function() {
        var prop;
        data_priv.remove(elem, "fxshow");
        for (prop in orig) {
          jQuery.style(elem, prop, orig[prop]);
        }
      });
      for (prop in orig) {
        tween = createTween(hidden ? dataShow[prop] : 0, prop, anim);
        if (!(prop in dataShow)) {
          dataShow[prop] = tween.start;
          if (hidden) {
            tween.end = tween.start;
            tween.start = prop === "width" || prop === "height" ? 1 : 0;
          }
        }
      }
    } else if ((display === "none" ? defaultDisplay(elem.nodeName) : display) === "inline") {
      style.display = display;
    }
  }
  function propFilter(props, specialEasing) {
    var index,
        name,
        easing,
        value,
        hooks;
    for (index in props) {
      name = jQuery.camelCase(index);
      easing = specialEasing[name];
      value = props[index];
      if (jQuery.isArray(value)) {
        easing = value[1];
        value = props[index] = value[0];
      }
      if (index !== name) {
        props[name] = value;
        delete props[index];
      }
      hooks = jQuery.cssHooks[name];
      if (hooks && "expand" in hooks) {
        value = hooks.expand(value);
        delete props[name];
        for (index in value) {
          if (!(index in props)) {
            props[index] = value[index];
            specialEasing[index] = easing;
          }
        }
      } else {
        specialEasing[name] = easing;
      }
    }
  }
  function Animation(elem, properties, options) {
    var result,
        stopped,
        index = 0,
        length = animationPrefilters.length,
        deferred = jQuery.Deferred().always(function() {
          delete tick.elem;
        }),
        tick = function() {
          if (stopped) {
            return false;
          }
          var currentTime = fxNow || createFxNow(),
              remaining = Math.max(0, animation.startTime + animation.duration - currentTime),
              temp = remaining / animation.duration || 0,
              percent = 1 - temp,
              index = 0,
              length = animation.tweens.length;
          for (; index < length; index++) {
            animation.tweens[index].run(percent);
          }
          deferred.notifyWith(elem, [animation, percent, remaining]);
          if (percent < 1 && length) {
            return remaining;
          } else {
            deferred.resolveWith(elem, [animation]);
            return false;
          }
        },
        animation = deferred.promise({
          elem: elem,
          props: jQuery.extend({}, properties),
          opts: jQuery.extend(true, {specialEasing: {}}, options),
          originalProperties: properties,
          originalOptions: options,
          startTime: fxNow || createFxNow(),
          duration: options.duration,
          tweens: [],
          createTween: function(prop, end) {
            var tween = jQuery.Tween(elem, animation.opts, prop, end, animation.opts.specialEasing[prop] || animation.opts.easing);
            animation.tweens.push(tween);
            return tween;
          },
          stop: function(gotoEnd) {
            var index = 0,
                length = gotoEnd ? animation.tweens.length : 0;
            if (stopped) {
              return this;
            }
            stopped = true;
            for (; index < length; index++) {
              animation.tweens[index].run(1);
            }
            if (gotoEnd) {
              deferred.resolveWith(elem, [animation, gotoEnd]);
            } else {
              deferred.rejectWith(elem, [animation, gotoEnd]);
            }
            return this;
          }
        }),
        props = animation.props;
    propFilter(props, animation.opts.specialEasing);
    for (; index < length; index++) {
      result = animationPrefilters[index].call(animation, elem, props, animation.opts);
      if (result) {
        return result;
      }
    }
    jQuery.map(props, createTween, animation);
    if (jQuery.isFunction(animation.opts.start)) {
      animation.opts.start.call(elem, animation);
    }
    jQuery.fx.timer(jQuery.extend(tick, {
      elem: elem,
      anim: animation,
      queue: animation.opts.queue
    }));
    return animation.progress(animation.opts.progress).done(animation.opts.done, animation.opts.complete).fail(animation.opts.fail).always(animation.opts.always);
  }
  jQuery.Animation = jQuery.extend(Animation, {
    tweener: function(props, callback) {
      if (jQuery.isFunction(props)) {
        callback = props;
        props = ["*"];
      } else {
        props = props.split(" ");
      }
      var prop,
          index = 0,
          length = props.length;
      for (; index < length; index++) {
        prop = props[index];
        tweeners[prop] = tweeners[prop] || [];
        tweeners[prop].unshift(callback);
      }
    },
    prefilter: function(callback, prepend) {
      if (prepend) {
        animationPrefilters.unshift(callback);
      } else {
        animationPrefilters.push(callback);
      }
    }
  });
  jQuery.speed = function(speed, easing, fn) {
    var opt = speed && typeof speed === "object" ? jQuery.extend({}, speed) : {
      complete: fn || !fn && easing || jQuery.isFunction(speed) && speed,
      duration: speed,
      easing: fn && easing || easing && !jQuery.isFunction(easing) && easing
    };
    opt.duration = jQuery.fx.off ? 0 : typeof opt.duration === "number" ? opt.duration : opt.duration in jQuery.fx.speeds ? jQuery.fx.speeds[opt.duration] : jQuery.fx.speeds._default;
    if (opt.queue == null || opt.queue === true) {
      opt.queue = "fx";
    }
    opt.old = opt.complete;
    opt.complete = function() {
      if (jQuery.isFunction(opt.old)) {
        opt.old.call(this);
      }
      if (opt.queue) {
        jQuery.dequeue(this, opt.queue);
      }
    };
    return opt;
  };
  jQuery.fn.extend({
    fadeTo: function(speed, to, easing, callback) {
      return this.filter(isHidden).css("opacity", 0).show().end().animate({opacity: to}, speed, easing, callback);
    },
    animate: function(prop, speed, easing, callback) {
      var empty = jQuery.isEmptyObject(prop),
          optall = jQuery.speed(speed, easing, callback),
          doAnimation = function() {
            var anim = Animation(this, jQuery.extend({}, prop), optall);
            if (empty || data_priv.get(this, "finish")) {
              anim.stop(true);
            }
          };
      doAnimation.finish = doAnimation;
      return empty || optall.queue === false ? this.each(doAnimation) : this.queue(optall.queue, doAnimation);
    },
    stop: function(type, clearQueue, gotoEnd) {
      var stopQueue = function(hooks) {
        var stop = hooks.stop;
        delete hooks.stop;
        stop(gotoEnd);
      };
      if (typeof type !== "string") {
        gotoEnd = clearQueue;
        clearQueue = type;
        type = undefined;
      }
      if (clearQueue && type !== false) {
        this.queue(type || "fx", []);
      }
      return this.each(function() {
        var dequeue = true,
            index = type != null && type + "queueHooks",
            timers = jQuery.timers,
            data = data_priv.get(this);
        if (index) {
          if (data[index] && data[index].stop) {
            stopQueue(data[index]);
          }
        } else {
          for (index in data) {
            if (data[index] && data[index].stop && rrun.test(index)) {
              stopQueue(data[index]);
            }
          }
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && (type == null || timers[index].queue === type)) {
            timers[index].anim.stop(gotoEnd);
            dequeue = false;
            timers.splice(index, 1);
          }
        }
        if (dequeue || !gotoEnd) {
          jQuery.dequeue(this, type);
        }
      });
    },
    finish: function(type) {
      if (type !== false) {
        type = type || "fx";
      }
      return this.each(function() {
        var index,
            data = data_priv.get(this),
            queue = data[type + "queue"],
            hooks = data[type + "queueHooks"],
            timers = jQuery.timers,
            length = queue ? queue.length : 0;
        data.finish = true;
        jQuery.queue(this, type, []);
        if (hooks && hooks.stop) {
          hooks.stop.call(this, true);
        }
        for (index = timers.length; index--; ) {
          if (timers[index].elem === this && timers[index].queue === type) {
            timers[index].anim.stop(true);
            timers.splice(index, 1);
          }
        }
        for (index = 0; index < length; index++) {
          if (queue[index] && queue[index].finish) {
            queue[index].finish.call(this);
          }
        }
        delete data.finish;
      });
    }
  });
  jQuery.each(["toggle", "show", "hide"], function(i, name) {
    var cssFn = jQuery.fn[name];
    jQuery.fn[name] = function(speed, easing, callback) {
      return speed == null || typeof speed === "boolean" ? cssFn.apply(this, arguments) : this.animate(genFx(name, true), speed, easing, callback);
    };
  });
  jQuery.each({
    slideDown: genFx("show"),
    slideUp: genFx("hide"),
    slideToggle: genFx("toggle"),
    fadeIn: {opacity: "show"},
    fadeOut: {opacity: "hide"},
    fadeToggle: {opacity: "toggle"}
  }, function(name, props) {
    jQuery.fn[name] = function(speed, easing, callback) {
      return this.animate(props, speed, easing, callback);
    };
  });
  jQuery.timers = [];
  jQuery.fx.tick = function() {
    var timer,
        i = 0,
        timers = jQuery.timers;
    fxNow = jQuery.now();
    for (; i < timers.length; i++) {
      timer = timers[i];
      if (!timer() && timers[i] === timer) {
        timers.splice(i--, 1);
      }
    }
    if (!timers.length) {
      jQuery.fx.stop();
    }
    fxNow = undefined;
  };
  jQuery.fx.timer = function(timer) {
    jQuery.timers.push(timer);
    if (timer()) {
      jQuery.fx.start();
    } else {
      jQuery.timers.pop();
    }
  };
  jQuery.fx.interval = 13;
  jQuery.fx.start = function() {
    if (!timerId) {
      timerId = setInterval(jQuery.fx.tick, jQuery.fx.interval);
    }
  };
  jQuery.fx.stop = function() {
    clearInterval(timerId);
    timerId = null;
  };
  jQuery.fx.speeds = {
    slow: 600,
    fast: 200,
    _default: 400
  };
  jQuery.fn.delay = function(time, type) {
    time = jQuery.fx ? jQuery.fx.speeds[time] || time : time;
    type = type || "fx";
    return this.queue(type, function(next, hooks) {
      var timeout = setTimeout(next, time);
      hooks.stop = function() {
        clearTimeout(timeout);
      };
    });
  };
  (function() {
    var input = document.createElement("input"),
        select = document.createElement("select"),
        opt = select.appendChild(document.createElement("option"));
    input.type = "checkbox";
    support.checkOn = input.value !== "";
    support.optSelected = opt.selected;
    select.disabled = true;
    support.optDisabled = !opt.disabled;
    input = document.createElement("input");
    input.value = "t";
    input.type = "radio";
    support.radioValue = input.value === "t";
  })();
  var nodeHook,
      boolHook,
      attrHandle = jQuery.expr.attrHandle;
  jQuery.fn.extend({
    attr: function(name, value) {
      return access(this, jQuery.attr, name, value, arguments.length > 1);
    },
    removeAttr: function(name) {
      return this.each(function() {
        jQuery.removeAttr(this, name);
      });
    }
  });
  jQuery.extend({
    attr: function(elem, name, value) {
      var hooks,
          ret,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return;
      }
      if (typeof elem.getAttribute === strundefined) {
        return jQuery.prop(elem, name, value);
      }
      if (nType !== 1 || !jQuery.isXMLDoc(elem)) {
        name = name.toLowerCase();
        hooks = jQuery.attrHooks[name] || (jQuery.expr.match.bool.test(name) ? boolHook : nodeHook);
      }
      if (value !== undefined) {
        if (value === null) {
          jQuery.removeAttr(elem, name);
        } else if (hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined) {
          return ret;
        } else {
          elem.setAttribute(name, value + "");
          return value;
        }
      } else if (hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null) {
        return ret;
      } else {
        ret = jQuery.find.attr(elem, name);
        return ret == null ? undefined : ret;
      }
    },
    removeAttr: function(elem, value) {
      var name,
          propName,
          i = 0,
          attrNames = value && value.match(rnotwhite);
      if (attrNames && elem.nodeType === 1) {
        while ((name = attrNames[i++])) {
          propName = jQuery.propFix[name] || name;
          if (jQuery.expr.match.bool.test(name)) {
            elem[propName] = false;
          }
          elem.removeAttribute(name);
        }
      }
    },
    attrHooks: {type: {set: function(elem, value) {
          if (!support.radioValue && value === "radio" && jQuery.nodeName(elem, "input")) {
            var val = elem.value;
            elem.setAttribute("type", value);
            if (val) {
              elem.value = val;
            }
            return value;
          }
        }}}
  });
  boolHook = {set: function(elem, value, name) {
      if (value === false) {
        jQuery.removeAttr(elem, name);
      } else {
        elem.setAttribute(name, name);
      }
      return name;
    }};
  jQuery.each(jQuery.expr.match.bool.source.match(/\w+/g), function(i, name) {
    var getter = attrHandle[name] || jQuery.find.attr;
    attrHandle[name] = function(elem, name, isXML) {
      var ret,
          handle;
      if (!isXML) {
        handle = attrHandle[name];
        attrHandle[name] = ret;
        ret = getter(elem, name, isXML) != null ? name.toLowerCase() : null;
        attrHandle[name] = handle;
      }
      return ret;
    };
  });
  var rfocusable = /^(?:input|select|textarea|button)$/i;
  jQuery.fn.extend({
    prop: function(name, value) {
      return access(this, jQuery.prop, name, value, arguments.length > 1);
    },
    removeProp: function(name) {
      return this.each(function() {
        delete this[jQuery.propFix[name] || name];
      });
    }
  });
  jQuery.extend({
    propFix: {
      "for": "htmlFor",
      "class": "className"
    },
    prop: function(elem, name, value) {
      var ret,
          hooks,
          notxml,
          nType = elem.nodeType;
      if (!elem || nType === 3 || nType === 8 || nType === 2) {
        return;
      }
      notxml = nType !== 1 || !jQuery.isXMLDoc(elem);
      if (notxml) {
        name = jQuery.propFix[name] || name;
        hooks = jQuery.propHooks[name];
      }
      if (value !== undefined) {
        return hooks && "set" in hooks && (ret = hooks.set(elem, value, name)) !== undefined ? ret : (elem[name] = value);
      } else {
        return hooks && "get" in hooks && (ret = hooks.get(elem, name)) !== null ? ret : elem[name];
      }
    },
    propHooks: {tabIndex: {get: function(elem) {
          return elem.hasAttribute("tabindex") || rfocusable.test(elem.nodeName) || elem.href ? elem.tabIndex : -1;
        }}}
  });
  if (!support.optSelected) {
    jQuery.propHooks.selected = {get: function(elem) {
        var parent = elem.parentNode;
        if (parent && parent.parentNode) {
          parent.parentNode.selectedIndex;
        }
        return null;
      }};
  }
  jQuery.each(["tabIndex", "readOnly", "maxLength", "cellSpacing", "cellPadding", "rowSpan", "colSpan", "useMap", "frameBorder", "contentEditable"], function() {
    jQuery.propFix[this.toLowerCase()] = this;
  });
  var rclass = /[\t\r\n\f]/g;
  jQuery.fn.extend({
    addClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).addClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : " ");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              if (cur.indexOf(" " + clazz + " ") < 0) {
                cur += clazz + " ";
              }
            }
            finalValue = jQuery.trim(cur);
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    removeClass: function(value) {
      var classes,
          elem,
          cur,
          clazz,
          j,
          finalValue,
          proceed = arguments.length === 0 || typeof value === "string" && value,
          i = 0,
          len = this.length;
      if (jQuery.isFunction(value)) {
        return this.each(function(j) {
          jQuery(this).removeClass(value.call(this, j, this.className));
        });
      }
      if (proceed) {
        classes = (value || "").match(rnotwhite) || [];
        for (; i < len; i++) {
          elem = this[i];
          cur = elem.nodeType === 1 && (elem.className ? (" " + elem.className + " ").replace(rclass, " ") : "");
          if (cur) {
            j = 0;
            while ((clazz = classes[j++])) {
              while (cur.indexOf(" " + clazz + " ") >= 0) {
                cur = cur.replace(" " + clazz + " ", " ");
              }
            }
            finalValue = value ? jQuery.trim(cur) : "";
            if (elem.className !== finalValue) {
              elem.className = finalValue;
            }
          }
        }
      }
      return this;
    },
    toggleClass: function(value, stateVal) {
      var type = typeof value;
      if (typeof stateVal === "boolean" && type === "string") {
        return stateVal ? this.addClass(value) : this.removeClass(value);
      }
      if (jQuery.isFunction(value)) {
        return this.each(function(i) {
          jQuery(this).toggleClass(value.call(this, i, this.className, stateVal), stateVal);
        });
      }
      return this.each(function() {
        if (type === "string") {
          var className,
              i = 0,
              self = jQuery(this),
              classNames = value.match(rnotwhite) || [];
          while ((className = classNames[i++])) {
            if (self.hasClass(className)) {
              self.removeClass(className);
            } else {
              self.addClass(className);
            }
          }
        } else if (type === strundefined || type === "boolean") {
          if (this.className) {
            data_priv.set(this, "__className__", this.className);
          }
          this.className = this.className || value === false ? "" : data_priv.get(this, "__className__") || "";
        }
      });
    },
    hasClass: function(selector) {
      var className = " " + selector + " ",
          i = 0,
          l = this.length;
      for (; i < l; i++) {
        if (this[i].nodeType === 1 && (" " + this[i].className + " ").replace(rclass, " ").indexOf(className) >= 0) {
          return true;
        }
      }
      return false;
    }
  });
  var rreturn = /\r/g;
  jQuery.fn.extend({val: function(value) {
      var hooks,
          ret,
          isFunction,
          elem = this[0];
      if (!arguments.length) {
        if (elem) {
          hooks = jQuery.valHooks[elem.type] || jQuery.valHooks[elem.nodeName.toLowerCase()];
          if (hooks && "get" in hooks && (ret = hooks.get(elem, "value")) !== undefined) {
            return ret;
          }
          ret = elem.value;
          return typeof ret === "string" ? ret.replace(rreturn, "") : ret == null ? "" : ret;
        }
        return;
      }
      isFunction = jQuery.isFunction(value);
      return this.each(function(i) {
        var val;
        if (this.nodeType !== 1) {
          return;
        }
        if (isFunction) {
          val = value.call(this, i, jQuery(this).val());
        } else {
          val = value;
        }
        if (val == null) {
          val = "";
        } else if (typeof val === "number") {
          val += "";
        } else if (jQuery.isArray(val)) {
          val = jQuery.map(val, function(value) {
            return value == null ? "" : value + "";
          });
        }
        hooks = jQuery.valHooks[this.type] || jQuery.valHooks[this.nodeName.toLowerCase()];
        if (!hooks || !("set" in hooks) || hooks.set(this, val, "value") === undefined) {
          this.value = val;
        }
      });
    }});
  jQuery.extend({valHooks: {
      option: {get: function(elem) {
          var val = jQuery.find.attr(elem, "value");
          return val != null ? val : jQuery.trim(jQuery.text(elem));
        }},
      select: {
        get: function(elem) {
          var value,
              option,
              options = elem.options,
              index = elem.selectedIndex,
              one = elem.type === "select-one" || index < 0,
              values = one ? null : [],
              max = one ? index + 1 : options.length,
              i = index < 0 ? max : one ? index : 0;
          for (; i < max; i++) {
            option = options[i];
            if ((option.selected || i === index) && (support.optDisabled ? !option.disabled : option.getAttribute("disabled") === null) && (!option.parentNode.disabled || !jQuery.nodeName(option.parentNode, "optgroup"))) {
              value = jQuery(option).val();
              if (one) {
                return value;
              }
              values.push(value);
            }
          }
          return values;
        },
        set: function(elem, value) {
          var optionSet,
              option,
              options = elem.options,
              values = jQuery.makeArray(value),
              i = options.length;
          while (i--) {
            option = options[i];
            if ((option.selected = jQuery.inArray(option.value, values) >= 0)) {
              optionSet = true;
            }
          }
          if (!optionSet) {
            elem.selectedIndex = -1;
          }
          return values;
        }
      }
    }});
  jQuery.each(["radio", "checkbox"], function() {
    jQuery.valHooks[this] = {set: function(elem, value) {
        if (jQuery.isArray(value)) {
          return (elem.checked = jQuery.inArray(jQuery(elem).val(), value) >= 0);
        }
      }};
    if (!support.checkOn) {
      jQuery.valHooks[this].get = function(elem) {
        return elem.getAttribute("value") === null ? "on" : elem.value;
      };
    }
  });
  jQuery.each(("blur focus focusin focusout load resize scroll unload click dblclick " + "mousedown mouseup mousemove mouseover mouseout mouseenter mouseleave " + "change select submit keydown keypress keyup error contextmenu").split(" "), function(i, name) {
    jQuery.fn[name] = function(data, fn) {
      return arguments.length > 0 ? this.on(name, null, data, fn) : this.trigger(name);
    };
  });
  jQuery.fn.extend({
    hover: function(fnOver, fnOut) {
      return this.mouseenter(fnOver).mouseleave(fnOut || fnOver);
    },
    bind: function(types, data, fn) {
      return this.on(types, null, data, fn);
    },
    unbind: function(types, fn) {
      return this.off(types, null, fn);
    },
    delegate: function(selector, types, data, fn) {
      return this.on(types, selector, data, fn);
    },
    undelegate: function(selector, types, fn) {
      return arguments.length === 1 ? this.off(selector, "**") : this.off(types, selector || "**", fn);
    }
  });
  var nonce = jQuery.now();
  var rquery = (/\?/);
  jQuery.parseJSON = function(data) {
    return JSON.parse(data + "");
  };
  jQuery.parseXML = function(data) {
    var xml,
        tmp;
    if (!data || typeof data !== "string") {
      return null;
    }
    try {
      tmp = new DOMParser();
      xml = tmp.parseFromString(data, "text/xml");
    } catch (e) {
      xml = undefined;
    }
    if (!xml || xml.getElementsByTagName("parsererror").length) {
      jQuery.error("Invalid XML: " + data);
    }
    return xml;
  };
  var rhash = /#.*$/,
      rts = /([?&])_=[^&]*/,
      rheaders = /^(.*?):[ \t]*([^\r\n]*)$/mg,
      rlocalProtocol = /^(?:about|app|app-storage|.+-extension|file|res|widget):$/,
      rnoContent = /^(?:GET|HEAD)$/,
      rprotocol = /^\/\//,
      rurl = /^([\w.+-]+:)(?:\/\/(?:[^\/?#]*@|)([^\/?#:]*)(?::(\d+)|)|)/,
      prefilters = {},
      transports = {},
      allTypes = "*/".concat("*"),
      ajaxLocation = window.location.href,
      ajaxLocParts = rurl.exec(ajaxLocation.toLowerCase()) || [];
  function addToPrefiltersOrTransports(structure) {
    return function(dataTypeExpression, func) {
      if (typeof dataTypeExpression !== "string") {
        func = dataTypeExpression;
        dataTypeExpression = "*";
      }
      var dataType,
          i = 0,
          dataTypes = dataTypeExpression.toLowerCase().match(rnotwhite) || [];
      if (jQuery.isFunction(func)) {
        while ((dataType = dataTypes[i++])) {
          if (dataType[0] === "+") {
            dataType = dataType.slice(1) || "*";
            (structure[dataType] = structure[dataType] || []).unshift(func);
          } else {
            (structure[dataType] = structure[dataType] || []).push(func);
          }
        }
      }
    };
  }
  function inspectPrefiltersOrTransports(structure, options, originalOptions, jqXHR) {
    var inspected = {},
        seekingTransport = (structure === transports);
    function inspect(dataType) {
      var selected;
      inspected[dataType] = true;
      jQuery.each(structure[dataType] || [], function(_, prefilterOrFactory) {
        var dataTypeOrTransport = prefilterOrFactory(options, originalOptions, jqXHR);
        if (typeof dataTypeOrTransport === "string" && !seekingTransport && !inspected[dataTypeOrTransport]) {
          options.dataTypes.unshift(dataTypeOrTransport);
          inspect(dataTypeOrTransport);
          return false;
        } else if (seekingTransport) {
          return !(selected = dataTypeOrTransport);
        }
      });
      return selected;
    }
    return inspect(options.dataTypes[0]) || !inspected["*"] && inspect("*");
  }
  function ajaxExtend(target, src) {
    var key,
        deep,
        flatOptions = jQuery.ajaxSettings.flatOptions || {};
    for (key in src) {
      if (src[key] !== undefined) {
        (flatOptions[key] ? target : (deep || (deep = {})))[key] = src[key];
      }
    }
    if (deep) {
      jQuery.extend(true, target, deep);
    }
    return target;
  }
  function ajaxHandleResponses(s, jqXHR, responses) {
    var ct,
        type,
        finalDataType,
        firstDataType,
        contents = s.contents,
        dataTypes = s.dataTypes;
    while (dataTypes[0] === "*") {
      dataTypes.shift();
      if (ct === undefined) {
        ct = s.mimeType || jqXHR.getResponseHeader("Content-Type");
      }
    }
    if (ct) {
      for (type in contents) {
        if (contents[type] && contents[type].test(ct)) {
          dataTypes.unshift(type);
          break;
        }
      }
    }
    if (dataTypes[0] in responses) {
      finalDataType = dataTypes[0];
    } else {
      for (type in responses) {
        if (!dataTypes[0] || s.converters[type + " " + dataTypes[0]]) {
          finalDataType = type;
          break;
        }
        if (!firstDataType) {
          firstDataType = type;
        }
      }
      finalDataType = finalDataType || firstDataType;
    }
    if (finalDataType) {
      if (finalDataType !== dataTypes[0]) {
        dataTypes.unshift(finalDataType);
      }
      return responses[finalDataType];
    }
  }
  function ajaxConvert(s, response, jqXHR, isSuccess) {
    var conv2,
        current,
        conv,
        tmp,
        prev,
        converters = {},
        dataTypes = s.dataTypes.slice();
    if (dataTypes[1]) {
      for (conv in s.converters) {
        converters[conv.toLowerCase()] = s.converters[conv];
      }
    }
    current = dataTypes.shift();
    while (current) {
      if (s.responseFields[current]) {
        jqXHR[s.responseFields[current]] = response;
      }
      if (!prev && isSuccess && s.dataFilter) {
        response = s.dataFilter(response, s.dataType);
      }
      prev = current;
      current = dataTypes.shift();
      if (current) {
        if (current === "*") {
          current = prev;
        } else if (prev !== "*" && prev !== current) {
          conv = converters[prev + " " + current] || converters["* " + current];
          if (!conv) {
            for (conv2 in converters) {
              tmp = conv2.split(" ");
              if (tmp[1] === current) {
                conv = converters[prev + " " + tmp[0]] || converters["* " + tmp[0]];
                if (conv) {
                  if (conv === true) {
                    conv = converters[conv2];
                  } else if (converters[conv2] !== true) {
                    current = tmp[0];
                    dataTypes.unshift(tmp[1]);
                  }
                  break;
                }
              }
            }
          }
          if (conv !== true) {
            if (conv && s["throws"]) {
              response = conv(response);
            } else {
              try {
                response = conv(response);
              } catch (e) {
                return {
                  state: "parsererror",
                  error: conv ? e : "No conversion from " + prev + " to " + current
                };
              }
            }
          }
        }
      }
    }
    return {
      state: "success",
      data: response
    };
  }
  jQuery.extend({
    active: 0,
    lastModified: {},
    etag: {},
    ajaxSettings: {
      url: ajaxLocation,
      type: "GET",
      isLocal: rlocalProtocol.test(ajaxLocParts[1]),
      global: true,
      processData: true,
      async: true,
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
      accepts: {
        "*": allTypes,
        text: "text/plain",
        html: "text/html",
        xml: "application/xml, text/xml",
        json: "application/json, text/javascript"
      },
      contents: {
        xml: /xml/,
        html: /html/,
        json: /json/
      },
      responseFields: {
        xml: "responseXML",
        text: "responseText",
        json: "responseJSON"
      },
      converters: {
        "* text": String,
        "text html": true,
        "text json": jQuery.parseJSON,
        "text xml": jQuery.parseXML
      },
      flatOptions: {
        url: true,
        context: true
      }
    },
    ajaxSetup: function(target, settings) {
      return settings ? ajaxExtend(ajaxExtend(target, jQuery.ajaxSettings), settings) : ajaxExtend(jQuery.ajaxSettings, target);
    },
    ajaxPrefilter: addToPrefiltersOrTransports(prefilters),
    ajaxTransport: addToPrefiltersOrTransports(transports),
    ajax: function(url, options) {
      if (typeof url === "object") {
        options = url;
        url = undefined;
      }
      options = options || {};
      var transport,
          cacheURL,
          responseHeadersString,
          responseHeaders,
          timeoutTimer,
          parts,
          fireGlobals,
          i,
          s = jQuery.ajaxSetup({}, options),
          callbackContext = s.context || s,
          globalEventContext = s.context && (callbackContext.nodeType || callbackContext.jquery) ? jQuery(callbackContext) : jQuery.event,
          deferred = jQuery.Deferred(),
          completeDeferred = jQuery.Callbacks("once memory"),
          statusCode = s.statusCode || {},
          requestHeaders = {},
          requestHeadersNames = {},
          state = 0,
          strAbort = "canceled",
          jqXHR = {
            readyState: 0,
            getResponseHeader: function(key) {
              var match;
              if (state === 2) {
                if (!responseHeaders) {
                  responseHeaders = {};
                  while ((match = rheaders.exec(responseHeadersString))) {
                    responseHeaders[match[1].toLowerCase()] = match[2];
                  }
                }
                match = responseHeaders[key.toLowerCase()];
              }
              return match == null ? null : match;
            },
            getAllResponseHeaders: function() {
              return state === 2 ? responseHeadersString : null;
            },
            setRequestHeader: function(name, value) {
              var lname = name.toLowerCase();
              if (!state) {
                name = requestHeadersNames[lname] = requestHeadersNames[lname] || name;
                requestHeaders[name] = value;
              }
              return this;
            },
            overrideMimeType: function(type) {
              if (!state) {
                s.mimeType = type;
              }
              return this;
            },
            statusCode: function(map) {
              var code;
              if (map) {
                if (state < 2) {
                  for (code in map) {
                    statusCode[code] = [statusCode[code], map[code]];
                  }
                } else {
                  jqXHR.always(map[jqXHR.status]);
                }
              }
              return this;
            },
            abort: function(statusText) {
              var finalText = statusText || strAbort;
              if (transport) {
                transport.abort(finalText);
              }
              done(0, finalText);
              return this;
            }
          };
      deferred.promise(jqXHR).complete = completeDeferred.add;
      jqXHR.success = jqXHR.done;
      jqXHR.error = jqXHR.fail;
      s.url = ((url || s.url || ajaxLocation) + "").replace(rhash, "").replace(rprotocol, ajaxLocParts[1] + "//");
      s.type = options.method || options.type || s.method || s.type;
      s.dataTypes = jQuery.trim(s.dataType || "*").toLowerCase().match(rnotwhite) || [""];
      if (s.crossDomain == null) {
        parts = rurl.exec(s.url.toLowerCase());
        s.crossDomain = !!(parts && (parts[1] !== ajaxLocParts[1] || parts[2] !== ajaxLocParts[2] || (parts[3] || (parts[1] === "http:" ? "80" : "443")) !== (ajaxLocParts[3] || (ajaxLocParts[1] === "http:" ? "80" : "443"))));
      }
      if (s.data && s.processData && typeof s.data !== "string") {
        s.data = jQuery.param(s.data, s.traditional);
      }
      inspectPrefiltersOrTransports(prefilters, s, options, jqXHR);
      if (state === 2) {
        return jqXHR;
      }
      fireGlobals = jQuery.event && s.global;
      if (fireGlobals && jQuery.active++ === 0) {
        jQuery.event.trigger("ajaxStart");
      }
      s.type = s.type.toUpperCase();
      s.hasContent = !rnoContent.test(s.type);
      cacheURL = s.url;
      if (!s.hasContent) {
        if (s.data) {
          cacheURL = (s.url += (rquery.test(cacheURL) ? "&" : "?") + s.data);
          delete s.data;
        }
        if (s.cache === false) {
          s.url = rts.test(cacheURL) ? cacheURL.replace(rts, "$1_=" + nonce++) : cacheURL + (rquery.test(cacheURL) ? "&" : "?") + "_=" + nonce++;
        }
      }
      if (s.ifModified) {
        if (jQuery.lastModified[cacheURL]) {
          jqXHR.setRequestHeader("If-Modified-Since", jQuery.lastModified[cacheURL]);
        }
        if (jQuery.etag[cacheURL]) {
          jqXHR.setRequestHeader("If-None-Match", jQuery.etag[cacheURL]);
        }
      }
      if (s.data && s.hasContent && s.contentType !== false || options.contentType) {
        jqXHR.setRequestHeader("Content-Type", s.contentType);
      }
      jqXHR.setRequestHeader("Accept", s.dataTypes[0] && s.accepts[s.dataTypes[0]] ? s.accepts[s.dataTypes[0]] + (s.dataTypes[0] !== "*" ? ", " + allTypes + "; q=0.01" : "") : s.accepts["*"]);
      for (i in s.headers) {
        jqXHR.setRequestHeader(i, s.headers[i]);
      }
      if (s.beforeSend && (s.beforeSend.call(callbackContext, jqXHR, s) === false || state === 2)) {
        return jqXHR.abort();
      }
      strAbort = "abort";
      for (i in {
        success: 1,
        error: 1,
        complete: 1
      }) {
        jqXHR[i](s[i]);
      }
      transport = inspectPrefiltersOrTransports(transports, s, options, jqXHR);
      if (!transport) {
        done(-1, "No Transport");
      } else {
        jqXHR.readyState = 1;
        if (fireGlobals) {
          globalEventContext.trigger("ajaxSend", [jqXHR, s]);
        }
        if (s.async && s.timeout > 0) {
          timeoutTimer = setTimeout(function() {
            jqXHR.abort("timeout");
          }, s.timeout);
        }
        try {
          state = 1;
          transport.send(requestHeaders, done);
        } catch (e) {
          if (state < 2) {
            done(-1, e);
          } else {
            throw e;
          }
        }
      }
      function done(status, nativeStatusText, responses, headers) {
        var isSuccess,
            success,
            error,
            response,
            modified,
            statusText = nativeStatusText;
        if (state === 2) {
          return;
        }
        state = 2;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        transport = undefined;
        responseHeadersString = headers || "";
        jqXHR.readyState = status > 0 ? 4 : 0;
        isSuccess = status >= 200 && status < 300 || status === 304;
        if (responses) {
          response = ajaxHandleResponses(s, jqXHR, responses);
        }
        response = ajaxConvert(s, response, jqXHR, isSuccess);
        if (isSuccess) {
          if (s.ifModified) {
            modified = jqXHR.getResponseHeader("Last-Modified");
            if (modified) {
              jQuery.lastModified[cacheURL] = modified;
            }
            modified = jqXHR.getResponseHeader("etag");
            if (modified) {
              jQuery.etag[cacheURL] = modified;
            }
          }
          if (status === 204 || s.type === "HEAD") {
            statusText = "nocontent";
          } else if (status === 304) {
            statusText = "notmodified";
          } else {
            statusText = response.state;
            success = response.data;
            error = response.error;
            isSuccess = !error;
          }
        } else {
          error = statusText;
          if (status || !statusText) {
            statusText = "error";
            if (status < 0) {
              status = 0;
            }
          }
        }
        jqXHR.status = status;
        jqXHR.statusText = (nativeStatusText || statusText) + "";
        if (isSuccess) {
          deferred.resolveWith(callbackContext, [success, statusText, jqXHR]);
        } else {
          deferred.rejectWith(callbackContext, [jqXHR, statusText, error]);
        }
        jqXHR.statusCode(statusCode);
        statusCode = undefined;
        if (fireGlobals) {
          globalEventContext.trigger(isSuccess ? "ajaxSuccess" : "ajaxError", [jqXHR, s, isSuccess ? success : error]);
        }
        completeDeferred.fireWith(callbackContext, [jqXHR, statusText]);
        if (fireGlobals) {
          globalEventContext.trigger("ajaxComplete", [jqXHR, s]);
          if (!(--jQuery.active)) {
            jQuery.event.trigger("ajaxStop");
          }
        }
      }
      return jqXHR;
    },
    getJSON: function(url, data, callback) {
      return jQuery.get(url, data, callback, "json");
    },
    getScript: function(url, callback) {
      return jQuery.get(url, undefined, callback, "script");
    }
  });
  jQuery.each(["get", "post"], function(i, method) {
    jQuery[method] = function(url, data, callback, type) {
      if (jQuery.isFunction(data)) {
        type = type || callback;
        callback = data;
        data = undefined;
      }
      return jQuery.ajax({
        url: url,
        type: method,
        dataType: type,
        data: data,
        success: callback
      });
    };
  });
  jQuery._evalUrl = function(url) {
    return jQuery.ajax({
      url: url,
      type: "GET",
      dataType: "script",
      async: false,
      global: false,
      "throws": true
    });
  };
  jQuery.fn.extend({
    wrapAll: function(html) {
      var wrap;
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapAll(html.call(this, i));
        });
      }
      if (this[0]) {
        wrap = jQuery(html, this[0].ownerDocument).eq(0).clone(true);
        if (this[0].parentNode) {
          wrap.insertBefore(this[0]);
        }
        wrap.map(function() {
          var elem = this;
          while (elem.firstElementChild) {
            elem = elem.firstElementChild;
          }
          return elem;
        }).append(this);
      }
      return this;
    },
    wrapInner: function(html) {
      if (jQuery.isFunction(html)) {
        return this.each(function(i) {
          jQuery(this).wrapInner(html.call(this, i));
        });
      }
      return this.each(function() {
        var self = jQuery(this),
            contents = self.contents();
        if (contents.length) {
          contents.wrapAll(html);
        } else {
          self.append(html);
        }
      });
    },
    wrap: function(html) {
      var isFunction = jQuery.isFunction(html);
      return this.each(function(i) {
        jQuery(this).wrapAll(isFunction ? html.call(this, i) : html);
      });
    },
    unwrap: function() {
      return this.parent().each(function() {
        if (!jQuery.nodeName(this, "body")) {
          jQuery(this).replaceWith(this.childNodes);
        }
      }).end();
    }
  });
  jQuery.expr.filters.hidden = function(elem) {
    return elem.offsetWidth <= 0 && elem.offsetHeight <= 0;
  };
  jQuery.expr.filters.visible = function(elem) {
    return !jQuery.expr.filters.hidden(elem);
  };
  var r20 = /%20/g,
      rbracket = /\[\]$/,
      rCRLF = /\r?\n/g,
      rsubmitterTypes = /^(?:submit|button|image|reset|file)$/i,
      rsubmittable = /^(?:input|select|textarea|keygen)/i;
  function buildParams(prefix, obj, traditional, add) {
    var name;
    if (jQuery.isArray(obj)) {
      jQuery.each(obj, function(i, v) {
        if (traditional || rbracket.test(prefix)) {
          add(prefix, v);
        } else {
          buildParams(prefix + "[" + (typeof v === "object" ? i : "") + "]", v, traditional, add);
        }
      });
    } else if (!traditional && jQuery.type(obj) === "object") {
      for (name in obj) {
        buildParams(prefix + "[" + name + "]", obj[name], traditional, add);
      }
    } else {
      add(prefix, obj);
    }
  }
  jQuery.param = function(a, traditional) {
    var prefix,
        s = [],
        add = function(key, value) {
          value = jQuery.isFunction(value) ? value() : (value == null ? "" : value);
          s[s.length] = encodeURIComponent(key) + "=" + encodeURIComponent(value);
        };
    if (traditional === undefined) {
      traditional = jQuery.ajaxSettings && jQuery.ajaxSettings.traditional;
    }
    if (jQuery.isArray(a) || (a.jquery && !jQuery.isPlainObject(a))) {
      jQuery.each(a, function() {
        add(this.name, this.value);
      });
    } else {
      for (prefix in a) {
        buildParams(prefix, a[prefix], traditional, add);
      }
    }
    return s.join("&").replace(r20, "+");
  };
  jQuery.fn.extend({
    serialize: function() {
      return jQuery.param(this.serializeArray());
    },
    serializeArray: function() {
      return this.map(function() {
        var elements = jQuery.prop(this, "elements");
        return elements ? jQuery.makeArray(elements) : this;
      }).filter(function() {
        var type = this.type;
        return this.name && !jQuery(this).is(":disabled") && rsubmittable.test(this.nodeName) && !rsubmitterTypes.test(type) && (this.checked || !rcheckableType.test(type));
      }).map(function(i, elem) {
        var val = jQuery(this).val();
        return val == null ? null : jQuery.isArray(val) ? jQuery.map(val, function(val) {
          return {
            name: elem.name,
            value: val.replace(rCRLF, "\r\n")
          };
        }) : {
          name: elem.name,
          value: val.replace(rCRLF, "\r\n")
        };
      }).get();
    }
  });
  jQuery.ajaxSettings.xhr = function() {
    try {
      return new XMLHttpRequest();
    } catch (e) {}
  };
  var xhrId = 0,
      xhrCallbacks = {},
      xhrSuccessStatus = {
        0: 200,
        1223: 204
      },
      xhrSupported = jQuery.ajaxSettings.xhr();
  if (window.attachEvent) {
    window.attachEvent("onunload", function() {
      for (var key in xhrCallbacks) {
        xhrCallbacks[key]();
      }
    });
  }
  support.cors = !!xhrSupported && ("withCredentials" in xhrSupported);
  support.ajax = xhrSupported = !!xhrSupported;
  jQuery.ajaxTransport(function(options) {
    var callback;
    if (support.cors || xhrSupported && !options.crossDomain) {
      return {
        send: function(headers, complete) {
          var i,
              xhr = options.xhr(),
              id = ++xhrId;
          xhr.open(options.type, options.url, options.async, options.username, options.password);
          if (options.xhrFields) {
            for (i in options.xhrFields) {
              xhr[i] = options.xhrFields[i];
            }
          }
          if (options.mimeType && xhr.overrideMimeType) {
            xhr.overrideMimeType(options.mimeType);
          }
          if (!options.crossDomain && !headers["X-Requested-With"]) {
            headers["X-Requested-With"] = "XMLHttpRequest";
          }
          for (i in headers) {
            xhr.setRequestHeader(i, headers[i]);
          }
          callback = function(type) {
            return function() {
              if (callback) {
                delete xhrCallbacks[id];
                callback = xhr.onload = xhr.onerror = null;
                if (type === "abort") {
                  xhr.abort();
                } else if (type === "error") {
                  complete(xhr.status, xhr.statusText);
                } else {
                  complete(xhrSuccessStatus[xhr.status] || xhr.status, xhr.statusText, typeof xhr.responseText === "string" ? {text: xhr.responseText} : undefined, xhr.getAllResponseHeaders());
                }
              }
            };
          };
          xhr.onload = callback();
          xhr.onerror = callback("error");
          callback = xhrCallbacks[id] = callback("abort");
          try {
            xhr.send(options.hasContent && options.data || null);
          } catch (e) {
            if (callback) {
              throw e;
            }
          }
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  jQuery.ajaxSetup({
    accepts: {script: "text/javascript, application/javascript, application/ecmascript, application/x-ecmascript"},
    contents: {script: /(?:java|ecma)script/},
    converters: {"text script": function(text) {
        jQuery.globalEval(text);
        return text;
      }}
  });
  jQuery.ajaxPrefilter("script", function(s) {
    if (s.cache === undefined) {
      s.cache = false;
    }
    if (s.crossDomain) {
      s.type = "GET";
    }
  });
  jQuery.ajaxTransport("script", function(s) {
    if (s.crossDomain) {
      var script,
          callback;
      return {
        send: function(_, complete) {
          script = jQuery("<script>").prop({
            async: true,
            charset: s.scriptCharset,
            src: s.url
          }).on("load error", callback = function(evt) {
            script.remove();
            callback = null;
            if (evt) {
              complete(evt.type === "error" ? 404 : 200, evt.type);
            }
          });
          document.head.appendChild(script[0]);
        },
        abort: function() {
          if (callback) {
            callback();
          }
        }
      };
    }
  });
  var oldCallbacks = [],
      rjsonp = /(=)\?(?=&|$)|\?\?/;
  jQuery.ajaxSetup({
    jsonp: "callback",
    jsonpCallback: function() {
      var callback = oldCallbacks.pop() || (jQuery.expando + "_" + (nonce++));
      this[callback] = true;
      return callback;
    }
  });
  jQuery.ajaxPrefilter("json jsonp", function(s, originalSettings, jqXHR) {
    var callbackName,
        overwritten,
        responseContainer,
        jsonProp = s.jsonp !== false && (rjsonp.test(s.url) ? "url" : typeof s.data === "string" && !(s.contentType || "").indexOf("application/x-www-form-urlencoded") && rjsonp.test(s.data) && "data");
    if (jsonProp || s.dataTypes[0] === "jsonp") {
      callbackName = s.jsonpCallback = jQuery.isFunction(s.jsonpCallback) ? s.jsonpCallback() : s.jsonpCallback;
      if (jsonProp) {
        s[jsonProp] = s[jsonProp].replace(rjsonp, "$1" + callbackName);
      } else if (s.jsonp !== false) {
        s.url += (rquery.test(s.url) ? "&" : "?") + s.jsonp + "=" + callbackName;
      }
      s.converters["script json"] = function() {
        if (!responseContainer) {
          jQuery.error(callbackName + " was not called");
        }
        return responseContainer[0];
      };
      s.dataTypes[0] = "json";
      overwritten = window[callbackName];
      window[callbackName] = function() {
        responseContainer = arguments;
      };
      jqXHR.always(function() {
        window[callbackName] = overwritten;
        if (s[callbackName]) {
          s.jsonpCallback = originalSettings.jsonpCallback;
          oldCallbacks.push(callbackName);
        }
        if (responseContainer && jQuery.isFunction(overwritten)) {
          overwritten(responseContainer[0]);
        }
        responseContainer = overwritten = undefined;
      });
      return "script";
    }
  });
  jQuery.parseHTML = function(data, context, keepScripts) {
    if (!data || typeof data !== "string") {
      return null;
    }
    if (typeof context === "boolean") {
      keepScripts = context;
      context = false;
    }
    context = context || document;
    var parsed = rsingleTag.exec(data),
        scripts = !keepScripts && [];
    if (parsed) {
      return [context.createElement(parsed[1])];
    }
    parsed = jQuery.buildFragment([data], context, scripts);
    if (scripts && scripts.length) {
      jQuery(scripts).remove();
    }
    return jQuery.merge([], parsed.childNodes);
  };
  var _load = jQuery.fn.load;
  jQuery.fn.load = function(url, params, callback) {
    if (typeof url !== "string" && _load) {
      return _load.apply(this, arguments);
    }
    var selector,
        type,
        response,
        self = this,
        off = url.indexOf(" ");
    if (off >= 0) {
      selector = jQuery.trim(url.slice(off));
      url = url.slice(0, off);
    }
    if (jQuery.isFunction(params)) {
      callback = params;
      params = undefined;
    } else if (params && typeof params === "object") {
      type = "POST";
    }
    if (self.length > 0) {
      jQuery.ajax({
        url: url,
        type: type,
        dataType: "html",
        data: params
      }).done(function(responseText) {
        response = arguments;
        self.html(selector ? jQuery("<div>").append(jQuery.parseHTML(responseText)).find(selector) : responseText);
      }).complete(callback && function(jqXHR, status) {
        self.each(callback, response || [jqXHR.responseText, status, jqXHR]);
      });
    }
    return this;
  };
  jQuery.each(["ajaxStart", "ajaxStop", "ajaxComplete", "ajaxError", "ajaxSuccess", "ajaxSend"], function(i, type) {
    jQuery.fn[type] = function(fn) {
      return this.on(type, fn);
    };
  });
  jQuery.expr.filters.animated = function(elem) {
    return jQuery.grep(jQuery.timers, function(fn) {
      return elem === fn.elem;
    }).length;
  };
  var docElem = window.document.documentElement;
  function getWindow(elem) {
    return jQuery.isWindow(elem) ? elem : elem.nodeType === 9 && elem.defaultView;
  }
  jQuery.offset = {setOffset: function(elem, options, i) {
      var curPosition,
          curLeft,
          curCSSTop,
          curTop,
          curOffset,
          curCSSLeft,
          calculatePosition,
          position = jQuery.css(elem, "position"),
          curElem = jQuery(elem),
          props = {};
      if (position === "static") {
        elem.style.position = "relative";
      }
      curOffset = curElem.offset();
      curCSSTop = jQuery.css(elem, "top");
      curCSSLeft = jQuery.css(elem, "left");
      calculatePosition = (position === "absolute" || position === "fixed") && (curCSSTop + curCSSLeft).indexOf("auto") > -1;
      if (calculatePosition) {
        curPosition = curElem.position();
        curTop = curPosition.top;
        curLeft = curPosition.left;
      } else {
        curTop = parseFloat(curCSSTop) || 0;
        curLeft = parseFloat(curCSSLeft) || 0;
      }
      if (jQuery.isFunction(options)) {
        options = options.call(elem, i, curOffset);
      }
      if (options.top != null) {
        props.top = (options.top - curOffset.top) + curTop;
      }
      if (options.left != null) {
        props.left = (options.left - curOffset.left) + curLeft;
      }
      if ("using" in options) {
        options.using.call(elem, props);
      } else {
        curElem.css(props);
      }
    }};
  jQuery.fn.extend({
    offset: function(options) {
      if (arguments.length) {
        return options === undefined ? this : this.each(function(i) {
          jQuery.offset.setOffset(this, options, i);
        });
      }
      var docElem,
          win,
          elem = this[0],
          box = {
            top: 0,
            left: 0
          },
          doc = elem && elem.ownerDocument;
      if (!doc) {
        return;
      }
      docElem = doc.documentElement;
      if (!jQuery.contains(docElem, elem)) {
        return box;
      }
      if (typeof elem.getBoundingClientRect !== strundefined) {
        box = elem.getBoundingClientRect();
      }
      win = getWindow(doc);
      return {
        top: box.top + win.pageYOffset - docElem.clientTop,
        left: box.left + win.pageXOffset - docElem.clientLeft
      };
    },
    position: function() {
      if (!this[0]) {
        return;
      }
      var offsetParent,
          offset,
          elem = this[0],
          parentOffset = {
            top: 0,
            left: 0
          };
      if (jQuery.css(elem, "position") === "fixed") {
        offset = elem.getBoundingClientRect();
      } else {
        offsetParent = this.offsetParent();
        offset = this.offset();
        if (!jQuery.nodeName(offsetParent[0], "html")) {
          parentOffset = offsetParent.offset();
        }
        parentOffset.top += jQuery.css(offsetParent[0], "borderTopWidth", true);
        parentOffset.left += jQuery.css(offsetParent[0], "borderLeftWidth", true);
      }
      return {
        top: offset.top - parentOffset.top - jQuery.css(elem, "marginTop", true),
        left: offset.left - parentOffset.left - jQuery.css(elem, "marginLeft", true)
      };
    },
    offsetParent: function() {
      return this.map(function() {
        var offsetParent = this.offsetParent || docElem;
        while (offsetParent && (!jQuery.nodeName(offsetParent, "html") && jQuery.css(offsetParent, "position") === "static")) {
          offsetParent = offsetParent.offsetParent;
        }
        return offsetParent || docElem;
      });
    }
  });
  jQuery.each({
    scrollLeft: "pageXOffset",
    scrollTop: "pageYOffset"
  }, function(method, prop) {
    var top = "pageYOffset" === prop;
    jQuery.fn[method] = function(val) {
      return access(this, function(elem, method, val) {
        var win = getWindow(elem);
        if (val === undefined) {
          return win ? win[prop] : elem[method];
        }
        if (win) {
          win.scrollTo(!top ? val : window.pageXOffset, top ? val : window.pageYOffset);
        } else {
          elem[method] = val;
        }
      }, method, val, arguments.length, null);
    };
  });
  jQuery.each(["top", "left"], function(i, prop) {
    jQuery.cssHooks[prop] = addGetHookIf(support.pixelPosition, function(elem, computed) {
      if (computed) {
        computed = curCSS(elem, prop);
        return rnumnonpx.test(computed) ? jQuery(elem).position()[prop] + "px" : computed;
      }
    });
  });
  jQuery.each({
    Height: "height",
    Width: "width"
  }, function(name, type) {
    jQuery.each({
      padding: "inner" + name,
      content: type,
      "": "outer" + name
    }, function(defaultExtra, funcName) {
      jQuery.fn[funcName] = function(margin, value) {
        var chainable = arguments.length && (defaultExtra || typeof margin !== "boolean"),
            extra = defaultExtra || (margin === true || value === true ? "margin" : "border");
        return access(this, function(elem, type, value) {
          var doc;
          if (jQuery.isWindow(elem)) {
            return elem.document.documentElement["client" + name];
          }
          if (elem.nodeType === 9) {
            doc = elem.documentElement;
            return Math.max(elem.body["scroll" + name], doc["scroll" + name], elem.body["offset" + name], doc["offset" + name], doc["client" + name]);
          }
          return value === undefined ? jQuery.css(elem, type, extra) : jQuery.style(elem, type, value, extra);
        }, type, chainable ? margin : undefined, chainable, null);
      };
    });
  });
  jQuery.fn.size = function() {
    return this.length;
  };
  jQuery.fn.andSelf = jQuery.fn.addBack;
  if (typeof define === "function" && define.amd) {
    define("a", [], function() {
      return jQuery;
    });
  }
  var _jQuery = window.jQuery,
      _$ = window.$;
  jQuery.noConflict = function(deep) {
    if (window.$ === jQuery) {
      window.$ = _$;
    }
    if (deep && window.jQuery === jQuery) {
      window.jQuery = _jQuery;
    }
    return jQuery;
  };
  if (typeof noGlobal === strundefined) {
    window.jQuery = window.$ = jQuery;
  }
  return jQuery;
}));

_removeDefine();
})();
(function() {
var _removeDefine = $__System.get("@@amd-helpers").createDefine();
define("b", ["a"], function(main) {
  return main;
});

_removeDefine();
})();
$__System.register('c', [], function (_export) {
    /*
    Module for the auditing of the game
    */
    'use strict';

    var theLog;

    // The logging function
    function log(msg) {
        var logMsg = new Date() + ' ' + msg;
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
        var oldLog = localStorage.getObject('log');
        if (typeof oldLog !== 'undefined' && oldLog) {
            theLog = oldLog;
        }
        return theLog;
    }
    return {
        setters: [],
        execute: function () {
            _export('log', log);

            _export('restore', restore);

            theLog = [];
        }
    };
});
$__System.register('d', ['c'], function (_export) {
    /*
    connectFour.js
    This is the model of the game, all logic is here but no DOM manipulation.
    */

    // Object representing an instance of the game
    'use strict';

    var audit, instance, highscore, EMPTY;

    // Return highscore object so that it can be saved
    function getHighscore() {
        return highscore;
    }

    // Restore the highscore object
    function restoreHighscore(oldHighscore) {
        highscore = oldHighscore;
    }

    // Increment the highscore for player `player`
    function updateHighScore(player) {
        if (typeof highscore[player] === 'undefined') {
            highscore[player] = 1;
        } else {
            highscore[player] += 1;
        }
        audit.log(player + ' has now won ' + highscore[player] + ' times');
    }

    // Return instance object so that it can be saved
    function getInstance() {
        return instance;
    }

    function restoreInstance(oldInstance) {
        instance = oldInstance;
    }

    // string denoting empty space in the board

    // The player whose turn it is drops a token in column `col`
    // returns the row the token was placed in or
    // false if no empty slot available in this col
    function makeMove(col) {
        var player = instance.players[instance.turn];
        var row = nextEmptyRow(col);

        if (row === false) {
            return false;
        } else {
            instance.board[row][col] = instance.turn;
            audit.log(player, ' drops a token in ', col);
            return row;
        }
    }

    // Return the next empty slot if it exists, else false
    function nextEmptyRow(col) {
        for (var i = instance.ySize - 1; i >= 0; i--) {
            if (instance.board[i][col] === EMPTY) {
                return i;
            }
        }
        return false;
    }

    /**
        Compute wheter a token dropped in `row,col` is a win or not
    */
    function isWon(row, col) {
        var player = instance.board[row][col];

        // Partially apply connection with player argument
        var predicate = connection.bind(null, player);

        /* Check for horizontal win */
        var leftPos = traverseWhile(predicate, stepLeft, row, col);
        var rightPos = traverseWhile(predicate, stepRight, row, col);
        // > 4 because both step functions will have stepped one step too much
        if (rightPos.j - leftPos.j > 4) {
            audit.log('win horizontally!');
            return true;
        }

        /* Check for vertical win */
        var downPos = traverseWhile(predicate, stepDown, row, col);
        var upPos = traverseWhile(predicate, stepUp, row, col);
        // > 4 because both step functions will have stepped one step too much
        if (upPos.i - downPos.i > 4) {
            audit.log('win  vertically!');
            return true;
        }

        /* Check for diagonal \ win */
        var downRightPos = traverseWhile(predicate, stepDownRight, row, col);
        var upLeftPos = traverseWhile(predicate, stepUpLeft, row, col);
        // > 4 because both step functions will have stepped one step too much
        if (upLeftPos.i - downRightPos.i > 4) {
            audit.log('win diagonally!');
            return true;
        }

        /* Check for diagonal / win */
        var downLeftPos = traverseWhile(predicate, stepDownLeft, row, col);
        var upRightPos = traverseWhile(predicate, stepUpRight, row, col);
        // > 4 because both step functions will have stepped one step too much
        if (upRightPos.i - downLeftPos.i > 4) {
            console.log('win diagonally!');
            return true;
        }

        function connection(token, r, c) {
            function sameToken(token, r, c) {
                return instance.board[r][c] == token;
            }

            function withinBoard(r, c) {
                return r >= 0 && r < instance.ySize && c >= 0 && c < instance.xSize;
            }

            return withinBoard(r, c) && sameToken(token, r, c);
        }

        /*
        Traverse the board while predicate `p` holds in direction specified
        by `next` from position (i,j). Return the end position as (i',j')
        */
        function traverseWhile(p, next, i, j) {
            var iEnd = i;
            var jEnd = j;

            while (p(iEnd, jEnd)) {
                var nextPos = next(iEnd, jEnd);
                iEnd = nextPos.i;
                jEnd = nextPos.j;
            }
            return {
                i: iEnd,
                j: jEnd
            };
        }

        function stepLeft(i, j) {
            return {
                i: i,
                j: +j - 1
            };
        }

        function stepRight(i, j) {
            return {
                i: i,
                j: +j + 1
            };
        }

        function stepUp(i, j) {
            return {
                i: +i + 1,
                j: j
            };
        }

        function stepDown(i, j) {
            return {
                i: +i - 1,
                j: j
            };
        }

        function stepUpLeft(i, j) {
            var pos = stepUp(i, j);
            return stepLeft(pos.i, pos.j);
        }

        function stepDownRight(i, j) {
            var pos = stepDown(i, j);
            return stepRight(pos.i, pos.j);
        }

        function stepUpRight(i, j) {
            var pos = stepUp(i, j);
            return stepRight(pos.i, pos.j);
        }

        function stepDownLeft(i, j) {
            var pos = stepDown(i, j);
            return stepLeft(pos.i, pos.j);
        }

        return false;
    }

    function logBoard() {
        var str = '';
        for (var m = 0; m < instance.ySize; m++) {
            for (var n = 0; n < instance.xSize; n++) {
                str += instance.board[m][n] + ' ';
            }
            str += '\n';
        }
        console.log(str);
    }

    // Set next player's turn in model and return her/his name (so that view can update)
    function nextTurn() {
        var nbrPlayers = instance.players.length;
        instance.turn = (instance.turn + 1) % nbrPlayers;
        return instance.players[instance.turn];
    }

    function setup(playerNames, xSize, ySize) {
        audit.log('setting up the game.');

        instance.players = playerNames;
        instance.xSize = xSize;
        instance.ySize = ySize;

        // Initiate the board as an array of arrays -> matrix
        // row-major layout
        instance.board = new Array(ySize);
        for (var i = 0; i < ySize; i++) {
            // The + before ySize is required to coerce xSize to int,
            // even though it is supposed to be an int
            instance.board[i] = new Array(+xSize);
        }

        audit.log('rows: ' + instance.board.length + '\ncols: ' + instance.board[0].length);
        resetBoard();

        // Draw a random player to start
        instance.turn = Math.floor(Math.random() * instance.players.length);
    }

    // Sets the whole board to be empty
    function resetBoard() {
        for (var m = 0; m < instance.ySize; m++) {
            for (var n = 0; n < instance.xSize; n++) {
                instance.board[m][n] = EMPTY;
            }
        }
    }

    // Return the name of the current player
    function currentPlayer() {
        return instance.players[instance.turn];
    }

    // Return the id of the current player
    function currentPlayerId() {
        return instance.turn;
    }
    return {
        setters: [function (_c) {
            audit = _c;
        }],
        execute: function () {
            _export('setup', setup);

            _export('makeMove', makeMove);

            _export('nextTurn', nextTurn);

            _export('isWon', isWon);

            _export('currentPlayer', currentPlayer);

            _export('currentPlayerId', currentPlayerId);

            _export('getInstance', getInstance);

            _export('restoreInstance', restoreInstance);

            _export('updateHighScore', updateHighScore);

            _export('getHighscore', getHighscore);

            _export('restoreHighscore', restoreHighscore);

            _export('nextEmptyRow', nextEmptyRow);

            instance = {
                turn: 0, // integer indicating whos turn it is
                players: [], // array of player names
                xSize: 7, // default value, will in practice be overruled
                ySize: 6, // default value, will in practice be overruled
                board: [] // will be set as a matrix representing the board
            };
            highscore = {};
            EMPTY = '_';
        }
    };
});
$__System.registerDynamic("e", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(exec) {
    try {
      return !!exec();
    } catch (e) {
      return true;
    }
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("f", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (typeof it != 'function')
      throw TypeError(it + ' is not a function!');
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("10", ["f"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var aFunction = $__require('f');
  module.exports = function(fn, that, length) {
    aFunction(fn);
    if (that === undefined)
      return fn;
    switch (length) {
      case 1:
        return function(a) {
          return fn.call(that, a);
        };
      case 2:
        return function(a, b) {
          return fn.call(that, a, b);
        };
      case 3:
        return function(a, b, c) {
          return fn.call(that, a, b, c);
        };
    }
    return function() {
      return fn.apply(that, arguments);
    };
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("11", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var core = module.exports = {version: '1.2.6'};
  if (typeof __e == 'number')
    __e = core;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("12", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = module.exports = typeof window != 'undefined' && window.Math == Math ? window : typeof self != 'undefined' && self.Math == Math ? self : Function('return this')();
  if (typeof __g == 'number')
    __g = global;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("13", ["12", "11", "10"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var global = $__require('12'),
      core = $__require('11'),
      ctx = $__require('10'),
      PROTOTYPE = 'prototype';
  var $export = function(type, name, source) {
    var IS_FORCED = type & $export.F,
        IS_GLOBAL = type & $export.G,
        IS_STATIC = type & $export.S,
        IS_PROTO = type & $export.P,
        IS_BIND = type & $export.B,
        IS_WRAP = type & $export.W,
        exports = IS_GLOBAL ? core : core[name] || (core[name] = {}),
        target = IS_GLOBAL ? global : IS_STATIC ? global[name] : (global[name] || {})[PROTOTYPE],
        key,
        own,
        out;
    if (IS_GLOBAL)
      source = name;
    for (key in source) {
      own = !IS_FORCED && target && key in target;
      if (own && key in exports)
        continue;
      out = own ? target[key] : source[key];
      exports[key] = IS_GLOBAL && typeof target[key] != 'function' ? source[key] : IS_BIND && own ? ctx(out, global) : IS_WRAP && target[key] == out ? (function(C) {
        var F = function(param) {
          return this instanceof C ? new C(param) : C(param);
        };
        F[PROTOTYPE] = C[PROTOTYPE];
        return F;
      })(out) : IS_PROTO && typeof out == 'function' ? ctx(Function.call, out) : out;
      if (IS_PROTO)
        (exports[PROTOTYPE] || (exports[PROTOTYPE] = {}))[key] = out;
    }
  };
  $export.F = 1;
  $export.G = 2;
  $export.S = 4;
  $export.P = 8;
  $export.B = 16;
  $export.W = 32;
  module.exports = $export;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("14", ["13", "11", "e"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var $export = $__require('13'),
      core = $__require('11'),
      fails = $__require('e');
  module.exports = function(KEY, exec) {
    var fn = (core.Object || {})[KEY] || Object[KEY],
        exp = {};
    exp[KEY] = exec(fn);
    $export($export.S + $export.F * fails(function() {
      fn(1);
    }), 'Object', exp);
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("15", [], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = function(it) {
    if (it == undefined)
      throw TypeError("Can't call method on  " + it);
    return it;
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("16", ["15"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var defined = $__require('15');
  module.exports = function(it) {
    return Object(defined(it));
  };
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("17", ["16", "14"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  var toObject = $__require('16');
  $__require('14')('keys', function($keys) {
    return function keys(it) {
      return $keys(toObject(it));
    };
  });
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("18", ["17", "11"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  $__require('17');
  module.exports = $__require('11').Object.keys;
  global.define = __define;
  return module.exports;
});

$__System.registerDynamic("19", ["18"], true, function($__require, exports, module) {
  ;
  var global = this,
      __define = global.define;
  global.define = undefined;
  module.exports = {
    "default": $__require('18'),
    __esModule: true
  };
  global.define = __define;
  return module.exports;
});

$__System.register('1', ['9', '19', 'd', 'b', 'c'], function (_export) {
    var tablesorter, _Object$keys, game, $, audit;

    return {
        setters: [function (_2) {
            tablesorter = _2['default'];
        }, function (_) {
            _Object$keys = _['default'];
        }, function (_d) {
            game = _d;
        }, function (_b) {
            $ = _b['default'];
        }, function (_c) {
            audit = _c;
        }],
        execute: function () {
            /*
            main.js
            The main JS script, handling the view (manipulating DOM), calling appropiate functions on
            the model in connectFour.js, here referenced simply as `game`.
            */

            'use strict';

            $(document).ready(function () {

                /* HTML5 local storage extension to easily handle objects */
                Storage.prototype.setObject = function (key, value) {
                    this.setItem(key, JSON.stringify(value));
                };
                Storage.prototype.getObject = function (key) {
                    var value = this.getItem(key);
                    return value && JSON.parse(value);
                };

                // Restore the log
                audit.restore();
                audit.log('App started');
                // Restore old instance
                restoreOldInstance();
                // Fill in highscore list if saved
                updateHighscore();

                /**
                Attach event handler for pressing the `Show audit log` button
                */
                $('#auditButton').click(function () {
                    var theLog = audit.restore();
                    $('#auditLog').empty();
                    for (var i = theLog.length - 1; i >= 0; i--) {
                        $('#auditLog').append('<li>' + theLog[i] + '</li>');
                    }
                    if (theLog.length > 0) {
                        $('#auditLog').toggle();
                    }
                });

                /**
                Attach event handler for pressing the `Play` button
                */
                $('#settings').submit(function (event) {
                    event.preventDefault();
                    event.target.checkValidity();

                    var playerNames = [getById('player1').value, getById('player2').value];

                    var xSize = getById('x-size').value;
                    var ySize = getById('y-size').value;

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

                    for (var i = 0; i < x; i++) {
                        table.appendChild(create('colgroup'));
                    }
                    table.appendChild(tbody);

                    for (var i = 0; i < y; i++) {
                        var row = create('tr');
                        for (var j = 0; j < x; j++) {
                            var cell = create('td');
                            var div = create('div');
                            // Set some x and y coordinates for the div inside the cell,
                            // these will be used to know which column was clicked
                            div.dataset.x = j;
                            div.dataset.y = i;
                            div.className = 'cell';
                            div.classList.add('index' + j + '-' + i);
                            cell.appendChild(div);
                            row.appendChild(cell);
                        }
                        tbody.appendChild(row);
                    }

                    // Turn indicator
                    var turnIndicator = create('div');
                    turnIndicator.id = 'turn-indicator';
                    getById('game').appendChild(turnIndicator);

                    // Append the table after the turn indicator
                    getById('game').appendChild(table);

                    // To handle different table sizes, we must set the width here
                    $('#gameBoard td').css('width', 100 / x);

                    // Reset button
                    var resetButton = create('button');
                    resetButton.appendChild(document.createTextNode('Reset'));
                    resetButton.id = 'resetButton';
                    getById('game').appendChild(resetButton);

                    // Add `Reset` button event handler
                    $('#resetButton').on('click', reset);

                    /* When player hovers over a column, that players token will be
                    temporarily placed on the next available position in the column */
                    $('td').hover(function () {
                        var col = $(this).find('.cell').data('x');
                        var row = game.nextEmptyRow(col);
                        var player = game.currentPlayerId();
                        if (row !== false) {
                            // explicitly check false because 0 is ok
                            $('.index' + col + '-' + row).addClass('hoverCell' + player);
                        }
                    }, function () {
                        var col = $(this).find('.cell').data('x');
                        var row = game.nextEmptyRow(col);
                        var player = game.currentPlayerId();
                        if (row !== false) {
                            $('.index' + col + '-' + row).removeClass('hoverCell' + player);
                        }
                    });

                    // Attach event handler for clicking on column = making a move
                    $('#game').on('click', '#gameBoard tr td', function (e) {
                        var col = $(this).children()[0].dataset.x;
                        var row = game.makeMove(col);
                        if (row === false) {
                            alert('no space in this column');
                        } else {
                            // only update if makeMove was somehow succesful
                            console.log('placed in row ' + row);
                            getCell(row, col).classList.add('marker' + game.currentPlayerId());
                            if (game.isWon(row, col)) {
                                // Display winner message
                                $('#turn-indicator').text('Congratulations, ' + game.currentPlayer() + '! You have won the game!');
                                // Prevent players from making any more moves
                                $('#game').off();
                                $('#gameBoard td').off();
                                // Change text of reset button to 'Play again'
                                $('#resetButton').text('Play again!');
                                game.updateHighScore(game.currentPlayer());
                                console.info(game.currentPlayer() + ' won the game, deleting instance');
                                localStorage.removeItem('instance');
                                console.info('Saving highscore object');
                                localStorage.setObject('highscore', game.getHighscore());
                                updateHighscore();
                            } else {
                                updateTurnIndicator(game.nextTurn());
                                // Save instance to persistent storage
                                localStorage.setObject('instance', game.getInstance());
                            }
                        }
                    });
                };

                // Get the DOM element at (row,col)
                function getCell(row, col) {
                    return document.getElementsByClassName('index' + col + '-' + row)[0];
                }

                function reset(event) {
                    $('#game').off(); // remove click listeners
                    $('#gameBoard').remove();
                    $('#turn-indicator').remove();
                    $('#resetButton').remove();
                    $('#settingsWrapper').show();
                    $('#auditWrapper').show();
                    $('#highscoreWrapper').show();
                    updateHighscore();
                    localStorage.removeItem('instance');
                    audit.log('Stored game instance deleted');
                }

                // Update the highscore view and model with the latest from localStorage
                function updateHighscore() {
                    var highscore = localStorage.getObject('highscore');
                    if (typeof highscore !== 'undefined' && highscore) {
                        game.restoreHighscore(highscore);

                        $('#highscore tbody').empty();
                        _Object$keys(highscore).forEach(function (name) {
                            $('#highscore').append('<tr><td>' + name + '</td><td>' + highscore[name] + '</td></tr>');
                        });
                        $('#highscore').tablesorter({ sortList: [[1, 1], [0, 0]] });
                        $('#highscore').trigger('update');
                        $('#highscore').show();
                    }
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
                    var oldInstance = localStorage.getObject('instance');
                    if (typeof oldInstance !== 'undefined' && oldInstance) {
                        $('#settingsWrapper').hide();
                        game.restoreInstance(oldInstance);
                        createBoard(oldInstance.xSize, oldInstance.ySize);
                        updateTurnIndicator(game.currentPlayer()); // note: currentPlayer() and not nextTurn()
                        // Update board according to the instance
                        for (var m = 0; m < oldInstance.ySize; m++) {
                            for (var n = 0; n < oldInstance.xSize; n++) {
                                var cellId = oldInstance.board[m][n];
                                if (cellId !== '_') {
                                    getCell(m, n).classList.add('marker' + cellId);
                                }
                            }
                        }
                    } else {
                        audit.log('No previous game instance found');
                    }
                }
            });
        }
    };
});
})
(function(factory) {
  factory();
});
//# sourceMappingURL=app-v0.1.0.js.map