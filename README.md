# 💧 Compteur Lisier — Charles Murgat

Application **PWA** (installable sur téléphone, fonctionne hors-ligne) pour
comptabiliser les volumes de **lisier pompés**.

> **Identité visuelle** reprise de l'application sœur *Pointage CM* : charte
> Charles Murgat (crème `#f5f0e8`, or `#7a5020`, brun `#141008`), polices
> *Cormorant Garamond* + *Jost*, et logo de marque commun.

- Liste déroulante des personnes : **Nathan POINT**, **Raphaël POINT**,
  **Jean-Paul BROCHIER**
- Champ de saisie du **volume en litres**
- Bouton **Enregistrer**
- Chaque enregistrement ajoute **une ligne dans un tableur Google** (sur le
  Google Drive de l'exploitation)
- Page **Historique** conservée **en cache sur chaque téléphone**
  (pas de synchronisation de l'historique avec le tableur)

---

## 🗂️ Contenu du projet

| Fichier | Rôle |
|---|---|
| `index.html`, `styles.css`, `app.js` | L'application (interface + logique) |
| `manifest.webmanifest`, `service-worker.js` | Installation PWA + hors-ligne |
| `icons/` | Icônes de l'application |
| `google-apps-script/Code.gs` | Script Google qui ajoute une ligne au tableur |
| `google-apps-script/DEPLOIEMENT.md` | **Guide de mise en place de la synchronisation** |

---

## 🚀 Mise en route (3 étapes)

### 1. Héberger l'application (une seule fois)

L'application est faite de simples fichiers statiques. Le plus simple :
**GitHub Pages** (gratuit, adresse en `https://`, nécessaire pour une PWA).

1. Sur GitHub, ouvrir le dépôt → **Settings → Pages**.
2. **Build and deployment → Source : Deploy from a branch**.
3. Choisir la branche `claude/pwa-lisier-tracking-bzp4h1` (ou `main` après
   fusion) et le dossier **`/ (root)`**, puis **Save**.
4. Au bout d'une minute, GitHub affiche l'adresse publique, du type
   `https://<compte>.github.io/<depot>/`.

> Toute autre hébergement statique en HTTPS convient aussi (Netlify, Vercel,
> un serveur web classique…).

### 2. Relier le tableur Google

Suivre le guide **[`google-apps-script/DEPLOIEMENT.md`](google-apps-script/DEPLOIEMENT.md)**.
À la fin, on colle l'adresse du script dans l'application via l'icône **⚙️**.

### 3. Installer l'application sur les téléphones

Ouvrir l'adresse du site dans le navigateur du téléphone, puis :

- **iPhone (Safari)** : bouton **Partager** → **Sur l'écran d'accueil**.
- **Android (Chrome)** : menu **⋮** → **Installer l'application** /
  **Ajouter à l'écran d'accueil**.

L'icône 💧 apparaît alors comme une vraie application.

---

## 📶 Fonctionnement hors-ligne

- L'application se lance même **sans réseau** (mise en cache).
- Un pompage saisi hors-ligne est **conservé** puis **envoyé automatiquement**
  au tableur dès que la connexion revient (badge **⏳ En attente** → **✓ Envoyé**).
- Un **anti-doublon** (identifiant unique par pompage) garantit qu'une même
  saisie n'est **jamais ajoutée deux fois** au tableur, même en cas de renvoi.

## 🔐 Données

- L'**historique** est stocké **localement** sur chaque téléphone
  (via IndexedDB). Le vider (⚙️) n'affecte pas le tableur.
- Le **tableur Google** est la source centrale partagée par tous les téléphones.

---

## 🛠️ Développement / test en local

Servir le dossier avec n'importe quel serveur statique, par exemple :

```bash
python3 -m http.server 8080
# puis ouvrir http://localhost:8080
```

> Un service worker exige `http://localhost` ou `https://` (il ne fonctionne
> pas en `file://`).

## ✏️ Personnalisation rapide

- **Modifier la liste des personnes** : éditer les `<option>` dans `index.html`.
- **Changer les colonnes du tableur** : adapter `HEADERS` et l'ordre du
  `appendRow(...)` dans `google-apps-script/Code.gs`.
- **Couleurs / polices** : variables `--cream`, `--gold`, `--dark`… en haut de
  `styles.css` ; le logo de marque est dans `icons/logo-murgat.svg`.
- **Après modification des fichiers** : incrémenter `CACHE_VERSION` dans
  `service-worker.js` pour forcer la mise à jour sur les téléphones.
