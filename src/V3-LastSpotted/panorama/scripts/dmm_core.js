// Made by V3. Discord: v3nty.
// dmm_core.js — shared foundation for the Deadlock UI mods.
// Loaded FIRST in hud.xml. Publishes a single `DMM` namespace on the shared
// Panorama JS global so every mod (LastSpot, Soul Advantage, Minimap) can reuse
// one copy of the logging, perf, DOM, hero-data and storage primitives instead
// of duplicating them per file.
(function () {
  "use strict";

  // Panorama runs every <include> in one shared JS global. Resolve it robustly
  // and reuse an existing DMM if a second copy of this file ever loads.
  var G = (typeof globalThis !== "undefined") ? globalThis
        : (function () { return this; })();
  if (G.DMM && G.DMM.__ready) return;

  // ---------------------------------------------------------------------------
  // Panel API (verified against the live Source 2 Panorama surface)
  // ---------------------------------------------------------------------------
  function valid(panel) {
    try { return !!(panel && panel.IsValid && panel.IsValid()); } catch (e) {}
    return false;
  }

  function id(panel) {
    try { return (panel && panel.id) || "<no-id>"; } catch (e) {}
    return "<id-error>";
  }

  function type(panel) {
    try { return (panel && panel.paneltype) || "<no-type>"; } catch (e) {}
    return "<type-error>";
  }

  function hasClass(panel, className) {
    try { return !!(panel && panel.BHasClass && panel.BHasClass(className)); } catch (e) {}
    return false;
  }

  function visible(panel) {
    try { return panel && panel.visible !== false; } catch (e) {}
    return true;
  }

  function childCount(panel) {
    try { return (panel && panel.GetChildCount && panel.GetChildCount()) || 0; } catch (e) {}
    return 0;
  }

  function childAt(panel, index) {
    try { return panel && panel.GetChild ? panel.GetChild(index) : null; } catch (e) {}
    return null;
  }

  function root(panel) {
    var cur = panel;
    try { while (cur && cur.GetParent && cur.GetParent()) cur = cur.GetParent(); } catch (e) {}
    return cur;
  }

  function find(panel, childId) {
    try {
      var c = panel && panel.FindChildTraverse ? panel.FindChildTraverse(childId) : null;
      return valid(c) ? c : null;
    } catch (e) {}
    return null;
  }

  function findDirect(panel, childId) {
    var n = childCount(panel);
    for (var i = 0; i < n; i++) {
      var c = childAt(panel, i);
      if (valid(c) && c.id === childId) return c;
    }
    return null;
  }

  function setClass(panel, className, enabled) {
    if (!valid(panel)) return;
    try {
      if (enabled) panel.AddClass(className);
      else panel.RemoveClass(className);
    } catch (e) {}
  }

  function remove(panel) {
    try { if (valid(panel)) panel.DeleteAsync(0); } catch (e) {}
  }

  // Reads a string off a panel: direct JS property first, then the panel's
  // attribute channels (string / int / uint32) which many HUD panels use.
  function readString(panel, prop) {
    if (!valid(panel)) return "";
    try {
      var v = panel[prop];
      if (v !== undefined && v !== null && String(v).length > 0) return String(v);
    } catch (e) {}
    try {
      var a = panel.GetAttributeString ? panel.GetAttributeString(prop, "") : "";
      if (a && String(a).length > 0) return String(a);
    } catch (e) {}
    try {
      var n = panel.GetAttributeInt ? panel.GetAttributeInt(prop, -999999) : -999999;
      if (n !== undefined && n !== null && Number(n) !== -999999) return String(n);
    } catch (e) {}
    try {
      var u = panel.GetAttributeUInt32 ? panel.GetAttributeUInt32(prop, 4294967295) : 4294967295;
      if (u !== undefined && u !== null && Number(u) !== 4294967295) return String(u);
    } catch (e) {}
    return "";
  }

  function readAnyString(panel, names) {
    if (!valid(panel)) return "";
    for (var i = 0; i < names.length; i++) {
      var v = readString(panel, names[i]);
      if (v) return v;
    }
    try {
      var bg = panel.style && panel.style.backgroundImage;
      if (bg && String(bg).length > 0 && String(bg) !== "none") return String(bg);
    } catch (e) {}
    return "";
  }

  // ---------------------------------------------------------------------------
  // Numeric helpers
  // ---------------------------------------------------------------------------
  function safeNumber(value) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    if (Math.abs(n) > 1000000) return null;
    return n;
  }

  function safeExtent(value, fallback, maxValue) {
    var n = Number(value);
    var cap = maxValue || 8192;
    if (!isFinite(n) || n <= 0 || n > cap) return fallback;
    return n;
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  // FNV-1a → base36. Stable, cheap key/signature hashing.
  function hashString(value) {
    var hash = 2166136261;
    var s = String(value || "");
    for (var i = 0; i < s.length; i++) {
      hash ^= s.charCodeAt(i);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36);
  }

  function shortValue(value, maxLen) {
    var s = String(value || "").replace(/[\r\n|]+/g, " ").trim();
    var n = maxLen || 80;
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function now() {
    try { if (typeof Date.now === "function") return Date.now(); } catch (e) {}
    return (new Date()).getTime();
  }

  function perfNow() {
    try {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        return performance.now();
      }
    } catch (e) {}
    return now();
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------
  function schedule(seconds, fn) {
    try { if ($ && $.Schedule) return $.Schedule(seconds, fn); } catch (e) {}
    return null;
  }

  function cancel(handle) {
    try { if (handle && $ && $.CancelScheduled) $.CancelScheduled(handle); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Logging — one leveled logger. Each mod gets a prefixed sub-logger via make().
  // ---------------------------------------------------------------------------
  function rawMsg(line) {
    try { if ($ && $.Msg) $.Msg(line); } catch (e) {}
  }

  function makeLogger(prefix) {
    var tag = "[" + prefix + "] ";
    var enabled = false;
    return {
      setEnabled: function (on) { enabled = !!on; },
      isEnabled: function () { return enabled; },
      // force=true always prints; otherwise gated by the mod's debug flag.
      log: function (message, force) { if (enabled || force) rawMsg(tag + message); },
      warn: function (message) { rawMsg(tag + "WARN " + message); }
    };
  }

  // ---------------------------------------------------------------------------
  // Perf — single lightweight sampler. Wrap hot functions with time().
  // ---------------------------------------------------------------------------
  function makePerf(label) {
    var enabled = false;
    var slowMs = 4.0;
    var stats = Object.create(null);
    function record(name, dt, meta) {
      var s = stats[name];
      if (!s) s = stats[name] = { count: 0, total: 0, max: 0, last: 0, slow: 0, meta: "" };
      s.count++; s.total += dt; s.last = dt;
      if (dt > s.max) s.max = dt;
      if (meta) s.meta = String(meta).replace(/[\r\n|]+/g, " ").slice(0, 90);
      if (dt >= slowMs) {
        s.slow++;
        rawMsg("[" + label + "] PERF_SLOW name=" + name + " ms=" + dt.toFixed(2) + (s.meta ? " meta=" + s.meta : ""));
      }
    }
    return {
      setEnabled: function (on) { enabled = !!on; },
      isEnabled: function () { return enabled; },
      reset: function () { stats = Object.create(null); },
      // time(name, fn, metaFn): runs fn, samples its duration when enabled.
      time: function (name, fn, metaFn) {
        if (!enabled) return fn();
        var start = perfNow();
        try { return fn(); }
        finally { record(name, Math.max(0, perfNow() - start), metaFn ? metaFn() : ""); }
      },
      snapshot: function (resetAfter) {
        var rows = [];
        for (var k in stats) {
          var s = stats[k];
          if (!s || !s.count) continue;
          rows.push({ name: k, count: s.count, avg: s.total / s.count, max: s.max, slow: s.slow, meta: s.meta });
        }
        rows.sort(function (a, b) { return (b.avg * b.count) - (a.avg * a.count); });
        var lines = [label + " perf " + (enabled ? "ON" : "OFF") + " samples=" + rows.length];
        for (var i = 0; i < rows.length && i < 8; i++) {
          var r = rows[i];
          lines.push((i + 1) + ". " + r.name + " count=" + r.count + " avg=" + r.avg.toFixed(2) + " max=" + r.max.toFixed(2) + " slow=" + r.slow + (r.meta ? " " + r.meta : ""));
        }
        if (resetAfter) stats = Object.create(null);
        return lines.join("\n");
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Hero data — the single source of truth (was duplicated across 3 files).
  // ---------------------------------------------------------------------------
  var HERO_CODE_NAMES = {
    "Abrams": "bull", "Apollo": "fencer", "Bebop": "bebop", "Billy": "punkgoat",
    "Calico": "nano", "Celeste": "unicorn", "Doorman": "doorman", "Drifter": "drifter",
    "Dynamo": "sumo", "Graves": "necro", "Grey Talon": "archer", "Haze": "haze",
    "Holliday": "astro", "Infernus": "inferno", "Ivy": "tengu", "Kelvin": "kelvin",
    "Lady Geist": "spectre", "Lash": "lash", "McGinnis": "engineer", "Mina": "vampirebat",
    "Mirage": "mirage", "Mo & Krill": "digger", "Paige": "bookworm", "Paradox": "chrono",
    "Pocket": "synth", "Rem": "familiar", "Seven": "gigawatt", "Shiv": "shiv",
    "Silver": "werewolf", "Sinclair": "magician", "Venator": "priest", "Victor": "frank",
    "Vindicta": "hornet", "Viscous": "viscous", "Vyper": "kali", "Warden": "warden",
    "Wraith": "wraith", "Yamato": "yamato"
  };
  var HERO_NAMES = Object.keys(HERO_CODE_NAMES);

  // Precompute simplified keys once for fast canonicalization.
  function simplify(v) {
    return String(v || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
  }
  var HERO_KEY_INDEX = Object.create(null);
  for (var hi = 0; hi < HERO_NAMES.length; hi++) {
    var hname = HERO_NAMES[hi];
    HERO_KEY_INDEX[simplify(hname)] = hname;
    HERO_KEY_INDEX[simplify(HERO_CODE_NAMES[hname])] = hname;
  }

  function canonicalHeroName(value) {
    var key = simplify(value);
    if (!key) return "";
    return HERO_KEY_INDEX[key] || "";
  }

  function isKnownHeroName(value) { return !!canonicalHeroName(value); }

  function heroCodeName(value) {
    var canonical = canonicalHeroName(value);
    return canonical ? HERO_CODE_NAMES[canonical] : "";
  }

  function heroIconPath(value) {
    var code = heroCodeName(value);
    return code ? "s2r://panorama/images/heroes/" + code + "_mm_psd.vtex" : "";
  }

  // Finds the first known hero name mentioned anywhere inside a longer string
  // (e.g. a portrait path or tooltip). Prefers the longest match.
  function findHeroMention(value) {
    var key = simplify(value);
    if (!key) return "";
    var best = "";
    for (var i = 0; i < HERO_NAMES.length; i++) {
      var name = HERO_NAMES[i];
      var nk = simplify(name);
      var ck = simplify(HERO_CODE_NAMES[name]);
      if ((nk && key.indexOf(nk) !== -1) || (ck && key.indexOf(ck) !== -1)) {
        if (name.length > best.length) best = name;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // GameClock — real match-time reader, shared across mods (LastSpot's topbar
  // name probe and Soul Advantage's local-hero probe both gate on this at
  // 30s). GameRules/Game/GameStateAPI/etc are confirmed unavailable in this
  // Panorama context (live-probed), so this reads the HUD's own visible clock
  // text ("12:34" or bare seconds) instead. Confirmed real panel: a Label
  // with id "GameTime" under CitadelHudTopBar — tried directly first (cheap
  // native lookup); the heuristic scan below is only a fallback in case that
  // id ever changes. The winning panel is cached so repeat calls are one
  // cheap .text + regex parse, not a HUD rescan.
  // ---------------------------------------------------------------------------
  var gameClockCachedPanel = null;
  var gameClockLastScanTs = 0;
  var gameClockLastResult = null;
  var gameClockScanAttempts = 0;
  var GAME_CLOCK_MAX_SCAN_ATTEMPTS = 6;
  var GAME_CLOCK_KNOWN_TIMER_IDS = ["GameTime"];

  function gameClockAncestryPath(panel, maxDepth) {
    var parts = [], cur = panel, max = maxDepth || 10;
    try {
      for (var i = 0; i < max && valid(cur); i++) {
        parts.push((id(cur) || "<no-id>") + ":" + type(cur));
        cur = cur.GetParent ? cur.GetParent() : null;
      }
    } catch (e) {}
    return parts.reverse().join("/");
  }

  function gameClockReadPanelText(panel) {
    if (!valid(panel)) return "";
    try { if (panel.text !== undefined && panel.text !== null) return String(panel.text || ""); } catch (e) {}
    try { if (typeof panel.GetText === "function") return String(panel.GetText() || ""); } catch (e) {}
    return "";
  }

  function gameClockParseClockText(text) {
    var cleaned = String(text || "").replace(/\s+/g, "").trim();
    if (!cleaned || cleaned.length > 12) return null;
    var m = cleaned.match(/^(-?)(\d{1,2}):(\d{2})$/);
    if (m) {
      var minutes = Number(m[2]), seconds = Number(m[3]);
      if (!isFinite(minutes) || !isFinite(seconds) || seconds > 59) return null;
      var value = (minutes * 60) + seconds;
      return m[1] === "-" ? -value : value;
    }
    m = cleaned.match(/^(-?\d{1,4})(?:\.(\d{1,3}))?$/);
    if (m) {
      var v = Number(cleaned);
      if (!isFinite(v) || v < -300 || v > 7200) return null;
      return v;
    }
    return null;
  }

  // Ranks candidate panels so a real clock ("12:34" + timer-ish id/type/path)
  // wins over ability cooldowns, urn/buff timers, scoreboard ratios, etc.
  function gameClockRankTimerPanel(panel, text, seconds) {
    if (!valid(panel) || seconds === null || seconds < -120 || seconds > 7200) return null;
    var idl = String(id(panel) || "").toLowerCase();
    var tyl = String(type(panel) || "").toLowerCase();
    var path = String(gameClockAncestryPath(panel, 10) || "").toLowerCase();
    var meta = idl + " " + tyl + " " + path;
    if (meta.indexOf("lastspot") >= 0 || meta.indexOf("souladvantage") >= 0) return null;
    var isClockText = /^-?\d{1,2}:\d{2}$/.test(String(text || "").replace(/\s+/g, "").trim());
    var timerish = /(game.?time|match.?time|hud.?time|timer|clock|elapsed|gametime|matchtime)/i.test(meta);
    var matchHudish = /(topbar|top_bar|scoreboard|gameplay_hud|citadelhud|hud)/i.test(meta);
    var badContext = /(ability|cooldown|respawn|death|item|mod|buff|debuff|urn|shop|tooltip|chat|damage|ping)/i.test(meta);
    if (!isClockText && !timerish) return null;
    var rank = 1000;
    if (timerish) rank -= 520;
    if (matchHudish) rank -= 180;
    if (isClockText) rank -= 90;
    if (tyl.indexOf("label") >= 0) rank -= 25;
    if (badContext) rank += 420;
    var w = safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 10000);
    var h = safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 10000);
    if (w > 0 && h > 0) rank -= 20;
    if (w > 400 || h > 140) rank += 80;
    return { panel: panel, seconds: seconds, rank: rank };
  }

  // root/hud are the CALLER's own resolved panels (each mod tracks its own).
  function gameClockScanForTimerPanel(root, hud) {
    for (var ki = 0; ki < GAME_CLOCK_KNOWN_TIMER_IDS.length; ki++) {
      var known = find(root, GAME_CLOCK_KNOWN_TIMER_IDS[ki]);
      if (valid(known)) {
        var knownSeconds = gameClockParseClockText(gameClockReadPanelText(known).trim());
        if (knownSeconds !== null) return { panel: known, seconds: knownSeconds, rank: 0 };
      }
    }
    var roots = [];
    function add(p) { if (valid(p) && roots.indexOf(p) === -1) roots.push(p); }
    add(hud); add(root);
    var queue = [], i;
    for (i = 0; i < roots.length; i++) queue.push({ p: roots[i], d: 0 });
    var candidates = [], scanned = 0;
    while (queue.length && scanned < 2200) {
      var node = queue.shift(), p = node.p;
      if (!valid(p) || node.d > 12) continue;
      scanned++;
      var text = gameClockReadPanelText(p).trim();
      if (text && text.length <= 16) {
        var seconds = gameClockParseClockText(text);
        var ranked = gameClockRankTimerPanel(p, text, seconds);
        if (ranked) candidates.push(ranked);
      }
      var n = childCount(p);
      for (var c = 0; c < n && c < 80; c++) queue.push({ p: childAt(p, c), d: node.d + 1 });
    }
    candidates.sort(function (a, b) { return a.rank - b.rank; });
    var best = candidates.length ? candidates[0] : null;
    return (best && best.rank <= 860) ? best : null;
  }

  // Real match seconds, or null if genuinely unavailable. Cheap (one .text
  // read) once a panel is cached; otherwise re-scans at most once every 5s,
  // up to GAME_CLOCK_MAX_SCAN_ATTEMPTS times, then permanently stops trying
  // until resetGameTime() is called (e.g. on a new match).
  function getGameTime(root, hud) {
    var nowMs = now();
    if (valid(gameClockCachedPanel)) {
      var seconds = gameClockParseClockText(gameClockReadPanelText(gameClockCachedPanel).trim());
      if (seconds !== null) return seconds;
      gameClockCachedPanel = null;
    }
    if (gameClockScanAttempts >= GAME_CLOCK_MAX_SCAN_ATTEMPTS) return gameClockLastResult;
    if (nowMs - gameClockLastScanTs < 5000) return gameClockLastResult;
    gameClockLastScanTs = nowMs;
    gameClockScanAttempts++;
    var found = gameClockScanForTimerPanel(root, hud);
    if (found) { gameClockCachedPanel = found.panel; gameClockLastResult = found.seconds; return found.seconds; }
    gameClockLastResult = null;
    return null;
  }

  function resetGameTime() {
    gameClockCachedPanel = null;
    gameClockLastScanTs = 0;
    gameClockLastResult = null;
    gameClockScanAttempts = 0;
  }

  // ---------------------------------------------------------------------------
  // Storage — thin wrapper over persistentStorage (survives across matches).
  // ---------------------------------------------------------------------------
  function storageGet(key, fallback) {
    try {
      if ($ && $.persistentStorage) {
        var raw = $.persistentStorage.getItem(key);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw);
      }
    } catch (e) {}
    return fallback;
  }

  function storageSet(key, value) {
    try {
      if ($ && $.persistentStorage) {
        $.persistentStorage.setItem(key, JSON.stringify(value));
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ---------------------------------------------------------------------------
  // Publish
  // ---------------------------------------------------------------------------
  G.DMM = {
    __ready: true,
    version: "core-1",
    // panels
    valid: valid, id: id, type: type, hasClass: hasClass, visible: visible,
    childCount: childCount, childAt: childAt, root: root,
    find: find, findDirect: findDirect, setClass: setClass, remove: remove,
    readString: readString, readAnyString: readAnyString,
    // numbers
    safeNumber: safeNumber, safeExtent: safeExtent, clamp: clamp,
    hashString: hashString, shortValue: shortValue, now: now, perfNow: perfNow,
    // scheduling
    schedule: schedule, cancel: cancel,
    // logging / perf factories
    makeLogger: makeLogger, makePerf: makePerf,
    // hero data
    HERO_CODE_NAMES: HERO_CODE_NAMES, HERO_NAMES: HERO_NAMES,
    canonicalHeroName: canonicalHeroName, isKnownHeroName: isKnownHeroName,
    heroCodeName: heroCodeName, heroIconPath: heroIconPath, findHeroMention: findHeroMention,
    // storage
    storageGet: storageGet, storageSet: storageSet,
    // game clock (shared match-time gate, see GameClock section above)
    getGameTime: getGameTime, resetGameTime: resetGameTime
  };

  rawMsg("[dmm_core] ready (" + HERO_NAMES.length + " heroes)");
})();
