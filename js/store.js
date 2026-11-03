/* Données du diaporama, partagées par l'écran, le dashboard et la page de vote.
   - Supabase (API REST, sans librairie) quand config.js est rempli
   - Démo locale quand l'adresse contient #mock (données d'exemple dans ce navigateur)
   - Sinon "off" : l'écran affiche seulement les slides fixes
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
    { id: "lunch", label: "Repas du midi" }
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

  function voterId() {
    try {
      let id = localStorage.getItem("matdora-voter");
      if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("matdora-voter", id); }
      return id;
    } catch (e) { return "anonyme-" + Math.random().toString(36).slice(2); }
  }

  // Complète la config enregistrée avec les valeurs par défaut (et les slides ajoutées depuis)
  function withDefaults(saved) {
    const out = Object.assign({}, DEFAULTS, saved || {});
    const list = Array.isArray(out.slides) ? out.slides.filter(s => SLIDES.some(d => d.id === s.id)) : [];
    SLIDES.forEach(d => { if (!list.some(s => s.id === d.id)) list.push({ id: d.id, enabled: true, duration: 15 }); });
    out.slides = list;
    out.pauses = normPauses(saved && saved.pauses);
    return out;
  }

  function countVotes(options, votes, voter) {
    const mine = votes.filter(v => v.voter === voter)[0];
    return {
      options: options.map(o => Object.assign({}, o, { votes: votes.filter(v => v.option_id === o.id).length })),
      total: votes.length,
      myVote: mine ? mine.option_id : null
    };
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

    async function api(path, opts) {
      opts = opts || {};
      const headers = Object.assign({ apikey: key, Authorization: "Bearer " + key }, opts.headers || {});
      let body = opts.body;
      if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.json); }
      const res = await fetch(base + path, { method: opts.method || "GET", headers, body });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Supabase ${res.status} : ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return text ? JSON.parse(text) : null;
    }
    const photoUrl = path => `${base}/storage/v1/object/public/photos/${path}`;

    return {
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
      async deletePhoto(photo) {
        await api(`/rest/v1/photos?id=eq.${photo.id}`, { method: "DELETE" });
        await api(`/storage/v1/object/photos/${photo.path}`, { method: "DELETE" }).catch(() => {});
      },
      async lunch(day, voter) {
        const options = await api(`/rest/v1/lunch_options?select=id,name,created_at&day=eq.${day}&order=created_at`);
        const votes = await api(`/rest/v1/lunch_votes?select=option_id,voter&day=eq.${day}`);
        return countVotes(options, votes, voter);
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
      vote(day, optionId, voter) {
        return api("/rest/v1/lunch_votes?on_conflict=day,voter", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          json: { day, voter, option_id: optionId }
        });
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
      updateRestaurant(id, patch) {
        return api(`/rest/v1/restaurants?id=eq.${id}`, { method: "PATCH", json: patch });
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
          }
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
        votes: [
          { day, voter: "demo-a", option_id: "o1" },
          { day, voter: "demo-b", option_id: "o1" },
          { day, voter: "demo-c", option_id: "o2" }
        ],
        restaurants: seedRestaurants(),
        draws: []
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
      lunch(day, voter) {
        const s = load();
        return later(countVotes(s.options.filter(o => o.day === day), s.votes.filter(v => v.day === day), voter));
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
      vote(day, optionId, voter) {
        const s = load();
        s.votes = s.votes.filter(v => !(v.day === day && v.voter === voter));
        s.votes.push({ day, voter, option_id: optionId });
        save(s);
        return later(null);
      },
      deleteOption(optionId) {
        const s = load();
        s.options = s.options.filter(o => o.id !== optionId);
        s.votes = s.votes.filter(v => v.option_id !== optionId);
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

  // Choix du jour = restos ouverts ce jour-là + propositions du jour, avec les votes et le tirage
  async function lunch(day, voter) {
    const all = await Promise.all([impl.lunch(day, voter), impl.listRestaurants(), impl.getDraw(day)]);
    const base = all[0], restos = all[1], draw = all[2];
    const open = restos.filter(r => openOn(r, day));
    const options = base.options.map(o => Object.assign({}, o));
    open.forEach(r => {
      const found = options.filter(o => sameName(o.name, r.name))[0];
      if (found) found.restaurant_id = r.id;
      else options.push({ id: null, name: r.name, votes: 0, restaurant_id: r.id });
    });
    return { options, total: base.total, myVote: base.myVote, draw, candidates: open, restaurants: restos, drawTime: drawTime(day) };
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

  // Voter pour un choix : crée d'abord l'option du jour si c'est un resto de la liste pas encore proposé
  async function voteFor(day, option, voter) {
    let optionId = option.id;
    if (!optionId) {
      try {
        optionId = (await impl.propose(day, option.name)).id;
      } catch (e) {
        const again = await impl.lunch(day, voter);
        const found = again.options.filter(o => sameName(o.name, option.name))[0];
        if (!found) throw e;
        optionId = found.id;
      }
    }
    await impl.vote(day, optionId, voter);
    return optionId;
  }

  const lunchApi = impl ? { lunch, ensureDraw, reroll, voteFor, lunchRaw: impl.lunch } : {};
  window.MatDoraStore = Object.assign(
    { mode, SLIDES, DEFAULTS, today, voterId, withDefaults, resizeImage, openOn, drawTime, weekday, DRAW_HOUR, DRAW_MINUTE },
    impl || { getSettings: () => Promise.resolve(withDefaults(null)) },
    lunchApi
  );
})();
