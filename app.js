/* ============================================================
   Compteur Lisier — logique de l'application
   - Saisie d'un pompage (personne + volume en litres)
   - Stockage local (IndexedDB) : historique en cache sur l'appareil
   - Envoi de chaque pompage au Google Sheet via un script Apps Script
   - File d'attente hors-ligne + renvoi automatique
   ============================================================ */
(function () {
  "use strict";

  // -------------------- Constantes --------------------
  var DB_NAME = "compteur-lisier";
  var DB_VERSION = 1;
  var STORE = "entries";
  var LS_ENDPOINT = "lisier.endpoint";
  var LS_LASTPERSON = "lisier.lastPerson";

  // -------------------- Petits utilitaires --------------------
  function $(sel) { return document.querySelector(sel); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues ? crypto.getRandomValues(b) : b.forEach(function (_, i) { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = [].map.call(b, function (x) { return ("0" + x.toString(16)).slice(-2); }).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  function getEndpoint() { return (localStorage.getItem(LS_ENDPOINT) || "").trim(); }
  function setEndpoint(v) { localStorage.setItem(LS_ENDPOINT, (v || "").trim()); }

  var nfLitres = new Intl.NumberFormat("fr-FR");
  var fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  var fmtTime = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }
  function whenLabel(iso) {
    var d = new Date(iso), now = new Date();
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, now)) return "Aujourd'hui à " + fmtTime.format(d);
    if (sameDay(d, y)) return "Hier à " + fmtTime.format(d);
    return fmtDate.format(d) + " à " + fmtTime.format(d);
  }

  // -------------------- IndexedDB --------------------
  var _dbPromise = null;
  function db() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var os = d.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("ts", "ts", { unique: false });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return _dbPromise;
  }
  function tx(mode) { return db().then(function (d) { return d.transaction(STORE, mode).objectStore(STORE); }); }
  function idbReq(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  function addEntry(e) { return tx("readwrite").then(function (os) { return idbReq(os.add(e)); }); }
  function putEntry(e) { return tx("readwrite").then(function (os) { return idbReq(os.put(e)); }); }
  function allEntries() {
    return tx("readonly").then(function (os) { return idbReq(os.getAll()); }).then(function (list) {
      list.sort(function (a, b) { return b.ts < a.ts ? -1 : b.ts > a.ts ? 1 : 0; });
      return list;
    });
  }
  function unsyncedEntries() {
    return allEntries().then(function (list) { return list.filter(function (e) { return !e.synced; }); });
  }
  function clearEntries() { return tx("readwrite").then(function (os) { return idbReq(os.clear()); }); }

  // -------------------- Envoi vers Google Sheet --------------------
  // Le script Apps Script dédoublonne par "id" : on peut donc renvoyer sans
  // risque de créer une ligne en double.
  function sendEntry(entry) {
    var url = getEndpoint();
    if (!url) return Promise.resolve("noendpoint");
    if (!navigator.onLine) return Promise.resolve("pending");

    var body = JSON.stringify({
      id: entry.id,
      personne: entry.personne,
      volumeL: entry.volumeL,
      ts: entry.ts
    });
    var opts = { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body, redirect: "follow" };

    // 1) Tentative CORS : on peut lire la réponse et confirmer.
    return fetch(url, opts).then(function (res) {
      if (res.ok) {
        return res.json().then(function (j) {
          return (j && j.ok !== false) ? "sent" : "pending";
        }, function () { return "retry-nocors"; });
      }
      return "retry-nocors";
    }, function () {
      return "retry-nocors";
    }).then(function (state) {
      if (state !== "retry-nocors") return state;
      // 2) Repli « no-cors » : livraison best-effort (réponse illisible),
      //    marquée envoyée de façon optimiste (le script dédoublonne par id).
      return fetch(url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: body })
        .then(function () { return "sent"; }, function () { return "pending"; });
    });
  }

  var _flushing = false;
  function flushPending() {
    if (_flushing) return Promise.resolve();
    _flushing = true;
    return unsyncedEntries().then(function (list) {
      var chain = Promise.resolve();
      list.forEach(function (e) {
        chain = chain.then(function () {
          return sendEntry(e).then(function (st) {
            if (st === "sent") { e.synced = true; return putEntry(e); }
          });
        });
      });
      return chain;
    }).then(function () {
      _flushing = false;
      return refreshUI();
    }, function () { _flushing = false; });
  }

  // -------------------- Interface --------------------
  var el = {};
  function cacheEls() {
    el.form = $("#pumpForm");
    el.personne = $("#personne");
    el.volume = $("#volume");
    el.volErr = $("#volErr");
    el.btnSave = $("#btnSave");
    el.syncHint = $("#syncHint");
    el.net = $("#netBadge");
    el.history = $("#historyList");
    el.empty = $("#historyEmpty");
    el.sumCount = $("#sumCount");
    el.sumTotal = $("#sumTotal");
    el.sumToday = $("#sumToday");
    el.toast = $("#toast");
    // réglages
    el.settings = $("#settings");
    el.endpoint = $("#endpoint");
    el.testResult = $("#testResult");
  }

  var _toastTimer = null;
  function toast(msg, kind) {
    el.toast.textContent = msg;
    el.toast.className = "toast toast--show" + (kind ? " toast--" + kind : "");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { el.toast.className = "toast"; }, 2600);
  }
  function vibrate(ms) { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (_) {} } }

  function switchView(name) {
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("view--active"); });
    var view = $("#view-" + name);
    if (view) view.classList.add("view--active");
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("tab--active", t.getAttribute("data-view") === name);
    });
    if (name === "historique") refreshUI();
  }

  function updateNet() {
    var on = navigator.onLine;
    el.net.textContent = on ? "En ligne" : "Hors ligne";
    el.net.className = "net" + (on ? "" : " net--off");
  }

  function renderHistory(list) {
    el.history.innerHTML = "";
    if (!list.length) {
      el.empty.classList.add("empty--show");
      return;
    }
    el.empty.classList.remove("empty--show");
    var frag = document.createDocumentFragment();
    list.forEach(function (e) {
      var li = document.createElement("li");
      li.className = "history__item";

      var main = document.createElement("div");
      main.className = "history__main";
      var who = document.createElement("div");
      who.className = "history__who";
      who.textContent = e.personne;
      var when = document.createElement("div");
      when.className = "history__when";
      when.textContent = whenLabel(e.ts);
      main.appendChild(who); main.appendChild(when);

      var vol = document.createElement("div");
      vol.className = "history__vol";
      vol.innerHTML = nfLitres.format(e.volumeL) + " <small>L</small>";

      var badge = document.createElement("span");
      badge.className = "badge " + (e.synced ? "badge--ok" : "badge--wait");
      badge.textContent = e.synced ? "✓ Envoyé" : "⏳ En attente";

      li.appendChild(main); li.appendChild(vol); li.appendChild(badge);
      frag.appendChild(li);
    });
    el.history.appendChild(frag);
  }

  function renderSummary(list) {
    var now = new Date(), total = 0, today = 0;
    list.forEach(function (e) {
      total += e.volumeL;
      if (sameDay(new Date(e.ts), now)) today += e.volumeL;
    });
    el.sumCount.textContent = nfLitres.format(list.length);
    el.sumTotal.textContent = nfLitres.format(total);
    el.sumToday.textContent = nfLitres.format(today);
  }

  function renderSyncHint(list) {
    var pending = list.filter(function (e) { return !e.synced; }).length;
    if (!getEndpoint()) {
      el.syncHint.hidden = false;
      el.syncHint.textContent = "⚠️ Synchronisation non configurée — appuyez sur ⚙️ pour relier le tableur Google.";
    } else if (pending > 0) {
      el.syncHint.hidden = false;
      el.syncHint.textContent = "⏳ " + pending + " pompage(s) en attente d'envoi.";
    } else {
      el.syncHint.hidden = true;
    }
  }

  function refreshUI() {
    return allEntries().then(function (list) {
      renderHistory(list);
      renderSummary(list);
      renderSyncHint(list);
    });
  }

  // -------------------- Saisie --------------------
  function parseVolume(raw) {
    if (!raw) return NaN;
    return parseFloat(String(raw).replace(/\s/g, "").replace(",", "."));
  }

  function onSubmit(ev) {
    ev.preventDefault();
    var personne = el.personne.value;
    var vol = parseVolume(el.volume.value);

    if (!personne) { toast("Choisissez d'abord la personne.", "err"); el.personne.focus(); return; }
    if (!(vol > 0)) {
      el.volErr.hidden = false;
      el.volume.focus();
      return;
    }
    el.volErr.hidden = true;

    var entry = {
      id: uuid(),
      personne: personne,
      volumeL: vol,
      ts: new Date().toISOString(),
      synced: false
    };

    el.btnSave.disabled = true;
    addEntry(entry).then(function () {
      localStorage.setItem(LS_LASTPERSON, personne);
      el.volume.value = "";
      vibrate(30);
      toast("Pompage enregistré ✓", "ok");
      el.volume.focus();
      return refreshUI();
    }).then(function () {
      return sendEntry(entry).then(function (st) {
        if (st === "sent") { entry.synced = true; return putEntry(entry).then(refreshUI); }
      });
    }).then(function () {
      // renvoyer d'éventuels pompages encore en attente
      return flushPending();
    }).catch(function (err) {
      toast("Erreur d'enregistrement.", "err");
      console.error(err);
    }).then(function () {
      el.btnSave.disabled = false;
    });
  }

  // -------------------- Réglages --------------------
  function openSettings() {
    el.endpoint.value = getEndpoint();
    el.testResult.hidden = true;
    el.settings.hidden = false;
  }
  function closeSettings() { el.settings.hidden = true; }

  function saveSettings() {
    setEndpoint(el.endpoint.value);
    closeSettings();
    toast("Réglages enregistrés.", "ok");
    flushPending();
  }

  function testConnection() {
    var url = (el.endpoint.value || "").trim();
    el.testResult.hidden = false;
    el.testResult.className = "testresult";
    el.testResult.textContent = "Test en cours…";
    if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
      el.testResult.className = "testresult testresult--err";
      el.testResult.textContent = "L'adresse doit commencer par https://script.google.com/…";
      return;
    }
    fetch(url, { method: "GET", redirect: "follow" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          el.testResult.className = "testresult testresult--ok";
          el.testResult.textContent = "✓ Connexion réussie au script.";
        } else {
          throw new Error("réponse inattendue");
        }
      })
      .catch(function () {
        el.testResult.className = "testresult testresult--err";
        el.testResult.textContent = "Réponse illisible. Vérifiez que le déploiement est en accès « Tout le monde ». L'envoi peut toutefois fonctionner.";
      });
  }

  function clearHistory() {
    if (!window.confirm("Vider l'historique de ce téléphone ? (Le tableur Google n'est pas affecté.)")) return;
    clearEntries().then(function () {
      closeSettings();
      toast("Historique vidé.", "ok");
      refreshUI();
    });
  }

  // -------------------- Démarrage --------------------
  function init() {
    cacheEls();

    // pré-sélection de la dernière personne
    var last = localStorage.getItem(LS_LASTPERSON);
    if (last) {
      var opt = [].slice.call(el.personne.options).filter(function (o) { return o.value === last; })[0];
      if (opt) el.personne.value = last;
    }

    el.form.addEventListener("submit", onSubmit);
    el.volume.addEventListener("input", function () { if (parseVolume(el.volume.value) > 0) el.volErr.hidden = true; });

    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.getAttribute("data-view")); });
    });

    $("#btnSettings").addEventListener("click", openSettings);
    $("#btnSaveSettings").addEventListener("click", saveSettings);
    $("#btnTest").addEventListener("click", testConnection);
    $("#btnResync").addEventListener("click", function () { toast("Renvoi en cours…"); flushPending(); });
    $("#btnClear").addEventListener("click", clearHistory);
    document.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", closeSettings); });

    window.addEventListener("online", function () { updateNet(); flushPending(); });
    window.addEventListener("offline", updateNet);

    updateNet();
    refreshUI().then(flushPending);

    // Service worker (hors-ligne)
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("service-worker.js").catch(function (e) { console.warn("SW:", e); });
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
