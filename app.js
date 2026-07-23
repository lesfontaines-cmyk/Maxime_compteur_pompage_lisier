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
  var LS_OP_NOM = "lisier.opNom";           // nom de l'opérateur (par appareil)
  var LS_OP_RAISON = "lisier.opRaison";     // raison sociale de l'entreprise de pompage (par appareil)
  var LS_OP_ADRESSE = "lisier.opAdresse";   // adresse de l'entreprise de pompage (par appareil)

  // ============================================================
  //  CONFIGURATION (en dur — réservée à l'administrateur)
  //  L'opérateur n'a rien à régler dans l'application.
  // ============================================================
  // Adresse « /exec » du script Google (Web App déployé).
  var ENDPOINT_URL = "https://script.google.com/macros/s/AKfycbwryCl3KsCid3NpPG7SYMPXkLMeexa7Wgc3k8tymNjAaPOuPb2Ol7j80zC03IfxZeehfQ/exec";
  // Identité de l'exploitation, imprimée en en-tête du bordereau PDF.
  var EXPLOITATION_NOM = "Les Fils de Charles Murgat";
  var EXPLOITATION_ADR = "36 Chem. du Lavoir, 38270 Beaufort";

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
  function getEndpoint() { return (ENDPOINT_URL || "").trim(); }
  function expNom() { return EXPLOITATION_NOM; }
  function expAdr() { return EXPLOITATION_ADR; }
  function opNom() { return (localStorage.getItem(LS_OP_NOM) || "").trim(); }
  function opRaison() { return (localStorage.getItem(LS_OP_RAISON) || "").trim(); }
  function opAdresse() { return (localStorage.getItem(LS_OP_ADRESSE) || "").trim(); }
  function isConfigComplete() { return !!(opNom() && opRaison() && opAdresse()); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function sanitize(s) {
    return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  }
  function isoStamp(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes());
  }

  // -------------------- Logo (rasterisé pour le PDF) --------------------
  // jsPDF n'insère pas de SVG : on rastérise le logo de l'entreprise en PNG une
  // fois au démarrage, puis on l'imprime en en-tête de chaque bordereau.
  var LOGO_URL = "icons/logo-murgat.svg";
  var LOGO_ASPECT = 243 / 38; // rapport largeur/hauteur (viewBox du logo)
  var _logoPng = null;        // data URL PNG du logo, prête pour jsPDF

  function preloadLogo() {
    try {
      fetch(LOGO_URL).then(function (r) { return r.ok ? r.text() : Promise.reject(); })
        .then(function (svg) {
          // Un SVG sans width/height se rend à une taille par défaut (voire nulle)
          // une fois dessiné sur un canvas : on force une taille explicite.
          var w = 1200, h = Math.round(w / LOGO_ASPECT);
          if (!/<svg[^>]*\bwidth=/.test(svg)) {
            svg = svg.replace(/<svg\b/, '<svg width="' + w + '" height="' + h + '"');
          }
          var blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
          var url = URL.createObjectURL(blob);
          var img = new Image();
          img.onload = function () {
            try {
              var cv = document.createElement("canvas");
              cv.width = w; cv.height = h;
              cv.getContext("2d").drawImage(img, 0, 0, w, h);
              _logoPng = cv.toDataURL("image/png");
            } catch (_) {}
            URL.revokeObjectURL(url);
          };
          img.onerror = function () { URL.revokeObjectURL(url); };
          img.src = url;
        }).catch(function () {});
    } catch (_) {}
  }

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
      entreprise: entry.entreprise || "",
      adresse: entry.adresse || "",
      volumeL: entry.volumeL,
      ts: entry.ts,
      filename: entry.filename || "",
      pdfBase64: entry.pdfBase64 || ""
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
    el.opDisplay = $("#opDisplay");
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
    el.opNom = $("#opNom");
    el.opRaison = $("#opRaison");
    el.opAdresse = $("#opAdresse");
    el.opErr = $("#opErr");
    el.reqBanner = $("#reqBanner");
    // signature
    el.signModal = $("#signModal");
    el.signRecap = $("#signRecap");
    el.signPad = $("#signPad");
    el.signErr = $("#signErr");
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

      if (e.pdfBase64) {
        var pdfBtn = document.createElement("button");
        pdfBtn.type = "button";
        pdfBtn.className = "history__pdf";
        pdfBtn.textContent = "⤓ Bordereau PDF";
        pdfBtn.addEventListener("click", (function (entry) {
          return function () { downloadPdf(entry); };
        })(e));
        main.appendChild(pdfBtn);
      }

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
    if (pending > 0) {
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

  var pendingPump = null; // { personne, volumeL } en attente de signature

  function onSubmit(ev) {
    ev.preventDefault();

    // Nom, raison sociale et adresse obligatoires (ils figurent sur le bordereau).
    if (!isConfigComplete()) {
      toast("Renseignez d'abord le nom, la raison sociale et l'adresse.", "err");
      openSettings(true);
      return;
    }

    var vol = parseVolume(el.volume.value);
    if (!(vol > 0)) {
      el.volErr.hidden = false;
      el.volume.focus();
      return;
    }
    el.volErr.hidden = true;

    pendingPump = { personne: opNom(), volumeL: vol };
    openSign(pendingPump);
  }

  // -------------------- Signature (pop-up) --------------------
  var sign = { canvas: null, ctx: null, drawing: false, dirty: false };

  function openSign(p) {
    var d = new Date();
    el.signRecap.innerHTML = "<b>" + escapeHtml(p.personne) + "</b> — " +
      nfLitres.format(p.volumeL) + " litres" +
      '<div class="sign-recap__meta">' + fmtDate.format(d) + " à " + fmtTime.format(d) + "</div>";
    el.signErr.hidden = true;
    el.signModal.hidden = false;
    if (window.requestAnimationFrame) requestAnimationFrame(setupPad); else setupPad();
  }
  function closeSign() { el.signModal.hidden = true; }

  function setupPad() {
    var c = el.signPad; sign.canvas = c;
    var rect = c.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.round(rect.width * dpr));
    c.height = Math.max(1, Math.round(rect.height * dpr));
    var ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.2; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#141008";
    sign.ctx = ctx; sign.dirty = false;
  }
  function padPos(e) {
    var r = sign.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function padDown(e) {
    if (!sign.ctx) return;
    e.preventDefault(); sign.drawing = true;
    try { sign.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    var p = padPos(e); sign.ctx.beginPath(); sign.ctx.moveTo(p.x, p.y);
  }
  function padMove(e) {
    if (!sign.drawing) return;
    e.preventDefault();
    var p = padPos(e); sign.ctx.lineTo(p.x, p.y); sign.ctx.stroke(); sign.dirty = true;
    el.signErr.hidden = true;
  }
  function padUp() { sign.drawing = false; }
  function clearPad() {
    if (!sign.ctx) return;
    sign.ctx.save(); sign.ctx.setTransform(1, 0, 0, 1, 0, 0);
    sign.ctx.clearRect(0, 0, sign.canvas.width, sign.canvas.height); sign.ctx.restore();
    sign.dirty = false; el.signErr.hidden = true;
  }

  function onSignValidate() {
    if (!sign.dirty) { el.signErr.hidden = false; return; }
    if (!pendingPump) { closeSign(); return; }
    var now = new Date();
    var entry = {
      id: uuid(),
      personne: pendingPump.personne,
      entreprise: opRaison(),
      adresse: opAdresse(),
      volumeL: pendingPump.volumeL,
      ts: now.toISOString(),
      synced: false,
      signature: sign.canvas.toDataURL("image/png")
    };
    try {
      var pdf = buildBordereauPDF(entry);
      entry.pdfBase64 = pdf.base64;
      entry.filename = pdf.filename;
      delete entry.signature; // la signature est déjà dans le PDF
    } catch (err) {
      console.error("Génération PDF:", err);
      toast("Bordereau PDF non généré (voir console).", "err");
    }

    closeSign();
    addEntry(entry).then(function () {
      el.volume.value = "";
      pendingPump = null;
      vibrate(30);
      toast("Pompage enregistré et signé ✓", "ok");
      return refreshUI();
    }).then(function () {
      return sendEntry(entry).then(function (st) {
        if (st === "sent") { entry.synced = true; return putEntry(entry).then(refreshUI); }
      });
    }).then(function () {
      return flushPending();
    }).catch(function (err) {
      toast("Erreur d'enregistrement.", "err");
      console.error(err);
    });
  }

  // -------------------- Bordereau PDF --------------------
  function buildBordereauPDF(entry) {
    if (!(window.jspdf && window.jspdf.jsPDF)) throw new Error("jsPDF indisponible");
    var JsPDF = window.jspdf.jsPDF;
    var doc = new JsPDF({ unit: "mm", format: "a4" });
    var d = new Date(entry.ts);
    var dateStr = fmtDate.format(d), heureStr = fmtTime.format(d);
    var W = 210, m = 16, right = W - m, cw = right - m;
    var nom = expNom() || "Charles Murgat", adr = expAdr();
    var ref = "N° " + sanitize(entry.id).slice(0, 8).toUpperCase() + "-" + isoStamp(d);

    // En-tête exploitation — logo de l'entreprise (si prêt) + nom + adresse.
    if (_logoPng) {
      var lw = 66, lh = lw / LOGO_ASPECT;                 // largeur fixe, hauteur proportionnelle
      try { doc.addImage(_logoPng, "PNG", (W - lw) / 2, 11, lw, lh); } catch (_) {}
      doc.setFont("times", "bold"); doc.setFontSize(12); doc.setTextColor(20, 16, 8);
      doc.text(nom.toUpperCase(), W / 2, 26, { align: "center" });
      if (adr) { doc.setFont("times", "normal"); doc.setFontSize(9); doc.setTextColor(90, 80, 72); doc.text(adr, W / 2, 30.5, { align: "center" }); }
    } else {
      // Repli texte si le logo n'a pas pu être chargé/rastérisé.
      doc.setFont("times", "bold"); doc.setFontSize(19); doc.setTextColor(20, 16, 8);
      doc.text(nom.toUpperCase(), W / 2, 20, { align: "center" });
      doc.setFont("times", "italic"); doc.setFontSize(9); doc.setTextColor(90, 80, 72);
      doc.text("Pisciculture familiale depuis 1898", W / 2, 25.5, { align: "center" });
      if (adr) { doc.setFont("times", "normal"); doc.setFontSize(9); doc.text(adr, W / 2, 30, { align: "center" }); }
    }

    // Titre
    doc.setDrawColor(122, 80, 32); doc.setLineWidth(0.6); doc.line(m, 34, right, 34);
    doc.setFont("helvetica", "bold"); doc.setFontSize(14); doc.setTextColor(20, 16, 8);
    doc.text("BORDEREAU DE POMPAGE DE LISIER", W / 2, 42, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.3); doc.setTextColor(120, 110, 100);
    doc.text("Document interne — mise en page inspirée du CERFA n°12571*01 (bordereau de suivi de déchets)", W / 2, 46.5, { align: "center" });

    var y = 54;
    doc.setFont("helvetica", "normal"); doc.setFontSize(9); doc.setTextColor(60, 60, 60);
    doc.text(ref, right, 52, { align: "right" });

    function fieldBox(numTitle, value, h, big) {
      doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.3); doc.rect(m, y, cw, h);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(120, 110, 100);
      doc.text(numTitle.toUpperCase(), m + 3, y + 5);
      doc.setTextColor(20, 16, 8);
      doc.setFont(big ? "times" : "helvetica", big ? "bold" : "normal");
      doc.setFontSize(big ? 20 : 12);
      doc.text(String(value), m + 4, y + (big ? 14 : 12.5));
      y += h + 4;
    }
    // La police standard du PDF ne rend pas l'espace fine insécable (U+202F/U+00A0)
    // utilisée par le format français : on la remplace par une espace normale.
    var volTxt = nfLitres.format(entry.volumeL).replace(/[\u00a0\u202f\u2009]/g, " ");
    var interv = opRaison() + (opAdresse() ? "  —  " + opAdresse() : "");
    fieldBox("1 · Exploitation / producteur", nom + (adr ? "  —  " + adr : ""), 16);
    fieldBox("2 · Intervenant — entreprise de pompage", interv, 16);
    fieldBox("3 · Nature du produit pompé", "Lisier (effluent d'élevage)", 16);
    fieldBox("4 · Volume pompé", volTxt + " litres", 18, true);

    // Ligne date + opérateur (deux colonnes)
    var half = (cw - 4) / 2;
    doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.3);
    doc.rect(m, y, half, 16); doc.rect(m + half + 4, y, half, 16);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(120, 110, 100);
    doc.text("5 · DATE ET HEURE DU POMPAGE", m + 3, y + 5);
    doc.text("6 · OPÉRATEUR", m + half + 7, y + 5);
    doc.setFont("helvetica", "normal"); doc.setFontSize(12); doc.setTextColor(20, 16, 8);
    doc.text(dateStr + " à " + heureStr, m + 4, y + 12.5);
    doc.text(entry.personne, m + half + 8, y + 12.5);
    y += 20;

    // Signature
    var sh = 46;
    doc.setDrawColor(150, 150, 150); doc.rect(m, y, cw, sh);
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(120, 110, 100);
    doc.text("7 · SIGNATURE DE L'OPÉRATEUR", m + 3, y + 5);
    if (entry.signature) { try { doc.addImage(entry.signature, "PNG", m + 4, y + 8, 78, 30); } catch (_) {} }
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(90, 80, 72);
    doc.text("Signé électroniquement le " + dateStr + " à " + heureStr, right - 3, y + sh - 4, { align: "right" });
    y += sh + 6;

    // Pied de page
    doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(130, 130, 130);
    doc.text("Bordereau généré automatiquement par l'application « Compteur Lisier » — " + nom + ".", W / 2, 289, { align: "center" });

    var dataUri = doc.output("datauristring");
    var base64 = dataUri.substring(dataUri.indexOf("base64,") + 7);
    var filename = "Bordereau_lisier_" + isoStamp(d) + "_" + (sanitize(entry.personne) || "operateur") + ".pdf";
    return { base64: base64, filename: filename };
  }

  function downloadPdf(entry) {
    if (!entry.pdfBase64) { toast("Bordereau indisponible.", "err"); return; }
    var a = document.createElement("a");
    a.href = "data:application/pdf;base64," + entry.pdfBase64;
    a.download = entry.filename || ("bordereau-" + entry.id + ".pdf");
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }

  // -------------------- Réglages --------------------
  var _forcedOpen = false;

  function highlightRequired(on) {
    [el.opNom, el.opRaison, el.opAdresse].forEach(function (inp) {
      var empty = !(inp.value || "").trim();
      inp.classList.toggle("input--required", !!on && empty);
    });
  }

  function firstEmptyField() {
    if (!opNom()) return el.opNom;
    if (!opRaison()) return el.opRaison;
    return el.opAdresse;
  }

  function openSettings(forceRequired) {
    el.opNom.value = opNom();
    el.opRaison.value = opRaison();
    el.opAdresse.value = opAdresse();
    el.opErr.hidden = true;
    _forcedOpen = (forceRequired === true) && !isConfigComplete();
    el.reqBanner.hidden = !_forcedOpen;
    highlightRequired(_forcedOpen);
    el.settings.hidden = false;
    if (_forcedOpen) { firstEmptyField().focus(); }
  }
  function closeSettings() { _forcedOpen = false; el.settings.hidden = true; }

  // Fermeture demandée (croix / fond) : bloquée tant que la config obligatoire
  // n'est pas complète lors d'une ouverture forcée.
  function tryCloseSettings() {
    if (_forcedOpen && !isConfigComplete()) {
      el.opErr.hidden = false;
      highlightRequired(true);
      firstEmptyField().focus();
      return;
    }
    closeSettings();
  }

  function saveSettings() {
    var n = (el.opNom.value || "").trim();
    var r = (el.opRaison.value || "").trim();
    var a = (el.opAdresse.value || "").trim();
    if (!n || !r || !a) {
      el.opErr.hidden = false;
      highlightRequired(true);
      (!n ? el.opNom : !r ? el.opRaison : el.opAdresse).focus();
      return;
    }
    localStorage.setItem(LS_OP_NOM, n);
    localStorage.setItem(LS_OP_RAISON, r);
    localStorage.setItem(LS_OP_ADRESSE, a);
    el.opErr.hidden = true;
    highlightRequired(false);
    _forcedOpen = false;
    el.reqBanner.hidden = true;
    closeSettings();
    renderOpDisplay();
    toast("Informations enregistrées.", "ok");
  }

  function renderOpDisplay() {
    if (!el.opDisplay) return;
    if (isConfigComplete()) {
      el.opDisplay.innerHTML = '<span class="op-display__nom"></span><span class="op-display__soc"></span>';
      el.opDisplay.querySelector(".op-display__nom").textContent = opNom();
      el.opDisplay.querySelector(".op-display__soc").textContent = opRaison();
      el.opDisplay.classList.remove("op-display--empty");
    } else {
      el.opDisplay.textContent = "— À configurer (appuyez sur ⚙️) —";
      el.opDisplay.classList.add("op-display--empty");
    }
  }

  // -------------------- Démarrage --------------------
  function init() {
    cacheEls();
    renderOpDisplay();
    preloadLogo();

    el.form.addEventListener("submit", onSubmit);
    el.volume.addEventListener("input", function () { if (parseVolume(el.volume.value) > 0) el.volErr.hidden = true; });

    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.getAttribute("data-view")); });
    });

    $("#btnSettings").addEventListener("click", function () { openSettings(false); });
    $("#btnSaveSettings").addEventListener("click", saveSettings);
    document.querySelectorAll("[data-close]").forEach(function (b) { b.addEventListener("click", tryCloseSettings); });

    // Mise à jour de la surbrillance des champs obligatoires en direct
    [el.opNom, el.opRaison, el.opAdresse].forEach(function (inp) {
      inp.addEventListener("input", function () {
        el.opErr.hidden = true;
        if (!el.reqBanner.hidden) highlightRequired(true);
      });
    });

    // Signature (pop-up)
    $("#signValidate").addEventListener("click", onSignValidate);
    $("#signClear").addEventListener("click", clearPad);
    document.querySelectorAll("[data-sign-close]").forEach(function (b) {
      b.addEventListener("click", function () { closeSign(); pendingPump = null; });
    });
    var pad = el.signPad;
    pad.addEventListener("pointerdown", padDown);
    pad.addEventListener("pointermove", padMove);
    pad.addEventListener("pointerup", padUp);
    pad.addEventListener("pointercancel", padUp);

    window.addEventListener("online", function () { updateNet(); flushPending(); });
    window.addEventListener("offline", updateNet);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) flushPending();
    });

    updateNet();
    refreshUI().then(flushPending);

    // Première utilisation : forcer la saisie du nom, de la raison sociale et
    // de l'adresse (indispensables sur le bordereau).
    if (!isConfigComplete()) openSettings(true);

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
