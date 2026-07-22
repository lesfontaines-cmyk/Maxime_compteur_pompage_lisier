# Mise en place de la synchronisation Google Sheet

Ce guide explique comment relier l'application **Compteur Lisier** à un tableur
Google, pour qu'**une nouvelle ligne soit ajoutée automatiquement à chaque
pompage enregistré**.

> **Pourquoi un Google Sheet et pas un fichier Excel (.xlsx) ?**
> Une application web ne peut pas modifier directement un fichier `.xlsx` posé
> sur un Google Drive. En revanche, elle peut écrire dans un **Google Sheet**
> via un petit script. Un Google Sheet se comporte comme Excel et peut être
> **téléchargé en `.xlsx` à tout moment** (menu *Fichier → Télécharger →
> Microsoft Excel*). C'est la méthode recommandée, gratuite et fiable.

---

## Étape 1 — Créer le tableur

1. Aller sur https://sheets.google.com (avec le compte Google du Drive de
   l'exploitation).
2. Créer un tableur vierge, le nommer par exemple **« Pompage lisier »**.
   Les colonnes (Date, Heure, Personne, Volume (L)) seront créées
   automatiquement par le script — rien à préparer.

## Étape 2 — Ouvrir l'éditeur de script

1. Dans le tableur : menu **Extensions → Apps Script**.
2. Un nouvel onglet s'ouvre avec un fichier `Code.gs` contenant un exemple.
3. **Tout sélectionner et supprimer**, puis **copier-coller** l'intégralité du
   fichier [`Code.gs`](./Code.gs) de ce dépôt.
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

## Étape 6 — Configurer l'application

1. Ouvrir l'application **Compteur Lisier** sur le téléphone (ou dans le
   navigateur).
2. Appuyer sur l'icône **⚙️** en haut à droite.
3. **Coller l'adresse** dans le champ « Adresse du script Google ».
4. Appuyer sur **Tester la connexion** → le message « ✓ Connexion réussie »
   doit apparaître.
5. Appuyer sur **Enregistrer**.

## Étape 7 — Vérifier

1. Sur l'écran **Saisie**, choisir une personne, saisir un volume, appuyer sur
   **Enregistrer le pompage**.
2. Retourner dans le tableur Google : **une nouvelle ligne** doit être apparue.
3. Dans l'application, l'historique affiche le badge **✓ Envoyé**.

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
- **Plusieurs téléphones ?** Oui : mettez la **même adresse** dans le réglage
  ⚙️ de chaque téléphone. Toutes les saisies arrivent dans le même tableur.
- **Un badge « ⏳ En attente » reste affiché ?** Le téléphone était hors ligne
  au moment de la saisie. Dès que la connexion revient, l'envoi se fait tout
  seul ; vous pouvez aussi forcer via ⚙️ → « Renvoyer les pompages en attente ».
  Grâce à l'anti-doublon, un même pompage n'est jamais compté deux fois.
- **Récupérer un vrai fichier Excel ?** Dans le tableur : *Fichier → Télécharger
  → Microsoft Excel (.xlsx)*.
