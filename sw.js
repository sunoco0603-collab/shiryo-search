/*
 * 資料検索アプリ オフライン用サービスワーカー
 *
 * 役割は2つある。
 *
 * 1. アプリ本体（HTML・アイコン・KaTeX）をキャッシュして、電波がなくても開けるようにする。
 * 2. data/... への要求を、取り込み済みの資料データ（IndexedDB）から返す。
 *    これにより、アプリ側の検索処理は「data/meta.js を読む」という書き方のまま変えずに済む。
 *    教科書本文はネット上に一切置かず、端末の中だけに存在する。
 *
 * アプリを更新したら CACHE の数字を1つ増やすこと。
 */
var CACHE = "shiryo-navi-v3";
var SHELL = "./index.html";
var ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png"
];
// 外部ライブラリ（ここだけは別ドメインでもキャッシュする）
// KaTeX＝数式表示、pdf.js＝取り込んだPDFの表示。どちらもオフラインで必要になる。
var KATEX = [
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css",
  "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js"
];

var SN_DB = "shiryo-navi", SN_STORE = "files";

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(ASSETS).catch(function () {})
        .then(function () { return c.addAll(KATEX).catch(function () {}); });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* ---------- 取り込み済み資料データの読み出し ---------- */
/*
 * バージョンを指定せずに開く。こうしないと、アプリ側でDBの構成を変えたとき
 * （PDF置き場の追加など）にバージョン違いで開けなくなる。
 */
function snOpenDb() {
  return new Promise(function (res, rej) {
    var req = indexedDB.open(SN_DB);
    req.onsuccess = function () { res(req.result); };
    req.onerror = function () { rej(req.error); };
  });
}
function snGetFile(path) {
  return snOpenDb().then(function (db) {
    if (!db.objectStoreNames.contains(SN_STORE)) return null;   // まだ取り込み前
    return new Promise(function (res, rej) {
      var t = db.transaction(SN_STORE, "readonly");
      var r = t.objectStore(SN_STORE).get(path);
      r.onsuccess = function () { res(r.result || null); };
      r.onerror = function () { rej(r.error); };
    });
  });
}

/** このアプリの置き場から見た相対パス（例 "data/meta.js"）を取り出す */
function snRelPath(url) {
  var scope = new URL("./", self.registration.scope).pathname;
  var p = url.pathname;
  return p.indexOf(scope) === 0 ? p.slice(scope.length) : p.replace(/^\//, "");
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  // 数式ライブラリ：キャッシュ優先（フォントも使うたびに貯めていく）
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && (res.status === 200 || res.type === "opaque")) {
            var copy = res.clone();
            caches.open(CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  var rel = snRelPath(url);

  // 資料データ：ネットには存在しない。取り込み済みのものを返す。
  if (rel.indexOf("data/") === 0 && /\.js$/.test(rel)) {
    e.respondWith(
      snGetFile(rel).then(function (rec) {
        if (rec && typeof rec.body === "string") {
          return new Response(rec.body, {
            status: 200,
            headers: { "Content-Type": "application/javascript; charset=utf-8" }
          });
        }
        // 取り込み前、または本文が無い資料。空の中身を返し、アプリ側の判定に任せる。
        return new Response("/* not imported */", {
          status: 404,
          headers: { "Content-Type": "application/javascript; charset=utf-8" }
        });
      }).catch(function () {
        return new Response("/* storage error */", { status: 404 });
      })
    );
    return;
  }

  // ページそのもの：ネット優先（更新をすぐ反映するため）
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(SHELL, copy); });
        return res;
      }).catch(function () {
        return caches.match(SHELL).then(function (hit) { return hit || caches.match("./"); });
      })
    );
    return;
  }

  // それ以外：キャッシュ優先
  e.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === "basic") {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
