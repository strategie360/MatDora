# MatDora : mise en place

## Les pages

| Page | Pour qui | Adresse |
| --- | --- | --- |
| `index.html` | La Fire TV | `https://<site>/` |
| `admin.html` | Tout le monde : régler les slides, ajouter des photos, gérer le repas | `https://<site>/admin.html` |
| `vote.html` | Les téléphones (via le QR code de la slide Repas) | `https://<site>/vote.html` |

Ajouter `#mock` à la fin d'une adresse lance le **mode démo** : des données d'exemple, stockées
seulement dans ce navigateur. Pratique pour essayer sans rien casser.

## Brancher Supabase (une seule fois)

1. Créer un compte et un projet sur supabase.com (offre gratuite).
2. Dans le projet : **SQL Editor** → coller le contenu de `supabase/setup.sql` → **Run**.
3. **Project Settings → API Keys** : copier la **Project URL** et la clé **publishable**
   (`sb_publishable_…`, ou l'ancienne clé `anon`).
4. Les coller dans `config.js` (`supabaseUrl` et `supabaseKey`).
   Ne jamais y mettre la clé secrète (`sb_secret_…` / `service_role`).
5. Lancer les tests, puis pousser.

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

Ces tests utilisent le mode démo et ne touchent pas Supabase. Pour vérifier aussi le vrai
Supabase, ouvrir http://localhost:8000/tests/run.html#live : ils proposent un resto, votent,
envoient une photo, puis effacent tout (l'écran peut afficher le resto de test quelques secondes).

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
