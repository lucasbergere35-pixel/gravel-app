# Guide pas à pas — Gravel Compagnon

Ce guide explique comment travailler sur l'appli depuis Windows, la tester,
la mettre en ligne gratuitement et l'installer sur iPhone.

---

## 1. Les outils (une seule fois)

| Outil | À quoi il sert | Installation |
|---|---|---|
| **Node.js** (version LTS) | Exécute les outils de développement (Vite, tests) et fournit `npm`, le gestionnaire de paquets | `winget install OpenJS.NodeJS.LTS` dans PowerShell |
| **Git** | Garde l'historique du code et l'envoie sur GitHub | `winget install Git.Git` |
| **Compte GitHub** | Héberge le code et le site (gratuit, HTTPS) | https://github.com/signup |
| VS Code (facultatif) | Éditeur de code pour lire et modifier les fichiers | `winget install Microsoft.VisualStudioCode` |

Après une installation, **ferme puis rouvre** le terminal pour que la commande soit reconnue.
Pour vérifier : `node --version` et `git --version` affichent un numéro de version.

---

## 2. Tester en local sur le PC

Dans un terminal ouvert dans le dossier `C:\Users\lucas\gravel-app` :

```
npm install      (une seule fois : télécharge les librairies dans node_modules/)
npm run dev      (démarre un petit serveur local)
```

Ouvre l'adresse affichée (http://localhost:5173) dans Chrome ou Edge. Chaque fois qu'un
fichier est modifié, la page se met à jour toute seule. `Ctrl + C` arrête le serveur.

Astuce : dans Chrome, `F12`, puis l'icône téléphone (« Toggle device toolbar »), permet
de voir l'appli au format iPhone.

Autres commandes :
- `npm test` : lance les tests automatiques (calculs, lecture GPX).
- `npm run build` : vérifie le code et prépare la version de production dans `dist/`.

---

## 3. Mise en ligne sur GitHub Pages

### 3.1 Créer le dépôt (une seule fois)
1. Sur https://github.com, connecte-toi, puis **New repository** (bouton vert ou « + » en haut à droite).
2. Nom : **`gravel-app`** (exactement : l'adresse du site en dépend).
3. Visibilité : **Public** (GitHub Pages est gratuit pour les dépôts publics).
4. Ne coche **rien** d'autre (pas de README, pas de .gitignore). Clique **Create repository**.
5. Dans le dépôt : **Settings → Pages → Build and deployment → Source : GitHub Actions**.

### 3.2 Envoyer le code (une seule fois)
Indique d'abord à Git qui signe les modifications. L'adresse e-mail apparaîtra publiquement
dans l'historique du dépôt. Pour la garder privée, utilise celle que GitHub fournit dans
**Settings → Emails** (de la forme `12345678+TON-PSEUDO@users.noreply.github.com`) :
```
git config --global user.name "Ton prénom"
git config --global user.email "ton-adresse-email"
```
Puis, dans le terminal, dans le dossier du projet (remplace `TON-PSEUDO`) :
```
git remote add origin https://github.com/TON-PSEUDO/gravel-app.git
git push -u origin main
```
Une fenêtre de connexion GitHub s'ouvre la première fois : connecte-toi dans le navigateur.

### 3.3 Ensuite, à chaque modification
```
git add -A
git commit -m "Ce que j'ai changé"
git push
```
Dans l'onglet **Actions** du dépôt, un déploiement démarre (environ 1 minute). Une coche
verte veut dire que c'est en ligne. Une croix rouge veut dire qu'un test ou le build a
échoué, et rien n'a été publié.

Adresse du site : **https://TON-PSEUDO.github.io/gravel-app/**

---

## 4. Installer sur l'iPhone

1. Ouvre **Safari** (pas Chrome) et va sur `https://TON-PSEUDO.github.io/gravel-app/`.
2. Touche le bouton **Partager** (carré avec une flèche vers le haut).
3. Choisis **Sur l'écran d'accueil** (fais défiler si besoin). Laisse « Ouvrir comme app web » activé s'il est proposé.
4. Touche **Ajouter**. L'icône « Gravel Compagnon » apparaît sur l'écran d'accueil.

Lance toujours l'appli **depuis cette icône**. Elle s'ouvre alors en plein écran, et ses
données (itinéraires, profil) sont séparées de celles de Safari.

**Mises à jour** : après un `git push`, ouvre l'appli. Au bout de quelques secondes, une
bannière « Nouvelle version disponible » apparaît : touche **Mettre à jour**. Si rien
n'apparaît, ferme complètement l'appli (balayer vers le haut) et rouvre-la.

---

## 5. Récupérer un GPX depuis Komoot

1. Dans Komoot (appli ou site), ouvre l'itinéraire, puis le menu **…** et **Exporter / Télécharger en GPX**.
2. Sur iPhone : **Enregistrer dans Fichiers** (par ex. dans « Sur mon iPhone »).
3. Dans Gravel Compagnon : **＋ Importer un GPX**, puis **Choisir le fichier** et sélectionne le GPX.
