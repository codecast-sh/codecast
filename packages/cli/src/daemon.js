#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};

// src/daemon.ts
import * as fs14 from "fs";
import * as os2 from "os";
import * as path13 from "path";
import { Database as Database3 } from "bun:sqlite";
import { execSync as execSync2, execFileSync, exec as exec2, execFile, spawn } from "child_process";

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/index.js
import { stat as statcb } from "fs";
import { stat as stat3, readdir as readdir2 } from "fs/promises";
import { EventEmitter } from "events";
import * as sysPath2 from "path";

// node_modules/.pnpm/readdirp@4.1.2/node_modules/readdirp/esm/index.js
import { stat, lstat, readdir, realpath } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolve as presolve, relative as prelative, join as pjoin, sep as psep } from "node:path";
var EntryTypes = {
  FILE_TYPE: "files",
  DIR_TYPE: "directories",
  FILE_DIR_TYPE: "files_directories",
  EVERYTHING_TYPE: "all"
};
var defaultOptions = {
  root: ".",
  fileFilter: (_entryInfo) => true,
  directoryFilter: (_entryInfo) => true,
  type: EntryTypes.FILE_TYPE,
  lstat: false,
  depth: 2147483648,
  alwaysStat: false,
  highWaterMark: 4096
};
Object.freeze(defaultOptions);
var RECURSIVE_ERROR_CODE = "READDIRP_RECURSIVE_ERROR";
var NORMAL_FLOW_ERRORS = new Set(["ENOENT", "EPERM", "EACCES", "ELOOP", RECURSIVE_ERROR_CODE]);
var ALL_TYPES = [
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
];
var DIR_TYPES = new Set([
  EntryTypes.DIR_TYPE,
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE
]);
var FILE_TYPES = new Set([
  EntryTypes.EVERYTHING_TYPE,
  EntryTypes.FILE_DIR_TYPE,
  EntryTypes.FILE_TYPE
]);
var isNormalFlowError = (error) => NORMAL_FLOW_ERRORS.has(error.code);
var wantBigintFsStats = process.platform === "win32";
var emptyFn = (_entryInfo) => true;
var normalizeFilter = (filter) => {
  if (filter === undefined)
    return emptyFn;
  if (typeof filter === "function")
    return filter;
  if (typeof filter === "string") {
    const fl = filter.trim();
    return (entry) => entry.basename === fl;
  }
  if (Array.isArray(filter)) {
    const trItems = filter.map((item) => item.trim());
    return (entry) => trItems.some((f) => entry.basename === f);
  }
  return emptyFn;
};

class ReaddirpStream extends Readable {
  constructor(options = {}) {
    super({
      objectMode: true,
      autoDestroy: true,
      highWaterMark: options.highWaterMark
    });
    const opts = { ...defaultOptions, ...options };
    const { root, type } = opts;
    this._fileFilter = normalizeFilter(opts.fileFilter);
    this._directoryFilter = normalizeFilter(opts.directoryFilter);
    const statMethod = opts.lstat ? lstat : stat;
    if (wantBigintFsStats) {
      this._stat = (path) => statMethod(path, { bigint: true });
    } else {
      this._stat = statMethod;
    }
    this._maxDepth = opts.depth ?? defaultOptions.depth;
    this._wantsDir = type ? DIR_TYPES.has(type) : false;
    this._wantsFile = type ? FILE_TYPES.has(type) : false;
    this._wantsEverything = type === EntryTypes.EVERYTHING_TYPE;
    this._root = presolve(root);
    this._isDirent = !opts.alwaysStat;
    this._statsProp = this._isDirent ? "dirent" : "stats";
    this._rdOptions = { encoding: "utf8", withFileTypes: this._isDirent };
    this.parents = [this._exploreDir(root, 1)];
    this.reading = false;
    this.parent = undefined;
  }
  async _read(batch) {
    if (this.reading)
      return;
    this.reading = true;
    try {
      while (!this.destroyed && batch > 0) {
        const par = this.parent;
        const fil = par && par.files;
        if (fil && fil.length > 0) {
          const { path, depth } = par;
          const slice = fil.splice(0, batch).map((dirent) => this._formatEntry(dirent, path));
          const awaited = await Promise.all(slice);
          for (const entry of awaited) {
            if (!entry)
              continue;
            if (this.destroyed)
              return;
            const entryType = await this._getEntryType(entry);
            if (entryType === "directory" && this._directoryFilter(entry)) {
              if (depth <= this._maxDepth) {
                this.parents.push(this._exploreDir(entry.fullPath, depth + 1));
              }
              if (this._wantsDir) {
                this.push(entry);
                batch--;
              }
            } else if ((entryType === "file" || this._includeAsFile(entry)) && this._fileFilter(entry)) {
              if (this._wantsFile) {
                this.push(entry);
                batch--;
              }
            }
          }
        } else {
          const parent = this.parents.pop();
          if (!parent) {
            this.push(null);
            break;
          }
          this.parent = await parent;
          if (this.destroyed)
            return;
        }
      }
    } catch (error) {
      this.destroy(error);
    } finally {
      this.reading = false;
    }
  }
  async _exploreDir(path, depth) {
    let files;
    try {
      files = await readdir(path, this._rdOptions);
    } catch (error) {
      this._onError(error);
    }
    return { files, depth, path };
  }
  async _formatEntry(dirent, path) {
    let entry;
    const basename = this._isDirent ? dirent.name : dirent;
    try {
      const fullPath = presolve(pjoin(path, basename));
      entry = { path: prelative(this._root, fullPath), fullPath, basename };
      entry[this._statsProp] = this._isDirent ? dirent : await this._stat(fullPath);
    } catch (err) {
      this._onError(err);
      return;
    }
    return entry;
  }
  _onError(err) {
    if (isNormalFlowError(err) && !this.destroyed) {
      this.emit("warn", err);
    } else {
      this.destroy(err);
    }
  }
  async _getEntryType(entry) {
    if (!entry && this._statsProp in entry) {
      return "";
    }
    const stats = entry[this._statsProp];
    if (stats.isFile())
      return "file";
    if (stats.isDirectory())
      return "directory";
    if (stats && stats.isSymbolicLink()) {
      const full = entry.fullPath;
      try {
        const entryRealPath = await realpath(full);
        const entryRealPathStats = await lstat(entryRealPath);
        if (entryRealPathStats.isFile()) {
          return "file";
        }
        if (entryRealPathStats.isDirectory()) {
          const len = entryRealPath.length;
          if (full.startsWith(entryRealPath) && full.substr(len, 1) === psep) {
            const recursiveError = new Error(`Circular symlink detected: "${full}" points to "${entryRealPath}"`);
            recursiveError.code = RECURSIVE_ERROR_CODE;
            return this._onError(recursiveError);
          }
          return "directory";
        }
      } catch (error) {
        this._onError(error);
        return "";
      }
    }
  }
  _includeAsFile(entry) {
    const stats = entry && entry[this._statsProp];
    return stats && this._wantsEverything && !stats.isDirectory();
  }
}
function readdirp(root, options = {}) {
  let type = options.entryType || options.type;
  if (type === "both")
    type = EntryTypes.FILE_DIR_TYPE;
  if (type)
    options.type = type;
  if (!root) {
    throw new Error("readdirp: root argument is required. Usage: readdirp(root, options)");
  } else if (typeof root !== "string") {
    throw new TypeError("readdirp: root argument must be a string. Usage: readdirp(root, options)");
  } else if (type && !ALL_TYPES.includes(type)) {
    throw new Error(`readdirp: Invalid type passed. Use one of ${ALL_TYPES.join(", ")}`);
  }
  options.root = root;
  return new ReaddirpStream(options);
}

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/handler.js
import { watchFile, unwatchFile, watch as fs_watch } from "fs";
import { open, stat as stat2, lstat as lstat2, realpath as fsrealpath } from "fs/promises";
import * as sysPath from "path";
import { type as osType } from "os";
var STR_DATA = "data";
var STR_END = "end";
var STR_CLOSE = "close";
var EMPTY_FN = () => {
};
var pl = process.platform;
var isWindows = pl === "win32";
var isMacos = pl === "darwin";
var isLinux = pl === "linux";
var isFreeBSD = pl === "freebsd";
var isIBMi = osType() === "OS400";
var EVENTS = {
  ALL: "all",
  READY: "ready",
  ADD: "add",
  CHANGE: "change",
  ADD_DIR: "addDir",
  UNLINK: "unlink",
  UNLINK_DIR: "unlinkDir",
  RAW: "raw",
  ERROR: "error"
};
var EV = EVENTS;
var THROTTLE_MODE_WATCH = "watch";
var statMethods = { lstat: lstat2, stat: stat2 };
var KEY_LISTENERS = "listeners";
var KEY_ERR = "errHandlers";
var KEY_RAW = "rawEmitters";
var HANDLER_KEYS = [KEY_LISTENERS, KEY_ERR, KEY_RAW];
var binaryExtensions = new Set([
  "3dm",
  "3ds",
  "3g2",
  "3gp",
  "7z",
  "a",
  "aac",
  "adp",
  "afdesign",
  "afphoto",
  "afpub",
  "ai",
  "aif",
  "aiff",
  "alz",
  "ape",
  "apk",
  "appimage",
  "ar",
  "arj",
  "asf",
  "au",
  "avi",
  "bak",
  "baml",
  "bh",
  "bin",
  "bk",
  "bmp",
  "btif",
  "bz2",
  "bzip2",
  "cab",
  "caf",
  "cgm",
  "class",
  "cmx",
  "cpio",
  "cr2",
  "cur",
  "dat",
  "dcm",
  "deb",
  "dex",
  "djvu",
  "dll",
  "dmg",
  "dng",
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dra",
  "DS_Store",
  "dsk",
  "dts",
  "dtshd",
  "dvb",
  "dwg",
  "dxf",
  "ecelp4800",
  "ecelp7470",
  "ecelp9600",
  "egg",
  "eol",
  "eot",
  "epub",
  "exe",
  "f4v",
  "fbs",
  "fh",
  "fla",
  "flac",
  "flatpak",
  "fli",
  "flv",
  "fpx",
  "fst",
  "fvt",
  "g3",
  "gh",
  "gif",
  "graffle",
  "gz",
  "gzip",
  "h261",
  "h263",
  "h264",
  "icns",
  "ico",
  "ief",
  "img",
  "ipa",
  "iso",
  "jar",
  "jpeg",
  "jpg",
  "jpgv",
  "jpm",
  "jxr",
  "key",
  "ktx",
  "lha",
  "lib",
  "lvp",
  "lz",
  "lzh",
  "lzma",
  "lzo",
  "m3u",
  "m4a",
  "m4v",
  "mar",
  "mdi",
  "mht",
  "mid",
  "midi",
  "mj2",
  "mka",
  "mkv",
  "mmr",
  "mng",
  "mobi",
  "mov",
  "movie",
  "mp3",
  "mp4",
  "mp4a",
  "mpeg",
  "mpg",
  "mpga",
  "mxu",
  "nef",
  "npx",
  "numbers",
  "nupkg",
  "o",
  "odp",
  "ods",
  "odt",
  "oga",
  "ogg",
  "ogv",
  "otf",
  "ott",
  "pages",
  "pbm",
  "pcx",
  "pdb",
  "pdf",
  "pea",
  "pgm",
  "pic",
  "png",
  "pnm",
  "pot",
  "potm",
  "potx",
  "ppa",
  "ppam",
  "ppm",
  "pps",
  "ppsm",
  "ppsx",
  "ppt",
  "pptm",
  "pptx",
  "psd",
  "pya",
  "pyc",
  "pyo",
  "pyv",
  "qt",
  "rar",
  "ras",
  "raw",
  "resources",
  "rgb",
  "rip",
  "rlc",
  "rmf",
  "rmvb",
  "rpm",
  "rtf",
  "rz",
  "s3m",
  "s7z",
  "scpt",
  "sgi",
  "shar",
  "snap",
  "sil",
  "sketch",
  "slk",
  "smv",
  "snk",
  "so",
  "stl",
  "suo",
  "sub",
  "swf",
  "tar",
  "tbz",
  "tbz2",
  "tga",
  "tgz",
  "thmx",
  "tif",
  "tiff",
  "tlz",
  "ttc",
  "ttf",
  "txz",
  "udf",
  "uvh",
  "uvi",
  "uvm",
  "uvp",
  "uvs",
  "uvu",
  "viv",
  "vob",
  "war",
  "wav",
  "wax",
  "wbmp",
  "wdp",
  "weba",
  "webm",
  "webp",
  "whl",
  "wim",
  "wm",
  "wma",
  "wmv",
  "wmx",
  "woff",
  "woff2",
  "wrm",
  "wvx",
  "xbm",
  "xif",
  "xla",
  "xlam",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "xm",
  "xmind",
  "xpi",
  "xpm",
  "xwd",
  "xz",
  "z",
  "zip",
  "zipx"
]);
var isBinaryPath = (filePath) => binaryExtensions.has(sysPath.extname(filePath).slice(1).toLowerCase());
var foreach = (val, fn) => {
  if (val instanceof Set) {
    val.forEach(fn);
  } else {
    fn(val);
  }
};
var addAndConvert = (main, prop, item) => {
  let container = main[prop];
  if (!(container instanceof Set)) {
    main[prop] = container = new Set([container]);
  }
  container.add(item);
};
var clearItem = (cont) => (key) => {
  const set = cont[key];
  if (set instanceof Set) {
    set.clear();
  } else {
    delete cont[key];
  }
};
var delFromSet = (main, prop, item) => {
  const container = main[prop];
  if (container instanceof Set) {
    container.delete(item);
  } else if (container === item) {
    delete main[prop];
  }
};
var isEmptySet = (val) => val instanceof Set ? val.size === 0 : !val;
var FsWatchInstances = new Map;
function createFsWatchInstance(path, options, listener, errHandler, emitRaw) {
  const handleEvent = (rawEvent, evPath) => {
    listener(path);
    emitRaw(rawEvent, evPath, { watchedPath: path });
    if (evPath && path !== evPath) {
      fsWatchBroadcast(sysPath.resolve(path, evPath), KEY_LISTENERS, sysPath.join(path, evPath));
    }
  };
  try {
    return fs_watch(path, {
      persistent: options.persistent
    }, handleEvent);
  } catch (error) {
    errHandler(error);
    return;
  }
}
var fsWatchBroadcast = (fullPath, listenerType, val1, val2, val3) => {
  const cont = FsWatchInstances.get(fullPath);
  if (!cont)
    return;
  foreach(cont[listenerType], (listener) => {
    listener(val1, val2, val3);
  });
};
var setFsWatchListener = (path, fullPath, options, handlers) => {
  const { listener, errHandler, rawEmitter } = handlers;
  let cont = FsWatchInstances.get(fullPath);
  let watcher;
  if (!options.persistent) {
    watcher = createFsWatchInstance(path, options, listener, errHandler, rawEmitter);
    if (!watcher)
      return;
    return watcher.close.bind(watcher);
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_ERR, errHandler);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    watcher = createFsWatchInstance(path, options, fsWatchBroadcast.bind(null, fullPath, KEY_LISTENERS), errHandler, fsWatchBroadcast.bind(null, fullPath, KEY_RAW));
    if (!watcher)
      return;
    watcher.on(EV.ERROR, async (error) => {
      const broadcastErr = fsWatchBroadcast.bind(null, fullPath, KEY_ERR);
      if (cont)
        cont.watcherUnusable = true;
      if (isWindows && error.code === "EPERM") {
        try {
          const fd = await open(path, "r");
          await fd.close();
          broadcastErr(error);
        } catch (err) {
        }
      } else {
        broadcastErr(error);
      }
    });
    cont = {
      listeners: listener,
      errHandlers: errHandler,
      rawEmitters: rawEmitter,
      watcher
    };
    FsWatchInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_ERR, errHandler);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      cont.watcher.close();
      FsWatchInstances.delete(fullPath);
      HANDLER_KEYS.forEach(clearItem(cont));
      cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};
var FsWatchFileInstances = new Map;
var setFsWatchFileListener = (path, fullPath, options, handlers) => {
  const { listener, rawEmitter } = handlers;
  let cont = FsWatchFileInstances.get(fullPath);
  const copts = cont && cont.options;
  if (copts && (copts.persistent < options.persistent || copts.interval > options.interval)) {
    unwatchFile(fullPath);
    cont = undefined;
  }
  if (cont) {
    addAndConvert(cont, KEY_LISTENERS, listener);
    addAndConvert(cont, KEY_RAW, rawEmitter);
  } else {
    cont = {
      listeners: listener,
      rawEmitters: rawEmitter,
      options,
      watcher: watchFile(fullPath, options, (curr, prev) => {
        foreach(cont.rawEmitters, (rawEmitter2) => {
          rawEmitter2(EV.CHANGE, fullPath, { curr, prev });
        });
        const currmtime = curr.mtimeMs;
        if (curr.size !== prev.size || currmtime > prev.mtimeMs || currmtime === 0) {
          foreach(cont.listeners, (listener2) => listener2(path, curr));
        }
      })
    };
    FsWatchFileInstances.set(fullPath, cont);
  }
  return () => {
    delFromSet(cont, KEY_LISTENERS, listener);
    delFromSet(cont, KEY_RAW, rawEmitter);
    if (isEmptySet(cont.listeners)) {
      FsWatchFileInstances.delete(fullPath);
      unwatchFile(fullPath);
      cont.options = cont.watcher = undefined;
      Object.freeze(cont);
    }
  };
};

class NodeFsHandler {
  constructor(fsW) {
    this.fsw = fsW;
    this._boundHandleError = (error) => fsW._handleError(error);
  }
  _watchWithNodeFs(path, listener) {
    const opts = this.fsw.options;
    const directory = sysPath.dirname(path);
    const basename2 = sysPath.basename(path);
    const parent = this.fsw._getWatchedDir(directory);
    parent.add(basename2);
    const absolutePath = sysPath.resolve(path);
    const options = {
      persistent: opts.persistent
    };
    if (!listener)
      listener = EMPTY_FN;
    let closer;
    if (opts.usePolling) {
      const enableBin = opts.interval !== opts.binaryInterval;
      options.interval = enableBin && isBinaryPath(basename2) ? opts.binaryInterval : opts.interval;
      closer = setFsWatchFileListener(path, absolutePath, options, {
        listener,
        rawEmitter: this.fsw._emitRaw
      });
    } else {
      closer = setFsWatchListener(path, absolutePath, options, {
        listener,
        errHandler: this._boundHandleError,
        rawEmitter: this.fsw._emitRaw
      });
    }
    return closer;
  }
  _handleFile(file, stats, initialAdd) {
    if (this.fsw.closed) {
      return;
    }
    const dirname2 = sysPath.dirname(file);
    const basename2 = sysPath.basename(file);
    const parent = this.fsw._getWatchedDir(dirname2);
    let prevStats = stats;
    if (parent.has(basename2))
      return;
    const listener = async (path, newStats) => {
      if (!this.fsw._throttle(THROTTLE_MODE_WATCH, file, 5))
        return;
      if (!newStats || newStats.mtimeMs === 0) {
        try {
          const newStats2 = await stat2(file);
          if (this.fsw.closed)
            return;
          const at = newStats2.atimeMs;
          const mt = newStats2.mtimeMs;
          if (!at || at <= mt || mt !== prevStats.mtimeMs) {
            this.fsw._emit(EV.CHANGE, file, newStats2);
          }
          if ((isMacos || isLinux || isFreeBSD) && prevStats.ino !== newStats2.ino) {
            this.fsw._closeFile(path);
            prevStats = newStats2;
            const closer2 = this._watchWithNodeFs(file, listener);
            if (closer2)
              this.fsw._addPathCloser(path, closer2);
          } else {
            prevStats = newStats2;
          }
        } catch (error) {
          this.fsw._remove(dirname2, basename2);
        }
      } else if (parent.has(basename2)) {
        const at = newStats.atimeMs;
        const mt = newStats.mtimeMs;
        if (!at || at <= mt || mt !== prevStats.mtimeMs) {
          this.fsw._emit(EV.CHANGE, file, newStats);
        }
        prevStats = newStats;
      }
    };
    const closer = this._watchWithNodeFs(file, listener);
    if (!(initialAdd && this.fsw.options.ignoreInitial) && this.fsw._isntIgnored(file)) {
      if (!this.fsw._throttle(EV.ADD, file, 0))
        return;
      this.fsw._emit(EV.ADD, file, stats);
    }
    return closer;
  }
  async _handleSymlink(entry, directory, path, item) {
    if (this.fsw.closed) {
      return;
    }
    const full = entry.fullPath;
    const dir = this.fsw._getWatchedDir(directory);
    if (!this.fsw.options.followSymlinks) {
      this.fsw._incrReadyCount();
      let linkPath;
      try {
        linkPath = await fsrealpath(path);
      } catch (e) {
        this.fsw._emitReady();
        return true;
      }
      if (this.fsw.closed)
        return;
      if (dir.has(item)) {
        if (this.fsw._symlinkPaths.get(full) !== linkPath) {
          this.fsw._symlinkPaths.set(full, linkPath);
          this.fsw._emit(EV.CHANGE, path, entry.stats);
        }
      } else {
        dir.add(item);
        this.fsw._symlinkPaths.set(full, linkPath);
        this.fsw._emit(EV.ADD, path, entry.stats);
      }
      this.fsw._emitReady();
      return true;
    }
    if (this.fsw._symlinkPaths.has(full)) {
      return true;
    }
    this.fsw._symlinkPaths.set(full, true);
  }
  _handleRead(directory, initialAdd, wh, target, dir, depth, throttler) {
    directory = sysPath.join(directory, "");
    throttler = this.fsw._throttle("readdir", directory, 1000);
    if (!throttler)
      return;
    const previous = this.fsw._getWatchedDir(wh.path);
    const current = new Set;
    let stream = this.fsw._readdirp(directory, {
      fileFilter: (entry) => wh.filterPath(entry),
      directoryFilter: (entry) => wh.filterDir(entry)
    });
    if (!stream)
      return;
    stream.on(STR_DATA, async (entry) => {
      if (this.fsw.closed) {
        stream = undefined;
        return;
      }
      const item = entry.path;
      let path = sysPath.join(directory, item);
      current.add(item);
      if (entry.stats.isSymbolicLink() && await this._handleSymlink(entry, directory, path, item)) {
        return;
      }
      if (this.fsw.closed) {
        stream = undefined;
        return;
      }
      if (item === target || !target && !previous.has(item)) {
        this.fsw._incrReadyCount();
        path = sysPath.join(dir, sysPath.relative(dir, path));
        this._addToNodeFs(path, initialAdd, wh, depth + 1);
      }
    }).on(EV.ERROR, this._boundHandleError);
    return new Promise((resolve2, reject) => {
      if (!stream)
        return reject();
      stream.once(STR_END, () => {
        if (this.fsw.closed) {
          stream = undefined;
          return;
        }
        const wasThrottled = throttler ? throttler.clear() : false;
        resolve2(undefined);
        previous.getChildren().filter((item) => {
          return item !== directory && !current.has(item);
        }).forEach((item) => {
          this.fsw._remove(directory, item);
        });
        stream = undefined;
        if (wasThrottled)
          this._handleRead(directory, false, wh, target, dir, depth, throttler);
      });
    });
  }
  async _handleDir(dir, stats, initialAdd, depth, target, wh, realpath2) {
    const parentDir = this.fsw._getWatchedDir(sysPath.dirname(dir));
    const tracked = parentDir.has(sysPath.basename(dir));
    if (!(initialAdd && this.fsw.options.ignoreInitial) && !target && !tracked) {
      this.fsw._emit(EV.ADD_DIR, dir, stats);
    }
    parentDir.add(sysPath.basename(dir));
    this.fsw._getWatchedDir(dir);
    let throttler;
    let closer;
    const oDepth = this.fsw.options.depth;
    if ((oDepth == null || depth <= oDepth) && !this.fsw._symlinkPaths.has(realpath2)) {
      if (!target) {
        await this._handleRead(dir, initialAdd, wh, target, dir, depth, throttler);
        if (this.fsw.closed)
          return;
      }
      closer = this._watchWithNodeFs(dir, (dirPath, stats2) => {
        if (stats2 && stats2.mtimeMs === 0)
          return;
        this._handleRead(dirPath, false, wh, target, dir, depth, throttler);
      });
    }
    return closer;
  }
  async _addToNodeFs(path, initialAdd, priorWh, depth, target) {
    const ready = this.fsw._emitReady;
    if (this.fsw._isIgnored(path) || this.fsw.closed) {
      ready();
      return false;
    }
    const wh = this.fsw._getWatchHelpers(path);
    if (priorWh) {
      wh.filterPath = (entry) => priorWh.filterPath(entry);
      wh.filterDir = (entry) => priorWh.filterDir(entry);
    }
    try {
      const stats = await statMethods[wh.statMethod](wh.watchPath);
      if (this.fsw.closed)
        return;
      if (this.fsw._isIgnored(wh.watchPath, stats)) {
        ready();
        return false;
      }
      const follow = this.fsw.options.followSymlinks;
      let closer;
      if (stats.isDirectory()) {
        const absPath = sysPath.resolve(path);
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed)
          return;
        closer = await this._handleDir(wh.watchPath, stats, initialAdd, depth, target, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (absPath !== targetPath && targetPath !== undefined) {
          this.fsw._symlinkPaths.set(absPath, targetPath);
        }
      } else if (stats.isSymbolicLink()) {
        const targetPath = follow ? await fsrealpath(path) : path;
        if (this.fsw.closed)
          return;
        const parent = sysPath.dirname(wh.watchPath);
        this.fsw._getWatchedDir(parent).add(wh.watchPath);
        this.fsw._emit(EV.ADD, wh.watchPath, stats);
        closer = await this._handleDir(parent, stats, initialAdd, depth, path, wh, targetPath);
        if (this.fsw.closed)
          return;
        if (targetPath !== undefined) {
          this.fsw._symlinkPaths.set(sysPath.resolve(path), targetPath);
        }
      } else {
        closer = this._handleFile(wh.watchPath, stats, initialAdd);
      }
      ready();
      if (closer)
        this.fsw._addPathCloser(path, closer);
      return false;
    } catch (error) {
      if (this.fsw._handleError(error)) {
        ready();
        return path;
      }
    }
  }
}

// node_modules/.pnpm/chokidar@4.0.3/node_modules/chokidar/esm/index.js
/*! chokidar - MIT License (c) 2012 Paul Miller (paulmillr.com) */
var SLASH = "/";
var SLASH_SLASH = "//";
var ONE_DOT = ".";
var TWO_DOTS = "..";
var STRING_TYPE = "string";
var BACK_SLASH_RE = /\\/g;
var DOUBLE_SLASH_RE = /\/\//;
var DOT_RE = /\..*\.(sw[px])$|~$|\.subl.*\.tmp/;
var REPLACER_RE = /^\.[/\\]/;
function arrify(item) {
  return Array.isArray(item) ? item : [item];
}
var isMatcherObject = (matcher) => typeof matcher === "object" && matcher !== null && !(matcher instanceof RegExp);
function createPattern(matcher) {
  if (typeof matcher === "function")
    return matcher;
  if (typeof matcher === "string")
    return (string) => matcher === string;
  if (matcher instanceof RegExp)
    return (string) => matcher.test(string);
  if (typeof matcher === "object" && matcher !== null) {
    return (string) => {
      if (matcher.path === string)
        return true;
      if (matcher.recursive) {
        const relative3 = sysPath2.relative(matcher.path, string);
        if (!relative3) {
          return false;
        }
        return !relative3.startsWith("..") && !sysPath2.isAbsolute(relative3);
      }
      return false;
    };
  }
  return () => false;
}
function normalizePath(path) {
  if (typeof path !== "string")
    throw new Error("string expected");
  path = sysPath2.normalize(path);
  path = path.replace(/\\/g, "/");
  let prepend = false;
  if (path.startsWith("//"))
    prepend = true;
  const DOUBLE_SLASH_RE2 = /\/\//;
  while (path.match(DOUBLE_SLASH_RE2))
    path = path.replace(DOUBLE_SLASH_RE2, "/");
  if (prepend)
    path = "/" + path;
  return path;
}
function matchPatterns(patterns, testString, stats) {
  const path = normalizePath(testString);
  for (let index = 0;index < patterns.length; index++) {
    const pattern = patterns[index];
    if (pattern(path, stats)) {
      return true;
    }
  }
  return false;
}
function anymatch(matchers, testString) {
  if (matchers == null) {
    throw new TypeError("anymatch: specify first argument");
  }
  const matchersArray = arrify(matchers);
  const patterns = matchersArray.map((matcher) => createPattern(matcher));
  if (testString == null) {
    return (testString2, stats) => {
      return matchPatterns(patterns, testString2, stats);
    };
  }
  return matchPatterns(patterns, testString);
}
var unifyPaths = (paths_) => {
  const paths = arrify(paths_).flat();
  if (!paths.every((p) => typeof p === STRING_TYPE)) {
    throw new TypeError(`Non-string provided as watch path: ${paths}`);
  }
  return paths.map(normalizePathToUnix);
};
var toUnix = (string) => {
  let str = string.replace(BACK_SLASH_RE, SLASH);
  let prepend = false;
  if (str.startsWith(SLASH_SLASH)) {
    prepend = true;
  }
  while (str.match(DOUBLE_SLASH_RE)) {
    str = str.replace(DOUBLE_SLASH_RE, SLASH);
  }
  if (prepend) {
    str = SLASH + str;
  }
  return str;
};
var normalizePathToUnix = (path) => toUnix(sysPath2.normalize(toUnix(path)));
var normalizeIgnored = (cwd = "") => (path) => {
  if (typeof path === "string") {
    return normalizePathToUnix(sysPath2.isAbsolute(path) ? path : sysPath2.join(cwd, path));
  } else {
    return path;
  }
};
var getAbsolutePath = (path, cwd) => {
  if (sysPath2.isAbsolute(path)) {
    return path;
  }
  return sysPath2.join(cwd, path);
};
var EMPTY_SET = Object.freeze(new Set);

class DirEntry {
  constructor(dir, removeWatcher) {
    this.path = dir;
    this._removeWatcher = removeWatcher;
    this.items = new Set;
  }
  add(item) {
    const { items } = this;
    if (!items)
      return;
    if (item !== ONE_DOT && item !== TWO_DOTS)
      items.add(item);
  }
  async remove(item) {
    const { items } = this;
    if (!items)
      return;
    items.delete(item);
    if (items.size > 0)
      return;
    const dir = this.path;
    try {
      await readdir2(dir);
    } catch (err) {
      if (this._removeWatcher) {
        this._removeWatcher(sysPath2.dirname(dir), sysPath2.basename(dir));
      }
    }
  }
  has(item) {
    const { items } = this;
    if (!items)
      return;
    return items.has(item);
  }
  getChildren() {
    const { items } = this;
    if (!items)
      return [];
    return [...items.values()];
  }
  dispose() {
    this.items.clear();
    this.path = "";
    this._removeWatcher = EMPTY_FN;
    this.items = EMPTY_SET;
    Object.freeze(this);
  }
}
var STAT_METHOD_F = "stat";
var STAT_METHOD_L = "lstat";

class WatchHelper {
  constructor(path, follow, fsw) {
    this.fsw = fsw;
    const watchPath = path;
    this.path = path = path.replace(REPLACER_RE, "");
    this.watchPath = watchPath;
    this.fullWatchPath = sysPath2.resolve(watchPath);
    this.dirParts = [];
    this.dirParts.forEach((parts) => {
      if (parts.length > 1)
        parts.pop();
    });
    this.followSymlinks = follow;
    this.statMethod = follow ? STAT_METHOD_F : STAT_METHOD_L;
  }
  entryPath(entry) {
    return sysPath2.join(this.watchPath, sysPath2.relative(this.watchPath, entry.fullPath));
  }
  filterPath(entry) {
    const { stats } = entry;
    if (stats && stats.isSymbolicLink())
      return this.filterDir(entry);
    const resolvedPath = this.entryPath(entry);
    return this.fsw._isntIgnored(resolvedPath, stats) && this.fsw._hasReadPermissions(stats);
  }
  filterDir(entry) {
    return this.fsw._isntIgnored(this.entryPath(entry), entry.stats);
  }
}

class FSWatcher extends EventEmitter {
  constructor(_opts = {}) {
    super();
    this.closed = false;
    this._closers = new Map;
    this._ignoredPaths = new Set;
    this._throttled = new Map;
    this._streams = new Set;
    this._symlinkPaths = new Map;
    this._watched = new Map;
    this._pendingWrites = new Map;
    this._pendingUnlinks = new Map;
    this._readyCount = 0;
    this._readyEmitted = false;
    const awf = _opts.awaitWriteFinish;
    const DEF_AWF = { stabilityThreshold: 2000, pollInterval: 100 };
    const opts = {
      persistent: true,
      ignoreInitial: false,
      ignorePermissionErrors: false,
      interval: 100,
      binaryInterval: 300,
      followSymlinks: true,
      usePolling: false,
      atomic: true,
      ..._opts,
      ignored: _opts.ignored ? arrify(_opts.ignored) : arrify([]),
      awaitWriteFinish: awf === true ? DEF_AWF : typeof awf === "object" ? { ...DEF_AWF, ...awf } : false
    };
    if (isIBMi)
      opts.usePolling = true;
    if (opts.atomic === undefined)
      opts.atomic = !opts.usePolling;
    const envPoll = process.env.CHOKIDAR_USEPOLLING;
    if (envPoll !== undefined) {
      const envLower = envPoll.toLowerCase();
      if (envLower === "false" || envLower === "0")
        opts.usePolling = false;
      else if (envLower === "true" || envLower === "1")
        opts.usePolling = true;
      else
        opts.usePolling = !!envLower;
    }
    const envInterval = process.env.CHOKIDAR_INTERVAL;
    if (envInterval)
      opts.interval = Number.parseInt(envInterval, 10);
    let readyCalls = 0;
    this._emitReady = () => {
      readyCalls++;
      if (readyCalls >= this._readyCount) {
        this._emitReady = EMPTY_FN;
        this._readyEmitted = true;
        process.nextTick(() => this.emit(EVENTS.READY));
      }
    };
    this._emitRaw = (...args) => this.emit(EVENTS.RAW, ...args);
    this._boundRemove = this._remove.bind(this);
    this.options = opts;
    this._nodeFsHandler = new NodeFsHandler(this);
    Object.freeze(opts);
  }
  _addIgnoredPath(matcher) {
    if (isMatcherObject(matcher)) {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher.path && ignored.recursive === matcher.recursive) {
          return;
        }
      }
    }
    this._ignoredPaths.add(matcher);
  }
  _removeIgnoredPath(matcher) {
    this._ignoredPaths.delete(matcher);
    if (typeof matcher === "string") {
      for (const ignored of this._ignoredPaths) {
        if (isMatcherObject(ignored) && ignored.path === matcher) {
          this._ignoredPaths.delete(ignored);
        }
      }
    }
  }
  add(paths_, _origAdd, _internal) {
    const { cwd } = this.options;
    this.closed = false;
    this._closePromise = undefined;
    let paths = unifyPaths(paths_);
    if (cwd) {
      paths = paths.map((path) => {
        const absPath = getAbsolutePath(path, cwd);
        return absPath;
      });
    }
    paths.forEach((path) => {
      this._removeIgnoredPath(path);
    });
    this._userIgnored = undefined;
    if (!this._readyCount)
      this._readyCount = 0;
    this._readyCount += paths.length;
    Promise.all(paths.map(async (path) => {
      const res = await this._nodeFsHandler._addToNodeFs(path, !_internal, undefined, 0, _origAdd);
      if (res)
        this._emitReady();
      return res;
    })).then((results) => {
      if (this.closed)
        return;
      results.forEach((item) => {
        if (item)
          this.add(sysPath2.dirname(item), sysPath2.basename(_origAdd || item));
      });
    });
    return this;
  }
  unwatch(paths_) {
    if (this.closed)
      return this;
    const paths = unifyPaths(paths_);
    const { cwd } = this.options;
    paths.forEach((path) => {
      if (!sysPath2.isAbsolute(path) && !this._closers.has(path)) {
        if (cwd)
          path = sysPath2.join(cwd, path);
        path = sysPath2.resolve(path);
      }
      this._closePath(path);
      this._addIgnoredPath(path);
      if (this._watched.has(path)) {
        this._addIgnoredPath({
          path,
          recursive: true
        });
      }
      this._userIgnored = undefined;
    });
    return this;
  }
  close() {
    if (this._closePromise) {
      return this._closePromise;
    }
    this.closed = true;
    this.removeAllListeners();
    const closers = [];
    this._closers.forEach((closerList) => closerList.forEach((closer) => {
      const promise = closer();
      if (promise instanceof Promise)
        closers.push(promise);
    }));
    this._streams.forEach((stream) => stream.destroy());
    this._userIgnored = undefined;
    this._readyCount = 0;
    this._readyEmitted = false;
    this._watched.forEach((dirent) => dirent.dispose());
    this._closers.clear();
    this._watched.clear();
    this._streams.clear();
    this._symlinkPaths.clear();
    this._throttled.clear();
    this._closePromise = closers.length ? Promise.all(closers).then(() => {
      return;
    }) : Promise.resolve();
    return this._closePromise;
  }
  getWatched() {
    const watchList = {};
    this._watched.forEach((entry, dir) => {
      const key = this.options.cwd ? sysPath2.relative(this.options.cwd, dir) : dir;
      const index = key || ONE_DOT;
      watchList[index] = entry.getChildren().sort();
    });
    return watchList;
  }
  emitWithAll(event, args) {
    this.emit(event, ...args);
    if (event !== EVENTS.ERROR)
      this.emit(EVENTS.ALL, event, ...args);
  }
  async _emit(event, path, stats) {
    if (this.closed)
      return;
    const opts = this.options;
    if (isWindows)
      path = sysPath2.normalize(path);
    if (opts.cwd)
      path = sysPath2.relative(opts.cwd, path);
    const args = [path];
    if (stats != null)
      args.push(stats);
    const awf = opts.awaitWriteFinish;
    let pw;
    if (awf && (pw = this._pendingWrites.get(path))) {
      pw.lastChange = new Date;
      return this;
    }
    if (opts.atomic) {
      if (event === EVENTS.UNLINK) {
        this._pendingUnlinks.set(path, [event, ...args]);
        setTimeout(() => {
          this._pendingUnlinks.forEach((entry, path2) => {
            this.emit(...entry);
            this.emit(EVENTS.ALL, ...entry);
            this._pendingUnlinks.delete(path2);
          });
        }, typeof opts.atomic === "number" ? opts.atomic : 100);
        return this;
      }
      if (event === EVENTS.ADD && this._pendingUnlinks.has(path)) {
        event = EVENTS.CHANGE;
        this._pendingUnlinks.delete(path);
      }
    }
    if (awf && (event === EVENTS.ADD || event === EVENTS.CHANGE) && this._readyEmitted) {
      const awfEmit = (err, stats2) => {
        if (err) {
          event = EVENTS.ERROR;
          args[0] = err;
          this.emitWithAll(event, args);
        } else if (stats2) {
          if (args.length > 1) {
            args[1] = stats2;
          } else {
            args.push(stats2);
          }
          this.emitWithAll(event, args);
        }
      };
      this._awaitWriteFinish(path, awf.stabilityThreshold, event, awfEmit);
      return this;
    }
    if (event === EVENTS.CHANGE) {
      const isThrottled = !this._throttle(EVENTS.CHANGE, path, 50);
      if (isThrottled)
        return this;
    }
    if (opts.alwaysStat && stats === undefined && (event === EVENTS.ADD || event === EVENTS.ADD_DIR || event === EVENTS.CHANGE)) {
      const fullPath = opts.cwd ? sysPath2.join(opts.cwd, path) : path;
      let stats2;
      try {
        stats2 = await stat3(fullPath);
      } catch (err) {
      }
      if (!stats2 || this.closed)
        return;
      args.push(stats2);
    }
    this.emitWithAll(event, args);
    return this;
  }
  _handleError(error) {
    const code = error && error.code;
    if (error && code !== "ENOENT" && code !== "ENOTDIR" && (!this.options.ignorePermissionErrors || code !== "EPERM" && code !== "EACCES")) {
      this.emit(EVENTS.ERROR, error);
    }
    return error || this.closed;
  }
  _throttle(actionType, path, timeout) {
    if (!this._throttled.has(actionType)) {
      this._throttled.set(actionType, new Map);
    }
    const action = this._throttled.get(actionType);
    if (!action)
      throw new Error("invalid throttle");
    const actionPath = action.get(path);
    if (actionPath) {
      actionPath.count++;
      return false;
    }
    let timeoutObject;
    const clear = () => {
      const item = action.get(path);
      const count = item ? item.count : 0;
      action.delete(path);
      clearTimeout(timeoutObject);
      if (item)
        clearTimeout(item.timeoutObject);
      return count;
    };
    timeoutObject = setTimeout(clear, timeout);
    const thr = { timeoutObject, clear, count: 0 };
    action.set(path, thr);
    return thr;
  }
  _incrReadyCount() {
    return this._readyCount++;
  }
  _awaitWriteFinish(path, threshold, event, awfEmit) {
    const awf = this.options.awaitWriteFinish;
    if (typeof awf !== "object")
      return;
    const pollInterval = awf.pollInterval;
    let timeoutHandler;
    let fullPath = path;
    if (this.options.cwd && !sysPath2.isAbsolute(path)) {
      fullPath = sysPath2.join(this.options.cwd, path);
    }
    const now = new Date;
    const writes = this._pendingWrites;
    function awaitWriteFinishFn(prevStat) {
      statcb(fullPath, (err, curStat) => {
        if (err || !writes.has(path)) {
          if (err && err.code !== "ENOENT")
            awfEmit(err);
          return;
        }
        const now2 = Number(new Date);
        if (prevStat && curStat.size !== prevStat.size) {
          writes.get(path).lastChange = now2;
        }
        const pw = writes.get(path);
        const df = now2 - pw.lastChange;
        if (df >= threshold) {
          writes.delete(path);
          awfEmit(undefined, curStat);
        } else {
          timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval, curStat);
        }
      });
    }
    if (!writes.has(path)) {
      writes.set(path, {
        lastChange: now,
        cancelWait: () => {
          writes.delete(path);
          clearTimeout(timeoutHandler);
          return event;
        }
      });
      timeoutHandler = setTimeout(awaitWriteFinishFn, pollInterval);
    }
  }
  _isIgnored(path, stats) {
    if (this.options.atomic && DOT_RE.test(path))
      return true;
    if (!this._userIgnored) {
      const { cwd } = this.options;
      const ign = this.options.ignored;
      const ignored = (ign || []).map(normalizeIgnored(cwd));
      const ignoredPaths = [...this._ignoredPaths];
      const list = [...ignoredPaths.map(normalizeIgnored(cwd)), ...ignored];
      this._userIgnored = anymatch(list, undefined);
    }
    return this._userIgnored(path, stats);
  }
  _isntIgnored(path, stat4) {
    return !this._isIgnored(path, stat4);
  }
  _getWatchHelpers(path) {
    return new WatchHelper(path, this.options.followSymlinks, this);
  }
  _getWatchedDir(directory) {
    const dir = sysPath2.resolve(directory);
    if (!this._watched.has(dir))
      this._watched.set(dir, new DirEntry(dir, this._boundRemove));
    return this._watched.get(dir);
  }
  _hasReadPermissions(stats) {
    if (this.options.ignorePermissionErrors)
      return true;
    return Boolean(Number(stats.mode) & 256);
  }
  _remove(directory, item, isDirectory) {
    const path = sysPath2.join(directory, item);
    const fullPath = sysPath2.resolve(path);
    isDirectory = isDirectory != null ? isDirectory : this._watched.has(path) || this._watched.has(fullPath);
    if (!this._throttle("remove", path, 100))
      return;
    if (!isDirectory && this._watched.size === 1) {
      this.add(directory, item, true);
    }
    const wp = this._getWatchedDir(path);
    const nestedDirectoryChildren = wp.getChildren();
    nestedDirectoryChildren.forEach((nested) => this._remove(path, nested));
    const parent = this._getWatchedDir(directory);
    const wasTracked = parent.has(item);
    parent.remove(item);
    if (this._symlinkPaths.has(fullPath)) {
      this._symlinkPaths.delete(fullPath);
    }
    let relPath = path;
    if (this.options.cwd)
      relPath = sysPath2.relative(this.options.cwd, path);
    if (this.options.awaitWriteFinish && this._pendingWrites.has(relPath)) {
      const event = this._pendingWrites.get(relPath).cancelWait();
      if (event === EVENTS.ADD)
        return;
    }
    this._watched.delete(path);
    this._watched.delete(fullPath);
    const eventName = isDirectory ? EVENTS.UNLINK_DIR : EVENTS.UNLINK;
    if (wasTracked && !this._isIgnored(path))
      this._emit(eventName, path);
    this._closePath(path);
  }
  _closePath(path) {
    this._closeFile(path);
    const dir = sysPath2.dirname(path);
    this._getWatchedDir(dir).remove(sysPath2.basename(path));
  }
  _closeFile(path) {
    const closers = this._closers.get(path);
    if (!closers)
      return;
    closers.forEach((closer) => closer());
    this._closers.delete(path);
  }
  _addPathCloser(path, closer) {
    if (!closer)
      return;
    let list = this._closers.get(path);
    if (!list) {
      list = [];
      this._closers.set(path, list);
    }
    list.push(closer);
  }
  _readdirp(root, opts) {
    if (this.closed)
      return;
    const options = { type: EVENTS.ALL, alwaysStat: true, lstat: true, ...opts, depth: 0 };
    let stream = readdirp(root, options);
    this._streams.add(stream);
    stream.once(STR_CLOSE, () => {
      stream = undefined;
    });
    stream.once(STR_END, () => {
      if (stream) {
        this._streams.delete(stream);
        stream = undefined;
      }
    });
    return stream;
  }
}
function watch(paths, options = {}) {
  const watcher = new FSWatcher(options);
  watcher.add(paths);
  return watcher;
}

// src/sessionWatcher.ts
import { EventEmitter as EventEmitter3 } from "events";
import * as path2 from "path";
import * as fs2 from "fs";

// src/recursiveWatcher.ts
import { EventEmitter as EventEmitter2 } from "events";
import * as fs from "fs";
import * as path from "path";
var supportsRecursiveWatch = process.platform === "darwin" || process.platform === "win32";

class RecursiveWatcher extends EventEmitter2 {
  fsWatcher = null;
  chokidarWatcher = null;
  debounceTimers = new Map;
  watchPath;
  filter;
  callback;
  maxDepth;
  debounceMs;
  constructor(opts) {
    super();
    this.watchPath = opts.path;
    this.filter = opts.filter;
    this.callback = opts.callback;
    this.maxDepth = opts.maxDepth ?? Infinity;
    this.debounceMs = opts.debounceMs ?? 100;
  }
  start() {
    if (this.fsWatcher || this.chokidarWatcher)
      return;
    if (!fs.existsSync(this.watchPath)) {
      fs.mkdirSync(this.watchPath, { recursive: true });
    }
    if (supportsRecursiveWatch) {
      this.startFsWatch();
    } else {
      this.startChokidar();
    }
  }
  startFsWatch() {
    this.fsWatcher = fs.watch(this.watchPath, { recursive: true }, (_eventType, filename) => {
      if (!filename)
        return;
      const parts = filename.split(path.sep);
      if (parts.length > this.maxDepth)
        return;
      if (!this.filter(filename))
        return;
      const fullPath = path.join(this.watchPath, filename);
      const existing = this.debounceTimers.get(fullPath);
      if (existing)
        clearTimeout(existing);
      this.debounceTimers.set(fullPath, setTimeout(() => {
        this.debounceTimers.delete(fullPath);
        try {
          fs.statSync(fullPath);
          this.callback(fullPath, "change");
        } catch {
        }
      }, this.debounceMs));
    });
    this.fsWatcher.on("error", (err) => {
      this.emit("error", err);
    });
    this.emit("ready");
  }
  startChokidar() {
    this.chokidarWatcher = watch(this.watchPath, {
      persistent: true,
      ignoreInitial: true,
      depth: this.maxDepth,
      awaitWriteFinish: {
        stabilityThreshold: this.debounceMs,
        pollInterval: Math.max(20, this.debounceMs / 2)
      }
    });
    this.chokidarWatcher.on("add", (filePath) => {
      const rel = path.relative(this.watchPath, filePath);
      if (this.filter(rel))
        this.callback(filePath, "add");
    });
    this.chokidarWatcher.on("change", (filePath) => {
      const rel = path.relative(this.watchPath, filePath);
      if (this.filter(rel))
        this.callback(filePath, "change");
    });
    this.chokidarWatcher.on("error", (err) => {
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
    this.chokidarWatcher.on("ready", () => {
      this.emit("ready");
    });
  }
  stop() {
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    if (this.chokidarWatcher) {
      this.chokidarWatcher.close();
      this.chokidarWatcher = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
  restart() {
    this.stop();
    this.start();
  }
  get isWatching() {
    return this.fsWatcher !== null || this.chokidarWatcher !== null;
  }
}

// src/sessionWatcher.ts
class SessionWatcher extends EventEmitter3 {
  watcher = null;
  projectsPath;
  constructor(projectsPath) {
    super();
    this.projectsPath = projectsPath || path2.join(process.env.HOME || "", ".claude", "projects");
  }
  start() {
    if (this.watcher) {
      return;
    }
    if (!fs2.existsSync(this.projectsPath)) {
      fs2.mkdirSync(this.projectsPath, { recursive: true });
    }
    this.emitExistingFilesSorted();
    this.watcher = new RecursiveWatcher({
      path: this.projectsPath,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      maxDepth: 2,
      debounceMs: 100
    });
    this.watcher.on("error", (err) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }
  emitExistingFilesSorted() {
    const files = [];
    const RECENT_THRESHOLD_MS = 10 * 60 * 1000;
    const now = Date.now();
    const scanDir = (dir, depth) => {
      if (depth > 2)
        return;
      try {
        const entries = fs2.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path2.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath, depth + 1);
          } else if (entry.name.endsWith(".jsonl")) {
            try {
              const fileStat = fs2.statSync(fullPath);
              files.push({ path: fullPath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
            } catch {
            }
          }
        }
      } catch {
      }
    };
    try {
      scanDir(this.projectsPath, 0);
    } catch {
      return;
    }
    const recentFiles = files.filter((f) => now - f.mtimeMs < RECENT_THRESHOLD_MS);
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const file of recentFiles) {
      this.handleFileEvent(file.path, "add");
    }
  }
  stop() {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }
  restart() {
    this.stop();
    this.start();
  }
  handleFileEvent(filePath, eventType) {
    const relative5 = path2.relative(this.projectsPath, filePath);
    const parts = relative5.split(path2.sep);
    if (parts.length < 2)
      return;
    const projectDirName = parts[0];
    const sessionFileName = parts[1];
    const sessionId = sessionFileName.replace(".jsonl", "");
    this.emit("session", {
      sessionId,
      filePath,
      eventType,
      projectPath: projectDirName
    });
  }
}

// src/cursorWatcher.ts
import { EventEmitter as EventEmitter4 } from "events";
import * as path3 from "path";
import * as fs3 from "fs";
import { Database } from "bun:sqlite";

class CursorWatcher extends EventEmitter4 {
  pollInterval = null;
  cursorPath;
  workspaceStates = new Map;
  pollFrequencyMs;
  isFirstPoll = true;
  constructor(cursorPath, pollFrequencyMs = 2000) {
    super();
    this.cursorPath = cursorPath || this.detectCursorPath();
    this.pollFrequencyMs = pollFrequencyMs;
  }
  detectCursorPath() {
    const platform = process.platform;
    const home = process.env.HOME || "";
    if (platform === "darwin") {
      return path3.join(home, "Library", "Application Support", "Cursor");
    } else if (platform === "linux") {
      return path3.join(home, ".config", "Cursor");
    } else if (platform === "win32") {
      return path3.join(process.env.APPDATA || "", "Cursor");
    }
    return path3.join(home, ".cursor");
  }
  start() {
    if (this.pollInterval) {
      return;
    }
    const workspaceStoragePath = path3.join(this.cursorPath, "User", "workspaceStorage");
    if (!fs3.existsSync(workspaceStoragePath)) {
      return;
    }
    this.emit("ready");
    this.pollInterval = setInterval(() => {
      this.pollWorkspaces(workspaceStoragePath);
    }, this.pollFrequencyMs);
    setImmediate(() => this.pollWorkspaces(workspaceStoragePath));
  }
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
  pollWorkspaces(workspaceStoragePath) {
    try {
      const workspaceDirs = fs3.readdirSync(workspaceStoragePath);
      if (this.isFirstPoll) {
        console.log(`[CursorWatcher] Found ${workspaceDirs.length} workspace directories`);
      }
      const workspaces = [];
      for (const workspaceHash of workspaceDirs) {
        const dbPath = path3.join(workspaceStoragePath, workspaceHash, "state.vscdb");
        if (!fs3.existsSync(dbPath)) {
          continue;
        }
        try {
          const stat4 = fs3.statSync(dbPath);
          workspaces.push({ hash: workspaceHash, dbPath, mtime: stat4.mtimeMs });
        } catch {
        }
      }
      if (this.isFirstPoll) {
        workspaces.sort((a, b) => b.mtime - a.mtime);
        this.isFirstPoll = false;
      }
      for (const workspace of workspaces) {
        try {
          this.checkWorkspaceForChanges(workspace.hash, workspace.dbPath);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          this.emit("error", new Error(`Failed to check workspace ${workspace.hash}: ${error.message}`));
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }
  getWorkspaceFolderPath(workspaceStorageDir) {
    const workspaceJsonPath = path3.join(workspaceStorageDir, "workspace.json");
    try {
      if (!fs3.existsSync(workspaceJsonPath)) {
        return null;
      }
      const content = fs3.readFileSync(workspaceJsonPath, "utf-8");
      const data = JSON.parse(content);
      const folderUri = data.folder || data.workspace;
      if (!folderUri) {
        return null;
      }
      if (folderUri.startsWith("file://")) {
        const decoded = decodeURIComponent(folderUri.slice(7));
        if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
          return decoded.slice(1);
        }
        return decoded;
      }
      return folderUri;
    } catch {
      return null;
    }
  }
  checkWorkspaceForChanges(workspaceHash, dbPath) {
    let db = null;
    try {
      db = new Database(dbPath, { readonly: true });
      const tableExists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
      if (!tableExists) {
        return;
      }
      const maxRowIdResult = db.query("SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'").get();
      const maxRowId = maxRowIdResult?.maxRowId ?? 0;
      const state = this.workspaceStates.get(workspaceHash);
      const workspaceStorageDir = path3.dirname(dbPath);
      const actualPath = this.getWorkspaceFolderPath(workspaceStorageDir) || workspaceHash;
      if (!state) {
        this.workspaceStates.set(workspaceHash, {
          lastRowId: maxRowId,
          lastCheck: Date.now()
        });
        if (maxRowId > 0) {
          console.log(`[CursorWatcher] Emitting session for ${workspaceHash} (${actualPath}), maxRowId=${maxRowId}`);
          this.emit("session", {
            sessionId: workspaceHash,
            workspacePath: actualPath,
            dbPath,
            eventType: "add"
          });
        }
      } else if (maxRowId > state.lastRowId) {
        state.lastRowId = maxRowId;
        state.lastCheck = Date.now();
        this.emit("session", {
          sessionId: workspaceHash,
          workspacePath: actualPath,
          dbPath,
          eventType: "change"
        });
      }
    } finally {
      if (db) {
        db.close();
      }
    }
  }
}

// src/cursorTranscriptWatcher.ts
import { EventEmitter as EventEmitter5 } from "events";
import * as path4 from "path";
import * as fs4 from "fs";
class CursorTranscriptWatcher extends EventEmitter5 {
  watcher = null;
  historyPath;
  constructor(historyPath) {
    super();
    this.historyPath = historyPath || path4.join(process.env.HOME || "", ".cursor", "projects");
  }
  start() {
    if (this.watcher) {
      return;
    }
    if (!fs4.existsSync(this.historyPath)) {
      return;
    }
    this.emitExistingFilesSorted();
    this.watcher = new RecursiveWatcher({
      path: this.historyPath,
      filter: (rel) => rel.endsWith(".txt") && rel.includes(`agent-transcripts${path4.sep}`) || rel.includes("agent-transcripts/"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      debounceMs: 100
    });
    this.watcher.on("error", (err) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }
  emitExistingFilesSorted() {
    const files = [];
    const scanDir = (dir) => {
      let entries;
      try {
        entries = fs4.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path4.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".txt")) {
          if (!fullPath.includes(`${path4.sep}agent-transcripts${path4.sep}`)) {
            continue;
          }
          try {
            const stat4 = fs4.statSync(fullPath);
            files.push({ path: fullPath, mtime: stat4.mtimeMs });
          } catch {
            continue;
          }
        }
      }
    };
    scanDir(this.historyPath);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      this.handleFileEvent(file.path, "add");
    }
  }
  stop() {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }
  handleFileEvent(filePath, eventType) {
    const sessionId = this.extractSessionId(filePath);
    this.emit("session", { sessionId, filePath, eventType });
  }
  extractSessionId(filePath) {
    return path4.basename(filePath, ".txt");
  }
}

// src/codexWatcher.ts
import { EventEmitter as EventEmitter6 } from "events";
import * as path5 from "path";
import * as fs5 from "fs";
class CodexWatcher extends EventEmitter6 {
  watcher = null;
  historyPath;
  constructor(historyPath) {
    super();
    this.historyPath = historyPath || path5.join(process.env.HOME || "", ".codex", "sessions");
  }
  start() {
    if (this.watcher) {
      return;
    }
    if (!fs5.existsSync(this.historyPath)) {
      fs5.mkdirSync(this.historyPath, { recursive: true });
    }
    this.emitExistingFilesSorted();
    this.watcher = new RecursiveWatcher({
      path: this.historyPath,
      filter: (rel) => rel.endsWith(".jsonl"),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      maxDepth: 4,
      debounceMs: 100
    });
    this.watcher.on("error", (err) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }
  emitExistingFilesSorted() {
    const files = [];
    const scanDir = (dir) => {
      try {
        const entries = fs5.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path5.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            try {
              const stat4 = fs5.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat4.mtimeMs });
            } catch {
            }
          }
        }
      } catch {
      }
    };
    scanDir(this.historyPath);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      this.handleFileEvent(file.path, "add");
    }
  }
  stop() {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }
  handleFileEvent(filePath, eventType) {
    const sessionId = this.extractSessionId(filePath);
    this.emit("session", { sessionId, filePath, eventType });
  }
  extractSessionId(filePath) {
    const filename = path5.basename(filePath, ".jsonl");
    const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    return match ? match[1] : filename;
  }
}

// src/sessionProcessMatcher.ts
function isResumeInvocation(agentType, commandLine) {
  if (agentType === "codex" || agentType === "gemini") {
    return /\s--resume(\s|$)/.test(commandLine) || /\sresume(\s|$)/.test(commandLine);
  }
  return /\s--resume(\s|$)/.test(commandLine);
}
function hasCodexSessionFileOpen(lsofOutput, sessionId) {
  if (!lsofOutput || !sessionId)
    return false;
  return lsofOutput.split(`
`).some((line) => line.includes(".codex/sessions/") && line.includes(sessionId) && line.includes(".jsonl"));
}
function choosePreferredCodexCandidate(candidates) {
  if (candidates.length === 0)
    return null;
  return candidates.find((c) => !c.tmuxTarget) || candidates[0];
}
function matchStartedConversation(entries, {
  tmuxSessionName,
  projectPath,
  now = Date.now(),
  ttlMs = 300000
}) {
  const startedEntries = Array.isArray(entries) ? entries : [...entries];
  if (tmuxSessionName) {
    for (const [conversationId, entry] of startedEntries) {
      if (entry.tmuxSession === tmuxSessionName) {
        return conversationId;
      }
    }
  }
  if (!projectPath)
    return null;
  for (const [conversationId, entry] of startedEntries) {
    if (entry.projectPath === projectPath && now - entry.startedAt < ttlMs) {
      return conversationId;
    }
  }
  return null;
}
function matchSingleFreshStartedConversation(entries, {
  now = Date.now(),
  freshnessMs = 120000
} = {}) {
  const startedEntries = Array.isArray(entries) ? entries : [...entries];
  const fresh = startedEntries.filter(([, entry]) => now - entry.startedAt < freshnessMs);
  if (fresh.length !== 1)
    return null;
  return fresh[0][0];
}

// src/geminiWatcher.ts
import { EventEmitter as EventEmitter7 } from "events";
import * as path6 from "path";
import * as fs6 from "fs";
class GeminiWatcher extends EventEmitter7 {
  watcher = null;
  basePath;
  constructor(basePath) {
    super();
    this.basePath = basePath || path6.join(process.env.HOME || "", ".gemini", "tmp");
  }
  start() {
    if (this.watcher) {
      return;
    }
    if (!fs6.existsSync(this.basePath)) {
      fs6.mkdirSync(this.basePath, { recursive: true });
    }
    this.emitExistingFilesSorted();
    this.watcher = new RecursiveWatcher({
      path: this.basePath,
      filter: (rel) => rel.endsWith(".json") && (rel.includes(`chats${path6.sep}`) || rel.includes("chats/")),
      callback: (filePath, eventType) => this.handleFileEvent(filePath, eventType),
      debounceMs: 200
    });
    this.watcher.on("error", (err) => this.emit("error", err));
    this.watcher.on("ready", () => this.emit("ready"));
    this.watcher.start();
  }
  emitExistingFilesSorted() {
    const files = [];
    const scanDir = (dir) => {
      try {
        const entries = fs6.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path6.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".json") && dir.endsWith("/chats")) {
            try {
              const stat4 = fs6.statSync(fullPath);
              files.push({ path: fullPath, mtime: stat4.mtimeMs });
            } catch {
            }
          }
        }
      } catch {
      }
    };
    scanDir(this.basePath);
    files.sort((a, b) => b.mtime - a.mtime);
    for (const file of files) {
      this.handleFileEvent(file.path, "add");
    }
  }
  stop() {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }
  handleFileEvent(filePath, eventType) {
    const sessionId = this.extractSessionId(filePath);
    const projectHash = this.extractProjectHash(filePath);
    this.emit("session", { sessionId, filePath, projectHash, eventType });
  }
  extractSessionId(filePath) {
    const filename = path6.basename(filePath, ".json");
    const match = filename.match(/([0-9a-f]{8})$/i);
    return match ? filename : filename;
  }
  extractProjectHash(filePath) {
    const parts = filePath.split(path6.sep);
    const chatsIdx = parts.lastIndexOf("chats");
    if (chatsIdx > 0) {
      return parts[chatsIdx - 1];
    }
    return "";
  }
}

// src/parser.ts
function parseSessionLine(line) {
  if (!line.trim())
    return null;
  try {
    return JSON.parse(line);
  } catch (err) {
    const preview = line.length > 100 ? line.slice(0, 100) + "..." : line;
    console.warn(`[parser] Failed to parse session line: ${err instanceof Error ? err.message : String(err)}`);
    console.warn(`[parser] Line content: ${preview}`);
    return null;
  }
}
function extractMessages(entries) {
  const messages = [];
  for (const entry of entries) {
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    if (entry.type === "system") {
      if (entry.content && entry.subtype) {
        messages.push({
          uuid: entry.uuid,
          role: "system",
          content: entry.content,
          timestamp,
          subtype: entry.subtype
        });
      }
      continue;
    }
    if (entry.type === "queue-operation" && entry.operation === "enqueue" && entry.content) {
      messages.push({
        uuid: entry.uuid,
        role: "user",
        content: entry.content,
        timestamp
      });
      continue;
    }
    if (entry.isMeta || entry.isCompactSummary || entry.isVisibleInTranscriptOnly)
      continue;
    const normalizedType = entry.type === "human" ? "user" : entry.type;
    if (normalizedType !== "user" && normalizedType !== "assistant")
      continue;
    if (!entry.message)
      continue;
    let role;
    let textContent = "";
    let thinking = "";
    const toolCalls = [];
    const toolResults = [];
    const images = [];
    if (typeof entry.message === "string") {
      role = normalizedType;
      textContent = entry.message;
    } else {
      role = entry.message.role;
      const content = entry.message.content;
      if (typeof content === "string") {
        textContent = content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text") {
            textContent += block.text;
          } else if (block.type === "thinking") {
            thinking += block.thinking;
          } else if (block.type === "tool_use") {
            toolCalls.push({ id: block.id, name: block.name, input: block.input });
          } else if (block.type === "tool_result") {
            let toolResultContent = block.content;
            if (Array.isArray(block.content)) {
              const contentArray = block.content;
              toolResultContent = contentArray.filter((c) => c.type === "text" && c.text).map((c) => c.text).join("");
              for (const item of contentArray) {
                if (item.type === "image" && item.source) {
                  images.push({
                    mediaType: item.source.media_type,
                    data: item.source.data,
                    toolUseId: block.tool_use_id
                  });
                }
              }
            }
            toolResults.push({
              toolUseId: block.tool_use_id,
              content: toolResultContent,
              isError: block.is_error
            });
          } else if (block.type === "image") {
            images.push({
              mediaType: block.source.media_type,
              data: block.source.data
            });
          }
        }
      }
    }
    if (textContent || thinking || toolCalls.length > 0 || toolResults.length > 0 || images.length > 0) {
      messages.push({
        uuid: entry.uuid,
        role,
        content: textContent,
        timestamp,
        thinking: thinking || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        images: images.length > 0 ? images : undefined
      });
    }
  }
  return messages;
}
function parseSessionFile(content) {
  const lines = content.split(`
`);
  const entries = lines.map(parseSessionLine).filter((e) => e !== null);
  return extractMessages(entries);
}
function extractSlug(content) {
  const lines = content.split(`
`);
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.slug) {
      return entry.slug;
    }
  }
  return;
}
function extractParentUuid(content) {
  const lines = content.split(`
`);
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.type === "user") {
      return entry.parentUuid || undefined;
    }
  }
  return;
}
function extractSummaryTitle(content) {
  const lines = content.split(`
`);
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.type === "summary" && entry?.summary) {
      return entry.summary;
    }
  }
  return;
}
function extractCwd(content) {
  const lines = content.split(`
`);
  for (const line of lines) {
    const entry = parseSessionLine(line);
    if (entry?.cwd) {
      return entry.cwd;
    }
  }
  return;
}
function detectCliFlags(content) {
  const flags = [];
  const firstUserLine = content.split(`
`).find((l) => l.includes('"type":"user"'));
  if (firstUserLine) {
    try {
      const parsed = JSON.parse(firstUserLine);
      if (parsed.permissionMode === "bypassPermissions") {
        flags.push("--dangerously-skip-permissions");
      }
    } catch {
    }
  }
  if (content.includes("mcp__claude-in-chrome__") || content.includes('"claude-in-chrome"')) {
    flags.push("--chrome");
  }
  return flags.length > 0 ? flags.join(" ") : null;
}
function sanitizeCodexText(content) {
  return content.replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "").replace(/\n{3,}/g, `

`);
}
function parseCodexImageItem(item) {
  if (typeof item.image_data === "string" && typeof item.media_type === "string") {
    return {
      mediaType: item.media_type,
      data: item.image_data
    };
  }
  const imageUrl = typeof item.image_url === "string" ? item.image_url : typeof item.url === "string" ? item.url : undefined;
  if (!imageUrl)
    return null;
  const match = imageUrl.match(/^data:([^;,]+);base64,([\s\S]+)$/i);
  if (!match)
    return null;
  return {
    mediaType: match[1],
    data: match[2]
  };
}
function extractCodexTextAndImages(content) {
  if (typeof content === "string") {
    return { text: sanitizeCodexText(content), images: [] };
  }
  if (!Array.isArray(content)) {
    return { text: "", images: [] };
  }
  const textParts = [];
  const images = [];
  for (const item of content) {
    if (item.type === "input_text" || item.type === "output_text" || item.type === "text") {
      if (typeof item.text === "string" && item.text.length > 0) {
        textParts.push(item.text);
      }
      continue;
    }
    if (item.type === "input_image" || item.type === "output_image" || item.type === "image") {
      const parsedImage = parseCodexImageItem(item);
      if (parsedImage) {
        images.push(parsedImage);
      }
    }
  }
  return {
    text: sanitizeCodexText(textParts.join(`
`)),
    images
  };
}
function parseCodexSessionFile(content) {
  const lines = content.split(`
`);
  const messages = [];
  let currentAssistantContent = "";
  let currentAssistantThinking = "";
  let currentToolCalls = [];
  let currentToolResults = [];
  let currentAssistantImages = [];
  let lastTimestamp = Date.now();
  const flushAssistantMessage = () => {
    if (currentAssistantContent || currentAssistantThinking || currentToolCalls.length > 0 || currentToolResults.length > 0 || currentAssistantImages.length > 0) {
      messages.push({
        role: "assistant",
        content: currentAssistantContent.trim(),
        timestamp: lastTimestamp,
        thinking: currentAssistantThinking.trim() || undefined,
        toolCalls: currentToolCalls.length > 0 ? [...currentToolCalls] : undefined,
        toolResults: currentToolResults.length > 0 ? [...currentToolResults] : undefined,
        images: currentAssistantImages.length > 0 ? [...currentAssistantImages] : undefined
      });
      currentAssistantContent = "";
      currentAssistantThinking = "";
      currentToolCalls = [];
      currentToolResults = [];
      currentAssistantImages = [];
    }
  };
  for (const line of lines) {
    if (!line.trim())
      continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "response_item")
      continue;
    const payload = entry.payload;
    const timestamp = entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now();
    lastTimestamp = timestamp;
    if (payload.type === "message") {
      const role = payload.role;
      if (role === "developer" || role === "system")
        continue;
      const { text, images } = extractCodexTextAndImages(payload.content);
      const trimmedText = text.trim();
      if (role === "user") {
        flushAssistantMessage();
        const isSystemContext = trimmedText.startsWith("<environment_context>") || trimmedText.startsWith("<INSTRUCTIONS>") || trimmedText.startsWith("# AGENTS.md instructions") || trimmedText.startsWith("<permissions") || trimmedText.startsWith("<collaboration_mode>") || trimmedText.startsWith("<app-context>");
        if ((trimmedText || images.length > 0) && !isSystemContext) {
          messages.push({
            role: "user",
            content: trimmedText,
            timestamp,
            images: images.length > 0 ? images : undefined
          });
        }
      } else if (role === "assistant") {
        if (trimmedText) {
          currentAssistantContent += (currentAssistantContent ? `
` : "") + trimmedText;
        }
        if (images.length > 0) {
          currentAssistantImages.push(...images);
        }
      }
    } else if (payload.type === "reasoning") {
      const contentArray = Array.isArray(payload.content) ? payload.content : [];
      const summaryArray = Array.isArray(payload.summary) ? payload.summary : [];
      const thinkingText = contentArray.length > 0 ? contentArray.map((c) => c.text || "").join(`
`) : summaryArray.map((c) => c.text || "").join(`
`);
      if (thinkingText) {
        currentAssistantThinking += (currentAssistantThinking ? `
` : "") + thinkingText;
      }
    } else if (payload.type === "function_call") {
      let args = {};
      if (payload.arguments) {
        try {
          const parsed = JSON.parse(payload.arguments);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            args = parsed;
          } else if (typeof parsed === "string" && parsed.trim()) {
            args = { input: parsed };
          } else if (payload.arguments.trim()) {
            args = { input: payload.arguments };
          }
        } catch {
          if (payload.arguments.trim()) {
            args = { input: payload.arguments };
          }
        }
      }
      currentToolCalls.push({
        id: payload.call_id || "",
        name: payload.name || "",
        input: args
      });
    } else if (payload.type === "function_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      currentToolResults.push({
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string" ? payload.output : outputParsed.text
      });
      if (outputParsed.images.length > 0) {
        currentAssistantImages.push(...outputParsed.images.map((img) => ({
          mediaType: img.mediaType,
          data: img.data,
          toolUseId: payload.call_id || undefined
        })));
      }
    } else if (payload.type === "custom_tool_call") {
      currentToolCalls.push({
        id: payload.call_id || "",
        name: payload.name || "",
        input: payload.input ? { input: payload.input } : {}
      });
    } else if (payload.type === "custom_tool_call_output") {
      const outputParsed = extractCodexTextAndImages(payload.output);
      currentToolResults.push({
        toolUseId: payload.call_id || "",
        content: typeof payload.output === "string" ? payload.output : outputParsed.text
      });
      if (outputParsed.images.length > 0) {
        currentAssistantImages.push(...outputParsed.images.map((img) => ({
          mediaType: img.mediaType,
          data: img.data,
          toolUseId: payload.call_id || undefined
        })));
      }
    }
  }
  flushAssistantMessage();
  return messages;
}
function extractCodexCwd(content) {
  const lines = content.split(`
`);
  for (const line of lines) {
    if (!line.trim())
      continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session_meta" && entry.payload?.cwd) {
        return entry.payload.cwd;
      }
    } catch {
    }
  }
  return;
}
function parseCursorTranscriptFile(content) {
  const messages = [];
  const lines = content.split(`
`);
  let currentRole = null;
  let buffer = [];
  const flush = () => {
    if (!currentRole) {
      buffer = [];
      return;
    }
    const raw = buffer.join(`
`).trim();
    buffer = [];
    if (!raw) {
      return;
    }
    let contentText = raw;
    let thinking;
    if (currentRole === "user") {
      const match = raw.match(/<user_query>([\s\S]*?)<\/user_query>/i);
      if (match) {
        contentText = match[1].trim();
      }
    }
    if (currentRole === "assistant") {
      const thinkMatches = raw.match(/<think>([\s\S]*?)<\/think>/gi);
      if (thinkMatches) {
        const extracted = thinkMatches.map((m) => m.replace(/<\/?think>/gi, "").trim()).filter(Boolean).join(`
`);
        thinking = extracted || undefined;
        contentText = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      }
    }
    if (!contentText) {
      return;
    }
    messages.push({
      role: currentRole,
      content: contentText,
      thinking,
      timestamp: Date.now()
    });
  };
  for (const line of lines) {
    const trimmed = line.trim().toLowerCase();
    if (trimmed === "user:" || trimmed === "assistant:" || trimmed === "system:") {
      flush();
      currentRole = trimmed.slice(0, -1);
      continue;
    }
    buffer.push(line);
  }
  flush();
  return messages;
}
function parseGeminiSessionFile(content) {
  let session;
  try {
    session = JSON.parse(content);
  } catch {
    return [];
  }
  if (!session.messages || !Array.isArray(session.messages)) {
    return [];
  }
  const messages = [];
  for (const msg of session.messages) {
    if (msg.type === "info")
      continue;
    const timestamp = msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now();
    let role;
    let textContent = "";
    if (msg.type === "user") {
      role = "user";
      if (Array.isArray(msg.content)) {
        textContent = msg.content.map((c) => c.text).join(`
`);
      } else if (typeof msg.content === "string") {
        textContent = msg.content;
      }
    } else if (msg.type === "gemini") {
      role = "assistant";
      if (typeof msg.content === "string") {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        textContent = msg.content.map((c) => c.text).join(`
`);
      }
    } else {
      continue;
    }
    let thinking;
    if (msg.thoughts && msg.thoughts.length > 0) {
      thinking = msg.thoughts.map((t) => t.subject ? `${t.subject}: ${t.description}` : t.description).join(`

`);
    }
    if (textContent || thinking) {
      messages.push({
        uuid: msg.id,
        role,
        content: textContent,
        timestamp,
        thinking: thinking || undefined
      });
    }
  }
  return messages;
}

// src/cursorProcessor.ts
import { Database as Database2 } from "bun:sqlite";
function extractTextFromInitText(initText) {
  if (!initText.startsWith("{")) {
    return initText.trim();
  }
  try {
    let walk = function(node) {
      if (!node || typeof node !== "object")
        return;
      const n = node;
      if (n.type === "mention" && typeof n.mentionName === "string") {
        texts.push(`@${n.mentionName}`);
      } else if (n.type === "text" && typeof n.text === "string") {
        texts.push(n.text);
      }
      if (Array.isArray(n.children)) {
        for (const child of n.children) {
          walk(child);
        }
      }
    };
    const data = JSON.parse(initText);
    const texts = [];
    walk(data.root);
    return texts.join("").trim();
  } catch {
    return initText.trim();
  }
}
function parseCursorChatData(jsonStr) {
  try {
    const data = JSON.parse(jsonStr);
    const messages = [];
    if (!data.tabs || !Array.isArray(data.tabs)) {
      return messages;
    }
    for (const tab of data.tabs) {
      if (!tab.bubbles || !Array.isArray(tab.bubbles))
        continue;
      for (const bubble of tab.bubbles) {
        let content = "";
        let role;
        let timestamp = Date.now();
        if (bubble.type === "user") {
          role = "user";
          if (bubble.initText) {
            content = extractTextFromInitText(bubble.initText);
          }
          if (bubble.contextCacheTimestamp) {
            timestamp = bubble.contextCacheTimestamp;
          }
        } else if (bubble.type === "ai") {
          role = "assistant";
          content = bubble.rawText || "";
        } else {
          continue;
        }
        if (content.trim()) {
          messages.push({
            uuid: bubble.id,
            role,
            content,
            timestamp
          });
        }
      }
    }
    return messages;
  } catch {
    return [];
  }
}
function extractMessagesFromCursorDb(dbPath, skipCount = 0) {
  let db = null;
  try {
    db = new Database2(dbPath, { readonly: true });
    const row = db.query("SELECT rowid, value FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata' ORDER BY rowid DESC LIMIT 1").get();
    if (!row) {
      return { messages: [], maxRowId: 0, totalCount: 0 };
    }
    const allMessages = parseCursorChatData(row.value);
    const newMessages = allMessages.slice(skipCount);
    return { messages: newMessages, maxRowId: row.rowid, totalCount: allMessages.length };
  } finally {
    if (db) {
      db.close();
    }
  }
}

// src/positionTracker.ts
import * as fs7 from "fs";
import * as path7 from "path";
var CONFIG_DIR = process.env.HOME + "/.codecast";
var POSITIONS_FILE = path7.join(CONFIG_DIR, "positions.json");
function ensureConfigDir() {
  if (!fs7.existsSync(CONFIG_DIR)) {
    fs7.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}
function loadPositions() {
  try {
    if (fs7.existsSync(POSITIONS_FILE)) {
      return JSON.parse(fs7.readFileSync(POSITIONS_FILE, "utf-8"));
    }
  } catch {
  }
  return {};
}
function savePositions(positions) {
  ensureConfigDir();
  const tempFile = POSITIONS_FILE + ".tmp";
  fs7.writeFileSync(tempFile, JSON.stringify(positions, null, 2));
  fs7.renameSync(tempFile, POSITIONS_FILE);
}
function getPosition(filePath) {
  return loadPositions()[filePath] || 0;
}
function setPosition(filePath, offset) {
  const positions = loadPositions();
  positions[filePath] = offset;
  savePositions(positions);
}

// src/syncLedger.ts
import * as fs8 from "fs";
import * as path8 from "path";
var CONFIG_DIR2 = process.env.HOME + "/.codecast";
var LEDGER_FILE = path8.join(CONFIG_DIR2, "sync-ledger.json");
var POSITIONS_FILE2 = path8.join(CONFIG_DIR2, "positions.json");
function loadPositions2() {
  try {
    if (fs8.existsSync(POSITIONS_FILE2)) {
      return JSON.parse(fs8.readFileSync(POSITIONS_FILE2, "utf-8"));
    }
  } catch {
  }
  return {};
}
function ensureConfigDir2() {
  if (!fs8.existsSync(CONFIG_DIR2)) {
    fs8.mkdirSync(CONFIG_DIR2, { recursive: true });
  }
}
function loadLedger() {
  try {
    if (fs8.existsSync(LEDGER_FILE)) {
      return JSON.parse(fs8.readFileSync(LEDGER_FILE, "utf-8"));
    }
  } catch {
  }
  return {};
}
function saveLedger(ledger) {
  ensureConfigDir2();
  const tempFile = LEDGER_FILE + ".tmp";
  fs8.writeFileSync(tempFile, JSON.stringify(ledger, null, 2));
  fs8.renameSync(tempFile, LEDGER_FILE);
}
function getSyncRecord(filePath) {
  const ledger = loadLedger();
  if (ledger[filePath]) {
    return ledger[filePath];
  }
  const positions = loadPositions2();
  if (positions[filePath] !== undefined) {
    return {
      lastSyncedAt: 0,
      lastSyncedPosition: positions[filePath],
      messageCount: 0,
      isLegacyFallback: true
    };
  }
  return null;
}
function updateSyncRecord(filePath, update) {
  const ledger = loadLedger();
  const existing = ledger[filePath] || {
    lastSyncedAt: 0,
    lastSyncedPosition: 0,
    messageCount: 0
  };
  ledger[filePath] = { ...existing, ...update };
  saveLedger(ledger);
}
function markSynced(filePath, position, messageCount, conversationId) {
  updateSyncRecord(filePath, {
    lastSyncedAt: Date.now(),
    lastSyncedPosition: position,
    messageCount,
    conversationId
  });
}
function findUnsyncedFiles(baseDir, maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const ledger = loadLedger();
  const positions = loadPositions2();
  const now = Date.now();
  const unsynced = [];
  if (!fs8.existsSync(baseDir))
    return unsynced;
  const scanDir = (dir) => {
    try {
      const entries = fs8.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path8.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".jsonl")) {
          try {
            const stats = fs8.statSync(fullPath);
            const fileAge = now - stats.mtimeMs;
            if (fileAge > maxAgeMs)
              continue;
            const record = ledger[fullPath];
            const legacyPosition = positions[fullPath];
            if (record) {
              if (stats.mtimeMs > record.lastSyncedAt || stats.size > record.lastSyncedPosition) {
                unsynced.push(fullPath);
              }
            } else if (legacyPosition !== undefined) {
              if (stats.size > legacyPosition) {
                unsynced.push(fullPath);
              }
            } else {
              unsynced.push(fullPath);
            }
          } catch {
          }
        }
      }
    } catch {
    }
  };
  scanDir(baseDir);
  return unsynced;
}

// node_modules/convex/dist/esm/index.js
var version = "1.31.2";

// node_modules/convex/dist/esm/values/base64.js
var exports_base64 = {};
__export(exports_base64, {
  toByteArray: () => toByteArray,
  fromByteArrayUrlSafeNoPadding: () => fromByteArrayUrlSafeNoPadding,
  fromByteArray: () => fromByteArray,
  byteLength: () => byteLength
});
var lookup = [];
var revLookup = [];
var Arr = Uint8Array;
var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (i = 0, len = code.length;i < len; ++i) {
  lookup[i] = code[i];
  revLookup[code.charCodeAt(i)] = i;
}
var i;
var len;
revLookup[45] = 62;
revLookup[95] = 63;
function getLens(b64) {
  var len = b64.length;
  if (len % 4 > 0) {
    throw new Error("Invalid string. Length must be a multiple of 4");
  }
  var validLen = b64.indexOf("=");
  if (validLen === -1)
    validLen = len;
  var placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
  return [validLen, placeHoldersLen];
}
function byteLength(b64) {
  var lens = getLens(b64);
  var validLen = lens[0];
  var placeHoldersLen = lens[1];
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}
function _byteLength(_b64, validLen, placeHoldersLen) {
  return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
}
function toByteArray(b64) {
  var tmp;
  var lens = getLens(b64);
  var validLen = lens[0];
  var placeHoldersLen = lens[1];
  var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
  var curByte = 0;
  var len = placeHoldersLen > 0 ? validLen - 4 : validLen;
  var i;
  for (i = 0;i < len; i += 4) {
    tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
    arr[curByte++] = tmp >> 16 & 255;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 2) {
    tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
    arr[curByte++] = tmp & 255;
  }
  if (placeHoldersLen === 1) {
    tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
    arr[curByte++] = tmp >> 8 & 255;
    arr[curByte++] = tmp & 255;
  }
  return arr;
}
function tripletToBase64(num) {
  return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
}
function encodeChunk(uint8, start, end) {
  var tmp;
  var output = [];
  for (var i = start;i < end; i += 3) {
    tmp = (uint8[i] << 16 & 16711680) + (uint8[i + 1] << 8 & 65280) + (uint8[i + 2] & 255);
    output.push(tripletToBase64(tmp));
  }
  return output.join("");
}
function fromByteArray(uint8) {
  var tmp;
  var len = uint8.length;
  var extraBytes = len % 3;
  var parts = [];
  var maxChunkLength = 16383;
  for (var i = 0, len2 = len - extraBytes;i < len2; i += maxChunkLength) {
    parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));
  }
  if (extraBytes === 1) {
    tmp = uint8[len - 1];
    parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
  } else if (extraBytes === 2) {
    tmp = (uint8[len - 2] << 8) + uint8[len - 1];
    parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
  }
  return parts.join("");
}
function fromByteArrayUrlSafeNoPadding(uint8) {
  return fromByteArray(uint8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// node_modules/convex/dist/esm/common/index.js
function parseArgs(args) {
  if (args === undefined) {
    return {};
  }
  if (!isSimpleObject(args)) {
    throw new Error(`The arguments to a Convex function must be an object. Received: ${args}`);
  }
  return args;
}
function validateDeploymentUrl(deploymentUrl) {
  if (typeof deploymentUrl === "undefined") {
    throw new Error(`Client created with undefined deployment address. If you used an environment variable, check that it's set.`);
  }
  if (typeof deploymentUrl !== "string") {
    throw new Error(`Invalid deployment address: found ${deploymentUrl}".`);
  }
  if (!(deploymentUrl.startsWith("http:") || deploymentUrl.startsWith("https:"))) {
    throw new Error(`Invalid deployment address: Must start with "https://" or "http://". Found "${deploymentUrl}".`);
  }
  try {
    new URL(deploymentUrl);
  } catch {
    throw new Error(`Invalid deployment address: "${deploymentUrl}" is not a valid URL. If you believe this URL is correct, use the \`skipConvexDeploymentUrlCheck\` option to bypass this.`);
  }
  if (deploymentUrl.endsWith(".convex.site")) {
    throw new Error(`Invalid deployment address: "${deploymentUrl}" ends with .convex.site, which is used for HTTP Actions. Convex deployment URLs typically end with .convex.cloud? If you believe this URL is correct, use the \`skipConvexDeploymentUrlCheck\` option to bypass this.`);
  }
}
function isSimpleObject(value) {
  const isObject = typeof value === "object";
  const prototype = Object.getPrototypeOf(value);
  const isSimple = prototype === null || prototype === Object.prototype || prototype?.constructor?.name === "Object";
  return isObject && isSimple;
}

// node_modules/convex/dist/esm/values/value.js
var LITTLE_ENDIAN = true;
var MIN_INT64 = BigInt("-9223372036854775808");
var MAX_INT64 = BigInt("9223372036854775807");
var ZERO = BigInt("0");
var EIGHT = BigInt("8");
var TWOFIFTYSIX = BigInt("256");
function isSpecial(n) {
  return Number.isNaN(n) || !Number.isFinite(n) || Object.is(n, -0);
}
function slowBigIntToBase64(value) {
  if (value < ZERO) {
    value -= MIN_INT64 + MIN_INT64;
  }
  let hex = value.toString(16);
  if (hex.length % 2 === 1)
    hex = "0" + hex;
  const bytes = new Uint8Array(new ArrayBuffer(8));
  let i = 0;
  for (const hexByte of hex.match(/.{2}/g).reverse()) {
    bytes.set([parseInt(hexByte, 16)], i++);
    value >>= EIGHT;
  }
  return fromByteArray(bytes);
}
function slowBase64ToBigInt(encoded) {
  const integerBytes = toByteArray(encoded);
  if (integerBytes.byteLength !== 8) {
    throw new Error(`Received ${integerBytes.byteLength} bytes, expected 8 for $integer`);
  }
  let value = ZERO;
  let power = ZERO;
  for (const byte of integerBytes) {
    value += BigInt(byte) * TWOFIFTYSIX ** power;
    power++;
  }
  if (value > MAX_INT64) {
    value += MIN_INT64 + MIN_INT64;
  }
  return value;
}
function modernBigIntToBase64(value) {
  if (value < MIN_INT64 || MAX_INT64 < value) {
    throw new Error(`BigInt ${value} does not fit into a 64-bit signed integer.`);
  }
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigInt64(0, value, true);
  return fromByteArray(new Uint8Array(buffer));
}
function modernBase64ToBigInt(encoded) {
  const integerBytes = toByteArray(encoded);
  if (integerBytes.byteLength !== 8) {
    throw new Error(`Received ${integerBytes.byteLength} bytes, expected 8 for $integer`);
  }
  const intBytesView = new DataView(integerBytes.buffer);
  return intBytesView.getBigInt64(0, true);
}
var bigIntToBase64 = DataView.prototype.setBigInt64 ? modernBigIntToBase64 : slowBigIntToBase64;
var base64ToBigInt = DataView.prototype.getBigInt64 ? modernBase64ToBigInt : slowBase64ToBigInt;
var MAX_IDENTIFIER_LEN = 1024;
function validateObjectField(k) {
  if (k.length > MAX_IDENTIFIER_LEN) {
    throw new Error(`Field name ${k} exceeds maximum field name length ${MAX_IDENTIFIER_LEN}.`);
  }
  if (k.startsWith("$")) {
    throw new Error(`Field name ${k} starts with a '$', which is reserved.`);
  }
  for (let i = 0;i < k.length; i += 1) {
    const charCode = k.charCodeAt(i);
    if (charCode < 32 || charCode >= 127) {
      throw new Error(`Field name ${k} has invalid character '${k[i]}': Field names can only contain non-control ASCII characters`);
    }
  }
}
function jsonToConvex(value) {
  if (value === null) {
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((value2) => jsonToConvex(value2));
  }
  if (typeof value !== "object") {
    throw new Error(`Unexpected type of ${value}`);
  }
  const entries = Object.entries(value);
  if (entries.length === 1) {
    const key = entries[0][0];
    if (key === "$bytes") {
      if (typeof value.$bytes !== "string") {
        throw new Error(`Malformed $bytes field on ${value}`);
      }
      return toByteArray(value.$bytes).buffer;
    }
    if (key === "$integer") {
      if (typeof value.$integer !== "string") {
        throw new Error(`Malformed $integer field on ${value}`);
      }
      return base64ToBigInt(value.$integer);
    }
    if (key === "$float") {
      if (typeof value.$float !== "string") {
        throw new Error(`Malformed $float field on ${value}`);
      }
      const floatBytes = toByteArray(value.$float);
      if (floatBytes.byteLength !== 8) {
        throw new Error(`Received ${floatBytes.byteLength} bytes, expected 8 for $float`);
      }
      const floatBytesView = new DataView(floatBytes.buffer);
      const float = floatBytesView.getFloat64(0, LITTLE_ENDIAN);
      if (!isSpecial(float)) {
        throw new Error(`Float ${float} should be encoded as a number`);
      }
      return float;
    }
    if (key === "$set") {
      throw new Error(`Received a Set which is no longer supported as a Convex type.`);
    }
    if (key === "$map") {
      throw new Error(`Received a Map which is no longer supported as a Convex type.`);
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    validateObjectField(k);
    out[k] = jsonToConvex(v);
  }
  return out;
}
var MAX_VALUE_FOR_ERROR_LEN = 16384;
function stringifyValueForError(value) {
  const str = JSON.stringify(value, (_key, value2) => {
    if (value2 === undefined) {
      return "undefined";
    }
    if (typeof value2 === "bigint") {
      return `${value2.toString()}n`;
    }
    return value2;
  });
  if (str.length > MAX_VALUE_FOR_ERROR_LEN) {
    const rest = "[...truncated]";
    let truncateAt = MAX_VALUE_FOR_ERROR_LEN - rest.length;
    const codePoint = str.codePointAt(truncateAt - 1);
    if (codePoint !== undefined && codePoint > 65535) {
      truncateAt -= 1;
    }
    return str.substring(0, truncateAt) + rest;
  }
  return str;
}
function convexToJsonInternal(value, originalValue, context, includeTopLevelUndefined) {
  if (value === undefined) {
    const contextText = context && ` (present at path ${context} in original object ${stringifyValueForError(originalValue)})`;
    throw new Error(`undefined is not a valid Convex value${contextText}. To learn about Convex's supported types, see https://docs.convex.dev/using/types.`);
  }
  if (value === null) {
    return value;
  }
  if (typeof value === "bigint") {
    if (value < MIN_INT64 || MAX_INT64 < value) {
      throw new Error(`BigInt ${value} does not fit into a 64-bit signed integer.`);
    }
    return { $integer: bigIntToBase64(value) };
  }
  if (typeof value === "number") {
    if (isSpecial(value)) {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, value, LITTLE_ENDIAN);
      return { $float: fromByteArray(new Uint8Array(buffer)) };
    } else {
      return value;
    }
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return { $bytes: fromByteArray(new Uint8Array(value)) };
  }
  if (Array.isArray(value)) {
    return value.map((value2, i) => convexToJsonInternal(value2, originalValue, context + `[${i}]`, false));
  }
  if (value instanceof Set) {
    throw new Error(errorMessageForUnsupportedType(context, "Set", [...value], originalValue));
  }
  if (value instanceof Map) {
    throw new Error(errorMessageForUnsupportedType(context, "Map", [...value], originalValue));
  }
  if (!isSimpleObject(value)) {
    const theType = value?.constructor?.name;
    const typeName = theType ? `${theType} ` : "";
    throw new Error(errorMessageForUnsupportedType(context, typeName, value, originalValue));
  }
  const out = {};
  const entries = Object.entries(value);
  entries.sort(([k1, _v1], [k2, _v2]) => k1 === k2 ? 0 : k1 < k2 ? -1 : 1);
  for (const [k, v] of entries) {
    if (v !== undefined) {
      validateObjectField(k);
      out[k] = convexToJsonInternal(v, originalValue, context + `.${k}`, false);
    } else if (includeTopLevelUndefined) {
      validateObjectField(k);
      out[k] = convexOrUndefinedToJsonInternal(v, originalValue, context + `.${k}`);
    }
  }
  return out;
}
function errorMessageForUnsupportedType(context, typeName, value, originalValue) {
  if (context) {
    return `${typeName}${stringifyValueForError(value)} is not a supported Convex type (present at path ${context} in original object ${stringifyValueForError(originalValue)}). To learn about Convex's supported types, see https://docs.convex.dev/using/types.`;
  } else {
    return `${typeName}${stringifyValueForError(value)} is not a supported Convex type.`;
  }
}
function convexOrUndefinedToJsonInternal(value, originalValue, context) {
  if (value === undefined) {
    return { $undefined: null };
  } else {
    if (originalValue === undefined) {
      throw new Error(`Programming error. Current value is ${stringifyValueForError(value)} but original value is undefined`);
    }
    return convexToJsonInternal(value, originalValue, context, false);
  }
}
function convexToJson(value) {
  return convexToJsonInternal(value, value, "", false);
}
// node_modules/convex/dist/esm/values/errors.js
var __defProp2 = Object.defineProperty;
var __defNormalProp = (obj, key, value) => (key in obj) ? __defProp2(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var _a;
var _b;
var IDENTIFYING_FIELD = Symbol.for("ConvexError");

class ConvexError extends (_b = Error, _a = IDENTIFYING_FIELD, _b) {
  constructor(data) {
    super(typeof data === "string" ? data : stringifyValueForError(data));
    __publicField(this, "name", "ConvexError");
    __publicField(this, "data");
    __publicField(this, _a, true);
    this.data = data;
  }
}
// node_modules/convex/dist/esm/browser/logging.js
var __defProp3 = Object.defineProperty;
var __defNormalProp2 = (obj, key, value) => (key in obj) ? __defProp3(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField2 = (obj, key, value) => __defNormalProp2(obj, typeof key !== "symbol" ? key + "" : key, value);
var INFO_COLOR = "color:rgb(0, 145, 255)";
function prefix_for_source(source) {
  switch (source) {
    case "query":
      return "Q";
    case "mutation":
      return "M";
    case "action":
      return "A";
    case "any":
      return "?";
  }
}

class DefaultLogger {
  constructor(options) {
    __publicField2(this, "_onLogLineFuncs");
    __publicField2(this, "_verbose");
    this._onLogLineFuncs = {};
    this._verbose = options.verbose;
  }
  addLogLineListener(func) {
    let id = Math.random().toString(36).substring(2, 15);
    for (let i = 0;i < 10; i++) {
      if (this._onLogLineFuncs[id] === undefined) {
        break;
      }
      id = Math.random().toString(36).substring(2, 15);
    }
    this._onLogLineFuncs[id] = func;
    return () => {
      delete this._onLogLineFuncs[id];
    };
  }
  logVerbose(...args) {
    if (this._verbose) {
      for (const func of Object.values(this._onLogLineFuncs)) {
        func("debug", `${(/* @__PURE__ */ new Date()).toISOString()}`, ...args);
      }
    }
  }
  log(...args) {
    for (const func of Object.values(this._onLogLineFuncs)) {
      func("info", ...args);
    }
  }
  warn(...args) {
    for (const func of Object.values(this._onLogLineFuncs)) {
      func("warn", ...args);
    }
  }
  error(...args) {
    for (const func of Object.values(this._onLogLineFuncs)) {
      func("error", ...args);
    }
  }
}
function instantiateDefaultLogger(options) {
  const logger = new DefaultLogger(options);
  logger.addLogLineListener((level, ...args) => {
    switch (level) {
      case "debug":
        console.debug(...args);
        break;
      case "info":
        console.log(...args);
        break;
      case "warn":
        console.warn(...args);
        break;
      case "error":
        console.error(...args);
        break;
      default: {
        console.log(...args);
      }
    }
  });
  return logger;
}
function instantiateNoopLogger(options) {
  return new DefaultLogger(options);
}
function logForFunction(logger, type, source, udfPath, message) {
  const prefix = prefix_for_source(source);
  if (typeof message === "object") {
    message = `ConvexError ${JSON.stringify(message.errorData, null, 2)}`;
  }
  if (type === "info") {
    const match = message.match(/^\[.*?\] /);
    if (match === null) {
      logger.error(`[CONVEX ${prefix}(${udfPath})] Could not parse console.log`);
      return;
    }
    const level = message.slice(1, match[0].length - 2);
    const args = message.slice(match[0].length);
    logger.log(`%c[CONVEX ${prefix}(${udfPath})] [${level}]`, INFO_COLOR, args);
  } else {
    logger.error(`[CONVEX ${prefix}(${udfPath})] ${message}`);
  }
}
function logFatalError(logger, message) {
  const errorMessage = `[CONVEX FATAL ERROR] ${message}`;
  logger.error(errorMessage);
  return new Error(errorMessage);
}
function createHybridErrorStacktrace(source, udfPath, result) {
  const prefix = prefix_for_source(source);
  return `[CONVEX ${prefix}(${udfPath})] ${result.errorMessage}
  Called by client`;
}
function forwardData(result, error) {
  error.data = result.errorData;
  return error;
}

// node_modules/convex/dist/esm/browser/sync/udf_path_utils.js
function canonicalizeUdfPath(udfPath) {
  const pieces = udfPath.split(":");
  let moduleName;
  let functionName;
  if (pieces.length === 1) {
    moduleName = pieces[0];
    functionName = "default";
  } else {
    moduleName = pieces.slice(0, pieces.length - 1).join(":");
    functionName = pieces[pieces.length - 1];
  }
  if (moduleName.endsWith(".js")) {
    moduleName = moduleName.slice(0, -3);
  }
  return `${moduleName}:${functionName}`;
}
function serializePathAndArgs(udfPath, args) {
  return JSON.stringify({
    udfPath: canonicalizeUdfPath(udfPath),
    args: convexToJson(args)
  });
}
function serializePaginatedPathAndArgs(udfPath, args, options) {
  const { initialNumItems, id } = options;
  const result = JSON.stringify({
    type: "paginated",
    udfPath: canonicalizeUdfPath(udfPath),
    args: convexToJson(args),
    options: convexToJson({ initialNumItems, id })
  });
  return result;
}
function serializedQueryTokenIsPaginated(token) {
  return JSON.parse(token).type === "paginated";
}

// node_modules/convex/dist/esm/browser/sync/local_state.js
var __defProp4 = Object.defineProperty;
var __defNormalProp3 = (obj, key, value) => (key in obj) ? __defProp4(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField3 = (obj, key, value) => __defNormalProp3(obj, typeof key !== "symbol" ? key + "" : key, value);

class LocalSyncState {
  constructor() {
    __publicField3(this, "nextQueryId");
    __publicField3(this, "querySetVersion");
    __publicField3(this, "querySet");
    __publicField3(this, "queryIdToToken");
    __publicField3(this, "identityVersion");
    __publicField3(this, "auth");
    __publicField3(this, "outstandingQueriesOlderThanRestart");
    __publicField3(this, "outstandingAuthOlderThanRestart");
    __publicField3(this, "paused");
    __publicField3(this, "pendingQuerySetModifications");
    this.nextQueryId = 0;
    this.querySetVersion = 0;
    this.identityVersion = 0;
    this.querySet = /* @__PURE__ */ new Map;
    this.queryIdToToken = /* @__PURE__ */ new Map;
    this.outstandingQueriesOlderThanRestart = /* @__PURE__ */ new Set;
    this.outstandingAuthOlderThanRestart = false;
    this.paused = false;
    this.pendingQuerySetModifications = /* @__PURE__ */ new Map;
  }
  hasSyncedPastLastReconnect() {
    return this.outstandingQueriesOlderThanRestart.size === 0 && !this.outstandingAuthOlderThanRestart;
  }
  markAuthCompletion() {
    this.outstandingAuthOlderThanRestart = false;
  }
  subscribe(udfPath, args, journal, componentPath) {
    const canonicalizedUdfPath = canonicalizeUdfPath(udfPath);
    const queryToken = serializePathAndArgs(canonicalizedUdfPath, args);
    const existingEntry = this.querySet.get(queryToken);
    if (existingEntry !== undefined) {
      existingEntry.numSubscribers += 1;
      return {
        queryToken,
        modification: null,
        unsubscribe: () => this.removeSubscriber(queryToken)
      };
    } else {
      const queryId = this.nextQueryId++;
      const query = {
        id: queryId,
        canonicalizedUdfPath,
        args,
        numSubscribers: 1,
        journal,
        componentPath
      };
      this.querySet.set(queryToken, query);
      this.queryIdToToken.set(queryId, queryToken);
      const baseVersion = this.querySetVersion;
      const newVersion = this.querySetVersion + 1;
      const add = {
        type: "Add",
        queryId,
        udfPath: canonicalizedUdfPath,
        args: [convexToJson(args)],
        journal,
        componentPath
      };
      if (this.paused) {
        this.pendingQuerySetModifications.set(queryId, add);
      } else {
        this.querySetVersion = newVersion;
      }
      const modification = {
        type: "ModifyQuerySet",
        baseVersion,
        newVersion,
        modifications: [add]
      };
      return {
        queryToken,
        modification,
        unsubscribe: () => this.removeSubscriber(queryToken)
      };
    }
  }
  transition(transition) {
    for (const modification of transition.modifications) {
      switch (modification.type) {
        case "QueryUpdated":
        case "QueryFailed": {
          this.outstandingQueriesOlderThanRestart.delete(modification.queryId);
          const journal = modification.journal;
          if (journal !== undefined) {
            const queryToken = this.queryIdToToken.get(modification.queryId);
            if (queryToken !== undefined) {
              this.querySet.get(queryToken).journal = journal;
            }
          }
          break;
        }
        case "QueryRemoved": {
          this.outstandingQueriesOlderThanRestart.delete(modification.queryId);
          break;
        }
        default: {
          throw new Error(`Invalid modification ${modification.type}`);
        }
      }
    }
  }
  queryId(udfPath, args) {
    const canonicalizedUdfPath = canonicalizeUdfPath(udfPath);
    const queryToken = serializePathAndArgs(canonicalizedUdfPath, args);
    const existingEntry = this.querySet.get(queryToken);
    if (existingEntry !== undefined) {
      return existingEntry.id;
    }
    return null;
  }
  isCurrentOrNewerAuthVersion(version2) {
    return version2 >= this.identityVersion;
  }
  getAuth() {
    return this.auth;
  }
  setAuth(value) {
    this.auth = {
      tokenType: "User",
      value
    };
    const baseVersion = this.identityVersion;
    if (!this.paused) {
      this.identityVersion = baseVersion + 1;
    }
    return {
      type: "Authenticate",
      baseVersion,
      ...this.auth
    };
  }
  setAdminAuth(value, actingAs) {
    const auth = {
      tokenType: "Admin",
      value,
      impersonating: actingAs
    };
    this.auth = auth;
    const baseVersion = this.identityVersion;
    if (!this.paused) {
      this.identityVersion = baseVersion + 1;
    }
    return {
      type: "Authenticate",
      baseVersion,
      ...auth
    };
  }
  clearAuth() {
    this.auth = undefined;
    this.markAuthCompletion();
    const baseVersion = this.identityVersion;
    if (!this.paused) {
      this.identityVersion = baseVersion + 1;
    }
    return {
      type: "Authenticate",
      tokenType: "None",
      baseVersion
    };
  }
  hasAuth() {
    return !!this.auth;
  }
  isNewAuth(value) {
    return this.auth?.value !== value;
  }
  queryPath(queryId) {
    const pathAndArgs = this.queryIdToToken.get(queryId);
    if (pathAndArgs) {
      return this.querySet.get(pathAndArgs).canonicalizedUdfPath;
    }
    return null;
  }
  queryArgs(queryId) {
    const pathAndArgs = this.queryIdToToken.get(queryId);
    if (pathAndArgs) {
      return this.querySet.get(pathAndArgs).args;
    }
    return null;
  }
  queryToken(queryId) {
    return this.queryIdToToken.get(queryId) ?? null;
  }
  queryJournal(queryToken) {
    return this.querySet.get(queryToken)?.journal;
  }
  restart(oldRemoteQueryResults) {
    this.unpause();
    this.outstandingQueriesOlderThanRestart.clear();
    const modifications = [];
    for (const localQuery of this.querySet.values()) {
      const add = {
        type: "Add",
        queryId: localQuery.id,
        udfPath: localQuery.canonicalizedUdfPath,
        args: [convexToJson(localQuery.args)],
        journal: localQuery.journal,
        componentPath: localQuery.componentPath
      };
      modifications.push(add);
      if (!oldRemoteQueryResults.has(localQuery.id)) {
        this.outstandingQueriesOlderThanRestart.add(localQuery.id);
      }
    }
    this.querySetVersion = 1;
    const querySet = {
      type: "ModifyQuerySet",
      baseVersion: 0,
      newVersion: 1,
      modifications
    };
    if (!this.auth) {
      this.identityVersion = 0;
      return [querySet, undefined];
    }
    this.outstandingAuthOlderThanRestart = true;
    const authenticate = {
      type: "Authenticate",
      baseVersion: 0,
      ...this.auth
    };
    this.identityVersion = 1;
    return [querySet, authenticate];
  }
  pause() {
    this.paused = true;
  }
  resume() {
    const querySet = this.pendingQuerySetModifications.size > 0 ? {
      type: "ModifyQuerySet",
      baseVersion: this.querySetVersion,
      newVersion: ++this.querySetVersion,
      modifications: Array.from(this.pendingQuerySetModifications.values())
    } : undefined;
    const authenticate = this.auth !== undefined ? {
      type: "Authenticate",
      baseVersion: this.identityVersion++,
      ...this.auth
    } : undefined;
    this.unpause();
    return [querySet, authenticate];
  }
  unpause() {
    this.paused = false;
    this.pendingQuerySetModifications.clear();
  }
  removeSubscriber(queryToken) {
    const localQuery = this.querySet.get(queryToken);
    if (localQuery.numSubscribers > 1) {
      localQuery.numSubscribers -= 1;
      return null;
    } else {
      this.querySet.delete(queryToken);
      this.queryIdToToken.delete(localQuery.id);
      this.outstandingQueriesOlderThanRestart.delete(localQuery.id);
      const baseVersion = this.querySetVersion;
      const newVersion = this.querySetVersion + 1;
      const remove = {
        type: "Remove",
        queryId: localQuery.id
      };
      if (this.paused) {
        if (this.pendingQuerySetModifications.has(localQuery.id)) {
          this.pendingQuerySetModifications.delete(localQuery.id);
        } else {
          this.pendingQuerySetModifications.set(localQuery.id, remove);
        }
      } else {
        this.querySetVersion = newVersion;
      }
      return {
        type: "ModifyQuerySet",
        baseVersion,
        newVersion,
        modifications: [remove]
      };
    }
  }
}

// node_modules/convex/dist/esm/browser/sync/request_manager.js
var __defProp5 = Object.defineProperty;
var __defNormalProp4 = (obj, key, value) => (key in obj) ? __defProp5(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField4 = (obj, key, value) => __defNormalProp4(obj, typeof key !== "symbol" ? key + "" : key, value);

class RequestManager {
  constructor(logger, markConnectionStateDirty) {
    this.logger = logger;
    this.markConnectionStateDirty = markConnectionStateDirty;
    __publicField4(this, "inflightRequests");
    __publicField4(this, "requestsOlderThanRestart");
    __publicField4(this, "inflightMutationsCount", 0);
    __publicField4(this, "inflightActionsCount", 0);
    this.inflightRequests = /* @__PURE__ */ new Map;
    this.requestsOlderThanRestart = /* @__PURE__ */ new Set;
  }
  request(message, sent) {
    const result = new Promise((resolve3) => {
      const status = sent ? "Requested" : "NotSent";
      this.inflightRequests.set(message.requestId, {
        message,
        status: { status, requestedAt: /* @__PURE__ */ new Date, onResult: resolve3 }
      });
      if (message.type === "Mutation") {
        this.inflightMutationsCount++;
      } else if (message.type === "Action") {
        this.inflightActionsCount++;
      }
    });
    this.markConnectionStateDirty();
    return result;
  }
  onResponse(response) {
    const requestInfo = this.inflightRequests.get(response.requestId);
    if (requestInfo === undefined) {
      return null;
    }
    if (requestInfo.status.status === "Completed") {
      return null;
    }
    const udfType = requestInfo.message.type === "Mutation" ? "mutation" : "action";
    const udfPath = requestInfo.message.udfPath;
    for (const line of response.logLines) {
      logForFunction(this.logger, "info", udfType, udfPath, line);
    }
    const status = requestInfo.status;
    let result;
    let onResolve;
    if (response.success) {
      result = {
        success: true,
        logLines: response.logLines,
        value: jsonToConvex(response.result)
      };
      onResolve = () => status.onResult(result);
    } else {
      const errorMessage = response.result;
      const { errorData } = response;
      logForFunction(this.logger, "error", udfType, udfPath, errorMessage);
      result = {
        success: false,
        errorMessage,
        errorData: errorData !== undefined ? jsonToConvex(errorData) : undefined,
        logLines: response.logLines
      };
      onResolve = () => status.onResult(result);
    }
    if (response.type === "ActionResponse" || !response.success) {
      onResolve();
      this.inflightRequests.delete(response.requestId);
      this.requestsOlderThanRestart.delete(response.requestId);
      if (requestInfo.message.type === "Action") {
        this.inflightActionsCount--;
      } else if (requestInfo.message.type === "Mutation") {
        this.inflightMutationsCount--;
      }
      this.markConnectionStateDirty();
      return { requestId: response.requestId, result };
    }
    requestInfo.status = {
      status: "Completed",
      result,
      ts: response.ts,
      onResolve
    };
    return null;
  }
  removeCompleted(ts) {
    const completeRequests = /* @__PURE__ */ new Map;
    for (const [requestId, requestInfo] of this.inflightRequests.entries()) {
      const status = requestInfo.status;
      if (status.status === "Completed" && status.ts.lessThanOrEqual(ts)) {
        status.onResolve();
        completeRequests.set(requestId, status.result);
        if (requestInfo.message.type === "Mutation") {
          this.inflightMutationsCount--;
        } else if (requestInfo.message.type === "Action") {
          this.inflightActionsCount--;
        }
        this.inflightRequests.delete(requestId);
        this.requestsOlderThanRestart.delete(requestId);
      }
    }
    if (completeRequests.size > 0) {
      this.markConnectionStateDirty();
    }
    return completeRequests;
  }
  restart() {
    this.requestsOlderThanRestart = new Set(this.inflightRequests.keys());
    const allMessages = [];
    for (const [requestId, value] of this.inflightRequests) {
      if (value.status.status === "NotSent") {
        value.status.status = "Requested";
        allMessages.push(value.message);
        continue;
      }
      if (value.message.type === "Mutation") {
        allMessages.push(value.message);
      } else if (value.message.type === "Action") {
        this.inflightRequests.delete(requestId);
        this.requestsOlderThanRestart.delete(requestId);
        this.inflightActionsCount--;
        if (value.status.status === "Completed") {
          throw new Error("Action should never be in 'Completed' state");
        }
        value.status.onResult({
          success: false,
          errorMessage: "Connection lost while action was in flight",
          logLines: []
        });
      }
    }
    this.markConnectionStateDirty();
    return allMessages;
  }
  resume() {
    const allMessages = [];
    for (const [, value] of this.inflightRequests) {
      if (value.status.status === "NotSent") {
        value.status.status = "Requested";
        allMessages.push(value.message);
        continue;
      }
    }
    return allMessages;
  }
  hasIncompleteRequests() {
    for (const requestInfo of this.inflightRequests.values()) {
      if (requestInfo.status.status === "Requested") {
        return true;
      }
    }
    return false;
  }
  hasInflightRequests() {
    return this.inflightRequests.size > 0;
  }
  hasSyncedPastLastReconnect() {
    return this.requestsOlderThanRestart.size === 0;
  }
  timeOfOldestInflightRequest() {
    if (this.inflightRequests.size === 0) {
      return null;
    }
    let oldestInflightRequest = Date.now();
    for (const request of this.inflightRequests.values()) {
      if (request.status.status !== "Completed") {
        if (request.status.requestedAt.getTime() < oldestInflightRequest) {
          oldestInflightRequest = request.status.requestedAt.getTime();
        }
      }
    }
    return new Date(oldestInflightRequest);
  }
  inflightMutations() {
    return this.inflightMutationsCount;
  }
  inflightActions() {
    return this.inflightActionsCount;
  }
}

// node_modules/convex/dist/esm/server/functionName.js
var functionName = Symbol.for("functionName");

// node_modules/convex/dist/esm/server/components/paths.js
var toReferencePath = Symbol.for("toReferencePath");
function extractReferencePath(reference) {
  return reference[toReferencePath] ?? null;
}
function isFunctionHandle(s) {
  return s.startsWith("function://");
}
function getFunctionAddress(functionReference) {
  let functionAddress;
  if (typeof functionReference === "string") {
    if (isFunctionHandle(functionReference)) {
      functionAddress = { functionHandle: functionReference };
    } else {
      functionAddress = { name: functionReference };
    }
  } else if (functionReference[functionName]) {
    functionAddress = { name: functionReference[functionName] };
  } else {
    const referencePath = extractReferencePath(functionReference);
    if (!referencePath) {
      throw new Error(`${functionReference} is not a functionReference`);
    }
    functionAddress = { reference: referencePath };
  }
  return functionAddress;
}

// node_modules/convex/dist/esm/server/api.js
function getFunctionName(functionReference) {
  const address = getFunctionAddress(functionReference);
  if (address.name === undefined) {
    if (address.functionHandle !== undefined) {
      throw new Error(`Expected function reference like "api.file.func" or "internal.file.func", but received function handle ${address.functionHandle}`);
    } else if (address.reference !== undefined) {
      throw new Error(`Expected function reference in the current component like "api.file.func" or "internal.file.func", but received reference ${address.reference}`);
    }
    throw new Error(`Expected function reference like "api.file.func" or "internal.file.func", but received ${JSON.stringify(address)}`);
  }
  if (typeof functionReference === "string")
    return functionReference;
  const name = functionReference[functionName];
  if (!name) {
    throw new Error(`${functionReference} is not a functionReference`);
  }
  return name;
}
function createApi(pathParts = []) {
  const handler = {
    get(_, prop) {
      if (typeof prop === "string") {
        const newParts = [...pathParts, prop];
        return createApi(newParts);
      } else if (prop === functionName) {
        if (pathParts.length < 2) {
          const found = ["api", ...pathParts].join(".");
          throw new Error(`API path is expected to be of the form \`api.moduleName.functionName\`. Found: \`${found}\``);
        }
        const path9 = pathParts.slice(0, -1).join("/");
        const exportName = pathParts[pathParts.length - 1];
        if (exportName === "default") {
          return path9;
        } else {
          return path9 + ":" + exportName;
        }
      } else if (prop === Symbol.toStringTag) {
        return "FunctionReference";
      } else {
        return;
      }
    }
  };
  return new Proxy({}, handler);
}
var anyApi = createApi();

// node_modules/convex/dist/esm/browser/sync/optimistic_updates_impl.js
var __defProp6 = Object.defineProperty;
var __defNormalProp5 = (obj, key, value) => (key in obj) ? __defProp6(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField5 = (obj, key, value) => __defNormalProp5(obj, typeof key !== "symbol" ? key + "" : key, value);

class OptimisticLocalStoreImpl {
  constructor(queryResults) {
    __publicField5(this, "queryResults");
    __publicField5(this, "modifiedQueries");
    this.queryResults = queryResults;
    this.modifiedQueries = [];
  }
  getQuery(query, ...args) {
    const queryArgs = parseArgs(args[0]);
    const name = getFunctionName(query);
    const queryResult = this.queryResults.get(serializePathAndArgs(name, queryArgs));
    if (queryResult === undefined) {
      return;
    }
    return OptimisticLocalStoreImpl.queryValue(queryResult.result);
  }
  getAllQueries(query) {
    const queriesWithName = [];
    const name = getFunctionName(query);
    for (const queryResult of this.queryResults.values()) {
      if (queryResult.udfPath === canonicalizeUdfPath(name)) {
        queriesWithName.push({
          args: queryResult.args,
          value: OptimisticLocalStoreImpl.queryValue(queryResult.result)
        });
      }
    }
    return queriesWithName;
  }
  setQuery(queryReference, args, value) {
    const queryArgs = parseArgs(args);
    const name = getFunctionName(queryReference);
    const queryToken = serializePathAndArgs(name, queryArgs);
    let result;
    if (value === undefined) {
      result = undefined;
    } else {
      result = {
        success: true,
        value,
        logLines: []
      };
    }
    const query = {
      udfPath: name,
      args: queryArgs,
      result
    };
    this.queryResults.set(queryToken, query);
    this.modifiedQueries.push(queryToken);
  }
  static queryValue(result) {
    if (result === undefined) {
      return;
    } else if (result.success) {
      return result.value;
    } else {
      return;
    }
  }
}

class OptimisticQueryResults {
  constructor() {
    __publicField5(this, "queryResults");
    __publicField5(this, "optimisticUpdates");
    this.queryResults = /* @__PURE__ */ new Map;
    this.optimisticUpdates = [];
  }
  ingestQueryResultsFromServer(serverQueryResults, optimisticUpdatesToDrop) {
    this.optimisticUpdates = this.optimisticUpdates.filter((updateAndId) => {
      return !optimisticUpdatesToDrop.has(updateAndId.mutationId);
    });
    const oldQueryResults = this.queryResults;
    this.queryResults = new Map(serverQueryResults);
    const localStore = new OptimisticLocalStoreImpl(this.queryResults);
    for (const updateAndId of this.optimisticUpdates) {
      updateAndId.update(localStore);
    }
    const changedQueries = [];
    for (const [queryToken, query] of this.queryResults) {
      const oldQuery = oldQueryResults.get(queryToken);
      if (oldQuery === undefined || oldQuery.result !== query.result) {
        changedQueries.push(queryToken);
      }
    }
    return changedQueries;
  }
  applyOptimisticUpdate(update, mutationId) {
    this.optimisticUpdates.push({
      update,
      mutationId
    });
    const localStore = new OptimisticLocalStoreImpl(this.queryResults);
    update(localStore);
    return localStore.modifiedQueries;
  }
  rawQueryResult(queryToken) {
    const query = this.queryResults.get(queryToken);
    if (query === undefined) {
      return;
    }
    return query.result;
  }
  queryResult(queryToken) {
    const query = this.queryResults.get(queryToken);
    if (query === undefined) {
      return;
    }
    const result = query.result;
    if (result === undefined) {
      return;
    } else if (result.success) {
      return result.value;
    } else {
      if (result.errorData !== undefined) {
        throw forwardData(result, new ConvexError(createHybridErrorStacktrace("query", query.udfPath, result)));
      }
      throw new Error(createHybridErrorStacktrace("query", query.udfPath, result));
    }
  }
  hasQueryResult(queryToken) {
    return this.queryResults.get(queryToken) !== undefined;
  }
  queryLogs(queryToken) {
    const query = this.queryResults.get(queryToken);
    return query?.result?.logLines;
  }
}

// node_modules/convex/dist/esm/vendor/long.js
var __defProp7 = Object.defineProperty;
var __defNormalProp6 = (obj, key, value) => (key in obj) ? __defProp7(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField6 = (obj, key, value) => __defNormalProp6(obj, typeof key !== "symbol" ? key + "" : key, value);

class Long {
  constructor(low, high) {
    __publicField6(this, "low");
    __publicField6(this, "high");
    __publicField6(this, "__isUnsignedLong__");
    this.low = low | 0;
    this.high = high | 0;
    this.__isUnsignedLong__ = true;
  }
  static isLong(obj) {
    return (obj && obj.__isUnsignedLong__) === true;
  }
  static fromBytesLE(bytes) {
    return new Long(bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24, bytes[4] | bytes[5] << 8 | bytes[6] << 16 | bytes[7] << 24);
  }
  toBytesLE() {
    const hi = this.high;
    const lo = this.low;
    return [
      lo & 255,
      lo >>> 8 & 255,
      lo >>> 16 & 255,
      lo >>> 24,
      hi & 255,
      hi >>> 8 & 255,
      hi >>> 16 & 255,
      hi >>> 24
    ];
  }
  static fromNumber(value) {
    if (isNaN(value))
      return UZERO;
    if (value < 0)
      return UZERO;
    if (value >= TWO_PWR_64_DBL)
      return MAX_UNSIGNED_VALUE;
    return new Long(value % TWO_PWR_32_DBL | 0, value / TWO_PWR_32_DBL | 0);
  }
  toString() {
    return (BigInt(this.high) * BigInt(TWO_PWR_32_DBL) + BigInt(this.low)).toString();
  }
  equals(other) {
    if (!Long.isLong(other))
      other = Long.fromValue(other);
    if (this.high >>> 31 === 1 && other.high >>> 31 === 1)
      return false;
    return this.high === other.high && this.low === other.low;
  }
  notEquals(other) {
    return !this.equals(other);
  }
  comp(other) {
    if (!Long.isLong(other))
      other = Long.fromValue(other);
    if (this.equals(other))
      return 0;
    return other.high >>> 0 > this.high >>> 0 || other.high === this.high && other.low >>> 0 > this.low >>> 0 ? -1 : 1;
  }
  lessThanOrEqual(other) {
    return this.comp(other) <= 0;
  }
  static fromValue(val) {
    if (typeof val === "number")
      return Long.fromNumber(val);
    return new Long(val.low, val.high);
  }
}
var UZERO = new Long(0, 0);
var TWO_PWR_16_DBL = 1 << 16;
var TWO_PWR_32_DBL = TWO_PWR_16_DBL * TWO_PWR_16_DBL;
var TWO_PWR_64_DBL = TWO_PWR_32_DBL * TWO_PWR_32_DBL;
var MAX_UNSIGNED_VALUE = new Long(4294967295 | 0, 4294967295 | 0);

// node_modules/convex/dist/esm/browser/sync/remote_query_set.js
var __defProp8 = Object.defineProperty;
var __defNormalProp7 = (obj, key, value) => (key in obj) ? __defProp8(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField7 = (obj, key, value) => __defNormalProp7(obj, typeof key !== "symbol" ? key + "" : key, value);

class RemoteQuerySet {
  constructor(queryPath, logger) {
    __publicField7(this, "version");
    __publicField7(this, "remoteQuerySet");
    __publicField7(this, "queryPath");
    __publicField7(this, "logger");
    this.version = { querySet: 0, ts: Long.fromNumber(0), identity: 0 };
    this.remoteQuerySet = /* @__PURE__ */ new Map;
    this.queryPath = queryPath;
    this.logger = logger;
  }
  transition(transition) {
    const start = transition.startVersion;
    if (this.version.querySet !== start.querySet || this.version.ts.notEquals(start.ts) || this.version.identity !== start.identity) {
      throw new Error(`Invalid start version: ${start.ts.toString()}:${start.querySet}:${start.identity}, transitioning from ${this.version.ts.toString()}:${this.version.querySet}:${this.version.identity}`);
    }
    for (const modification of transition.modifications) {
      switch (modification.type) {
        case "QueryUpdated": {
          const queryPath = this.queryPath(modification.queryId);
          if (queryPath) {
            for (const line of modification.logLines) {
              logForFunction(this.logger, "info", "query", queryPath, line);
            }
          }
          const value = jsonToConvex(modification.value ?? null);
          this.remoteQuerySet.set(modification.queryId, {
            success: true,
            value,
            logLines: modification.logLines
          });
          break;
        }
        case "QueryFailed": {
          const queryPath = this.queryPath(modification.queryId);
          if (queryPath) {
            for (const line of modification.logLines) {
              logForFunction(this.logger, "info", "query", queryPath, line);
            }
          }
          const { errorData } = modification;
          this.remoteQuerySet.set(modification.queryId, {
            success: false,
            errorMessage: modification.errorMessage,
            errorData: errorData !== undefined ? jsonToConvex(errorData) : undefined,
            logLines: modification.logLines
          });
          break;
        }
        case "QueryRemoved": {
          this.remoteQuerySet.delete(modification.queryId);
          break;
        }
        default: {
          throw new Error(`Invalid modification ${modification.type}`);
        }
      }
    }
    this.version = transition.endVersion;
  }
  remoteQueryResults() {
    return this.remoteQuerySet;
  }
  timestamp() {
    return this.version.ts;
  }
}

// node_modules/convex/dist/esm/browser/sync/protocol.js
function u64ToLong(encoded) {
  const integerBytes = exports_base64.toByteArray(encoded);
  return Long.fromBytesLE(Array.from(integerBytes));
}
function longToU64(raw) {
  const integerBytes = new Uint8Array(raw.toBytesLE());
  return exports_base64.fromByteArray(integerBytes);
}
function parseServerMessage(encoded) {
  switch (encoded.type) {
    case "FatalError":
    case "AuthError":
    case "ActionResponse":
    case "TransitionChunk":
    case "Ping": {
      return { ...encoded };
    }
    case "MutationResponse": {
      if (encoded.success) {
        return { ...encoded, ts: u64ToLong(encoded.ts) };
      } else {
        return { ...encoded };
      }
    }
    case "Transition": {
      return {
        ...encoded,
        startVersion: {
          ...encoded.startVersion,
          ts: u64ToLong(encoded.startVersion.ts)
        },
        endVersion: {
          ...encoded.endVersion,
          ts: u64ToLong(encoded.endVersion.ts)
        }
      };
    }
    default: {
    }
  }
  return;
}
function encodeClientMessage(message) {
  switch (message.type) {
    case "Authenticate":
    case "ModifyQuerySet":
    case "Mutation":
    case "Action":
    case "Event": {
      return { ...message };
    }
    case "Connect": {
      if (message.maxObservedTimestamp !== undefined) {
        return {
          ...message,
          maxObservedTimestamp: longToU64(message.maxObservedTimestamp)
        };
      } else {
        return { ...message, maxObservedTimestamp: undefined };
      }
    }
    default: {
    }
  }
  return;
}

// node_modules/convex/dist/esm/browser/sync/web_socket_manager.js
var __defProp9 = Object.defineProperty;
var __defNormalProp8 = (obj, key, value) => (key in obj) ? __defProp9(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField8 = (obj, key, value) => __defNormalProp8(obj, typeof key !== "symbol" ? key + "" : key, value);
var CLOSE_NORMAL = 1000;
var CLOSE_GOING_AWAY = 1001;
var CLOSE_NO_STATUS = 1005;
var CLOSE_NOT_FOUND = 4040;
var firstTime;
function monotonicMillis() {
  if (firstTime === undefined) {
    firstTime = Date.now();
  }
  if (typeof performance === "undefined" || !performance.now) {
    return Date.now();
  }
  return Math.round(firstTime + performance.now());
}
function prettyNow() {
  return `t=${Math.round((monotonicMillis() - firstTime) / 100) / 10}s`;
}
var serverDisconnectErrors = {
  InternalServerError: { timeout: 1000 },
  SubscriptionsWorkerFullError: { timeout: 3000 },
  TooManyConcurrentRequests: { timeout: 3000 },
  CommitterFullError: { timeout: 3000 },
  AwsTooManyRequestsException: { timeout: 3000 },
  ExecuteFullError: { timeout: 3000 },
  SystemTimeoutError: { timeout: 3000 },
  ExpiredInQueue: { timeout: 3000 },
  VectorIndexesUnavailable: { timeout: 1000 },
  SearchIndexesUnavailable: { timeout: 1000 },
  TableSummariesUnavailable: { timeout: 1000 },
  VectorIndexTooLarge: { timeout: 3000 },
  SearchIndexTooLarge: { timeout: 3000 },
  TooManyWritesInTimePeriod: { timeout: 3000 }
};
function classifyDisconnectError(s) {
  if (s === undefined)
    return "Unknown";
  for (const prefix of Object.keys(serverDisconnectErrors)) {
    if (s.startsWith(prefix)) {
      return prefix;
    }
  }
  return "Unknown";
}

class WebSocketManager {
  constructor(uri, callbacks, webSocketConstructor, logger, markConnectionStateDirty, debug) {
    this.markConnectionStateDirty = markConnectionStateDirty;
    this.debug = debug;
    __publicField8(this, "socket");
    __publicField8(this, "connectionCount");
    __publicField8(this, "_hasEverConnected", false);
    __publicField8(this, "lastCloseReason");
    __publicField8(this, "transitionChunkBuffer", null);
    __publicField8(this, "defaultInitialBackoff");
    __publicField8(this, "maxBackoff");
    __publicField8(this, "retries");
    __publicField8(this, "serverInactivityThreshold");
    __publicField8(this, "reconnectDueToServerInactivityTimeout");
    __publicField8(this, "uri");
    __publicField8(this, "onOpen");
    __publicField8(this, "onResume");
    __publicField8(this, "onMessage");
    __publicField8(this, "webSocketConstructor");
    __publicField8(this, "logger");
    __publicField8(this, "onServerDisconnectError");
    this.webSocketConstructor = webSocketConstructor;
    this.socket = { state: "disconnected" };
    this.connectionCount = 0;
    this.lastCloseReason = "InitialConnect";
    this.defaultInitialBackoff = 1000;
    this.maxBackoff = 16000;
    this.retries = 0;
    this.serverInactivityThreshold = 60000;
    this.reconnectDueToServerInactivityTimeout = null;
    this.uri = uri;
    this.onOpen = callbacks.onOpen;
    this.onResume = callbacks.onResume;
    this.onMessage = callbacks.onMessage;
    this.onServerDisconnectError = callbacks.onServerDisconnectError;
    this.logger = logger;
    this.connect();
  }
  setSocketState(state) {
    this.socket = state;
    this._logVerbose(`socket state changed: ${this.socket.state}, paused: ${"paused" in this.socket ? this.socket.paused : undefined}`);
    this.markConnectionStateDirty();
  }
  assembleTransition(chunk) {
    if (chunk.partNumber < 0 || chunk.partNumber >= chunk.totalParts || chunk.totalParts === 0 || this.transitionChunkBuffer && (this.transitionChunkBuffer.totalParts !== chunk.totalParts || this.transitionChunkBuffer.transitionId !== chunk.transitionId)) {
      this.transitionChunkBuffer = null;
      throw new Error("Invalid TransitionChunk");
    }
    if (this.transitionChunkBuffer === null) {
      this.transitionChunkBuffer = {
        chunks: [],
        totalParts: chunk.totalParts,
        transitionId: chunk.transitionId
      };
    }
    if (chunk.partNumber !== this.transitionChunkBuffer.chunks.length) {
      const expectedLength = this.transitionChunkBuffer.chunks.length;
      this.transitionChunkBuffer = null;
      throw new Error(`TransitionChunk received out of order: expected part ${expectedLength}, got ${chunk.partNumber}`);
    }
    this.transitionChunkBuffer.chunks.push(chunk.chunk);
    if (this.transitionChunkBuffer.chunks.length === chunk.totalParts) {
      const fullJson = this.transitionChunkBuffer.chunks.join("");
      this.transitionChunkBuffer = null;
      const transition = parseServerMessage(JSON.parse(fullJson));
      if (transition.type !== "Transition") {
        throw new Error(`Expected Transition, got ${transition.type} after assembling chunks`);
      }
      return transition;
    }
    return null;
  }
  connect() {
    if (this.socket.state === "terminated") {
      return;
    }
    if (this.socket.state !== "disconnected" && this.socket.state !== "stopped") {
      throw new Error("Didn't start connection from disconnected state: " + this.socket.state);
    }
    const ws = new this.webSocketConstructor(this.uri);
    this._logVerbose("constructed WebSocket");
    this.setSocketState({
      state: "connecting",
      ws,
      paused: "no"
    });
    this.resetServerInactivityTimeout();
    ws.onopen = () => {
      this.logger.logVerbose("begin ws.onopen");
      if (this.socket.state !== "connecting") {
        throw new Error("onopen called with socket not in connecting state");
      }
      this.setSocketState({
        state: "ready",
        ws,
        paused: this.socket.paused === "yes" ? "uninitialized" : "no"
      });
      this.resetServerInactivityTimeout();
      if (this.socket.paused === "no") {
        this._hasEverConnected = true;
        this.onOpen({
          connectionCount: this.connectionCount,
          lastCloseReason: this.lastCloseReason,
          clientTs: monotonicMillis()
        });
      }
      if (this.lastCloseReason !== "InitialConnect") {
        if (this.lastCloseReason) {
          this.logger.log("WebSocket reconnected at", prettyNow(), "after disconnect due to", this.lastCloseReason);
        } else {
          this.logger.log("WebSocket reconnected at", prettyNow());
        }
      }
      this.connectionCount += 1;
      this.lastCloseReason = null;
    };
    ws.onerror = (error) => {
      this.transitionChunkBuffer = null;
      const message = error.message;
      if (message) {
        this.logger.log(`WebSocket error message: ${message}`);
      }
    };
    ws.onmessage = (message) => {
      this.resetServerInactivityTimeout();
      const messageLength = message.data.length;
      let serverMessage = parseServerMessage(JSON.parse(message.data));
      this._logVerbose(`received ws message with type ${serverMessage.type}`);
      if (serverMessage.type === "Ping") {
        return;
      }
      if (serverMessage.type === "TransitionChunk") {
        const transition = this.assembleTransition(serverMessage);
        if (!transition) {
          return;
        }
        serverMessage = transition;
        this._logVerbose(`assembled full ws message of type ${serverMessage.type}`);
      }
      if (this.transitionChunkBuffer !== null) {
        this.transitionChunkBuffer = null;
        this.logger.log(`Received unexpected ${serverMessage.type} while buffering TransitionChunks`);
      }
      if (serverMessage.type === "Transition") {
        this.reportLargeTransition({
          messageLength,
          transition: serverMessage
        });
      }
      const response = this.onMessage(serverMessage);
      if (response.hasSyncedPastLastReconnect) {
        this.retries = 0;
        this.markConnectionStateDirty();
      }
    };
    ws.onclose = (event) => {
      this._logVerbose("begin ws.onclose");
      this.transitionChunkBuffer = null;
      if (this.lastCloseReason === null) {
        this.lastCloseReason = event.reason || `closed with code ${event.code}`;
      }
      if (event.code !== CLOSE_NORMAL && event.code !== CLOSE_GOING_AWAY && event.code !== CLOSE_NO_STATUS && event.code !== CLOSE_NOT_FOUND) {
        let msg = `WebSocket closed with code ${event.code}`;
        if (event.reason) {
          msg += `: ${event.reason}`;
        }
        this.logger.log(msg);
        if (this.onServerDisconnectError && event.reason) {
          this.onServerDisconnectError(msg);
        }
      }
      const reason = classifyDisconnectError(event.reason);
      this.scheduleReconnect(reason);
      return;
    };
  }
  socketState() {
    return this.socket.state;
  }
  sendMessage(message) {
    const messageForLog = {
      type: message.type,
      ...message.type === "Authenticate" && message.tokenType === "User" ? {
        value: `...${message.value.slice(-7)}`
      } : {}
    };
    if (this.socket.state === "ready" && this.socket.paused === "no") {
      const encodedMessage = encodeClientMessage(message);
      const request = JSON.stringify(encodedMessage);
      let sent = false;
      try {
        this.socket.ws.send(request);
        sent = true;
      } catch (error) {
        this.logger.log(`Failed to send message on WebSocket, reconnecting: ${error}`);
        this.closeAndReconnect("FailedToSendMessage");
      }
      this._logVerbose(`${sent ? "sent" : "failed to send"} message with type ${message.type}: ${JSON.stringify(messageForLog)}`);
      return true;
    }
    this._logVerbose(`message not sent (socket state: ${this.socket.state}, paused: ${"paused" in this.socket ? this.socket.paused : undefined}): ${JSON.stringify(messageForLog)}`);
    return false;
  }
  resetServerInactivityTimeout() {
    if (this.socket.state === "terminated") {
      return;
    }
    if (this.reconnectDueToServerInactivityTimeout !== null) {
      clearTimeout(this.reconnectDueToServerInactivityTimeout);
      this.reconnectDueToServerInactivityTimeout = null;
    }
    this.reconnectDueToServerInactivityTimeout = setTimeout(() => {
      this.closeAndReconnect("InactiveServer");
    }, this.serverInactivityThreshold);
  }
  scheduleReconnect(reason) {
    this.socket = { state: "disconnected" };
    const backoff = this.nextBackoff(reason);
    this.markConnectionStateDirty();
    this.logger.log(`Attempting reconnect in ${Math.round(backoff)}ms`);
    setTimeout(() => this.connect(), backoff);
  }
  closeAndReconnect(closeReason) {
    this._logVerbose(`begin closeAndReconnect with reason ${closeReason}`);
    switch (this.socket.state) {
      case "disconnected":
      case "terminated":
      case "stopped":
        return;
      case "connecting":
      case "ready": {
        this.lastCloseReason = closeReason;
        this.close();
        this.scheduleReconnect("client");
        return;
      }
      default: {
        this.socket;
      }
    }
  }
  close() {
    this.transitionChunkBuffer = null;
    switch (this.socket.state) {
      case "disconnected":
      case "terminated":
      case "stopped":
        return Promise.resolve();
      case "connecting": {
        const ws = this.socket.ws;
        ws.onmessage = (_message) => {
          this._logVerbose("Ignoring message received after close");
        };
        return new Promise((r) => {
          ws.onclose = () => {
            this._logVerbose("Closed after connecting");
            r();
          };
          ws.onopen = () => {
            this._logVerbose("Opened after connecting");
            ws.close();
          };
        });
      }
      case "ready": {
        this._logVerbose("ws.close called");
        const ws = this.socket.ws;
        ws.onmessage = (_message) => {
          this._logVerbose("Ignoring message received after close");
        };
        const result = new Promise((r) => {
          ws.onclose = () => {
            r();
          };
        });
        ws.close();
        return result;
      }
      default: {
        this.socket;
        return Promise.resolve();
      }
    }
  }
  terminate() {
    if (this.reconnectDueToServerInactivityTimeout) {
      clearTimeout(this.reconnectDueToServerInactivityTimeout);
    }
    switch (this.socket.state) {
      case "terminated":
      case "stopped":
      case "disconnected":
      case "connecting":
      case "ready": {
        const result = this.close();
        this.setSocketState({ state: "terminated" });
        return result;
      }
      default: {
        this.socket;
        throw new Error(`Invalid websocket state: ${this.socket.state}`);
      }
    }
  }
  stop() {
    switch (this.socket.state) {
      case "terminated":
        return Promise.resolve();
      case "connecting":
      case "stopped":
      case "disconnected":
      case "ready": {
        const result = this.close();
        this.socket = { state: "stopped" };
        return result;
      }
      default: {
        this.socket;
        return Promise.resolve();
      }
    }
  }
  tryRestart() {
    switch (this.socket.state) {
      case "stopped":
        break;
      case "terminated":
      case "connecting":
      case "ready":
      case "disconnected":
        this.logger.logVerbose("Restart called without stopping first");
        return;
      default: {
        this.socket;
      }
    }
    this.connect();
  }
  pause() {
    switch (this.socket.state) {
      case "disconnected":
      case "stopped":
      case "terminated":
        return;
      case "connecting":
      case "ready": {
        this.socket = { ...this.socket, paused: "yes" };
        return;
      }
      default: {
        this.socket;
        return;
      }
    }
  }
  resume() {
    switch (this.socket.state) {
      case "connecting":
        this.socket = { ...this.socket, paused: "no" };
        return;
      case "ready":
        if (this.socket.paused === "uninitialized") {
          this.socket = { ...this.socket, paused: "no" };
          this.onOpen({
            connectionCount: this.connectionCount,
            lastCloseReason: this.lastCloseReason,
            clientTs: monotonicMillis()
          });
        } else if (this.socket.paused === "yes") {
          this.socket = { ...this.socket, paused: "no" };
          this.onResume();
        }
        return;
      case "terminated":
      case "stopped":
      case "disconnected":
        return;
      default: {
        this.socket;
      }
    }
    this.connect();
  }
  connectionState() {
    return {
      isConnected: this.socket.state === "ready",
      hasEverConnected: this._hasEverConnected,
      connectionCount: this.connectionCount,
      connectionRetries: this.retries
    };
  }
  _logVerbose(message) {
    this.logger.logVerbose(message);
  }
  nextBackoff(reason) {
    const initialBackoff = reason === "client" ? 100 : reason === "Unknown" ? this.defaultInitialBackoff : serverDisconnectErrors[reason].timeout;
    const baseBackoff = initialBackoff * Math.pow(2, this.retries);
    this.retries += 1;
    const actualBackoff = Math.min(baseBackoff, this.maxBackoff);
    const jitter = actualBackoff * (Math.random() - 0.5);
    return actualBackoff + jitter;
  }
  reportLargeTransition({
    transition,
    messageLength
  }) {
    if (transition.clientClockSkew === undefined || transition.serverTs === undefined) {
      return;
    }
    const transitionTransitTime = monotonicMillis() - transition.clientClockSkew - transition.serverTs / 1e6;
    const prettyTransitionTime = `${Math.round(transitionTransitTime)}ms`;
    const prettyMessageMB = `${Math.round(messageLength / 1e4) / 100}MB`;
    const bytesPerSecond = messageLength / (transitionTransitTime / 1000);
    const prettyBytesPerSecond = `${Math.round(bytesPerSecond / 1e4) / 100}MB per second`;
    this._logVerbose(`received ${prettyMessageMB} transition in ${prettyTransitionTime} at ${prettyBytesPerSecond}`);
    if (messageLength > 20000000) {
      this.logger.log(`received query results totaling more that 20MB (${prettyMessageMB}) which will take a long time to download on slower connections`);
    } else if (transitionTransitTime > 20000) {
      this.logger.log(`received query results totaling ${prettyMessageMB} which took more than 20s to arrive (${prettyTransitionTime})`);
    }
    if (this.debug) {
      this.sendMessage({
        type: "Event",
        eventType: "ClientReceivedTransition",
        event: { transitionTransitTime, messageLength }
      });
    }
  }
}

// node_modules/convex/dist/esm/browser/sync/session.js
function newSessionId() {
  return uuidv4();
}
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0, v = c === "x" ? r : r & 3 | 8;
    return v.toString(16);
  });
}

// node_modules/convex/dist/esm/vendor/jwt-decode/index.js
class InvalidTokenError extends Error {
}
InvalidTokenError.prototype.name = "InvalidTokenError";
function b64DecodeUnicode(str) {
  return decodeURIComponent(atob(str).replace(/(.)/g, (_m, p) => {
    let code2 = p.charCodeAt(0).toString(16).toUpperCase();
    if (code2.length < 2) {
      code2 = "0" + code2;
    }
    return "%" + code2;
  }));
}
function base64UrlDecode(str) {
  let output = str.replace(/-/g, "+").replace(/_/g, "/");
  switch (output.length % 4) {
    case 0:
      break;
    case 2:
      output += "==";
      break;
    case 3:
      output += "=";
      break;
    default:
      throw new Error("base64 string is not of the correct length");
  }
  try {
    return b64DecodeUnicode(output);
  } catch {
    return atob(output);
  }
}
function jwtDecode(token, options) {
  if (typeof token !== "string") {
    throw new InvalidTokenError("Invalid token specified: must be a string");
  }
  options || (options = {});
  const pos = options.header === true ? 0 : 1;
  const part = token.split(".")[pos];
  if (typeof part !== "string") {
    throw new InvalidTokenError(`Invalid token specified: missing part #${pos + 1}`);
  }
  let decoded;
  try {
    decoded = base64UrlDecode(part);
  } catch (e) {
    throw new InvalidTokenError(`Invalid token specified: invalid base64 for part #${pos + 1} (${e.message})`);
  }
  try {
    return JSON.parse(decoded);
  } catch (e) {
    throw new InvalidTokenError(`Invalid token specified: invalid json for part #${pos + 1} (${e.message})`);
  }
}

// node_modules/convex/dist/esm/browser/sync/authentication_manager.js
var __defProp10 = Object.defineProperty;
var __defNormalProp9 = (obj, key, value) => (key in obj) ? __defProp10(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField9 = (obj, key, value) => __defNormalProp9(obj, typeof key !== "symbol" ? key + "" : key, value);
var MAXIMUM_REFRESH_DELAY = 20 * 24 * 60 * 60 * 1000;
var MAX_TOKEN_CONFIRMATION_ATTEMPTS = 2;

class AuthenticationManager {
  constructor(syncState, callbacks, config) {
    __publicField9(this, "authState", { state: "noAuth" });
    __publicField9(this, "configVersion", 0);
    __publicField9(this, "syncState");
    __publicField9(this, "authenticate");
    __publicField9(this, "stopSocket");
    __publicField9(this, "tryRestartSocket");
    __publicField9(this, "pauseSocket");
    __publicField9(this, "resumeSocket");
    __publicField9(this, "clearAuth");
    __publicField9(this, "logger");
    __publicField9(this, "refreshTokenLeewaySeconds");
    __publicField9(this, "tokenConfirmationAttempts", 0);
    this.syncState = syncState;
    this.authenticate = callbacks.authenticate;
    this.stopSocket = callbacks.stopSocket;
    this.tryRestartSocket = callbacks.tryRestartSocket;
    this.pauseSocket = callbacks.pauseSocket;
    this.resumeSocket = callbacks.resumeSocket;
    this.clearAuth = callbacks.clearAuth;
    this.logger = config.logger;
    this.refreshTokenLeewaySeconds = config.refreshTokenLeewaySeconds;
  }
  async setConfig(fetchToken, onChange) {
    this.resetAuthState();
    this._logVerbose("pausing WS for auth token fetch");
    this.pauseSocket();
    const token = await this.fetchTokenAndGuardAgainstRace(fetchToken, {
      forceRefreshToken: false
    });
    if (token.isFromOutdatedConfig) {
      return;
    }
    if (token.value) {
      this.setAuthState({
        state: "waitingForServerConfirmationOfCachedToken",
        config: { fetchToken, onAuthChange: onChange },
        hasRetried: false
      });
      this.authenticate(token.value);
    } else {
      this.setAuthState({
        state: "initialRefetch",
        config: { fetchToken, onAuthChange: onChange }
      });
      await this.refetchToken();
    }
    this._logVerbose("resuming WS after auth token fetch");
    this.resumeSocket();
  }
  onTransition(serverMessage) {
    if (!this.syncState.isCurrentOrNewerAuthVersion(serverMessage.endVersion.identity)) {
      return;
    }
    if (serverMessage.endVersion.identity <= serverMessage.startVersion.identity) {
      return;
    }
    if (this.authState.state === "waitingForServerConfirmationOfCachedToken") {
      this._logVerbose("server confirmed auth token is valid");
      this.refetchToken();
      this.authState.config.onAuthChange(true);
      return;
    }
    if (this.authState.state === "waitingForServerConfirmationOfFreshToken") {
      this._logVerbose("server confirmed new auth token is valid");
      this.scheduleTokenRefetch(this.authState.token);
      this.tokenConfirmationAttempts = 0;
      if (!this.authState.hadAuth) {
        this.authState.config.onAuthChange(true);
      }
    }
  }
  onAuthError(serverMessage) {
    if (serverMessage.authUpdateAttempted === false && (this.authState.state === "waitingForServerConfirmationOfFreshToken" || this.authState.state === "waitingForServerConfirmationOfCachedToken")) {
      this._logVerbose("ignoring non-auth token expired error");
      return;
    }
    const { baseVersion } = serverMessage;
    if (!this.syncState.isCurrentOrNewerAuthVersion(baseVersion + 1)) {
      this._logVerbose("ignoring auth error for previous auth attempt");
      return;
    }
    this.tryToReauthenticate(serverMessage);
    return;
  }
  async tryToReauthenticate(serverMessage) {
    this._logVerbose(`attempting to reauthenticate: ${serverMessage.error}`);
    if (this.authState.state === "noAuth" || this.authState.state === "waitingForServerConfirmationOfFreshToken" && this.tokenConfirmationAttempts >= MAX_TOKEN_CONFIRMATION_ATTEMPTS) {
      this.logger.error(`Failed to authenticate: "${serverMessage.error}", check your server auth config`);
      if (this.syncState.hasAuth()) {
        this.syncState.clearAuth();
      }
      if (this.authState.state !== "noAuth") {
        this.setAndReportAuthFailed(this.authState.config.onAuthChange);
      }
      return;
    }
    if (this.authState.state === "waitingForServerConfirmationOfFreshToken") {
      this.tokenConfirmationAttempts++;
      this._logVerbose(`retrying reauthentication, ${MAX_TOKEN_CONFIRMATION_ATTEMPTS - this.tokenConfirmationAttempts} attempts remaining`);
    }
    await this.stopSocket();
    const token = await this.fetchTokenAndGuardAgainstRace(this.authState.config.fetchToken, {
      forceRefreshToken: true
    });
    if (token.isFromOutdatedConfig) {
      return;
    }
    if (token.value && this.syncState.isNewAuth(token.value)) {
      this.authenticate(token.value);
      this.setAuthState({
        state: "waitingForServerConfirmationOfFreshToken",
        config: this.authState.config,
        token: token.value,
        hadAuth: this.authState.state === "notRefetching" || this.authState.state === "waitingForScheduledRefetch"
      });
    } else {
      this._logVerbose("reauthentication failed, could not fetch a new token");
      if (this.syncState.hasAuth()) {
        this.syncState.clearAuth();
      }
      this.setAndReportAuthFailed(this.authState.config.onAuthChange);
    }
    this.tryRestartSocket();
  }
  async refetchToken() {
    if (this.authState.state === "noAuth") {
      return;
    }
    this._logVerbose("refetching auth token");
    const token = await this.fetchTokenAndGuardAgainstRace(this.authState.config.fetchToken, {
      forceRefreshToken: true
    });
    if (token.isFromOutdatedConfig) {
      return;
    }
    if (token.value) {
      if (this.syncState.isNewAuth(token.value)) {
        this.setAuthState({
          state: "waitingForServerConfirmationOfFreshToken",
          hadAuth: this.syncState.hasAuth(),
          token: token.value,
          config: this.authState.config
        });
        this.authenticate(token.value);
      } else {
        this.setAuthState({
          state: "notRefetching",
          config: this.authState.config
        });
      }
    } else {
      this._logVerbose("refetching token failed");
      if (this.syncState.hasAuth()) {
        this.clearAuth();
      }
      this.setAndReportAuthFailed(this.authState.config.onAuthChange);
    }
    this._logVerbose("restarting WS after auth token fetch (if currently stopped)");
    this.tryRestartSocket();
  }
  scheduleTokenRefetch(token) {
    if (this.authState.state === "noAuth") {
      return;
    }
    const decodedToken = this.decodeToken(token);
    if (!decodedToken) {
      this.logger.error("Auth token is not a valid JWT, cannot refetch the token");
      return;
    }
    const { iat, exp } = decodedToken;
    if (!iat || !exp) {
      this.logger.error("Auth token does not have required fields, cannot refetch the token");
      return;
    }
    const tokenValiditySeconds = exp - iat;
    if (tokenValiditySeconds <= 2) {
      this.logger.error("Auth token does not live long enough, cannot refetch the token");
      return;
    }
    let delay = Math.min(MAXIMUM_REFRESH_DELAY, (tokenValiditySeconds - this.refreshTokenLeewaySeconds) * 1000);
    if (delay <= 0) {
      this.logger.warn(`Refetching auth token immediately, configured leeway ${this.refreshTokenLeewaySeconds}s is larger than the token's lifetime ${tokenValiditySeconds}s`);
      delay = 0;
    }
    const refetchTokenTimeoutId = setTimeout(() => {
      this._logVerbose("running scheduled token refetch");
      this.refetchToken();
    }, delay);
    this.setAuthState({
      state: "waitingForScheduledRefetch",
      refetchTokenTimeoutId,
      config: this.authState.config
    });
    this._logVerbose(`scheduled preemptive auth token refetching in ${delay}ms`);
  }
  async fetchTokenAndGuardAgainstRace(fetchToken, fetchArgs) {
    const originalConfigVersion = ++this.configVersion;
    this._logVerbose(`fetching token with config version ${originalConfigVersion}`);
    const token = await fetchToken(fetchArgs);
    if (this.configVersion !== originalConfigVersion) {
      this._logVerbose(`stale config version, expected ${originalConfigVersion}, got ${this.configVersion}`);
      return { isFromOutdatedConfig: true };
    }
    return { isFromOutdatedConfig: false, value: token };
  }
  stop() {
    this.resetAuthState();
    this.configVersion++;
    this._logVerbose(`config version bumped to ${this.configVersion}`);
  }
  setAndReportAuthFailed(onAuthChange) {
    onAuthChange(false);
    this.resetAuthState();
  }
  resetAuthState() {
    this.setAuthState({ state: "noAuth" });
  }
  setAuthState(newAuth) {
    const authStateForLog = newAuth.state === "waitingForServerConfirmationOfFreshToken" ? {
      hadAuth: newAuth.hadAuth,
      state: newAuth.state,
      token: `...${newAuth.token.slice(-7)}`
    } : { state: newAuth.state };
    this._logVerbose(`setting auth state to ${JSON.stringify(authStateForLog)}`);
    switch (newAuth.state) {
      case "waitingForScheduledRefetch":
      case "notRefetching":
      case "noAuth":
        this.tokenConfirmationAttempts = 0;
        break;
      case "waitingForServerConfirmationOfFreshToken":
      case "waitingForServerConfirmationOfCachedToken":
      case "initialRefetch":
        break;
      default: {
      }
    }
    if (this.authState.state === "waitingForScheduledRefetch") {
      clearTimeout(this.authState.refetchTokenTimeoutId);
      this.syncState.markAuthCompletion();
    }
    this.authState = newAuth;
  }
  decodeToken(token) {
    try {
      return jwtDecode(token);
    } catch (e) {
      this._logVerbose(`Error decoding token: ${e instanceof Error ? e.message : "Unknown error"}`);
      return null;
    }
  }
  _logVerbose(message) {
    this.logger.logVerbose(`${message} [v${this.configVersion}]`);
  }
}

// node_modules/convex/dist/esm/browser/sync/metrics.js
var markNames = [
  "convexClientConstructed",
  "convexWebSocketOpen",
  "convexFirstMessageReceived"
];
function mark(name, sessionId) {
  const detail = { sessionId };
  if (typeof performance === "undefined" || !performance.mark)
    return;
  performance.mark(name, { detail });
}
function performanceMarkToJson(mark2) {
  let name = mark2.name.slice("convex".length);
  name = name.charAt(0).toLowerCase() + name.slice(1);
  return {
    name,
    startTime: mark2.startTime
  };
}
function getMarksReport(sessionId) {
  if (typeof performance === "undefined" || !performance.getEntriesByName) {
    return [];
  }
  const allMarks = [];
  for (const name of markNames) {
    const marks = performance.getEntriesByName(name).filter((entry) => entry.entryType === "mark").filter((mark2) => mark2.detail.sessionId === sessionId);
    allMarks.push(...marks);
  }
  return allMarks.map(performanceMarkToJson);
}

// node_modules/convex/dist/esm/browser/sync/client.js
var __defProp11 = Object.defineProperty;
var __defNormalProp10 = (obj, key, value) => (key in obj) ? __defProp11(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField10 = (obj, key, value) => __defNormalProp10(obj, typeof key !== "symbol" ? key + "" : key, value);

class BaseConvexClient {
  constructor(address, onTransition, options) {
    __publicField10(this, "address");
    __publicField10(this, "state");
    __publicField10(this, "requestManager");
    __publicField10(this, "webSocketManager");
    __publicField10(this, "authenticationManager");
    __publicField10(this, "remoteQuerySet");
    __publicField10(this, "optimisticQueryResults");
    __publicField10(this, "_transitionHandlerCounter", 0);
    __publicField10(this, "_nextRequestId");
    __publicField10(this, "_onTransitionFns", /* @__PURE__ */ new Map);
    __publicField10(this, "_sessionId");
    __publicField10(this, "firstMessageReceived", false);
    __publicField10(this, "debug");
    __publicField10(this, "logger");
    __publicField10(this, "maxObservedTimestamp");
    __publicField10(this, "connectionStateSubscribers", /* @__PURE__ */ new Map);
    __publicField10(this, "nextConnectionStateSubscriberId", 0);
    __publicField10(this, "_lastPublishedConnectionState");
    __publicField10(this, "markConnectionStateDirty", () => {
      Promise.resolve().then(() => {
        const curConnectionState = this.connectionState();
        if (JSON.stringify(curConnectionState) !== JSON.stringify(this._lastPublishedConnectionState)) {
          this._lastPublishedConnectionState = curConnectionState;
          for (const cb of this.connectionStateSubscribers.values()) {
            cb(curConnectionState);
          }
        }
      });
    });
    __publicField10(this, "mark", (name) => {
      if (this.debug) {
        mark(name, this.sessionId);
      }
    });
    if (typeof address === "object") {
      throw new Error("Passing a ClientConfig object is no longer supported. Pass the URL of the Convex deployment as a string directly.");
    }
    if (options?.skipConvexDeploymentUrlCheck !== true) {
      validateDeploymentUrl(address);
    }
    options = { ...options };
    const authRefreshTokenLeewaySeconds = options.authRefreshTokenLeewaySeconds ?? 2;
    let webSocketConstructor = options.webSocketConstructor;
    if (!webSocketConstructor && typeof WebSocket === "undefined") {
      throw new Error("No WebSocket global variable defined! To use Convex in an environment without WebSocket try the HTTP client: https://docs.convex.dev/api/classes/browser.ConvexHttpClient");
    }
    webSocketConstructor = webSocketConstructor || WebSocket;
    this.debug = options.reportDebugInfoToConvex ?? false;
    this.address = address;
    this.logger = options.logger === false ? instantiateNoopLogger({ verbose: options.verbose ?? false }) : options.logger !== true && options.logger ? options.logger : instantiateDefaultLogger({ verbose: options.verbose ?? false });
    const i = address.search("://");
    if (i === -1) {
      throw new Error("Provided address was not an absolute URL.");
    }
    const origin = address.substring(i + 3);
    const protocol = address.substring(0, i);
    let wsProtocol;
    if (protocol === "http") {
      wsProtocol = "ws";
    } else if (protocol === "https") {
      wsProtocol = "wss";
    } else {
      throw new Error(`Unknown parent protocol ${protocol}`);
    }
    const wsUri = `${wsProtocol}://${origin}/api/${version}/sync`;
    this.state = new LocalSyncState;
    this.remoteQuerySet = new RemoteQuerySet((queryId) => this.state.queryPath(queryId), this.logger);
    this.requestManager = new RequestManager(this.logger, this.markConnectionStateDirty);
    const pauseSocket = () => {
      this.webSocketManager.pause();
      this.state.pause();
    };
    this.authenticationManager = new AuthenticationManager(this.state, {
      authenticate: (token) => {
        const message = this.state.setAuth(token);
        this.webSocketManager.sendMessage(message);
        return message.baseVersion;
      },
      stopSocket: () => this.webSocketManager.stop(),
      tryRestartSocket: () => this.webSocketManager.tryRestart(),
      pauseSocket,
      resumeSocket: () => this.webSocketManager.resume(),
      clearAuth: () => {
        this.clearAuth();
      }
    }, {
      logger: this.logger,
      refreshTokenLeewaySeconds: authRefreshTokenLeewaySeconds
    });
    this.optimisticQueryResults = new OptimisticQueryResults;
    this.addOnTransitionHandler((transition) => {
      onTransition(transition.queries.map((q) => q.token));
    });
    this._nextRequestId = 0;
    this._sessionId = newSessionId();
    const { unsavedChangesWarning } = options;
    if (typeof window === "undefined" || typeof window.addEventListener === "undefined") {
      if (unsavedChangesWarning === true) {
        throw new Error("unsavedChangesWarning requested, but window.addEventListener not found! Remove {unsavedChangesWarning: true} from Convex client options.");
      }
    } else if (unsavedChangesWarning !== false) {
      window.addEventListener("beforeunload", (e) => {
        if (this.requestManager.hasIncompleteRequests()) {
          e.preventDefault();
          const confirmationMessage = "Are you sure you want to leave? Your changes may not be saved.";
          (e || window.event).returnValue = confirmationMessage;
          return confirmationMessage;
        }
      });
    }
    this.webSocketManager = new WebSocketManager(wsUri, {
      onOpen: (reconnectMetadata) => {
        this.mark("convexWebSocketOpen");
        this.webSocketManager.sendMessage({
          ...reconnectMetadata,
          type: "Connect",
          sessionId: this._sessionId,
          maxObservedTimestamp: this.maxObservedTimestamp
        });
        const oldRemoteQueryResults = new Set(this.remoteQuerySet.remoteQueryResults().keys());
        this.remoteQuerySet = new RemoteQuerySet((queryId) => this.state.queryPath(queryId), this.logger);
        const [querySetModification, authModification] = this.state.restart(oldRemoteQueryResults);
        if (authModification) {
          this.webSocketManager.sendMessage(authModification);
        }
        this.webSocketManager.sendMessage(querySetModification);
        for (const message of this.requestManager.restart()) {
          this.webSocketManager.sendMessage(message);
        }
      },
      onResume: () => {
        const [querySetModification, authModification] = this.state.resume();
        if (authModification) {
          this.webSocketManager.sendMessage(authModification);
        }
        if (querySetModification) {
          this.webSocketManager.sendMessage(querySetModification);
        }
        for (const message of this.requestManager.resume()) {
          this.webSocketManager.sendMessage(message);
        }
      },
      onMessage: (serverMessage) => {
        if (!this.firstMessageReceived) {
          this.firstMessageReceived = true;
          this.mark("convexFirstMessageReceived");
          this.reportMarks();
        }
        switch (serverMessage.type) {
          case "Transition": {
            this.observedTimestamp(serverMessage.endVersion.ts);
            this.authenticationManager.onTransition(serverMessage);
            this.remoteQuerySet.transition(serverMessage);
            this.state.transition(serverMessage);
            const completedRequests = this.requestManager.removeCompleted(this.remoteQuerySet.timestamp());
            this.notifyOnQueryResultChanges(completedRequests);
            break;
          }
          case "MutationResponse": {
            if (serverMessage.success) {
              this.observedTimestamp(serverMessage.ts);
            }
            const completedMutationInfo = this.requestManager.onResponse(serverMessage);
            if (completedMutationInfo !== null) {
              this.notifyOnQueryResultChanges(/* @__PURE__ */ new Map([
                [
                  completedMutationInfo.requestId,
                  completedMutationInfo.result
                ]
              ]));
            }
            break;
          }
          case "ActionResponse": {
            this.requestManager.onResponse(serverMessage);
            break;
          }
          case "AuthError": {
            this.authenticationManager.onAuthError(serverMessage);
            break;
          }
          case "FatalError": {
            const error = logFatalError(this.logger, serverMessage.error);
            this.webSocketManager.terminate();
            throw error;
          }
          default: {
          }
        }
        return {
          hasSyncedPastLastReconnect: this.hasSyncedPastLastReconnect()
        };
      },
      onServerDisconnectError: options.onServerDisconnectError
    }, webSocketConstructor, this.logger, this.markConnectionStateDirty, this.debug);
    this.mark("convexClientConstructed");
    if (options.expectAuth) {
      pauseSocket();
    }
  }
  hasSyncedPastLastReconnect() {
    const hasSyncedPastLastReconnect = this.requestManager.hasSyncedPastLastReconnect() || this.state.hasSyncedPastLastReconnect();
    return hasSyncedPastLastReconnect;
  }
  observedTimestamp(observedTs) {
    if (this.maxObservedTimestamp === undefined || this.maxObservedTimestamp.lessThanOrEqual(observedTs)) {
      this.maxObservedTimestamp = observedTs;
    }
  }
  getMaxObservedTimestamp() {
    return this.maxObservedTimestamp;
  }
  notifyOnQueryResultChanges(completedRequests) {
    const remoteQueryResults = this.remoteQuerySet.remoteQueryResults();
    const queryTokenToValue = /* @__PURE__ */ new Map;
    for (const [queryId, result] of remoteQueryResults) {
      const queryToken = this.state.queryToken(queryId);
      if (queryToken !== null) {
        const query = {
          result,
          udfPath: this.state.queryPath(queryId),
          args: this.state.queryArgs(queryId)
        };
        queryTokenToValue.set(queryToken, query);
      }
    }
    const changedQueryTokens = this.optimisticQueryResults.ingestQueryResultsFromServer(queryTokenToValue, new Set(completedRequests.keys()));
    this.handleTransition({
      queries: changedQueryTokens.map((token) => {
        const optimisticResult = this.optimisticQueryResults.rawQueryResult(token);
        return {
          token,
          modification: {
            kind: "Updated",
            result: optimisticResult
          }
        };
      }),
      reflectedMutations: Array.from(completedRequests).map(([requestId, result]) => ({
        requestId,
        result
      })),
      timestamp: this.remoteQuerySet.timestamp()
    });
  }
  handleTransition(transition) {
    for (const fn of this._onTransitionFns.values()) {
      fn(transition);
    }
  }
  addOnTransitionHandler(fn) {
    const id = this._transitionHandlerCounter++;
    this._onTransitionFns.set(id, fn);
    return () => this._onTransitionFns.delete(id);
  }
  getCurrentAuthClaims() {
    const authToken = this.state.getAuth();
    let decoded = {};
    if (authToken && authToken.tokenType === "User") {
      try {
        decoded = authToken ? jwtDecode(authToken.value) : {};
      } catch {
        decoded = {};
      }
    } else {
      return;
    }
    return { token: authToken.value, decoded };
  }
  setAuth(fetchToken, onChange) {
    this.authenticationManager.setConfig(fetchToken, onChange);
  }
  hasAuth() {
    return this.state.hasAuth();
  }
  setAdminAuth(value, fakeUserIdentity) {
    const message = this.state.setAdminAuth(value, fakeUserIdentity);
    this.webSocketManager.sendMessage(message);
  }
  clearAuth() {
    const message = this.state.clearAuth();
    this.webSocketManager.sendMessage(message);
  }
  subscribe(name, args, options) {
    const argsObject = parseArgs(args);
    const { modification, queryToken, unsubscribe } = this.state.subscribe(name, argsObject, options?.journal, options?.componentPath);
    if (modification !== null) {
      this.webSocketManager.sendMessage(modification);
    }
    return {
      queryToken,
      unsubscribe: () => {
        const modification2 = unsubscribe();
        if (modification2) {
          this.webSocketManager.sendMessage(modification2);
        }
      }
    };
  }
  localQueryResult(udfPath, args) {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(udfPath, argsObject);
    return this.optimisticQueryResults.queryResult(queryToken);
  }
  localQueryResultByToken(queryToken) {
    return this.optimisticQueryResults.queryResult(queryToken);
  }
  hasLocalQueryResultByToken(queryToken) {
    return this.optimisticQueryResults.hasQueryResult(queryToken);
  }
  localQueryLogs(udfPath, args) {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(udfPath, argsObject);
    return this.optimisticQueryResults.queryLogs(queryToken);
  }
  queryJournal(name, args) {
    const argsObject = parseArgs(args);
    const queryToken = serializePathAndArgs(name, argsObject);
    return this.state.queryJournal(queryToken);
  }
  connectionState() {
    const wsConnectionState = this.webSocketManager.connectionState();
    return {
      hasInflightRequests: this.requestManager.hasInflightRequests(),
      isWebSocketConnected: wsConnectionState.isConnected,
      hasEverConnected: wsConnectionState.hasEverConnected,
      connectionCount: wsConnectionState.connectionCount,
      connectionRetries: wsConnectionState.connectionRetries,
      timeOfOldestInflightRequest: this.requestManager.timeOfOldestInflightRequest(),
      inflightMutations: this.requestManager.inflightMutations(),
      inflightActions: this.requestManager.inflightActions()
    };
  }
  subscribeToConnectionState(cb) {
    const id = this.nextConnectionStateSubscriberId++;
    this.connectionStateSubscribers.set(id, cb);
    return () => {
      this.connectionStateSubscribers.delete(id);
    };
  }
  async mutation(name, args, options) {
    const result = await this.mutationInternal(name, args, options);
    if (!result.success) {
      if (result.errorData !== undefined) {
        throw forwardData(result, new ConvexError(createHybridErrorStacktrace("mutation", name, result)));
      }
      throw new Error(createHybridErrorStacktrace("mutation", name, result));
    }
    return result.value;
  }
  async mutationInternal(udfPath, args, options, componentPath) {
    const { mutationPromise } = this.enqueueMutation(udfPath, args, options, componentPath);
    return mutationPromise;
  }
  enqueueMutation(udfPath, args, options, componentPath) {
    const mutationArgs = parseArgs(args);
    this.tryReportLongDisconnect();
    const requestId = this.nextRequestId;
    this._nextRequestId++;
    if (options !== undefined) {
      const optimisticUpdate = options.optimisticUpdate;
      if (optimisticUpdate !== undefined) {
        const wrappedUpdate = (localQueryStore) => {
          const result = optimisticUpdate(localQueryStore, mutationArgs);
          if (result instanceof Promise) {
            this.logger.warn("Optimistic update handler returned a Promise. Optimistic updates should be synchronous.");
          }
        };
        const changedQueryTokens = this.optimisticQueryResults.applyOptimisticUpdate(wrappedUpdate, requestId);
        const changedQueries = changedQueryTokens.map((token) => {
          const localResult = this.localQueryResultByToken(token);
          return {
            token,
            modification: {
              kind: "Updated",
              result: localResult === undefined ? undefined : {
                success: true,
                value: localResult,
                logLines: []
              }
            }
          };
        });
        this.handleTransition({
          queries: changedQueries,
          reflectedMutations: [],
          timestamp: this.remoteQuerySet.timestamp()
        });
      }
    }
    const message = {
      type: "Mutation",
      requestId,
      udfPath,
      componentPath,
      args: [convexToJson(mutationArgs)]
    };
    const mightBeSent = this.webSocketManager.sendMessage(message);
    const mutationPromise = this.requestManager.request(message, mightBeSent);
    return {
      requestId,
      mutationPromise
    };
  }
  async action(name, args) {
    const result = await this.actionInternal(name, args);
    if (!result.success) {
      if (result.errorData !== undefined) {
        throw forwardData(result, new ConvexError(createHybridErrorStacktrace("action", name, result)));
      }
      throw new Error(createHybridErrorStacktrace("action", name, result));
    }
    return result.value;
  }
  async actionInternal(udfPath, args, componentPath) {
    const actionArgs = parseArgs(args);
    const requestId = this.nextRequestId;
    this._nextRequestId++;
    this.tryReportLongDisconnect();
    const message = {
      type: "Action",
      requestId,
      udfPath,
      componentPath,
      args: [convexToJson(actionArgs)]
    };
    const mightBeSent = this.webSocketManager.sendMessage(message);
    return this.requestManager.request(message, mightBeSent);
  }
  async close() {
    this.authenticationManager.stop();
    return this.webSocketManager.terminate();
  }
  get url() {
    return this.address;
  }
  get nextRequestId() {
    return this._nextRequestId;
  }
  get sessionId() {
    return this._sessionId;
  }
  reportMarks() {
    if (this.debug) {
      const report = getMarksReport(this.sessionId);
      this.webSocketManager.sendMessage({
        type: "Event",
        eventType: "ClientConnect",
        event: report
      });
    }
  }
  tryReportLongDisconnect() {
    if (!this.debug) {
      return;
    }
    const timeOfOldestRequest = this.connectionState().timeOfOldestInflightRequest;
    if (timeOfOldestRequest === null || Date.now() - timeOfOldestRequest.getTime() <= 60 * 1000) {
      return;
    }
    const endpoint = `${this.address}/api/debug_event`;
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Convex-Client": `npm-${version}`
      },
      body: JSON.stringify({ event: "LongWebsocketDisconnect" })
    }).then((response) => {
      if (!response.ok) {
        this.logger.warn("Analytics request failed with response:", response.body);
      }
    }).catch((error) => {
      this.logger.warn("Analytics response failed with error:", error);
    });
  }
}

// node_modules/convex/dist/esm/browser/simple_client-node.js
import { createRequire } from "module";
import { resolve as nodePathResolve } from "path";
// node_modules/convex/dist/esm/browser/http_client.js
var __defProp12 = Object.defineProperty;
var __defNormalProp11 = (obj, key, value) => (key in obj) ? __defProp12(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField11 = (obj, key, value) => __defNormalProp11(obj, typeof key !== "symbol" ? key + "" : key, value);
var STATUS_CODE_UDF_FAILED = 560;
var specifiedFetch = undefined;
class ConvexHttpClient {
  constructor(address, options) {
    __publicField11(this, "address");
    __publicField11(this, "auth");
    __publicField11(this, "adminAuth");
    __publicField11(this, "encodedTsPromise");
    __publicField11(this, "debug");
    __publicField11(this, "fetchOptions");
    __publicField11(this, "fetch");
    __publicField11(this, "logger");
    __publicField11(this, "mutationQueue", []);
    __publicField11(this, "isProcessingQueue", false);
    if (typeof options === "boolean") {
      throw new Error("skipConvexDeploymentUrlCheck as the second argument is no longer supported. Please pass an options object, `{ skipConvexDeploymentUrlCheck: true }`.");
    }
    const opts = options ?? {};
    if (opts.skipConvexDeploymentUrlCheck !== true) {
      validateDeploymentUrl(address);
    }
    this.logger = options?.logger === false ? instantiateNoopLogger({ verbose: false }) : options?.logger !== true && options?.logger ? options.logger : instantiateDefaultLogger({ verbose: false });
    this.address = address;
    this.debug = true;
    this.auth = undefined;
    this.adminAuth = undefined;
    this.fetch = options?.fetch;
    if (options?.auth) {
      this.setAuth(options.auth);
    }
  }
  backendUrl() {
    return `${this.address}/api`;
  }
  get url() {
    return this.address;
  }
  setAuth(value) {
    this.clearAuth();
    this.auth = value;
  }
  setAdminAuth(token, actingAsIdentity) {
    this.clearAuth();
    if (actingAsIdentity !== undefined) {
      const bytes = new TextEncoder().encode(JSON.stringify(actingAsIdentity));
      const actingAsIdentityEncoded = btoa(String.fromCodePoint(...bytes));
      this.adminAuth = `${token}:${actingAsIdentityEncoded}`;
    } else {
      this.adminAuth = token;
    }
  }
  clearAuth() {
    this.auth = undefined;
    this.adminAuth = undefined;
  }
  setDebug(debug) {
    this.debug = debug;
  }
  setFetchOptions(fetchOptions) {
    this.fetchOptions = fetchOptions;
  }
  async consistentQuery(query, ...args) {
    const queryArgs = parseArgs(args[0]);
    const timestampPromise = this.getTimestamp();
    return await this.queryInner(query, queryArgs, { timestampPromise });
  }
  async getTimestamp() {
    if (this.encodedTsPromise) {
      return this.encodedTsPromise;
    }
    return this.encodedTsPromise = this.getTimestampInner();
  }
  async getTimestampInner() {
    const localFetch = this.fetch || specifiedFetch || fetch;
    const headers = {
      "Content-Type": "application/json",
      "Convex-Client": `npm-${version}`
    };
    const response = await localFetch(`${this.address}/api/query_ts`, {
      ...this.fetchOptions,
      method: "POST",
      headers
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const { ts } = await response.json();
    return ts;
  }
  async query(query, ...args) {
    const queryArgs = parseArgs(args[0]);
    return await this.queryInner(query, queryArgs, {});
  }
  async queryInner(query, queryArgs, options) {
    const name = getFunctionName(query);
    const args = [convexToJson(queryArgs)];
    const headers = {
      "Content-Type": "application/json",
      "Convex-Client": `npm-${version}`
    };
    if (this.adminAuth) {
      headers["Authorization"] = `Convex ${this.adminAuth}`;
    } else if (this.auth) {
      headers["Authorization"] = `Bearer ${this.auth}`;
    }
    const localFetch = this.fetch || specifiedFetch || fetch;
    const timestamp = options.timestampPromise ? await options.timestampPromise : undefined;
    const body = JSON.stringify({
      path: name,
      format: "convex_encoded_json",
      args,
      ...timestamp ? { ts: timestamp } : {}
    });
    const endpoint = timestamp ? `${this.address}/api/query_at_ts` : `${this.address}/api/query`;
    const response = await localFetch(endpoint, {
      ...this.fetchOptions,
      body,
      method: "POST",
      headers
    });
    if (!response.ok && response.status !== STATUS_CODE_UDF_FAILED) {
      throw new Error(await response.text());
    }
    const respJSON = await response.json();
    if (this.debug) {
      for (const line of respJSON.logLines ?? []) {
        logForFunction(this.logger, "info", "query", name, line);
      }
    }
    switch (respJSON.status) {
      case "success":
        return jsonToConvex(respJSON.value);
      case "error":
        if (respJSON.errorData !== undefined) {
          throw forwardErrorData(respJSON.errorData, new ConvexError(respJSON.errorMessage));
        }
        throw new Error(respJSON.errorMessage);
      default:
        throw new Error(`Invalid response: ${JSON.stringify(respJSON)}`);
    }
  }
  async mutationInner(mutation, mutationArgs) {
    const name = getFunctionName(mutation);
    const body = JSON.stringify({
      path: name,
      format: "convex_encoded_json",
      args: [convexToJson(mutationArgs)]
    });
    const headers = {
      "Content-Type": "application/json",
      "Convex-Client": `npm-${version}`
    };
    if (this.adminAuth) {
      headers["Authorization"] = `Convex ${this.adminAuth}`;
    } else if (this.auth) {
      headers["Authorization"] = `Bearer ${this.auth}`;
    }
    const localFetch = this.fetch || specifiedFetch || fetch;
    const response = await localFetch(`${this.address}/api/mutation`, {
      ...this.fetchOptions,
      body,
      method: "POST",
      headers
    });
    if (!response.ok && response.status !== STATUS_CODE_UDF_FAILED) {
      throw new Error(await response.text());
    }
    const respJSON = await response.json();
    if (this.debug) {
      for (const line of respJSON.logLines ?? []) {
        logForFunction(this.logger, "info", "mutation", name, line);
      }
    }
    switch (respJSON.status) {
      case "success":
        return jsonToConvex(respJSON.value);
      case "error":
        if (respJSON.errorData !== undefined) {
          throw forwardErrorData(respJSON.errorData, new ConvexError(respJSON.errorMessage));
        }
        throw new Error(respJSON.errorMessage);
      default:
        throw new Error(`Invalid response: ${JSON.stringify(respJSON)}`);
    }
  }
  async processMutationQueue() {
    if (this.isProcessingQueue) {
      return;
    }
    this.isProcessingQueue = true;
    while (this.mutationQueue.length > 0) {
      const { mutation, args, resolve: resolve3, reject } = this.mutationQueue.shift();
      try {
        const result = await this.mutationInner(mutation, args);
        resolve3(result);
      } catch (error) {
        reject(error);
      }
    }
    this.isProcessingQueue = false;
  }
  enqueueMutation(mutation, args) {
    return new Promise((resolve3, reject) => {
      this.mutationQueue.push({ mutation, args, resolve: resolve3, reject });
      this.processMutationQueue();
    });
  }
  async mutation(mutation, ...args) {
    const [fnArgs, options] = args;
    const mutationArgs = parseArgs(fnArgs);
    const queued = !options?.skipQueue;
    if (queued) {
      return await this.enqueueMutation(mutation, mutationArgs);
    } else {
      return await this.mutationInner(mutation, mutationArgs);
    }
  }
  async action(action, ...args) {
    const actionArgs = parseArgs(args[0]);
    const name = getFunctionName(action);
    const body = JSON.stringify({
      path: name,
      format: "convex_encoded_json",
      args: [convexToJson(actionArgs)]
    });
    const headers = {
      "Content-Type": "application/json",
      "Convex-Client": `npm-${version}`
    };
    if (this.adminAuth) {
      headers["Authorization"] = `Convex ${this.adminAuth}`;
    } else if (this.auth) {
      headers["Authorization"] = `Bearer ${this.auth}`;
    }
    const localFetch = this.fetch || specifiedFetch || fetch;
    const response = await localFetch(`${this.address}/api/action`, {
      ...this.fetchOptions,
      body,
      method: "POST",
      headers
    });
    if (!response.ok && response.status !== STATUS_CODE_UDF_FAILED) {
      throw new Error(await response.text());
    }
    const respJSON = await response.json();
    if (this.debug) {
      for (const line of respJSON.logLines ?? []) {
        logForFunction(this.logger, "info", "action", name, line);
      }
    }
    switch (respJSON.status) {
      case "success":
        return jsonToConvex(respJSON.value);
      case "error":
        if (respJSON.errorData !== undefined) {
          throw forwardErrorData(respJSON.errorData, new ConvexError(respJSON.errorMessage));
        }
        throw new Error(respJSON.errorMessage);
      default:
        throw new Error(`Invalid response: ${JSON.stringify(respJSON)}`);
    }
  }
  async function(anyFunction, componentPath, ...args) {
    const functionArgs = parseArgs(args[0]);
    const name = typeof anyFunction === "string" ? anyFunction : getFunctionName(anyFunction);
    const body = JSON.stringify({
      componentPath,
      path: name,
      format: "convex_encoded_json",
      args: convexToJson(functionArgs)
    });
    const headers = {
      "Content-Type": "application/json",
      "Convex-Client": `npm-${version}`
    };
    if (this.adminAuth) {
      headers["Authorization"] = `Convex ${this.adminAuth}`;
    } else if (this.auth) {
      headers["Authorization"] = `Bearer ${this.auth}`;
    }
    const localFetch = this.fetch || specifiedFetch || fetch;
    const response = await localFetch(`${this.address}/api/function`, {
      ...this.fetchOptions,
      body,
      method: "POST",
      headers
    });
    if (!response.ok && response.status !== STATUS_CODE_UDF_FAILED) {
      throw new Error(await response.text());
    }
    const respJSON = await response.json();
    if (this.debug) {
      for (const line of respJSON.logLines ?? []) {
        logForFunction(this.logger, "info", "any", name, line);
      }
    }
    switch (respJSON.status) {
      case "success":
        return jsonToConvex(respJSON.value);
      case "error":
        if (respJSON.errorData !== undefined) {
          throw forwardErrorData(respJSON.errorData, new ConvexError(respJSON.errorMessage));
        }
        throw new Error(respJSON.errorMessage);
      default:
        throw new Error(`Invalid response: ${JSON.stringify(respJSON)}`);
    }
  }
}
function forwardErrorData(errorData, error) {
  error.data = jsonToConvex(errorData);
  return error;
}

// node_modules/convex/dist/esm/browser/sync/pagination.js
function asPaginationResult(value) {
  if (typeof value !== "object" || value === null || !Array.isArray(value.page) || typeof value.isDone !== "boolean" || typeof value.continueCursor !== "string") {
    throw new Error(`Not a valid paginated query result: ${value?.toString()}`);
  }
  return value;
}

// node_modules/convex/dist/esm/browser/sync/paginated_query_client.js
var __defProp13 = Object.defineProperty;
var __defNormalProp12 = (obj, key, value) => (key in obj) ? __defProp13(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField12 = (obj, key, value) => __defNormalProp12(obj, typeof key !== "symbol" ? key + "" : key, value);

class PaginatedQueryClient {
  constructor(client, onTransition) {
    this.client = client;
    this.onTransition = onTransition;
    __publicField12(this, "paginatedQuerySet", /* @__PURE__ */ new Map);
    __publicField12(this, "lastTransitionTs");
    this.lastTransitionTs = Long.fromNumber(0);
    this.client.addOnTransitionHandler((transition) => this.onBaseTransition(transition));
  }
  subscribe(name, args, options) {
    const canonicalizedUdfPath = canonicalizeUdfPath(name);
    const token = serializePaginatedPathAndArgs(canonicalizedUdfPath, args, options);
    const unsubscribe = () => this.removePaginatedQuerySubscriber(token);
    const existingEntry = this.paginatedQuerySet.get(token);
    if (existingEntry) {
      existingEntry.numSubscribers += 1;
      return {
        paginatedQueryToken: token,
        unsubscribe
      };
    }
    this.paginatedQuerySet.set(token, {
      token,
      canonicalizedUdfPath,
      args,
      numSubscribers: 1,
      options: { initialNumItems: options.initialNumItems },
      nextPageKey: 0,
      pageKeys: [],
      pageKeyToQuery: /* @__PURE__ */ new Map,
      ongoingSplits: /* @__PURE__ */ new Map,
      skip: false,
      id: options.id
    });
    this.addPageToPaginatedQuery(token, null, options.initialNumItems);
    return {
      paginatedQueryToken: token,
      unsubscribe
    };
  }
  localQueryResult(name, args, options) {
    const canonicalizedUdfPath = canonicalizeUdfPath(name);
    const token = serializePaginatedPathAndArgs(canonicalizedUdfPath, args, options);
    return this.localQueryResultByToken(token);
  }
  localQueryResultByToken(token) {
    const paginatedQuery = this.paginatedQuerySet.get(token);
    if (!paginatedQuery) {
      return;
    }
    const activePages = this.activePageQueryTokens(paginatedQuery);
    if (activePages.length === 0) {
      return {
        results: [],
        status: "LoadingFirstPage",
        loadMore: (numItems) => {
          return this.loadMoreOfPaginatedQuery(token, numItems);
        }
      };
    }
    let allResults = [];
    let hasUndefined = false;
    let isDone = false;
    for (const pageToken of activePages) {
      const result = this.client.localQueryResultByToken(pageToken);
      if (result === undefined) {
        hasUndefined = true;
        isDone = false;
        continue;
      }
      const paginationResult = asPaginationResult(result);
      allResults = allResults.concat(paginationResult.page);
      isDone = !!paginationResult.isDone;
    }
    let status;
    if (hasUndefined) {
      status = allResults.length === 0 ? "LoadingFirstPage" : "LoadingMore";
    } else if (isDone) {
      status = "Exhausted";
    } else {
      status = "CanLoadMore";
    }
    return {
      results: allResults,
      status,
      loadMore: (numItems) => {
        return this.loadMoreOfPaginatedQuery(token, numItems);
      }
    };
  }
  onBaseTransition(transition) {
    const changedBaseTokens = transition.queries.map((q) => q.token);
    const changed = this.queriesContainingTokens(changedBaseTokens);
    let paginatedQueries = [];
    if (changed.length > 0) {
      this.processPaginatedQuerySplits(changed, (token) => this.client.localQueryResultByToken(token));
      paginatedQueries = changed.map((token) => ({
        token,
        modification: {
          kind: "Updated",
          result: this.localQueryResultByToken(token)
        }
      }));
    }
    const extendedTransition = {
      ...transition,
      paginatedQueries
    };
    this.onTransition(extendedTransition);
  }
  loadMoreOfPaginatedQuery(token, numItems) {
    this.mustGetPaginatedQuery(token);
    const lastPageToken = this.queryTokenForLastPageOfPaginatedQuery(token);
    const lastPageResult = this.client.localQueryResultByToken(lastPageToken);
    if (!lastPageResult) {
      return false;
    }
    const paginationResult = asPaginationResult(lastPageResult);
    if (paginationResult.isDone) {
      return false;
    }
    this.addPageToPaginatedQuery(token, paginationResult.continueCursor, numItems);
    const loadMoreTransition = {
      timestamp: this.lastTransitionTs,
      reflectedMutations: [],
      queries: [],
      paginatedQueries: [
        {
          token,
          modification: {
            kind: "Updated",
            result: this.localQueryResultByToken(token)
          }
        }
      ]
    };
    this.onTransition(loadMoreTransition);
    return true;
  }
  queriesContainingTokens(queryTokens) {
    if (queryTokens.length === 0) {
      return [];
    }
    const changed = [];
    const queryTokenSet = new Set(queryTokens);
    for (const [paginatedToken, paginatedQuery] of this.paginatedQuerySet) {
      for (const pageToken of this.allQueryTokens(paginatedQuery)) {
        if (queryTokenSet.has(pageToken)) {
          changed.push(paginatedToken);
          break;
        }
      }
    }
    return changed;
  }
  processPaginatedQuerySplits(changed, getResult) {
    for (const paginatedQueryToken of changed) {
      const paginatedQuery = this.mustGetPaginatedQuery(paginatedQueryToken);
      const { ongoingSplits, pageKeyToQuery, pageKeys } = paginatedQuery;
      for (const [pageKey, [splitKey1, splitKey2]] of ongoingSplits) {
        const bothNewPagesLoaded = getResult(pageKeyToQuery.get(splitKey1).queryToken) !== undefined && getResult(pageKeyToQuery.get(splitKey2).queryToken) !== undefined;
        if (bothNewPagesLoaded) {
          this.completePaginatedQuerySplit(paginatedQuery, pageKey, splitKey1, splitKey2);
        }
      }
      for (const pageKey of pageKeys) {
        if (ongoingSplits.has(pageKey)) {
          continue;
        }
        const pageToken = pageKeyToQuery.get(pageKey).queryToken;
        const pageResult = getResult(pageToken);
        if (!pageResult) {
          continue;
        }
        const result = asPaginationResult(pageResult);
        const shouldSplit = result.splitCursor && (result.pageStatus === "SplitRecommended" || result.pageStatus === "SplitRequired" || result.page.length > paginatedQuery.options.initialNumItems * 2);
        if (shouldSplit) {
          this.splitPaginatedQueryPage(paginatedQuery, pageKey, result.splitCursor, result.continueCursor);
        }
      }
    }
  }
  splitPaginatedQueryPage(paginatedQuery, pageKey, splitCursor, continueCursor) {
    const splitKey1 = paginatedQuery.nextPageKey++;
    const splitKey2 = paginatedQuery.nextPageKey++;
    const paginationOpts = {
      cursor: continueCursor,
      numItems: paginatedQuery.options.initialNumItems,
      id: paginatedQuery.id
    };
    const firstSubscription = this.client.subscribe(paginatedQuery.canonicalizedUdfPath, {
      ...paginatedQuery.args,
      paginationOpts: {
        ...paginationOpts,
        cursor: null,
        endCursor: splitCursor
      }
    });
    paginatedQuery.pageKeyToQuery.set(splitKey1, firstSubscription);
    const secondSubscription = this.client.subscribe(paginatedQuery.canonicalizedUdfPath, {
      ...paginatedQuery.args,
      paginationOpts: {
        ...paginationOpts,
        cursor: splitCursor,
        endCursor: continueCursor
      }
    });
    paginatedQuery.pageKeyToQuery.set(splitKey2, secondSubscription);
    paginatedQuery.ongoingSplits.set(pageKey, [splitKey1, splitKey2]);
  }
  addPageToPaginatedQuery(token, continueCursor, numItems) {
    const paginatedQuery = this.mustGetPaginatedQuery(token);
    const pageKey = paginatedQuery.nextPageKey++;
    const paginationOpts = {
      cursor: continueCursor,
      numItems,
      id: paginatedQuery.id
    };
    const pageArgs = {
      ...paginatedQuery.args,
      paginationOpts
    };
    const subscription = this.client.subscribe(paginatedQuery.canonicalizedUdfPath, pageArgs);
    paginatedQuery.pageKeys.push(pageKey);
    paginatedQuery.pageKeyToQuery.set(pageKey, subscription);
    return subscription;
  }
  removePaginatedQuerySubscriber(token) {
    const paginatedQuery = this.paginatedQuerySet.get(token);
    if (!paginatedQuery) {
      return;
    }
    paginatedQuery.numSubscribers -= 1;
    if (paginatedQuery.numSubscribers > 0) {
      return;
    }
    for (const subscription of paginatedQuery.pageKeyToQuery.values()) {
      subscription.unsubscribe();
    }
    this.paginatedQuerySet.delete(token);
  }
  completePaginatedQuerySplit(paginatedQuery, pageKey, splitKey1, splitKey2) {
    const originalQuery = paginatedQuery.pageKeyToQuery.get(pageKey);
    paginatedQuery.pageKeyToQuery.delete(pageKey);
    const pageIndex = paginatedQuery.pageKeys.indexOf(pageKey);
    paginatedQuery.pageKeys.splice(pageIndex, 1, splitKey1, splitKey2);
    paginatedQuery.ongoingSplits.delete(pageKey);
    originalQuery.unsubscribe();
  }
  activePageQueryTokens(paginatedQuery) {
    return paginatedQuery.pageKeys.map((pageKey) => paginatedQuery.pageKeyToQuery.get(pageKey).queryToken);
  }
  allQueryTokens(paginatedQuery) {
    return Array.from(paginatedQuery.pageKeyToQuery.values()).map((sub) => sub.queryToken);
  }
  queryTokenForLastPageOfPaginatedQuery(token) {
    const paginatedQuery = this.mustGetPaginatedQuery(token);
    const lastPageKey = paginatedQuery.pageKeys[paginatedQuery.pageKeys.length - 1];
    if (lastPageKey === undefined) {
      throw new Error(`No pages for paginated query ${token}`);
    }
    return paginatedQuery.pageKeyToQuery.get(lastPageKey).queryToken;
  }
  mustGetPaginatedQuery(token) {
    const paginatedQuery = this.paginatedQuerySet.get(token);
    if (!paginatedQuery) {
      throw new Error("paginated query no longer exists for token " + token);
    }
    return paginatedQuery;
  }
}

// node_modules/convex/dist/esm/browser/simple_client.js
var __defProp14 = Object.defineProperty;
var __defNormalProp13 = (obj, key, value) => (key in obj) ? __defProp14(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField13 = (obj, key, value) => __defNormalProp13(obj, typeof key !== "symbol" ? key + "" : key, value);
var defaultWebSocketConstructor;
function setDefaultWebSocketConstructor(ws) {
  defaultWebSocketConstructor = ws;
}

class ConvexClient {
  constructor(address, options = {}) {
    __publicField13(this, "listeners");
    __publicField13(this, "_client");
    __publicField13(this, "_paginatedClient");
    __publicField13(this, "callNewListenersWithCurrentValuesTimer");
    __publicField13(this, "_closed");
    __publicField13(this, "_disabled");
    if (options.skipConvexDeploymentUrlCheck !== true) {
      validateDeploymentUrl(address);
    }
    const { disabled, ...baseOptions } = options;
    this._closed = false;
    this._disabled = !!disabled;
    if (defaultWebSocketConstructor && !("webSocketConstructor" in baseOptions) && typeof WebSocket === "undefined") {
      baseOptions.webSocketConstructor = defaultWebSocketConstructor;
    }
    if (typeof window === "undefined" && !("unsavedChangesWarning" in baseOptions)) {
      baseOptions.unsavedChangesWarning = false;
    }
    if (!this.disabled) {
      this._client = new BaseConvexClient(address, () => {
      }, baseOptions);
      this._paginatedClient = new PaginatedQueryClient(this._client, (transition) => this._transition(transition));
    }
    this.listeners = /* @__PURE__ */ new Set;
  }
  get closed() {
    return this._closed;
  }
  get client() {
    if (this._client)
      return this._client;
    throw new Error("ConvexClient is disabled");
  }
  get paginatedClient() {
    if (this._paginatedClient)
      return this._paginatedClient;
    throw new Error("ConvexClient is disabled");
  }
  get disabled() {
    return this._disabled;
  }
  onUpdate(query, args, callback, onError) {
    if (this.disabled) {
      return this.createDisabledUnsubscribe();
    }
    const { queryToken, unsubscribe } = this.client.subscribe(getFunctionName(query), args);
    const queryInfo = {
      queryToken,
      callback,
      onError,
      unsubscribe,
      hasEverRun: false,
      query,
      args,
      paginationOptions: undefined
    };
    this.listeners.add(queryInfo);
    if (this.queryResultReady(queryToken) && this.callNewListenersWithCurrentValuesTimer === undefined) {
      this.callNewListenersWithCurrentValuesTimer = setTimeout(() => this.callNewListenersWithCurrentValues(), 0);
    }
    const unsubscribeProps = {
      unsubscribe: () => {
        if (this.closed) {
          return;
        }
        this.listeners.delete(queryInfo);
        unsubscribe();
      },
      getCurrentValue: () => this.client.localQueryResultByToken(queryToken),
      getQueryLogs: () => this.client.localQueryLogs(queryToken)
    };
    const ret = unsubscribeProps.unsubscribe;
    Object.assign(ret, unsubscribeProps);
    return ret;
  }
  onPaginatedUpdate_experimental(query, args, options, callback, onError) {
    if (this.disabled) {
      return this.createDisabledUnsubscribe();
    }
    const paginationOptions = {
      initialNumItems: options.initialNumItems,
      id: -1
    };
    const { paginatedQueryToken, unsubscribe } = this.paginatedClient.subscribe(getFunctionName(query), args, paginationOptions);
    const queryInfo = {
      queryToken: paginatedQueryToken,
      callback,
      onError,
      unsubscribe,
      hasEverRun: false,
      query,
      args,
      paginationOptions
    };
    this.listeners.add(queryInfo);
    if (!!this.paginatedClient.localQueryResultByToken(paginatedQueryToken) && this.callNewListenersWithCurrentValuesTimer === undefined) {
      this.callNewListenersWithCurrentValuesTimer = setTimeout(() => this.callNewListenersWithCurrentValues(), 0);
    }
    const unsubscribeProps = {
      unsubscribe: () => {
        if (this.closed) {
          return;
        }
        this.listeners.delete(queryInfo);
        unsubscribe();
      },
      getCurrentValue: () => {
        const result = this.paginatedClient.localQueryResult(getFunctionName(query), args, paginationOptions);
        return result;
      },
      getQueryLogs: () => []
    };
    const ret = unsubscribeProps.unsubscribe;
    Object.assign(ret, unsubscribeProps);
    return ret;
  }
  callNewListenersWithCurrentValues() {
    this.callNewListenersWithCurrentValuesTimer = undefined;
    this._transition({ queries: [], paginatedQueries: [] }, true);
  }
  queryResultReady(queryToken) {
    return this.client.hasLocalQueryResultByToken(queryToken);
  }
  createDisabledUnsubscribe() {
    const disabledUnsubscribe = () => {
    };
    const unsubscribeProps = {
      unsubscribe: disabledUnsubscribe,
      getCurrentValue: () => {
        return;
      },
      getQueryLogs: () => {
        return;
      }
    };
    Object.assign(disabledUnsubscribe, unsubscribeProps);
    return disabledUnsubscribe;
  }
  async close() {
    if (this.disabled)
      return;
    this.listeners.clear();
    this._closed = true;
    if (this._paginatedClient) {
      this._paginatedClient = undefined;
    }
    return this.client.close();
  }
  getAuth() {
    if (this.disabled)
      return;
    return this.client.getCurrentAuthClaims();
  }
  setAuth(fetchToken, onChange) {
    if (this.disabled)
      return;
    this.client.setAuth(fetchToken, onChange ?? (() => {
    }));
  }
  setAdminAuth(token, identity) {
    if (this.closed) {
      throw new Error("ConvexClient has already been closed.");
    }
    if (this.disabled)
      return;
    this.client.setAdminAuth(token, identity);
  }
  _transition({
    queries,
    paginatedQueries
  }, callNewListeners = false) {
    const updatedQueries = [
      ...queries.map((q) => q.token),
      ...paginatedQueries.map((q) => q.token)
    ];
    for (const queryInfo of this.listeners) {
      const { callback, queryToken, onError, hasEverRun } = queryInfo;
      const isPaginatedQuery = serializedQueryTokenIsPaginated(queryToken);
      const hasResultReady = isPaginatedQuery ? !!this.paginatedClient.localQueryResultByToken(queryToken) : this.client.hasLocalQueryResultByToken(queryToken);
      if (updatedQueries.includes(queryToken) || callNewListeners && !hasEverRun && hasResultReady) {
        queryInfo.hasEverRun = true;
        let newValue;
        try {
          if (isPaginatedQuery) {
            newValue = this.paginatedClient.localQueryResultByToken(queryToken);
          } else {
            newValue = this.client.localQueryResultByToken(queryToken);
          }
        } catch (error) {
          if (!(error instanceof Error))
            throw error;
          if (onError) {
            onError(error, "Second argument to onUpdate onError is reserved for later use");
          } else {
            Promise.reject(error);
          }
          continue;
        }
        callback(newValue, "Second argument to onUpdate callback is reserved for later use");
      }
    }
  }
  async mutation(mutation, args, options) {
    if (this.disabled)
      throw new Error("ConvexClient is disabled");
    return await this.client.mutation(getFunctionName(mutation), args, options);
  }
  async action(action, args) {
    if (this.disabled)
      throw new Error("ConvexClient is disabled");
    return await this.client.action(getFunctionName(action), args);
  }
  async query(query, args) {
    if (this.disabled)
      throw new Error("ConvexClient is disabled");
    const value = this.client.localQueryResult(getFunctionName(query), args);
    if (value !== undefined)
      return Promise.resolve(value);
    return new Promise((resolve3, reject) => {
      const { unsubscribe } = this.onUpdate(query, args, (value2) => {
        unsubscribe();
        resolve3(value2);
      }, (e) => {
        unsubscribe();
        reject(e);
      });
    });
  }
  connectionState() {
    if (this.disabled)
      throw new Error("ConvexClient is disabled");
    return this.client.connectionState();
  }
  subscribeToConnectionState(cb) {
    if (this.disabled)
      return () => {
      };
    return this.client.subscribeToConnectionState(cb);
  }
}

// node_modules/convex/dist/esm/browser/simple_client-node.js
var __dirname = "/Users/ashot/src/codecast/packages/cli/node_modules/convex/dist/esm/browser";
var require2 = createRequire(nodePathResolve("."));
var __create = Object.create;
var __defProp15 = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require2 !== "undefined" ? require2 : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require2 !== "undefined" ? require2 : a)[b]
}) : x)(function(x) {
  if (typeof require2 !== "undefined")
    return require2.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp15(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp15(target, "default", { value: mod, enumerable: true }) : target, mod));
var require_stream = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/stream.js"(exports, module) {
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data))
          ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed)
          return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed)
          return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called)
            callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy)
          ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null)
          return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted)
            duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused)
          ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});
var require_constants = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/constants.js"(exports, module) {
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob)
      BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
      kListener: Symbol("kListener"),
      kStatusCode: Symbol("status-code"),
      kWebSocket: Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});
var require_node_gyp_build = __commonJS({
  "../common/temp/node_modules/.pnpm/node-gyp-build@4.8.4/node_modules/node-gyp-build/node-gyp-build.js"(exports, module) {
    var fs9 = __require("fs");
    var path9 = __require("path");
    var os = __require("os");
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    var vars = process.config && process.config.variables || {};
    var prebuildsOnly = !!process.env.PREBUILDS_ONLY;
    var abi = process.versions.modules;
    var runtime = isElectron() ? "electron" : isNwjs() ? "node-webkit" : "node";
    var arch = process.env.npm_config_arch || os.arch();
    var platform = process.env.npm_config_platform || os.platform();
    var libc = process.env.LIBC || (isAlpine(platform) ? "musl" : "glibc");
    var armv = process.env.ARM_VERSION || (arch === "arm64" ? "8" : vars.arm_version) || "";
    var uv = (process.versions.uv || "").split(".")[0];
    module.exports = load;
    function load(dir) {
      return runtimeRequire(load.resolve(dir));
    }
    load.resolve = load.path = function(dir) {
      dir = path9.resolve(dir || ".");
      try {
        var name = runtimeRequire(path9.join(dir, "package.json")).name.toUpperCase().replace(/-/g, "_");
        if (process.env[name + "_PREBUILD"])
          dir = process.env[name + "_PREBUILD"];
      } catch (err) {
      }
      if (!prebuildsOnly) {
        var release = getFirst(path9.join(dir, "build/Release"), matchBuild);
        if (release)
          return release;
        var debug = getFirst(path9.join(dir, "build/Debug"), matchBuild);
        if (debug)
          return debug;
      }
      var prebuild = resolve3(dir);
      if (prebuild)
        return prebuild;
      var nearby = resolve3(path9.dirname(process.execPath));
      if (nearby)
        return nearby;
      var target = [
        "platform=" + platform,
        "arch=" + arch,
        "runtime=" + runtime,
        "abi=" + abi,
        "uv=" + uv,
        armv ? "armv=" + armv : "",
        "libc=" + libc,
        "node=" + process.versions.node,
        process.versions.electron ? "electron=" + process.versions.electron : "",
        typeof __webpack_require__ === "function" ? "webpack=true" : ""
      ].filter(Boolean).join(" ");
      throw new Error("No native build was found for " + target + `
    loaded from: ` + dir + `
`);
      function resolve3(dir2) {
        var tuples = readdirSync7(path9.join(dir2, "prebuilds")).map(parseTuple);
        var tuple = tuples.filter(matchTuple(platform, arch)).sort(compareTuples)[0];
        if (!tuple)
          return;
        var prebuilds = path9.join(dir2, "prebuilds", tuple.name);
        var parsed = readdirSync7(prebuilds).map(parseTags);
        var candidates = parsed.filter(matchTags(runtime, abi));
        var winner = candidates.sort(compareTags(runtime))[0];
        if (winner)
          return path9.join(prebuilds, winner.file);
      }
    };
    function readdirSync7(dir) {
      try {
        return fs9.readdirSync(dir);
      } catch (err) {
        return [];
      }
    }
    function getFirst(dir, filter) {
      var files = readdirSync7(dir).filter(filter);
      return files[0] && path9.join(dir, files[0]);
    }
    function matchBuild(name) {
      return /\.node$/.test(name);
    }
    function parseTuple(name) {
      var arr = name.split("-");
      if (arr.length !== 2)
        return;
      var platform2 = arr[0];
      var architectures = arr[1].split("+");
      if (!platform2)
        return;
      if (!architectures.length)
        return;
      if (!architectures.every(Boolean))
        return;
      return { name, platform: platform2, architectures };
    }
    function matchTuple(platform2, arch2) {
      return function(tuple) {
        if (tuple == null)
          return false;
        if (tuple.platform !== platform2)
          return false;
        return tuple.architectures.includes(arch2);
      };
    }
    function compareTuples(a, b) {
      return a.architectures.length - b.architectures.length;
    }
    function parseTags(file) {
      var arr = file.split(".");
      var extension = arr.pop();
      var tags = { file, specificity: 0 };
      if (extension !== "node")
        return;
      for (var i = 0;i < arr.length; i++) {
        var tag = arr[i];
        if (tag === "node" || tag === "electron" || tag === "node-webkit") {
          tags.runtime = tag;
        } else if (tag === "napi") {
          tags.napi = true;
        } else if (tag.slice(0, 3) === "abi") {
          tags.abi = tag.slice(3);
        } else if (tag.slice(0, 2) === "uv") {
          tags.uv = tag.slice(2);
        } else if (tag.slice(0, 4) === "armv") {
          tags.armv = tag.slice(4);
        } else if (tag === "glibc" || tag === "musl") {
          tags.libc = tag;
        } else {
          continue;
        }
        tags.specificity++;
      }
      return tags;
    }
    function matchTags(runtime2, abi2) {
      return function(tags) {
        if (tags == null)
          return false;
        if (tags.runtime && tags.runtime !== runtime2 && !runtimeAgnostic(tags))
          return false;
        if (tags.abi && tags.abi !== abi2 && !tags.napi)
          return false;
        if (tags.uv && tags.uv !== uv)
          return false;
        if (tags.armv && tags.armv !== armv)
          return false;
        if (tags.libc && tags.libc !== libc)
          return false;
        return true;
      };
    }
    function runtimeAgnostic(tags) {
      return tags.runtime === "node" && tags.napi;
    }
    function compareTags(runtime2) {
      return function(a, b) {
        if (a.runtime !== b.runtime) {
          return a.runtime === runtime2 ? -1 : 1;
        } else if (a.abi !== b.abi) {
          return a.abi ? -1 : 1;
        } else if (a.specificity !== b.specificity) {
          return a.specificity > b.specificity ? -1 : 1;
        } else {
          return 0;
        }
      };
    }
    function isNwjs() {
      return !!(process.versions && process.versions.nw);
    }
    function isElectron() {
      if (process.versions && process.versions.electron)
        return true;
      if (process.env.ELECTRON_RUN_AS_NODE)
        return true;
      return typeof window !== "undefined" && window.process && window.process.type === "renderer";
    }
    function isAlpine(platform2) {
      return platform2 === "linux" && fs9.existsSync("/etc/alpine-release");
    }
    load.parseTags = parseTags;
    load.matchTags = matchTags;
    load.compareTags = compareTags;
    load.parseTuple = parseTuple;
    load.matchTuple = matchTuple;
    load.compareTuples = compareTuples;
  }
});
var require_node_gyp_build2 = __commonJS({
  "../common/temp/node_modules/.pnpm/node-gyp-build@4.8.4/node_modules/node-gyp-build/index.js"(exports, module) {
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    if (typeof runtimeRequire.addon === "function") {
      module.exports = runtimeRequire.addon.bind(runtimeRequire);
    } else {
      module.exports = require_node_gyp_build();
    }
  }
});
var require_fallback = __commonJS({
  "../common/temp/node_modules/.pnpm/bufferutil@4.0.9/node_modules/bufferutil/fallback.js"(exports, module) {
    var mask = (source, mask2, output, offset, length) => {
      for (var i = 0;i < length; i++) {
        output[offset + i] = source[i] ^ mask2[i & 3];
      }
    };
    var unmask = (buffer, mask2) => {
      const length = buffer.length;
      for (var i = 0;i < length; i++) {
        buffer[i] ^= mask2[i & 3];
      }
    };
    module.exports = { mask, unmask };
  }
});
var require_bufferutil = __commonJS({
  "../common/temp/node_modules/.pnpm/bufferutil@4.0.9/node_modules/bufferutil/index.js"(exports, module) {
    try {
      module.exports = require_node_gyp_build2()(__dirname);
    } catch (e) {
      module.exports = require_fallback();
    }
  }
});
var require_buffer_util = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/buffer-util.js"(exports, module) {
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat(list, totalLength) {
      if (list.length === 0)
        return EMPTY_BUFFER;
      if (list.length === 1)
        return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0;i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0;i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0;i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data))
        return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require_bufferutil();
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48)
            _mask(source, mask, output, offset, length);
          else
            bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32)
            _unmask(buffer, mask);
          else
            bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});
var require_limiter = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/limiter.js"(exports, module) {
    var kDone = Symbol("kDone");
    var kRun = Symbol("kRun");
    var Limiter = class {
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      [kRun]() {
        if (this.pending === this.concurrency)
          return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter;
  }
});
var require_permessage_deflate = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = Symbol("permessage-deflate");
    var kTotalLength = Symbol("total-length");
    var kCallback = Symbol("callback");
    var kBuffers = Symbol("buffers");
    var kError = Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate = class {
      constructor(options, isServer, maxPayload) {
        this._maxPayload = maxPayload | 0;
        this._options = options || {};
        this._threshold = this._options.threshold !== undefined ? this._options.threshold : 1024;
        this._isServer = !!isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== undefined ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter(concurrency);
        }
      }
      static get extensionName() {
        return "permessage-deflate";
      }
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(new Error("The deflate stream was closed while data was being processed"));
          }
        }
      }
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && !params.client_max_window_bits) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error('Unexpected or invalid parameter "client_max_window_bits"');
        }
        return params;
      }
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key) => {
            let value = params[key];
            if (value.length > 1) {
              throw new Error(`Parameter "${key}" must have only a single value`);
            }
            value = value[0];
            if (key === "client_max_window_bits") {
              if (value !== true) {
                const num = +value;
                if (!Number.isInteger(num) || num < 8 || num > 15) {
                  throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
                }
                value = num;
              } else if (!this._isServer) {
                throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
              }
            } else if (key === "server_max_window_bits") {
              const num = +value;
              if (!Number.isInteger(num) || num < 8 || num > 15) {
                throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
              }
              value = num;
            } else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
              }
            } else {
              throw new Error(`Unknown parameter "${key}"`);
            }
            params[key] = value;
          });
        });
        return configurations;
      }
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin)
          this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(this._inflate[kBuffers], this._inflate[kTotalLength]);
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(this._deflate[kBuffers], this._deflate[kTotalLength]);
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});
var require_validation = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/validation.js"(exports, module) {
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
    ];
    function isValidStatusCode(code2) {
      return code2 >= 1000 && code2 <= 1014 && code2 !== 1004 && code2 !== 1005 && code2 !== 1006 || code2 >= 3000 && code2 <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = __require("utf-8-validate");
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});
var require_receiver = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/receiver.js"(exports, module) {
    var { Writable } = __require("stream");
    var PerMessageDeflate = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== undefined ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = undefined;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = undefined;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO)
          return cb();
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length)
          return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored)
          cb();
      }
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(RangeError, "RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3");
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate.extensionName]) {
          const error = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(RangeError, "invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE");
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE");
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(RangeError, "FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN");
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1");
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(RangeError, `invalid payload length ${this._payloadLength}`, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH");
            cb(error);
            return;
          }
        } else {
          const error = this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE");
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented)
          this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(RangeError, "MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK");
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(RangeError, "MASK must be clear", true, 1002, "WS_ERR_UNEXPECTED_MASK");
          cb(error);
          return;
        }
        if (this._payloadLength === 126)
          this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127)
          this._state = GET_PAYLOAD_LENGTH_64;
        else
          this.haveLength(cb);
      }
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num = buf.readUInt32BE(0);
        if (num > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(RangeError, "Unsupported WebSocket frame: payload length > 2^53 - 1", false, 1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH");
          cb(error);
          return;
        }
        this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
            cb(error);
            return;
          }
        }
        if (this._masked)
          this._state = GET_MASK;
        else
          this._state = GET_DATA;
      }
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err)
            return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH");
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO)
            this.startLoop(cb);
        });
      }
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8");
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code2 = data.readUInt16BE(0);
            if (!isValidStatusCode(code2)) {
              const error = this.createError(RangeError, `invalid status code ${code2}`, true, 1002, "WS_ERR_INVALID_CLOSE_CODE");
              cb(error);
              return;
            }
            const buf = new FastBuffer(data.buffer, data.byteOffset + 2, data.length - 2);
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8");
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code2, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(prefix ? `Invalid WebSocket frame: ${message}` : message);
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});
var require_sender = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/sender.js"(exports, module) {
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var PerMessageDeflate = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = undefined;
      }
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === undefined) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== undefined) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1)
          target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask)
          return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking)
          return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      close(code2, data, mask, cb) {
        let buf;
        if (code2 === undefined) {
          buf = EMPTY_BUFFER;
        } else if (typeof code2 !== "number" || !isValidStatusCode(code2)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === undefined || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code2, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code2, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else {
            buf.set(data, 2);
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      ping(data, mask, cb) {
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength2 = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength2 > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength2,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      pong(data, mask, cb) {
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength2 = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength2 > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength2,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength2;
        let readOnly;
        if (typeof data === "string") {
          byteLength2 = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength2 = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength2 = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength2 >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin)
          this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength2,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error("The socket was closed while the blob was being read");
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error("The socket was closed while data was being compressed");
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function")
        cb(err);
      for (let i = 0;i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function")
          callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});
var require_event_target = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/event-target.js"(exports, module) {
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = Symbol("kCode");
    var kData = Symbol("kData");
    var kError = Symbol("kError");
    var kMessage = Symbol("kMessage");
    var kReason = Symbol("kReason");
    var kTarget = Symbol("kTarget");
    var kType = Symbol("kType");
    var kWasClean = Symbol("kWasClean");
    var Event = class {
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      get target() {
        return this[kTarget];
      }
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === undefined ? 0 : options.code;
        this[kReason] = options.reason === undefined ? "" : options.reason;
        this[kWasClean] = options.wasClean === undefined ? false : options.wasClean;
      }
      get code() {
        return this[kCode];
      }
      get reason() {
        return this[kReason];
      }
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === undefined ? null : options.error;
        this[kMessage] = options.message === undefined ? "" : options.message;
      }
      get error() {
        return this[kError];
      }
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === undefined ? null : options.data;
      }
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code2, message) {
            const event = new CloseEvent("close", {
              code: code2,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});
var require_extension = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/extension.js"(exports, module) {
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === undefined)
        dest[name] = [elem];
      else
        dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code2 = -1;
      let end = -1;
      let i = 0;
      for (;i < header.length; i++) {
        code2 = header.charCodeAt(i);
        if (extensionName === undefined) {
          if (end === -1 && tokenChars[code2] === 1) {
            if (start === -1)
              start = i;
          } else if (i !== 0 && (code2 === 32 || code2 === 9)) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code2 === 59 || code2 === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            const name = header.slice(start, end);
            if (code2 === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === undefined) {
          if (end === -1 && tokenChars[code2] === 1) {
            if (start === -1)
              start = i;
          } else if (code2 === 32 || code2 === 9) {
            if (end === -1 && start !== -1)
              end = i;
          } else if (code2 === 59 || code2 === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            push(params, header.slice(start, end), true);
            if (code2 === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = undefined;
            }
            start = end = -1;
          } else if (code2 === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code2] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1)
              start = i;
            else if (!mustUnescape)
              mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code2] === 1) {
              if (start === -1)
                start = i;
            } else if (code2 === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code2 === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code2 === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code2] === 1) {
            if (start === -1)
              start = i;
          } else if (start !== -1 && (code2 === 32 || code2 === 9)) {
            if (end === -1)
              end = i;
          } else if (code2 === 59 || code2 === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1)
              end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code2 === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = undefined;
            }
            paramName = undefined;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code2 === 32 || code2 === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1)
        end = i;
      const token = header.slice(start, end);
      if (extensionName === undefined) {
        push(offers, token, params);
      } else {
        if (paramName === undefined) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension) => {
        let configurations = extensions[extension];
        if (!Array.isArray(configurations))
          configurations = [configurations];
        return configurations.map((params) => {
          return [extension].concat(Object.keys(params).map((k) => {
            let values = params[k];
            if (!Array.isArray(values))
              values = [values];
            return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
          })).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});
var require_websocket = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/websocket.js"(exports, module) {
    var EventEmitter8 = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes, createHash } = __require("crypto");
    var { Duplex, Readable: Readable2 } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var closeTimeout = 30 * 1000;
    var kAborted = Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter8 {
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === undefined) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._isServer = true;
        }
      }
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type))
          return;
        this._binaryType = type;
        if (this._receiver)
          this._receiver._binaryType = type;
      }
      get bufferedAmount() {
        if (!this._socket)
          return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      get isPaused() {
        return this._paused;
      }
      get onclose() {
        return null;
      }
      get onerror() {
        return null;
      }
      get onopen() {
        return null;
      }
      get onmessage() {
        return null;
      }
      get protocol() {
        return this._protocol;
      }
      get readyState() {
        return this._readyState;
      }
      get url() {
        return this._url;
      }
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout)
          socket.setTimeout(0);
        if (socket.setNoDelay)
          socket.setNoDelay();
        if (head.length > 0)
          socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate.extensionName]) {
          this._extensions[PerMessageDeflate.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      close(code2, data) {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code2, data, !this._isServer, (err) => {
          if (err)
            return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = undefined;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = undefined;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === undefined)
          mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = undefined;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = undefined;
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === undefined)
          mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain)
          this._socket.resume();
      }
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number")
          data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      terminate() {
        if (this.readyState === _WebSocket.CLOSED)
          return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute])
              return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function")
            return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        protocolVersion: protocolVersions[1],
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: undefined,
        hostname: undefined,
        protocol: undefined,
        timeout: undefined,
        method: "GET",
        host: undefined,
        path: undefined,
        port: undefined
      };
      websocket._autoPong = opts.autoPong;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(`Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`);
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch (e) {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key = randomBytes(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set;
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate(opts.perMessageDeflate !== true ? opts.perMessageDeflate : {}, false, opts.maxPayload);
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError("An invalid or duplicated subprotocol was specified");
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key2, value] of Object.entries(headers)) {
              options.headers[key2.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost)
              delete opts.headers.host;
            opts.auth = undefined;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted])
          return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(websocket, req, `Unexpected server response: ${res.statusCode}`);
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING)
          return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== undefined) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt)
          websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== undefined) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = undefined;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket)
          websocket._sender._bufferedBytes += length;
        else
          websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(`WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`);
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code2, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code2;
      if (websocket._socket[kWebSocket] === undefined)
        return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code2 === 1005)
        websocket.close();
      else
        websocket.close(code2, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused)
        websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== undefined) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong)
        websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED)
        return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(websocket._socket.destroy.bind(websocket._socket), closeTimeout);
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      let chunk;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && (chunk = websocket._socket.read()) !== null) {
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = undefined;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});
var require_subprotocol = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/subprotocol.js"(exports, module) {
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set;
      let start = -1;
      let end = -1;
      let i = 0;
      for (i;i < header.length; i++) {
        const code2 = header.charCodeAt(i);
        if (end === -1 && tokenChars[code2] === 1) {
          if (start === -1)
            start = i;
        } else if (i !== 0 && (code2 === 32 || code2 === 9)) {
          if (end === -1 && start !== -1)
            end = i;
        } else if (code2 === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1)
            end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});
var require_websocket_server = __commonJS({
  "../common/temp/node_modules/.pnpm/ws@8.18.0_bufferutil@4.0.9/node_modules/ws/lib/websocket-server.js"(exports, module) {
    var EventEmitter8 = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension = require_extension();
    var PerMessageDeflate = require_permessage_deflate();
    var subprotocol = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter8 {
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          verifyClient: null,
          noServer: false,
          backlog: null,
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError('One and only one of the "port", "server", or "noServer" options must be specified');
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(options.port, options.host, options.backlog, callback);
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true)
          options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set;
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server)
          return null;
        return this._server.address();
      }
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb)
          this.once("close", cb);
        if (this._state === CLOSING)
          return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path)
            return false;
        }
        return true;
      }
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version2 = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === undefined || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key === undefined || !keyRegex.test(key)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version2 !== 8 && version2 !== 13) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set;
        if (secWebSocketProtocol !== undefined) {
          try {
            protocols = subprotocol.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== undefined) {
          const perMessageDeflate = new PerMessageDeflate(this.options.perMessageDeflate, true, this.options.maxPayload);
          try {
            const offers = extension.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate.extensionName]);
              extensions[PerMessageDeflate.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version2 === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code2, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code2 || 401, message, headers);
              }
              this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
            });
            return;
          }
          if (!this.options.verifyClient(info))
            return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
      }
      completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable)
          return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error("server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration");
        }
        if (this._state > RUNNING)
          return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, undefined, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate.extensionName]) {
          const params = extensions[PerMessageDeflate.extensionName].params;
          const value = extension.format({
            [PerMessageDeflate.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat(`\r
`).join(`\r
`));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map))
        server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code2, message, headers) {
      message = message || http.STATUS_CODES[code2];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(`HTTP/1.1 ${code2} ${http.STATUS_CODES[code2]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join(`\r
`) + `\r
\r
` + message);
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code2, message) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code2, message);
      }
    }
  }
});
var import_stream = __toESM(require_stream(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;
var nodeWebSocket = wrapper_default;
setDefaultWebSocketConstructor(nodeWebSocket);
// src/redact.ts
var API_KEY_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]{20,}/g,
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /api[_-]?key[=:]\s*["']?[a-zA-Z0-9_-]{20,}["']?/gi,
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  /AKIA[A-Z0-9]{16}/g,
  /(?:^|[^a-zA-Z])[a-zA-Z_]*(?:_SECRET|_TOKEN|_KEY|_PASSWORD|_CREDENTIAL|API_KEY|SECRET_KEY)[a-zA-Z_]*[=:]\s*["']?[^\s"']{8,}["']?/gi,
  /-----BEGIN\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?(?:PRIVATE|PUBLIC)\s+KEY-----/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  /gho_[a-zA-Z0-9]{36}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g
];
function redactSecrets(content) {
  let result = typeof content === "string" ? content : content === null || content === undefined ? "" : typeof content === "object" ? JSON.stringify(content) : String(content);
  for (const pattern of API_KEY_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, "[REDACTED_API_KEY]");
  }
  return result;
}
function maskToken(token) {
  if (!token)
    return "(not set)";
  if (token.length <= 8)
    return "*****";
  return `${token.slice(0, 3)}...${token.slice(-3)}`;
}

// src/hash.ts
import * as crypto2 from "crypto";
import * as path9 from "path";
function hashPath(inputPath) {
  const normalized = path9.normalize(inputPath);
  return crypto2.createHash("sha256").update(normalized).digest("hex");
}

// src/syncService.ts
var MAX_CONTENT_SIZE = 1e5;
var MAX_TOOL_RESULT_SIZE = 50000;
var MAX_IMAGE_SIZE = 5000000;
var MAX_IMAGES_PER_MESSAGE = 10;
var MIN_REQUEST_INTERVAL_MS = 100;

class AuthExpiredError extends Error {
  constructor(message = "Authentication token expired") {
    super(message);
    this.name = "AuthExpiredError";
  }
}
function truncate(str, maxLen) {
  if (str.length <= maxLen)
    return str;
  return str.slice(0, maxLen) + `
... [truncated ${str.length - maxLen} chars]`;
}
function isAuthError(error) {
  const message = (error?.message || String(error)).toLowerCase();
  if (message.includes("server error") || message.includes("request id:") || message.includes("optimisticconcurrencycontrolfailure") || message.includes("rate limit") || message.includes("timeout") || message.includes("network") || message.includes("econnrefused") || message.includes("econnreset")) {
    return false;
  }
  return message.includes("invalid token") || message.includes("token expired") || message.includes("token not found") || message.includes("authentication failed") || message.includes("auth") && message.includes("expired");
}

class SyncService {
  client;
  subscriptionClient;
  userId;
  apiToken;
  lastRequestTime = 0;
  throttleQueue = Promise.resolve();
  constructor(config) {
    this.client = new ConvexHttpClient(config.convexUrl);
    this.subscriptionClient = new ConvexClient(config.convexUrl);
    this.userId = config.userId;
    this.apiToken = config.authToken;
  }
  async throttle() {
    const ticket = this.throttleQueue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < MIN_REQUEST_INTERVAL_MS) {
        await new Promise((resolve3) => setTimeout(resolve3, MIN_REQUEST_INTERVAL_MS - elapsed));
      }
      this.lastRequestTime = Date.now();
    });
    this.throttleQueue = ticket;
    await ticket;
  }
  getClient() {
    return this.client;
  }
  getSubscriptionClient() {
    return this.subscriptionClient;
  }
  setUserId(userId) {
    this.userId = userId;
  }
  setApiToken(token) {
    this.apiToken = token;
  }
  async uploadImage(base64Data, mediaType) {
    try {
      const uploadUrl = await this.client.mutation("images:generateUploadUrl", { api_token: this.apiToken });
      const binaryData = Buffer.from(base64Data, "base64");
      if (binaryData.length > MAX_IMAGE_SIZE) {
        return null;
      }
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mediaType },
        body: binaryData
      });
      if (!response.ok) {
        return null;
      }
      const result = await response.json();
      return result.storageId;
    } catch {
      return null;
    }
  }
  async createConversation(params) {
    await this.throttle();
    const projectHash = params.projectPath ? hashPath(params.projectPath) : undefined;
    const gitInfo = params.gitInfo;
    try {
      const result = await this.client.mutation("conversations:createConversation", {
        user_id: params.userId,
        team_id: params.teamId,
        agent_type: params.agentType,
        session_id: params.sessionId,
        project_hash: projectHash,
        project_path: params.projectPath,
        slug: params.slug,
        title: params.title,
        started_at: params.startedAt,
        parent_message_uuid: params.parentMessageUuid,
        parent_conversation_id: params.parentConversationId,
        git_commit_hash: gitInfo?.commitHash || params.gitCommitHash,
        git_branch: gitInfo?.branch,
        git_remote_url: gitInfo?.remoteUrl,
        git_status: gitInfo?.status,
        git_diff: gitInfo?.diff,
        git_diff_staged: gitInfo?.diffStaged,
        git_root: gitInfo?.root,
        cli_flags: params.cliFlags,
        worktree_name: gitInfo?.worktreeName,
        worktree_branch: gitInfo?.worktreeBranch,
        worktree_path: gitInfo?.worktreePath,
        worktree_status: gitInfo?.worktreeName ? "active" : undefined,
        api_token: this.apiToken
      });
      return result;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async linkSessions(parentConversationId, childConversationId) {
    await this.throttle();
    try {
      await this.client.mutation("conversations:linkSessions", {
        parent_conversation_id: parentConversationId,
        child_conversation_id: childConversationId,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async linkPlanHandoff(parentConversationId, childConversationId) {
    await this.throttle();
    try {
      await this.client.mutation("conversations:linkPlanHandoff", {
        parent_conversation_id: parentConversationId,
        child_conversation_id: childConversationId,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async syncPlanFromPlanMode(params) {
    await this.throttle();
    try {
      const result = await this.client.mutation("docs:create", {
        api_token: this.apiToken,
        title: "",
        content: params.planContent,
        source: "plan_mode",
        conversation_id: params.sessionId,
        project_path: params.projectPath
      });
      return result?.plan_short_id || null;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async syncTaskFromPlanMode(params) {
    await this.throttle();
    try {
      const result = await this.client.mutation("tasks:create", {
        api_token: this.apiToken,
        title: params.title,
        description: params.description,
        task_type: "task",
        status: "open",
        priority: "medium",
        source: "plan_mode",
        conversation_id: params.sessionId,
        plan_id: params.planShortId
      });
      return result?.short_id || null;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async updateTaskStatus(shortId, status, sessionId) {
    await this.throttle();
    try {
      await this.client.mutation("tasks:update", {
        api_token: this.apiToken,
        short_id: shortId,
        status,
        conversation_id: sessionId
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async addMessage(params) {
    await this.throttle();
    const redactedContent = truncate(redactSecrets(params.content), MAX_CONTENT_SIZE);
    const redactedThinking = params.thinking ? truncate(redactSecrets(params.thinking), MAX_CONTENT_SIZE) : undefined;
    const roleMap = {
      human: "user",
      assistant: "assistant",
      system: "system"
    };
    const toolCalls = params.toolCalls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE)
    }));
    const toolResults = params.toolResults?.map((tr) => ({
      tool_use_id: tr.toolUseId,
      content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
      is_error: tr.isError
    }));
    const images = [];
    if (params.images && params.images.length > 0) {
      const imagesToProcess = params.images.slice(0, MAX_IMAGES_PER_MESSAGE);
      for (const img of imagesToProcess) {
        const storageId = await this.uploadImage(img.data, img.mediaType);
        if (storageId) {
          images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
        }
      }
    }
    try {
      const messageId = await this.client.mutation("messages:addMessage", {
        conversation_id: params.conversationId,
        message_uuid: params.messageUuid,
        role: roleMap[params.role],
        content: redactedContent,
        thinking: redactedThinking,
        tool_calls: toolCalls,
        tool_results: toolResults,
        images: images.length > 0 ? images : undefined,
        subtype: params.subtype,
        timestamp: params.timestamp,
        api_token: this.apiToken
      });
      return messageId;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async addMessages(params) {
    if (params.messages.length === 0) {
      return { inserted: 0, ids: [] };
    }
    const roleMap = {
      human: "user",
      assistant: "assistant",
      system: "system"
    };
    const preparedMessages = [];
    for (const msg of params.messages) {
      const redactedContent = truncate(redactSecrets(msg.content), MAX_CONTENT_SIZE);
      const redactedThinking = msg.thinking ? truncate(redactSecrets(msg.thinking), MAX_CONTENT_SIZE) : undefined;
      const toolCalls = msg.toolCalls?.map((tc) => ({
        id: tc.id,
        name: tc.name,
        input: truncate(redactSecrets(JSON.stringify(tc.input)), MAX_TOOL_RESULT_SIZE)
      }));
      const toolResults = msg.toolResults?.map((tr) => ({
        tool_use_id: tr.toolUseId,
        content: truncate(redactSecrets(tr.content), MAX_TOOL_RESULT_SIZE),
        is_error: tr.isError
      }));
      const images = [];
      if (msg.images && msg.images.length > 0) {
        const imagesToProcess = msg.images.slice(0, MAX_IMAGES_PER_MESSAGE);
        for (const img of imagesToProcess) {
          const storageId = await this.uploadImage(img.data, img.mediaType);
          if (storageId) {
            images.push({ media_type: img.mediaType, storage_id: storageId, tool_use_id: img.toolUseId });
          }
        }
      }
      preparedMessages.push({
        message_uuid: msg.messageUuid,
        role: roleMap[msg.role],
        content: redactedContent,
        thinking: redactedThinking,
        tool_calls: toolCalls,
        tool_results: toolResults,
        images: images.length > 0 ? images : undefined,
        subtype: msg.subtype,
        timestamp: msg.timestamp
      });
    }
    const BATCH_SIZE = 25;
    let totalInserted = 0;
    const allIds = [];
    for (let i = 0;i < preparedMessages.length; i += BATCH_SIZE) {
      const batch = preparedMessages.slice(i, i + BATCH_SIZE);
      await this.throttle();
      try {
        const result = await this.client.mutation("messages:addMessages", {
          conversation_id: params.conversationId,
          messages: batch,
          api_token: this.apiToken
        });
        const typed = result;
        totalInserted += typed.inserted;
        allIds.push(...typed.ids);
      } catch (error) {
        if (isAuthError(error)) {
          throw new AuthExpiredError;
        }
        throw error;
      }
    }
    return { inserted: totalInserted, ids: allIds };
  }
  async updateSyncCursor(params) {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(params.filePath);
    try {
      await this.client.mutation("syncCursors:updateSyncCursor", {
        user_id: this.userId,
        file_path_hash: filePathHash,
        last_position: params.byteOffset,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async getSyncCursor(filePath) {
    if (!this.userId) {
      throw new Error("userId required for sync cursor operations");
    }
    const filePathHash = hashPath(filePath);
    try {
      const position = await this.client.query("syncCursors:getSyncCursor", {
        user_id: this.userId,
        file_path_hash: filePathHash,
        api_token: this.apiToken
      });
      return position ?? 0;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async updateTitle(conversationId, title) {
    try {
      await this.client.mutation("conversations:updateTitle", {
        conversation_id: conversationId,
        title,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async updateProjectPath(sessionId, projectPath, gitRoot) {
    try {
      const result = await this.client.mutation("conversations:updateProjectPath", {
        session_id: sessionId,
        project_path: projectPath,
        git_root: gitRoot,
        api_token: this.apiToken
      });
      return result;
    } catch {
      return null;
    }
  }
  async updateSessionId(conversationId, sessionId) {
    try {
      await this.client.mutation("conversations:updateSessionId", {
        conversation_id: conversationId,
        session_id: sessionId,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async registerManagedSession(sessionId, pid, tmuxSession, conversationId) {
    try {
      await this.client.mutation("managedSessions:registerManagedSession", {
        session_id: sessionId,
        pid,
        tmux_session: tmuxSession,
        conversation_id: conversationId,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async heartbeatManagedSession(sessionId) {
    try {
      await this.client.mutation("managedSessions:heartbeat", {
        session_id: sessionId,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async updateMessageStatus(params) {
    try {
      await this.client.mutation("pendingMessages:updateMessageStatus", {
        message_id: params.messageId,
        status: params.status,
        delivered_at: params.deliveredAt,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async retryMessage(messageId) {
    try {
      await this.client.mutation("pendingMessages:retryMessage", {
        message_id: messageId,
        api_token: this.apiToken
      });
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async setSessionError(conversationId, error) {
    if (!this.apiToken)
      return;
    try {
      await this.client.mutation("conversations:setSessionError", {
        conversation_id: conversationId,
        error,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async markSessionCompleted(conversationId) {
    if (!this.apiToken)
      return;
    try {
      await this.client.mutation("conversations:markSessionCompleted", {
        conversation_id: conversationId,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async markSessionActive(conversationId) {
    if (!this.apiToken)
      return;
    try {
      await this.client.mutation("conversations:markSessionActive", {
        conversation_id: conversationId,
        api_token: this.apiToken
      });
    } catch {
    }
  }
  async updateSessionAgentStatus(conversationId, status, clientTs, permissionMode) {
    if (!this.apiToken)
      return;
    try {
      await this.client.mutation("managedSessions:updateAgentStatus", {
        conversation_id: conversationId,
        agent_status: status,
        client_ts: clientTs || Date.now(),
        api_token: this.apiToken,
        ...permissionMode ? { permission_mode: permissionMode } : {}
      });
    } catch {
    }
  }
  async checkManagedSession(conversationId) {
    try {
      const result = await this.client.query("managedSessions:isSessionManaged", {
        conversation_id: conversationId,
        api_token: this.apiToken
      });
      return result;
    } catch {
      return null;
    }
  }
  async createPermissionRequest(params) {
    try {
      const permissionId = await this.client.mutation("permissions:createPermissionRequest", {
        conversation_id: params.conversation_id,
        session_id: params.session_id,
        tool_name: params.tool_name,
        arguments_preview: params.arguments_preview,
        api_token: this.apiToken
      });
      return permissionId;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async getPermissionDecision(sessionId) {
    try {
      const decision = await this.client.query("permissions:getPermissionDecision", {
        session_id: sessionId,
        api_token: this.apiToken
      });
      return decision;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async getMinCliVersion() {
    try {
      const version2 = await this.client.query("systemConfig:getMinCliVersion", {});
      return version2;
    } catch {
      return null;
    }
  }
  async syncLogs(logs) {
    if (!this.apiToken || logs.length === 0) {
      return null;
    }
    try {
      const result = await this.client.mutation("daemonLogs:insertBatch", {
        api_token: this.apiToken,
        logs
      });
      return result;
    } catch {
      return null;
    }
  }
  async createSessionNotification(params) {
    if (!this.apiToken)
      return;
    try {
      await this.client.mutation("notifications:createSessionNotification", {
        api_token: this.apiToken,
        conversation_id: params.conversation_id,
        type: params.type,
        title: params.title,
        message: params.message
      });
    } catch {
    }
  }
  async getMessageCountsForReconciliation(sessionIds) {
    if (!this.apiToken || sessionIds.length === 0) {
      return [];
    }
    try {
      const result = await this.client.query("conversations:getMessageCountsForReconciliation", {
        session_ids: sessionIds,
        api_token: this.apiToken
      });
      return result;
    } catch (error) {
      if (isAuthError(error)) {
        throw new AuthExpiredError;
      }
      throw error;
    }
  }
  async getDueTasks(limit) {
    if (!this.apiToken)
      return [];
    try {
      const result = await this.client.query("agentTasks:getDueTasks", { api_token: this.apiToken, limit });
      return result || [];
    } catch {
      return [];
    }
  }
  async claimTask(taskId, daemonId) {
    if (!this.apiToken)
      return null;
    try {
      return await this.client.mutation("agentTasks:claimTask", { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId });
    } catch {
      return null;
    }
  }
  async renewTaskLease(taskId, daemonId) {
    if (!this.apiToken)
      return false;
    try {
      const result = await this.client.mutation("agentTasks:renewLease", { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId });
      return result;
    } catch {
      return false;
    }
  }
  async completeTaskRun(taskId, daemonId, summary, conversationId) {
    if (!this.apiToken)
      return false;
    try {
      const result = await this.client.mutation("agentTasks:completeTaskRun", {
        api_token: this.apiToken,
        task_id: taskId,
        daemon_id: daemonId,
        summary,
        conversation_id: conversationId
      });
      return result;
    } catch {
      return false;
    }
  }
  async failTaskRun(taskId, daemonId, error) {
    if (!this.apiToken)
      return false;
    try {
      const result = await this.client.mutation("agentTasks:failTaskRun", { api_token: this.apiToken, task_id: taskId, daemon_id: daemonId, error });
      return result;
    } catch {
      return false;
    }
  }
}

// src/retryQueue.ts
import fs9 from "fs";
function parseRateLimitDelay(error) {
  const match = error.match(/wait (\d+) seconds/i);
  if (match) {
    return parseInt(match[1], 10) * 1000 + 1000;
  }
  if (error.toLowerCase().includes("rate limit")) {
    return 15000;
  }
  return null;
}
var DEFAULT_INITIAL_DELAY = 1000;
var DEFAULT_MAX_DELAY = 30000;
var DEFAULT_MAX_ATTEMPTS = 10;
var DEFAULT_CONCURRENCY = 5;

class RetryQueue {
  queue = new Map;
  timer = null;
  executor = null;
  initialDelayMs;
  maxDelayMs;
  maxAttempts;
  concurrency;
  persistPath;
  droppedPath;
  log;
  processing = false;
  rateLimitedUntil = 0;
  constructor(config = {}) {
    this.initialDelayMs = config.initialDelayMs ?? DEFAULT_INITIAL_DELAY;
    this.maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY;
    this.maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
    this.persistPath = config.persistPath ?? null;
    this.droppedPath = config.droppedPath ?? null;
    this.log = config.onLog ?? (() => {
    });
    this.load();
  }
  load() {
    if (!this.persistPath)
      return;
    try {
      if (fs9.existsSync(this.persistPath)) {
        const data = JSON.parse(fs9.readFileSync(this.persistPath, "utf-8"));
        if (Array.isArray(data)) {
          for (const op of data) {
            if (op.id && op.type && op.params) {
              op.nextRetryAt = Date.now() + 1000;
              this.queue.set(op.id, op);
            }
          }
          if (this.queue.size > 0) {
            this.log(`Restored ${this.queue.size} operations from disk`);
          }
        }
      }
    } catch {
      this.log("Failed to load retry queue from disk");
    }
  }
  start() {
    if (this.queue.size > 0) {
      this.scheduleNextCheck();
    }
  }
  persist() {
    if (!this.persistPath)
      return;
    try {
      const data = Array.from(this.queue.values());
      fs9.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
    } catch {
      this.log("Failed to persist retry queue to disk");
    }
  }
  setExecutor(executor) {
    this.executor = executor;
  }
  add(type, params, error) {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const rateLimitDelay = error ? parseRateLimitDelay(error) : null;
    const delay = rateLimitDelay ?? this.initialDelayMs;
    const op = {
      id,
      type,
      params,
      attempts: 0,
      nextRetryAt: Date.now() + delay,
      createdAt: Date.now(),
      lastError: error,
      rateLimitDelayMs: rateLimitDelay ?? undefined
    };
    this.queue.set(id, op);
    this.persist();
    this.log(`Queued ${type} for retry${rateLimitDelay ? ` (rate limited, ${delay}ms)` : ""} (id: ${id})`);
    this.scheduleNextCheck();
    return id;
  }
  calculateNextDelay(attempts) {
    const delay = this.initialDelayMs * Math.pow(2, attempts);
    return Math.min(delay, this.maxDelayMs);
  }
  scheduleNextCheck() {
    this.stopTimer();
    if (this.queue.size === 0) {
      return;
    }
    const now = Date.now();
    let earliestRetryAt = this.rateLimitedUntil > now ? this.rateLimitedUntil : Infinity;
    for (const op of this.queue.values()) {
      if (op.nextRetryAt < earliestRetryAt) {
        earliestRetryAt = op.nextRetryAt;
      }
    }
    if (this.rateLimitedUntil > now && earliestRetryAt < this.rateLimitedUntil) {
      earliestRetryAt = this.rateLimitedUntil;
    }
    const delay = Math.max(10, earliestRetryAt - now);
    this.timer = setTimeout(() => this.processQueue(), delay);
  }
  stopTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
  async processQueue() {
    if (this.processing || !this.executor || this.queue.size === 0)
      return;
    this.processing = true;
    const now = Date.now();
    if (this.rateLimitedUntil > now) {
      this.processing = false;
      this.scheduleNextCheck();
      return;
    }
    const readyOps = [];
    for (const op of this.queue.values()) {
      if (op.nextRetryAt <= now) {
        readyOps.push(op);
      }
    }
    if (readyOps.length === 0) {
      this.processing = false;
      this.scheduleNextCheck();
      return;
    }
    const batch = readyOps.slice(0, this.concurrency);
    const processOp = async (op) => {
      op.attempts++;
      this.log(`Retrying ${op.type} (attempt ${op.attempts}/${this.maxAttempts}, id: ${op.id})`);
      try {
        const success = await this.executor(op);
        if (success) {
          this.queue.delete(op.id);
          this.log(`Retry succeeded for ${op.type} (id: ${op.id})`);
        } else {
          this.handleFailure(op, "Operation returned false");
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const rateLimitDelay = parseRateLimitDelay(errorMsg);
        if (rateLimitDelay) {
          this.rateLimitedUntil = Date.now() + rateLimitDelay;
          this.log(`Rate limited globally for ${rateLimitDelay}ms`, "warn");
        }
        this.handleFailure(op, errorMsg);
      }
    };
    await Promise.all(batch.map(processOp));
    this.persist();
    this.processing = false;
    this.scheduleNextCheck();
  }
  isNetworkError(error) {
    const networkPatterns = ["typo in the url", "unable to connect", "fetch failed", "econnrefused", "enotfound", "etimedout", "network", "socket"];
    const lower = error.toLowerCase();
    return networkPatterns.some((p) => lower.includes(p));
  }
  handleFailure(op, error) {
    op.lastError = error;
    const isNetwork = this.isNetworkError(error);
    if (isNetwork && Date.now() - op.createdAt > 24 * 60 * 60 * 1000) {
      this.log(`Network op retrying >24h: ${op.type} (${op.attempts} attempts, id: ${op.id}). Still persisting.`, "error");
    }
    if (op.attempts >= this.maxAttempts && !isNetwork) {
      this.log(`Max retries reached. DROPPED: ${op.type} after ${op.attempts} attempts. Last error: ${error}. Session: ${op.params.sessionId || "unknown"}`, "error");
      this.recordDroppedOperation(op);
      this.queue.delete(op.id);
      return;
    }
    const rateLimitDelay = parseRateLimitDelay(error);
    const maxDelay = isNetwork ? 5 * 60 * 1000 : this.maxDelayMs;
    const effectiveAttempts = isNetwork ? Math.min(op.attempts, 10) : op.attempts;
    const baseDelay = rateLimitDelay ?? this.calculateNextDelay(effectiveAttempts);
    const nextDelay = Math.min(baseDelay, maxDelay);
    op.nextRetryAt = Date.now() + nextDelay;
    op.rateLimitDelayMs = rateLimitDelay ?? undefined;
    this.log(`Retry failed for ${op.type}: ${error}. Next retry in ${nextDelay}ms${rateLimitDelay ? " (rate limited)" : ""}${isNetwork ? " (network, indefinite)" : ""} (id: ${op.id})`, "warn");
  }
  recordDroppedOperation(op) {
    if (!this.droppedPath)
      return;
    const dropped = {
      id: op.id,
      type: op.type,
      params: op.params,
      attempts: op.attempts,
      createdAt: op.createdAt,
      droppedAt: Date.now(),
      lastError: op.lastError,
      sessionId: op.params.sessionId,
      conversationId: op.params.conversationId
    };
    try {
      let existing = [];
      if (fs9.existsSync(this.droppedPath)) {
        try {
          existing = JSON.parse(fs9.readFileSync(this.droppedPath, "utf-8"));
        } catch {
          existing = [];
        }
      }
      existing.push(dropped);
      if (existing.length > 1000) {
        existing = existing.slice(-1000);
      }
      fs9.writeFileSync(this.droppedPath, JSON.stringify(existing, null, 2));
      this.log(`Recorded dropped operation to ${this.droppedPath}`);
    } catch (err) {
      this.log(`Failed to record dropped operation: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  getDroppedOperations() {
    if (!this.droppedPath || !fs9.existsSync(this.droppedPath)) {
      return [];
    }
    try {
      return JSON.parse(fs9.readFileSync(this.droppedPath, "utf-8"));
    } catch {
      return [];
    }
  }
  clearDroppedOperations() {
    if (this.droppedPath && fs9.existsSync(this.droppedPath)) {
      fs9.unlinkSync(this.droppedPath);
    }
  }
  getQueueSize() {
    return this.queue.size;
  }
  getPendingOperations() {
    return Array.from(this.queue.values());
  }
  clear() {
    this.queue.clear();
    this.persist();
    this.stopTimer();
  }
  stop() {
    this.stopTimer();
  }
  async waitForCompletion(timeoutMs = 1e4) {
    const startTime = Date.now();
    while (this.queue.size > 0) {
      if (Date.now() - startTime > timeoutMs) {
        this.log(`Timeout waiting for retry queue to drain (${this.queue.size} operations remaining)`);
        return false;
      }
      await new Promise((resolve3) => setTimeout(resolve3, 100));
    }
    this.log("All retry queue operations completed");
    return true;
  }
}

// src/invalidateSync.ts
async function delay(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
function exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount) {
  const maxDelayRet = minDelay + (maxDelay - minDelay) / maxFailureCount * Math.max(currentFailureCount, maxFailureCount);
  return Math.round(Math.random() * maxDelayRet);
}
function createBackoff(opts) {
  return async (callback) => {
    let currentFailureCount = 0;
    const minDelay = opts?.minDelay ?? 250;
    const maxDelay = opts?.maxDelay ?? 1000;
    const maxFailureCount = opts?.maxFailureCount ?? 50;
    while (true) {
      try {
        return await callback();
      } catch (e) {
        if (currentFailureCount < maxFailureCount) {
          currentFailureCount++;
        }
        opts?.onError?.(e, currentFailureCount);
        const waitForRequest = exponentialBackoffDelay(currentFailureCount, minDelay, maxDelay, maxFailureCount);
        await delay(waitForRequest);
      }
    }
  };
}
var backoff = createBackoff({
  onError: (e) => {
    console.warn(e);
  }
});

class InvalidateSync {
  _invalidated = false;
  _invalidatedDouble = false;
  _stopped = false;
  _command;
  _pendings = [];
  constructor(command) {
    this._command = command;
  }
  invalidate() {
    if (this._stopped) {
      return;
    }
    if (!this._invalidated) {
      this._invalidated = true;
      this._invalidatedDouble = false;
      this._doSync();
    } else {
      if (!this._invalidatedDouble) {
        this._invalidatedDouble = true;
      }
    }
  }
  async invalidateAndAwait() {
    if (this._stopped) {
      return;
    }
    await new Promise((resolve3) => {
      this._pendings.push(resolve3);
      this.invalidate();
    });
  }
  async awaitQueue() {
    if (this._stopped || !this._invalidated && this._pendings.length === 0) {
      return;
    }
    await new Promise((resolve3) => {
      this._pendings.push(resolve3);
    });
  }
  stop() {
    if (this._stopped) {
      return;
    }
    this._notifyPendings();
    this._stopped = true;
  }
  _notifyPendings = () => {
    for (const pending of this._pendings) {
      pending();
    }
    this._pendings = [];
  };
  _doSync = async () => {
    await backoff(async () => {
      if (this._stopped) {
        return;
      }
      await this._command();
    });
    if (this._stopped) {
      this._notifyPendings();
      return;
    }
    if (this._invalidatedDouble) {
      this._invalidatedDouble = false;
      this._doSync();
    } else {
      this._invalidated = false;
      this._notifyPendings();
    }
  };
}

// src/daemon.ts
import { promisify as promisify2 } from "util";

// src/permissionDetector.ts
var PERMISSION_PATTERNS = [
  /Allow tool (\w+)\?\s*\[y\/n\]/i,
  /Permission required.*?to use (\w+)/i,
  /Do you want to allow.*?(\w+)/i,
  /Approve (\w+) tool/i,
  /Allow (\w+) to execute/i,
  /\[y\/n\]\s*$/i,
  /Allow execution\?/i,
  /Proceed with execution\?/i
];
function detectPermissionPrompt(content) {
  const hasYesNoPrompt = content.match(/\[y\/n\]\s*$/i);
  const hasAllowKeyword = content.match(/allow|permission|approve|proceed/i);
  if (hasYesNoPrompt && hasAllowKeyword) {
    const toolName = extractToolName(content);
    const argumentsPreview = extractArgumentsPreview(content);
    return {
      tool_name: toolName,
      arguments_preview: argumentsPreview
    };
  }
  for (const pattern of PERMISSION_PATTERNS) {
    const match = content.match(pattern);
    if (match) {
      const toolName = extractToolName(content);
      const argumentsPreview = extractArgumentsPreview(content);
      return {
        tool_name: toolName,
        arguments_preview: argumentsPreview
      };
    }
  }
  return null;
}
function extractToolName(content) {
  const lowerContent = content.toLowerCase();
  if (lowerContent.includes("bash") || lowerContent.includes("shell") || lowerContent.includes("command")) {
    return "Bash";
  }
  if (lowerContent.includes("write") || lowerContent.includes("edit")) {
    return "Edit";
  }
  if (lowerContent.includes("read")) {
    return "Read";
  }
  const toolPatterns = [
    /(?:tool|allow)\s+['"]?(\w+)['"]?\s+(?:tool)?/i
  ];
  for (const pattern of toolPatterns) {
    const match = content.match(pattern);
    if (match && match[1] && !match[1].match(/^(to|the|a|an)$/i)) {
      return match[1];
    }
  }
  return "unknown";
}
function extractArgumentsPreview(content) {
  const lines = content.split(`
`);
  const relevantLines = [];
  for (let i = 0;i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    if (line && !line.match(/^Allow|^Permission|^Do you want|^\[y\/n\]/i)) {
      relevantLines.push(line);
    }
  }
  const preview = relevantLines.join(" ").substring(0, 200);
  return preview || content.substring(0, 200);
}

// src/permissionHandler.ts
var POLL_INTERVAL_MS = 1000;
var TIMEOUT_MS = 5 * 60 * 1000;
async function handlePermissionRequest(syncService2, conversationId, sessionId, prompt, log) {
  try {
    await syncService2.createPermissionRequest({
      conversation_id: conversationId,
      session_id: sessionId,
      tool_name: prompt.tool_name,
      arguments_preview: prompt.arguments_preview
    });
    log(`Created permission request for tool: ${prompt.tool_name}`);
    const startTime = Date.now();
    while (Date.now() - startTime < TIMEOUT_MS) {
      const decision = await syncService2.getPermissionDecision(sessionId);
      if (decision) {
        const approved = decision.status === "approved";
        log(`Permission ${approved ? "approved" : "denied"} for tool: ${prompt.tool_name}`);
        return { approved };
      }
      await new Promise((resolve3) => setTimeout(resolve3, POLL_INTERVAL_MS));
    }
    log(`Permission request timed out for tool: ${prompt.tool_name}`);
    return null;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error handling permission request: ${errMsg}`);
    return null;
  }
}

// src/update.ts
import * as fs10 from "fs";
import * as path10 from "path";
import * as os from "os";
var VERSION = "1.0.75";
var LATEST_URL = "https://dl.codecast.sh/latest.json";
var UPDATE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
var CONFIG_DIR3 = process.env.HOME + "/.codecast";
var UPDATE_STATE_FILE = path10.join(CONFIG_DIR3, "update-state.json");
function getPlatformKey() {
  const platform2 = os.platform();
  const arch2 = os.arch();
  const platformMap = {
    darwin: "darwin",
    linux: "linux",
    win32: "windows"
  };
  const archMap = {
    arm64: "arm64",
    x64: "x64",
    x86_64: "x64"
  };
  const p = platformMap[platform2] || platform2;
  const a = archMap[arch2] || arch2;
  return `${p}-${a}`;
}
function readUpdateState() {
  try {
    if (fs10.existsSync(UPDATE_STATE_FILE)) {
      return JSON.parse(fs10.readFileSync(UPDATE_STATE_FILE, "utf-8"));
    }
  } catch {
  }
  return {};
}
function writeUpdateState(state) {
  try {
    if (!fs10.existsSync(CONFIG_DIR3)) {
      fs10.mkdirSync(CONFIG_DIR3, { recursive: true });
    }
    fs10.writeFileSync(UPDATE_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
  }
}
function getVersion() {
  return VERSION;
}
function isDevMode() {
  const exe = process.execPath.toLowerCase();
  return exe.includes("bun") || !exe.includes("codecast") && !exe.includes("/cast");
}
async function performUpdate() {
  if (isDevMode()) {
    console.error("Cannot self-update in dev mode (running via bun)");
    console.error("Install the binary version: curl -fsSL codecast.sh/install | sh (provides 'cast' command)");
    return false;
  }
  const platformKey = getPlatformKey();
  try {
    const response = await fetch(LATEST_URL);
    if (!response.ok) {
      console.error("Failed to fetch update info");
      return false;
    }
    const latest = await response.json();
    const binary = latest.binaries[platformKey];
    if (!binary) {
      console.error(`No binary available for platform: ${platformKey}`);
      return false;
    }
    console.log(`Downloading cast v${latest.version}...`);
    const binaryResponse = await fetch(binary.url);
    if (!binaryResponse.ok) {
      console.error("Failed to download binary");
      return false;
    }
    const binaryData = await binaryResponse.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", binaryData);
    const hashHex = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hashHex !== binary.sha256) {
      console.error("Checksum verification failed");
      return false;
    }
    const currentExe = process.execPath;
    const backupExe = currentExe + ".backup";
    const newExe = currentExe + ".new";
    fs10.writeFileSync(newExe, Buffer.from(binaryData));
    fs10.chmodSync(newExe, 493);
    if (fs10.existsSync(backupExe)) {
      fs10.unlinkSync(backupExe);
    }
    fs10.renameSync(currentExe, backupExe);
    fs10.renameSync(newExe, currentExe);
    try {
      fs10.unlinkSync(backupExe);
    } catch {
    }
    const state = readUpdateState();
    state.availableVersion = undefined;
    writeUpdateState(state);
    console.log(`Updated to v${latest.version}`);
    ensureCastAlias();
    return true;
  } catch (err) {
    console.error("Update failed:", err);
    return false;
  }
}
function ensureCastAlias() {
  if (isDevMode())
    return;
  const exe = process.execPath;
  const dir = path10.dirname(exe);
  const castLink = path10.join(dir, "cast");
  try {
    const target = fs10.readlinkSync(castLink);
    if (target === exe)
      return;
    fs10.unlinkSync(castLink);
  } catch (e) {
    if (e?.code === "ENOENT") {
    } else {
      return;
    }
  }
  try {
    fs10.symlinkSync(exe, castLink);
  } catch {
  }
}

// src/reconciliation.ts
import * as fs11 from "fs";
import * as path11 from "path";
var CONFIG_DIR4 = process.env.HOME + "/.codecast";
var RECONCILIATION_FILE = path11.join(CONFIG_DIR4, "last-reconciliation.json");
function saveLastReconciliation(data) {
  try {
    fs11.writeFileSync(RECONCILIATION_FILE, JSON.stringify(data, null, 2));
  } catch {
  }
}
function countMessagesInFile(filePath) {
  try {
    const content = fs11.readFileSync(filePath, "utf-8");
    const messages = parseSessionFile(content);
    return messages.length;
  } catch {
    return 0;
  }
}
function extractSessionIdFromPath(filePath) {
  return path11.basename(filePath, ".jsonl");
}
async function performReconciliation(syncService2, log, maxFiles = 50) {
  const result = {
    timestamp: Date.now(),
    checked: 0,
    discrepancies: [],
    errors: []
  };
  const claudeProjectsDir = path11.join(process.env.HOME || "", ".claude", "projects");
  if (!fs11.existsSync(claudeProjectsDir)) {
    return result;
  }
  const recentFiles = [];
  const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const scanDir = (dir) => {
    try {
      const entries = fs11.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path11.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.name.endsWith(".jsonl") && !entry.name.startsWith("agent-")) {
          try {
            const stats = fs11.statSync(fullPath);
            if (now - stats.mtimeMs < maxAgeMs) {
              recentFiles.push({ path: fullPath, mtime: stats.mtimeMs });
            }
          } catch {
          }
        }
      }
    } catch {
    }
  };
  scanDir(claudeProjectsDir);
  recentFiles.sort((a, b) => b.mtime - a.mtime);
  const filesToCheck = recentFiles.slice(0, maxFiles);
  if (filesToCheck.length === 0) {
    log("Reconciliation: No recent session files found");
    return result;
  }
  const sessionIds = filesToCheck.map((f) => extractSessionIdFromPath(f.path));
  log(`Reconciliation: Checking ${sessionIds.length} sessions against backend`);
  let backendCounts = [];
  try {
    backendCounts = await syncService2.getMessageCountsForReconciliation(sessionIds);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    result.errors.push(`Failed to query backend: ${errMsg}`);
    log(`Reconciliation error: ${errMsg}`, "error");
    return result;
  }
  const backendMap = new Map(backendCounts.map((c) => [c.session_id, c]));
  for (const file of filesToCheck) {
    const sessionId = extractSessionIdFromPath(file.path);
    const localCount = countMessagesInFile(file.path);
    const backendData = backendMap.get(sessionId);
    result.checked++;
    if (!backendData) {
      result.discrepancies.push({
        sessionId,
        filePath: file.path,
        localCount,
        backendCount: 0,
        status: "missing_backend"
      });
      log(`Reconciliation: Session ${sessionId.slice(0, 8)}... missing from backend (${localCount} local messages)`, "warn");
    } else if (localCount !== backendData.message_count) {
      result.discrepancies.push({
        sessionId,
        filePath: file.path,
        localCount,
        backendCount: backendData.message_count,
        status: "count_mismatch"
      });
      log(`Reconciliation: Session ${sessionId.slice(0, 8)}... count mismatch (local: ${localCount}, backend: ${backendData.message_count})`, "warn");
    }
  }
  saveLastReconciliation({
    timestamp: result.timestamp,
    discrepancyCount: result.discrepancies.length
  });
  if (result.discrepancies.length === 0) {
    log(`Reconciliation: All ${result.checked} sessions match backend`);
  } else {
    log(`Reconciliation: Found ${result.discrepancies.length} discrepancies out of ${result.checked} sessions`, "warn");
  }
  return result;
}
async function repairDiscrepancies(discrepancies, log) {
  let repaired = 0;
  const MAX_RESYNC_BYTES = 5 * 1024 * 1024;
  for (const d of discrepancies) {
    if (d.status === "count_mismatch" && d.backendCount >= d.localCount) {
      log(`Skipping repair for ${d.sessionId.slice(0, 8)}... backend already has >= local messages (backend: ${d.backendCount}, local: ${d.localCount})`);
      continue;
    }
    if (d.status === "missing_backend" || d.status === "count_mismatch") {
      let fileSize = 0;
      try {
        fileSize = fs11.statSync(d.filePath).size;
      } catch {
      }
      if (fileSize > MAX_RESYNC_BYTES) {
        const newPosition = Math.max(0, fileSize - MAX_RESYNC_BYTES);
        setPosition(d.filePath, newPosition);
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to ${newPosition} (tail ${MAX_RESYNC_BYTES} bytes of ${fileSize} byte file)`);
      } else {
        setPosition(d.filePath, 0);
        log(`Reset sync position for ${d.sessionId.slice(0, 8)}... to trigger full re-sync`);
      }
      repaired++;
    }
  }
  return repaired;
}

// src/taskScheduler.ts
import { exec } from "child_process";
import { promisify } from "util";
import * as fs12 from "fs";
import * as crypto3 from "crypto";

// src/tmux.ts
import { execSync, spawnSync } from "child_process";
var ENRICHED_PATH = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
var _hasTmux = null;
function hasTmux() {
  if (_hasTmux === null) {
    try {
      execSync("tmux -V", { stdio: "ignore", timeout: 2000, env: { ...process.env, PATH: ENRICHED_PATH } });
      _hasTmux = true;
    } catch {
      return false;
    }
  }
  return _hasTmux;
}

// src/taskScheduler.ts
var _execAsync = promisify(exec);
var execAsync = (cmd, opts) => _execAsync(cmd, { timeout: 1e4, ...opts });
var POLL_INTERVAL_MS2 = 30000;
var HEARTBEAT_INTERVAL_MS = 60000;
var MAX_CONCURRENCY = 2;

class TaskScheduler {
  daemonId;
  syncService;
  config;
  log;
  running = new Map;
  pollTimer = null;
  stopped = false;
  constructor({ syncService: syncService2, config, log }) {
    this.daemonId = crypto3.randomUUID();
    this.syncService = syncService2;
    this.config = config;
    this.log = (msg, level) => log(`[TaskSched] ${msg}`, level);
  }
  start() {
    this.log(`Started with daemon_id=${this.daemonId.slice(0, 8)}, polling every ${POLL_INTERVAL_MS2 / 1000}s`);
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS2);
  }
  stop() {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const task of this.running.values()) {
      clearInterval(task.heartbeatTimer);
    }
    this.running.clear();
    this.log("Stopped");
  }
  async poll() {
    if (this.stopped)
      return;
    if (this.running.size >= MAX_CONCURRENCY)
      return;
    try {
      const dueTasks = await this.syncService.getDueTasks(MAX_CONCURRENCY - this.running.size);
      if (!dueTasks || dueTasks.length === 0)
        return;
      for (const task of dueTasks) {
        if (this.running.size >= MAX_CONCURRENCY)
          break;
        if (this.running.has(task._id))
          continue;
        await this.executeTask(task);
      }
    } catch (err) {
      this.log(`Poll error: ${err instanceof Error ? err.message : String(err)}`, "warn");
    }
  }
  async executeTask(task) {
    const claimed = await this.syncService.claimTask(task._id, this.daemonId);
    if (!claimed) {
      this.log(`Failed to claim task ${task._id} (already claimed?)`);
      return;
    }
    this.log(`Claimed task "${task.title}" (${task._id})`);
    const prompt = this.buildPrompt(task);
    const agentType = task.agent_type || "claude";
    const projectPath = task.project_path || process.env.HOME || "/tmp";
    const cwd = fs12.existsSync(projectPath) ? projectPath : process.env.HOME || "/tmp";
    const shortId = task._id.toString().slice(-6);
    const tmuxSession = `ct-${agentType}-${shortId}`;
    const promptFile = `/tmp/codecast-task-${shortId}.txt`;
    fs12.writeFileSync(promptFile, prompt);
    let args = [];
    if (agentType === "codex") {
      args.push("codex", `"$(cat ${promptFile})"`);
      const extraArgs = this.config.codex_args;
      if (extraArgs) {
        args.push(...extraArgs.split(/\s+/).filter(Boolean));
      }
      if (!args.some((a) => a.includes("--full-auto") || a.includes("--ask-for-approval") || a.includes("--dangerously-bypass"))) {
        args.push("--dangerously-bypass-approvals-and-sandbox");
      }
    } else {
      args.push("claude", "-p", `"$(cat ${promptFile})"`, "--dangerously-skip-permissions");
      const extraArgs = this.config.claude_args;
      if (extraArgs) {
        const skip = new Set(["--chrome", "--dangerously-skip-permissions"]);
        const extra = extraArgs.split(/\s+/).filter(Boolean);
        for (const arg of extra) {
          if (!skip.has(arg) && !args.includes(arg))
            args.push(arg);
        }
      }
    }
    const shellCmd = `unset CLAUDECODE; ${args.join(" ")}; rm -f ${promptFile}`;
    if (!hasTmux()) {
      this.log(`tmux not installed, cannot run task "${task.title}"`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, "tmux is not installed");
      return;
    }
    try {
      try {
        await execAsync(`tmux kill-session -t '${tmuxSession}' 2>/dev/null`);
      } catch {
      }
      await execAsync(`tmux new-session -d -s '${tmuxSession}' -c '${cwd}'`);
      await execAsync(`tmux send-keys -t '${tmuxSession}' ${JSON.stringify(shellCmd)} Enter`);
      this.log(`Spawned tmux session ${tmuxSession} for task "${task.title}"`);
    } catch (err) {
      this.log(`Failed to spawn tmux for task "${task.title}": ${err instanceof Error ? err.message : String(err)}`, "error");
      await this.syncService.failTaskRun(task._id, this.daemonId, "Failed to spawn tmux session");
      return;
    }
    const heartbeatTimer = setInterval(async () => {
      const renewed = await this.syncService.renewTaskLease(task._id, this.daemonId);
      if (!renewed) {
        this.log(`Lease renewal failed for task ${task._id}, stopping monitor`);
        this.cleanupTask(task._id);
      }
      await this.checkTaskCompletion(task._id);
    }, HEARTBEAT_INTERVAL_MS);
    const maxRuntimeMs = task.max_runtime_ms || 10 * 60 * 1000;
    this.running.set(task._id, {
      taskId: task._id,
      tmuxSession,
      startedAt: Date.now(),
      maxRuntimeMs,
      heartbeatTimer
    });
  }
  async checkTaskCompletion(taskId) {
    const entry = this.running.get(taskId);
    if (!entry)
      return;
    try {
      await execAsync(`tmux has-session -t '${entry.tmuxSession}' 2>/dev/null`);
    } catch {
      this.log(`tmux session ${entry.tmuxSession} ended for task ${taskId}`);
      await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent session ended");
      this.cleanupTask(taskId);
      return;
    }
    const elapsed = Date.now() - entry.startedAt;
    if (elapsed > entry.maxRuntimeMs) {
      this.log(`Task ${taskId} exceeded max runtime (${entry.maxRuntimeMs}ms), killing`);
      try {
        await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`);
      } catch {
      }
      await this.syncService.failTaskRun(taskId, this.daemonId, `Exceeded max runtime (${Math.round(entry.maxRuntimeMs / 60000)}min)`);
      this.cleanupTask(taskId);
      return;
    }
    try {
      const { stdout } = await execAsync(`tmux capture-pane -p -J -t '${entry.tmuxSession}' -S -20 2>/dev/null`);
      const lines = stdout.trim().split(`
`).filter(Boolean);
      const lastLine = lines[lines.length - 1]?.trim() || "";
      if (lastLine.endsWith("$") || lastLine.endsWith("%") || lastLine.endsWith("#")) {
        this.log(`Task ${taskId} returned to shell prompt, cleaning up`);
        try {
          await execAsync(`tmux kill-session -t '${entry.tmuxSession}'`);
        } catch {
        }
        await this.syncService.completeTaskRun(taskId, this.daemonId, "Agent exited");
        this.cleanupTask(taskId);
      }
    } catch {
    }
  }
  cleanupTask(taskId) {
    const entry = this.running.get(taskId);
    if (entry) {
      clearInterval(entry.heartbeatTimer);
      this.running.delete(taskId);
    }
  }
  buildPrompt(task) {
    const parts = [];
    parts.push(`[Codecast Task: ${task.title}]`);
    parts.push(`Task ID: ${task._id}`);
    parts.push(`Mode: ${task.mode || "propose"}`);
    parts.push("");
    parts.push(task.prompt);
    if (task.context_summary || task.last_run_summary) {
      parts.push("");
      parts.push("---");
    }
    if (task.context_summary) {
      const convId = task.originating_conversation_id;
      parts.push(`Context from originating session${convId ? ` (${convId.toString().slice(-8)})` : ""}:`);
      parts.push(task.context_summary);
    }
    if (task.last_run_summary) {
      const ago = task.last_run_at ? formatTimeAgo(Date.now() - task.last_run_at) : "unknown time ago";
      parts.push("");
      parts.push(`Previous run (${ago}):`);
      parts.push(task.last_run_summary);
    }
    parts.push("");
    parts.push("---");
    parts.push("Instructions:");
    parts.push(`- When done, run: cast task complete ${task._id} --summary "brief description of what was done"`);
    parts.push('- To schedule follow-up: cast task add "..." --in <time>');
    if (task.originating_conversation_id) {
      parts.push(`- Run \`cast read ${task.originating_conversation_id}\` for full original context`);
    }
    return parts.join(`
`);
  }
  getRunningCount() {
    return this.running.size;
  }
}
function formatTimeAgo(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60)
    return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24)
    return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// src/jsonlGenerator.ts
import * as fs13 from "fs";
import * as path12 from "path";
import * as crypto4 from "crypto";
var uuidv42 = () => crypto4.randomUUID();
function estimateTokensFromText(text) {
  if (!text)
    return 0;
  return Math.ceil(text.length / 4);
}
function estimateTokensForMessage(msg) {
  let tokens = 0;
  if (msg.content)
    tokens += estimateTokensFromText(msg.content);
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      if (tc.name)
        tokens += estimateTokensFromText(tc.name);
      if (tc.input)
        tokens += estimateTokensFromText(tc.input);
    }
  }
  if (msg.tool_results) {
    for (const tr of msg.tool_results) {
      const text = truncate2(tr.content || "", 2000);
      tokens += estimateTokensFromText(text);
    }
  }
  return tokens;
}
function chooseClaudeTailMessagesForTokenBudget(data, budgetTokens) {
  if (budgetTokens <= 0)
    return 0;
  const messages = data.messages;
  if (messages.length === 0)
    return 0;
  const reserved = estimateTokensFromText("[Codecast import]") + 512;
  const budget = Math.max(0, budgetTokens - reserved);
  let used = 0;
  let count = 0;
  for (let i = messages.length - 1;i >= 0; i -= 1) {
    const t = estimateTokensForMessage(messages[i]);
    if (count > 0 && used + t > budget)
      break;
    used += t;
    count += 1;
  }
  return Math.max(1, count);
}
var REQUEST_TIMEOUT_MS = 30000;
var MAX_RETRIES = 3;
function sleep(ms) {
  return new Promise((resolve3) => setTimeout(resolve3, ms));
}
async function fetchJsonWithRetry(url, body, context) {
  let lastErr;
  for (let attempt = 1;attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const rawText = await response.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch {
        if (response.status >= 500 && attempt < MAX_RETRIES) {
          await sleep(250 * attempt);
          continue;
        }
        throw new Error(`${context}: HTTP ${response.status} with invalid JSON`);
      }
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        await sleep(250 * attempt);
        continue;
      }
      return { response, data };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(250 * attempt);
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${context}: ${msg}`);
}
async function fetchExport(siteUrl, apiToken, conversationId) {
  const allMessages = [];
  let conversation = null;
  let cursor;
  let page = 0;
  while (true) {
    page += 1;
    if (page > 1000) {
      throw new Error("Export failed: too many pages");
    }
    const { response: resp, data } = await fetchJsonWithRetry(`${siteUrl}/cli/export`, {
      api_token: apiToken,
      conversation_id: conversationId,
      cursor,
      limit: 500
    }, "Export failed");
    if (data.error) {
      const details = data.details ? ` (${data.details.trim()})` : "";
      const shouldFallbackToRead = !cursor && data.error === "Internal error" && typeof data.details === "string" && data.details.includes("Array length is too long");
      if (shouldFallbackToRead) {
        return await fetchExportViaReadApi(siteUrl, apiToken, conversationId);
      }
      throw new Error(`Export failed: ${data.error}${details}`);
    }
    if (!resp.ok) {
      throw new Error(`Export failed: HTTP ${resp.status}`);
    }
    if (!data.conversation || !Array.isArray(data.messages)) {
      throw new Error("Export failed: malformed export response");
    }
    if (!conversation) {
      conversation = data.conversation;
    }
    allMessages.push(...data.messages);
    const nextCursor = typeof data.next_cursor === "string" ? data.next_cursor : undefined;
    if (data.done || !nextCursor) {
      break;
    }
    if (nextCursor === cursor) {
      throw new Error("Export failed: pagination cursor did not advance");
    }
    cursor = nextCursor;
  }
  if (!conversation) {
    throw new Error("Export failed: missing conversation metadata");
  }
  return {
    conversation,
    messages: allMessages
  };
}
async function fetchExportViaReadApi(siteUrl, apiToken, conversationId) {
  let startLine = 1;
  let totalCount = 0;
  let convMeta;
  const allMessages = [];
  while (true) {
    const endLine = startLine + 49;
    const { response: resp, data } = await fetchJsonWithRetry(`${siteUrl}/cli/read`, {
      api_token: apiToken,
      conversation_id: conversationId,
      start_line: startLine,
      end_line: endLine
    }, "Export failed");
    if (data.error) {
      const details = data.details ? ` (${data.details.trim()})` : "";
      throw new Error(`Export failed: ${data.error}${details}`);
    }
    if (!resp.ok) {
      throw new Error(`Export failed: fallback read HTTP ${resp.status}`);
    }
    if (!data.conversation || !Array.isArray(data.messages)) {
      throw new Error("Export failed: malformed fallback read response");
    }
    if (!convMeta) {
      convMeta = data.conversation;
      totalCount = data.conversation.message_count || 0;
    }
    for (const msg of data.messages) {
      allMessages.push({
        role: msg.role,
        content: msg.content || "",
        timestamp: msg.timestamp,
        tool_calls: msg.tool_calls?.map((tc, idx) => ({
          id: tc.id || `tool_${startLine}_${idx}`,
          name: tc.name || "unknown_tool",
          input: tc.input || "{}"
        })),
        tool_results: msg.tool_results?.map((tr) => ({
          tool_use_id: tr.tool_use_id || `tool_${startLine}`,
          content: tr.content || "",
          is_error: tr.is_error
        }))
      });
    }
    if (allMessages.length >= totalCount || data.messages.length === 0) {
      break;
    }
    startLine += 50;
  }
  if (!convMeta) {
    throw new Error("Export failed: fallback read missing conversation metadata");
  }
  const startedAt = allMessages[0]?.timestamp || convMeta.updated_at || new Date().toISOString();
  return {
    conversation: {
      id: convMeta.id,
      title: convMeta.title,
      session_id: convMeta.id,
      agent_type: "claude_code",
      project_path: convMeta.project_path || null,
      model: null,
      message_count: totalCount,
      started_at: startedAt,
      updated_at: convMeta.updated_at
    },
    messages: allMessages
  };
}
function truncate2(text, max = 2000) {
  if (text.length <= max)
    return text;
  return text.slice(0, max) + `
... (truncated)`;
}
function partitionToolResultsByExpected(results, expectedToolUseIds) {
  const matched = [];
  const orphaned = [];
  for (const tr of results || []) {
    if (expectedToolUseIds.has(tr.tool_use_id)) {
      matched.push(tr);
    } else {
      orphaned.push(tr);
    }
  }
  return { matched, orphaned };
}
function generateClaudeCodeJsonl(data, options = {}) {
  const lines = [];
  const sessionId = options.sessionId || uuidv42();
  const cwd = data.conversation.project_path || process.cwd();
  let parentUuid = null;
  let expectedToolUseIds = new Set;
  const firstUuid = uuidv42();
  lines.push(JSON.stringify({
    type: "file-history-snapshot",
    messageId: firstUuid,
    snapshot: { messageId: firstUuid, trackedFileBackups: {}, timestamp: data.conversation.started_at },
    isSnapshotUpdate: false
  }));
  let messages = data.messages;
  const tailMessages = typeof options.tailMessages === "number" ? options.tailMessages : undefined;
  if (tailMessages && tailMessages > 0 && messages.length > tailMessages) {
    const cutoffIndex = messages.length - tailMessages;
    const firstUserIndex = messages.findIndex((m) => m.role === "user");
    const firstUser = firstUserIndex >= 0 ? messages[firstUserIndex] : null;
    const tail = messages.slice(-tailMessages);
    const notice = {
      role: "user",
      timestamp: data.conversation.started_at,
      content: `[Codecast import] This Claude session was truncated to avoid overly-long context (which can break Claude Code /compact).
` + `Original: ${messages.length} messages. Included: last ${tailMessages} messages` + (firstUser && firstUserIndex < cutoffIndex ? " + first user message." : ".")
    };
    messages = [notice];
    if (firstUser && firstUserIndex < cutoffIndex) {
      messages.push(firstUser);
    }
    messages.push(...tail);
  }
  for (const msg of messages) {
    const uuid = msg.message_uuid || uuidv42();
    if (msg.role === "user") {
      const { matched } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      if (matched.length > 0) {
        const content = [];
        if (msg.content && msg.content.trim().length > 0) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tr of matched) {
          content.push({
            type: "tool_result",
            tool_use_id: tr.tool_use_id,
            content: [{ type: "text", text: truncate2(tr.content || "") }],
            ...tr.is_error ? { is_error: true } : {}
          });
        }
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content },
          uuid,
          timestamp: msg.timestamp,
          toolUseResult: matched.map((tr) => ({ type: "text", text: tr.content || "" }))
        }));
        parentUuid = uuid;
      } else if (msg.content && msg.content.length > 0) {
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content: msg.content },
          uuid,
          timestamp: msg.timestamp,
          thinkingMetadata: { maxThinkingTokens: 31999 },
          todos: [],
          permissionMode: "bypassPermissions"
        }));
        parentUuid = uuid;
      }
      expectedToolUseIds = new Set;
    } else if (msg.role === "assistant") {
      const contentBlocks = [];
      const assistantToolUseIds = new Set;
      if (msg.content)
        contentBlocks.push({ type: "text", text: msg.content });
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try {
            input = JSON.parse(tc.input);
          } catch {
          }
          contentBlocks.push({ type: "tool_use", id: tc.id, name: tc.name, input });
          assistantToolUseIds.add(tc.id);
        }
      }
      if (contentBlocks.length === 0)
        contentBlocks.push({ type: "text", text: "" });
      const msgId = `msg_${uuidv42().replace(/-/g, "").slice(0, 24)}`;
      lines.push(JSON.stringify({
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd,
        sessionId,
        version: "2.1.29",
        gitBranch: "main",
        message: {
          model: data.conversation.model || "claude-opus-4-6-20260205",
          id: msgId,
          type: "message",
          role: "assistant",
          content: contentBlocks,
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 500, service_tier: "standard" }
        },
        requestId: `req_${uuidv42().replace(/-/g, "").slice(0, 24)}`,
        type: "assistant",
        uuid,
        timestamp: msg.timestamp
      }));
      parentUuid = uuid;
      expectedToolUseIds = assistantToolUseIds;
      const { matched: inlineMatched } = partitionToolResultsByExpected(msg.tool_results, expectedToolUseIds);
      if (inlineMatched.length > 0) {
        const trUuid = uuidv42();
        const trContent = inlineMatched.map((tr) => ({
          type: "tool_result",
          tool_use_id: tr.tool_use_id,
          content: [{ type: "text", text: truncate2(tr.content || "") }],
          ...tr.is_error ? { is_error: true } : {}
        }));
        lines.push(JSON.stringify({
          parentUuid,
          isSidechain: false,
          userType: "external",
          cwd,
          sessionId,
          version: "2.1.29",
          gitBranch: "main",
          type: "user",
          message: { role: "user", content: trContent },
          uuid: trUuid,
          timestamp: msg.timestamp,
          toolUseResult: inlineMatched.map((tr) => ({ type: "text", text: tr.content || "" }))
        }));
        parentUuid = trUuid;
        expectedToolUseIds = new Set;
      }
    }
  }
  const merged = [];
  for (let i = 0;i < lines.length; i++) {
    try {
      const cur = JSON.parse(lines[i]);
      if (cur.message?.role === "assistant" && merged.length > 0) {
        const prev = JSON.parse(merged[merged.length - 1]);
        if (prev.message?.role === "assistant") {
          const prevContent = Array.isArray(prev.message.content) ? prev.message.content : [];
          const curContent = Array.isArray(cur.message.content) ? cur.message.content : [];
          prev.message.content = [...prevContent, ...curContent];
          merged[merged.length - 1] = JSON.stringify(prev);
          continue;
        }
      }
    } catch {
    }
    merged.push(lines[i]);
  }
  return { jsonl: merged.join(`
`) + `
`, sessionId };
}
function writeClaudeCodeSession(jsonl, sessionId, projectPath) {
  const projectSlug = (projectPath || process.cwd()).replace(/\//g, "-");
  const projectDir = path12.join(process.env.HOME, ".claude", "projects", projectSlug);
  fs13.mkdirSync(projectDir, { recursive: true });
  const filePath = path12.join(projectDir, `${sessionId}.jsonl`);
  fs13.writeFileSync(filePath, jsonl);
  return sessionId;
}
function mapToolName(name) {
  return "shell_command";
}
function generateCodexJsonl(data, options = {}) {
  const lines = [];
  const sessionId = options.sessionId || uuidv42();
  const cwd = data.conversation.project_path || process.cwd();
  const startTime = data.conversation.started_at;
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "session_meta",
    payload: {
      id: sessionId,
      timestamp: startTime,
      cwd,
      originator: "codex_cli_rs",
      cli_version: "0.94.0",
      source: "cli",
      model_provider: "openai",
      base_instructions: { text: "You are Codex, a coding agent.", source: "built-in" }
    }
  }));
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: {
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: `<permissions instructions>
Filesystem sandboxing: sandbox_mode is danger-full-access. approval_policy is never.
</permissions instructions>` }]
    }
  }));
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `# Project context
Working directory: ${cwd}` }] }
  }));
  lines.push(JSON.stringify({
    timestamp: startTime,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>
  <cwd>${cwd}</cwd>
  <shell>bash</shell>
</environment_context>` }] }
  }));
  for (const msg of data.messages) {
    const ts = msg.timestamp;
    if (msg.role === "user") {
      if (msg.tool_results && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: { type: "function_call_output", call_id: tr.tool_use_id, output: tr.is_error ? `Error:
${tr.content}` : `Exit code: 0
Output:
${tr.content}` }
          }));
        }
      } else {
        if (msg.content) {
          lines.push(JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: msg.content }] } }));
          lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "user_message", message: msg.content, images: [], local_images: [], text_elements: [] } }));
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "turn_context",
            payload: {
              cwd,
              approval_policy: "never",
              sandbox_policy: { type: "danger-full-access" },
              model: "gpt-5.2-codex",
              personality: "friendly",
              collaboration_mode: { mode: "code", settings: { model: "gpt-5.2-codex", reasoning_effort: "high", developer_instructions: `you are now in code mode.
` } },
              effort: "high",
              summary: "auto"
            }
          }));
        }
      }
    } else if (msg.role === "assistant") {
      if (msg.thinking) {
        lines.push(JSON.stringify({
          timestamp: ts,
          type: "response_item",
          payload: { type: "reasoning", summary: [{ type: "summary_text", text: msg.thinking.slice(0, 500) }], content: null, encrypted_content: null }
        }));
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: { type: "function_call", name: mapToolName(tc.name), arguments: tc.input, call_id: tc.id }
          }));
        }
      }
      if (msg.content) {
        lines.push(JSON.stringify({ timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content }] } }));
        lines.push(JSON.stringify({ timestamp: ts, type: "event_msg", payload: { type: "agent_message", message: msg.content } }));
      }
      if (msg.tool_results && msg.tool_results.length > 0) {
        for (const tr of msg.tool_results) {
          lines.push(JSON.stringify({
            timestamp: ts,
            type: "response_item",
            payload: { type: "function_call_output", call_id: tr.tool_use_id, output: tr.is_error ? `Error:
${tr.content}` : `Exit code: 0
Output:
${tr.content}` }
          }));
        }
      }
      lines.push(JSON.stringify({
        timestamp: ts,
        type: "event_msg",
        payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: 0, window_minutes: 300, resets_at: 0 }, secondary: { used_percent: 0, window_minutes: 10080, resets_at: 0 }, credits: { has_credits: false, unlimited: false, balance: null }, plan_type: null } }
      }));
    }
  }
  return { jsonl: lines.join(`
`) + `
`, sessionId };
}
function writeCodexSession(jsonl, sessionId, name) {
  const now = new Date;
  const dateDir = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}`;
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const fileName = `${name || "remote"}-${ts}-${sessionId}.jsonl`;
  const sessionsDir = path12.join(process.env.HOME, ".codex", "sessions", dateDir);
  fs13.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path12.join(sessionsDir, fileName);
  fs13.writeFileSync(filePath, jsonl);
  return sessionId;
}

// src/daemon.ts
var __dirname = "/Users/ashot/src/codecast/packages/cli/src";
var _execAsync2 = promisify2(exec2);
var ENRICHED_PATH2 = [process.env.PATH, "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");
var EXEC_TIMEOUT_MS = 1e4;
var execAsync2 = (cmd, opts) => _execAsync2(cmd, { timeout: EXEC_TIMEOUT_MS, ...opts, env: { ...process.env, PATH: ENRICHED_PATH2, ...opts?.env } });
var _execFileAsync = promisify2(execFile);
var SAFE_ENV = { ...process.env, PATH: ENRICHED_PATH2 };
function tmuxExecSync(args, opts) {
  return execFileSync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    encoding: "utf-8",
    env: { ...SAFE_ENV, ...opts?.env }
  }).toString();
}
async function tmuxExec(args, opts) {
  return _execFileAsync("tmux", args, {
    timeout: opts?.timeout ?? EXEC_TIMEOUT_MS,
    killSignal: opts?.killSignal ?? "SIGTERM",
    env: { ...SAFE_ENV, ...opts?.env }
  });
}
function validatePath(p) {
  if (!p || typeof p !== "string")
    return null;
  if (!path13.isAbsolute(p))
    return null;
  if (/[;|&`$(){}<>"\r\n\0]/.test(p))
    return null;
  const resolved = path13.resolve(p);
  if (resolved !== p && resolved !== p.replace(/\/+$/, ""))
    return null;
  if (!fs14.existsSync(resolved))
    return null;
  return resolved;
}
var SAFE_ARG_RE = /^[a-zA-Z0-9_.\/=:@%+, -]+$/;
function sanitizeBinaryArgs(args) {
  return args.filter((a) => {
    if (!SAFE_ARG_RE.test(a)) {
      log(`[SECURITY] Rejected unsafe binary arg: ${a}`);
      return false;
    }
    return true;
  });
}
function validateTmuxTarget(target) {
  return /^[a-zA-Z0-9_.:-]+$/.test(target);
}
var lastTickTime = Date.now();
var SLEEP_DETECTION_THRESHOLD_MS = 30000;
var WAKE_GRACE_PERIOD_MS = 5000;
var wakeGraceUntil = 0;
setInterval(() => {
  const now = Date.now();
  const elapsed = now - lastTickTime;
  if (elapsed > SLEEP_DETECTION_THRESHOLD_MS) {
    wakeGraceUntil = now + WAKE_GRACE_PERIOD_MS;
    log(`Sleep detected (${Math.round(elapsed / 1000)}s gap), grace period until ${new Date(wakeGraceUntil).toISOString()}`);
  }
  lastTickTime = now;
}, 5000);
function isInWakeGrace() {
  return Date.now() < wakeGraceUntil;
}
var CONFIG_DIR5 = process.env.HOME + "/.codecast";
var CONFIG_FILE = path13.join(CONFIG_DIR5, "config.json");
var LOG_FILE = path13.join(CONFIG_DIR5, "daemon.log");
var STATE_FILE = path13.join(CONFIG_DIR5, "daemon.state");
var PID_FILE = path13.join(CONFIG_DIR5, "daemon.pid");
var VERSION_FILE = path13.join(CONFIG_DIR5, "daemon.version");
function getPermissionFlags(agentType, config) {
  const modes = config?.agent_permission_modes;
  if (agentType === "claude") {
    if (modes?.claude === "bypass")
      return "--permission-mode bypassPermissions";
  } else if (agentType === "codex") {
    const existing = config?.codex_args || "";
    if (existing.includes("--full-auto") || existing.includes("--ask-for-approval") || existing.includes("--dangerously-bypass"))
      return null;
    if (modes?.codex === "full_auto")
      return "--full-auto";
    if (modes?.codex === "default")
      return null;
    return "--dangerously-bypass-approvals-and-sandbox";
  } else if (agentType === "gemini") {
  }
  return null;
}
var AUTH_FAILURE_THRESHOLD = 5;
var WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;
var RECONCILIATION_INTERVAL_MS = 60 * 60 * 1000;
var WATCHDOG_STALE_THRESHOLD_MS = 10 * 60 * 1000;
var VERSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;
var LOG_FLUSH_INTERVAL_MS = 15 * 1000;
var MAX_LOG_QUEUE_SIZE = 500;
var LOG_QUEUE_FILE = path13.join(process.env.HOME || "", ".codecast", "log-queue.json");
var EVENT_LOOP_CHECK_INTERVAL_MS = 30 * 1000;
var EVENT_LOOP_LAG_THRESHOLD_MS = 60 * 1000;
var HEARTBEAT_STALE_THRESHOLD_MS = 15 * 60 * 1000;
var remoteLogQueue = [];
var syncServiceRef = null;
var daemonVersion;
var activeConfig = null;
var platform2 = process.platform;
function loadPersistedLogQueue() {
  try {
    if (fs14.existsSync(LOG_QUEUE_FILE)) {
      const data = JSON.parse(fs14.readFileSync(LOG_QUEUE_FILE, "utf-8"));
      if (Array.isArray(data) && data.length > 0) {
        remoteLogQueue = [...data, ...remoteLogQueue].slice(-MAX_LOG_QUEUE_SIZE);
        fs14.unlinkSync(LOG_QUEUE_FILE);
      }
    }
  } catch {
  }
}
function persistLogQueue() {
  if (remoteLogQueue.length === 0)
    return;
  try {
    fs14.writeFileSync(LOG_QUEUE_FILE, JSON.stringify(remoteLogQueue), { mode: 384 });
  } catch {
  }
}
function getSiteUrl() {
  const config = activeConfig || readConfig();
  if (!config?.convex_url)
    return null;
  return config.convex_url.replace(".cloud", ".site");
}
function getAuthToken() {
  const config = activeConfig || readConfig();
  return config?.auth_token || null;
}
async function flushRemoteLogsViaHttp() {
  if (remoteLogQueue.length === 0)
    return;
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token)
    return;
  const logsToSend = remoteLogQueue.splice(0, 100);
  const logsWithMeta = logsToSend.map((l) => ({
    ...l,
    daemon_version: daemonVersion,
    platform: platform2
  }));
  try {
    const response = await fetch(`${siteUrl}/cli/log-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_token: token, logs: logsWithMeta }),
      signal: AbortSignal.timeout(1e4)
    });
    if (!response.ok) {
      remoteLogQueue.unshift(...logsToSend);
      persistLogQueue();
    }
  } catch {
    remoteLogQueue.unshift(...logsToSend);
    persistLogQueue();
  }
}
function sendLogImmediate(level, message, metadata) {
  const siteUrl = getSiteUrl();
  const token = getAuthToken();
  if (!siteUrl || !token)
    return;
  fetch(`${siteUrl}/cli/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_token: token,
      level,
      message: message.slice(0, 2000),
      metadata,
      cli_version: daemonVersion,
      platform: platform2
    }),
    signal: AbortSignal.timeout(1e4)
  }).catch(() => {
  });
}
var IDLE_TIMEOUT_MS = 2 * 60000;
var IDLE_COOLDOWN_MS = 5 * 60000;
var idleTimers = new Map;
var lastIdleNotification = new Map;
var lastIdleNotifiedSize = new Map;
var lastErrorNotification = new Map;
var lastWorkingStatusSent = new Map;
var WORKING_STATUS_THROTTLE_MS = 1e4;
var lastHookStatus = new Map;
var pendingInteractivePrompts = new Map;
var AGENT_STATUS_DIR = path13.join(process.env.HOME || "", ".codecast", "agent-status");
function sendAgentStatus(syncService2, conversationId, sessionId, status, clientTs, permissionMode) {
  if (status === "working" && !permissionMode) {
    const last = lastWorkingStatusSent.get(sessionId) ?? 0;
    if (Date.now() - last < WORKING_STATUS_THROTTLE_MS)
      return;
    lastWorkingStatusSent.set(sessionId, Date.now());
  }
  syncService2.updateSessionAgentStatus(conversationId, status, clientTs, permissionMode).catch((err) => {
    log(`[sendAgentStatus] error: ${err?.message || err}`);
  });
}
function truncateForNotification(text, maxLen = 200) {
  let result = text.replace(/```[\s\S]*?```/g, "[code]").replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (result.length > maxLen) {
    result = result.slice(0, maxLen) + "...";
  }
  return result;
}
function detectErrorInMessage(content) {
  const patterns = [
    /(?:Error|ERROR|FATAL|FAILED|panic):\s*(.+)/,
    /(?:compilation failed|build failed|test failed)/i,
    /exit code (?!0\b)\d+/i,
    /(?:Traceback|Exception|Unhandled rejection)/i
  ];
  for (const pat of patterns) {
    const match = content.match(pat);
    if (match)
      return match[0].slice(0, 200);
  }
  return null;
}
function extractPendingToolUseFromTranscript(transcriptPath) {
  try {
    if (!transcriptPath || !fs14.existsSync(transcriptPath))
      return null;
    const tailContent = readFileTail(transcriptPath, 32768);
    const lines = tailContent.trim().split(`
`);
    const tail = lines.slice(-20);
    let lastToolUse = null;
    const completedToolIds = new Set;
    for (const line of tail) {
      try {
        const entry = JSON.parse(line);
        const msg = entry.message || entry;
        const blocks = Array.isArray(msg.content) ? msg.content : [];
        for (const block of blocks) {
          if (block.type === "tool_result")
            completedToolIds.add(block.tool_use_id);
          if (block.type === "tool_use")
            lastToolUse = { name: block.name, input: block.input };
        }
      } catch {
      }
    }
    if (!lastToolUse)
      return null;
    let preview = "";
    if (lastToolUse.input) {
      if (typeof lastToolUse.input.command === "string") {
        preview = lastToolUse.input.command;
      } else if (typeof lastToolUse.input.file_path === "string") {
        preview = lastToolUse.input.file_path;
      } else if (typeof lastToolUse.input.pattern === "string") {
        preview = lastToolUse.input.pattern;
      } else {
        preview = JSON.stringify(lastToolUse.input).slice(0, 300);
      }
    }
    if (lastToolUse.input?.description) {
      preview = `${lastToolUse.input.description}
${preview}`;
    }
    return { tool_name: lastToolUse.name, arguments_preview: preview.slice(0, 500) };
  } catch {
    return null;
  }
}
var permissionRecordPending = new Set;
var permissionJustResolved = new Set;
var syncStats = {
  messagesSynced: 0,
  conversationsCreated: 0,
  sessionsActive: new Set,
  lastReportTime: Date.now(),
  errors: 0,
  warnings: 0
};
var lastWatcherEventTime = Date.now();
var HEALTH_REPORT_INTERVAL_MS = 5 * 60 * 1000;
function log(message, level = "info", metadata) {
  const timestamp = new Date().toISOString();
  const levelTag = level === "info" ? "" : `[${level.toUpperCase()}] `;
  const line = `[${timestamp}] ${levelTag}${message}
`;
  fs14.appendFileSync(LOG_FILE, line);
  if (level === "warn" || level === "error") {
    remoteLogQueue.push({
      level,
      message: message.slice(0, 2000),
      metadata,
      timestamp: Date.now()
    });
    if (remoteLogQueue.length > MAX_LOG_QUEUE_SIZE) {
      remoteLogQueue.shift();
    }
  }
}
function logError(message, error, sessionId) {
  const errMsg = error ? `${message}: ${error.message}` : message;
  log(errMsg, "error", {
    session_id: sessionId,
    error_code: error?.name,
    stack: error?.stack?.slice(0, 1000)
  });
}
function logWarn(message, sessionId) {
  log(message, "warn", { session_id: sessionId });
}
function logDelivery(message, metadata) {
  log(message, "info", metadata);
  remoteLogQueue.push({
    level: "info",
    message: `[DELIVERY] ${message.slice(0, 2000)}`,
    metadata,
    timestamp: Date.now()
  });
  if (remoteLogQueue.length > MAX_LOG_QUEUE_SIZE) {
    remoteLogQueue.shift();
  }
}
function logLifecycle(event, details) {
  const message = details ? `[LIFECYCLE] ${event}: ${details}` : `[LIFECYCLE] ${event}`;
  log(message, "info");
  remoteLogQueue.push({
    level: "info",
    message,
    metadata: { error_code: event },
    timestamp: Date.now()
  });
}
function getSystemMetrics() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  let fds = 0;
  try {
    fds = fs14.readdirSync(`/dev/fd`).length;
  } catch {
    try {
      fds = parseInt(execSync2("lsof -p " + process.pid + " 2>/dev/null | wc -l", { timeout: 5000 }).toString().trim(), 10) || 0;
    } catch {
    }
  }
  return {
    rss_mb: Math.round(mem.rss / 1024 / 1024),
    heap_mb: Math.round(mem.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    uptime_min: Math.round(process.uptime() / 60),
    fds,
    cpu_user_ms: Math.round(cpu.user / 1000),
    cpu_system_ms: Math.round(cpu.system / 1000)
  };
}
var FD_WARN_THRESHOLD = 5000;
var RSS_WARN_THRESHOLD_MB = 1500;
function logHealthSummary() {
  const now = Date.now();
  const periodMinutes = Math.round((now - syncStats.lastReportTime) / 60000);
  const sessionsCount = syncStats.sessionsActive.size;
  const metrics = getSystemMetrics();
  const metricStr = `rss=${metrics.rss_mb}MB heap=${metrics.heap_mb}/${metrics.heap_total_mb}MB fds=${metrics.fds} cpu=${metrics.cpu_user_ms}+${metrics.cpu_system_ms}ms uptime=${metrics.uptime_min}min`;
  const syncStr = `${syncStats.messagesSynced}msgs ${syncStats.conversationsCreated}convos ${sessionsCount}sessions ${syncStats.errors}errs`;
  const summary = `Health: ${syncStr} | ${metricStr} (${periodMinutes}min)`;
  log(summary, "info");
  remoteLogQueue.push({
    level: "info",
    message: summary,
    metadata: {
      error_code: syncStats.errors > 0 ? `${syncStats.errors} errors` : undefined
    },
    timestamp: now
  });
  if (metrics.fds > FD_WARN_THRESHOLD) {
    const msg = `HIGH FD COUNT: ${metrics.fds} open file descriptors (threshold: ${FD_WARN_THRESHOLD})`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_fd_count" });
  }
  if (metrics.rss_mb > RSS_WARN_THRESHOLD_MB) {
    const msg = `HIGH MEMORY: ${metrics.rss_mb}MB RSS (threshold: ${RSS_WARN_THRESHOLD_MB}MB)`;
    logWarn(msg);
    sendLogImmediate("warn", msg, { error_code: "high_memory" });
  }
  syncStats.messagesSynced = 0;
  syncStats.conversationsCreated = 0;
  syncStats.sessionsActive.clear();
  syncStats.errors = 0;
  syncStats.warnings = 0;
  syncStats.lastReportTime = now;
}
function isAutostartEnabled() {
  const home = process.env.HOME || "";
  if (platform2 === "darwin") {
    const plistPath = path13.join(home, "Library", "LaunchAgents", "sh.codecast.daemon.plist");
    return fs14.existsSync(plistPath);
  } else if (platform2 === "linux") {
    const servicePath = path13.join(home, ".config", "systemd", "user", "codecast.service");
    return fs14.existsSync(servicePath);
  }
  return false;
}
async function pollDaemonCommands() {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url)
    return;
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonVersion || "unknown",
        platform: platform2,
        pid: process.pid,
        autostart_enabled: isAutostartEnabled(),
        has_tmux: hasTmux()
      })
    });
    if (!response.ok)
      return;
    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`[POLL] Received ${data.commands.length} command(s): ${data.commands.map((c) => c.command).join(", ")}`);
      for (const cmd of data.commands) {
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }
  } catch {
  }
}
async function sendHeartbeat() {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    return;
  }
  try {
    const siteUrl = config.convex_url.replace(".cloud", ".site");
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonVersion || "unknown",
        platform: platform2,
        pid: process.pid,
        autostart_enabled: isAutostartEnabled(),
        has_tmux: hasTmux()
      })
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      log(`Heartbeat failed: ${response.status} ${text}`);
      return;
    }
    const data = await response.json();
    if (data.commands && data.commands.length > 0) {
      log(`Received ${data.commands.length} remote command(s)`);
      for (const cmd of data.commands) {
        await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
      }
    }
    if (data.sync_mode !== undefined) {
      const currentConfig = readConfig();
      const serverMode = data.sync_mode;
      const serverProjects = data.sync_projects ?? [];
      const localMode = currentConfig?.sync_mode ?? "all";
      const localProjects = currentConfig?.sync_projects ?? [];
      if (serverMode !== localMode || JSON.stringify(serverProjects) !== JSON.stringify(localProjects)) {
        log(`Sync settings updated from server: mode=${serverMode}, projects=${serverProjects.length}`);
        patchConfig({ sync_mode: serverMode, sync_projects: serverProjects });
        if (activeConfig) {
          activeConfig.sync_mode = serverMode;
          activeConfig.sync_projects = serverProjects;
        }
      }
    }
    if (data.team_id !== undefined) {
      const currentConfig = readConfig();
      if (currentConfig && currentConfig.team_id !== data.team_id) {
        log(`Team ID updated from server: ${data.team_id}`);
        patchConfig({ team_id: data.team_id });
        if (activeConfig) {
          activeConfig.team_id = data.team_id;
        }
      }
    }
    if (data.agent_permission_modes !== undefined) {
      const currentConfig = readConfig();
      const serverModes = data.agent_permission_modes;
      const localModes = currentConfig?.agent_permission_modes;
      if (JSON.stringify(serverModes) !== JSON.stringify(localModes)) {
        log(`Agent permission modes updated from server: ${JSON.stringify(serverModes)}`);
        patchConfig({ agent_permission_modes: serverModes });
        if (activeConfig) {
          activeConfig.agent_permission_modes = serverModes;
        }
      }
    }
  } catch (err) {
    log(`Heartbeat error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function executeRemoteCommand(commandId, command, config, commandArgs) {
  const siteUrl = config.convex_url?.replace(".cloud", ".site");
  if (!siteUrl || !config.auth_token)
    return;
  let result;
  let error;
  try {
    switch (command) {
      case "status": {
        const state = readDaemonState();
        result = JSON.stringify({
          version: daemonVersion,
          platform: platform2,
          pid: process.pid,
          uptime: process.uptime(),
          autostart: isAutostartEnabled(),
          lastSync: state?.lastSyncTime,
          queueSize: state?.pendingQueueSize,
          stats: {
            messagesSynced: syncStats.messagesSynced,
            conversationsCreated: syncStats.conversationsCreated,
            activeSessions: syncStats.sessionsActive.size
          }
        });
        log(`[REMOTE] Status requested, responding`);
        break;
      }
      case "version": {
        result = daemonVersion || "unknown";
        log(`[REMOTE] Version requested: ${result}`);
        break;
      }
      case "restart": {
        log(`[REMOTE] Restart requested`);
        result = "restarting";
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result
          })
        });
        setTimeout(() => {
          log("Restarting daemon per remote command...");
          const spawned = spawnReplacement();
          if (spawned) {
            skipRespawn = true;
          } else {
            log("spawnReplacement failed, letting exit handler respawn");
          }
          setTimeout(() => process.exit(0), 500);
        }, 1000);
        return;
      }
      case "force_update": {
        const currentVersion = daemonVersion || "unknown";
        logLifecycle("update_start", `Remote update requested from v${currentVersion}`);
        result = "updating";
        await fetch(`${siteUrl}/cli/command-result`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            command_id: commandId,
            result
          })
        });
        await flushRemoteLogs();
        setTimeout(async () => {
          const success = await performUpdate();
          if (success) {
            logLifecycle("update_complete", `Binary replaced from v${currentVersion}, restarting`);
            await flushRemoteLogs();
            log("Update successful, restarting...");
            const spawned = spawnReplacement();
            if (spawned) {
              skipRespawn = true;
            } else {
              log("spawnReplacement failed, letting exit handler respawn");
            }
            setTimeout(() => process.exit(0), 500);
          } else {
            logLifecycle("update_failed", `Update failed from v${currentVersion}`);
            await flushRemoteLogs();
          }
        }, 1000);
        return;
      }
      case "start_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const rawAgentType = parsed.agent_type;
        const agentType = rawAgentType === "codex" || rawAgentType === "gemini" ? rawAgentType : "claude";
        const rawPath = parsed.project_path || process.env.HOME || "/tmp";
        const conversationId = parsed.conversation_id;
        const isolated = parsed.isolated === true;
        const worktreeName = parsed.worktree_name;
        const shortId = Math.random().toString(36).slice(2, 8);
        const tmuxSession = `cc-${agentType}-${shortId}`;
        let cwd = validatePath(rawPath) || validatePath(process.env.HOME || "/tmp") || "/tmp";
        let worktreeResult = null;
        if (isolated && cwd) {
          const gitRoot = (() => {
            try {
              return execSync2("git rev-parse --show-toplevel", {
                cwd,
                encoding: "utf-8",
                stdio: ["pipe", "pipe", "ignore"]
              }).trim();
            } catch {
              return null;
            }
          })();
          if (gitRoot) {
            const wtName = worktreeName || `session-${shortId}`;
            worktreeResult = createWorktree(gitRoot, wtName);
            if (worktreeResult) {
              cwd = worktreeResult.worktreePath;
              log(`[WORKTREE] Created isolated worktree: ${worktreeResult.worktreeName} at ${cwd}`);
            } else {
              log(`[WORKTREE] Failed to create worktree, falling back to repo root`);
            }
          }
        }
        let binary;
        let binaryArgs = [];
        if (agentType === "codex") {
          binary = "codex";
          const extraArgs = config.codex_args || "";
          if (extraArgs)
            binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
            if (!config.codex_args && !config.agent_permission_modes?.codex) {
              const flagFile = path13.join(CONFIG_DIR5, ".codex-bypass-notified");
              if (!fs14.existsSync(flagFile)) {
                fs14.writeFileSync(flagFile, new Date().toISOString());
                if (conversationId) {
                  syncService.createSessionNotification({
                    conversation_id: conversationId,
                    type: "info",
                    title: "Codex running in full-access mode",
                    message: "Codex is running without permission prompts by default. Configure with: cast config codex_args"
                  }).catch(() => {
                  });
                }
              }
            }
          }
        } else if (agentType === "gemini") {
          binary = "gemini";
        } else {
          binary = "claude";
          const extraArgs = config.claude_args || "";
          if (extraArgs)
            binaryArgs.push(...extraArgs.split(/\s+/).filter(Boolean));
          const permFlags = getPermissionFlags(agentType, config);
          if (permFlags && !extraArgs.includes("--dangerously-skip-permissions") && !extraArgs.includes("--permission-mode")) {
            binaryArgs.push(...permFlags.split(/\s+/).filter(Boolean));
          }
        }
        binaryArgs = sanitizeBinaryArgs(binaryArgs);
        const envPrefix = worktreeResult ? `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT AGENT_RESOURCE_INDEX=${worktreeResult.portIndex}` : `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT`;
        const cmdText = `${envPrefix} ${[binary, ...binaryArgs].join(" ")}`;
        if (!hasTmux()) {
          error = "tmux is not installed";
          break;
        }
        try {
          tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", cmdText], { timeout: 5000 });
          tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
          const resultObj = { tmux_session: tmuxSession, agent_type: agentType, project_path: cwd };
          if (worktreeResult) {
            resultObj.worktree_name = worktreeResult.worktreeName;
            resultObj.worktree_branch = worktreeResult.worktreeBranch;
            resultObj.worktree_path = worktreeResult.worktreePath;
            resultObj.port_index = worktreeResult.portIndex;
          }
          result = JSON.stringify(resultObj);
          log(`[REMOTE] Started ${agentType} session in tmux: ${tmuxSession} (cwd: ${cwd})`);
          if (conversationId) {
            startedSessionTmux.set(conversationId, {
              tmuxSession,
              projectPath: cwd,
              startedAt: Date.now(),
              agentType,
              worktreeName: worktreeResult?.worktreeName,
              worktreeBranch: worktreeResult?.worktreeBranch,
              worktreePath: worktreeResult?.worktreePath
            });
            log(`[REMOTE] Registered started session tmux for conversation ${conversationId.slice(0, 12)}`);
            if (agentType === "claude") {
              discoverAndLinkSession(conversationId, tmuxSession, cwd).catch((err) => {
                log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
              });
            }
          }
        } catch (spawnErr) {
          error = `Failed to start session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
          log(`[REMOTE] start_session error: ${error}`);
        }
        break;
      }
      case "escape": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          await new Promise((resolve4) => setTimeout(resolve4, 500));
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
          result = "escape_sent";
          log(`[REMOTE] Sent Escape+Enter to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          try {
            process.kill(proc.pid, "SIGINT");
            result = "escape_sent_sigint";
            log(`[REMOTE] Sent SIGINT to session ${sessionId.slice(0, 8)} pid=${proc.pid}`);
          } catch (killErr) {
            error = `Failed to send SIGINT to pid ${proc.pid}: ${killErr}`;
          }
        }
        break;
      }
      case "rewind": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const stepsBack = parsed.steps_back;
        if (!conversationId || stepsBack === undefined || stepsBack < 1) {
          error = "Missing conversation_id or invalid steps_back";
          break;
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const agentType = detectSessionAgentType(sessionId);
        if (agentType !== "claude") {
          error = `Rewind not yet supported for ${agentType} sessions`;
          break;
        }
        const proc = await findSessionProcess(sessionId, agentType);
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (!tmuxTarget || !validateTmuxTarget(tmuxTarget)) {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const safeSteps = Math.min(Math.max(1, Math.floor(Number(stepsBack))), 50);
        const PROMPT_RE = /[❯›]/;
        const PROMPT_EMPTY_RE = /[❯›]\s*(\n|$)/;
        const BUSY_RE = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|Wandering|Vibing|Coasting|Working|thinking/;
        const captureLast = async () => {
          const { stdout } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-8"]);
          return stdout.split(`
`).slice(-10).join(`
`);
        };
        const isAtPrompt = async () => {
          const last = await captureLast();
          return PROMPT_RE.test(last) && !BUSY_RE.test(last);
        };
        const hasEmptyPrompt = async () => {
          const last = await captureLast();
          return PROMPT_EMPTY_RE.test(last);
        };
        if (!await isAtPrompt()) {
          log(`[REWIND] Session not at prompt, sending Escape`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          let gotPrompt = false;
          for (let i = 0;i < 60; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (await isAtPrompt()) {
              gotPrompt = true;
              break;
            }
          }
          if (!gotPrompt) {
            error = "Timed out waiting for prompt after interrupt";
            break;
          }
          log(`[REWIND] Got prompt after interrupt`);
        }
        for (let attempt = 0;attempt < 3; attempt++) {
          if (await hasEmptyPrompt())
            break;
          log(`[REWIND] Clearing existing prompt text (attempt ${attempt + 1})`);
          await tmuxExec(["send-keys", "-t", tmuxTarget, "Escape"]);
          await new Promise((r) => setTimeout(r, 500));
        }
        log(`[REWIND] Sending ${safeSteps} Up arrows`);
        const upKeys = Array.from({ length: safeSteps }, () => "Up");
        await tmuxExec(["send-keys", "-t", tmuxTarget, ...upKeys]);
        await new Promise((r) => setTimeout(r, 300));
        if (await hasEmptyPrompt()) {
          log(`[REWIND] Prompt still empty after Up arrows, no history at position ${safeSteps}`);
          error = `No message found at history position ${safeSteps}`;
          break;
        }
        log(`[REWIND] Submitting rewind`);
        await tmuxExec(["send-keys", "-t", tmuxTarget, "Enter"]);
        result = "rewind_sent";
        log(`[REWIND] Rewind ${stepsBack} steps sent to session ${sessionId.slice(0, 8)}`);
        break;
      }
      case "send_keys": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        const keys = parsed.keys;
        if (!conversationId || !keys) {
          error = "Missing conversation_id or keys";
          break;
        }
        const ALLOWED_KEYS = new Set(["BTab", "Escape", "Enter", "Tab", "Up", "Down", "Left", "Right", "Space", "BSpace"]);
        const keyList = keys.split(" ");
        const invalidKey = keyList.find((k) => !ALLOWED_KEYS.has(k));
        if (invalidKey) {
          error = `Key '${invalidKey}' not in allowlist`;
          break;
        }
        let sessionId;
        {
          const cache = readConversationCache();
          const reverse = buildReverseConversationCache(cache);
          sessionId = reverse[conversationId];
        }
        if (!sessionId) {
          for (let i = 0;i < 10; i++) {
            await new Promise((r) => setTimeout(r, 500));
            const freshCache = readConversationCache();
            const freshReverse = buildReverseConversationCache(freshCache);
            sessionId = freshReverse[conversationId];
            if (sessionId)
              break;
          }
        }
        if (!sessionId) {
          error = `No session found for conversation ${conversationId}`;
          break;
        }
        const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
        if (!proc) {
          error = `No running process for session ${sessionId.slice(0, 8)}`;
          break;
        }
        const tmuxTarget = await findTmuxPaneForTty(proc.tty);
        if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
          const groups = [];
          for (const k of keyList) {
            if (k === "Escape" || k === "Enter" || groups.length > 0 && k !== groups[groups.length - 1][0]) {
              groups.push([k]);
            } else if (groups.length === 0) {
              groups.push([k]);
            } else {
              groups[groups.length - 1].push(k);
            }
          }
          for (let i = 0;i < groups.length; i++) {
            if (i > 0) {
              const prevKey = groups[i - 1][0];
              const needsDelay = prevKey === "Escape" || prevKey === "Enter";
              await new Promise((r) => setTimeout(r, needsDelay ? 600 : 150));
            }
            await tmuxExec(["send-keys", "-t", tmuxTarget, ...groups[i]]);
          }
          result = "keys_sent";
          log(`[REMOTE] Sent ${keys} (${groups.length} groups) to session ${sessionId.slice(0, 8)} via tmux ${tmuxTarget}`);
        } else {
          error = `No tmux pane found for session ${sessionId.slice(0, 8)}`;
        }
        break;
      }
      case "kill_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const conversationId = parsed.conversation_id;
        if (!conversationId) {
          error = "Missing conversation_id";
          break;
        }
        const started = startedSessionTmux.get(conversationId);
        if (started && validateTmuxTarget(started.tmuxSession)) {
          try {
            await tmuxExec(["kill-session", "-t", started.tmuxSession]);
            log(`[REMOTE] Killed started tmux session ${started.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
          } catch {
          }
          startedSessionTmux.delete(conversationId);
          result = "killed_tmux";
        }
        const cache = readConversationCache();
        const reverse = buildReverseConversationCache(cache);
        const sessionId = reverse[conversationId];
        if (sessionId && !result) {
          const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
          if (proc) {
            const tmuxTarget = await findTmuxPaneForTty(proc.tty);
            if (tmuxTarget && validateTmuxTarget(tmuxTarget)) {
              const tmuxSessionName = tmuxTarget.split(":")[0];
              try {
                await tmuxExec(["kill-session", "-t", tmuxSessionName]);
                log(`[REMOTE] Killed tmux session ${tmuxSessionName} for conversation ${conversationId.slice(0, 12)}`);
                result = "killed_tmux";
              } catch {
                try {
                  process.kill(proc.pid, "SIGKILL");
                  result = "killed_sigkill";
                  log(`[REMOTE] Sent SIGKILL to pid ${proc.pid} for conversation ${conversationId.slice(0, 12)}`);
                } catch (killErr) {
                  error = `Failed to kill pid ${proc.pid}: ${killErr}`;
                }
              }
            } else {
              try {
                process.kill(proc.pid, "SIGKILL");
                result = "killed_sigkill";
                log(`[REMOTE] Sent SIGKILL to pid ${proc.pid} for conversation ${conversationId.slice(0, 12)}`);
              } catch (killErr) {
                error = `Failed to kill pid ${proc.pid}: ${killErr}`;
              }
            }
          }
        }
        if (sessionId) {
          const cachedTmux = resumeSessionCache.get(sessionId);
          if (cachedTmux && validateTmuxTarget(cachedTmux)) {
            try {
              await tmuxExec(["kill-session", "-t", cachedTmux]);
              log(`[REMOTE] Killed cached resume tmux ${cachedTmux} for session ${sessionId.slice(0, 8)}`);
            } catch {
            }
            resumeSessionCache.delete(sessionId);
            if (!result)
              result = "killed_tmux";
          }
          const hbInterval = resumeHeartbeatIntervals.get(sessionId);
          if (hbInterval) {
            clearInterval(hbInterval);
            resumeHeartbeatIntervals.delete(sessionId);
          }
          stopCodexPermissionPoller(sessionId);
          sessionProcessCache.delete(sessionId);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);
          const shortId = sessionId.slice(0, 8);
          try {
            const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
            for (const tmuxName of tmuxList.trim().split(`
`)) {
              if (!tmuxName || !tmuxName.includes(shortId))
                continue;
              if (!validateTmuxTarget(tmuxName))
                continue;
              const alive = await isTmuxAgentAlive(tmuxName);
              if (!alive) {
                try {
                  await tmuxExec(["kill-session", "-t", tmuxName]);
                  log(`[REMOTE] Killed zombie tmux session ${tmuxName} for session ${shortId}`);
                  if (!result)
                    result = "killed_zombie";
                } catch {
                }
              }
            }
          } catch {
          }
        }
        if (!result)
          result = sessionId ? "no_process" : "no_session";
        break;
      }
      case "resume_session": {
        const parsed = commandArgs ? JSON.parse(commandArgs) : {};
        const sessionId = parsed.session_id;
        const conversationId = parsed.conversation_id;
        if (!sessionId) {
          error = "Missing session_id";
          break;
        }
        const projectPath = parsed.project_path;
        if (resumeInFlight.has(sessionId)) {
          log(`[REMOTE] Resume already in flight for ${sessionId.slice(0, 8)}, skipping`);
          result = JSON.stringify({ skipped: true, reason: "resume_in_flight" });
          break;
        }
        restartingSessionIds.set(sessionId, Date.now());
        log(`[REMOTE] Force-resuming session ${sessionId.slice(0, 8)}${projectPath ? ` in ${projectPath}` : ""}`);
        let resumed = await autoResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
        if (!resumed) {
          log(`[REMOTE] Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
          resumed = await repairAndResumeSession(sessionId, "", readTitleCache(), false, projectPath, conversationId);
        }
        if (resumed) {
          if (conversationId) {
            const cache = readConversationCache();
            cache[sessionId] = conversationId;
            saveConversationCache(cache);
            if (syncServiceRef) {
              syncServiceRef.markSessionActive(conversationId).catch(() => {
              });
              syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {
              });
            }
          }
          restartingSessionIds.delete(sessionId);
          result = JSON.stringify({ resumed: true, session_id: sessionId });
          log(`[REMOTE] Force-resume succeeded for ${sessionId.slice(0, 8)}`);
        } else if (conversationId && projectPath) {
          log(`[REMOTE] Resume failed for ${sessionId.slice(0, 8)}, reconstituting session from DB...`);
          const cwd = fs14.existsSync(projectPath) ? projectPath : process.env.HOME || "/tmp";
          let reconstituted = false;
          if (config?.convex_url && config?.auth_token) {
            try {
              const siteUrl2 = config.convex_url.replace(".cloud", ".site");
              const exportData = await fetchExport(siteUrl2, config.auth_token, conversationId);
              if (exportData.messages.length > 0) {
                const TOKEN_BUDGET = 1e5;
                const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
                const { jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId });
                const newSessionId2 = writeClaudeCodeSession(jsonl, sessionId, projectPath);
                log(`[REMOTE] Reconstituted JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} msgs, tail=${tailMessages})`);
                const reconResumed = await autoResumeSession(newSessionId2, "", readTitleCache(), false, cwd, conversationId);
                if (reconResumed) {
                  const cache = readConversationCache();
                  cache[newSessionId2] = conversationId;
                  saveConversationCache(cache);
                  if (syncServiceRef) {
                    syncServiceRef.markSessionActive(conversationId).catch(() => {
                    });
                    syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {
                    });
                  }
                  restartingSessionIds.delete(sessionId);
                  result = JSON.stringify({ reconstituted: true, session_id: newSessionId2 });
                  log(`[REMOTE] Reconstituted + resumed session ${sessionId.slice(0, 8)}`);
                  reconstituted = true;
                }
              }
            } catch (reconErr) {
              log(`[REMOTE] Reconstitution failed for ${sessionId.slice(0, 8)}: ${reconErr instanceof Error ? reconErr.message : String(reconErr)}`);
            }
          }
          if (!reconstituted) {
            log(`[REMOTE] Starting blank session in ${projectPath}`);
            const shortId = Math.random().toString(36).slice(2, 8);
            const tmuxSession = `cc-claude-${shortId}`;
            let extraFlags = config.claude_args || "";
            const blankArgs = extraFlags ? extraFlags.split(/\s+/).filter(Boolean) : [];
            const safeBlankArgs = sanitizeBinaryArgs(blankArgs);
            const blankCmdText = `env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT ${["claude", ...safeBlankArgs].join(" ")}`;
            try {
              tmuxExecSync(["new-session", "-d", "-s", tmuxSession, "-c", cwd], { timeout: 5000 });
              tmuxExecSync(["send-keys", "-t", tmuxSession, "-l", blankCmdText], { timeout: 5000 });
              tmuxExecSync(["send-keys", "-t", tmuxSession, "Enter"], { timeout: 5000 });
              startedSessionTmux.set(conversationId, {
                tmuxSession,
                projectPath: cwd,
                startedAt: Date.now(),
                agentType: "claude"
              });
              discoverAndLinkSession(conversationId, tmuxSession, cwd).catch((err) => {
                log(`Session discovery failed for ${conversationId.slice(0, 12)}: ${err}`);
              });
              result = JSON.stringify({ started_fresh: true, tmux_session: tmuxSession });
              log(`[REMOTE] Started fresh session ${tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
            } catch (spawnErr) {
              error = `Failed to start fresh session: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
            }
          }
        } else {
          error = `Failed to resume session ${sessionId.slice(0, 8)} — session file may not exist locally`;
        }
        break;
      }
      default:
        error = `Unknown command: ${command}`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  try {
    await fetch(`${siteUrl}/cli/command-result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        command_id: commandId,
        result,
        error
      })
    });
  } catch {
  }
}
async function flushRemoteLogs() {
  await flushRemoteLogsViaHttp();
}
function ensureConfigDir3() {
  if (!fs14.existsSync(CONFIG_DIR5)) {
    fs14.mkdirSync(CONFIG_DIR5, { recursive: true, mode: 448 });
  }
}
function readConfig() {
  if (!fs14.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    return JSON.parse(fs14.readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}
function patchConfig(updates) {
  const config = readConfig();
  if (!config)
    return;
  Object.assign(config, updates);
  fs14.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 384 });
}
function readConversationCache() {
  const cacheFile = path13.join(CONFIG_DIR5, "conversations.json");
  if (!fs14.existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(fs14.readFileSync(cacheFile, "utf-8"));
  } catch {
    return {};
  }
}
function saveConversationCache(cache) {
  const cacheFile = path13.join(CONFIG_DIR5, "conversations.json");
  fs14.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}
function readTitleCache() {
  const cacheFile = path13.join(CONFIG_DIR5, "titles.json");
  if (!fs14.existsSync(cacheFile)) {
    return {};
  }
  try {
    return JSON.parse(fs14.readFileSync(cacheFile, "utf-8"));
  } catch {
    return {};
  }
}
function saveTitleCache(cache) {
  const cacheFile = path13.join(CONFIG_DIR5, "titles.json");
  fs14.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
}
function generateTitleFromMessage(content) {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }
  const cmdNameMatch = trimmed.match(/<command-name>([^<]*)<\/command-name>/);
  if (cmdNameMatch)
    return `/${cmdNameMatch[1].replace(/^\//, "")}`;
  const cmdMsgMatch = trimmed.match(/<command-message>([^<]*)<\/command-message>/);
  if (cmdMsgMatch)
    return `/${cmdMsgMatch[1].replace(/^\//, "")}`;
  const cleaned = trimmed.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, "").replace(/<[^>]+>/g, "").trim();
  const result = cleaned || trimmed;
  if (result.length <= 50) {
    return result;
  }
  return result.slice(0, 50) + "...";
}
function readDaemonState() {
  if (!fs14.existsSync(STATE_FILE)) {
    return {};
  }
  try {
    return JSON.parse(fs14.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}
function saveDaemonState(updates) {
  try {
    const current = readDaemonState();
    const newState = { ...current, ...updates, timestamp: Date.now() };
    fs14.writeFileSync(STATE_FILE, JSON.stringify(newState, null, 2), { mode: 384 });
  } catch (err) {
    log(`Failed to write daemon state: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function handleAuthFailure() {
  const state = readDaemonState();
  const currentCount = (state.authFailureCount || 0) + 1;
  if (currentCount >= AUTH_FAILURE_THRESHOLD) {
    logError(`Auth failed ${currentCount} times consecutively - marking auth as expired`);
    saveDaemonState({ authExpired: true, authFailureCount: currentCount });
    return true;
  }
  log(`Auth failure ${currentCount}/${AUTH_FAILURE_THRESHOLD} - will retry`);
  saveDaemonState({ authFailureCount: currentCount });
  return false;
}
function resetAuthFailureCount() {
  const state = readDaemonState();
  if (state.authFailureCount && state.authFailureCount > 0) {
    saveDaemonState({ authFailureCount: 0 });
  }
}
function isPathExcluded(projectPath, excludedPaths) {
  if (!excludedPaths || !projectPath) {
    return false;
  }
  const paths = excludedPaths.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  for (const excludedPath of paths) {
    const normalizedExcluded = path13.resolve(excludedPath);
    const normalizedProject = path13.resolve(projectPath);
    if (normalizedProject.startsWith(normalizedExcluded)) {
      return true;
    }
  }
  return false;
}
function isProjectAllowedToSync(projectPath, config) {
  if (!config.sync_mode || config.sync_mode === "all") {
    return true;
  }
  if (!config.sync_projects || config.sync_projects.length === 0) {
    return false;
  }
  const normalizedProject = path13.resolve(projectPath);
  return config.sync_projects.some((allowed) => {
    const normalizedAllowed = path13.resolve(allowed);
    return normalizedProject === normalizedAllowed || normalizedProject.startsWith(normalizedAllowed + path13.sep);
  });
}
function getGitInfo(projectPath) {
  const execGit = (args) => {
    try {
      return execSync2(`git ${args}`, {
        cwd: projectPath,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024
      }).trim();
    } catch {
      return;
    }
  };
  const commitHash = execGit("rev-parse HEAD");
  if (!commitHash) {
    return;
  }
  const branch = execGit("rev-parse --abbrev-ref HEAD");
  const remoteUrl = execGit("remote get-url origin");
  const status = execGit("status --porcelain");
  const diff = execGit("diff");
  const diffStaged = execGit("diff --cached");
  const root = execGit("rev-parse --show-toplevel");
  const worktreeMatch = projectPath.match(/\.codecast\/worktrees\/([^/]+)/);
  const worktreeName = worktreeMatch ? worktreeMatch[1] : undefined;
  return {
    commitHash,
    branch,
    remoteUrl,
    status,
    diff: diff ? diff.slice(0, 1e5) : undefined,
    diffStaged: diffStaged ? diffStaged.slice(0, 1e5) : undefined,
    root,
    worktreeName,
    worktreeBranch: worktreeName ? branch : undefined,
    worktreePath: worktreeName ? projectPath : undefined
  };
}
var CODECAST_WORKTREE_DIR = ".codecast/worktrees";
function createWorktree(repoRoot, name) {
  const worktreeDir = path13.join(repoRoot, CODECAST_WORKTREE_DIR);
  const worktreePath = path13.join(worktreeDir, name);
  const branchName = `codecast/${name}`;
  if (fs14.existsSync(worktreePath)) {
    const existingBranch = (() => {
      try {
        return execSync2(`git rev-parse --abbrev-ref HEAD`, {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "ignore"]
        }).trim();
      } catch {
        return branchName;
      }
    })();
    return {
      worktreePath,
      worktreeName: name,
      worktreeBranch: existingBranch,
      portIndex: assignPortIndex(repoRoot)
    };
  }
  try {
    fs14.mkdirSync(worktreeDir, { recursive: true });
    execSync2(`git worktree add -b ${branchName} ${worktreePath}`, {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"]
    });
  } catch (err) {
    try {
      execSync2(`git worktree add ${worktreePath} ${branchName}`, {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      log(`[WORKTREE] Failed to create worktree: ${err}`);
      return null;
    }
  }
  copySetupFiles(repoRoot, worktreePath);
  return {
    worktreePath,
    worktreeName: name,
    worktreeBranch: branchName,
    portIndex: assignPortIndex(repoRoot)
  };
}
function assignPortIndex(repoRoot) {
  const worktreeDir = path13.join(repoRoot, CODECAST_WORKTREE_DIR);
  if (!fs14.existsSync(worktreeDir))
    return 0;
  const existing = fs14.readdirSync(worktreeDir).filter((f) => {
    try {
      return fs14.statSync(path13.join(worktreeDir, f)).isDirectory();
    } catch {
      return false;
    }
  });
  return Math.min(existing.length - 1, 9);
}
function copySetupFiles(mainRoot, worktreePath) {
  const configFile = path13.join(mainRoot, ".wt-setup-files");
  const patterns = fs14.existsSync(configFile) ? fs14.readFileSync(configFile, "utf-8").split(`
`).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [".env", ".env.local"];
  for (const pattern of patterns) {
    const src = path13.join(mainRoot, pattern);
    const dest = path13.join(worktreePath, pattern);
    if (!fs14.existsSync(src) || fs14.existsSync(dest))
      continue;
    try {
      const destDir = path13.dirname(dest);
      fs14.mkdirSync(destDir, { recursive: true });
      if (fs14.statSync(src).isDirectory()) {
        execSync2(`cp -r ${JSON.stringify(src)} ${JSON.stringify(dest)}`, { stdio: "ignore" });
      } else {
        fs14.copyFileSync(src, dest);
      }
    } catch {
    }
  }
}
function decodeProjectDirName(dirName) {
  const stripped = dirName.startsWith("-") ? dirName.slice(1) : dirName;
  const tokens = stripped.split("-");
  let resolved = "/";
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "") {
      i++;
      continue;
    }
    let matched = false;
    for (let len = tokens.length - i;len >= 1; len--) {
      const candidate = tokens.slice(i, i + len).join("-");
      if (fs14.existsSync(path13.join(resolved, candidate))) {
        resolved = path13.join(resolved, candidate);
        i += len;
        matched = true;
        break;
      }
      if (fs14.existsSync(path13.join(resolved, "." + candidate))) {
        resolved = path13.join(resolved, "." + candidate);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) {
      resolved = path13.join(resolved, tokens[i]);
      i++;
    }
  }
  return resolved;
}
async function flushPendingMessagesBatch(pendingMsgs, conversationId, syncService2, retryQueue) {
  try {
    await syncService2.addMessages({
      conversationId,
      messages: pendingMsgs.map((msg) => ({
        messageUuid: msg.uuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype
      }))
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Batch pending flush failed, queueing individually: ${errMsg}`);
    for (const msg of pendingMsgs) {
      retryQueue.add("addMessage", {
        conversationId,
        messageUuid: msg.uuid,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        thinking: msg.thinking,
        toolCalls: msg.toolCalls,
        toolResults: msg.toolResults,
        images: msg.images,
        subtype: msg.subtype
      }, errMsg);
    }
  }
}
function mapRole(role) {
  return role === "user" ? "human" : role === "system" ? "system" : "assistant";
}
function prepMessageForSync(msg) {
  return {
    messageUuid: msg.uuid,
    role: mapRole(msg.role),
    content: redactSecrets(msg.content),
    timestamp: msg.timestamp,
    thinking: msg.thinking,
    toolCalls: msg.toolCalls,
    toolResults: msg.toolResults,
    images: msg.images,
    subtype: msg.subtype
  };
}
async function syncMessagesBatch(messages, conversationId, syncService2, retryQueue) {
  try {
    await syncService2.addMessages({
      conversationId,
      messages: messages.map(prepMessageForSync)
    });
    resetAuthFailureCount();
    return { authExpired: false, conversationNotFound: false };
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      if (handleAuthFailure()) {
        return { authExpired: true, conversationNotFound: false };
      }
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("Conversation not found")) {
      return { authExpired: false, conversationNotFound: true };
    }
    log(`Batch sync failed, queueing individually: ${errMsg}`);
    for (const msg of messages) {
      const prepped = prepMessageForSync(msg);
      retryQueue.add("addMessage", {
        conversationId,
        ...prepped
      }, errMsg);
    }
    return { authExpired: false, conversationNotFound: false };
  }
}
function readFileHead(filePath, maxBytes = 8192) {
  const fd = fs14.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs14.readSync(fd, buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs14.closeSync(fd);
  }
}
function readFileTail(filePath, maxBytes = 8192) {
  const stat4 = fs14.statSync(filePath);
  const fd = fs14.openSync(filePath, "r");
  try {
    const offset = Math.max(0, stat4.size - maxBytes);
    const buf = Buffer.alloc(Math.min(maxBytes, stat4.size));
    const bytesRead = fs14.readSync(fd, buf, 0, buf.length, offset);
    return buf.slice(0, bytesRead).toString("utf-8");
  } finally {
    fs14.closeSync(fd);
  }
}
async function processSessionFile(filePath, sessionId, projectPath, syncService2, userId, teamId, conversationCache, retryQueue, pendingMessages, titleCache, updateStateCallback, parentConversationId) {
  let lastPosition = getPosition(filePath);
  let stats;
  try {
    stats = fs14.statSync(filePath);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }
  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }
  if (stats.size <= lastPosition) {
    return;
  }
  const bytesToRead = stats.size - lastPosition;
  let fd;
  try {
    fd = fs14.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs14.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs14.closeSync(fd);
    const newContent = buffer.toString("utf-8");
    let messages = parseSessionFile(newContent);
    if (permissionJustResolved.has(sessionId)) {
      const before = messages.length;
      messages = messages.filter((m) => !(m.role === "user" && /^[yn]$/i.test(m.content?.trim())));
      if (messages.length < before) {
        log(`Filtered ${before - messages.length} permission response message(s) for session ${sessionId.slice(0, 8)}`);
      }
      permissionJustResolved.delete(sessionId);
    }
    let conversationId = conversationCache[sessionId];
    if (conversationId) {
      let titleContent;
      try {
        titleContent = newContent + `
` + readFileTail(filePath, 4096);
      } catch (err) {
        if (err.code === "EACCES" || err.code === "EPERM") {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService2.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }
      if (!planHandoffChecked.has(sessionId)) {
        planHandoffChecked.add(sessionId);
        let headContent;
        try {
          headContent = readFileHead(filePath, 16384);
        } catch {
          headContent = "";
        }
        const headMessages = parseSessionFile(headContent);
        const userMsgs = headMessages.filter((m) => m.role === "user").slice(0, 3);
        for (const msg of userMsgs) {
          if (!msg.content)
            continue;
          const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
          if (handoffMatch) {
            const jsonlPath = handoffMatch[1];
            const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (parentSessionMatch) {
              const parentSessionId = parentSessionMatch[1];
              const parentConvId = conversationCache[parentSessionId];
              if (parentConvId) {
                try {
                  await syncService2.linkPlanHandoff(parentConvId, conversationId);
                  planHandoffChildren.set(parentConvId, conversationId);
                  log(`Retroactive plan handoff: linked ${sessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                } catch (err) {
                  log(`Failed retroactive plan handoff link: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
            break;
          }
        }
      }
    }
    if (messages.length === 0) {
      setPosition(filePath, stats.size);
      return;
    }
    if (!conversationId) {
      let headContent;
      try {
        headContent = readFileHead(filePath, 16384);
      } catch (err) {
        if (err.code === "EACCES" || err.code === "EPERM") {
          log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
          return;
        }
        throw err;
      }
      try {
        const slug = extractSlug(headContent);
        const parentMessageUuid = extractParentUuid(headContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        const dirName = path13.basename(path13.dirname(filePath));
        const decodedPath = dirName ? decodeProjectDirName(dirName) : undefined;
        const actualProjectPath = (decodedPath && fs14.existsSync(decodedPath) ? decodedPath : null) || extractCwd(headContent) || projectPath;
        const gitInfo = actualProjectPath ? getGitInfo(actualProjectPath) : undefined;
        const firstUserMessage = messages.find((msg) => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        let isPlanHandoff = false;
        if (!parentConversationId) {
          const parts = filePath.split(path13.sep);
          const isSubagentFile = parts.includes("subagents");
          if (isSubagentFile) {
            const subagentsIdx = parts.lastIndexOf("subagents");
            const parentSessionId = parts[subagentsIdx - 1];
            if (parentSessionId && conversationCache[parentSessionId]) {
              parentConversationId = conversationCache[parentSessionId];
              log(`Detected subagent parent for ${sessionId}: ${parentConversationId}`);
            } else if (parentSessionId) {
              pendingSubagentParents.set(sessionId, parentSessionId);
              log(`Subagent ${sessionId} parent ${parentSessionId} not cached yet, queued for linking`);
            }
          }
        }
        if (!parentConversationId) {
          const userMessages = messages.filter((msg) => msg.role === "user").slice(0, 3);
          for (const msg of userMessages) {
            if (!msg.content)
              continue;
            const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
            if (handoffMatch) {
              const jsonlPath = handoffMatch[1];
              const parentSessionMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
              if (parentSessionMatch) {
                const parentSessionId = parentSessionMatch[1];
                if (conversationCache[parentSessionId]) {
                  parentConversationId = conversationCache[parentSessionId];
                  isPlanHandoff = true;
                  log(`Detected plan handoff parent for ${sessionId}: ${parentConversationId} (from ${parentSessionId})`);
                }
              }
              break;
            }
          }
        }
        let matchedStartedConversation = null;
        if (startedSessionTmux.size > 0) {
          const startedClaudeEntries = Array.from(startedSessionTmux.entries()).filter(([, entry]) => entry.agentType === "claude");
          const proc = await findSessionProcess(sessionId, "claude").catch(() => null);
          let tmuxSessionName = null;
          if (proc) {
            tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
            if (!tmuxSessionName) {
              const tmuxPane = await findTmuxPaneForTty(proc.tty);
              if (tmuxPane) {
                tmuxSessionName = tmuxPane.split(":")[0];
                cacheSessionProcess(sessionId, proc, tmuxPane);
              }
            }
          }
          matchedStartedConversation = matchStartedConversation(startedClaudeEntries, {
            tmuxSessionName,
            projectPath: actualProjectPath
          });
          if (matchedStartedConversation && tmuxSessionName) {
            log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
          } else if (matchedStartedConversation && actualProjectPath) {
            log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
          } else {
            matchedStartedConversation = matchSingleFreshStartedConversation(startedClaudeEntries);
            if (matchedStartedConversation) {
              log(`Matched session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via fresh-start fallback`);
            }
          }
        }
        if (matchedStartedConversation) {
          conversationId = matchedStartedConversation;
          const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          syncService2.updateSessionId(conversationId, sessionId).catch(() => {
          });
          if (tmuxEntry) {
            syncService2.registerManagedSession(sessionId, process.pid, tmuxEntry.tmuxSession, conversationId).catch(() => {
            });
          }
          startedSessionTmux.delete(matchedStartedConversation);
          log(`Linked session ${sessionId} to existing started conversation ${conversationId}`);
        } else {
          const cliFlags = detectCliFlags(headContent + `
` + newContent);
          conversationId = await syncService2.createConversation({
            userId,
            teamId,
            sessionId,
            agentType: "claude_code",
            projectPath: actualProjectPath,
            slug,
            title,
            startedAt: firstMessageTimestamp,
            parentMessageUuid: isPlanHandoff ? "plan-handoff" : parentConversationId ? undefined : parentMessageUuid,
            parentConversationId,
            gitInfo,
            cliFlags: cliFlags || undefined
          });
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          if (isPlanHandoff && parentConversationId) {
            planHandoffChildren.set(parentConversationId, conversationId);
            log(`Registered plan handoff: parent ${parentConversationId.slice(0, 12)} -> child ${conversationId.slice(0, 12)}`);
          }
          log(`Created conversation ${conversationId} for session ${sessionId}`);
          syncStats.conversationsCreated++;
          findSessionProcess(sessionId, "claude").then((proc) => {
            if (!proc)
              return;
            findTmuxPaneForTty(proc.tty).then((tmuxPane) => {
              const tmuxSessionName = tmuxPane?.split(":")[0];
              syncService2.registerManagedSession(sessionId, proc.pid, tmuxSessionName, conversationId).catch(() => {
              });
              if (tmuxSessionName)
                log(`Registered managed session for ${sessionId.slice(0, 8)} (tmux: ${tmuxSessionName})`);
            }).catch(() => {
              syncService2.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(() => {
              });
            });
          }).catch(() => {
            syncService2.registerManagedSession(sessionId, process.pid, undefined, conversationId).catch(() => {
            });
          });
          for (const [childSessionId, parentSessionId] of pendingSubagentParents) {
            if (parentSessionId === sessionId) {
              const childConvId = conversationCache[childSessionId];
              if (childConvId) {
                syncService2.linkSessions(conversationId, childConvId).then(() => {
                  log(`Linked pending subagent ${childSessionId.slice(0, 8)} -> parent ${sessionId.slice(0, 8)}`);
                }).catch((err) => {
                  log(`Failed to link subagent ${childSessionId.slice(0, 8)}: ${err}`);
                });
                pendingSubagentParents.delete(childSessionId);
              }
            }
          }
        }
        if (global.activeSessions) {
          global.activeSessions.set(conversationId, {
            sessionId,
            conversationId,
            projectPath: actualProjectPath || ""
          });
        }
        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService2, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, stats.size);
            return;
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create conversation, queueing for retry: ${errMsg}`);
        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype
          });
        }
        let retryHeadContent;
        try {
          retryHeadContent = readFileHead(filePath, 16384);
        } catch (readErr) {
          if (readErr.code === "EACCES" || readErr.code === "EPERM") {
            log(`Warning: Permission denied reading ${filePath} for retry queue. Skipping.`);
            setPosition(filePath, stats.size);
            return;
          }
          throw readErr;
        }
        const slug = extractSlug(retryHeadContent);
        const firstMsgTimestamp = messages[0]?.timestamp;
        const retryDirName = path13.basename(path13.dirname(filePath));
        const retryDecoded = retryDirName ? decodeProjectDirName(retryDirName) : undefined;
        const retryProjectPath = (retryDecoded && fs14.existsSync(retryDecoded) ? retryDecoded : null) || extractCwd(retryHeadContent) || projectPath;
        const gitInfo = retryProjectPath ? getGitInfo(retryProjectPath) : undefined;
        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "claude_code",
          projectPath: retryProjectPath,
          slug,
          startedAt: firstMsgTimestamp,
          gitInfo
        }, errMsg);
        setPosition(filePath, stats.size);
        return;
      }
    }
    if (conversationId && (newContent.includes("ExitPlanMode") || newContent.includes("TaskCreate") || newContent.includes("TaskUpdate"))) {
      const lines = newContent.split(`
`);
      for (const line of lines) {
        if (!line.includes("ExitPlanMode") && !line.includes("TaskCreate") && !line.includes("TaskUpdate"))
          continue;
        try {
          const entry = JSON.parse(line);
          const msg = entry.message || entry;
          const blocks = Array.isArray(msg.content) ? msg.content : [];
          for (const block of blocks) {
            if (block.type !== "tool_use")
              continue;
            if (block.name === "ExitPlanMode" && block.input?.plan && !planModeSynced.has(sessionId)) {
              planModeSynced.add(sessionId);
              const dirName = path13.basename(path13.dirname(filePath));
              const projPath = dirName ? decodeProjectDirName(dirName) : undefined;
              try {
                const planShortId = await syncService2.syncPlanFromPlanMode({
                  sessionId,
                  planContent: block.input.plan,
                  projectPath: projPath
                });
                if (planShortId) {
                  planModePlanMap.set(sessionId, planShortId);
                  savePlanModeCache();
                }
                log(`Synced plan_mode plan ${planShortId} for session ${sessionId.slice(0, 8)} (${block.input.plan.length} chars)`);
              } catch (err) {
                log(`Failed to sync plan_mode: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (block.name === "TaskCreate" && block.input?.subject) {
              const taskMap = planModeTaskMap.get(sessionId) || new Map;
              const localId = String(taskMap.size + 1);
              try {
                const shortId = await syncService2.syncTaskFromPlanMode({
                  sessionId,
                  title: block.input.subject,
                  description: block.input.description,
                  planShortId: planModePlanMap.get(sessionId)
                });
                if (shortId) {
                  taskMap.set(localId, shortId);
                  planModeTaskMap.set(sessionId, taskMap);
                  savePlanModeCache();
                  log(`Synced task ${shortId} from TaskCreate in session ${sessionId.slice(0, 8)}: ${block.input.subject}`);
                }
              } catch (err) {
                log(`Failed to sync TaskCreate: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            if (block.name === "TaskUpdate" && block.input?.taskId && block.input?.status) {
              const taskMap = planModeTaskMap.get(sessionId);
              const shortId = taskMap?.get(String(block.input.taskId));
              if (shortId) {
                const status = block.input.status === "completed" ? "done" : block.input.status === "in_progress" ? "in_progress" : block.input.status;
                try {
                  await syncService2.updateTaskStatus(shortId, status, sessionId);
                  log(`Updated task ${shortId} -> ${status} in session ${sessionId.slice(0, 8)}`);
                } catch (err) {
                  log(`Failed to sync TaskUpdate: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
            }
          }
        } catch {
        }
      }
    }
    const batchResult = await syncMessagesBatch(messages, conversationId, syncService2, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);
      let recreateHeadContent;
      try {
        recreateHeadContent = readFileHead(filePath, 16384);
      } catch (readErr) {
        if (readErr.code === "EACCES" || readErr.code === "EPERM") {
          log(`Warning: Permission denied reading ${filePath} for conversation recreation. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw readErr;
      }
      const slug = extractSlug(recreateHeadContent);
      const firstMessageTimestamp = messages[0]?.timestamp;
      const recreateDirName = path13.basename(path13.dirname(filePath));
      const recreateDecoded = recreateDirName ? decodeProjectDirName(recreateDirName) : undefined;
      const recreateProjectPath = (recreateDecoded && fs14.existsSync(recreateDecoded) ? recreateDecoded : null) || extractCwd(recreateHeadContent) || projectPath;
      const gitInfo = recreateProjectPath ? getGitInfo(recreateProjectPath) : undefined;
      try {
        const firstUserMessage = messages.find((msg) => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "claude_code",
          projectPath: recreateProjectPath,
          slug,
          title,
          startedAt: firstMessageTimestamp,
          gitInfo
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for session ${sessionId}`);
        await syncService2.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync)
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
      }
    }
    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "claude");
    const lastMessage = messages[messages.length - 1];
    const wasInterrupted = lastMessage?.role === "user" && (lastMessage.content?.trim().startsWith("[Request interrupted") || lastMessage.content?.trim().startsWith("[Request cancelled"));
    const lastAssistantMessage = messages.filter((m) => m.role === "assistant").pop();
    if (lastAssistantMessage && conversationId) {
      const permissionPrompt = detectPermissionPrompt(lastAssistantMessage.content);
      if (permissionPrompt) {
        log(`Permission prompt detected for tool: ${permissionPrompt.tool_name}`);
        permissionJustResolved.add(sessionId);
        sendAgentStatus(syncService2, conversationId, sessionId, "permission_blocked");
        const permArgPreview = truncateForNotification(`${permissionPrompt.tool_name}: ${permissionPrompt.arguments_preview || ""}`, 150);
        syncService2.createSessionNotification({
          conversation_id: conversationId,
          type: "permission_request",
          title: `codecast - Permission needed`,
          message: permArgPreview
        }).catch(() => {
        });
        handlePermissionRequest(syncService2, conversationId, sessionId, permissionPrompt, log).then((decision) => {
          if (decision) {
            const response = decision.approved ? "y" : "n";
            log(`Attempting to inject response '${response}' to session ${sessionId.slice(0, 8)}`);
            findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
              if (!proc) {
                log("No process found for session");
                return;
              }
              findTmuxPaneForTty(proc.tty).then((tmuxTarget) => {
                if (tmuxTarget) {
                  injectViaTmux(tmuxTarget, response).then(() => {
                    log(`Injected '${response}' via tmux for session ${sessionId.slice(0, 8)}`);
                  }).catch(() => {
                    injectViaTerminal(proc.tty, response, proc.termProgram).then(() => {
                      log(`Injected '${response}' via iTerm2 for session ${sessionId.slice(0, 8)}`);
                    }).catch((err) => {
                      log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                    });
                  });
                } else {
                  injectViaTerminal(proc.tty, response, proc.termProgram).then(() => {
                    log(`Injected '${response}' via iTerm2 for session ${sessionId.slice(0, 8)}`);
                  }).catch((err) => {
                    log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                  });
                }
              });
            }).catch((err) => {
              log(`Failed to find Claude session: ${err instanceof Error ? err.message : String(err)}`);
            });
          } else {
            log("Permission request timed out or failed");
          }
        }).catch((err) => {
          log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      const errorText = detectErrorInMessage(lastAssistantMessage.content);
      if (errorText && !permissionPrompt) {
        const now = Date.now();
        const lastErr = lastErrorNotification.get(sessionId) ?? 0;
        if (now - lastErr > IDLE_COOLDOWN_MS) {
          lastErrorNotification.set(sessionId, now);
          syncService2.createSessionNotification({
            conversation_id: conversationId,
            type: "session_error",
            title: "codecast - Error",
            message: truncateForNotification(errorText)
          }).catch(() => {
          });
        }
      }
      if (!permissionPrompt) {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer)
          clearTimeout(existingTimer);
        const hookEntry = lastHookStatus.get(sessionId);
        const hookIsRecent = hookEntry && Date.now() / 1000 - hookEntry.ts < 30;
        if (!hookIsRecent) {
          sendAgentStatus(syncService2, conversationId, sessionId, "working");
        }
        const hasPendingToolCalls = (lastAssistantMessage.toolCalls?.length ?? 0) > 0 && !messages.some((m) => m.role === "assistant" && (m.toolResults?.length ?? 0) > 0 && m.timestamp >= lastAssistantMessage.timestamp);
        if (wasInterrupted) {
          idleTimers.delete(sessionId);
          lastIdleNotifiedSize.set(sessionId, stats.size);
        } else if (hasPendingToolCalls) {
          idleTimers.delete(sessionId);
        } else {
          const capturedFilePath = filePath;
          const capturedSize = stats.size;
          if (capturedSize === lastIdleNotifiedSize.get(sessionId)) {
          } else {
            idleTimers.set(sessionId, setTimeout(() => {
              idleTimers.delete(sessionId);
              try {
                const currentStats = fs14.statSync(capturedFilePath);
                if (currentStats.size !== capturedSize)
                  return;
              } catch {
                return;
              }
              const hookIdle = lastHookStatus.get(sessionId);
              if (hookIdle && Date.now() / 1000 - hookIdle.ts < 30)
                return;
              lastIdleNotifiedSize.set(sessionId, capturedSize);
              sendAgentStatus(syncService2, conversationId, sessionId, "idle");
              const preview = truncateForNotification(lastAssistantMessage.content);
              syncService2.createSessionNotification({
                conversation_id: conversationId,
                type: "session_idle",
                title: "Claude done",
                message: preview
              }).catch(() => {
              });
              log(`Sent idle notification for session ${sessionId.slice(0, 8)}`);
            }, IDLE_TIMEOUT_MS));
          }
        }
      }
    } else if (conversationId) {
      const existingTimer = idleTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        idleTimers.delete(sessionId);
      }
      lastIdleNotifiedSize.delete(sessionId);
    }
    updateStateCallback();
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }
}
async function processCursorSession(dbPath, sessionId, workspacePath, syncService2, userId, teamId, conversationCache, retryQueue, pendingMessages, updateStateCallback) {
  const syncedCount = getPosition(dbPath);
  let result;
  try {
    result = extractMessagesFromCursorDb(dbPath, syncedCount);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${dbPath}. Will retry when permissions are restored.`);
      return;
    }
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Failed to extract messages from Cursor DB: ${errMsg}`);
    return;
  }
  const { messages, totalCount } = result;
  if (messages.length === 0) {
    return;
  }
  let conversationId = conversationCache[sessionId];
  if (!conversationId) {
    try {
      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find((msg) => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      conversationId = await syncService2.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Created conversation ${conversationId} for Cursor session ${sessionId}`);
      if (pendingMessages[sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService2, retryQueue);
        delete pendingMessages[sessionId];
      }
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        if (handleAuthFailure()) {
          log("⚠️  Authentication expired - sync paused");
          setPosition(dbPath, totalCount);
          return;
        }
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);
      if (!pendingMessages[sessionId]) {
        pendingMessages[sessionId] = [];
      }
      for (const msg of messages) {
        pendingMessages[sessionId].push({
          uuid: msg.uuid,
          role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
          content: redactSecrets(msg.content),
          timestamp: msg.timestamp,
          filePath: dbPath,
          fileSize: totalCount,
          thinking: msg.thinking,
          toolCalls: msg.toolCalls,
          toolResults: msg.toolResults,
          images: msg.images,
          subtype: msg.subtype
        });
      }
      const firstMsgTimestamp = messages[0]?.timestamp;
      retryQueue.add("createConversation", {
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        startedAt: firstMsgTimestamp
      }, errMsg);
      setPosition(dbPath, totalCount);
      return;
    }
  }
  const batchResult = await syncMessagesBatch(messages, conversationId, syncService2, retryQueue);
  if (batchResult.authExpired) {
    log("⚠️  Authentication expired - sync paused");
    return;
  }
  if (batchResult.conversationNotFound) {
    log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
    delete conversationCache[sessionId];
    saveConversationCache(conversationCache);
    const firstMessageTimestamp = messages[0]?.timestamp;
    const firstUserMessage = messages.find((msg) => msg.role === "user");
    const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
    try {
      conversationId = await syncService2.createConversation({
        userId,
        teamId,
        sessionId,
        agentType: "cursor",
        projectPath: workspacePath,
        title,
        startedAt: firstMessageTimestamp
      });
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Recreated conversation ${conversationId} for Cursor session ${sessionId}`);
      await syncService2.addMessages({
        conversationId,
        messages: messages.map(prepMessageForSync)
      });
    } catch (retryErr) {
      const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      log(`Failed to recreate conversation and add messages: ${retryErrMsg}`);
    }
  }
  setPosition(dbPath, totalCount);
  log(`Synced ${messages.length} Cursor messages for session ${sessionId}`);
  syncStats.messagesSynced += messages.length;
  syncStats.sessionsActive.add(sessionId);
  updateStateCallback();
}
async function processCursorTranscriptFile(filePath, sessionId, syncService2, userId, teamId, conversationCache, retryQueue, pendingMessages, updateStateCallback) {
  let lastPosition = getPosition(filePath);
  let stats;
  try {
    stats = fs14.statSync(filePath);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }
  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }
  if (stats.size <= lastPosition) {
    return;
  }
  let fd;
  try {
    fd = fs14.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs14.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs14.closeSync(fd);
    const newContent = buffer.toString("utf-8");
    const messages = parseCursorTranscriptFile(newContent);
    let conversationId = conversationCache[sessionId];
    if (messages.length === 0) {
      setPosition(filePath, stats.size);
      return;
    }
    if (!conversationId) {
      let projectPath;
      try {
        projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
      } catch {
        projectPath = undefined;
      }
      const firstMessageTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find((msg) => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;
      try {
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Cursor transcript ${sessionId}`);
        syncStats.conversationsCreated++;
        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService2, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, stats.size);
            return;
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Cursor conversation, queueing for retry: ${errMsg}`);
        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype
          });
        }
        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          title,
          startedAt: firstMessageTimestamp,
          gitInfo
        }, errMsg);
        setPosition(filePath, stats.size);
        return;
      }
    }
    const batchResult = await syncMessagesBatch(messages, conversationId, syncService2, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);
      try {
        const projectPath = findWorkspacePathForCursorConversation(sessionId) || undefined;
        const firstMessageTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find((m) => m.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const gitInfo = projectPath ? getGitInfo(projectPath) : undefined;
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "cursor",
          projectPath,
          slug: undefined,
          title,
          startedAt: firstMessageTimestamp,
          parentMessageUuid: undefined,
          gitInfo
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Cursor transcript ${sessionId}`);
        await syncService2.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync)
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Cursor conversation and add messages: ${retryErrMsg}`);
      }
    }
    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} Cursor transcript messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Cursor transcript file ${filePath}: ${errMsg}`);
  }
}
async function processCodexSession(filePath, sessionId, syncService2, userId, teamId, conversationCache, retryQueue, pendingMessages, titleCache, updateStateCallback) {
  let lastPosition = getPosition(filePath);
  let stats;
  try {
    stats = fs14.statSync(filePath);
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") {
      log(`Warning: Permission denied reading ${filePath}. Will retry when permissions are restored.`);
      return;
    }
    throw err;
  }
  if (stats.size < lastPosition) {
    log(`File rotation detected for ${filePath}: size=${stats.size} < position=${lastPosition}. Resetting to start.`);
    setPosition(filePath, 0);
    lastPosition = 0;
  }
  if (stats.size <= lastPosition) {
    return;
  }
  let fd;
  try {
    fd = fs14.openSync(filePath, "r");
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs14.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs14.closeSync(fd);
    const newContent = buffer.toString("utf-8");
    const messages = parseCodexSessionFile(newContent);
    let conversationId = conversationCache[sessionId];
    if (conversationId) {
      let titleContent;
      try {
        titleContent = newContent + `
` + readFileTail(filePath, 4096);
      } catch (err) {
        if (err.code === "EACCES" || err.code === "EPERM") {
          log(`Warning: Permission denied reading ${filePath} for title update. Skipping.`);
          setPosition(filePath, stats.size);
          return;
        }
        throw err;
      }
      const summaryTitle = extractSummaryTitle(titleContent);
      if (summaryTitle && titleCache[sessionId] !== summaryTitle) {
        try {
          await syncService2.updateTitle(conversationId, summaryTitle);
          titleCache[sessionId] = summaryTitle;
          saveTitleCache(titleCache);
          log(`Updated title for Codex session ${sessionId}: ${summaryTitle}`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log(`Failed to update title: ${errMsg}`);
        }
      }
    }
    if (messages.length === 0) {
      setPosition(filePath, stats.size);
      return;
    }
    if (!conversationId) {
      let headContent;
      try {
        headContent = readFileHead(filePath, 16384);
      } catch (err) {
        if (err.code === "EACCES" || err.code === "EPERM") {
          log(`Warning: Permission denied reading ${filePath} for conversation creation. Skipping.`);
          return;
        }
        throw err;
      }
      try {
        const projectPath = extractCodexCwd(headContent);
        const firstMessageTimestamp = messages[0]?.timestamp;
        let matchedStartedConversation = null;
        if (startedSessionTmux.size > 0) {
          const startedCodexEntries = Array.from(startedSessionTmux.entries()).filter(([, entry]) => entry.agentType === "codex");
          const proc = await findSessionProcess(sessionId, "codex").catch(() => null);
          let tmuxSessionName = null;
          if (proc) {
            tmuxSessionName = sessionProcessCache.get(sessionId)?.tmuxTarget?.split(":")[0] ?? null;
            if (!tmuxSessionName) {
              const tmuxPane = await findTmuxPaneForTty(proc.tty);
              if (tmuxPane) {
                tmuxSessionName = tmuxPane.split(":")[0];
                cacheSessionProcess(sessionId, proc, tmuxPane);
              }
            }
          }
          matchedStartedConversation = matchStartedConversation(startedCodexEntries, {
            tmuxSessionName,
            projectPath
          });
          if (matchedStartedConversation && tmuxSessionName) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via tmux ${tmuxSessionName}`);
          } else if (matchedStartedConversation && projectPath) {
            log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via projectPath fallback`);
          } else {
            matchedStartedConversation = matchSingleFreshStartedConversation(startedCodexEntries);
            if (matchedStartedConversation) {
              log(`Matched codex session ${sessionId.slice(0, 8)} to conversation ${matchedStartedConversation.slice(0, 12)} via fresh-start fallback`);
            }
          }
        }
        if (matchedStartedConversation) {
          conversationId = matchedStartedConversation;
          const tmuxEntry = startedSessionTmux.get(matchedStartedConversation);
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          syncService2.updateSessionId(conversationId, sessionId).catch(() => {
          });
          if (tmuxEntry) {
            syncService2.registerManagedSession(sessionId, process.pid, tmuxEntry.tmuxSession, conversationId).catch(() => {
            });
            startCodexPermissionPoller(sessionId, tmuxEntry.tmuxSession, conversationId, syncService2);
          }
          startedSessionTmux.delete(matchedStartedConversation);
          log(`Linked Codex session ${sessionId} to existing started conversation ${conversationId}`);
        } else {
          const firstUserMessage = messages.find((msg) => msg.role === "user");
          const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
          conversationId = await syncService2.createConversation({
            userId,
            teamId,
            sessionId,
            agentType: "codex",
            projectPath,
            slug: undefined,
            title,
            startedAt: firstMessageTimestamp,
            parentMessageUuid: undefined,
            gitInfo: undefined
          });
          conversationCache[sessionId] = conversationId;
          saveConversationCache(conversationCache);
          log(`Created conversation ${conversationId} for Codex session ${sessionId}`);
          if (global.activeSessions) {
            global.activeSessions.set(conversationId, {
              sessionId,
              conversationId,
              projectPath: ""
            });
          }
          if (pendingMessages[sessionId]) {
            await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService2, retryQueue);
            delete pendingMessages[sessionId];
          }
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            setPosition(filePath, stats.size);
            return;
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Codex conversation, queueing for retry: ${errMsg}`);
        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of messages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: stats.size,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype
          });
        }
        const firstMsgTimestamp = messages[0]?.timestamp;
        const firstUserMessage = messages.find((msg) => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp
        }, errMsg);
        setPosition(filePath, stats.size);
        return;
      }
    }
    const batchResult = await syncMessagesBatch(messages, conversationId, syncService2, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);
      const firstMsgTimestamp = messages[0]?.timestamp;
      const firstUserMessage = messages.find((msg) => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      try {
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "codex",
          title,
          startedAt: firstMsgTimestamp
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Codex session ${sessionId}`);
        await syncService2.addMessages({
          conversationId,
          messages: messages.map(prepMessageForSync)
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Codex conversation and add messages: ${retryErrMsg}`);
      }
    }
    setPosition(filePath, stats.size);
    markSynced(filePath, stats.size, messages.length, conversationId);
    log(`Synced ${messages.length} Codex messages for session ${sessionId}`);
    syncStats.messagesSynced += messages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "codex");
    if (conversationId) {
      sendAgentStatus(syncService2, conversationId, sessionId, "working");
    }
    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Codex session file ${filePath}: ${errMsg}`);
  }
}
var geminiSyncedCounts = new Map;
async function processGeminiSession(filePath, sessionId, projectHash, syncService2, userId, teamId, conversationCache, retryQueue, pendingMessages, titleCache, updateStateCallback) {
  try {
    let content;
    try {
      content = fs14.readFileSync(filePath, "utf-8");
    } catch (err) {
      if (err.code === "EACCES" || err.code === "EPERM") {
        log(`Warning: Permission denied reading ${filePath}. Will retry later.`);
        return;
      }
      throw err;
    }
    const allMessages = parseGeminiSessionFile(content);
    const previousCount = geminiSyncedCounts.get(filePath) || 0;
    if (allMessages.length <= previousCount) {
      return;
    }
    const newMessages = allMessages.slice(previousCount);
    let conversationId = conversationCache[sessionId];
    if (!conversationId) {
      try {
        const firstUserMessage = allMessages.find((msg) => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        const startTime = allMessages[0]?.timestamp;
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          projectPath: undefined,
          slug: undefined,
          title,
          startedAt: startTime,
          parentMessageUuid: undefined,
          gitInfo: undefined
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Created conversation ${conversationId} for Gemini session ${sessionId}`);
        if (global.activeSessions) {
          global.activeSessions.set(conversationId, {
            sessionId,
            conversationId,
            projectPath: ""
          });
        }
        if (pendingMessages[sessionId]) {
          await flushPendingMessagesBatch(pendingMessages[sessionId], conversationId, syncService2, retryQueue);
          delete pendingMessages[sessionId];
        }
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          if (handleAuthFailure()) {
            log("⚠️  Authentication expired - sync paused");
            geminiSyncedCounts.set(filePath, allMessages.length);
            return;
          }
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Failed to create Gemini conversation, queueing for retry: ${errMsg}`);
        if (!pendingMessages[sessionId]) {
          pendingMessages[sessionId] = [];
        }
        for (const msg of newMessages) {
          pendingMessages[sessionId].push({
            uuid: msg.uuid,
            role: msg.role === "user" ? "human" : msg.role === "system" ? "system" : "assistant",
            content: redactSecrets(msg.content),
            timestamp: msg.timestamp,
            filePath,
            fileSize: content.length,
            thinking: msg.thinking,
            toolCalls: msg.toolCalls,
            toolResults: msg.toolResults,
            images: msg.images,
            subtype: msg.subtype
          });
        }
        const firstUserMessage = allMessages.find((msg) => msg.role === "user");
        const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
        retryQueue.add("createConversation", {
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp
        }, errMsg);
        geminiSyncedCounts.set(filePath, allMessages.length);
        return;
      }
    }
    const batchResult = await syncMessagesBatch(newMessages, conversationId, syncService2, retryQueue);
    if (batchResult.authExpired) {
      log("⚠️  Authentication expired - sync paused");
      return;
    }
    if (batchResult.conversationNotFound) {
      log(`Conversation ${conversationId} not found, invalidating cache and recreating...`);
      delete conversationCache[sessionId];
      saveConversationCache(conversationCache);
      const firstUserMessage = allMessages.find((msg) => msg.role === "user");
      const title = firstUserMessage ? generateTitleFromMessage(firstUserMessage.content) : undefined;
      try {
        conversationId = await syncService2.createConversation({
          userId,
          teamId,
          sessionId,
          agentType: "gemini",
          title,
          startedAt: allMessages[0]?.timestamp
        });
        conversationCache[sessionId] = conversationId;
        saveConversationCache(conversationCache);
        log(`Recreated conversation ${conversationId} for Gemini session ${sessionId}`);
        await syncService2.addMessages({
          conversationId,
          messages: newMessages.map(prepMessageForSync)
        });
      } catch (retryErr) {
        const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        log(`Failed to recreate Gemini conversation and add messages: ${retryErrMsg}`);
      }
    }
    geminiSyncedCounts.set(filePath, allMessages.length);
    log(`Synced ${newMessages.length} Gemini messages for session ${sessionId}`);
    syncStats.messagesSynced += newMessages.length;
    syncStats.sessionsActive.add(sessionId);
    tryRegisterSessionProcess(sessionId, "gemini");
    updateStateCallback();
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log(`Error processing Gemini session file ${filePath}: ${errMsg}`);
  }
}
var reconnectAttempt = 0;
var BASE_DELAY_MS = 1000;
var MAX_DELAY_MS = 30000;
function getReconnectDelay() {
  const delay2 = Math.min(BASE_DELAY_MS * Math.pow(2, reconnectAttempt), MAX_DELAY_MS);
  reconnectAttempt++;
  return delay2;
}
function resetReconnectDelay() {
  reconnectAttempt = 0;
}
function normalizeTty(tty) {
  if (tty.startsWith("/dev/"))
    return tty;
  if (tty.startsWith("ttys"))
    return `/dev/${tty}`;
  if (tty.match(/^s\d+$/))
    return `/dev/tty${tty}`;
  return `/dev/${tty}`;
}
function buildReverseConversationCache(cache) {
  const reverse = {};
  for (const [sessionId, convId] of Object.entries(cache)) {
    reverse[convId] = sessionId;
  }
  return reverse;
}
function detectSessionAgentType(sessionId) {
  if (sessionId.startsWith("session-"))
    return "gemini";
  const sessionFile = findSessionFile(sessionId);
  return sessionFile?.agentType ?? "claude";
}
function tryRegisterSessionProcess(sessionId, agentType) {
  try {
    const registryDir = path13.join(CONFIG_DIR5, "session-registry");
    const registryFile = path13.join(registryDir, `${sessionId}.json`);
    if (fs14.existsSync(registryFile)) {
      const stat4 = fs14.statSync(registryFile);
      if (Date.now() - stat4.mtimeMs < 300000)
        return;
    }
    findSessionProcess(sessionId, agentType).then((result) => {
      if (!result)
        return;
      try {
        fs14.mkdirSync(registryDir, { recursive: true });
        fs14.writeFileSync(registryFile, JSON.stringify({ pid: result.pid, tty: result.tty, ts: Math.floor(Date.now() / 1000) }));
        log(`Opportunistically registered session ${sessionId.slice(0, 8)}: pid=${result.pid}, tty=${result.tty}`);
      } catch {
      }
      if (syncServiceRef) {
        const cache = readConversationCache();
        const conversationId = cache[sessionId];
        if (conversationId) {
          findTmuxPaneForTty(result.tty).then((tmuxPane) => {
            const tmuxSessionName = tmuxPane?.split(":")[0];
            syncServiceRef.registerManagedSession(sessionId, result.pid, tmuxSessionName, conversationId).catch(() => {
            });
          }).catch(() => {
            syncServiceRef.registerManagedSession(sessionId, result.pid, undefined, conversationId).catch(() => {
            });
          });
          if (!resumeHeartbeatIntervals.has(sessionId)) {
            const interval = setInterval(() => {
              syncServiceRef.heartbeatManagedSession(sessionId).catch(() => {
              });
            }, 30000);
            resumeHeartbeatIntervals.set(sessionId, interval);
          }
        }
      }
    }).catch(() => {
    });
  } catch {
  }
}
async function findSessionProcess(sessionId, agentType = "claude") {
  const cached = await getCachedSessionProcess(sessionId);
  if (cached) {
    log(`Process cache hit for session ${sessionId.slice(0, 8)}: pid=${cached.pid}`);
    return cached;
  }
  const binaryPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "claude";
  try {
    try {
      const registryFile = path13.join(CONFIG_DIR5, "session-registry", `${sessionId}.json`);
      if (fs14.existsSync(registryFile)) {
        const reg = JSON.parse(fs14.readFileSync(registryFile, "utf-8"));
        const pid = reg.pid;
        const tty = normalizeTty(reg.tty);
        const termProgram = reg.term || undefined;
        const { stdout: checkPs } = await execAsync2(`ps -o comm= -p ${pid} 2>/dev/null`);
        if (checkPs.trim()) {
          if (agentType === "codex") {
            log(`Ignoring registry candidate for codex session ${sessionId.slice(0, 8)} (pid=${pid})`);
          } else {
            const result = { pid, tty, sessionId, termProgram };
            cacheSessionProcess(sessionId, result);
            log(`Found session ${sessionId.slice(0, 8)} via registry: pid=${pid}, tty=${tty}, term=${termProgram ?? "unknown"}`);
            return result;
          }
        } else {
          try {
            fs14.unlinkSync(registryFile);
          } catch {
          }
        }
      }
    } catch {
    }
    try {
      const { stdout } = await execAsync2(`ps aux | grep -E '${binaryPattern}' | grep -v grep | grep -v 'codecast'`);
      const lines = stdout.trim().split(`
`);
      const geminiCandidates = [];
      const codexResumeCandidates2 = [];
      for (const line of lines) {
        if (!line.trim())
          continue;
        const isResume = isResumeInvocation(agentType, line);
        if (!isResume && agentType !== "gemini")
          continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 7)
          continue;
        const pid = parseInt(parts[1], 10);
        const tty = parts[6];
        if (isNaN(pid) || tty === "?" || tty === "??")
          continue;
        const normalizedTty = normalizeTty(tty);
        if (line.includes(sessionId)) {
          if (agentType === "codex") {
            codexResumeCandidates2.push({ pid, tty: normalizedTty });
            continue;
          }
          const result = { pid, tty: normalizedTty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found session ${sessionId.slice(0, 8)} via resume process match: pid=${pid}`);
          return result;
        }
        if (agentType === "gemini") {
          geminiCandidates.push({ pid, tty: normalizedTty });
        }
      }
      if (agentType === "gemini" && geminiCandidates.length > 0) {
        if (geminiCandidates.length === 1) {
          const only = geminiCandidates[0];
          const result2 = { pid: only.pid, tty: only.tty, sessionId };
          cacheSessionProcess(sessionId, result2);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via single process candidate: pid=${only.pid}`);
          return result2;
        }
        let newest = null;
        for (const c of geminiCandidates) {
          try {
            const { stdout: startOut } = await execAsync2(`ps -o lstart= -p ${c.pid}`);
            const startedAt = new Date(startOut.trim()).getTime();
            if (!isNaN(startedAt) && (!newest || startedAt > newest.startedAt)) {
              newest = { pid: c.pid, tty: c.tty, startedAt };
            }
          } catch {
          }
        }
        if (newest) {
          const result2 = { pid: newest.pid, tty: newest.tty, sessionId };
          cacheSessionProcess(sessionId, result2);
          log(`Found Gemini session ${sessionId.slice(0, 8)} via newest process heuristic: pid=${newest.pid}`);
          return result2;
        }
        const fallback = geminiCandidates[0];
        const result = { pid: fallback.pid, tty: fallback.tty, sessionId };
        cacheSessionProcess(sessionId, result);
        log(`Found Gemini session ${sessionId.slice(0, 8)} via fallback process candidate: pid=${fallback.pid}`);
        return result;
      }
    } catch {
    }
    if (agentType === "codex") {
      try {
        const { stdout } = await execAsync2(`ps aux | grep -E 'codex' | grep -v grep | grep -v 'codecast'`);
        const lines = stdout.trim().split(`
`);
        const candidates = [];
        for (const line of lines) {
          if (!line.trim())
            continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length < 7)
            continue;
          const pid = parseInt(parts[1], 10);
          const tty = parts[6];
          if (isNaN(pid) || tty === "?" || tty === "??")
            continue;
          try {
            const { stdout: lsofOut } = await execAsync2(`lsof -p ${pid} 2>/dev/null`);
            if (!hasCodexSessionFileOpen(lsofOut, sessionId))
              continue;
            const normalizedTty = normalizeTty(tty);
            let tmuxTarget = null;
            try {
              tmuxTarget = await findTmuxPaneForTty(normalizedTty);
            } catch {
            }
            candidates.push({ pid, tty: normalizedTty, tmuxTarget });
          } catch {
          }
        }
        if (candidates.length > 0) {
          const preferred = choosePreferredCodexCandidate(candidates);
          if (!preferred)
            return null;
          const result = { pid: preferred.pid, tty: preferred.tty, sessionId };
          cacheSessionProcess(sessionId, result, preferred.tmuxTarget || undefined);
          if (preferred.tmuxTarget) {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (tmux): pid=${preferred.pid}`);
          } else {
            log(`Found codex session ${sessionId.slice(0, 8)} via lsof session file match (non-tmux preferred): pid=${preferred.pid}`);
          }
          return result;
        }
        if (codexResumeCandidates.length > 0) {
          const candidate = codexResumeCandidates[0];
          const result = { pid: candidate.pid, tty: candidate.tty, sessionId };
          cacheSessionProcess(sessionId, result);
          log(`Found codex session ${sessionId.slice(0, 8)} via resume process fallback: pid=${candidate.pid}`);
          return result;
        }
      } catch {
      }
    }
    try {
      const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"]);
      const shortId = sessionId.slice(0, 8);
      for (const tmuxName of tmuxList.trim().split(`
`)) {
        if (!tmuxName.includes(shortId))
          continue;
        try {
          const { stdout: paneInfo } = await tmuxExec(["list-panes", "-t", tmuxName, "-F", "#{pane_tty} #{pane_pid}"]);
          const paneLine = paneInfo.trim().split(`
`)[0];
          if (paneLine) {
            const [paneTty, panePidStr] = paneLine.split(" ");
            const panePid = parseInt(panePidStr, 10);
            if (!isNaN(panePid) && paneTty) {
              try {
                const { stdout: childPs } = await execAsync2(`pgrep -P ${panePid} -f ${binaryPattern} 2>/dev/null`);
                const childPid = parseInt(childPs.trim().split(`
`)[0]?.trim(), 10);
                if (!isNaN(childPid)) {
                  const result = { pid: childPid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${childPid}`);
                  return result;
                }
                if (isAgentProcess(panePid)) {
                  const result = { pid: panePid, tty: normalizeTty(paneTty), sessionId };
                  cacheSessionProcess(sessionId, result, `${tmuxName}:0.0`);
                  log(`Found session ${sessionId.slice(0, 8)} via tmux session ${tmuxName}: pid=${panePid} (direct)`);
                  return result;
                }
                log(`Tmux session ${tmuxName} has no active agent (shell pid=${panePid}), skipping`);
              } catch {
              }
            }
          }
        } catch {
        }
      }
    } catch {
    }
    const jsonlPath = findSessionJsonlPath(sessionId);
    if (jsonlPath) {
      const jsonlStat = fs14.statSync(jsonlPath);
      const recentlyModified = Date.now() - jsonlStat.mtimeMs < 60000;
      if (recentlyModified) {
        const jsonlContent = readFileHead(jsonlPath, 5000);
        const projectCwd = extractCwd(jsonlContent) || (agentType === "codex" ? extractCodexCwd(jsonlContent) : null);
        if (projectCwd) {
          try {
            const psPattern = agentType === "gemini" ? "gemini" : agentType === "codex" ? "codex" : "/claude\\b|claude-code";
            const { stdout: psOut } = await execAsync2(`ps aux | grep -E '${psPattern}' | grep -v grep | grep -v 'codecast'`);
            const candidates = [];
            for (const line of psOut.trim().split(`
`)) {
              if (!line.trim())
                continue;
              const parts = line.trim().split(/\s+/);
              if (parts.length < 7)
                continue;
              const pid = parseInt(parts[1], 10);
              const tty = parts[6];
              if (isNaN(pid) || tty === "?" || tty === "??")
                continue;
              try {
                const { stdout: lsofOut } = await execAsync2(`lsof -d cwd -a -p ${pid} -F n 2>/dev/null`);
                const cwdLine = lsofOut.split(`
`).find((l) => l.startsWith("n"));
                if (cwdLine) {
                  const processCwd = cwdLine.slice(1);
                  if (processCwd === projectCwd || processCwd.startsWith(projectCwd + "/")) {
                    candidates.push({ pid, tty: normalizeTty(tty) });
                  }
                }
              } catch {
              }
            }
            const unclaimed = candidates.filter((c) => {
              for (const [cachedSid, cachedInfo] of sessionProcessCache) {
                if (cachedSid !== sessionId && cachedInfo.pid === c.pid)
                  return false;
              }
              return true;
            });
            if (unclaimed.length === 1) {
              const result = { pid: unclaimed[0].pid, tty: unclaimed[0].tty, sessionId };
              cacheSessionProcess(sessionId, result);
              log(`Found session ${sessionId.slice(0, 8)} via CWD match: pid=${unclaimed[0].pid}, cwd=${projectCwd}`);
              return result;
            } else if (unclaimed.length > 1) {
              const jsonlBirthMs = jsonlStat.birthtimeMs;
              let bestCandidate = null;
              let bestDelta = Infinity;
              for (const c of unclaimed) {
                try {
                  const { stdout: etimeOut } = await execAsync2(`ps -o lstart= -p ${c.pid}`);
                  const processStart = new Date(etimeOut.trim()).getTime();
                  const delta = Math.abs(processStart - jsonlBirthMs);
                  if (delta < bestDelta) {
                    bestDelta = delta;
                    bestCandidate = c;
                  }
                } catch {
                }
              }
              if (bestCandidate && bestDelta < 300000) {
                const result = { pid: bestCandidate.pid, tty: bestCandidate.tty, sessionId };
                cacheSessionProcess(sessionId, result);
                log(`Found session ${sessionId.slice(0, 8)} via CWD+timing match: pid=${bestCandidate.pid}, delta=${Math.round(bestDelta / 1000)}s`);
                return result;
              }
              log(`CWD match found ${unclaimed.length} unclaimed candidates for ${sessionId.slice(0, 8)}, could not disambiguate`);
            } else {
              log(`CWD match found ${candidates.length} candidates for ${sessionId.slice(0, 8)} but all claimed by other sessions`);
            }
          } catch {
          }
        }
      }
    }
    return null;
  } catch (err) {
    log(`Error finding Claude session process: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
async function findTmuxPaneForTty(tty) {
  if (!hasTmux())
    return null;
  try {
    const { stdout } = await tmuxExec(["list-panes", "-a", "-F", "#{pane_tty} #{session_name}:#{window_index}.#{pane_index}"]);
    const normalizedTty = normalizeTty(tty);
    for (const line of stdout.trim().split(`
`)) {
      const [paneTty, target] = line.split(" ");
      if (paneTty === normalizedTty && target) {
        return target;
      }
    }
    return null;
  } catch {
    return null;
  }
}
function parseInteractivePrompt(text) {
  const lines = text.split(`
`);
  const optionPattern = /^\s*[❯>)]*\s*(\d+)[.)]\s+(.+?)(?:\s{2,}(.+?))?$/;
  const options = [];
  let firstOptionIdx = -1;
  let gapCount = 0;
  for (let i = 0;i < lines.length; i++) {
    const m = lines[i].match(optionPattern);
    if (m) {
      if (firstOptionIdx < 0)
        firstOptionIdx = i;
      const label = m[2].replace(/\s*[✓✗✔☑]\s*/g, "").trim();
      const description = m[3]?.trim() || undefined;
      if (label)
        options.push({ label, description });
      gapCount = 0;
    } else if (options.length > 0) {
      const trimmed = lines[i].trim();
      if (!trimmed || /^\s{10,}/.test(lines[i])) {
        gapCount++;
        if (gapCount > 3)
          break;
      } else if (/^\s*[❯>]\s*$/.test(lines[i]) || /confirm|exit|adjust|effort/i.test(trimmed)) {
        break;
      }
    }
  }
  if (options.length < 2 || firstOptionIdx < 0)
    return null;
  const headerLines = lines.slice(Math.max(0, firstOptionIdx - 5), firstOptionIdx).map((l) => l.trim()).filter((l) => l.length > 0 && !/^[❯>]/.test(l) && !/^[─━═─\-_]{5,}$/.test(l));
  const question = headerLines[0] || "Select an option";
  return { question, options };
}
function parsePollMessage(content) {
  try {
    const parsed = JSON.parse(content);
    if (parsed.__cc_poll && (Array.isArray(parsed.keys) || Array.isArray(parsed.steps)))
      return parsed;
  } catch {
  }
  return null;
}
async function checkForInteractivePrompt(tmuxTarget, sessionId, conversationId, syncService2) {
  if (pendingInteractivePrompts.has(sessionId)) {
    log(`Skipping prompt check: pending prompt exists for ${sessionId.slice(0, 8)}`);
    return;
  }
  const hookEntry = lastHookStatus.get(sessionId);
  if (hookEntry && hookEntry.status === "working" && Date.now() / 1000 - hookEntry.ts < 10) {
    log(`Skipping prompt check: session ${sessionId.slice(0, 8)} is working`);
    return;
  }
  await new Promise((resolve4) => setTimeout(resolve4, 2000));
  try {
    const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxTarget, "-S", "-50"]);
    const prompt = parseInteractivePrompt(paneContent);
    if (!prompt) {
      log(`No interactive prompt found in ${tmuxTarget} for session ${sessionId.slice(0, 8)}`);
      return;
    }
    log(`Interactive prompt detected in session ${sessionId.slice(0, 8)}: "${prompt.question}" with ${prompt.options.length} options`);
    const now = Date.now();
    pendingInteractivePrompts.set(sessionId, now);
    await syncService2.addMessages({
      conversationId,
      messages: [{
        messageUuid: `interactive-prompt-${sessionId}-${now}`,
        role: "assistant",
        content: "",
        timestamp: now,
        toolCalls: [{
          id: `prompt-${now}`,
          name: "AskUserQuestion",
          input: {
            questions: [{
              question: prompt.question,
              options: prompt.options
            }]
          }
        }]
      }]
    });
    log(`Synced interactive prompt as AskUserQuestion for session ${sessionId.slice(0, 8)}`);
  } catch (err) {
    log(`Interactive prompt check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function normalizePromptText(value) {
  return value.replace(/\s+/g, " ").trim();
}
function tmuxPromptStillHasInput(paneContent, input) {
  const normalizedInput = normalizePromptText(input);
  if (!normalizedInput)
    return false;
  const lines = paneContent.split(`
`);
  const recent = lines.slice(-80).join(`
`);
  const lastPromptIndex = Math.max(recent.lastIndexOf("❯"), recent.lastIndexOf("›"));
  if (lastPromptIndex === -1)
    return false;
  const fromPrompt = recent.slice(lastPromptIndex);
  return normalizePromptText(fromPrompt).includes(normalizedInput);
}
var tmuxTargetLocks = new Map;
async function withTmuxLock(target, fn) {
  const baseTarget = target.split(":")[0];
  while (tmuxTargetLocks.has(baseTarget)) {
    await tmuxTargetLocks.get(baseTarget);
  }
  let resolve4;
  const lock = new Promise((r) => {
    resolve4 = r;
  });
  tmuxTargetLocks.set(baseTarget, lock);
  try {
    return await fn();
  } finally {
    tmuxTargetLocks.delete(baseTarget);
    resolve4();
  }
}
async function injectViaTmux(target, content) {
  return withTmuxLock(target, () => injectViaTmuxInner(target, content));
}
async function injectViaTmuxInner(target, content) {
  const poll = parsePollMessage(content);
  if (poll) {
    const steps = poll.steps || (poll.keys || []).map((k) => ({ key: k }));
    for (const step of steps) {
      await tmuxExec(["send-keys", "-t", target, step.key]);
      await new Promise((resolve4) => setTimeout(resolve4, 500));
      if (step.text) {
        await new Promise((resolve4) => setTimeout(resolve4, 300));
        await tmuxExec(["send-keys", "-t", target, "-l", step.text]);
        await new Promise((resolve4) => setTimeout(resolve4, 150));
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
        await new Promise((resolve4) => setTimeout(resolve4, 500));
      }
    }
    if (poll.text) {
      await new Promise((resolve4) => setTimeout(resolve4, 300));
      await tmuxExec(["send-keys", "-t", target, "-l", poll.text]);
      await new Promise((resolve4) => setTimeout(resolve4, 150));
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
    }
    log(`Injected poll response via tmux to ${target}`);
    return;
  }
  const sanitized = content.replace(/\r?\n/g, " ");
  try {
    const { stdout: preCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", "-5"]);
    const hasBlockingWarning = /Press enter to continue|Update available|⚠|recorded with model|weekly limit/i.test(preCheck);
    const promptVisible = /[❯›]/.test(preCheck.split(`
`).slice(-5).join(`
`));
    if (hasBlockingWarning && !promptVisible) {
      log(`Clearing blocking dialog before inject to ${target}`);
      await tmuxExec(["send-keys", "-t", target, "Enter"]);
      await new Promise((resolve4) => setTimeout(resolve4, 1000));
    } else if (hasBlockingWarning && promptVisible) {
      await tmuxExec(["send-keys", "-t", target, "Escape"]);
      await new Promise((resolve4) => setTimeout(resolve4, 500));
    }
  } catch {
  }
  const captureLines = Math.max(30, Math.ceil(sanitized.length / 60) + 10);
  const contentPrefix = sanitized.slice(0, 40);
  let pasteConfirmed = false;
  for (let pasteRetry = 0;pasteRetry < 4; pasteRetry++) {
    if (pasteRetry > 0) {
      log(`Paste retry ${pasteRetry} for ${target} (text not appearing in pane)`);
      await new Promise((resolve4) => setTimeout(resolve4, 500 * pasteRetry));
    }
    const id = `cc-${process.pid}-${Date.now()}`;
    const tmpFile = `/tmp/${id}`;
    try {
      fs14.writeFileSync(tmpFile, sanitized);
      await tmuxExec(["load-buffer", "-b", id, tmpFile]);
      await tmuxExec(["paste-buffer", "-t", target, "-b", id, "-d"]);
    } catch (err) {
      await tmuxExec(["send-keys", "-t", target, "-l", sanitized]);
    } finally {
      try {
        fs14.unlinkSync(tmpFile);
      } catch {
      }
    }
    for (let attempt = 0;attempt < 12; attempt++) {
      try {
        const { stdout: echoCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
        if (tmuxPromptStillHasInput(echoCheck, contentPrefix)) {
          pasteConfirmed = true;
          break;
        }
      } catch {
      }
      await new Promise((resolve4) => setTimeout(resolve4, 150));
    }
    if (pasteConfirmed)
      break;
  }
  if (!pasteConfirmed) {
    log(`WARNING: paste text never appeared in pane ${target} after 4 retries`);
  }
  const enterDelay = Math.max(200, Math.min(1000, Math.ceil(sanitized.length / 100) * 50));
  await new Promise((resolve4) => setTimeout(resolve4, enterDelay));
  await tmuxExec(["send-keys", "-t", target, "Enter"]);
  for (let retry = 0;retry < 5; retry++) {
    await new Promise((resolve4) => setTimeout(resolve4, 600));
    try {
      const { stdout: postCheck } = await tmuxExec(["capture-pane", "-p", "-J", "-t", target, "-S", `-${captureLines}`]);
      if (tmuxPromptStillHasInput(postCheck, contentPrefix)) {
        log(`Enter may not have submitted (retry ${retry + 1}), sending Enter again to ${target}`);
        await tmuxExec(["send-keys", "-t", target, "Enter"]);
      } else {
        const lastLines = postCheck.split(`
`).slice(-5).join(`
`);
        const hasPrompt = /[❯›]/.test(lastLines);
        const hasActivity = /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏|●|thinking|Bash|Read|Edit|Write|Glob|Grep/.test(lastLines);
        if (hasActivity || !hasPrompt) {
          break;
        }
        const promptLine = lastLines.split(`
`).find((l) => /[❯›]/.test(l));
        if (promptLine) {
          const promptMatch = promptLine.match(/[❯›]/);
          const afterPrompt = promptMatch ? promptLine.slice(promptMatch.index + 1).trim() : "";
          if (!afterPrompt)
            break;
        }
        break;
      }
    } catch {
      break;
    }
  }
  if (pasteConfirmed) {
    log(`Injected via tmux to ${target}`);
  } else {
    log(`WARNING: Injection to ${target} completed but paste was never confirmed`);
  }
}
function buildAppleScript(app, normalizedTty, content, poll) {
  const isIterm = app === "iTerm2";
  if (poll) {
    const steps = poll.steps || (poll.keys || []).map((k) => ({ key: k }));
    let stepActions;
    if (isIterm) {
      stepActions = steps.map((step, i) => {
        const lines = [`            tell s to write text "${step.key}" without newline`];
        if (step.text) {
          const escapedText = step.text.replace(/"/g, "\\\"");
          lines.push("            delay 0.5");
          lines.push(`            tell s to write text "${escapedText}" without newline`);
          lines.push("            delay 0.15");
          lines.push(`            tell s to write text ""`);
        }
        if (i < steps.length - 1)
          lines.push("            delay 0.5");
        return lines.join(`
`);
      }).join(`
`);
    } else {
      stepActions = steps.map((step, i) => {
        const lines = [`          do script "${step.key}" in t`];
        if (step.text) {
          const escapedText = step.text.replace(/"/g, "\\\"");
          lines.push("          delay 0.5");
          lines.push(`          do script "${escapedText}" in t`);
        }
        if (i < steps.length - 1)
          lines.push("          delay 0.5");
        return lines.join(`
`);
      }).join(`
`);
    }
    const textAction = poll.text ? isIterm ? `
            delay 0.3
            tell s to write text "${poll.text.replace(/"/g, "\\\"")}" without newline
            delay 0.15
            tell s to write text ""` : `
          delay 0.3
          do script "${poll.text.replace(/"/g, "\\\"")}" in t` : "";
    const script2 = isIterm ? `on run argv
  set targetTty to item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
${stepActions}${textAction}
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run` : `on run argv
  set targetTty to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
${stepActions}${textAction}
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
    return { script: script2, args: `'${normalizedTty}'` };
  }
  const escapedContent = content.replace(/'/g, "'\\''");
  const script = isIterm ? `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          set sTty to tty of s
          if sTty is targetTty then
            tell s to write text msgText without newline
            delay 0.15
            tell s to write text ""
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "not_found"
end run` : `on run argv
  set msgText to item 1 of argv
  set targetTty to item 2 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        if tty of t is targetTty then
          do script msgText in t
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "not_found"
end run`;
  return { script, args: `'${escapedContent}' '${normalizedTty}'` };
}
async function injectViaTerminal(tty, content, termProgram) {
  const normalizedTty = normalizeTty(tty);
  const poll = parsePollMessage(content);
  const app = termProgram === "Apple_Terminal" ? "Terminal" : "iTerm2";
  const { script, args } = buildAppleScript(app, normalizedTty, content, poll);
  const tmpFile = path13.join(CONFIG_DIR5, "terminal-inject.scpt");
  fs14.writeFileSync(tmpFile, script);
  try {
    const { stdout } = await execAsync2(`osascript "${tmpFile}" ${args}`);
    if (stdout.trim() === "not_found") {
      throw new Error(`${app} session not found for TTY ${normalizedTty}`);
    }
    log(`Injected ${poll ? "poll response" : "message"} via ${app} for TTY ${normalizedTty}`);
  } finally {
    try {
      fs14.unlinkSync(tmpFile);
    } catch {
    }
  }
}
function findSessionJsonlPath(sessionId) {
  return findSessionFile(sessionId)?.path ?? null;
}
function findSessionFile(sessionId) {
  const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
  if (fs14.existsSync(claudeProjectsDir)) {
    const projectDirs = fs14.readdirSync(claudeProjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    for (const dir of projectDirs) {
      const jsonlPath = path13.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
      if (fs14.existsSync(jsonlPath))
        return { path: jsonlPath, agentType: "claude" };
    }
  }
  const codexSessionsDir = path13.join(process.env.HOME || "", ".codex", "sessions");
  if (fs14.existsSync(codexSessionsDir)) {
    try {
      const findCodex = (dir) => {
        const entries = fs14.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path13.join(dir, entry.name);
          if (entry.isDirectory()) {
            const found = findCodex(fullPath);
            if (found)
              return found;
          } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) {
            return fullPath;
          }
        }
        return null;
      };
      const codexPath = findCodex(codexSessionsDir);
      if (codexPath)
        return { path: codexPath, agentType: "codex" };
    } catch {
    }
  }
  const geminiTmpDir = path13.join(process.env.HOME || "", ".gemini", "tmp");
  if (fs14.existsSync(geminiTmpDir)) {
    try {
      const projectDirs = fs14.readdirSync(geminiTmpDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
      for (const dir of projectDirs) {
        const chatsDir = path13.join(geminiTmpDir, dir, "chats");
        if (!fs14.existsSync(chatsDir))
          continue;
        const jsonPath = path13.join(chatsDir, `${sessionId}.json`);
        if (fs14.existsSync(jsonPath))
          return { path: jsonPath, agentType: "gemini" };
      }
    } catch {
    }
  }
  return null;
}
var resumeSessionCache = new Map;
var resumeHeartbeatIntervals = new Map;
var codexPermissionPollers = new Map;
var codexPermissionPending = new Set;
var codexPermissionRunning = new Set;
var CODEX_PERMISSION_PATTERNS = [
  /Would you like to run the following command\?/,
  /Press enter to confirm or esc to cancel/,
  /Do you want to proceed\?/
];
function detectCodexPermissionFromPane(paneContent) {
  if (!CODEX_PERMISSION_PATTERNS.some((p) => p.test(paneContent)))
    return null;
  let reason = "";
  let command = "";
  const lines = paneContent.split(`
`);
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i];
    if (line.includes("Reason:")) {
      reason = line.replace(/.*Reason:\s*/, "").trim();
    }
    if (line.startsWith("$ ")) {
      command = line.slice(2).trim();
      for (let j = i + 1;j < lines.length && j < i + 5; j++) {
        const next = lines[j].trim();
        if (next && !next.startsWith("1.") && !next.startsWith("2.") && !next.startsWith("3.") && !next.startsWith("Press ")) {
          command += " " + next;
        } else
          break;
      }
    }
  }
  return { reason: reason || "Command approval requested", command: command.slice(0, 300) };
}
function startCodexPermissionPoller(sessionId, tmuxSession, conversationId, syncService2) {
  if (codexPermissionPollers.has(sessionId))
    return;
  const interval = setInterval(async () => {
    if (codexPermissionPending.has(sessionId))
      return;
    if (codexPermissionRunning.has(sessionId))
      return;
    if (isInWakeGrace())
      return;
    codexPermissionRunning.add(sessionId);
    try {
      const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-30"], { timeout: 3000, killSignal: "SIGKILL" });
      const prompt = detectCodexPermissionFromPane(paneContent);
      if (!prompt)
        return;
      codexPermissionPending.add(sessionId);
      log(`Codex permission prompt detected in tmux for session ${sessionId.slice(0, 8)}: ${prompt.reason.slice(0, 100)}`);
      sendAgentStatus(syncService2, conversationId, sessionId, "permission_blocked");
      const preview = truncateForNotification(`${prompt.command || prompt.reason}`, 200);
      syncService2.createSessionNotification({
        conversation_id: conversationId,
        type: "permission_request",
        title: "codecast - Permission needed",
        message: preview
      }).catch(() => {
      });
      const permissionPrompt = {
        tool_name: "exec_command",
        arguments_preview: prompt.command || prompt.reason
      };
      handlePermissionRequest(syncService2, conversationId, sessionId, permissionPrompt, log).then(async (decision) => {
        if (decision) {
          const key = decision.approved ? "Enter" : "Escape";
          log(`Injecting Codex permission '${key}' for session ${sessionId.slice(0, 8)}`);
          try {
            await tmuxExec(["send-keys", "-t", tmuxSession, key]);
          } catch (err) {
            log(`Failed to inject Codex permission key: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        sendAgentStatus(syncService2, conversationId, sessionId, "working");
        codexPermissionPending.delete(sessionId);
      }).catch((err) => {
        log(`Codex permission handling error: ${err instanceof Error ? err.message : String(err)}`);
        codexPermissionPending.delete(sessionId);
      });
    } catch {
    } finally {
      codexPermissionRunning.delete(sessionId);
    }
  }, 3000);
  codexPermissionPollers.set(sessionId, interval);
  log(`Started Codex permission poller for session ${sessionId.slice(0, 8)} on tmux ${tmuxSession}`);
}
function stopCodexPermissionPoller(sessionId) {
  const interval = codexPermissionPollers.get(sessionId);
  if (interval) {
    clearInterval(interval);
    codexPermissionPollers.delete(sessionId);
    codexPermissionPending.delete(sessionId);
  }
}
var startedSessionTmux = new Map;
var STARTED_SESSION_TTL_MS = 5 * 60 * 1000;
var restartingSessionIds = new Map;
var RESTART_GUARD_TTL_MS = 60000;
var resumeInFlight = new Map;
var resumeInFlightStarted = new Map;
var RESUME_IN_FLIGHT_TIMEOUT_MS = 120000;
var UUID_JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;
async function discoverAndLinkSession(conversationId, tmuxSession, cwd) {
  const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
  const projectDirName = cwd.replace(/\//g, "-");
  const projectDir = path13.join(claudeProjectsDir, projectDirName);
  const existingFiles = new Set;
  if (fs14.existsSync(projectDir)) {
    for (const f of fs14.readdirSync(projectDir)) {
      if (UUID_JSONL_RE.test(f))
        existingFiles.add(f);
    }
  }
  for (let attempt = 0;attempt < 30; attempt++) {
    await new Promise((resolve4) => setTimeout(resolve4, 2000));
    if (!startedSessionTmux.has(conversationId)) {
      log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked by watcher, stopping discovery`);
      return;
    }
    if (!fs14.existsSync(projectDir))
      continue;
    for (const f of fs14.readdirSync(projectDir)) {
      const m = f.match(UUID_JSONL_RE);
      if (!m || existingFiles.has(f))
        continue;
      const sessionId = m[1];
      const cache = readConversationCache();
      if (cache[sessionId])
        continue;
      const reverseCache = buildReverseConversationCache(cache);
      if (reverseCache[conversationId]) {
        log(`[DISCOVER] Conversation ${conversationId.slice(0, 12)} already linked to ${reverseCache[conversationId].slice(0, 8)} by another writer`);
        startedSessionTmux.delete(conversationId);
        return;
      }
      cache[sessionId] = conversationId;
      saveConversationCache(cache);
      if (syncServiceRef) {
        syncServiceRef.updateSessionId(conversationId, sessionId).catch(() => {
        });
        syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {
        });
      }
      startedSessionTmux.delete(conversationId);
      log(`[DISCOVER] Linked session ${sessionId.slice(0, 8)} to conversation ${conversationId.slice(0, 12)} via JSONL discovery`);
      return;
    }
  }
  log(`[DISCOVER] Timed out discovering session for conversation ${conversationId.slice(0, 12)}`);
}
var planHandoffChildren = new Map;
var planHandoffChecked = new Set;
var planModeSynced = new Set;
var planModePlanMap = new Map;
var planModeTaskMap = new Map;
var PLAN_MODE_CACHE_FILE = path13.join(CONFIG_DIR5, "plan-mode-cache.json");
function loadPlanModeCache() {
  try {
    if (!fs14.existsSync(PLAN_MODE_CACHE_FILE))
      return;
    const data = JSON.parse(fs14.readFileSync(PLAN_MODE_CACHE_FILE, "utf-8"));
    if (data.synced)
      for (const s of data.synced)
        planModeSynced.add(s);
    if (data.plans)
      for (const [k, v] of Object.entries(data.plans))
        planModePlanMap.set(k, v);
    if (data.tasks) {
      for (const [sessionId, taskObj] of Object.entries(data.tasks)) {
        const map = new Map;
        for (const [localId, shortId] of Object.entries(taskObj)) {
          map.set(localId, shortId);
        }
        planModeTaskMap.set(sessionId, map);
      }
    }
  } catch {
  }
}
function savePlanModeCache() {
  try {
    const tasks = {};
    for (const [sessionId, map] of planModeTaskMap) {
      tasks[sessionId] = Object.fromEntries(map);
    }
    fs14.writeFileSync(PLAN_MODE_CACHE_FILE, JSON.stringify({
      synced: [...planModeSynced],
      plans: Object.fromEntries(planModePlanMap),
      tasks
    }), { mode: 384 });
  } catch {
  }
}
loadPlanModeCache();
var pendingSubagentParents = new Map;
var sessionProcessCache = new Map;
var PROCESS_CACHE_TTL_MS = 30000;
function cacheSessionProcess(sessionId, info, tmuxTarget) {
  sessionProcessCache.set(sessionId, {
    pid: info.pid,
    tty: info.tty,
    tmuxTarget,
    termProgram: info.termProgram,
    lastVerified: Date.now()
  });
}
async function getCachedSessionProcess(sessionId) {
  const cached = sessionProcessCache.get(sessionId);
  if (!cached)
    return null;
  if (Date.now() - cached.lastVerified > PROCESS_CACHE_TTL_MS) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
      return null;
    }
    cached.lastVerified = Date.now();
  }
  return { pid: cached.pid, tty: cached.tty, sessionId, termProgram: cached.termProgram };
}
function validateProcessCache() {
  for (const [sessionId, cached] of sessionProcessCache) {
    if (!isProcessRunning(cached.pid) || !isAgentProcess(cached.pid)) {
      sessionProcessCache.delete(sessionId);
    }
  }
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveSessionId(filePath) {
  const name = path13.basename(filePath, ".jsonl");
  if (UUID_RE.test(name))
    return name;
  try {
    const head = readFileHead(filePath, 4096);
    const m = head.match(/"sessionId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i);
    if (m)
      return m[1];
  } catch {
  }
  return name;
}
function slugify(text, maxLen = 30) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/, "");
}
async function autoResumeSession(sessionId, content, titleCache, nonInteractive = false, cwdOverride, conversationId) {
  const existing = resumeInFlight.get(sessionId);
  if (existing) {
    const startedAt = resumeInFlightStarted.get(sessionId) ?? 0;
    const age = Date.now() - startedAt;
    if (age > RESUME_IN_FLIGHT_TIMEOUT_MS) {
      logDelivery(`Resume in-flight for ${sessionId.slice(0, 8)} is stale (${Math.round(age / 1000)}s), clearing and retrying`);
      resumeInFlight.delete(sessionId);
      resumeInFlightStarted.delete(sessionId);
    } else {
      logDelivery(`Resume already in flight for ${sessionId.slice(0, 8)}, waiting (age=${Math.round(age / 1000)}s)...`);
      try {
        const result = await Promise.race([
          existing,
          new Promise((_, reject) => setTimeout(() => reject(new Error("resume_timeout")), RESUME_IN_FLIGHT_TIMEOUT_MS - age))
        ]);
        if (result && content) {
          const tmuxSession = resumeSessionCache.get(sessionId);
          if (tmuxSession) {
            await injectViaTmux(tmuxSession + ":0.0", content);
            log(`Injected message to already-resumed session ${sessionId.slice(0, 8)}`);
          }
        }
        return result;
      } catch (err) {
        if (err instanceof Error && err.message === "resume_timeout") {
          logDelivery(`Resume in-flight timed out for ${sessionId.slice(0, 8)}, clearing and retrying`);
          resumeInFlight.delete(sessionId);
          resumeInFlightStarted.delete(sessionId);
        } else {
          throw err;
        }
      }
    }
  }
  const promise = autoResumeSessionInner(sessionId, content, titleCache, nonInteractive, cwdOverride, conversationId);
  resumeInFlight.set(sessionId, promise);
  resumeInFlightStarted.set(sessionId, Date.now());
  try {
    return await promise;
  } finally {
    resumeInFlight.delete(sessionId);
    resumeInFlightStarted.delete(sessionId);
  }
}
async function autoResumeSessionInner(sessionId, content, titleCache, nonInteractive = false, cwdOverride, conversationId) {
  if (!hasTmux()) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: tmux not installed`);
    return false;
  }
  const sessionFile = findSessionFile(sessionId);
  if (!sessionFile) {
    logDelivery(`Cannot auto-resume ${sessionId.slice(0, 8)}: session JSONL file not found`);
    return false;
  }
  const { path: jsonlPath, agentType } = sessionFile;
  const jsonlContent = readFileHead(jsonlPath, 5000);
  const config = readConfig();
  let cwd;
  let resumeCmd;
  const shortId = sessionId.slice(0, 8);
  const title = titleCache[sessionId] || extractSummaryTitle(jsonlContent);
  const slug = title ? slugify(title) : "";
  const validOverride = cwdOverride && fs14.existsSync(cwdOverride) ? cwdOverride : undefined;
  if (agentType === "codex") {
    cwd = validOverride || extractCodexCwd(jsonlContent) || process.env.HOME || "/tmp";
    let extraFlags = config?.codex_args || "";
    const permFlags = getPermissionFlags("codex", config);
    if (permFlags)
      extraFlags = extraFlags ? extraFlags + " " + permFlags : permFlags;
    resumeCmd = `codex resume ${sessionId}${extraFlags ? " " + extraFlags : ""}`;
  } else if (agentType === "gemini") {
    cwd = validOverride || process.env.HOME || "/tmp";
    resumeCmd = `gemini --resume latest`;
  } else {
    cwd = validOverride || extractCwd(jsonlContent) || process.env.HOME || "/tmp";
    let extraFlags = config?.claude_args || "";
    try {
      const firstUserLine = jsonlContent.split(`
`).find((l) => l.includes('"type":"user"'));
      if (firstUserLine) {
        const parsed = JSON.parse(firstUserLine);
        if (parsed.permissionMode === "bypassPermissions" && !extraFlags.includes("--dangerously-skip-permissions")) {
          extraFlags = extraFlags ? extraFlags + " --dangerously-skip-permissions" : "--dangerously-skip-permissions";
        }
      }
    } catch {
    }
    const permFlags = getPermissionFlags("claude", config);
    if (permFlags && !extraFlags.includes("--dangerously-skip-permissions") && !extraFlags.includes("--permission-mode")) {
      extraFlags = extraFlags ? extraFlags + " " + permFlags : permFlags;
    }
    resumeCmd = `claude --resume ${sessionId}${extraFlags ? " " + extraFlags : ""}`;
  }
  const prefix = agentType === "codex" ? "cx" : agentType === "gemini" ? "gm" : "cc";
  const tmuxSession = slug ? `${prefix}-resume-${slug}-${shortId}` : `${prefix}-resume-${shortId}`;
  try {
    try {
      await tmuxExec(["kill-session", "-t", tmuxSession]);
    } catch {
    }
    await tmuxExec(["new-session", "-d", "-s", tmuxSession, "-c", cwd]);
    if (nonInteractive && agentType === "claude") {
      const tmpFile = path13.join(os2.tmpdir(), `codecast-msg-${shortId}.txt`);
      fs14.writeFileSync(tmpFile, content);
      const nonInteractiveCmd = `env -u CLAUDECODE ${resumeCmd} -p "$(cat '${tmpFile}')" --output-format stream-json --verbose && rm -f '${tmpFile}'`;
      await tmuxExec(["send-keys", "-t", tmuxSession, "-l", nonInteractiveCmd]);
      await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);
      logDelivery(`Auto-resumed ${agentType} ${shortId} in tmux=${tmuxSession} (non-interactive) cwd=${cwd}`);
      const fatalErrors2 = [
        "No conversation found",
        "Session not found",
        "command not found",
        "cannot be launched inside another",
        "is not an object",
        "ENOENT"
      ];
      for (let i = 0;i < 20; i++) {
        await new Promise((resolve4) => setTimeout(resolve4, 500));
        try {
          const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-20"]);
          if (fatalErrors2.some((e) => paneContent.includes(e))) {
            logDelivery(`Auto-resume FATAL (non-interactive) for ${shortId}: ${paneContent.slice(0, 300)}`);
            try {
              await tmuxExec(["kill-session", "-t", tmuxSession]);
            } catch {
            }
            try {
              fs14.unlinkSync(tmpFile);
            } catch {
            }
            return false;
          }
          if (paneContent.includes('"type":"result"') || paneContent.includes('"type":"assistant"')) {
            logDelivery(`Agent ${shortId} (non-interactive) producing output after ${(i + 1) * 500}ms`);
            break;
          }
        } catch {
        }
      }
      resumeSessionCache.set(sessionId, tmuxSession);
      if (syncServiceRef) {
        syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {
        });
        syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {
        });
      }
      return true;
    }
    await tmuxExec(["send-keys", "-t", tmuxSession, "-l", `env -u CLAUDECODE ${resumeCmd}`]);
    await tmuxExec(["send-keys", "-t", tmuxSession, "Enter"]);
    logDelivery(`Auto-resumed ${agentType} ${shortId} in tmux=${tmuxSession} cwd=${cwd} cmd=${resumeCmd}`);
    resumeSessionCache.set(sessionId, tmuxSession);
    if (syncServiceRef) {
      syncServiceRef.registerManagedSession(sessionId, process.pid, tmuxSession, conversationId).catch(() => {
      });
      syncServiceRef.updateSessionAgentStatus(conversationId, "connected").catch(() => {
      });
      const existing = resumeHeartbeatIntervals.get(sessionId);
      if (existing)
        clearInterval(existing);
      const interval = setInterval(() => {
        syncServiceRef.heartbeatManagedSession(sessionId).catch(() => {
        });
      }, 30000);
      resumeHeartbeatIntervals.set(sessionId, interval);
      if (agentType === "codex" && conversationId) {
        startCodexPermissionPoller(sessionId, tmuxSession, conversationId, syncServiceRef);
      }
    }
    const fatalErrors = [
      "cannot be launched inside another",
      "command not found",
      "No such file or directory",
      "Session not found",
      "No conversation found",
      "is not an object",
      "ENOENT"
    ];
    const promptPattern = /[❯›]/;
    const startTime = Date.now();
    let ready = false;
    for (let i = 0;i < 60; i++) {
      await new Promise((resolve4) => setTimeout(resolve4, 250));
      try {
        const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-20"]);
        if (fatalErrors.some((e) => paneContent.includes(e))) {
          logDelivery(`Auto-resume FATAL for ${shortId}: agent crashed. Pane: ${paneContent.slice(0, 300)}`);
          try {
            await tmuxExec(["kill-session", "-t", tmuxSession]);
          } catch {
          }
          return false;
        }
        if (promptPattern.test(paneContent) && await isTmuxAgentAlive(tmuxSession)) {
          logDelivery(`Agent ${shortId} ready (prompt visible) after ${Date.now() - startTime}ms`);
          ready = true;
          break;
        }
      } catch {
      }
    }
    if (!ready) {
      logDelivery(`Agent ${shortId} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
    }
    if (ready || !content) {
      try {
        const { stdout: preInjectPane } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-15"]);
        const warningPatterns = /⚠|recorded with model|weekly limit|Update available|Press enter to continue/;
        if (warningPatterns.test(preInjectPane)) {
          logDelivery(`Clearing startup warnings for ${shortId} before injection`);
          await tmuxExec(["send-keys", "-t", tmuxSession, "Escape"]);
          await new Promise((resolve4) => setTimeout(resolve4, 300));
          for (let w = 0;w < 20; w++) {
            await new Promise((resolve4) => setTimeout(resolve4, 250));
            try {
              const { stdout: cleared } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-5"]);
              if (promptPattern.test(cleared.split(`
`).slice(-3).join(`
`)))
                break;
            } catch {
            }
          }
        }
      } catch {
      }
    }
    if (content) {
      await injectViaTmux(tmuxSession + ":0.0", content);
      log(`Injected message to auto-resumed ${agentType} session ${shortId}`);
    } else {
      log(`Auto-resumed ${agentType} session ${shortId} (no message to inject)`);
    }
    return true;
  } catch (err) {
    logDelivery(`Auto-resume EXCEPTION ${agentType} ${shortId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
var repairAttempts = new Map;
var REPAIR_COOLDOWN_MS = 10 * 60 * 1000;
async function repairAndResumeSession(sessionId, content, titleCache, nonInteractive, cwdOverride, conversationId) {
  const lastAttempt = repairAttempts.get(sessionId);
  if (lastAttempt && Date.now() - lastAttempt < REPAIR_COOLDOWN_MS) {
    log(`Repair cooldown active for ${sessionId.slice(0, 8)}, skipping`);
    return false;
  }
  repairAttempts.set(sessionId, Date.now());
  const config = readConfig();
  if (!config?.convex_url || !config?.auth_token) {
    log(`Cannot repair session: missing config`);
    return false;
  }
  const convId = conversationId || (() => {
    const cache = readConversationCache();
    return cache[sessionId];
  })();
  if (!convId) {
    log(`Cannot repair ${sessionId.slice(0, 8)}: no conversation_id found`);
    return false;
  }
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  try {
    log(`Repairing session ${sessionId.slice(0, 8)} via Convex regeneration...`);
    const exportData = await fetchExport(siteUrl, config.auth_token, convId);
    if (exportData.messages.length === 0) {
      log(`Repair aborted for ${sessionId.slice(0, 8)}: conversation has 0 messages, nothing to resume`);
      return false;
    }
    const sessionFile = findSessionFile(sessionId);
    const isCodexSession = sessionFile?.agentType === "codex";
    let jsonl;
    let tailMessages;
    if (isCodexSession) {
      ({ jsonl } = generateCodexJsonl(exportData, { sessionId }));
    } else {
      const TOKEN_BUDGET = 1e5;
      tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      ({ jsonl } = generateClaudeCodeJsonl(exportData, { tailMessages, sessionId }));
    }
    const projectPath = cwdOverride || exportData.conversation.project_path || undefined;
    if (sessionFile) {
      const bakPath = sessionFile.path + ".bak";
      if (!fs14.existsSync(bakPath)) {
        fs14.copyFileSync(sessionFile.path, bakPath);
      }
      fs14.writeFileSync(sessionFile.path, jsonl);
      if (isCodexSession) {
        log(`Repaired Codex JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages)`);
      } else {
        log(`Repaired JSONL for ${sessionId.slice(0, 8)} (${exportData.messages.length} messages, tail=${tailMessages})`);
      }
    } else {
      if (isCodexSession) {
        writeCodexSession(jsonl, sessionId, "rollout");
        log(`Wrote new Codex session file for ${sessionId.slice(0, 8)}`);
      } else {
        writeClaudeCodeSession(jsonl, sessionId, projectPath);
        log(`Wrote new session file for ${sessionId.slice(0, 8)}`);
      }
    }
    const resumed = await autoResumeSession(sessionId, content, titleCache, nonInteractive, cwdOverride || projectPath, convId);
    if (resumed) {
      log(`Repair + resume succeeded for ${sessionId.slice(0, 8)}`);
      return true;
    }
  } catch (err) {
    log(`Convex regeneration failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const sessionFile = findSessionFile(sessionId);
    if (!sessionFile)
      return false;
    log(`Attempting surgical JSONL cleanup for ${sessionId.slice(0, 8)}...`);
    const lines = fs14.readFileSync(sessionFile.path, "utf-8").split(`
`).filter((l) => l.trim());
    const cleanLines = [];
    let removed = 0;
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        const content2 = parsed.message?.content;
        if (Array.isArray(content2)) {
          const hasCorruptToolResult = content2.some((c) => c.type === "tool_result" && c.content && typeof c.content === "string" && (c.content.includes("is not an object") || c.content.includes("undefined")));
          if (hasCorruptToolResult) {
            removed++;
            continue;
          }
        }
        cleanLines.push(line);
      } catch {
        cleanLines.push(line);
      }
    }
    if (removed > 0) {
      const bakPath = sessionFile.path + ".bak";
      if (!fs14.existsSync(bakPath)) {
        fs14.copyFileSync(sessionFile.path, bakPath);
      }
      fs14.writeFileSync(sessionFile.path, cleanLines.join(`
`) + `
`);
      log(`Surgical cleanup: removed ${removed} corrupt entries from ${sessionId.slice(0, 8)}`);
      const resumed = await autoResumeSession(sessionId, content, titleCache, nonInteractive, cwdOverride, convId);
      if (resumed) {
        log(`Surgical repair + resume succeeded for ${sessionId.slice(0, 8)}`);
        return true;
      }
    }
  } catch (err) {
    log(`Surgical cleanup failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return false;
}
async function postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService2, titleCache, conversationCache) {
  await new Promise((resolve4) => setTimeout(resolve4, 15000));
  if (resumeInFlight.has(sessionId)) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, resume in flight`);
    return;
  }
  const restartTs = restartingSessionIds.get(sessionId);
  if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
    log(`Health check: skipping for ${sessionId.slice(0, 8)}, restart in progress`);
    return;
  }
  const tmuxSession = resumeSessionCache.get(sessionId);
  if (!tmuxSession)
    return;
  try {
    await tmuxExec(["has-session", "-t", tmuxSession]);
  } catch {
    log(`Health check: tmux session ${tmuxSession} is dead after delivery for ${sessionId.slice(0, 8)}`);
    const repaired = await repairAndResumeSession(sessionId, content, titleCache, false, undefined, conversationId);
    if (repaired) {
      log(`Health check: repaired and re-delivered message for ${sessionId.slice(0, 8)}`);
      try {
        await syncService2.setSessionError(conversationId);
      } catch {
      }
    } else {
      log(`Health check: repair failed for ${sessionId.slice(0, 8)}, retrying message delivery`);
      try {
        await syncService2.retryMessage(messageId);
        await syncService2.setSessionError(conversationId, "Session crashed — retrying message delivery");
      } catch {
      }
    }
    return;
  }
  const alive = await isTmuxAgentAlive(tmuxSession);
  if (!alive) {
    log(`Health check: agent process dead in ${tmuxSession} for ${sessionId.slice(0, 8)}`);
    try {
      await tmuxExec(["kill-session", "-t", tmuxSession]);
    } catch {
    }
    resumeSessionCache.delete(sessionId);
    stopCodexPermissionPoller(sessionId);
    const hbInterval = resumeHeartbeatIntervals.get(sessionId);
    if (hbInterval) {
      clearInterval(hbInterval);
      resumeHeartbeatIntervals.delete(sessionId);
    }
    const repaired = await repairAndResumeSession(sessionId, content, titleCache, false, undefined, conversationId);
    if (repaired) {
      log(`Health check: repaired crashed session ${sessionId.slice(0, 8)}`);
      try {
        await syncService2.setSessionError(conversationId);
      } catch {
      }
    } else {
      log(`Health check: repair failed for crashed session ${sessionId.slice(0, 8)}, retrying message delivery`);
      try {
        await syncService2.retryMessage(messageId);
        await syncService2.setSessionError(conversationId, "Session crashed — retrying message delivery");
      } catch {
      }
    }
  } else {
    log(`Health check: session ${sessionId.slice(0, 8)} is healthy`);
    try {
      await syncService2.setSessionError(conversationId);
    } catch {
    }
  }
}
var materializeFailures = new Map;
var materializeInFlight = new Map;
var materializedSessions = new Set;
var MATERIALIZE_COOLDOWN_MS = 5 * 60 * 1000;
async function materializeSession(conversationId, conversationCache, titleCache, syncService2) {
  const existing = materializeInFlight.get(conversationId);
  if (existing)
    return existing;
  const lastFail = materializeFailures.get(conversationId);
  if (lastFail && Date.now() - lastFail < MATERIALIZE_COOLDOWN_MS) {
    return null;
  }
  const config = readConfig();
  if (!config?.convex_url || !config?.auth_token) {
    logDelivery(`Cannot materialize: missing convex_url or auth_token`);
    return null;
  }
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const promise = (async () => {
    try {
      logDelivery(`Materializing session for conv=${conversationId.slice(0, 12)}...`);
      const exportData = await fetchExport(siteUrl, config.auth_token, conversationId);
      if (exportData.messages.length === 0) {
        logDelivery(`Materialization skipped for ${conversationId.slice(0, 12)}: 0 messages (session_id=${exportData.conversation?.session_id?.slice(0, 8) || "none"})`);
        return null;
      }
      const TOKEN_BUDGET = 1e5;
      const tailMessages = chooseClaudeTailMessagesForTokenBudget(exportData, TOKEN_BUDGET);
      const { jsonl, sessionId } = generateClaudeCodeJsonl(exportData, { tailMessages });
      const projectPath = exportData.conversation.project_path || undefined;
      writeClaudeCodeSession(jsonl, sessionId, projectPath);
      conversationCache[sessionId] = conversationId;
      saveConversationCache(conversationCache);
      materializedSessions.add(sessionId);
      if (exportData.conversation.title) {
        titleCache[sessionId] = exportData.conversation.title;
        saveTitleCache(titleCache);
      }
      if (syncService2) {
        syncService2.updateSessionId(conversationId, sessionId).catch(() => {
        });
      }
      logDelivery(`Materialized session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)} (${exportData.messages.length} msgs, tail=${tailMessages})`);
      return sessionId;
    } catch (err) {
      logDelivery(`Materialization FAILED for ${conversationId.slice(0, 12)}: ${err instanceof Error ? err.message : String(err)}`);
      materializeFailures.set(conversationId, Date.now());
      return null;
    } finally {
      materializeInFlight.delete(conversationId);
    }
  })();
  materializeInFlight.set(conversationId, promise);
  return promise;
}
async function downloadImage(storageId, syncService2) {
  const destPath = `/tmp/codecast/images/${storageId}.png`;
  if (fs14.existsSync(destPath))
    return destPath;
  const imageUrl = await syncService2.getClient().query("images:getImageUrl", { storageId });
  if (!imageUrl)
    return null;
  const dir = path13.dirname(destPath);
  fs14.mkdirSync(dir, { recursive: true });
  const resp = await fetch(imageUrl);
  if (!resp.ok)
    throw new Error(`HTTP ${resp.status}`);
  fs14.writeFileSync(destPath, Buffer.from(await resp.arrayBuffer()));
  return destPath;
}
async function deliverMessage(conversationId, content, conversationCache, syncService2, messageId, titleCache) {
  logDelivery(`deliverMessage called: conv=${conversationId.slice(0, 12)} msgId=${messageId.slice(0, 12)} content="${content.slice(0, 80)}"`);
  const childConvId = planHandoffChildren.get(conversationId);
  if (childConvId) {
    logDelivery(`Redirecting message from plan parent ${conversationId.slice(0, 12)} to child ${childConvId.slice(0, 12)}`);
    return deliverMessage(childConvId, content, conversationCache, syncService2, messageId, titleCache);
  }
  const reverseCache = buildReverseConversationCache(conversationCache);
  let sessionId = reverseCache[conversationId];
  pendingInteractivePrompts.delete(sessionId || conversationId);
  if (!sessionId) {
    const cacheKeys = Object.keys(conversationCache);
    const reverseKeys = Object.keys(reverseCache);
    logDelivery(`No session in cache for conv=${conversationId.slice(0, 12)}, cache has ${cacheKeys.length} sessions/${reverseKeys.length} convs, startedTmux has ${startedSessionTmux.size} entries`);
    const tryStartedTmux = async (entry) => {
      try {
        await tmuxExec(["has-session", "-t", entry.tmuxSession]);
        const promptPattern = entry.agentType === "codex" ? />\s*$/ : entry.agentType === "gemini" ? />\s*$|gemini/i : /❯|⏵/;
        const fatalErrors = [
          "cannot be launched inside another",
          "command not found",
          "No such file or directory",
          "ENOENT"
        ];
        let ready = false;
        const startTime = Date.now();
        const trustPromptPatterns = /trust this folder|safety check|Is this a project/i;
        for (let i = 0;i < 60; i++) {
          await new Promise((resolve4) => setTimeout(resolve4, 250));
          try {
            const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", entry.tmuxSession, "-S", "-20"]);
            if (fatalErrors.some((e) => paneContent.includes(e))) {
              log(`Started session ${entry.tmuxSession} hit fatal error, falling through. Pane: ${paneContent.slice(0, 200)}`);
              startedSessionTmux.delete(conversationId);
              return false;
            }
            if (trustPromptPatterns.test(paneContent)) {
              log(`Started session ${entry.tmuxSession} showing trust prompt, sending Enter to accept`);
              await tmuxExec(["send-keys", "-t", entry.tmuxSession, "Enter"]);
              await new Promise((resolve4) => setTimeout(resolve4, 2000));
              continue;
            }
            if (promptPattern.test(paneContent)) {
              const lastLines = paneContent.split(`
`).slice(-10).join(`
`);
              if (trustPromptPatterns.test(lastLines))
                continue;
              log(`Started session ${entry.tmuxSession} ready (prompt visible) after ${Date.now() - startTime}ms`);
              ready = true;
              break;
            }
          } catch {
          }
        }
        if (!ready) {
          log(`Started session ${entry.tmuxSession} startup timed out after ${Date.now() - startTime}ms, proceeding anyway`);
        }
        await new Promise((resolve4) => setTimeout(resolve4, 1500));
        const startedTmuxTarget = entry.tmuxSession + ":0.0";
        await injectViaTmux(startedTmuxTarget, content);
        await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        log(`Delivered message to started session tmux ${entry.tmuxSession} for conversation ${conversationId.slice(0, 12)}`);
        if (content.trimStart().startsWith("/")) {
          checkForInteractivePrompt(startedTmuxTarget, conversationId, conversationId, syncService2).catch(() => {
          });
        }
        return true;
      } catch (err) {
        log(`Started session tmux ${entry.tmuxSession} not reachable, falling through: ${err instanceof Error ? err.message : String(err)}`);
        startedSessionTmux.delete(conversationId);
        return false;
      }
    };
    const started = startedSessionTmux.get(conversationId);
    if (started && await tryStartedTmux(started))
      return true;
    const freshCache = readConversationCache();
    const freshReverse = buildReverseConversationCache(freshCache);
    sessionId = freshReverse[conversationId];
    if (sessionId) {
      conversationCache[sessionId] = conversationId;
      log(`Found session ${sessionId.slice(0, 8)} for conversation ${conversationId.slice(0, 12)} via disk cache refresh`);
    } else if (!started) {
      logDelivery(`Waiting up to 12s for start_session to populate startedSessionTmux for conv=${conversationId.slice(0, 12)}`);
      for (let i = 0;i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const justStarted = startedSessionTmux.get(conversationId);
        if (justStarted) {
          log(`Found startedSessionTmux for ${conversationId.slice(0, 12)} after ${(i + 1) * 500}ms wait`);
          if (await tryStartedTmux(justStarted))
            return true;
          break;
        }
        const recheckCache = readConversationCache();
        const recheckReverse = buildReverseConversationCache(recheckCache);
        if (recheckReverse[conversationId]) {
          sessionId = recheckReverse[conversationId];
          conversationCache[sessionId] = conversationId;
          log(`Found session ${sessionId.slice(0, 8)} for ${conversationId.slice(0, 12)} via disk cache on wait iteration ${i + 1}`);
          break;
        }
      }
      if (!sessionId) {
        log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
        sessionId = await materializeSession(conversationId, conversationCache, titleCache, syncService2);
        if (!sessionId) {
          log(`Cannot deliver: no local session and materialization failed for ${conversationId}`);
          return false;
        }
      }
    } else {
      log(`No session_id in local cache for conversation ${conversationId}, attempting to materialize from server...`);
      sessionId = await materializeSession(conversationId, conversationCache, titleCache, syncService2);
      if (!sessionId) {
        logDelivery(`Cannot deliver: no local session and materialization failed for conv=${conversationId.slice(0, 12)}`);
        return false;
      }
    }
  }
  const isCursorSession = sessionId.startsWith("cursor-");
  const isGeminiSession = sessionId.startsWith("session-");
  if (isCursorSession) {
    logDelivery(`Session ${sessionId.slice(0, 20)} is Cursor IDE, cannot inject - skipping`);
    return false;
  }
  let detectedType = isGeminiSession ? "gemini" : "claude";
  if (!isGeminiSession) {
    const sessionFile = findSessionFile(sessionId);
    if (sessionFile)
      detectedType = sessionFile.agentType;
  }
  logDelivery(`Delivering to session=${sessionId.slice(0, 12)} conv=${conversationId.slice(0, 12)} type=${detectedType}`);
  const cachedTmux = resumeSessionCache.get(sessionId);
  if (cachedTmux) {
    logDelivery(`Found cached tmux=${cachedTmux} for session=${sessionId.slice(0, 12)}`);
    try {
      await tmuxExec(["has-session", "-t", cachedTmux]);
      if (!await isTmuxAgentAlive(cachedTmux)) {
        logDelivery(`Cached tmux ${cachedTmux} has no live agent, clearing cache`);
        resumeSessionCache.delete(sessionId);
        stopCodexPermissionPoller(sessionId);
        const hbInterval = resumeHeartbeatIntervals.get(sessionId);
        if (hbInterval) {
          clearInterval(hbInterval);
          resumeHeartbeatIntervals.delete(sessionId);
        }
        try {
          await tmuxExec(["kill-session", "-t", cachedTmux]);
        } catch {
        }
      } else {
        await injectViaTmux(cachedTmux, content);
        await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
        syncService2.setSessionError(conversationId).catch(() => {
        });
        if (content.trimStart().startsWith("/")) {
          checkForInteractivePrompt(cachedTmux, sessionId, conversationId, syncService2).catch(() => {
          });
        }
        return true;
      }
    } catch {
      resumeSessionCache.delete(sessionId);
      stopCodexPermissionPoller(sessionId);
      const hbInterval = resumeHeartbeatIntervals.get(sessionId);
      if (hbInterval) {
        clearInterval(hbInterval);
        resumeHeartbeatIntervals.delete(sessionId);
      }
    }
  }
  const isMaterialized = materializedSessions.has(sessionId);
  logDelivery(`Finding process: materialized=${isMaterialized} session=${sessionId.slice(0, 12)}`);
  const proc = isMaterialized ? null : await findSessionProcess(sessionId, detectedType);
  if (proc) {
    logDelivery(`Found process pid=${proc.pid} tty=${proc.tty} for session=${sessionId.slice(0, 12)}`);
    if (!isAgentProcess(proc.pid)) {
      logDelivery(`Process ${proc.pid} is no longer an agent process, clearing cache`);
      sessionProcessCache.delete(sessionId);
    } else {
      const tmuxTarget = await findTmuxPaneForTty(proc.tty);
      logDelivery(`tmux pane for tty=${proc.tty}: ${tmuxTarget ?? "not found"}`);
      let agentDetectedDead = false;
      if (tmuxTarget) {
        try {
          await injectViaTmux(tmuxTarget, content);
          const tmuxSessionName = tmuxTarget.split(":")[0];
          const agentAlive = await isTmuxAgentAlive(tmuxSessionName);
          if (!agentAlive) {
            logDelivery(`Agent in ${tmuxTarget} is dead after injection, falling through to auto-resume`);
            sessionProcessCache.delete(sessionId);
            agentDetectedDead = true;
          } else {
            await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
            logDelivery(`Delivered via tmux ${tmuxTarget}`);
            if (content.trimStart().startsWith("/")) {
              checkForInteractivePrompt(tmuxTarget, sessionId, conversationId, syncService2).catch(() => {
              });
            }
            return true;
          }
        } catch (err) {
          logDelivery(`tmux injection failed for ${tmuxTarget}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (!agentDetectedDead) {
        const termLabel = proc.termProgram === "Apple_Terminal" ? "Terminal.app" : "iTerm2";
        logDelivery(`Trying ${termLabel} injection for tty=${proc.tty}`);
        try {
          await injectViaTerminal(proc.tty, content, proc.termProgram);
          await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
          logDelivery(`Delivered via ${termLabel} tty=${proc.tty}`);
          return true;
        } catch (err) {
          logDelivery(`${termLabel} injection failed for ${proc.tty}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      logDelivery(`All injection methods failed for live process pid=${proc.pid}, falling back to auto-resume`);
    }
  } else {
    logDelivery(`No running process found for session=${sessionId.slice(0, 12)} type=${detectedType}`);
  }
  const tmuxAvailable = hasTmux();
  logDelivery(`Attempting auto-resume: session=${sessionId.slice(0, 8)} tmux=${tmuxAvailable}`);
  if (!tmuxAvailable) {
    logDelivery(`CANNOT auto-resume: tmux is not installed. Install with: brew install tmux`);
  }
  const resumed = await autoResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (resumed) {
    materializedSessions.delete(sessionId);
    await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    logDelivery(`Delivered via auto-resume for session=${sessionId.slice(0, 8)}`);
    if (content.trimStart().startsWith("/")) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService2).catch(() => {
        });
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService2, titleCache, conversationCache).catch((err) => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }
  logDelivery(`Auto-resume failed for ${sessionId.slice(0, 8)}, attempting repair...`);
  const repaired = await repairAndResumeSession(sessionId, content, titleCache, isMaterialized, undefined, conversationId);
  if (repaired) {
    materializedSessions.delete(sessionId);
    await syncService2.updateMessageStatus({ messageId, status: "delivered", deliveredAt: Date.now() });
    logDelivery(`Delivered via repair+resume for session=${sessionId.slice(0, 8)}`);
    if (content.trimStart().startsWith("/")) {
      const resumeTmux = resumeSessionCache.get(sessionId);
      if (resumeTmux) {
        checkForInteractivePrompt(resumeTmux + ":0.0", sessionId, conversationId, syncService2).catch(() => {
        });
      }
    }
    postDeliveryHealthCheck(sessionId, conversationId, content, messageId, syncService2, titleCache, conversationCache).catch((err) => {
      log(`Health check error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return true;
  }
  logDelivery(`DELIVERY FAILED: all methods exhausted for session=${sessionId.slice(0, 8)} conv=${conversationId.slice(0, 12)}`);
  return false;
}
function isSyncPaused() {
  return process.env.CODE_CHAT_SYNC_PAUSED === "1" || process.env.CODECAST_PAUSED === "1";
}
async function repairProjectPaths(syncService2) {
  const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
  if (!fs14.existsSync(claudeProjectsDir))
    return;
  log("Checking for project paths that need repair...");
  const projectDirs = fs14.readdirSync(claudeProjectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  let repaired = 0;
  let checked = 0;
  for (const dir of projectDirs) {
    const dirPath = path13.join(claudeProjectsDir, dir);
    const sessionFiles = fs14.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl") && f !== "sessions-index.json");
    const decodedPath = decodeProjectDirName(dir);
    const resolvedDir = decodedPath && fs14.existsSync(decodedPath) ? decodedPath : null;
    for (const file of sessionFiles) {
      const filePath = path13.join(dirPath, file);
      const sessionId = resolveSessionId(filePath);
      try {
        checked++;
        let projectPath = resolvedDir;
        if (!projectPath) {
          const content = readFileHead(filePath, 5000);
          projectPath = extractCwd(content) || null;
        }
        if (!projectPath)
          continue;
        const gitInfo = getGitInfo(projectPath);
        const result = await syncService2.updateProjectPath(sessionId, projectPath, gitInfo?.root);
        if (result?.updated) {
          repaired++;
          log(`Repaired path for ${sessionId.slice(0, 8)}: ${projectPath}`);
        }
      } catch {
      }
    }
  }
  if (repaired > 0) {
    log(`Repaired ${repaired} project paths (checked ${checked})`);
  }
}
async function waitForConfig() {
  const checkInterval = 30000;
  while (true) {
    const config = readConfig();
    if (config?.user_id) {
      const convexUrl = config.convex_url || process.env.CONVEX_URL;
      if (convexUrl) {
        return { config, convexUrl };
      }
    }
    log("Waiting for configuration... (run 'cast auth' to set up)");
    await new Promise((resolve4) => setTimeout(resolve4, checkInterval));
  }
}
function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function isTmuxAgentAlive(tmuxSession) {
  if (!hasTmux())
    return false;
  try {
    const { stdout } = await tmuxExec(["list-panes", "-t", tmuxSession, "-F", "#{pane_pid}"], { timeout: 3000, killSignal: "SIGKILL" });
    const panePid = stdout.trim();
    if (!panePid)
      return false;
    try {
      await execAsync2(`pgrep -P ${panePid}`, { timeout: 3000, killSignal: "SIGKILL" });
      return true;
    } catch {
      try {
        const { stdout: paneContent } = await tmuxExec(["capture-pane", "-p", "-J", "-t", tmuxSession, "-S", "-5"], { timeout: 3000, killSignal: "SIGKILL" });
        const trimmed = paneContent.trim();
        if (/[$%#]\s*$/.test(trimmed))
          return false;
        if (/Segmentation fault|panic:|SIGABRT|core dumped|exited with/.test(trimmed))
          return false;
        if (/[❯›]|⏵|thinking|Thinking|working|Running|bypass permissions|permission/.test(trimmed)) {
          return true;
        }
      } catch {
      }
      return false;
    }
  } catch {
    return false;
  }
}
function isAgentProcess(pid) {
  try {
    const comm = execSync2(`ps -o comm= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
    if (!comm)
      return false;
    const agentPatterns = ["claude", "codex", "gemini", "node", "bun", "deno"];
    const lower = comm.toLowerCase();
    return agentPatterns.some((p) => lower.includes(p));
  } catch {
    return false;
  }
}
var skipRespawn = false;
function spawnReplacement() {
  try {
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CODECAST_RESTART: "1" }
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
var CRASH_FILE = path13.join(CONFIG_DIR5, "crash-count.json");
function recordCrash() {
  try {
    let crashes = { count: 0, firstCrash: Date.now() };
    if (fs14.existsSync(CRASH_FILE)) {
      crashes = JSON.parse(fs14.readFileSync(CRASH_FILE, "utf-8"));
    }
    const windowMs = 30 * 60 * 1000;
    if (Date.now() - crashes.firstCrash > windowMs) {
      crashes = { count: 0, firstCrash: Date.now() };
    }
    crashes.count++;
    fs14.writeFileSync(CRASH_FILE, JSON.stringify(crashes));
    const backoffMinutes = crashes.count <= 3 ? 0 : Math.min(crashes.count * 2, 30);
    return { count: crashes.count, backoffMinutes };
  } catch {
    return { count: 1, backoffMinutes: 0 };
  }
}
function clearCrashCount() {
  try {
    if (fs14.existsSync(CRASH_FILE))
      fs14.unlinkSync(CRASH_FILE);
  } catch {
  }
}
function acquireLock() {
  if (fs14.existsSync(PID_FILE)) {
    try {
      const existingPid = parseInt(fs14.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (existingPid === process.pid) {
        return true;
      }
      if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
        return false;
      }
    } catch {
    }
  }
  try {
    const pgrepOut = execSync2(`pgrep -f 'daemon\\.ts$' 2>/dev/null || true`, { encoding: "utf-8", timeout: 3000 });
    const pids = pgrepOut.trim().split(`
`).map(Number).filter((p) => p && p !== process.pid && isProcessRunning(p));
    for (const zombiePid of pids) {
      log(`Killing zombie daemon process ${zombiePid}`);
      try {
        process.kill(zombiePid, "SIGKILL");
      } catch {
      }
    }
  } catch {
  }
  fs14.writeFileSync(PID_FILE, String(process.pid), { mode: 384 });
  try {
    const writtenPid = parseInt(fs14.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (writtenPid !== process.pid)
      return false;
  } catch {
    return false;
  }
  return true;
}
function findStaleSessionFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
  const staleFiles = [];
  const now = Date.now();
  if (!fs14.existsSync(claudeProjectsDir)) {
    return staleFiles;
  }
  try {
    const projectDirs = fs14.readdirSync(claudeProjectsDir);
    for (const projectDir of projectDirs) {
      const projectPath = path13.join(claudeProjectsDir, projectDir);
      const stat4 = fs14.statSync(projectPath);
      if (!stat4.isDirectory())
        continue;
      const files = fs14.readdirSync(projectPath);
      for (const file of files) {
        if (!file.endsWith(".jsonl"))
          continue;
        const filePath = path13.join(projectPath, file);
        try {
          const fileStat = fs14.statSync(filePath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs)
            continue;
          const syncRecord = getSyncRecord(filePath);
          if (shouldTreatClaudeFileAsStale(fileStat, syncRecord)) {
            staleFiles.push(filePath);
          }
        } catch {
        }
      }
    }
  } catch (err) {
    log(`Watchdog: Error scanning for stale files: ${err instanceof Error ? err.message : String(err)}`);
  }
  return staleFiles;
}
function shouldTreatClaudeFileAsStale(fileStat, syncRecord) {
  if (!syncRecord) {
    return true;
  }
  if (!syncRecord.isLegacyFallback && fileStat.mtimeMs > syncRecord.lastSyncedAt) {
    return true;
  }
  return fileStat.size > syncRecord.lastSyncedPosition;
}
function findStaleCodexSessionFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const codexSessionsDir = path13.join(process.env.HOME || "", ".codex", "sessions");
  const staleFiles = [];
  const now = Date.now();
  if (!fs14.existsSync(codexSessionsDir)) {
    return staleFiles;
  }
  const scanDir = (dir) => {
    let entries;
    try {
      entries = fs14.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path13.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const fileStat = fs14.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs)
            continue;
          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            staleFiles.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  };
  scanDir(codexSessionsDir);
  return staleFiles;
}
function detectCursorPath() {
  const platform3 = process.platform;
  const home = process.env.HOME || "";
  if (platform3 === "darwin") {
    return path13.join(home, "Library", "Application Support", "Cursor");
  } else if (platform3 === "linux") {
    return path13.join(home, ".config", "Cursor");
  } else if (platform3 === "win32") {
    return path13.join(process.env.APPDATA || "", "Cursor");
  }
  return path13.join(home, ".cursor");
}
function getCursorWorkspaceStoragePath() {
  const cursorPath = detectCursorPath();
  const workspaceStoragePath = path13.join(cursorPath, "User", "workspaceStorage");
  if (!fs14.existsSync(workspaceStoragePath)) {
    return null;
  }
  return workspaceStoragePath;
}
function getCursorWorkspaceFolderPath(workspaceStorageDir) {
  const workspaceJsonPath = path13.join(workspaceStorageDir, "workspace.json");
  try {
    if (!fs14.existsSync(workspaceJsonPath)) {
      return null;
    }
    const content = fs14.readFileSync(workspaceJsonPath, "utf-8");
    const data = JSON.parse(content);
    const folderUri = data.folder || data.workspace;
    if (!folderUri) {
      return null;
    }
    if (folderUri.startsWith("file://")) {
      const decoded = decodeURIComponent(folderUri.slice(7));
      if (process.platform === "win32" && decoded.match(/^\/[A-Z]:/i)) {
        return decoded.slice(1);
      }
      return decoded;
    }
    return folderUri;
  } catch {
    return null;
  }
}
function getCursorMaxRowId(dbPath) {
  let db = null;
  try {
    db = new Database3(dbPath, { readonly: true });
    const tableExists = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='ItemTable'").get();
    if (!tableExists) {
      return 0;
    }
    const maxRowIdResult = db.query("SELECT MAX(rowid) as maxRowId FROM ItemTable WHERE key = 'workbench.panel.aichat.view.aichat.chatdata'").get();
    return maxRowIdResult?.maxRowId ?? 0;
  } catch {
    return 0;
  } finally {
    if (db) {
      db.close();
    }
  }
}
function getCursorComposerData(dbPath) {
  let db = null;
  try {
    db = new Database3(dbPath, { readonly: true });
    const row = db.query("SELECT value FROM ItemTable WHERE key = 'composer.composerData' LIMIT 1").get();
    if (!row?.value) {
      return null;
    }
    return JSON.parse(row.value);
  } catch {
    return null;
  } finally {
    if (db) {
      db.close();
    }
  }
}
function findWorkspacePathForCursorConversation(sessionId) {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  if (!workspaceStoragePath) {
    return null;
  }
  let workspaceDirs;
  try {
    workspaceDirs = fs14.readdirSync(workspaceStoragePath);
  } catch {
    return null;
  }
  for (const workspaceHash of workspaceDirs) {
    const dbPath = path13.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs14.existsSync(dbPath)) {
      continue;
    }
    const composerData = getCursorComposerData(dbPath);
    const composers = composerData?.allComposers || [];
    if (!composers.some((c) => c.composerId === sessionId)) {
      continue;
    }
    const workspaceStorageDir = path13.dirname(dbPath);
    return getCursorWorkspaceFolderPath(workspaceStorageDir);
  }
  return null;
}
function findStaleCursorSessions(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const workspaceStoragePath = getCursorWorkspaceStoragePath();
  const staleSessions = [];
  const now = Date.now();
  if (!workspaceStoragePath) {
    return staleSessions;
  }
  let workspaceDirs;
  try {
    workspaceDirs = fs14.readdirSync(workspaceStoragePath);
  } catch {
    return staleSessions;
  }
  for (const workspaceHash of workspaceDirs) {
    const dbPath = path13.join(workspaceStoragePath, workspaceHash, "state.vscdb");
    if (!fs14.existsSync(dbPath)) {
      continue;
    }
    try {
      const stat4 = fs14.statSync(dbPath);
      const fileAge = now - stat4.mtimeMs;
      if (fileAge > maxAgeMs)
        continue;
      const maxRowId = getCursorMaxRowId(dbPath);
      if (maxRowId <= 0)
        continue;
      const lastRowId = getPosition(dbPath);
      if (maxRowId <= lastRowId)
        continue;
      const workspaceStorageDir = path13.dirname(dbPath);
      const workspacePath = getCursorWorkspaceFolderPath(workspaceStorageDir) || workspaceHash;
      staleSessions.push({
        sessionId: workspaceHash,
        workspacePath,
        dbPath
      });
    } catch {
      continue;
    }
  }
  return staleSessions;
}
function findStaleCursorTranscriptFiles(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  const cursorProjectsDir = path13.join(process.env.HOME || "", ".cursor", "projects");
  const staleFiles = [];
  const now = Date.now();
  if (!fs14.existsSync(cursorProjectsDir)) {
    return staleFiles;
  }
  const scanDir = (dir) => {
    let entries;
    try {
      entries = fs14.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path13.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".txt")) {
        if (!fullPath.includes(`${path13.sep}agent-transcripts${path13.sep}`)) {
          continue;
        }
        try {
          const fileStat = fs14.statSync(fullPath);
          const fileAge = now - fileStat.mtimeMs;
          if (fileAge > maxAgeMs)
            continue;
          const lastPosition = getPosition(fullPath);
          if (fileStat.size !== lastPosition) {
            staleFiles.push(fullPath);
          }
        } catch {
          continue;
        }
      }
    }
  };
  scanDir(cursorProjectsDir);
  return staleFiles;
}
function compareVersions(a, b) {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  for (let i = 0;i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA > numB)
      return 1;
    if (numA < numB)
      return -1;
  }
  return 0;
}
async function checkForForcedUpdate(syncService2) {
  try {
    const minVersion = await syncService2.getMinCliVersion();
    if (!minVersion)
      return false;
    const currentVersion = getVersion();
    if (compareVersions(currentVersion, minVersion) < 0) {
      logLifecycle("forced_update_start", `current=${currentVersion} min=${minVersion}`);
      await flushRemoteLogs();
      const success = await performUpdate();
      if (success) {
        logLifecycle("forced_update_complete", `Binary replaced from v${currentVersion}, target>=${minVersion}`);
        await flushRemoteLogs();
        spawnReplacement();
        await new Promise((resolve4) => setTimeout(resolve4, 500));
        process.exit(0);
      } else {
        logLifecycle("forced_update_failed", `current=${currentVersion} target>=${minVersion}`);
        await flushRemoteLogs();
      }
      return true;
    }
    return false;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logError(`Forced update check failed`, err instanceof Error ? err : undefined);
    return false;
  }
}
function checkDiskVersionMismatch() {
  try {
    const updateTsPath = path13.join(__dirname, "update.ts");
    const updateJsPath = path13.join(__dirname, "update.js");
    const filePath = fs14.existsSync(updateTsPath) ? updateTsPath : updateJsPath;
    if (!fs14.existsSync(filePath))
      return;
    const content = fs14.readFileSync(filePath, "utf-8");
    const match = content.match(/const VERSION\s*=\s*["']([^"']+)["']/);
    if (!match)
      return;
    const diskVersion = match[1];
    if (diskVersion !== daemonVersion) {
      log(`Disk version mismatch: running=${daemonVersion} disk=${diskVersion}, restarting`);
      logLifecycle("version_mismatch_restart", `${daemonVersion} -> ${diskVersion}`);
      flushRemoteLogs().then(() => {
        const spawned = spawnReplacement();
        if (spawned)
          skipRespawn = true;
        setTimeout(() => process.exit(0), 500);
      }).catch(() => {
        const spawned = spawnReplacement();
        if (spawned)
          skipRespawn = true;
        setTimeout(() => process.exit(0), 500);
      });
    }
  } catch {
  }
}
function startEventLoopMonitor() {
  let lastTickTime2 = Date.now();
  return setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickTime2;
    lastTickTime2 = now;
    saveDaemonState({ lastHeartbeatTick: now });
    if (elapsed > EVENT_LOOP_LAG_THRESHOLD_MS) {
      logLifecycle("wake_detected", `System was suspended for ${Math.round(elapsed / 1000)}s, recovering`);
      lastWatcherEventTime = 0;
    }
  }, EVENT_LOOP_CHECK_INTERVAL_MS);
}
function startVersionChecker(syncService2) {
  checkForForcedUpdate(syncService2);
  return setInterval(() => {
    checkForForcedUpdate(syncService2);
  }, VERSION_CHECK_INTERVAL_MS);
}
function logHealthReport(retryQueue) {
  const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
  const unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
  const droppedOps = retryQueue.getDroppedOperations();
  const queueSize = retryQueue.getQueueSize();
  if (unsyncedFiles.length > 0 || droppedOps.length > 0 || queueSize > 10) {
    logWarn(`Health: ${unsyncedFiles.length} pending files, ${droppedOps.length} dropped ops, ${queueSize} in retry queue`);
  }
}
function startReconciliation(syncService2, retryQueue) {
  log("Reconciliation scheduler started (runs every hour)");
  setTimeout(async () => {
    try {
      logHealthReport(retryQueue);
      const result = await performReconciliation(syncService2, (msg, level) => log(msg, level || "info"));
      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Initial reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, 5 * 60 * 1000);
  return setInterval(async () => {
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    try {
      logHealthReport(retryQueue);
      const result = await performReconciliation(syncService2, (msg, level) => log(msg, level || "info"));
      if (result.discrepancies.length > 0) {
        logWarn(`Reconciliation found ${result.discrepancies.length} discrepancies`);
        const repaired = await repairDiscrepancies(result.discrepancies, log);
        log(`Reconciliation: Reset ${repaired} sessions for re-sync`);
      }
    } catch (err) {
      logError("Reconciliation failed", err instanceof Error ? err : new Error(String(err)));
    }
  }, RECONCILIATION_INTERVAL_MS);
}
function startWatchdog(deps) {
  log("Watchdog started");
  let watchdogRunning = false;
  return setInterval(async () => {
    if (watchdogRunning || isInWakeGrace())
      return;
    watchdogRunning = true;
    try {
      const state = readDaemonState();
      const now = Date.now();
      saveDaemonState({ lastWatchdogCheck: now });
      if (state?.authExpired) {
        return;
      }
      if (isSyncPaused()) {
        return;
      }
      validateProcessCache();
      for (const [convId, entry] of startedSessionTmux.entries()) {
        if (now - entry.startedAt > STARTED_SESSION_TTL_MS) {
          try {
            await tmuxExec(["has-session", "-t", entry.tmuxSession], { timeout: 3000, killSignal: "SIGKILL" });
            if (!await isTmuxAgentAlive(entry.tmuxSession)) {
              log(`Pruning started session ${entry.tmuxSession}: agent dead (zombie shell)`);
              try {
                await tmuxExec(["kill-session", "-t", entry.tmuxSession]);
              } catch {
              }
              startedSessionTmux.delete(convId);
            }
          } catch {
            startedSessionTmux.delete(convId);
          }
        }
      }
      const activeStartedTmux = new Set([...startedSessionTmux.values()].map((e) => e.tmuxSession));
      try {
        const { stdout: tmuxList } = await tmuxExec(["list-sessions", "-F", "#{session_name}"], { timeout: 3000, killSignal: "SIGKILL" });
        for (const tmuxName of tmuxList.trim().split(`
`)) {
          if (!tmuxName || !/^cc-resume-/.test(tmuxName) && !/^cc-claude-/.test(tmuxName))
            continue;
          if (activeStartedTmux.has(tmuxName))
            continue;
          if (!await isTmuxAgentAlive(tmuxName)) {
            log(`Reaping zombie tmux session ${tmuxName}`);
            try {
              await tmuxExec(["kill-session", "-t", tmuxName]);
            } catch {
            }
          }
        }
      } catch {
      }
      try {
        const statusDir = AGENT_STATUS_DIR;
        if (fs14.existsSync(statusDir)) {
          const IDLE_STALE_MS = 10 * 60 * 1000;
          const ACTIVE_STALE_MS = 30 * 60 * 1000;
          for (const file of fs14.readdirSync(statusDir)) {
            if (!file.endsWith(".json"))
              continue;
            const sessionId = file.replace(".json", "");
            const filePath = path13.join(statusDir, file);
            try {
              const raw = fs14.readFileSync(filePath, "utf-8");
              const data = JSON.parse(raw);
              if (!data.ts)
                continue;
              const ageMs = now - data.ts * 1000;
              const threshold = data.status === "idle" || data.status === "stopped" ? IDLE_STALE_MS : ACTIVE_STALE_MS;
              if (ageMs < threshold)
                continue;
              const convId = deps.conversationCache[sessionId];
              if (!convId) {
                try {
                  fs14.unlinkSync(filePath);
                } catch {
                }
                continue;
              }
              log(`Watchdog: stale ${data.status} session ${sessionId.slice(0, 8)} (${Math.round(ageMs / 60000)}min), marking completed`);
              deps.syncService.markSessionCompleted(convId).catch(() => {
              });
              sendAgentStatus(deps.syncService, convId, sessionId, "stopped");
              try {
                fs14.unlinkSync(filePath);
              } catch {
              }
            } catch {
            }
          }
        }
      } catch {
      }
      const watcherIdleMinutes = Math.floor((now - lastWatcherEventTime) / 60000);
      if (watcherIdleMinutes >= 60) {
        log(`Watcher idle for ${watcherIdleMinutes}min, restarting`);
        try {
          deps.watcher.restart();
          lastWatcherEventTime = now;
          log(`Watcher restarted successfully`);
        } catch (err) {
          logError("Failed to restart watcher", err instanceof Error ? err : new Error(String(err)));
        }
      }
      const staleClaudeFiles = findStaleSessionFiles();
      const staleCodexFiles = findStaleCodexSessionFiles();
      const staleCursorSessions = findStaleCursorSessions();
      const staleCursorTranscriptFiles = findStaleCursorTranscriptFiles();
      const totalStale = staleClaudeFiles.length + staleCodexFiles.length + staleCursorSessions.length + staleCursorTranscriptFiles.length;
      if (totalStale === 0) {
        return;
      }
      log(`Watchdog: Detected ${totalStale} files needing sync`);
      const currentRestarts = state?.watchdogRestarts || 0;
      saveDaemonState({ watchdogRestarts: currentRestarts + 1 });
      for (const filePath of staleClaudeFiles) {
        const parts = filePath.split(path13.sep);
        const sessionId = resolveSessionId(filePath);
        const projectDirName = parts[parts.length - 2];
        const decoded = decodeProjectDirName(projectDirName);
        const projectPath = decoded && fs14.existsSync(decoded) ? decoded : projectDirName.replace(/-/g, path13.sep).replace(/^-/, "");
        if (deps.config.excluded_paths && isPathExcluded(projectPath, deps.config.excluded_paths)) {
          continue;
        }
        if (!isProjectAllowedToSync(projectPath, deps.config)) {
          continue;
        }
        log(`Watchdog: Syncing stale session ${sessionId}`);
        await processSessionFile(filePath, sessionId, projectPath, deps.syncService, deps.config.user_id, deps.config.team_id, deps.conversationCache, deps.retryQueue, deps.pendingMessages, deps.titleCache, deps.updateState);
      }
      for (const filePath of staleCodexFiles) {
        const filename = path13.basename(filePath, ".jsonl");
        const match = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
        const sessionId = match ? match[1] : filename;
        log(`Watchdog: Syncing stale Codex session ${sessionId}`);
        await processCodexSession(filePath, sessionId, deps.syncService, deps.config.user_id, deps.config.team_id, deps.conversationCache, deps.retryQueue, deps.pendingMessages, deps.titleCache, deps.updateState);
      }
      for (const cursorSession of staleCursorSessions) {
        if (deps.config.excluded_paths && isPathExcluded(cursorSession.workspacePath, deps.config.excluded_paths)) {
          continue;
        }
        if (!isProjectAllowedToSync(cursorSession.workspacePath, deps.config)) {
          continue;
        }
        log(`Watchdog: Syncing stale Cursor session ${cursorSession.sessionId}`);
        await processCursorSession(cursorSession.dbPath, cursorSession.sessionId, cursorSession.workspacePath, deps.syncService, deps.config.user_id, deps.config.team_id, deps.conversationCache, deps.retryQueue, deps.pendingMessages, deps.updateState);
      }
      for (const filePath of staleCursorTranscriptFiles) {
        const sessionId = path13.basename(filePath, ".txt");
        const workspacePath = findWorkspacePathForCursorConversation(sessionId);
        if (workspacePath) {
          if (deps.config.excluded_paths && isPathExcluded(workspacePath, deps.config.excluded_paths)) {
            continue;
          }
          if (!isProjectAllowedToSync(workspacePath, deps.config)) {
            continue;
          }
        } else if (deps.config.sync_mode === "selected") {
          continue;
        }
        log(`Watchdog: Syncing stale Cursor transcript ${sessionId}`);
        await processCursorTranscriptFile(filePath, sessionId, deps.syncService, deps.config.user_id, deps.config.team_id, deps.conversationCache, deps.retryQueue, deps.pendingMessages, deps.updateState);
      }
      log(`Watchdog: Sync completed for ${totalStale} files`);
    } finally {
      watchdogRunning = false;
    }
  }, WATCHDOG_INTERVAL_MS);
}
async function main() {
  ensureConfigDir3();
  ensureCastAlias();
  if (!acquireLock()) {
    const existingPid = fs14.readFileSync(PID_FILE, "utf-8").trim();
    console.error(`Daemon already running (PID: ${existingPid}). Exiting.`);
    process.exit(0);
  }
  const underLaunchd = !!process.env.XPC_SERVICE_NAME;
  process.on("exit", (code2) => {
    persistLogQueue();
    if (skipRespawn || underLaunchd)
      return;
    if (code2 !== 0) {
      const { count, backoffMinutes } = recordCrash();
      if (backoffMinutes > 0) {
        try {
          fs14.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] CRASH LOOP: ${count} crashes, backing off ${backoffMinutes}min before respawn
`);
        } catch {
        }
        try {
          spawn("sh", ["-c", `sleep ${backoffMinutes * 60} && "${process.execPath}" ${process.argv.slice(1).map((a) => `"${a}"`).join(" ")}`], {
            detached: true,
            stdio: "ignore",
            env: { ...process.env, CODECAST_RESTART: "1" }
          }).unref();
        } catch {
        }
        return;
      }
    } else {
      clearCrashCount();
    }
    try {
      spawn(process.execPath, process.argv.slice(1), {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" }
      }).unref();
    } catch {
    }
  });
  process.on("uncaughtException", async (err) => {
    logError("Uncaught exception", err);
    persistLogQueue();
    sendLogImmediate("error", `UNCAUGHT EXCEPTION: ${err.message}`, {
      error_code: err.name,
      stack: err.stack?.slice(0, 1000)
    });
    await flushRemoteLogs().catch(() => {
    });
    process.exit(1);
  });
  process.on("unhandledRejection", async (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logError("Unhandled rejection", err);
    await flushRemoteLogs().catch(() => {
    });
  });
  try {
    daemonVersion = getVersion();
  } catch {
    daemonVersion = "unknown";
  }
  try {
    fs14.writeFileSync(VERSION_FILE, daemonVersion, { mode: 384 });
  } catch {
  }
  activeConfig = readConfig();
  loadPersistedLogQueue();
  let crashRecoveryInfo = "";
  if (fs14.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs14.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 0) {
        crashRecoveryInfo = ` (recovered from ${crashes.count} crashes)`;
      }
    } catch {
    }
  }
  clearCrashCount();
  const isRestart = process.env.CODECAST_RESTART === "1";
  const startMsg = `v${daemonVersion} PID=${process.pid}${isRestart ? " (restart after update)" : ""}${crashRecoveryInfo}`;
  logLifecycle("daemon_start", startMsg);
  sendLogImmediate("info", `[LIFECYCLE] daemon_start: ${startMsg}`, { error_code: "daemon_start" });
  log(`PID: ${process.pid}`);
  if (isSyncPaused()) {
    log("⚠️  Sync is PAUSED via environment variable (CODE_CHAT_SYNC_PAUSED or CODECAST_PAUSED)");
  }
  saveDaemonState({ connected: false, runtimeVersion: getVersion() });
  const { config, convexUrl } = await waitForConfig();
  activeConfig = config;
  log(`User ID: ${config.user_id}`);
  log(`Convex URL: ${convexUrl}`);
  if (config.auth_token) {
    log(`Auth token: ${maskToken(config.auth_token)}`);
  }
  if (config.excluded_paths) {
    log(`Excluded paths: ${config.excluded_paths}`);
  }
  const syncService2 = new SyncService({
    convexUrl,
    authToken: config.auth_token,
    userId: config.user_id
  });
  syncServiceRef = syncService2;
  try {
    const didUpdate = await checkForForcedUpdate(syncService2);
    if (didUpdate)
      return;
  } catch (err) {
    log(`Startup update check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  repairProjectPaths(syncService2).catch((err) => {
    log(`Failed to repair project paths: ${err instanceof Error ? err.message : String(err)}`);
  });
  setInterval(() => {
    flushRemoteLogs().catch(() => {
    });
  }, LOG_FLUSH_INTERVAL_MS);
  setInterval(() => {
    logHealthSummary();
    sendHeartbeat().catch(() => {
    });
    checkDiskVersionMismatch();
  }, HEALTH_REPORT_INTERVAL_MS);
  setInterval(() => {
    pollDaemonCommands().catch(() => {
    });
  }, 1e4);
  sendHeartbeat().catch(() => {
  });
  const taskScheduler = new TaskScheduler({
    syncService: syncService2,
    config,
    log
  });
  taskScheduler.start();
  const conversationCache = readConversationCache();
  const titleCache = readTitleCache();
  const pendingMessages = {};
  const activeSessions = new Map;
  const retryQueue = new RetryQueue({
    initialDelayMs: 3000,
    maxDelayMs: 60000,
    maxAttempts: 15,
    persistPath: `${CONFIG_DIR5}/retry-queue.json`,
    droppedPath: `${CONFIG_DIR5}/dropped-operations.json`,
    onLog: (message, level) => log(message, level || "info")
  });
  const updateState = () => {
    saveDaemonState({
      lastSyncTime: Date.now(),
      pendingQueueSize: retryQueue.getQueueSize()
    });
  };
  retryQueue.setExecutor(async (op) => {
    if (op.type === "createConversation") {
      const params = op.params;
      const conversationId = await syncService2.createConversation(params);
      conversationCache[params.sessionId] = conversationId;
      saveConversationCache(conversationCache);
      log(`Retry: Created conversation ${conversationId} for session ${params.sessionId}`);
      if (pendingMessages[params.sessionId]) {
        await flushPendingMessagesBatch(pendingMessages[params.sessionId], conversationId, syncService2, retryQueue);
        delete pendingMessages[params.sessionId];
      }
      updateState();
      return true;
    }
    if (op.type === "addMessage") {
      const params = op.params;
      await syncService2.addMessage(params);
      updateState();
      return true;
    }
    return false;
  });
  retryQueue.start();
  const watcher = new SessionWatcher;
  const fileSyncs = new Map;
  watcher.on("ready", () => {
    log("Session watcher ready (depth=2)");
  });
  watcher.on("session", (event) => {
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    if (isSyncPaused()) {
      log(`Sync paused, skipping session: ${event.sessionId}`);
      return;
    }
    if (isPathExcluded(event.projectPath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${event.projectPath}`);
      return;
    }
    if (!isProjectAllowedToSync(event.projectPath, config)) {
      log(`Skipping sync for non-selected project: ${event.projectPath}`);
      return;
    }
    let sync = fileSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processSessionFile(filePath, event.sessionId, event.projectPath, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, titleCache, updateState);
      });
      fileSyncs.set(filePath, sync);
    }
    sync.invalidate();
  });
  watcher.on("error", (error) => {
    logError("Watcher error", error);
  });
  watcher.start();
  fs14.mkdirSync(AGENT_STATUS_DIR, { recursive: true });
  const statusWatcher = watch(AGENT_STATUS_DIR, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    depth: 0
  });
  statusWatcher.on("add", handleStatusFile).on("change", handleStatusFile);
  function handleStatusFile(filePath) {
    try {
      const basename8 = path13.basename(filePath, ".json");
      if (!basename8 || !filePath.endsWith(".json"))
        return;
      const sessionId = basename8;
      const raw = fs14.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      if (!data.status || !data.ts)
        return;
      const convId = conversationCache[sessionId];
      if (!convId)
        return;
      const prev = lastHookStatus.get(sessionId);
      if (prev && prev.ts >= data.ts)
        return;
      const statusChanged = !prev || prev.status !== data.status;
      const modeChanged = data.permission_mode && (!prev || prev.permission_mode !== data.permission_mode);
      lastHookStatus.set(sessionId, data);
      if (data.status === "compacting" || data.status === "idle" || data.status === "thinking" || data.status === "stopped") {
        const existingTimer = idleTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          idleTimers.delete(sessionId);
        }
      }
      if (statusChanged || modeChanged) {
        sendAgentStatus(syncService2, convId, sessionId, data.status, data.ts * 1000, data.permission_mode);
        log(`Hook status: ${data.status}${data.permission_mode ? ` mode=${data.permission_mode}` : ""} for session ${sessionId.slice(0, 8)}`);
      }
      if (data.status === "stopped" && statusChanged) {
        const restartTs = restartingSessionIds.get(sessionId);
        if (restartTs && Date.now() - restartTs < RESTART_GUARD_TTL_MS) {
          log(`Session ended for ${sessionId.slice(0, 8)}, but restart in progress — skipping completion`);
          try {
            fs14.unlinkSync(filePath);
          } catch {
          }
        } else {
          log(`Session ended for ${sessionId.slice(0, 8)}, marking completed`);
          syncService2.markSessionCompleted(convId).catch(() => {
          });
          try {
            fs14.unlinkSync(filePath);
          } catch {
          }
        }
      }
      if (data.status === "permission_blocked" && statusChanged && !permissionRecordPending.has(sessionId)) {
        permissionRecordPending.add(sessionId);
        permissionJustResolved.add(sessionId);
        const transcriptPath = data.transcript_path || findTranscriptForSession(sessionId);
        const toolInfo = extractPendingToolUseFromTranscript(transcriptPath || "");
        const toolName = toolInfo?.tool_name || extractToolFromMessage(data.message || "");
        const preview = toolInfo?.arguments_preview || data.message || "";
        const SKIP_TOOLS = new Set(["AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
        if (toolName && !SKIP_TOOLS.has(toolName)) {
          log(`Creating permission record: ${toolName} for session ${sessionId.slice(0, 8)}`);
          const permPrompt = { tool_name: toolName, arguments_preview: preview };
          syncService2.createSessionNotification({
            conversation_id: convId,
            type: "permission_request",
            title: "codecast - Permission needed",
            message: truncateForNotification(`${toolName}: ${preview}`, 150)
          }).catch(() => {
          });
          handlePermissionRequest(syncService2, convId, sessionId, permPrompt, log).then((decision) => {
            permissionRecordPending.delete(sessionId);
            if (decision) {
              const response = decision.approved ? "y" : "n";
              log(`Permission ${decision.approved ? "approved" : "denied"} for session ${sessionId.slice(0, 8)}, injecting '${response}'`);
              findSessionProcess(sessionId, detectSessionAgentType(sessionId)).then((proc) => {
                if (!proc) {
                  log("No process found for permission injection");
                  return;
                }
                findTmuxPaneForTty(proc.tty).then((tmuxTarget) => {
                  const inject = tmuxTarget ? () => injectViaTmux(tmuxTarget, response) : () => injectViaTerminal(proc.tty, response, proc.termProgram);
                  inject().then(() => {
                    log(`Injected '${response}' for session ${sessionId.slice(0, 8)}`);
                    sendAgentStatus(syncService2, convId, sessionId, "working");
                  }).catch((err) => {
                    log(`Failed to inject permission: ${err instanceof Error ? err.message : String(err)}`);
                  });
                });
              }).catch((err) => {
                log(`Failed to find session process: ${err instanceof Error ? err.message : String(err)}`);
              });
            }
          }).catch((err) => {
            permissionRecordPending.delete(sessionId);
            log(`Permission handling error: ${err instanceof Error ? err.message : String(err)}`);
          });
        } else {
          permissionRecordPending.delete(sessionId);
        }
      }
      if (data.status !== "permission_blocked" && prev?.status === "permission_blocked") {
        permissionRecordPending.delete(sessionId);
      }
    } catch {
    }
  }
  function extractToolFromMessage(message) {
    const m = message.match(/permission to use (\w+)/i) || message.match(/allow (\w+)/i);
    return m?.[1] || "Bash";
  }
  function findTranscriptForSession(sessionId) {
    const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
    try {
      const dirs = fs14.readdirSync(claudeProjectsDir);
      for (const dir of dirs) {
        const jsonlPath = path13.join(claudeProjectsDir, dir, `${sessionId}.jsonl`);
        if (fs14.existsSync(jsonlPath))
          return jsonlPath;
      }
    } catch {
    }
    return null;
  }
  const statusCleanupInterval = setInterval(() => {
    try {
      const files = fs14.readdirSync(AGENT_STATUS_DIR);
      const cutoff = Date.now() - 60 * 60 * 1000;
      for (const file of files) {
        const fp = path13.join(AGENT_STATUS_DIR, file);
        const stat4 = fs14.statSync(fp);
        if (stat4.mtimeMs < cutoff) {
          fs14.unlinkSync(fp);
          lastHookStatus.delete(path13.basename(file, ".json"));
        }
      }
    } catch {
    }
  }, 30 * 60 * 1000);
  const performStartupScan = async () => {
    const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
    if (!fs14.existsSync(claudeProjectsDir)) {
      log("Startup scan: No projects directory found, skipping");
      return;
    }
    let unsyncedFiles = [];
    try {
      unsyncedFiles = findUnsyncedFiles(claudeProjectsDir);
    } catch (err) {
      logError("Startup scan failed to find unsynced files", err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (unsyncedFiles.length > 0) {
      log(`Startup scan: Found ${unsyncedFiles.length} files needing sync`);
      for (const filePath of unsyncedFiles) {
        const parts = filePath.split(path13.sep);
        const sessionId = resolveSessionId(filePath);
        const isSubagentFile = parts.includes("subagents");
        let projectDirName;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          projectDirName = parts[subagentsIdx - 2] || parts[parts.length - 2];
        } else {
          projectDirName = parts[parts.length - 2];
        }
        const decoded = decodeProjectDirName(projectDirName);
        const projectPath = decoded && fs14.existsSync(decoded) ? decoded : projectDirName.replace(/-/g, path13.sep).replace(/^-/, "");
        if (config.excluded_paths && isPathExcluded(projectPath, config.excluded_paths)) {
          continue;
        }
        if (!isProjectAllowedToSync(projectPath, config)) {
          continue;
        }
        let parentConversationId;
        if (isSubagentFile) {
          const subagentsIdx = parts.lastIndexOf("subagents");
          const parentSessionId = parts[subagentsIdx - 1];
          if (parentSessionId && conversationCache[parentSessionId]) {
            parentConversationId = conversationCache[parentSessionId];
          }
        }
        log(`Startup scan: Syncing ${sessionId}${parentConversationId ? ` (subagent of ${parentConversationId})` : ""}`);
        await processSessionFile(filePath, sessionId, projectPath, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, titleCache, updateState, parentConversationId);
      }
      for (const [childSessionId, parentSessionId] of pendingSubagentParents) {
        const parentConvId = conversationCache[parentSessionId];
        const childConvId = conversationCache[childSessionId];
        if (parentConvId && childConvId) {
          syncService2.linkSessions(parentConvId, childConvId).then(() => {
            log(`Startup scan: Linked subagent ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
          }).catch((err) => {
            log(`Startup scan: Failed to link subagent ${childSessionId.slice(0, 8)}: ${err}`);
          });
          pendingSubagentParents.delete(childSessionId);
        }
      }
      log(`Startup scan: Completed syncing ${unsyncedFiles.length} files`);
    } else {
      log("Startup scan: All files up to date");
    }
  };
  performStartupScan().then(async () => {
    const claudeProjectsDir = path13.join(process.env.HOME || "", ".claude", "projects");
    let linked = 0;
    const alreadyLinked = new Set(planHandoffChildren.values());
    for (const [childSessionId, childConvId] of Object.entries(conversationCache)) {
      if (alreadyLinked.has(childConvId))
        continue;
      const possiblePaths = [
        path13.join(claudeProjectsDir, `-Users-ashot-src-codecast`, `${childSessionId}.jsonl`)
      ];
      try {
        const projDirs = fs14.readdirSync(claudeProjectsDir);
        for (const dir of projDirs) {
          const fp = path13.join(claudeProjectsDir, dir, `${childSessionId}.jsonl`);
          if (fs14.existsSync(fp) && !possiblePaths.includes(fp)) {
            possiblePaths.push(fp);
          }
        }
      } catch {
      }
      for (const fp of possiblePaths) {
        if (!fs14.existsSync(fp))
          continue;
        try {
          const headContent = readFileHead(fp, 16384);
          const msgs = parseSessionFile(headContent);
          const userMsgs = msgs.filter((m) => m.role === "user").slice(0, 3);
          for (const msg of userMsgs) {
            if (!msg.content)
              continue;
            const handoffMatch = msg.content.match(/read the full transcript at:\s*([^\s]+\.jsonl)/i);
            if (handoffMatch) {
              const jsonlPath = handoffMatch[1];
              const parentMatch = jsonlPath.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
              if (parentMatch) {
                const parentSessionId = parentMatch[1];
                const parentConvId = conversationCache[parentSessionId];
                if (parentConvId && parentConvId !== childConvId) {
                  try {
                    await syncService2.linkPlanHandoff(parentConvId, childConvId);
                    planHandoffChildren.set(parentConvId, childConvId);
                    linked++;
                    log(`Backfill: linked plan handoff ${childSessionId.slice(0, 8)} -> parent ${parentSessionId.slice(0, 8)}`);
                  } catch (err) {
                    log(`Backfill: failed to link ${childSessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
                  }
                }
              }
              break;
            }
          }
        } catch {
        }
        break;
      }
    }
    if (linked > 0)
      log(`Backfill: linked ${linked} plan handoff session(s)`);
  }).catch((err) => {
    logError("Startup scan failed", err instanceof Error ? err : new Error(String(err)));
  });
  const watchdogInterval = startWatchdog({
    config,
    syncService: syncService2,
    conversationCache,
    retryQueue,
    pendingMessages,
    titleCache,
    updateState,
    watcher
  });
  const versionCheckInterval = startVersionChecker(syncService2);
  const reconciliationInterval = startReconciliation(syncService2, retryQueue);
  const eventLoopMonitorInterval = startEventLoopMonitor();
  const cursorWatcher = new CursorWatcher;
  const cursorSyncs = new Map;
  cursorWatcher.on("ready", () => {
    log("Cursor watcher ready");
  });
  cursorWatcher.on("session", (event) => {
    const dbPath = event.dbPath;
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor session: ${event.sessionId}`);
      return;
    }
    if (isPathExcluded(event.workspacePath, config.excluded_paths)) {
      log(`Skipping sync for excluded path: ${event.workspacePath}`);
      return;
    }
    if (!isProjectAllowedToSync(event.workspacePath, config)) {
      log(`Skipping sync for non-selected project: ${event.workspacePath}`);
      return;
    }
    let sync = cursorSyncs.get(dbPath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorSession(dbPath, event.sessionId, event.workspacePath, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, updateState);
      });
      cursorSyncs.set(dbPath, sync);
    }
    sync.invalidate();
  });
  cursorWatcher.on("error", (error) => {
    logError("Cursor watcher error", error);
  });
  cursorWatcher.start();
  const cursorTranscriptWatcher = new CursorTranscriptWatcher;
  const cursorTranscriptSyncs = new Map;
  cursorTranscriptWatcher.on("ready", () => {
    log("Cursor transcript watcher ready");
  });
  cursorTranscriptWatcher.on("session", (event) => {
    const filePath = event.filePath;
    lastWatcherEventTime = Date.now();
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    if (isSyncPaused()) {
      log(`Sync paused, skipping Cursor transcript: ${event.sessionId}`);
      return;
    }
    const workspacePath = findWorkspacePathForCursorConversation(event.sessionId);
    if (workspacePath) {
      if (isPathExcluded(workspacePath, config.excluded_paths)) {
        log(`Skipping sync for excluded path: ${workspacePath}`);
        return;
      }
      if (!isProjectAllowedToSync(workspacePath, config)) {
        log(`Skipping sync for non-selected project: ${workspacePath}`);
        return;
      }
    } else if (config.sync_mode === "selected") {
      log(`Skipping Cursor transcript with unknown workspace path: ${event.sessionId}`);
      return;
    }
    let sync = cursorTranscriptSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCursorTranscriptFile(filePath, event.sessionId, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, updateState);
      });
      cursorTranscriptSyncs.set(filePath, sync);
    }
    sync.invalidate();
  });
  cursorTranscriptWatcher.on("error", (error) => {
    logError("Cursor transcript watcher error", error);
  });
  cursorTranscriptWatcher.start();
  const codexWatcher = new CodexWatcher;
  const codexSyncs = new Map;
  codexWatcher.on("ready", () => {
    log("Codex watcher ready");
  });
  codexWatcher.on("session", (event) => {
    const filePath = event.filePath;
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    if (isSyncPaused()) {
      log(`Sync paused, skipping Codex session: ${event.sessionId}`);
      return;
    }
    let sync = codexSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processCodexSession(filePath, event.sessionId, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, titleCache, updateState);
      });
      codexSyncs.set(filePath, sync);
    }
    sync.invalidate();
  });
  codexWatcher.on("error", (error) => {
    logError("Codex watcher error", error);
  });
  codexWatcher.start();
  const geminiWatcher = new GeminiWatcher;
  const geminiSyncs = new Map;
  geminiWatcher.on("ready", () => {
    log("Gemini watcher ready");
  });
  geminiWatcher.on("session", (event) => {
    const filePath = event.filePath;
    const state = readDaemonState();
    if (state?.authExpired) {
      return;
    }
    if (isSyncPaused()) {
      log(`Sync paused, skipping Gemini session: ${event.sessionId}`);
      return;
    }
    let sync = geminiSyncs.get(filePath);
    if (!sync) {
      sync = new InvalidateSync(async () => {
        await processGeminiSession(filePath, event.sessionId, event.projectHash, syncService2, config.user_id, config.team_id, conversationCache, retryQueue, pendingMessages, titleCache, updateState);
      });
      geminiSyncs.set(filePath, sync);
    }
    sync.invalidate();
  });
  geminiWatcher.on("error", (error) => {
    logError("Gemini watcher error", error);
  });
  geminiWatcher.start();
  const subscriptionClient = syncService2.getSubscriptionClient();
  let unsubscribe = null;
  let permissionUnsubscribe = null;
  let commandUnsubscribe = null;
  const processedPermissionIds = new Set;
  const processedCommandIds = new Set;
  const messageRetryTimers = new Set;
  function scheduleMessageRetry(messageId, retryCount, conversationId, messageContent) {
    if (messageRetryTimers.has(messageId))
      return;
    if (retryCount >= 10) {
      logDelivery(`msg=${messageId.slice(0, 8)} exceeded max retries (10), marking undeliverable`);
      syncService2.updateMessageStatus({ messageId, status: "undeliverable" }).catch(() => {
      });
      return;
    }
    const delays = [1000, 5000, 15000, 30000, 60000];
    const delay2 = delays[Math.min(retryCount, delays.length - 1)];
    logDelivery(`Scheduling retry ${retryCount + 1}/10 for msg=${messageId.slice(0, 8)} in ${delay2 / 1000}s`);
    messageRetryTimers.add(messageId);
    setTimeout(async () => {
      messageRetryTimers.delete(messageId);
      try {
        await syncService2.retryMessage(messageId);
        logDelivery(`Retry ${retryCount + 1} triggered for msg=${messageId.slice(0, 8)}`);
      } catch (err) {
        logDelivery(`Retry trigger failed for msg=${messageId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, delay2);
  }
  const messagesInFlight = new Set;
  const setupSubscription = () => {
    try {
      logDelivery("Setting up pending messages subscription");
      unsubscribe = subscriptionClient.onUpdate("pendingMessages:getPendingMessages", { user_id: config.user_id, api_token: config.auth_token }, async (messages) => {
        if (!messages) {
          return;
        }
        if (Array.isArray(messages)) {
          if (messages.length > 0) {
            logDelivery(`Subscription: ${messages.length} pending message(s) received`);
          }
          for (const msg of messages) {
            if (messagesInFlight.has(msg._id)) {
              logDelivery(`Skipping msg=${msg._id.slice(0, 8)} - already in flight`);
              continue;
            }
            messagesInFlight.add(msg._id);
            const imageIds = msg.image_storage_ids ?? (msg.image_storage_id ? [msg.image_storage_id] : []);
            logDelivery(`Processing: msg=${msg._id.slice(0, 8)} conv=${msg.conversation_id.slice(0, 12)} content="${msg.content.slice(0, 80)}" images=${imageIds.length} retry=${msg.retry_count ?? 0}`);
            let messageContent = msg.content;
            if (imageIds.length > 0) {
              const imagePaths = [];
              for (const storageId of imageIds) {
                try {
                  const imagePath = await downloadImage(storageId, syncService2);
                  if (imagePath) {
                    imagePaths.push(imagePath);
                    log(`Downloaded image to ${imagePath}`);
                  }
                } catch (err) {
                  log(`Failed to download image: ${err instanceof Error ? err.message : String(err)}`);
                }
              }
              if (imagePaths.length > 0) {
                const realText = msg.content.replace(/^\[image\]$/i, "").trim();
                const imageTags = imagePaths.map((p) => `[Image ${p}]`).join(" ");
                messageContent = realText ? `${realText} ${imageTags}` : imageTags;
              }
            }
            syncService2.updateSessionAgentStatus(msg.conversation_id, "connected").catch(() => {
            });
            try {
              const delivered = await deliverMessage(msg.conversation_id, messageContent, conversationCache, syncService2, msg._id, titleCache);
              if (delivered) {
                logDelivery(`SUCCESS: msg=${msg._id.slice(0, 8)} delivered`);
              } else {
                logDelivery(`FAILED: msg=${msg._id.slice(0, 8)} delivery returned false, scheduling retry ${(msg.retry_count ?? 0) + 1}`);
                scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, messageContent);
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              logDelivery(`ERROR: msg=${msg._id.slice(0, 8)} exception: ${errMsg}`);
              scheduleMessageRetry(msg._id, msg.retry_count ?? 0, msg.conversation_id, msg.content);
            } finally {
              messagesInFlight.delete(msg._id);
            }
          }
        } else {
          log(`Received non-array: ${typeof messages}`);
        }
        resetReconnectDelay();
      });
      logDelivery("Pending messages subscription established");
      saveDaemonState({ connected: true });
      if (reconnectAttempt > 0) {
        sendLogImmediate("info", `[LIFECYCLE] connection_restored: after ${reconnectAttempt} attempts`, { error_code: "connection_restored" });
      }
      resetReconnectDelay();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Subscription error", error);
      saveDaemonState({ connected: false });
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      const delay2 = getReconnectDelay();
      logWarn(`Connection lost, reconnecting in ${delay2}ms (attempt ${reconnectAttempt})`);
      if (reconnectAttempt <= 3 || reconnectAttempt % 10 === 0) {
        sendLogImmediate("warn", `Connection lost, attempt ${reconnectAttempt}: ${error.message}`, {
          error_code: "connection_lost",
          stack: error.stack?.slice(0, 500)
        });
      }
      setTimeout(() => {
        setupSubscription();
      }, delay2);
    }
  };
  setupSubscription();
  const setupPermissionSubscription = () => {
    try {
      log("Setting up permission responses subscription");
      permissionUnsubscribe = subscriptionClient.onUpdate("permissions:getAllRespondedPermissions", { user_id: config.user_id, api_token: config.auth_token }, async (permissions) => {
        log(`Permission subscription update received: ${JSON.stringify(permissions)?.slice(0, 200)}`);
        if (!permissions || !Array.isArray(permissions)) {
          log("No permissions in update or invalid format");
          return;
        }
        for (const permission of permissions) {
          if (processedPermissionIds.has(permission._id)) {
            continue;
          }
          log(`New permission response: ${permission._id} status=${permission.status} tool=${permission.tool_name}`);
          try {
            const response = permission.status === "approved" ? "y" : "n";
            const sessionId = permission.session_id;
            let injected = false;
            if (sessionId) {
              const proc = await findSessionProcess(sessionId, detectSessionAgentType(sessionId));
              if (proc) {
                const tmuxTarget = await findTmuxPaneForTty(proc.tty);
                if (tmuxTarget) {
                  try {
                    await injectViaTmux(tmuxTarget, response);
                    injected = true;
                  } catch {
                  }
                }
                if (!injected) {
                  try {
                    await injectViaTerminal(proc.tty, response, proc.termProgram);
                    injected = true;
                  } catch {
                  }
                }
              }
            }
            if (injected) {
              log(`Injected permission response '${response}' for session ${sessionId?.slice(0, 8)}`);
              processedPermissionIds.add(permission._id);
            } else {
              log(`Failed to inject permission response, will retry on next update`);
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            log(`Error handling permission response: ${errMsg}`);
          }
        }
        resetReconnectDelay();
      });
      log("Permission subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Permission subscription error", error);
      if (permissionUnsubscribe) {
        permissionUnsubscribe();
        permissionUnsubscribe = null;
      }
      const delay2 = getReconnectDelay();
      logWarn(`Permission subscription lost, reconnecting in ${delay2}ms`);
      setTimeout(() => {
        setupPermissionSubscription();
      }, delay2);
    }
  };
  setupPermissionSubscription();
  const setupCommandSubscription = () => {
    try {
      log("Setting up daemon commands subscription");
      commandUnsubscribe = subscriptionClient.onUpdate("users:getMyPendingCommands", { api_token: config.auth_token }, async (commands) => {
        if (!commands || !Array.isArray(commands) || commands.length === 0) {
          return;
        }
        log(`Command subscription update: ${commands.length} pending command(s)`);
        for (const cmd of commands) {
          if (processedCommandIds.has(cmd.id)) {
            continue;
          }
          processedCommandIds.add(cmd.id);
          log(`[SUBSCRIPTION] Executing command: ${cmd.command} (${cmd.id})`);
          await executeRemoteCommand(cmd.id, cmd.command, config, cmd.args);
        }
        resetReconnectDelay();
      });
      log("Command subscription established successfully");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logError("Command subscription error", error);
      if (commandUnsubscribe) {
        commandUnsubscribe();
        commandUnsubscribe = null;
      }
      const delay2 = getReconnectDelay();
      logWarn(`Command subscription lost, reconnecting in ${delay2}ms`);
      setTimeout(() => {
        setupCommandSubscription();
      }, delay2);
    }
  };
  setupCommandSubscription();
  const shutdown = async () => {
    skipRespawn = true;
    log("Shutting down gracefully");
    const hardExitTimer = setTimeout(() => {
      try {
        fs14.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [CRITICAL] Hard exit after shutdown timeout
`);
      } catch {
      }
      try {
        fs14.unlinkSync(PID_FILE);
      } catch {
      }
      try {
        fs14.unlinkSync(VERSION_FILE);
      } catch {
      }
      process.exit(1);
    }, 15000);
    hardExitTimer.unref();
    saveDaemonState({ connected: false });
    if (unsubscribe) {
      unsubscribe();
    }
    if (permissionUnsubscribe) {
      permissionUnsubscribe();
    }
    if (commandUnsubscribe) {
      commandUnsubscribe();
    }
    clearInterval(watchdogInterval);
    clearInterval(versionCheckInterval);
    clearInterval(reconciliationInterval);
    clearInterval(eventLoopMonitorInterval);
    clearInterval(statusCleanupInterval);
    log("Watchdog and reconciliation stopped");
    statusWatcher.close();
    watcher.stop();
    cursorWatcher.stop();
    cursorTranscriptWatcher.stop();
    retryQueue.stop();
    const pendingOps = retryQueue.getQueueSize();
    if (pendingOps > 0) {
      log(`Dropping ${pendingOps} pending retry operations`);
    }
    for (const sync of fileSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorSyncs.values()) {
      sync.stop();
    }
    for (const sync of cursorTranscriptSyncs.values()) {
      sync.stop();
    }
    if (fs14.existsSync(PID_FILE)) {
      try {
        fs14.unlinkSync(PID_FILE);
        log("PID file removed");
      } catch (err) {
        log(`Failed to remove PID file: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    try {
      fs14.unlinkSync(VERSION_FILE);
    } catch {
    }
    logLifecycle("daemon_stop", "graceful shutdown");
    sendLogImmediate("info", "[LIFECYCLE] daemon_stop: graceful shutdown", { error_code: "daemon_stop" });
    await flushRemoteLogs();
    persistLogQueue();
    process.exit(0);
  };
  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });
  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      log(`Shutdown error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
  });
  await new Promise(() => {
  });
}
var daemonStarted = false;
async function runDaemon() {
  if (daemonStarted)
    return;
  daemonStarted = true;
  return main();
}
async function runWatchdog() {
  const config = readConfig();
  if (!config?.auth_token || !config?.convex_url) {
    process.exit(0);
  }
  const siteUrl = config.convex_url.replace(".cloud", ".site");
  const version2 = getVersion();
  const logLine = (msg) => {
    try {
      fs14.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [watchdog] ${msg}
`);
    } catch {
    }
  };
  if (fs14.existsSync(CRASH_FILE)) {
    try {
      const crashes = JSON.parse(fs14.readFileSync(CRASH_FILE, "utf-8"));
      if (crashes.count > 3) {
        await fetch(`${siteUrl}/cli/log`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_token: config.auth_token,
            level: "error",
            message: `CRASH LOOP: ${crashes.count} crashes since ${new Date(crashes.firstCrash).toISOString()}, watchdog reporting`,
            metadata: { error_code: "crash_loop" },
            cli_version: version2,
            platform: process.platform
          })
        }).catch(() => {
        });
      }
    } catch {
    }
  }
  let daemonAlive = false;
  let daemonPid = 0;
  if (fs14.existsSync(PID_FILE)) {
    try {
      daemonPid = parseInt(fs14.readFileSync(PID_FILE, "utf-8").trim(), 10);
      if (daemonPid > 0) {
        process.kill(daemonPid, 0);
        daemonAlive = true;
      }
    } catch {
      daemonAlive = false;
    }
  }
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const lastTick = state.lastHeartbeatTick || state.lastWatchdogCheck || 0;
      const staleness = Date.now() - lastTick;
      if (lastTick > 0 && staleness > HEARTBEAT_STALE_THRESHOLD_MS) {
        logLine(`Daemon PID ${daemonPid} is alive but event loop frozen for ${Math.round(staleness / 1000)}s, killing`);
        try {
          process.kill(daemonPid, 9);
        } catch {
        }
        await new Promise((resolve4) => setTimeout(resolve4, 1000));
        daemonAlive = false;
      }
    } catch {
    }
  }
  let commands = [];
  let minCliVersion;
  try {
    const response = await fetch(`${siteUrl}/cli/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        version: daemonAlive ? version2 : `${version2}-watchdog`,
        platform: process.platform,
        pid: 0,
        autostart_enabled: true
      })
    });
    if (response.ok) {
      const data = await response.json();
      commands = data.commands || [];
      minCliVersion = data.min_cli_version;
    }
  } catch {
  }
  const sendWatchdogLog = async (level, message) => {
    await fetch(`${siteUrl}/cli/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_token: config.auth_token,
        level,
        message,
        cli_version: `${version2}-watchdog`,
        platform: process.platform
      })
    }).catch(() => {
    });
  };
  if (minCliVersion && compareVersions(version2, minCliVersion) < 0) {
    logLine(`Binary outdated: current=${version2} min=${minCliVersion}, updating...`);
    await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_start: current=${version2} min=${minCliVersion}`);
    const success = await performUpdate();
    if (success) {
      logLine("Watchdog update successful");
      await sendWatchdogLog("info", `[LIFECYCLE] watchdog_update_complete: ${version2} -> ${minCliVersion}`);
      clearCrashCount();
      if (daemonAlive && daemonPid > 0) {
        logLine(`Killing outdated daemon PID ${daemonPid}`);
        try {
          process.kill(daemonPid, 15);
        } catch {
        }
        await new Promise((resolve4) => setTimeout(resolve4, 2000));
        daemonAlive = false;
      }
    } else {
      logLine("Watchdog update failed");
      await sendWatchdogLog("warn", `[LIFECYCLE] watchdog_update_failed: current=${version2} target>=${minCliVersion}`);
    }
  }
  if (daemonAlive && daemonPid > 0) {
    try {
      const state = readDaemonState();
      const daemonVersion2 = state.runtimeVersion;
      const needsKill = daemonVersion2 ? compareVersions(daemonVersion2, version2) < 0 : !!(minCliVersion && compareVersions(version2, minCliVersion) >= 0);
      if (needsKill) {
        logLine(`Daemon running v${daemonVersion2 || "unknown"} but binary is v${version2}, killing to upgrade`);
        await sendWatchdogLog("info", `[LIFECYCLE] watchdog_version_mismatch: daemon=${daemonVersion2 || "unknown"} binary=${version2}, killing`);
        try {
          process.kill(daemonPid, 15);
        } catch {
        }
        await new Promise((resolve4) => setTimeout(resolve4, 2000));
        daemonAlive = false;
      }
    } catch {
    }
  }
  if (!daemonAlive) {
    logLine("Daemon not running, restarting...");
    const updateCmd = commands.find((c) => c.command === "force_update");
    if (updateCmd) {
      logLine("Force update pending, updating before restart...");
      const success = await performUpdate();
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: updateCmd.id,
          result: success ? "Updated by watchdog" : undefined,
          error: success ? undefined : "Watchdog update failed"
        })
      }).catch(() => {
      });
      if (success) {
        logLine("Update successful");
        clearCrashCount();
      }
      commands = commands.filter((c) => c.id !== updateCmd.id);
    }
    for (const cmd of commands) {
      await fetch(`${siteUrl}/cli/command-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_token: config.auth_token,
          command_id: cmd.id,
          result: `Handled by watchdog (daemon was dead): restarting`
        })
      }).catch(() => {
      });
    }
    clearCrashCount();
    const { executablePath, args } = getDaemonExecInfo();
    try {
      const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CODECAST_RESTART: "1" }
      });
      child.unref();
      logLine("Daemon restarted");
    } catch (err) {
      logLine(`Failed to restart daemon: ${err}`);
    }
  } else if (commands.some((c) => c.command === "force_update")) {
    logLine("Daemon alive with pending force_update, daemon should handle via subscription");
  }
}
function getDaemonExecInfo() {
  const execPath = process.execPath;
  const isBinary = !execPath.endsWith("/bun") && !execPath.endsWith("/node") && !execPath.includes("node_modules");
  if (isBinary) {
    return { executablePath: execPath, args: ["--", "_daemon"] };
  }
  return { executablePath: execPath, args: [path13.resolve(__dirname, "daemon.js")] };
}
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("daemon.js")) {
  daemonStarted = true;
  main().catch((err) => {
    logError("Fatal error", err instanceof Error ? err : new Error(String(err)));
    flushRemoteLogs().finally(() => process.exit(1));
  });
}
export {
  tmuxPromptStillHasInput,
  shouldTreatClaudeFileAsStale,
  runWatchdog,
  runDaemon
};
