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
  const DEFAULTS = {
    slides: SLIDES.map(s => ({ id: s.id, enabled: true, duration: 15 })),
    pauses: ["10:00", "12:00", "16:00"],
    happiness: null
  };

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
    if (!Array.isArray(out.pauses) || !out.pauses.length) out.pauses = DEFAULTS.pauses.slice();
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
      }
    };
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
        ]
      };
    }
    function load() {
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) return JSON.parse(raw);
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
      }
    };
  }

  const impl = mode === "supabase" ? supabaseStore() : mode === "demo" ? demoStore() : null;
  window.MatDoraStore = Object.assign({ mode, SLIDES, DEFAULTS, today, voterId, withDefaults, resizeImage }, impl || {
    getSettings: () => Promise.resolve(withDefaults(null))
  });
})();
