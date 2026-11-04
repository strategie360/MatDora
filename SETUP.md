# MatDora : mise en place

## Les pages

| Page | Pour qui | Adresse |
| --- | --- | --- |
| `index.html` | La Fire TV (demande le code du site) | `https://<site>/` |
| `admin.html` | Les admins (identifiant + mot de passe) : slides, photos, repas, code du site | `https://<site>/admin.html` |

Ajouter `#mock` à la fin d'une adresse lance le **mode démo** : des données d'exemple, stockées
seulement dans ce navigateur. Pratique pour essayer sans rien casser. En démo, le dashboard
s'ouvre avec l'identifiant `admin` et le mot de passe `admin`.

## Sécurité

- **Dashboard** : connexion par identifiant + mot de passe (comptes Supabase Auth). Seuls les
  comptes listés dans la table `admins` peuvent modifier quoi que ce soit : Supabase refuse
  toute écriture sinon, même en appelant l'API directement.
- **Site** : un code d'accès réglé dans le dashboard (onglet **Accès**). Sans le bon code,
  Supabase ne renvoie aucune donnée. La TV le demande une fois puis s'en souvient.
  Seule son empreinte (sha256) est enregistrée, jamais le code en clair.
- Le contenu fixe de la page (compte à rebours de Dora, rappel Jira…) fait partie du code du
  site : il est protégé par l'écran de code, mais reste lisible dans le code source.
- Les fichiers photo restent publics par leur adresse (longue, impossible à deviner).

## Comptes admins

1. Supabase → **Authentication → Users → Add user → Create new user** :
   e-mail `<identifiant>@matdora.app` (ex. `tom@matdora.app`), un mot de passe,
   et cocher **Auto Confirm User**.
2. Supabase → **SQL Editor** :

   ```sql
   insert into admins (email) values ('tom@matdora.app');
   ```

3. Sur le dashboard, se connecter avec l'identifiant `tom` et ce mot de passe.

Conseil : dans **Authentication → Sign In / Providers → Email**, désactiver
**Allow new users to sign up**. Même sans ça, un compte créé par quelqu'un d'autre n'a aucun
droit tant qu'il n'est pas dans la table `admins`.

## Brancher Supabase (une seule fois)

1. Créer un compte et un projet sur supabase.com (offre gratuite).
2. Dans le projet : **SQL Editor** → coller le contenu de `supabase/setup.sql` → **Run**.
3. **Project Settings → API Keys** : copier la **Project URL** et la clé **publishable**
   (`sb_publishable_…`, ou l'ancienne clé `anon`).
4. Les coller dans `config.js` (`supabaseUrl` et `supabaseKey`).
   Ne jamais y mettre la clé secrète (`sb_secret_…` / `service_role`).
5. Créer son compte admin (voir « Comptes admins »).
6. Lancer les tests, puis pousser.

**Mise à jour du code qui ajoute des tables** (par exemple la liste des restos et le tirage
au sort) : relancer `supabase/setup.sql` en entier dans le SQL Editor. C'est sans risque, rien
n'est effacé. En attendant, le site marche mais ces nouveautés restent vides.

Tant que `config.js` est vide, l'écran affiche uniquement les slides fixes
(Dora, Pause, Imputations, RDV).

## Tests

```bash
python -m http.server 8000
```

Puis ouvrir http://localhost:8000/tests/run.html. Le résumé s'affiche en haut.

Ces tests utilisent le mode démo et ne touchent pas Supabase. Pour vérifier aussi la sécurité
du vrai Supabase, ouvrir http://localhost:8000/tests/run.html#live : ils vérifient, sans rien
modifier, qu'un visiteur sans compte ne peut rien écrire ni envoyer de fichier, et que le code
du site est bien exigé quand il est réglé.

## Fire TV qui se met en veille

La page demande à garder l'écran allumé (Wake Lock) dès qu'elle est affichée en HTTPS.
Si la Fire TV s'endort quand même :

- **Paramètres → Affichage et sons → Économiseur d'écran → Délai : Jamais.**
- Si elle s'éteint encore, la mise en veille se coupe par ADB depuis un PC
  (Paramètres → Ma Fire TV → Options pour les développeurs → Débogage ADB : activé) :

  ```bash
  adb connect <ip-de-la-fire-tv>
  adb shell settings put secure sleep_timeout 0
  adb shell settings put system screen_off_timeout 2147483647
  ```
