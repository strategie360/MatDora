/* Vieux navigateurs de TV (ex. iiyama) qui ne connaissent pas clamp(), min() et max() en CSS :
   on les remplace dans les feuilles de style de la page par leur valeur calculée pour la taille
   de l'écran (recalculée si la taille change). Sans ça, toutes les tailles de texte sautent.
   ES5 uniquement : ce script doit marcher sur les vieux navigateurs. #noclamp le force (tests). */
(function () {
  var probe = document.createElement("div");
  probe.style.width = "clamp(1px, 2px, 3px)";
  var force = /(^#|,)noclamp(,|$)/.test(location.hash);
  window.cssFallback = { active: false };
  if (probe.style.width && !force) return;

  // Valeur simple en pixels (px, rem, em, vw, vh), ou null si ce n'est pas calculable
  function toPx(v) {
    var m = /^\s*(-?[\d.]+)(px|rem|em|vw|vh)?\s*$/.exec(v);
    if (!m) return null;
    var n = parseFloat(m[1]), unit = m[2] || "px";
    if (unit === "px") return n;
    if (unit === "rem" || unit === "em") return n * 16;
    if (unit === "vw") return n * window.innerWidth / 100;
    return n * window.innerHeight / 100;
  }
  // Arguments d'une fonction CSS, séparés par les virgules du premier niveau
  function splitArgs(s) {
    var out = [], depth = 0, start = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (c === "," && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
    }
    out.push(s.slice(start).trim());
    return out;
  }
  function round(px) { return Math.round(px * 100) / 100 + "px"; }
  // Valeur retenue pour clamp(min, idéal, max), min(…) ou max(…)
  function pick(fn, args) {
    var px = [], all = true, i;
    for (i = 0; i < args.length; i++) {
      args[i] = flatten(args[i]);
      px.push(toPx(args[i]));
      if (px[i] === null) all = false;
    }
    if (fn === "clamp") return all ? round(Math.max(px[0], Math.min(px[1], px[2]))) : args[1];
    if (all) {
      var best = px[0];
      for (i = 1; i < px.length; i++) best = fn === "min" ? Math.min(best, px[i]) : Math.max(best, px[i]);
      return round(best);
    }
    // Pas calculable (env(), var()…) : la valeur fixe d'abord, sinon la première
    for (i = 0; i < args.length; i++) if (toPx(args[i]) !== null) return args[i];
    return args[0];
  }
  function flatten(css) {
    var re = /(^|[^-\w])(clamp|min|max)\(/g, m, out = "", last = 0;
    while ((m = re.exec(css))) {
      var start = m.index + m[1].length, open = re.lastIndex - 1, depth = 0, end = -1;
      for (var j = open; j < css.length; j++) {
        var c = css.charAt(j);
        if (c === "(") depth++;
        else if (c === ")") { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) break;
      var value = pick(m[2], splitArgs(css.slice(open + 1, end)));
      // Une expression (ex. « 1rem + 2vw ») doit rester entre parenthèses dans un calc()
      if (/\s[-+*\/]\s/.test(value)) value = "calc(" + value + ")";
      out += css.slice(last, start) + value;
      last = end + 1;
      re.lastIndex = end + 1;
    }
    return out + css.slice(last);
  }

  var styles = [], originals = [];
  var list = document.getElementsByTagName("style");
  for (var i = 0; i < list.length; i++) { styles.push(list[i]); originals.push(list[i].textContent); }
  function apply() {
    for (var k = 0; k < styles.length; k++) styles[k].textContent = flatten(originals[k]);
  }
  apply();
  var timer = null;
  window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(apply, 150); });
  window.cssFallback = { active: true, flatten: flatten, apply: apply };
})();
