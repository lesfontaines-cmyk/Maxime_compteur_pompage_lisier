/**
 * Compteur Lisier — Google Apps Script
 * ------------------------------------
 * Backend de l'application PWA. Se déploie en « Application Web ».
 *
 *  • Authentification (email + mot de passe) — l'accès est réellement protégé
 *    ICI, côté serveur : aucune écriture n'est acceptée sans jeton de session
 *    valide. Le login côté navigateur n'est qu'un écran ; c'est ce script qui
 *    fait foi.
 *  • Chaque pompage authentifié ajoute une ligne dans la feuille « Pompages »
 *    avec l'identité RATTACHÉE AU COMPTE (pas de valeurs envoyées par le client).
 *
 * Colonnes de « Pompages » :
 *   Date | Heure | Entreprise | Adresse | Intervenant | Volume (L) | Bordereau
 *
 * Création d'un accès (réservé à l'administrateur) : lancer la fonction
 *   inviteUser("email@exemple.fr")
 * depuis l'éditeur Apps Script. L'utilisateur reçoit un email avec un lien
 * pour choisir son mot de passe et son identité depuis l'application.
 *
 * Voir DEPLOIEMENT.md pour la mise en place pas à pas.
 */

// ------------------------------------------------------------------
//  CONFIGURATION
// ------------------------------------------------------------------
// Tableur cible (Google Sheet). Vide = tableur auquel le script est rattaché.
var SHEET_ID = "1xPk6AUAe6gHjqDAIR127QpAm0K0CP4dRLzn3XZ40XKk";

// Adresse publique de l'application (pour composer le lien d'inscription).
var APP_URL = "https://pompage-lisier.charlesmurgat.com";

var DATA_SHEET = "Pompages";       // feuille des données visibles
var ID_SHEET = "_ids";             // feuille technique masquée (anti-doublon)
var USERS_SHEET = "Utilisateurs";  // feuille technique masquée (comptes)
var HEADERS = ["Date", "Heure", "Entreprise", "Adresse", "Intervenant", "Volume (L)", "Bordereau"];
var USERS_HEADERS = ["Email", "Statut", "Sel", "Hash", "JetonHash", "JetonExp",
                     "Nom", "Raison", "Adresse", "Sessions", "CreeLe", "MajLe"];

// Dossier Drive où sont archivés les bordereaux PDF signés.
var FOLDER_NAME = "Bordereaux pompage lisier"; // utilisé seulement si FOLDER_ID est vide
var FOLDER_ID = "1aXLN6VTcW2NHr37qWolw58DRtTXmlbtE"; // dossier « bordereaux » de l'exploitation

// Paramètres de sécurité.
var SESSION_TTL_DAYS = 30;   // durée de vie d'une session
var SIGNUP_TTL_HOURS = 72;   // durée de validité d'un lien d'inscription
var HASH_ITER = 5000;        // itérations de hachage du mot de passe
var MIN_PASSWORD = 8;        // longueur minimale du mot de passe

// ------------------------------------------------------------------
//  POINTS D'ENTRÉE HTTP
// ------------------------------------------------------------------

/** Vérification simple depuis un navigateur. */
function doGet() {
  return json({ ok: true, service: "Compteur Lisier", time: new Date().toISOString() });
}

/** Toutes les requêtes de l'application passent par ici (routées par `action`). */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return json({ ok: false, error: "busy" }); }
  try {
    if (!e || !e.postData || !e.postData.contents) return json({ ok: false, error: "no-data" });
    var data = JSON.parse(e.postData.contents);
    var action = String(data.action || "pump").trim();
    var ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();

    if (action === "login") return handleLogin_(ss, data);
    if (action === "finalizeSignup") return handleFinalize_(ss, data);
    if (action === "signupInfo") return handleSignupInfo_(ss, data);
    if (action === "session") return handleSessionCheck_(ss, data);
    if (action === "pump") return handlePump_(ss, data);
    return json({ ok: false, error: "unknown-action" });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ------------------------------------------------------------------
//  AUTHENTIFICATION
// ------------------------------------------------------------------

/** Connexion : email + mot de passe -> jeton de session + profil. */
function handleLogin_(ss, data) {
  var email = lc_(data.email);
  var pw = String(data.password || "");
  if (!email || !pw) return json({ ok: false, error: "invalid" });
  var sheet = usersSheet_(ss);
  var u = userRowByEmail_(sheet, email);
  // Réponse volontairement générique (ne révèle pas si l'email existe).
  if (!u || getField_(u.values, "Statut") !== "actif") return json({ ok: false, error: "auth" });
  var salt = getField_(u.values, "Sel"), hash = getField_(u.values, "Hash");
  if (!salt || !hash || !constantTimeEq_(hashPw_(pw, salt), hash)) return json({ ok: false, error: "auth" });
  var token = addSession_(sheet, u.row, u.values);
  return json({ ok: true, token: token, profile: profileFromRow_(u.values) });
}

/** Finalisation d'inscription : jeton du lien + mot de passe + identité. */
function handleFinalize_(ss, data) {
  var token = String(data.token || "").trim();
  var pw = String(data.password || "");
  var nom = String(data.nom || "").trim();
  var raison = String(data.raison || "").trim();
  var adresse = String(data.adresse || "").trim();
  if (!token) return json({ ok: false, error: "invalid" });
  if (pw.length < MIN_PASSWORD) return json({ ok: false, error: "weak-password" });
  if (!nom || !raison || !adresse) return json({ ok: false, error: "missing-identity" });

  var sheet = usersSheet_(ss);
  var u = userRowByJeton_(sheet, sha256Hex_(token));
  if (!u) return json({ ok: false, error: "bad-token" });
  var exp = Number(getField_(u.values, "JetonExp") || 0);
  if (!exp || exp < nowMs_()) return json({ ok: false, error: "expired-token" });

  var salt = makeSalt_();
  setField_(u.values, "Sel", salt);
  setField_(u.values, "Hash", hashPw_(pw, salt));
  setField_(u.values, "Nom", nom);
  setField_(u.values, "Raison", raison);
  setField_(u.values, "Adresse", adresse);
  setField_(u.values, "Statut", "actif");
  setField_(u.values, "JetonHash", "");   // le lien d'inscription est consommé
  setField_(u.values, "JetonExp", "");
  setField_(u.values, "MajLe", new Date());
  var newToken = addSession_(sheet, u.row, u.values); // écrit la ligne + ouvre une session
  return json({ ok: true, token: newToken, profile: profileFromRow_(u.values) });
}

/** Renvoie l'email associé à un lien d'inscription encore valide. */
function handleSignupInfo_(ss, data) {
  var token = String(data.token || "").trim();
  if (!token) return json({ ok: false });
  var u = userRowByJeton_(usersSheet_(ss), sha256Hex_(token));
  if (!u) return json({ ok: false });
  var exp = Number(getField_(u.values, "JetonExp") || 0);
  if (!exp || exp < nowMs_()) return json({ ok: false, error: "expired" });
  return json({ ok: true, email: getField_(u.values, "Email") });
}

/** Validité d'une session (re-connexion automatique à l'ouverture de l'app). */
function handleSessionCheck_(ss, data) {
  var auth = validateSessionToken_(ss, String(data.token || "").trim());
  if (!auth) return json({ ok: false });
  return json({ ok: true, profile: profileFromRow_(auth.values) });
}

// ------------------------------------------------------------------
//  ENREGISTREMENT D'UN POMPAGE (authentifié)
// ------------------------------------------------------------------
function handlePump_(ss, data) {
  var auth = validateSessionToken_(ss, String(data.token || "").trim());
  if (!auth) return json({ ok: false, error: "unauthorized" });

  // L'identité vient du COMPTE, jamais du client (anti-usurpation).
  var prof = profileFromRow_(auth.values);
  var personne = prof.nom, entreprise = prof.raison, adresse = prof.adresse;
  var volume = Number(data.volumeL);
  var id = String(data.id || "").trim();
  if (!(volume > 0)) return json({ ok: false, error: "invalid" });

  // Anti-doublon
  if (id) {
    var ids = getOrCreateIdSheet_(ss);
    var last = ids.getLastRow();
    if (last > 0) {
      var found = ids.getRange(1, 1, last, 1).createTextFinder(id).matchEntireCell(true).findNext();
      if (found) return json({ ok: true, duplicate: true });
    }
    ids.appendRow([id]);
  }

  // Bordereau PDF signé -> dossier Drive
  var fileUrl = "";
  if (data.pdfBase64 && data.filename) {
    try {
      var folder = getOrCreateBordereauxFolder_(ss);
      var bytes = Utilities.base64Decode(data.pdfBase64);
      var blob = Utilities.newBlob(bytes, "application/pdf", String(data.filename));
      fileUrl = folder.createFile(blob).getUrl();
    } catch (e2) {
      fileUrl = "ERREUR PDF: " + e2;
    }
  }

  var sheet = getOrCreateDataSheet_(ss);
  var ts = data.ts ? new Date(data.ts) : new Date();
  var tz = ss.getSpreadsheetTimeZone() || "Europe/Paris";
  var dateStr = Utilities.formatDate(ts, tz, "dd/MM/yyyy");
  var heureStr = Utilities.formatDate(ts, tz, "HH:mm");

  sheet.appendRow([dateStr, heureStr, entreprise, adresse, personne, volume, fileUrl]);
  return json({ ok: true, fileUrl: fileUrl });
}

// ------------------------------------------------------------------
//  ADMINISTRATION (à lancer depuis l'éditeur Apps Script)
// ------------------------------------------------------------------

/**
 * Crée (ou ré-invite) un accès et envoie le lien d'inscription par email.
 * Usage : sélectionner cette fonction dans l'éditeur, la lancer, saisir
 * l'email OU l'appeler ainsi : inviteUser("prenom.nom@exemple.fr")
 */
function inviteUser(email) {
  email = lc_(email);
  if (!email || email.indexOf("@") < 1) throw new Error("Email invalide : " + email);
  var ss = adminSS_();
  var sheet = usersSheet_(ss);
  var raw = randToken_();
  var exp = nowMs_() + SIGNUP_TTL_HOURS * 3600 * 1000;
  var u = userRowByEmail_(sheet, email);
  if (u) {
    setField_(u.values, "JetonHash", sha256Hex_(raw));
    setField_(u.values, "JetonExp", exp);
    if (getField_(u.values, "Statut") !== "actif") setField_(u.values, "Statut", "invite");
    setField_(u.values, "MajLe", new Date());
    writeRow_(sheet, u.row, u.values);
  } else {
    var vals = emptyUser_();
    setField_(vals, "Email", email);
    setField_(vals, "Statut", "invite");
    setField_(vals, "JetonHash", sha256Hex_(raw));
    setField_(vals, "JetonExp", exp);
    setField_(vals, "Sessions", "[]");
    setField_(vals, "CreeLe", new Date());
    setField_(vals, "MajLe", new Date());
    sheet.appendRow(vals);
  }
  var link = APP_URL + "?signup=" + raw;
  sendSignupEmail_(email, link, false);
  Logger.log("Invitation envoyée à " + email + "\n" + link);
  return link;
}

/** Ré-émet un lien pour redéfinir le mot de passe d'un utilisateur existant. */
function resetUserPassword(email) {
  email = lc_(email);
  var ss = adminSS_();
  var sheet = usersSheet_(ss);
  var u = userRowByEmail_(sheet, email);
  if (!u) throw new Error("Utilisateur introuvable : " + email);
  var raw = randToken_();
  setField_(u.values, "JetonHash", sha256Hex_(raw));
  setField_(u.values, "JetonExp", nowMs_() + SIGNUP_TTL_HOURS * 3600 * 1000);
  setField_(u.values, "MajLe", new Date());
  writeRow_(sheet, u.row, u.values);
  var link = APP_URL + "?signup=" + raw;
  sendSignupEmail_(email, link, true);
  Logger.log("Lien de réinitialisation envoyé à " + email + "\n" + link);
  return link;
}

/** Désactive un accès et révoque ses sessions. */
function deactivateUser(email) {
  email = lc_(email);
  var sheet = usersSheet_(adminSS_());
  var u = userRowByEmail_(sheet, email);
  if (!u) throw new Error("Utilisateur introuvable : " + email);
  setField_(u.values, "Statut", "desactive");
  setField_(u.values, "Sessions", "[]");
  setField_(u.values, "MajLe", new Date());
  writeRow_(sheet, u.row, u.values);
  Logger.log("Accès désactivé : " + email);
}

/** Liste les comptes (dans le journal d'exécution). */
function listUsers() {
  var sheet = usersSheet_(adminSS_());
  var last = sheet.getLastRow();
  if (last < 2) { Logger.log("Aucun utilisateur."); return; }
  var all = sheet.getRange(2, 1, last - 1, USERS_HEADERS.length).getValues();
  all.forEach(function (v) { Logger.log(getField_(v, "Email") + " — " + getField_(v, "Statut")); });
}

function adminSS_() {
  return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function sendSignupEmail_(email, link, isReset) {
  var subject = isReset
    ? "Réinitialisation de votre accès — Compteur Lisier"
    : "Votre accès à l'application Compteur Lisier";
  var intro = isReset
    ? "Une réinitialisation de votre mot de passe a été demandée."
    : "Un accès à l'application Compteur Lisier a été créé pour vous.";
  var verbe = isReset ? "redéfinir votre mot de passe" : "choisir votre mot de passe et finaliser votre inscription";
  var html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#141008;line-height:1.6">' +
    "<p>Bonjour,</p>" +
    "<p>" + intro + " Pour " + verbe + ", ouvrez ce lien depuis votre téléphone :</p>" +
    '<p><a href="' + link + '" style="display:inline-block;padding:12px 22px;background:#7a5020;' +
    'color:#ffffff;text-decoration:none;border-radius:4px;font-weight:bold">Finaliser mon accès</a></p>' +
    '<p style="font-size:13px;color:#5a5048">Si le bouton ne fonctionne pas, copiez ce lien :<br>' + link + "</p>" +
    '<p style="font-size:13px;color:#5a5048">Ce lien est valable ' + SIGNUP_TTL_HOURS + " heures.</p>" +
    '<p style="font-size:12px;color:#8a8378">Si vous n\'êtes pas concerné par ce message, ignorez-le.</p>' +
    "</div>";
  MailApp.sendEmail({ to: email, subject: subject, htmlBody: html, name: "Compteur Lisier" });
}

// ------------------------------------------------------------------
//  FEUILLE « Utilisateurs » + sessions
// ------------------------------------------------------------------
function usersSheet_(ss) {
  var s = ss.getSheetByName(USERS_SHEET);
  if (!s) {
    s = ss.insertSheet(USERS_SHEET);
    s.getRange(1, 1, 1, USERS_HEADERS.length).setValues([USERS_HEADERS]).setFontWeight("bold");
    s.setFrozenRows(1);
    s.hideSheet();
  }
  return s;
}
function emptyUser_() { var a = []; for (var i = 0; i < USERS_HEADERS.length; i++) a.push(""); return a; }
function colIdx_(name) { return USERS_HEADERS.indexOf(name); }
function getField_(vals, name) { return vals[colIdx_(name)]; }
function setField_(vals, name, v) { vals[colIdx_(name)] = v; }
function writeRow_(sheet, row, vals) { sheet.getRange(row, 1, 1, USERS_HEADERS.length).setValues([vals]); }
function profileFromRow_(vals) {
  return {
    email: getField_(vals, "Email"),
    nom: getField_(vals, "Nom"),
    raison: getField_(vals, "Raison"),
    adresse: getField_(vals, "Adresse")
  };
}

function userRowByEmail_(sheet, email) {
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var col = sheet.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (lc_(col[i][0]) === email) {
      var row = i + 2;
      return { row: row, values: sheet.getRange(row, 1, 1, USERS_HEADERS.length).getValues()[0] };
    }
  }
  return null;
}
function userRowByJeton_(sheet, jetonHash) {
  var last = sheet.getLastRow();
  if (last < 2 || !jetonHash) return null;
  var jc = colIdx_("JetonHash") + 1;
  var col = sheet.getRange(2, jc, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    if (String(col[i][0]) && String(col[i][0]) === jetonHash) {
      var row = i + 2;
      return { row: row, values: sheet.getRange(row, 1, 1, USERS_HEADERS.length).getValues()[0] };
    }
  }
  return null;
}

/** Ajoute une session (jeton aléatoire), purge les expirées, écrit la ligne. */
function addSession_(sheet, row, vals) {
  var raw = randToken_();
  var now = nowMs_();
  var arr = [];
  try { arr = JSON.parse(getField_(vals, "Sessions") || "[]"); } catch (_) { arr = []; }
  arr = arr.filter(function (s) { return s && s.e > now; });
  arr.push({ t: sha256Hex_(raw), e: now + SESSION_TTL_DAYS * 24 * 3600 * 1000 });
  if (arr.length > 20) arr = arr.slice(arr.length - 20);
  setField_(vals, "Sessions", JSON.stringify(arr));
  writeRow_(sheet, row, vals);
  return raw;
}

/** Retrouve l'utilisateur actif détenteur d'une session valide, sinon null. */
function validateSessionToken_(ss, token) {
  if (!token) return null;
  var hash = sha256Hex_(token);
  var sheet = usersSheet_(ss);
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var all = sheet.getRange(2, 1, last - 1, USERS_HEADERS.length).getValues();
  var now = nowMs_();
  for (var i = 0; i < all.length; i++) {
    if (getField_(all[i], "Statut") !== "actif") continue;
    var arr;
    try { arr = JSON.parse(getField_(all[i], "Sessions") || "[]"); } catch (_) { arr = []; }
    for (var j = 0; j < arr.length; j++) {
      if (arr[j] && arr[j].t === hash && arr[j].e > now) return { row: i + 2, values: all[i] };
    }
  }
  return null;
}

// ------------------------------------------------------------------
//  CRYPTO / UTILITAIRES
// ------------------------------------------------------------------
function lc_(s) { return String(s || "").trim().toLowerCase(); }
function nowMs_() { return new Date().getTime(); }

function sha256Hex_(str) {
  var raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str), Utilities.Charset.UTF_8);
  var out = "";
  for (var i = 0; i < raw.length; i++) {
    var b = (raw[i] + 256) % 256;
    out += (b < 16 ? "0" : "") + b.toString(16);
  }
  return out;
}
function randToken_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ""); }
function makeSalt_() { return randToken_().substring(0, 32); }

/** Hachage salé et itéré du mot de passe (pas de bcrypt en Apps Script). */
function hashPw_(pw, salt) {
  var h = String(pw);
  for (var i = 0; i < HASH_ITER; i++) h = sha256Hex_(salt + "|" + h);
  return h;
}
function constantTimeEq_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var r = 0;
  for (var i = 0; i < a.length; i++) r |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return r === 0;
}

// ------------------------------------------------------------------
//  FEUILLE « Pompages » + anti-doublon + Drive (inchangé)
// ------------------------------------------------------------------
function getOrCreateDataSheet_(ss) {
  var sheet = ss.getSheetByName(DATA_SHEET);
  if (!sheet) {
    var first = ss.getSheets()[0];
    if (first && first.getLastRow() === 0 && ss.getSheets().length === 1) {
      first.setName(DATA_SHEET);
      sheet = first;
    } else {
      sheet = ss.insertSheet(DATA_SHEET);
    }
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, HEADERS.length, 130);
  } else {
    migrateHeaders_(sheet);
  }
  return sheet;
}

/**
 * Migration douce et idempotente des tableurs créés avant l'ajout des
 * colonnes « Entreprise » et « Adresse ». On insère chaque colonne manquante à
 * sa place et on renomme l'ancienne colonne « Personne » en « Intervenant » :
 * les lignes déjà présentes restent alignées (colonnes ajoutées laissées vides
 * pour l'historique). Peut être rejouée sans effet si tout est déjà en place.
 */
function migrateHeaders_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  var persIdx = header.indexOf("Personne");
  if (persIdx !== -1) {
    sheet.getRange(1, persIdx + 1).setValue("Intervenant");
    header[persIdx] = "Intervenant";
  }
  if (header.indexOf("Entreprise") === -1) {
    var interIdx = header.indexOf("Intervenant");
    var at = (interIdx === -1) ? header.length : interIdx;
    sheet.insertColumnBefore(at + 1);
    sheet.getRange(1, at + 1).setValue("Entreprise");
    sheet.setColumnWidth(at + 1, 150);
    header.splice(at, 0, "Entreprise");
  }
  if (header.indexOf("Adresse") === -1) {
    var entIdx = header.indexOf("Entreprise");
    var at2 = (entIdx === -1) ? header.length : entIdx + 1;
    sheet.insertColumnBefore(at2 + 1);
    sheet.getRange(1, at2 + 1).setValue("Adresse");
    sheet.setColumnWidth(at2 + 1, 200);
    header.splice(at2, 0, "Adresse");
  }
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight("bold");
}

function getOrCreateIdSheet_(ss) {
  var s = ss.getSheetByName(ID_SHEET);
  if (!s) {
    s = ss.insertSheet(ID_SHEET);
    s.getRange(1, 1).setValue("id");
    s.hideSheet();
  }
  return s;
}

function getOrCreateBordereauxFolder_(ss) {
  if (FOLDER_ID) return DriveApp.getFolderById(FOLDER_ID);
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var it = parent.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(FOLDER_NAME);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
