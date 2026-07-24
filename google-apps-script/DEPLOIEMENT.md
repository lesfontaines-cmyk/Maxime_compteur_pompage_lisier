# Mise en place de la synchronisation Google Sheet

Ce guide explique comment relier l'application **Compteur Lisier** à un tableur
Google, pour qu'**une nouvelle ligne soit ajoutée automatiquement à chaque
pompage enregistré**, et que le **bordereau PDF signé** soit **archivé dans un
dossier Google Drive**.

> **Pourquoi un Google Sheet et pas un fichier Excel (.xlsx) ?**
> Une application web ne peut pas modifier directement un fichier `.xlsx` posé
> sur un Google Drive. En revanche, elle peut écrire dans un **Google Sheet**
> via un petit script. Un Google Sheet se comporte comme Excel et peut être
> **téléchargé en `.xlsx` à tout moment** (menu *Fichier → Télécharger →
> Microsoft Excel*). C'est la méthode recommandée, gratuite et fiable.

---

## Étape 1 — Ouvrir le tableur (déjà prêt)

Le tableur Google et le dossier des bordereaux existent déjà, et le script
[`Code.gs`](./Code.gs) est **pré-configuré avec leurs identifiants**
(`SHEET_ID` et `FOLDER_ID` en haut du fichier) — **rien à modifier dans le
code**.

1. Ouvrir le **Google Sheet** de l'exploitation (le tableur « pompage lisier »).

## Étape 2 — Coller le script

1. Dans le tableur : menu **Extensions → Apps Script**.
2. Un nouvel onglet s'ouvre avec un fichier `Code.gs` d'exemple.
3. **Tout sélectionner et supprimer**, puis **copier-coller** l'intégralité du
   fichier [`Code.gs`](./Code.gs) de ce dépôt (déjà configuré, ne rien changer).
4. Cliquer sur l'icône **💾 Enregistrer** (ou Ctrl/Cmd + S).

## Étape 3 — Déployer en application web

1. En haut à droite, cliquer sur **Déployer → Nouveau déploiement**.
2. Cliquer sur l'engrenage ⚙️ à côté de « Sélectionner le type » puis choisir
   **Application Web**.
3. Renseigner :
   - **Description** : `Compteur Lisier`
   - **Exécuter en tant que** : **Moi** (votre compte)
   - **Qui a accès** : **Tout le monde**
     *(indispensable pour que les téléphones puissent envoyer les données)*
4. Cliquer sur **Déployer**.

## Étape 4 — Autoriser (première fois seulement)

Google demande une autorisation la première fois :

1. Cliquer sur **Autoriser l'accès**, choisir votre compte Google.
2. Un écran « **Google n'a pas validé cette application** » peut apparaître
   (c'est normal, c'est *votre* script) :
   cliquer sur **Paramètres avancés**, puis
   **Accéder à « Compteur Lisier » (non sécurisé)**.
3. Cliquer sur **Autoriser**.

## Étape 5 — Copier l'adresse

Après le déploiement, Google affiche une **URL d'application Web** qui se termine
par **`/exec`**, par exemple :

```
https://script.google.com/macros/s/AKfycb.../exec
```

**Copier cette adresse.**

## Étape 6 — Inscrire l'adresse dans l'application

L'adresse du script est **écrite en dur dans le code** (l'opérateur n'a rien à
configurer). Il suffit de renseigner **une seule fois** la constante
`ENDPOINT_URL`, tout en haut du fichier [`app.js`](../app.js) :

```js
var ENDPOINT_URL = "https://script.google.com/macros/s/AKfycb.../exec";
```

Puis pousser la modification (elle se déploiera automatiquement sur le site).
En pratique : **communiquez l'adresse `/exec` à l'administrateur du projet**, qui
l'inscrira dans `app.js`.

> L'adresse `/exec` est déjà renseignée dans `app.js` (constante `ENDPOINT_URL`).

## Étape 7 — Créer les accès (comptes) et vérifier

L'application est **protégée par un login** : aucun enregistrement n'est accepté
sans compte valide. Voir la section **« Comptes & accès sécurisé »** ci-dessous
pour créer un premier accès, puis :

1. Ouvrir l'application, **se connecter** avec l'email + le mot de passe choisi.
2. Sur l'écran **Saisie**, saisir un volume et appuyer sur **Enregistrer le
   pompage**, puis signer.
3. Retourner dans le tableur Google : **une nouvelle ligne** doit être apparue
   (colonnes *Entreprise · Adresse · Intervenant* issues du **compte**).
4. Dans l'application, l'historique affiche le badge **✓ Envoyé**.

---

## Comptes & accès sécurisé (login)

L'accès est **imposé côté serveur** (ce script) : le login de l'application n'est
qu'un écran, c'est le script qui vérifie l'identité avant toute écriture. Les
comptes sont stockés dans une feuille technique masquée **« Utilisateurs »**
(mots de passe **hachés + salés**, jamais en clair).

### Créer un accès pour quelqu'un — le plus simple : le menu

Un menu **« Compteur Lisier »** apparaît directement dans la barre de menus du
**tableur** (à côté de *Fichier, Édition…*). Depuis là, aucune ligne de code à
écrire :

1. Ouvrir le **tableur** (pas l'éditeur de code). *Si le menu n'apparaît pas,
   recharger la page du tableur : il se crée à l'ouverture.*
2. Menu **Compteur Lisier → ➕ Inviter un utilisateur…**
3. Taper l'**adresse email** dans la fenêtre qui s'ouvre, valider.
4. La personne reçoit **un email** avec un lien. En l'ouvrant **depuis son
   téléphone**, l'application lui propose de **choisir son mot de passe et son
   identité** (nom, raison sociale, adresse — qui figureront sur ses bordereaux).

> La **première** utilisation du menu demande une autorisation Google (envoi
> d'emails) : accepter.

Le même menu propose aussi **🔑 Réinitialiser un mot de passe…**,
**🚫 Désactiver un accès…** et **👥 Lister les utilisateurs**.

### Équivalent en ligne de commande (éditeur Apps Script)

Si tu préfères l'éditeur, les mêmes actions existent en fonctions (écrire l'appel
en bas du fichier puis **Exécuter**) :

| Fonction | Effet |
|---|---|
| `inviteUser("email")` | Crée un accès (ou ré-invite) et envoie le lien d'inscription. |
| `resetUserPassword("email")` | Renvoie un lien pour redéfinir le mot de passe. |
| `deactivateUser("email")` | Désactive l'accès et **révoque toutes ses sessions**. |
| `listUsers()` | Liste les comptes et leur statut (dans le journal d'exécution). |

> **Autorisation Gmail.** L'envoi des emails d'invitation utilise votre compte
> Google. Au **premier** `inviteUser` (ou au redéploiement après cette mise à
> jour), Google redemandera une autorisation (« Envoyer des emails en votre
> nom ») : acceptez-la.

> **Astuce.** Le lien d'inscription est aussi affiché dans le **journal
> d'exécution** d'Apps Script (utile si l'email met du temps à arriver).

---

## Mettre à jour le script plus tard

Si le fichier `Code.gs` change :

1. Coller la nouvelle version dans l'éditeur Apps Script, **Enregistrer**.
2. **Déployer → Gérer les déploiements** → crayon ✏️ (modifier) →
   **Version : Nouvelle version** → **Déployer**.
3. L'URL `/exec` **reste la même** : rien à modifier dans l'application.

## Questions fréquentes

- **Faut-il un abonnement ?** Non, Apps Script et Google Sheets sont gratuits
  pour cet usage.
- **Plusieurs téléphones / utilisateurs ?** Oui : chaque personne se connecte
  avec **son propre compte**. Toutes les saisies arrivent dans le même tableur,
  avec l'identité de chaque intervenant.
- **Un badge « ⏳ En attente » reste affiché ?** Le téléphone était hors ligne
  au moment de la saisie. Dès que la connexion revient, l'envoi se fait tout
  seul. Grâce à l'anti-doublon, un même pompage n'est jamais compté deux fois.
- **Mot de passe oublié ?** L'administrateur lance `resetUserPassword("email")`
  dans Apps Script : la personne reçoit un lien pour en choisir un nouveau.
- **Récupérer un vrai fichier Excel ?** Dans le tableur : *Fichier → Télécharger
  → Microsoft Excel (.xlsx)*.
- **Où sont rangés les bordereaux PDF signés ?** Dans un dossier
  **« Bordereaux pompage lisier »** créé automatiquement **à côté du tableur**
  (même dossier Drive). La colonne *Bordereau* du tableur contient le lien direct
  vers chaque PDF. Pour imposer un autre dossier, collez son identifiant dans la
  variable `FOLDER_ID` en haut du script.
- **Google demande une autorisation « Voir et gérer les fichiers Google Drive » ?**
  C'est normal et nécessaire : le script doit pouvoir **enregistrer les PDF**
  dans votre Drive. Acceptez. (Si vous aviez déjà déployé la version sans PDF,
  refaites *Déployer → Gérer les déploiements → Nouvelle version* : Google
  redemandera l'autorisation Drive.)
