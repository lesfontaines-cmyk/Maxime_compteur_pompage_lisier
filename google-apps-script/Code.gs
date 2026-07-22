/**
 * Compteur Lisier — Google Apps Script
 * ------------------------------------
 * Reçoit chaque pompage envoyé par l'application PWA et ajoute une ligne
 * dans le tableur (Google Sheet). Se déploie en « Application Web ».
 *
 * Colonnes créées automatiquement : Date | Heure | Personne | Volume (L)
 *
 * Anti-doublon : chaque pompage possède un identifiant unique (id). Les
 * identifiants déjà traités sont mémorisés dans une feuille technique masquée
 * « _ids » afin qu'un renvoi (après une coupure réseau) ne crée pas de
 * ligne en double.
 *
 * Voir DEPLOIEMENT.md pour la mise en place pas à pas.
 */

var DATA_SHEET = "Pompages"; // feuille des données visibles
var ID_SHEET = "_ids";       // feuille technique masquée (anti-doublon)
var HEADERS = ["Date", "Heure", "Personne", "Volume (L)", "Bordereau"];
var FOLDER_NAME = "Bordereaux pompage lisier"; // dossier Drive des PDF signés
var FOLDER_ID = ""; // (facultatif) forcer un dossier précis : coller son identifiant ici

/** Vérification simple depuis un navigateur (bouton « Tester la connexion »). */
function doGet() {
  return json({ ok: true, service: "Compteur Lisier", time: new Date().toISOString() });
}

/** Réception d'un pompage (POST) depuis l'application. */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // évite les écritures simultanées
  } catch (err) {
    return json({ ok: false, error: "busy" });
  }
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: "no-data" });
    }
    var data = JSON.parse(e.postData.contents);
    var personne = String(data.personne || "").trim();
    var volume = Number(data.volumeL);
    var id = String(data.id || "").trim();

    if (!personne || !(volume > 0)) {
      return json({ ok: false, error: "invalid" });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

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

    // Bordereau PDF signé -> enregistrement dans un dossier Drive
    var fileUrl = "";
    if (data.pdfBase64 && data.filename) {
      try {
        var folder = getOrCreateBordereauxFolder_(ss);
        var bytes = Utilities.base64Decode(data.pdfBase64);
        var blob = Utilities.newBlob(bytes, "application/pdf", String(data.filename));
        var file = folder.createFile(blob);
        fileUrl = file.getUrl();
      } catch (e2) {
        fileUrl = "ERREUR PDF: " + e2;
      }
    }

    var sheet = getOrCreateDataSheet_(ss);
    var ts = data.ts ? new Date(data.ts) : new Date();
    var tz = ss.getSpreadsheetTimeZone() || "Europe/Paris";
    var dateStr = Utilities.formatDate(ts, tz, "dd/MM/yyyy");
    var heureStr = Utilities.formatDate(ts, tz, "HH:mm");

    sheet.appendRow([dateStr, heureStr, personne, volume, fileUrl]);
    return json({ ok: true, fileUrl: fileUrl });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/** Récupère (ou crée) la feuille de données, avec en-têtes. */
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
  }
  return sheet;
}

/** Récupère (ou crée) la feuille technique masquée des identifiants. */
function getOrCreateIdSheet_(ss) {
  var s = ss.getSheetByName(ID_SHEET);
  if (!s) {
    s = ss.insertSheet(ID_SHEET);
    s.getRange(1, 1).setValue("id"); // ligne 1 = en-tête technique
    s.hideSheet();
  }
  return s;
}

/**
 * Dossier Drive où sont archivés les bordereaux PDF.
 * - Si FOLDER_ID est renseigné, on l'utilise.
 * - Sinon, on crée/retrouve un sous-dossier FOLDER_NAME à côté du tableur.
 */
function getOrCreateBordereauxFolder_(ss) {
  if (FOLDER_ID) return DriveApp.getFolderById(FOLDER_ID);
  var parents = DriveApp.getFileById(ss.getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var it = parent.getFoldersByName(FOLDER_NAME);
  return it.hasNext() ? it.next() : parent.createFolder(FOLDER_NAME);
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
