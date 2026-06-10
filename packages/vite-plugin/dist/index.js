// src/index.ts
import { existsSync } from "fs";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { MANIFEST_PERMISSIONS, UIX } from "@dotuix/core";
function uixConfigToManifest(cfg) {
  const m = {
    uix: "1.0",
    id: cfg.id,
    name: cfg.name,
    version: cfg.version,
    entry: cfg.entry ?? "index.html",
    mode: cfg.mode ?? "window"
  };
  if (cfg.schemaVersion !== void 0) m.schemaVersion = cfg.schemaVersion;
  if (cfg.state !== void 0) m.state = cfg.state;
  if (cfg.permissions !== void 0) m.permissions = cfg.permissions;
  if (cfg.network !== void 0) m.network = cfg.network;
  if (cfg.theme !== void 0) m.theme = cfg.theme;
  if (cfg.author !== void 0) m.author = cfg.author;
  if (cfg.expires !== void 0) m.expires = cfg.expires;
  if (cfg.license !== void 0) m.license = cfg.license;
  return m;
}
function buildDevBridgeScript(appId, appName, appVersion, schemaVersion) {
  const APP_ID = JSON.stringify(appId);
  const APP_NAME = JSON.stringify(appName);
  const APP_VER = JSON.stringify(appVersion);
  const SCHEMA = String(schemaVersion);
  const DEFAULT_PERMISSIONS = JSON.stringify([...MANIFEST_PERMISSIONS]);
  return `(function () {
  if (window.__uix) return;
  var _APP_ID = ${APP_ID};
  var _APP_NAME = ${APP_NAME};
  var _APP_VERSION = ${APP_VER};
  var _SCHEMA_VERSION = ${SCHEMA};
  var _uid = 0;
  function genId(t) { return t + ':' + Date.now() + '-' + (++_uid); }
  var _dbReady = new Promise(function (ok, fail) {
    var req = indexedDB.open('dotuix-dev:' + _APP_ID, 1);
    req.onupgradeneeded = function (e) {
      var d = e.target.result;
      if (!d.objectStoreNames.contains('records')) {
        d.createObjectStore('records', { keyPath: 'id' }).createIndex('by_type', 'type', { unique: false });
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = function (e) { ok(e.target.result); };
    req.onerror   = function () { fail(req.error); };
  });
  function withDb(fn) { return _dbReady.then(fn); }
  function idbGet(store, key) {
    return withDb(function (d) { return new Promise(function (res, rej) {
      var r = d.transaction([store], 'readonly').objectStore(store).get(key);
      r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { rej(r.error); };
    }); });
  }
  function idbPut(store, val) {
    return withDb(function (d) { return new Promise(function (res, rej) {
      var r = d.transaction([store], 'readwrite').objectStore(store).put(val);
      r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); };
    }); });
  }
  function idbDel(store, key) {
    return withDb(function (d) { return new Promise(function (res, rej) {
      var r = d.transaction([store], 'readwrite').objectStore(store).delete(key);
      r.onsuccess = function () { res(); }; r.onerror = function () { rej(r.error); };
    }); });
  }
  function idbAll(store, idx, val) {
    return withDb(function (d) { return new Promise(function (res, rej) {
      var s = d.transaction([store], 'readonly').objectStore(store);
      var r = idx ? s.index(idx).getAll(val) : s.getAll();
      r.onsuccess = function () { res(r.result || []); }; r.onerror = function () { rej(r.error); };
    }); });
  }
  function idbClear(store, type) {
    return withDb(function (d) { return new Promise(function (res, rej) {
      var tx = d.transaction([store], 'readwrite'), s = tx.objectStore(store);
      if (!type) { var r = s.clear(); r.onsuccess = function(){res();}; r.onerror = function(){rej(r.error);}; return; }
      var cur = s.index('by_type').openKeyCursor(IDBKeyRange.only(type)), keys = [];
      cur.onsuccess = function (e) {
        var c = e.target.result;
        if (c) { keys.push(c.primaryKey); c.continue(); return; }
        var n = keys.length; if (!n) { res(); return; }
        keys.forEach(function (k) { var dr = s.delete(k); dr.onsuccess = function(){ if (!--n) res(); }; dr.onerror = function(){ rej(dr.error); }; });
      }; cur.onerror = function () { rej(cur.error); };
    }); });
  }
  function serBody(b) { return typeof b !== 'string' ? JSON.stringify(b) : b; }
  function tryParse(s) { try { return JSON.parse(s); } catch (_) { return {}; } }
  function parseDur(s) {
    var m = String(s).match(/^(\\d+)(d|h|m|s)$/);
    if (!m) return 0;
    return Number(m[1]) * { d:86400000, h:3600000, m:60000, s:1000 }[m[2]];
  }
  var state = {
    get: function (id) { return idbGet('records', id); },
    find: function (opts) {
      var q = typeof opts === 'string' ? { type: opts } : (opts || {});
      return idbAll('records', q.type ? 'by_type' : null, q.type || undefined).then(function (all) {
        if (q.where) all = all.filter(function (r) {
          var b = tryParse(r.body);
          return Object.keys(q.where).every(function (k) {
            var actual = (k==='id'||k==='type'||k==='created_at'||k==='updated_at') ? r[k] : b[k];
            var cond = q.where[k];
            if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
              return Object.keys(cond).every(function (op) {
                var v = cond[op];
                if (op==='eq') return actual === v;
                if (op==='neq') return actual !== v;
                if (op==='gt') return actual > v;
                if (op==='gte') return actual >= v;
                if (op==='lt') return actual < v;
                if (op==='lte') return actual <= v;
                if (op==='like') return String(actual).indexOf(String(v).replace(/%/g,'')) !== -1;
                if (op==='in') return (v||[]).indexOf(actual) !== -1;
                if (op==='is_null') return v ? (actual==null) : (actual!=null);
                throw new Error('Unknown where operator "'+op+'"');
              });
            }
            return actual === cond;
          });
        });
        if (q.orderBy) {
          var field = typeof q.orderBy === 'string' ? q.orderBy : q.orderBy.field;
          var dir = (typeof q.orderBy === 'object' && q.orderBy.direction === 'desc') ? -1 : 1;
          all.sort(function (a, b) { var av = a[field] != null ? a[field] : tryParse(a.body)[field]; var bv = b[field] != null ? b[field] : tryParse(b.body)[field]; return av < bv ? -dir : av > bv ? dir : 0; });
        }
        if (q.offset) all = all.slice(q.offset);
        if (q.limit)  all = all.slice(0, q.limit);
        return all;
      });
    },
    count: function (opts) { return state.find(opts).then(function (a) { return a.length; }); },
    insert: function (r) {
      var now = Date.now(), rec = { id: r.id || genId(r.type), type: r.type, body: serBody(r.body), created_at: now, updated_at: now };
      return idbPut('records', rec).then(function () { return rec; });
    },
    update: function (id, body) {
      return state.get(id).then(function (ex) {
        if (!ex) throw new Error('Record not found: ' + id);
        var rec = Object.assign({}, ex, { body: serBody(body), updated_at: Date.now() });
        return idbPut('records', rec).then(function () { return rec; });
      });
    },
    upsert: function (r) {
      return state.get(r.id).then(function (ex) {
        var now = Date.now(), rec = { id: r.id, type: r.type || (ex && ex.type) || 'unknown', body: serBody(r.body), created_at: ex ? ex.created_at : now, updated_at: now };
        return idbPut('records', rec).then(function () { return rec; });
      });
    },
    insertMany: function (recs) { return Promise.all((recs||[]).map(function(r){return state.insert(r);})); },
    delete:  function (id)   { return idbDel('records', id); },
    purge:   function (opts) {
      var type = typeof opts === 'string' ? opts : (opts && opts.type);
      var dur  = opts && opts.olderThan ? parseDur(opts.olderThan) : 0;
      return state.find(type ? { type: type } : null).then(function (all) {
        var del = dur ? all.filter(function(r){ return r.created_at < Date.now() - dur; }) : all;
        return Promise.all(del.map(function(r){ return state.delete(r.id); })).then(function(){ return del.length; });
      });
    },
    clear:   function (opts) { return idbClear('records', opts && opts.type); },
    reset:   function ()     { return idbClear('records'); },
    transaction: function (ops) {
      return (ops||[]).reduce(function(p,op){ return p.then(function(){
        if (op.op==='insert') return state.insert(op);
        if (op.op==='upsert') return state.upsert(op);
        if (op.op==='update') return state.update(op.id, op.body);
        if (op.op==='delete') return state.delete(op.id);
      }); }, Promise.resolve());
    },
    size: function(){ return state.find(null).then(function(all){ var types={}, bytes=0; all.forEach(function(r){ types[r.type]=(types[r.type]||0)+1; bytes+=(r.body?String(r.body).length:0); }); return { bytes:bytes, records:all.length, types:types }; }); },
    vacuum: function(){ return Promise.resolve({ before:0, after:0 }); },
    raw:  function(){ return Promise.resolve([]); }, sync: function(){ return Promise.resolve(); },
    export: function(opts){ return state.find(opts&&opts.type?{type:opts.type}:null).then(function(r){return JSON.stringify(r);}); },
    exportBundle: function(opts){
      var q = opts&&opts.types&&opts.types.length ? {type:opts.types[0]} : null;
      return state.find(q).then(function(records){
        return JSON.stringify({ format:'uixdata/1.0', appId:_APP_ID, exportedAt:new Date().toISOString(), records:records });
      });
    },
    importBundle: function(json, opts){
      try {
        var bundle=JSON.parse(json), recs=bundle.records||[], merge=opts&&opts.merge;
        if (!merge) return state.insertMany(recs).then(function(){ return {imported:recs.length,skipped:0}; });
        return recs.reduce(function(p,r){ return p.then(function(acc){
          return state.get(r.id).then(function(ex){
            if (ex){ acc.skipped++; return acc; }
            return state.insert(r).then(function(){ acc.imported++; return acc; });
          });
        }); }, Promise.resolve({imported:0,skipped:0}));
      } catch(e){ return Promise.reject(e); }
    },
  };
  var schema = {
    onUpgrade: function(fn){
      return idbGet('meta','schema_version').then(function(stored){
        var fromV=stored?Number(stored.value):1, toV=_SCHEMA_VERSION;
        if (fromV>=toV) return;
        return Promise.resolve(fn({from:fromV,to:toV,state:state})).then(function(){
          return idbPut('meta',{key:'schema_version',value:toV});
        });
      });
    },
    version:       function(){ return _SCHEMA_VERSION; },
    storedVersion: function(){ return 1; },
    needsUpgrade:  function(){ return false; },
  };
  window.__uix = {
    manifest: function(){ return { uix:'1.0', id:_APP_ID, name:_APP_NAME, version:_APP_VERSION,
      entry:'index.html', mode:'window', schemaVersion:_SCHEMA_VERSION,
      permissions:${DEFAULT_PERMISSIONS},
      network:'allowed' }; },
    state: state,
    data:  { find:function(){return Promise.resolve([]);}, get:function(){return Promise.resolve(null);},
             count:function(){return Promise.resolve(0);}, raw:function(){return Promise.resolve([]);} },
    schema: schema,
    license:{ get:function(){return Promise.resolve(null);}, hasFeature:function(){return Promise.resolve(false);} },
    clipboard:{ write:function(t){ return navigator.clipboard?navigator.clipboard.writeText(t):Promise.resolve(); } },
    fullscreen:{
      enter:  function(){ return document.documentElement.requestFullscreen().catch(function(){}); },
      exit:   function(){ return document.exitFullscreen().catch(function(){}); },
      toggle: function(){ return (document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()).catch(function(){}); },
    },
    viewer:{ version:function(){ return '0.0.0-dev'; } },
    file:{
      save: function(filename,content){
        var blob=content instanceof ArrayBuffer?new Blob([content]):new Blob([String(content)],{type:'text/plain'});
        var a=Object.assign(document.createElement('a'),{href:URL.createObjectURL(blob),download:filename});
        a.click(); URL.revokeObjectURL(a.href); return Promise.resolve(true);
      },
      open: function(opts){
        return new Promise(function(res){
          var inp=document.createElement('input'); inp.type='file';
          var acc=opts&&(opts.accept||opts.filter);
          if (acc) inp.accept=Array.isArray(acc)?acc.join(','):acc;
          inp.onchange=function(){ var f=inp.files&&inp.files[0]; if(!f){res(null);return;} var r=new FileReader(); r.onload=function(){res({name:f.name,content:r.result});}; r.readAsArrayBuffer(f); };
          inp.click();
        });
      },
    },
    browser:{ open:function(url){ window.open(url,'_blank','noopener'); return Promise.resolve(); } },
    window: { setTitle:function(t){ document.title=t; return Promise.resolve(); } },
    notify: function(title,body){ console.info('[dotuix dev] notify:',title,body||''); return Promise.resolve(); },
    print:  function(){ window.print(); },
    exit:   function(){ console.log('[dotuix dev] exit()'); return Promise.resolve(); },
  };
  window.uix = window.__uix;
})();`;
}
function dotuix(options = {}) {
  const { mockBridge = true } = options;
  let resolvedConfig;
  let appConfig = null;
  let baseManifest = null;
  return {
    name: "vite-plugin-dotuix",
    enforce: "pre",
    config() {
      return { base: "./" };
    },
    async configResolved(resolved) {
      resolvedConfig = resolved;
      const root = resolved.root;
      const uixConfigPath = join(root, "uix.config.ts");
      const manifestPath = join(root, "manifest.json");
      if (existsSync(uixConfigPath)) {
        try {
          const { loadConfigFromFile } = await import("vite");
          const result = await loadConfigFromFile(
            { command: resolved.command, mode: resolved.mode },
            uixConfigPath,
            root
          );
          if (result) {
            appConfig = result.config;
          }
        } catch (e) {
          resolved.logger.warn(`[dotuix] Failed to load uix.config.ts: ${e.message}`);
        }
      } else if (existsSync(manifestPath)) {
        try {
          baseManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        } catch {
          resolved.logger.warn("[dotuix] Failed to parse manifest.json");
        }
      }
    },
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (!mockBridge || resolvedConfig.command === "build") return html;
        const manifest = appConfig ? uixConfigToManifest(appConfig) : baseManifest ?? {};
        const id = String(manifest.id ?? "dev");
        const name = String(manifest.name ?? "Dev Preview");
        const version = String(manifest.version ?? "0.0.0");
        const schema = Number(manifest.schemaVersion ?? 1);
        const script = buildDevBridgeScript(id, name, version, schema);
        return html.replace(/<head>/i, `<head>
<script>${script}</script>`);
      }
    },
    async closeBundle() {
      if (resolvedConfig.command !== "build") return;
      const outDir = resolvedConfig.build.outDir;
      const root = resolvedConfig.root;
      let manifest = appConfig ? uixConfigToManifest(appConfig) : baseManifest ?? {};
      if (options.manifest) {
        manifest = { ...manifest, ...options.manifest };
      }
      const required = ["uix", "id", "name", "version", "entry"];
      const missing = required.filter((f) => !manifest[f]);
      if (missing.length) {
        resolvedConfig.logger.warn(
          `[dotuix] manifest is missing required fields: ${missing.join(", ")} \u2014 skipping .uix pack
         Add a uix.config.ts or manifest.json to your project root.`
        );
        return;
      }
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
      const rawName = manifest.id.split(".").pop() ?? "app";
      const appName = rawName.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
      const uixOut = options.output ?? join(root, `${appName}.uix`);
      await UIX.pack(outDir, uixOut);
      const rel = uixOut.startsWith(root) ? uixOut.slice(root.length + 1) : uixOut;
      resolvedConfig.logger.info(`
\u2713 [dotuix] packed \u2192 ${rel}
`, { clear: false });
    }
  };
}
var index_default = dotuix;
export {
  index_default as default,
  dotuix
};
