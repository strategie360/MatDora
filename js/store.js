/* Données du diaporama, partagées par l'écran et le dashboard.
   - Supabase (API REST, sans librairie) quand config.js est rempli
   - Démo locale quand l'adresse contient #mock (données d'exemple dans ce navigateur)
   - Sinon "off" : l'écran affiche seulement les slides fixes
   Sécurité : le dashboard se connecte avec identifiant + mot de passe (Supabase Auth),
   l'écran envoie le code du site (en-tête x-site-code) ; Supabase refuse sans eux.
   Écrit sans ?. ni ?? pour rester compatible avec les vieux Silk (Fire TV). */
(function () {
  const cfg = window.MATDORA_CONFIG || {};
  const flags = location.hash.replace("#", "").split(",");
  // #off force le mode sans données (utile pour les tests)
  const mode = flags.indexOf("off") !== -1 ? "off" : flags.indexOf("mock") !== -1 ? "demo" : (cfg.supabaseUrl && cfg.supabaseKey ? "supabase" : "off");
  const pad = n => String(n).padStart(2, "0");

  const SLIDES = [
    { id: "dora", label: "Dora" },
    { id: "pause", label: "Prochaine pause" },
    { id: "jira", label: "Imputations Jira" },
    { id: "rdv", label: "RDV Matthieu Hunel" },
    { id: "happiness", label: "Happiness event" },
    { id: "photos", label: "Photos d'events" },
    { id: "lunch", label: "Repas du midi" },
    { id: "birthday", label: "Anniversaires" },
    { id: "vacation", label: "Congés et absences" },
    { id: "news", label: "Arrivées et départs" }
  ];
  // Pauses : une liste d'horaires par jour (0 = dimanche … 6 = samedi)
  const WEEKDAY_PAUSES = ["10:00", "12:00", "16:00"];
  const DEFAULTS = {
    slides: SLIDES.map(s => ({ id: s.id, enabled: true, duration: 15 })),
    pauses: { 0: [], 1: WEEKDAY_PAUSES, 2: WEEKDAY_PAUSES, 3: WEEKDAY_PAUSES, 4: WEEKDAY_PAUSES, 5: WEEKDAY_PAUSES, 6: [] },
    happiness: null
  };

  // Ancien format (une seule liste pour lundi → vendredi) ou nouveau (par jour) → par jour
  function normPauses(p) {
    const out = {};
    for (let d = 0; d < 7; d++) {
      if (Array.isArray(p)) out[d] = d >= 1 && d <= 5 ? p.slice() : [];
      else if (p && typeof p === "object") out[d] = Array.isArray(p[d]) ? p[d].slice() : [];
      else out[d] = DEFAULTS.pauses[d].slice();
    }
    return out;
  }

  function today(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // Complète la config enregistrée avec les valeurs par défaut (et les slides ajoutées depuis)
  function withDefaults(saved) {
    const out = Object.assign({}, DEFAULTS, saved || {});
    const list = Array.isArray(out.slides) ? out.slides.filter(s => SLIDES.some(d => d.id === s.id)) : [];
    SLIDES.forEach(d => { if (!list.some(s => s.id === d.id)) list.push({ id: d.id, enabled: true, duration: 15 }); });
    out.slides = list;
    out.pauses = normPauses(saved && saved.pauses);
    // Équipe : anniversaires (prénom, jour, mois) et vacances (prénom, du, retour le, petit mot)
    out.birthdays = Array.isArray(out.birthdays) ? out.birthdays : [];
    out.vacations = Array.isArray(out.vacations) ? out.vacations : [];
    out.absenceMessage = typeof out.absenceMessage === "string" ? out.absenceMessage : "";
    // Arrivées et départs : bienvenue (stagiaire, alternant…), départ, passage en CDI
    out.teamNews = Array.isArray(out.teamNews) ? out.teamNews : [];
    return out;
  }

  /* ---------- Accès ---------- */
  // Nouvelle clé : chaque appareil doit taper le code lui-même (l'ancienne version
  // le mémorisait aussi dans le navigateur de l'admin qui le réglait)
  const CODE_KEY = "matdora-access-code", SESSION_KEY = "matdora-admin";
  try { localStorage.removeItem("matdora-site-code"); } catch (e) { /* rien */ }
  function readLocal(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeLocal(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* rien */ } }
  // Code du site mémorisé sur cet appareil (la TV le tape une seule fois)
  function storedCode() { return readLocal(CODE_KEY) || ""; }
  function rememberCode(code) { writeLocal(CODE_KEY, code ? code : null); }
  function loadSession() { try { return JSON.parse(readLocal(SESSION_KEY) || "null"); } catch (e) { return null; } }
  function saveSession(sess) { writeLocal(SESSION_KEY, sess ? JSON.stringify(sess) : null); }
  // L'identifiant devient l'e-mail du compte : "tom" → "tom@matdora.app"
  function usernameToEmail(u) { u = u.trim().toLowerCase(); return u.indexOf("@") !== -1 ? u : u + "@matdora.app"; }
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Réduit une photo avant envoi (max 1920 px, JPEG) : plus léger pour la Fire TV
  function resizeImage(file, max) {
    max = max || 1920;
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(b => b ? resolve(b) : reject(new Error("Conversion de l'image impossible")), "image/jpeg", 0.85);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Ce fichier n'est pas une image lisible")); };
      img.src = url;
    });
  }

  /* ---------- Supabase ---------- */
  function supabaseStore() {
    const base = cfg.supabaseUrl.replace(/\/+$/, "");
    const key = cfg.supabaseKey;

    // Session admin : jeton renouvelé une minute avant expiration
    async function token() {
      const sess = loadSession();
      if (!sess) return null;
      if (Date.now() < sess.expires_at - 60000) return sess.access_token;
      try {
        const res = await fetch(`${base}/auth/v1/token?grant_type=refresh_token`, {
          method: "POST",
          headers: { apikey: key, "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: sess.refresh_token })
        });
        if (!res.ok) throw new Error("session expirée");
        const t = await res.json();
        saveSession(Object.assign({}, sess, { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 }));
        return t.access_token;
      } catch (e) {
        saveSession(null);
        return null;
      }
    }

    async function api(path, opts) {
      opts = opts || {};
      const bearer = (await token()) || key;
      const headers = Object.assign({ apikey: key, Authorization: "Bearer " + bearer }, opts.headers || {});
      const code = storedCode();
      if (code) headers["x-site-code"] = code;
      let body = opts.body;
      if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
      const res = await fetch(base + path, { method: opts.method || "GET", headers, body });
      const text = await res.text();
      if (!res.ok) {
        const denied = res.status === 401 || res.status === 403 || /row-level security|42501/.test(text);
        const err = new Error(denied ? "Accès refusé : reconnecte-toi au dashboard." : `Supabase ${res.status} : ${text.slice(0, 200)}`);
        err.denied = denied;
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
    const photoUrl = path => `${base}/storage/v1/object/public/photos/${path}`;

    return {
      // ----- Accès -----
      async login(username, password) {
        const res = await fetch(`${base}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { apikey: key, "Content-Type": "application/json" },
          body: JSON.stringify({ email: usernameToEmail(username), password })
        });
        if (!res.ok) throw new Error("Identifiant ou mot de passe incorrect.");
        const t = await res.json();
        saveSession({ access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000, username: username.trim() });
        let admin = false;
        try { admin = await api("/rest/v1/rpc/is_admin", { method: "POST", json: {} }); } catch (e) { admin = false; }
        if (admin !== true) {
          saveSession(null);
          throw new Error("Ce compte n'a pas accès au dashboard (il n'est pas dans la liste des admins).");
        }
        return { username: username.trim() };
      },
      async logout() {
        const t = await token();
        saveSession(null);
        if (t) fetch(`${base}/auth/v1/logout`, { method: "POST", headers: { apikey: key, Authorization: "Bearer " + t } }).catch(() => {});
      },
      async currentAdmin() {
        const t = await token();
        const sess = loadSession();
        return t && sess ? { username: sess.username } : null;
      },
      // Un code est-il demandé, et celui-ci est-il bon ?
      async siteAccess(code) {
        try {
          return await api("/rest/v1/rpc/site_access", { method: "POST", json: { code: code || "" } });
        } catch (e) {
          if (e.status === 404) return { required: false, ok: true };  // sécurité pas encore installée
          throw e;
        }
      },
      async siteCodeActive() {
        const rows = await orEmpty(api("/rest/v1/site_secret?select=code_hash&id=eq.1"), []);
        return !!(rows[0] && rows[0].code_hash);
      },
      async setSiteCode(code) {
        await api("/rest/v1/site_secret?on_conflict=id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          json: { id: 1, code_hash: code ? await sha256(code) : null, updated_at: new Date().toISOString() }
        });
      },

      async getSettings() {
        const rows = await api("/rest/v1/settings?select=key,value");
        const saved = {};
        rows.forEach(r => { saved[r.key] = r.value; });
        return withDefaults(saved);
      },
      saveSetting(key, value) {
        return api("/rest/v1/settings?on_conflict=key", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          json: [{ key, value, updated_at: new Date().toISOString() }]
        });
      },
      async listPhotos() {
        const rows = await api("/rest/v1/photos?select=*&order=created_at.desc");
        return rows.map(p => Object.assign({}, p, { url: photoUrl(p.path) }));
      },
      async addPhoto(blob, caption, event) {
        const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await api(`/storage/v1/object/photos/${path}`, { method: "POST", body: blob, headers: { "Content-Type": blob.type || "image/jpeg" } });
        const rows = await api("/rest/v1/photos", { method: "POST", headers: { Prefer: "return=representation" }, json: { path, caption: caption || null, event: event || null } });
        return Object.assign({}, rows[0], { url: photoUrl(path) });
      },
      updatePhoto(id, patch) {
        return api(`/rest/v1/photos?id=eq.${id}`, { method: "PATCH", json: patch });
      },
      async deletePhoto(photo) {
        await api(`/rest/v1/photos?id=eq.${photo.id}`, { method: "DELETE" });
        await api(`/storage/v1/object/photos/${photo.path}`, { method: "DELETE" }).catch(() => {});
      },
      // Image hors galerie (ex. affiche du happiness event) : même bucket, sans ligne dans "photos"
      async uploadImage(blob, prefix) {
        const path = `${prefix || "image"}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        await api(`/storage/v1/object/photos/${path}`, { method: "POST", body: blob, headers: { "Content-Type": blob.type || "image/jpeg" } });
        return { url: photoUrl(path), path };
      },
      deleteImage(path) {
        return api(`/storage/v1/object/photos/${path}`, { method: "DELETE" }).catch(() => {});
      },
      async lunch(day) {
        const options = await api(`/rest/v1/lunch_options?select=id,name,created_at&day=eq.${day}&order=created_at`);
        return { options };
      },
      async propose(day, name) {
        try {
          const rows = await api("/rest/v1/lunch_options", { method: "POST", headers: { Prefer: "return=representation" }, json: { day, name } });
          return rows[0];
        } catch (e) {
          if (e.status === 409) throw new Error(`« ${name} » est déjà proposé aujourd'hui.`);
          throw e;
        }
      },
      deleteOption(id) {
        return api(`/rest/v1/lunch_options?id=eq.${id}`, { method: "DELETE" });
      },

      // Liste permanente des restos (jours d'ouverture, "pas dispo")
      // Tant que les tables ne sont pas créées (404), on renvoie du vide : le reste marche.
      listRestaurants() {
        return orEmpty(api("/rest/v1/restaurants?select=*&order=name"), []);
      },
      async addRestaurant(name) {
        try {
          const rows = await api("/rest/v1/restaurants", {
            method: "POST",
            headers: { Prefer: "return=representation" },
            json: { name, days: [1, 2, 3, 4, 5], unavailable: false }
          });
          return rows[0];
        } catch (e) {
          if (e.status === 409) throw new Error(`« ${name} » est déjà dans la liste.`);
          if (e.status === 404) throw new Error("La table des restos n'existe pas encore : relance supabase/setup.sql dans Supabase.");
          throw e;
        }
      },
      async updateRestaurant(id, patch) {
        try {
          return await api(`/rest/v1/restaurants?id=eq.${id}`, { method: "PATCH", json: patch });
        } catch (e) {
          if (e.status === 409) throw new Error(`« ${patch.name} » est déjà dans la liste.`);
          throw e;
        }
      },
      deleteRestaurant(id) {
        return api(`/rest/v1/restaurants?id=eq.${id}`, { method: "DELETE" });
      },
      async getDraw(day) {
        const rows = await orEmpty(api(`/rest/v1/lunch_draws?select=*&day=eq.${day}`), []);
        return rows[0] || null;
      },
      // replace = false : n'écrit que s'il n'y a pas encore de tirage (le premier gagne)
      saveDraw(day, resto, replace) {
        return api("/rest/v1/lunch_draws?on_conflict=day", {
          method: "POST",
          headers: { Prefer: replace ? "resolution=merge-duplicates" : "resolution=ignore-duplicates" },
          json: { day, restaurant_id: resto.id, name: resto.name, drawn_at: new Date().toISOString() }
        });
      }
    };
  }

  async function orEmpty(promise, empty) {
    try { return await promise; } catch (e) { if (e.status === 404) return empty; throw e; }
  }

  /* ---------- Démo locale (#mock) ---------- */
  function demoStore() {
    const KEY = "matdora-demo";
    let memory = null;

    function seed() {
      const d = new Date();
      const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + ((11 - d.getDay()) % 7 || 7), 18, 0);
      const day = today();
      return {
        settings: {
          happiness: {
            title: "Exemple : apéro de fin d'année",
            date: `${today(thursday)}T18:00`,
            place: "Exemple : la terrasse du 3e",
            description: "Exemple de description : jeux, buffet et playlist de l'équipe."
          },
          birthdays: [
            { id: "b1", name: "Exemple : Léa", day: d.getDate(), month: d.getMonth() + 1 },
            { id: "b2", name: "Exemple : Hugo", day: new Date(d.getTime() + 9 * 86400000).getDate(), month: new Date(d.getTime() + 9 * 86400000).getMonth() + 1 },
            { id: "b3", name: "Exemple : Inès", day: new Date(d.getTime() + 40 * 86400000).getDate(), month: new Date(d.getTime() + 40 * 86400000).getMonth() + 1 }
          ],
          vacations: [
            { id: "v1", kind: "vacances", name: "Exemple : Sarah", destination: "Japon", theme: "", from: today(new Date(d.getTime() - 2 * 86400000)), to: today(new Date(d.getTime() + 6 * 86400000)), note: "" }
          ],
          teamNews: [
            { id: "n1", type: "bienvenue", name: "Exemple : Léo", role: "Stagiaire marketing", date: today(new Date(d.getTime() - 1 * 86400000)), until: "", note: "" },
            { id: "n2", type: "cdi", name: "Exemple : Inès", role: "Alternante → CDI développeuse", date: today(new Date(d.getTime() + 3 * 86400000)), until: "", note: "" }
          ]
        },
        photos: [
          { id: "p1", path: "img/2.jpg", url: "img/2.jpg", caption: "Exemple : le sourire officiel", event: "Exemple : arrivée de Dora", created_at: d.toISOString() },
          { id: "p2", path: "img/1.jpg", url: "img/1.jpg", caption: "Exemple : sous la barrière", event: "Exemple : arrivée de Dora", created_at: d.toISOString() },
          { id: "p3", path: "img/3.jpg", url: "img/3.jpg", caption: "Exemple : la pose de star", event: "Exemple : arrivée de Dora", created_at: d.toISOString() }
        ],
        options: [
          { id: "o1", day, name: "Exemple : Pizzeria", created_at: d.toISOString() },
          { id: "o2", day, name: "Exemple : Sushi", created_at: d.toISOString() },
          { id: "o3", day, name: "Exemple : Food truck", created_at: d.toISOString() }
        ],
        restaurants: seedRestaurants(),
        draws: [],
        siteCode: null  // en démo, le code est gardé tel quel (c'est local)
      };
    }
    function seedRestaurants() {
      return [
        { id: "r1", name: "Exemple : Pizzeria", days: [1, 2, 3, 4, 5], unavailable: false },
        { id: "r2", name: "Exemple : Sushi", days: [1, 2, 3, 4, 5], unavailable: false },
        { id: "r3", name: "Exemple : Food truck", days: [2, 4], unavailable: false },
        { id: "r4", name: "Exemple : Brasserie", days: [1, 2, 3, 4, 5], unavailable: true }
      ];
    }
    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const state = JSON.parse(raw);
          // Données de démo d'une version précédente : on complète
          if (!state.restaurants) state.restaurants = seedRestaurants();
          if (!state.draws) state.draws = [];
          return state;
        }
      } catch (e) { /* stockage indisponible : mémoire */ }
      if (!memory) memory = seed();
      return memory;
    }
    function save(state) {
      memory = state;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* mémoire seulement */ }
    }
    const id = () => Math.random().toString(36).slice(2, 10);
    const later = v => new Promise(r => setTimeout(() => r(v), 20));
    const blobToDataUrl = blob => new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });

    return {
      reset() { try { localStorage.removeItem(KEY); } catch (e) { /* rien */ } memory = null; },
      // Démo : identifiant "admin", mot de passe "admin"
      login(username, password) {
        if (username.trim().toLowerCase() !== "admin" || password !== "admin") {
          return Promise.reject(new Error("Identifiant ou mot de passe incorrect."));
        }
        saveSession({ demo: true, username: "admin", expires_at: Date.now() + 8 * 3600000 });
        return later({ username: "admin" });
      },
      logout() { saveSession(null); return later(null); },
      currentAdmin() {
        const sess = loadSession();
        return later(sess && sess.demo && Date.now() < sess.expires_at ? { username: sess.username } : null);
      },
      siteAccess(code) {
        const c = load().siteCode;
        return later({ required: !!c, ok: !c || code === c });
      },
      siteCodeActive() { return later(!!load().siteCode); },
      setSiteCode(code) { const s = load(); s.siteCode = code || null; save(s); return later(null); },
      getSettings() { return later(withDefaults(load().settings)); },
      saveSetting(key, value) { const s = load(); s.settings[key] = value; save(s); return later(null); },
      listPhotos() { return later(load().photos.slice()); },
      async addPhoto(blob, caption, event) {
        const url = await blobToDataUrl(blob);
        const s = load();
        const p = { id: id(), path: "demo-" + id(), url, caption: caption || null, event: event || null, created_at: new Date().toISOString() };
        s.photos.unshift(p);
        save(s);
        return p;
      },
      deletePhoto(photo) { const s = load(); s.photos = s.photos.filter(p => p.id !== photo.id); save(s); return later(null); },
      updatePhoto(pid, patch) {
        const s = load();
        s.photos = s.photos.map(p => p.id === pid ? Object.assign({}, p, patch) : p);
        save(s);
        return later(null);
      },
      async uploadImage(blob, prefix) { return { url: await blobToDataUrl(blob), path: `demo-${prefix || "image"}-${id()}` }; },
      deleteImage() { return later(null); },
      lunch(day) {
        return later({ options: load().options.filter(o => o.day === day) });
      },
      propose(day, name) {
        const s = load();
        if (s.options.some(o => o.day === day && o.name.toLowerCase() === name.toLowerCase())) {
          return Promise.reject(new Error(`« ${name} » est déjà proposé aujourd'hui.`));
        }
        const o = { id: id(), day, name, created_at: new Date().toISOString() };
        s.options.push(o);
        save(s);
        return later(o);
      },
      deleteOption(optionId) {
        const s = load();
        s.options = s.options.filter(o => o.id !== optionId);
        save(s);
        return later(null);
      },
      listRestaurants() {
        return later(load().restaurants.slice().sort((a, b) => a.name.localeCompare(b.name)).map(r => Object.assign({}, r, { days: r.days.slice() })));
      },
      addRestaurant(name) {
        const s = load();
        if (s.restaurants.some(r => r.name.toLowerCase() === name.toLowerCase())) {
          return Promise.reject(new Error(`« ${name} » est déjà dans la liste.`));
        }
        const r = { id: id(), name, days: [1, 2, 3, 4, 5], unavailable: false };
        s.restaurants.push(r);
        save(s);
        return later(r);
      },
      updateRestaurant(rid, patch) {
        const s = load();
        if (patch.name && s.restaurants.some(r => r.id !== rid && r.name.toLowerCase() === patch.name.toLowerCase())) {
          return Promise.reject(new Error(`« ${patch.name} » est déjà dans la liste.`));
        }
        s.restaurants = s.restaurants.map(r => r.id === rid ? Object.assign({}, r, patch) : r);
        save(s);
        return later(null);
      },
      deleteRestaurant(rid) {
        const s = load();
        s.restaurants = s.restaurants.filter(r => r.id !== rid);
        save(s);
        return later(null);
      },
      getDraw(day) {
        return later(load().draws.filter(d => d.day === day)[0] || null);
      },
      saveDraw(day, resto, replace) {
        const s = load();
        const exists = s.draws.some(d => d.day === day);
        if (exists && !replace) return later(null);
        s.draws = s.draws.filter(d => d.day !== day);
        s.draws.push({ day, restaurant_id: resto.id, name: resto.name, drawn_at: new Date().toISOString() });
        save(s);
        return later(null);
      }
    };
  }

  const impl = mode === "supabase" ? supabaseStore() : mode === "demo" ? demoStore() : null;

  /* ---------- Repas : logique commune aux deux modes ---------- */
  const DRAW_HOUR = 11, DRAW_MINUTE = 30;  // tirage au sort quotidien à 11:30

  function weekday(day) { return new Date(day + "T12:00:00").getDay(); }
  function openOn(resto, day) {
    return !resto.unavailable && Array.isArray(resto.days) && resto.days.indexOf(weekday(day)) !== -1;
  }
  function drawTime(day) {
    const d = new Date(day + "T00:00:00");
    d.setHours(DRAW_HOUR, DRAW_MINUTE, 0, 0);
    return d;
  }
  const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

  // Choix du jour = restos ouverts ce jour-là + propositions du jour, et le tirage
  async function lunch(day) {
    const all = await Promise.all([impl.lunch(day), impl.listRestaurants(), impl.getDraw(day)]);
    const base = all[0], restos = all[1], draw = all[2];
    const open = restos.filter(r => openOn(r, day));
    const options = base.options.map(o => Object.assign({}, o));
    open.forEach(r => {
      const found = options.filter(o => sameName(o.name, r.name))[0];
      if (found) found.restaurant_id = r.id;
      else options.push({ id: null, name: r.name, restaurant_id: r.id });
    });
    options.sort((a, b) => a.name.localeCompare(b.name));
    return { options, draw, candidates: open, restaurants: restos, drawTime: drawTime(day) };
  }

  function pickRandom(list) { return list[Math.floor(Math.random() * list.length)]; }

  // À partir de 11:30, le premier écran ou téléphone qui passe fait le tirage du jour
  async function ensureDraw(day, now) {
    now = now || new Date();
    const existing = await impl.getDraw(day);
    if (existing || now < drawTime(day)) return existing;
    const open = (await impl.listRestaurants()).filter(r => openOn(r, day));
    if (!open.length) return null;
    await impl.saveDraw(day, pickRandom(open), false);
    return impl.getDraw(day);  // si un autre a tiré en même temps, c'est son tirage qui compte
  }

  // Bouton "Relancer" : nouveau tirage, différent du précédent quand c'est possible
  async function reroll(day) {
    const current = await impl.getDraw(day);
    const open = (await impl.listRestaurants()).filter(r => openOn(r, day));
    if (!open.length) throw new Error("Aucun resto ouvert ce jour-là : ajoute-en ou coche leurs jours dans le dashboard.");
    const pool = current && open.length > 1 ? open.filter(r => !sameName(r.name, current.name)) : open;
    await impl.saveDraw(day, pickRandom(pool), true);
    return impl.getDraw(day);
  }

  // Thèmes de la slide "Bonnes vacances", devinés d'après la destination (modifiable dans le dashboard)
  const VACATION_THEMES = [
    { id: "plage", label: "Plage", emoji: "🏖️🌴🍹", note: "Pendant ce temps, on garde la machine à café au chaud ☕" },
    { id: "japon", label: "Japon", emoji: "🗾🌸🍣", note: "Rapporte-nous des mochis 🍡" },
    { id: "montagne", label: "Montagne / ski", emoji: "🏔️⛷️☕", note: "Attention aux pistes noires !" },
    { id: "italie", label: "Italie", emoji: "🍝🛵🍦", note: "Une glace pour nous, s'il te plaît 🍨" },
    { id: "ville", label: "Ville", emoji: "🏙️🗺️📸", note: "Envoie-nous une carte postale !" },
    { id: "tropiques", label: "Tropiques", emoji: "🌺🥥🐠", note: "Ramène-nous un peu de soleil ☀️" },
    { id: "nord", label: "Grand Nord", emoji: "🌌❄️🦌", note: "Couvre-toi bien !" },
    { id: "campagne", label: "Campagne / nature", emoji: "🌳🚲🧺", note: "Profite du grand air 🌿" },
    { id: "sante", label: "Bon rétablissement", emoji: "🍵💐🛌", note: "Prends soin de toi, on pense à toi 💛" }
  ];
  // Types d'absence : vacances (thème selon la destination) ou arrêt maladie (thème « bon rétablissement »)
  const ABSENCE_KINDS = [
    { id: "vacances", label: "Vacances", emoji: "🏖️", title: "Bonnes vacances" },
    { id: "maladie", label: "Arrêt maladie", emoji: "🤒", title: "Bon rétablissement" }
  ];
  function absenceKind(v) { return ABSENCE_KINDS.filter(k => k.id === (v && v.kind))[0] || ABSENCE_KINDS[0]; }
  const THEME_WORDS = [
    [/japon|tokyo|kyoto|osaka|hokkaido|okinawa/i, "japon"],
    [/italie|rome|venise|florence|naples|sicile|sardaigne|milan|toscane|pouilles/i, "italie"],
    [/ski|montagne|alpes|chamonix|pyrénées|pyrenees|val d|courchevel|tignes|vosges|jura|dolomites/i, "montagne"],
    [/islande|norvège|norvege|laponie|finlande|suède|suede|canada|alaska|groenland/i, "nord"],
    [/bali|thaïlande|thailande|maldives|réunion|reunion|martinique|guadeloupe|tahiti|caraïbes|caraibes|mexique|cuba|brésil|bresil|maurice|seychelles|polynésie|polynesie|hawaï|hawai|vietnam|philippines/i, "tropiques"],
    [/paris|londres|london|new york|barcelone|berlin|amsterdam|lisbonne|prague|madrid|vienne|bruxelles|budapest|dublin|copenhague|séoul|seoul|ville/i, "ville"],
    [/campagne|bretagne|normandie|camping|vélo|velo|randonnée|randonnee|auvergne|dordogne|ardèche|ardeche|gîte|gite|ferme/i, "campagne"]
  ];
  function guessTheme(destination) {
    for (let i = 0; i < THEME_WORDS.length; i++) if (THEME_WORDS[i][0].test(destination || "")) return THEME_WORDS[i][1];
    return "plage";
  }
  function vacationTheme(v) {
    if (v && v.kind === "maladie") return VACATION_THEMES.filter(t => t.id === "sante")[0];
    const id = v && v.theme ? v.theme : guessTheme(v && v.destination);
    return VACATION_THEMES.filter(t => t.id === id)[0] || VACATION_THEMES[0];
  }

  // Annonces de la slide "Du nouveau dans l'équipe"
  const NEWS_TYPES = [
    { id: "bienvenue", label: "Bienvenue (stagiaire, alternant, recrue)", short: "Bienvenue", emoji: "👋🎉", title: "Bienvenue",
      role: "Ex. Stagiaire marketing", before: "Arrive le", after: "Arrivée le", note: "Bienvenue dans l'équipe, on est ravis de t'accueillir !" },
    { id: "depart", label: "Départ (ils nous ont quittés)", short: "Départ", emoji: "💐👋", title: "Merci et bonne route",
      role: "Ex. Développeur", before: "Dernier jour le", after: "Départ le", note: "Merci pour tout, et bonne continuation !" },
    { id: "cdi", label: "Alternant → CDI", short: "Alternant → CDI", emoji: "🎓➡️💼", title: "Félicitations",
      role: "Ex. Alternant → CDI développeur", before: "Passe en CDI le", after: "En CDI depuis le", note: "Bravo, l'aventure continue avec nous !" }
  ];
  const NEWS_BEFORE_DAYS = 7, NEWS_AFTER_DAYS = 14;  // affichée 7 jours avant la date et 14 jours après
  function newsType(n) { return NEWS_TYPES.filter(t => t.id === (n && n.type))[0] || NEWS_TYPES[0]; }
  function addDays(day, n) { const d = new Date(day + "T12:00:00"); d.setDate(d.getDate() + n); return today(d); }
  function newsWindow(n) { return { from: addDays(n.date, -NEWS_BEFORE_DAYS), until: n.until || addDays(n.date, NEWS_AFTER_DAYS) }; }

  const FOOD_EMOJI = [
    [/pizz|ital|pasta|pâtes|trattoria/i, "🍕"], [/sushi|japon|ramen|izakaya/i, "🍣"], [/burger/i, "🍔"],
    [/thai|thaï|wok|nouille|pho|vietnam/i, "🍜"], [/poke|poké|salad|bowl/i, "🥗"], [/crêp|crep|galette/i, "🥞"],
    [/kebab|grec|libanais|falafel|tacos/i, "🥙"], [/mexic|burrito|taco/i, "🌮"], [/indien|curry|tandoor/i, "🍛"],
    [/chin|dim sum|asiat/i, "🥡"], [/boulang|sandwich|pain/i, "🥖"], [/food ?truck|camion/i, "🚚"],
    [/burger|frite/i, "🍟"], [/fromage|raclette|fondue/i, "🧀"], [/poisson|fish|mer/i, "🐟"], [/végé|vege|vegan/i, "🥦"],
    [/brasserie|bistro|cantine|resto|restaurant|chez/i, "🍽️"]
  ];
  function foodEmoji(name) {
    for (let i = 0; i < FOOD_EMOJI.length; i++) if (FOOD_EMOJI[i][0].test(name)) return FOOD_EMOJI[i][1];
    return "🍴";
  }

  const lunchApi = impl ? { lunch, ensureDraw, reroll, lunchRaw: impl.lunch } : {};
  window.MatDoraStore = Object.assign(
    { mode, SLIDES, DEFAULTS, HM_REMINDER: "Va sur le channel HM pour voter pour la date et annoncer ta présence !", today, withDefaults, storedCode, rememberCode, usernameToEmail, resizeImage, foodEmoji, VACATION_THEMES, ABSENCE_KINDS, absenceKind, NEWS_TYPES, newsType, newsWindow, addDays, guessTheme, vacationTheme, openOn, drawTime, weekday, DRAW_HOUR, DRAW_MINUTE },
    impl || { getSettings: () => Promise.resolve(withDefaults(null)) },
    lunchApi
  );
})();
