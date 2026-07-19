// Made by V3. Discord: v3nty.
// Soul Advantage topbar/scoreboard overlay. Kept separate from LastSpotter.
// Current step: display each player's effective souls above their portrait.
(function () {
  "use strict";

  // dmm_core.js loads first (see hud.xml); used here only for the shared
  // real-match-time gate (DMM.getGameTime()) so the local-hero probe fires at
  // a sensible point instead of immediately at HUD load (see
  // getLocalHeroPanelOnce). Everything else in this file is still
  // self-contained pre-dmm_core code — full migration is a separate, larger
  // follow-up, not done in this pass to avoid unverified regressions.
  var G = (typeof globalThis !== "undefined") ? globalThis : (function () { return this; })();
  var DMM = G.DMM;

  var TIER_COST = { 1: 800, 2: 1600, 3: 3200, 4: 6400 };
  var UPDATE_SEC = 0.75;
  var RESCAN_SEC = 15.0;
  var LABEL_ID = "DMMSoulAdvantageDisplay";
  var LEGACY_LABEL_ID = "DMMUnspentSoulDisplay";
  var DEBUG_PANEL_ID = "DMMSoulAdvantageDebugPanel";
  var SETTINGS_KEY = "key_f10";
  var MAX_SCAN_PANELS = 1800;
  var PANEL_CACHE_VALIDATE_SEC = 5.0;

  var COLOR_PRESETS = ["#ffffff", "#fff0a8", "#66ff99", "#7dbdff", "#ffd166", "#ff8a66", "#ff6666", "#d6a3ff"];
  var settings = {
    x: 0,
    y: 4,
    scale: 1.65,
    fixedColor: "#ffffff"
  };

  var debugVisible = false;
  var keybindBound = false;
  var debugPanel = null;
  var debugLabels = {};
  var cachedPanels = [];
  var nextRescanMs = 0;
  var nextPanelValidationMs = 0;
  var lastPanelCount = 0;
  var lastEffectiveCount = 0;
  var perfEnabled = false;
  var perfSlowMs = 4.0;
  var perfLastText = "Perf: off";
  var perfStats = Object.create(null);
  var localHeroPanel = null;
  var localHeroName = "";
  var manualLocalHeroName = "";
  var autoLocalHeroProbeFailed = false;
  var nextLocalHeroProbeMs = 0;
  var nextManualLocalHeroFindMs = 0;
  var LOCAL_HERO_PROBE_RETRY_SEC = 60.0;
  var MANUAL_LOCAL_HERO_FIND_RETRY_SEC = 5.0;
  // Gate the auto probe on real match time (shared DMM.getGameTime(), same
  // 30s LastSpot's topbar probe uses) instead of firing on the very first
  // update tick after HUD load — that was BEFORE the local hero's topbar
  // panel even existed, so the single attempt always failed and permanently
  // gave up, which is why this previously always needed the F10 manual
  // fallback. Now bounded-retries like LastSpot's probe instead of a single
  // shot, so a slow load doesn't still cause a permanent false failure.
  var LOCAL_HERO_GATE_SEC = 60;
  var LOCAL_HERO_PROBE_MAX_ATTEMPTS = 3;
  // Print the full LOCAL_HERO_CAND dump on the automatic (gametime-gated) probe,
  // not just the manual one. Bounded exactly like the probe itself: fires at most
  // LOCAL_HERO_PROBE_MAX_ATTEMPTS times, >=30s in, <=18 lines each, then stops
  // once the local hero is cached. Set to false to silence.
  var LOCAL_HERO_DIAG = true;
  var LOCAL_HERO_PROBE_ATTEMPT_RETRY_SEC = 5.0;
  var localHeroProbeAttempts = 0;
  var localHeroBootMs = 0;
  // Nothing in the engine tells this script "a new match started" — the HUD
  // layout/script only loads once per client session, so without this every
  // per-match cache (cachedPanels, localHeroPanel, manualLocalHeroName) would
  // silently carry over stale/reused panels from the previous game until the
  // user manually hit Rescan. The match clock is monotonic within a game, so
  // any large drop is a reliable "new match" signal.
  var lastSeenGameSeconds = null;
  var MATCH_RESET_DROP_SEC = 8;
  // Diagnostic only (not a fix): cachedPlayerPanelsNeedRefresh() only forces
  // a rescan when the cached panel COUNT drops below 12. If a stale/wrong
  // panel object sits in the cache but still reports IsValid()==true, the
  // count never drops and the heuristic never notices — this periodically
  // cross-checks the cache against a fresh scan so a real repro gets logged
  // instead of guessed at again.
  var DIAG_SEC = 20;
  var nextDiagMs = 0;


  var HERO_CODE_NAMES = {
    "Abrams": "bull",
    "Apollo": "fencer",
    "Bebop": "bebop",
    "Billy": "punkgoat",
    "Calico": "nano",
    "Celeste": "unicorn",
    "Doorman": "doorman",
    "Drifter": "drifter",
    "Dynamo": "sumo",
    "Graves": "necro",
    "Grey Talon": "archer",
    "Haze": "haze",
    "Holliday": "astro",
    "Infernus": "inferno",
    "Ivy": "tengu",
    "Kelvin": "kelvin",
    "Lady Geist": "spectre",
    "Lash": "lash",
    "McGinnis": "engineer",
    "Mina": "vampirebat",
    "Mirage": "mirage",
    "Mo & Krill": "digger",
    "Paige": "bookworm",
    "Paradox": "chrono",
    "Pocket": "synth",
    "Rem": "familiar",
    "Seven": "gigawatt",
    "Shiv": "shiv",
    "Silver": "werewolf",
    "Sinclair": "magician",
    "Venator": "priest",
    "Victor": "frank",
    "Vindicta": "hornet",
    "Viscous": "viscous",
    "Vyper": "kali",
    "Warden": "warden",
    "Wraith": "wraith",
    "Yamato": "yamato"
  };
  var HERO_NAMES = Object.keys(HERO_CODE_NAMES);
  var HERO_PROBE_MAX_PANEL_VALUES = 96;
  var HERO_PROBE_MAX_SCAN_DEPTH = 5;
  var HERO_PROBE_MAX_SCAN_PANELS = 160;
  var HERO_PROBE_LOCAL_CLASS_HINTS = [
    "local", "localplayer", "local_player", "LocalPlayer", "isLocalPlayer", "is_local_player",
    "player_is_local", "self", "Self", "isSelf", "is_self", "selected", "Selected",
    "active", "Active", "active_player", "isActivePlayer", "spectated", "spectated_player",
    "viewing_as_player", "ViewingAsPlayer"
  ];
  var HERO_PROBE_FRIENDLY_CLASS_HINTS = ["friendly", "ally", "teammate", "TeamFriendly", "team_friendly", "localteam", "team1", "team2"];
  var HERO_PROBE_ENEMY_CLASS_HINTS = ["enemy", "TeamEnemy", "team_enemy", "opponent", "opposing", "team1", "team2"];

  function nowMs() { return Date.now ? Date.now() : (new Date()).getTime(); }

  function panelValid(panel) {
    if (!panel) return false;
    try { if (typeof panel.IsValid === "function") return !!panel.IsValid(); } catch (e) {}
    return !!panel;
  }

  function findRootPanel() {
    var panel = null;
    try { panel = $.GetContextPanel(); } catch (e0) { panel = null; }
    while (panelValid(panel) && typeof panel.GetParent === "function") {
      var parent = null;
      try { parent = panel.GetParent(); } catch (e1) { parent = null; }
      if (!panelValid(parent)) break;
      panel = parent;
    }
    return panel;
  }


  function perfNow() {
    try { if (typeof performance !== "undefined" && performance && typeof performance.now === "function") return performance.now(); } catch (e0) {}
    try { return Date.now ? Date.now() : (new Date()).getTime(); } catch (e1) {}
    return 0;
  }

  function perfStart() { return perfEnabled ? perfNow() : 0; }

  function perfEnd(name, startMs, meta) {
    if (!perfEnabled || !startMs) return;
    var dt = Math.max(0, perfNow() - startMs);
    var s = perfStats[name];
    if (!s) s = perfStats[name] = { count: 0, total: 0, max: 0, last: 0, slow: 0, meta: "" };
    s.count++;
    s.total += dt;
    s.last = dt;
    if (dt > s.max) s.max = dt;
    if (meta) s.meta = String(meta).replace(/[\r\n|]+/g, " ").slice(0, 90);
    if (dt >= perfSlowMs) {
      s.slow++;
      var nowPrint = perfNow();
      if (!s.lastSlowPrintMs || nowPrint - s.lastSlowPrintMs >= 1000) {
        s.lastSlowPrintMs = nowPrint;
        try { $.Msg("[SoulAdvantage] PERF_SLOW name=" + name + " ms=" + dt.toFixed(2) + (s.meta ? " meta=" + s.meta : "")); } catch (e2) {}
      }
    }
  }

  function perfResetStats() {
    perfStats = Object.create(null);
    perfLastText = "Perf stats reset.";
  }

  function perfSnapshotText(resetAfter) {
    var rows = [];
    for (var k in perfStats) {
      var s = perfStats[k];
      if (!s || !s.count) continue;
      rows.push({ name: k, count: s.count, total: s.total, avg: s.total / Math.max(1, s.count), max: s.max, last: s.last, slow: s.slow, meta: s.meta || "" });
    }
    rows.sort(function(a, b) { return (b.total - a.total) || (b.max - a.max); });
    var lines = [];
    lines.push("Soul perf " + (perfEnabled ? "ON" : "OFF") + " slow>=" + perfSlowMs.toFixed(1) + "ms samples=" + rows.length);
    if (!rows.length) lines.push("No samples yet. Enable perf and play/open UI for a few seconds.");
    for (var i = 0; i < rows.length && i < 10; i++) {
      var r = rows[i];
      lines.push((i + 1) + ". " + r.name + " count=" + r.count + " avg=" + r.avg.toFixed(2) + " max=" + r.max.toFixed(2) + " last=" + r.last.toFixed(2) + " slow=" + r.slow + (r.meta ? " " + r.meta : ""));
    }
    var out = lines.join("\n");
    if (resetAfter) perfResetStats();
    return out;
  }

  function perfRegisterApi() {
    var root = findRootPanel();
    if (!panelValid(root)) return;
    try {
      if (!root.__DMMPerfRegistry) root.__DMMPerfRegistry = {};
      root.__DMMPerfRegistry.SoulAdvantage = {
        setEnabled: function(enabled) { perfEnabled = !!enabled; if (perfEnabled) perfResetStats(); return perfEnabled; },
        isEnabled: function() { return !!perfEnabled; },
        snapshot: function(reset) { return perfSnapshotText(!!reset); },
        reset: function() { perfResetStats(); return true; },
        setSlowMs: function(ms) { perfSlowMs = Math.max(0.5, Math.min(50, Number(ms) || perfSlowMs)); return perfSlowMs; }
      };
    } catch (e) {}
  }

  function perfSetLabel(text) {
    perfLastText = String(text || "");
    try { if (debugLabels.perf) debugLabels.perf.text = perfLastText; } catch (e) {}
  }

  function perfCollectRegistries() {
    var registries = [];
    var seen = [];
    var root = findRootPanel();

    function addRegistry(panel) {
      if (!panel) return;
      var reg = null;
      try { reg = panel.__DMMPerfRegistry; } catch (e0) { reg = null; }
      if (!reg) return;
      for (var i = 0; i < seen.length; i++) {
        if (seen[i] === reg) return;
      }
      seen.push(reg);
      registries.push(reg);
    }

    addRegistry(root);
    try {
      var stack = root ? [root] : [];
      var scanned = 0;
      while (stack.length && scanned < 2500) {
        var panel = stack.pop();
        scanned++;
        addRegistry(panel);
        var childCount = 0;
        try { childCount = typeof panel.GetChildCount === "function" ? panel.GetChildCount() : 0; } catch (e1) { childCount = 0; }
        for (var c = 0; c < childCount; c++) {
          try {
            var child = panel.GetChild(c);
            if (child) stack.push(child);
          } catch (e2) {}
        }
      }
    } catch (e3) {}
    return registries;
  }

  function perfForEachApi(fn) {
    var registries = perfCollectRegistries();
    var seenNames = {};
    var n = 0;
    try {
      for (var r = 0; r < registries.length; r++) {
        var reg = registries[r];
        for (var name in reg) {
          if (seenNames[name]) continue;
          var api = reg[name];
          if (!api) continue;
          seenNames[name] = true;
          fn(name, api);
          n++;
        }
      }
    } catch (e) {}
    return n;
  }

  function perfToggleAll() {
    perfRegisterApi();
    var next = !perfEnabled;
    perfForEachApi(function(_name, api) { try { if (api.setEnabled) api.setEnabled(next); } catch (e) {} });
    perfSetLabel(next ? "Perf ON. Play through a stutter, then press Perf report." : "Perf OFF.");
    updateDebugText();
    return true;
  }

  function perfReportAll() {
    perfRegisterApi();
    var blocks = [];
    perfForEachApi(function(name, api) { try { if (api.snapshot) blocks.push("[" + name + "]\n" + api.snapshot(false)); } catch (e) { blocks.push("[" + name + "] snapshot_failed " + e); } });
    var text = blocks.join("\n\n") || "No perf APIs registered.";
    perfSetLabel(text);
    try { $.Msg("[SoulAdvantage] PERF_REPORT\n" + text); } catch (e2) {}
    updateDebugText();
    return true;
  }

  function perfResetAll() {
    perfRegisterApi();
    perfForEachApi(function(_name, api) { try { if (api.reset) api.reset(); } catch (e) {} });
    perfSetLabel("Perf stats reset.");
    updateDebugText();
    return true;
  }

  function parseFormattedNumber(valueText) {
    if (!valueText) return 0;
    valueText = valueText.toString().replace(/,/g, "").trim().toLowerCase();
    if (valueText.endsWith("k")) return (parseFloat(valueText.replace("k", "")) || 0) * 1000;
    return parseFloat(valueText) || 0;
  }

  function readText(panel) {
    if (!panelValid(panel)) return "";
    try { if (typeof panel.text !== "undefined" && panel.text !== null) return String(panel.text || ""); } catch (e0) {}
    try { if (typeof panel.GetText === "function") return String(panel.GetText() || ""); } catch (e1) {}
    return "";
  }

  function getSoulValueFromPanel(panel) {
    var soulValue = 0;
    try { soulValue = parseFormattedNumber(readText(panel.FindChildTraverse("HiddenGoldValue"))); } catch (e0) {}
    if (soulValue === 0) {
      try { soulValue = parseFormattedNumber(readText(panel.FindChildTraverse("SoulsValue"))); } catch (e1) {}
    }
    return soulValue;
  }

  function countClass(panel, className) {
    try { return (panel.FindChildrenWithClassTraverse(className) || []).length || 0; } catch (e) {}
    return 0;
  }

  function calculateSpentSoulsImpl(panel) {
    var spent = 0;
    spent += countClass(panel, "isTier1") * TIER_COST[1];
    spent += countClass(panel, "isTier2") * TIER_COST[2];
    spent += countClass(panel, "isTier3") * TIER_COST[3];
    spent += countClass(panel, "isTier4") * TIER_COST[4];
    return spent;
  }

  function calculateSpentSouls() {
    var __perfStart = perfStart();
    try { return calculateSpentSoulsImpl.apply(this, arguments); }
    finally { perfEnd("calculateSpentSouls", __perfStart, ""); }
  }


  function calculateSoulInfoImpl(panel) {
    var totalSouls = Math.max(0, getSoulValueFromPanel(panel));
    var spentSouls = Math.max(0, calculateSpentSouls(panel));
    var unspentSouls = Math.max(0, totalSouls - spentSouls);

    // Desired base math: effective = total souls - unspent souls.
    // With the current unspent calculation, this resolves to spent souls, capped by total when total is visible.
    var effectiveSouls = spentSouls; // I'm too lazy to deal with the bullshit chatGPT is generating. Don't even know how we got here but I'm just trying to make it work at this point.

    // Hideout / hero-test panels may expose item tiers before a usable total soul label exists.
    // In that case, still print the effective value we can infer from purchased tiers.
    if (totalSouls <= 0 && spentSouls > 0) effectiveSouls = spentSouls;

    return {
      total: totalSouls,
      unspent: unspentSouls,
      spent: spentSouls,
      effective: effectiveSouls
    };
  }

  function calculateSoulInfo() {
    var __perfStart = perfStart();
    try { return calculateSoulInfoImpl.apply(this, arguments); }
    finally { perfEnd("calculateSoulInfo", __perfStart, ""); }
  }


  function panelId(panel) { try { return String(panel.id || ""); } catch (e) {} return ""; }
  function panelType(panel) { try { return String(panel.paneltype || panel.constructor || ""); } catch (e) {} return ""; }

  function isPlayerPanel(panel) {
    if (!panelValid(panel)) return false;
    var id = panelId(panel);
    var type = panelType(panel);
    if (/^TopBarPlayer\d+$/i.test(id)) return true;
    if (/CitadelHudTopBarPlayer/i.test(type)) return true;
    if (/PlayerIntentsPlayer\d+$/i.test(id)) return true;
    return false;
  }

  function addUnique(list, seen, panel) {
    if (!panelValid(panel)) return;
    var key = "";
    try { key = String(panelId(panel)) + "|" + String(panelType(panel)) + "|" + String(panel.GetChildIndex ? panel.GetChildIndex() : list.length); } catch (e) { key = String(list.length); }
    if (seen[key]) return;
    seen[key] = true;
    list.push(panel);
  }

  function collectPlayerPanelsImpl() {
    var root = findRootPanel();
    var out = [];
    var seen = Object.create(null);
    if (!panelValid(root)) return out;

    var starts = [];
    function addStart(id) { try { var p = root.FindChildTraverse(id); if (panelValid(p)) starts.push(p); } catch (e) {} }
    addStart("TopBar");
    addStart("TeamFriendly");
    addStart("TeamEnemy");
    addStart("Scoreboard");
    addStart("scoreboard");
    starts.push(root);

    var scanned = 0;
    function walk(panel, depth) {
      if (!panelValid(panel) || scanned++ > MAX_SCAN_PANELS || depth > 8) return;
      if (isPlayerPanel(panel)) addUnique(out, seen, panel);
      var count = 0;
      try { count = panel.GetChildCount ? panel.GetChildCount() : 0; } catch (e0) { count = 0; }
      for (var i = 0; i < count; i++) {
        var child = null;
        try { child = panel.GetChild(i); } catch (e1) { child = null; }
        walk(child, depth + 1);
      }
    }
    for (var i = 0; i < starts.length; i++) walk(starts[i], 0);
    return out;
  }

  function collectPlayerPanels() {
    var __perfStart = perfStart();
    var out = [];
    try { out = collectPlayerPanelsImpl.apply(this, arguments) || []; return out; }
    finally { perfEnd("collectPlayerPanels", __perfStart, "panels=" + out.length); }
  }



  function canonicalHeroName(value) {
    var raw = String(value || "").trim();
    if (!raw) return "";
    var simplified = raw.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
    for (var i = 0; i < HERO_NAMES.length; i++) {
      var name = HERO_NAMES[i];
      var nameKey = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "");
      var codeKey = String(HERO_CODE_NAMES[name] || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (simplified === nameKey || simplified === codeKey) return name;
    }
    return "";
  }

  function findKnownHeroMention(value) {
    var raw = String(value || "");
    if (!raw) return "";
    var lower = raw.toLowerCase();
    var compact = lower.replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ");
    var padded = " " + compact + " ";
    var heroish = lower.indexOf("hero") >= 0 || lower.indexOf("portrait") >= 0 || lower.indexOf("unit") >= 0 || lower.indexOf("npc_") >= 0 || lower.indexOf("vtex") >= 0 || lower.indexOf("citadel") >= 0 || lower.indexOf("topbar") >= 0;
    for (var i = 0; i < HERO_NAMES.length; i++) {
      var name = HERO_NAMES[i];
      var code = String(HERO_CODE_NAMES[name] || "").toLowerCase();
      var nameWords = name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
      var nameCompact = nameWords.replace(/ /g, "");
      if (nameWords && padded.indexOf(" " + nameWords + " ") >= 0) return name;
      if (heroish && nameCompact && lower.replace(/[^a-z0-9]+/g, "").indexOf(nameCompact) >= 0) return name;
      if (code) {
        if (lower.indexOf("heroes/" + code) >= 0 || lower.indexOf("heroes\\" + code) >= 0) return name;
        if (lower.indexOf("hero_" + code) >= 0 || lower.indexOf("npc_hero_" + code) >= 0 || lower.indexOf("citadel_hero_" + code) >= 0) return name;
        if (heroish && padded.indexOf(" " + code.replace(/[^a-z0-9]+/g, " ") + " ") >= 0) return name;
      }
    }
    return "";
  }

  function addProbeValue(out, key, value) {
    if (out.length >= HERO_PROBE_MAX_PANEL_VALUES) return;
    try {
      if (value === undefined || value === null) return;
      var text = String(value || "").trim();
      if (!text) return;
      if (text.length > 240) text = text.slice(0, 240);
      out.push(String(key || "?") + "=" + text);
    } catch (e) {}
  }

  function readPanelProbeValues(panel, tag) {
    var out = [];
    if (!panelValid(panel)) return out;
    tag = tag || "panel";
    try { addProbeValue(out, tag + ".id", panel.id); } catch (e0) {}
    try { addProbeValue(out, tag + ".type", panel.paneltype); } catch (e1) {}
    try { addProbeValue(out, tag + ".text", panel.text); } catch (e2) {}
    var fields = [
      "src", "image", "texture", "source", "defaultsrc", "defaultSrc", "backgroundImage",
      "heroname", "heroName", "hero_name", "hero", "hero_id", "heroID", "unit", "unit_name",
      "npc_name", "localizedName", "tooltip", "player_name", "playerName", "steamid", "accountid"
    ];
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      try { addProbeValue(out, tag + "." + f, panel[f]); } catch (e3) {}
      try { if (panel.GetAttributeString) addProbeValue(out, tag + ".attr_" + f, panel.GetAttributeString(f, "")); } catch (e4) {}
    }
    try {
      if (panel.style) {
        addProbeValue(out, tag + ".style_bg", panel.style.backgroundImage);
        addProbeValue(out, tag + ".style_texture", panel.style.texture);
      }
    } catch (e5) {}
    try {
      if (panel.Data) {
        var data = panel.Data();
        if (data) {
          var n = 0;
          for (var k in data) {
            if (data.hasOwnProperty && !data.hasOwnProperty(k)) continue;
            addProbeValue(out, tag + ".data_" + k, data[k]);
            if (++n > 24) break;
          }
        }
      }
    } catch (e6) {}
    return out;
  }

  // NOTE: findKnownHeroMention is a SUBSTRING scan and runs before the exact
  // canonicalHeroName lookup, and the first value that yields any hero wins.
  // Several hero codenames are ordinary words ("bull", "nano", "haze", "lash",
  // "archer", "engineer", "bookworm", ...), so an unrelated attribute string can
  // false-match. `raw` is carried out so the diag log can show the exact text a
  // hero was inferred from.
  function extractHeroFromProbeValues(values) {
    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var mention = findKnownHeroMention(v);
      var hero = mention || canonicalHeroName(v);
      if (hero) {
        return {
          hero: hero,
          source: String(v).split("=")[0] || "value",
          how: mention ? "substring" : "exact",
          raw: String(v)
        };
      }
    }
    return { hero: "", source: "none", how: "-", raw: "" };
  }

  function extractHeroFromPanel(panel) {
    if (!panelValid(panel)) return { hero: "", source: "invalid" };

    var directValues = readPanelProbeValues(panel, "self");
    var direct = extractHeroFromProbeValues(directValues);
    if (direct.hero) return direct;

    var commonIds = [
      "HeroImage", "HeroPortrait", "HeroPortraitImage", "HeroIcon", "PlayerPortrait", "PlayerIcon",
      "Portrait", "MainImage", "MinimapHeroImage", "HeroContents", "PlayerDetailsContainer"
    ];
    for (var i = 0; i < commonIds.length; i++) {
      try {
        var child = panel.FindChildTraverse(commonIds[i]);
        if (panelValid(child)) {
          var values = readPanelProbeValues(child, commonIds[i]);
          var got = extractHeroFromProbeValues(values);
          if (got.hero) return got;
        }
      } catch (e0) {}
    }

    var queue = [{ p: panel, d: 0, path: "self" }];
    var scanned = 0;
    while (queue.length && scanned < HERO_PROBE_MAX_SCAN_PANELS) {
      var item = queue.shift();
      var p = item.p;
      if (!panelValid(p) || item.d > HERO_PROBE_MAX_SCAN_DEPTH) continue;
      scanned++;
      var vals = readPanelProbeValues(p, item.path);
      var result = extractHeroFromProbeValues(vals);
      if (result.hero) {
        result.source = item.path + ":" + result.source;
        return result;
      }
      var count = 0;
      try { count = p.GetChildCount ? p.GetChildCount() : 0; } catch (e1) { count = 0; }
      for (var c = 0; c < count && c < 40; c++) {
        try { queue.push({ p: p.GetChild(c), d: item.d + 1, path: item.path + "/" + c }); } catch (e2) {}
      }
    }
    return { hero: "", source: "scanned=" + scanned };
  }

  function panelHasAnyKnownClass(panel, classList, hits) {
    var score = 0;
    if (!panelValid(panel) || typeof panel.BHasClass !== "function") return 0;
    for (var i = 0; i < classList.length; i++) {
      var cls = classList[i];
      try {
        if (panel.BHasClass(cls)) {
          score++;
          if (hits) hits.push(cls);
        }
      } catch (e) {}
    }
    return score;
  }

  function describePanelNode(panel) {
    if (!panelValid(panel)) return "<invalid>";
    var id = panelId(panel) || "<no-id>";
    var type = panelType(panel) || "<no-type>";
    var hits = [];
    panelHasAnyKnownClass(panel, HERO_PROBE_LOCAL_CLASS_HINTS, hits);
    panelHasAnyKnownClass(panel, HERO_PROBE_FRIENDLY_CLASS_HINTS, hits);
    panelHasAnyKnownClass(panel, HERO_PROBE_ENEMY_CLASS_HINTS, hits);
    return id + ":" + type + (hits.length ? "[" + hits.join(",") + "]" : "");
  }

  function panelPathBrief(panel) {
    var parts = [];
    var p = panel;
    var guard = 0;
    while (panelValid(p) && guard++ < 10) {
      parts.push(describePanelNode(p));
      try { p = p.GetParent ? p.GetParent() : null; } catch (e) { p = null; }
    }
    return parts.join(" <- ");
  }

  function scorePanelLocalSignals(panel) {
    var score = 0;
    var hits = [];
    var p = panel;
    var guard = 0;
    while (panelValid(p) && guard++ < 7) {
      var localHits = [];
      var n = panelHasAnyKnownClass(p, HERO_PROBE_LOCAL_CLASS_HINTS, localHits);
      if (n) {
        score += guard <= 1 ? n * 10 : n * 4;
        for (var i = 0; i < localHits.length; i++) hits.push((guard <= 1 ? "self" : "parent") + ":" + localHits[i]);
      }
      var idType = (panelId(p) + " " + panelType(p)).toLowerCase();
      if (/local|self|active|spectat|selected/.test(idType)) {
        score += guard <= 1 ? 6 : 2;
        hits.push((guard <= 1 ? "self" : "parent") + ":idtype=" + idType.replace(/\s+/g, "/"));
      }
      try { p = p.GetParent ? p.GetParent() : null; } catch (e) { p = null; }
    }
    return { score: score, hits: hits };
  }

  function inferTeamGuess(panel) {
    var enemy = 0, friendly = 0, team1 = 0, team2 = 0;
    var hits = [];
    var p = panel;
    var guard = 0;
    while (panelValid(p) && guard++ < 7) {
      var nodeHits = [];
      friendly += panelHasAnyKnownClass(p, ["friendly", "ally", "teammate", "TeamFriendly", "team_friendly", "localteam"], nodeHits);
      enemy += panelHasAnyKnownClass(p, ["enemy", "TeamEnemy", "team_enemy", "opponent", "opposing"], nodeHits);
      if (panelHasAnyKnownClass(p, ["team1", "Team1"], nodeHits)) team1++;
      if (panelHasAnyKnownClass(p, ["team2", "Team2"], nodeHits)) team2++;
      var idType = (panelId(p) + " " + panelType(p)).toLowerCase();
      if (/enemy|opponent/.test(idType)) { enemy += 2; nodeHits.push("idtype_enemy"); }
      if (/friendly|ally|teamfriendly|localteam/.test(idType)) { friendly += 2; nodeHits.push("idtype_friendly"); }
      if (/team1/.test(idType)) { team1++; nodeHits.push("idtype_team1"); }
      if (/team2/.test(idType)) { team2++; nodeHits.push("idtype_team2"); }
      if (nodeHits.length) hits.push(nodeHits.join("+"));
      try { p = p.GetParent ? p.GetParent() : null; } catch (e) { p = null; }
    }
    var guess = "unknown";
    if (enemy > friendly) guess = "enemy";
    else if (friendly > enemy) guess = "friendly";
    else if (team1 || team2) guess = team1 >= team2 ? "team1" : "team2";
    return { guess: guess, friendly: friendly, enemy: enemy, team1: team1, team2: team2, hits: hits };
  }

  function readPanelPlayerId(panel) {
    if (!panelValid(panel)) return -1;
    var names = ["player_id", "playerId", "PlayerID", "playerID", "account_id", "accountid", "steamid", "userid", "user_id"];
    for (var i = 0; i < names.length; i++) {
      var k = names[i];
      try {
        var v = panel[k];
        if (v !== undefined && v !== null && String(v) !== "") {
          var n = Number(v);
          if (isFinite(n)) return n | 0;
        }
      } catch (e0) {}
      try {
        if (panel.GetAttributeInt) {
          var ai = panel.GetAttributeInt(k, -1);
          if (ai !== -1) return ai | 0;
        }
      } catch (e1) {}
      try {
        if (panel.GetAttributeString) {
          var as = panel.GetAttributeString(k, "");
          var ns = Number(as);
          if (as !== "" && isFinite(ns)) return ns | 0;
        }
      } catch (e2) {}
    }
    return -1;
  }

  function collectSoulHeroProbeCandidatesImpl() {
    var panels = collectPlayerPanels();
    var out = [];
    var seenHeroTeam = Object.create(null);
    for (var i = 0; i < panels.length; i++) {
      var p = panels[i];
      if (!panelValid(p)) continue;
      var heroInfo = extractHeroFromPanel(p);
      var local = scorePanelLocalSignals(p);
      var team = inferTeamGuess(p);
      var id = panelId(p);
      var type = panelType(p);
      var playerId = readPanelPlayerId(p);
      var path = panelPathBrief(p);
      var hero = heroInfo.hero || "";
      var key = (hero || "?") + "|" + team.guess + "|" + id + "|" + type + "|" + playerId;
      if (seenHeroTeam[key]) continue;
      seenHeroTeam[key] = true;
      out.push({
        index: out.length,
        panel: p,
        id: id,
        type: type,
        playerId: playerId,
        hero: hero,
        heroSource: heroInfo.source || "none",
        heroHow: heroInfo.how || "-",
        heroRaw: heroInfo.raw || "",
        localScore: local.score || 0,
        localHits: local.hits || [],
        teamGuess: team.guess || "unknown",
        teamInfo: team,
        path: path
      });
    }
    return out;
  }

  function collectSoulHeroProbeCandidates() {
    var __perfStart = perfStart();
    try { return collectSoulHeroProbeCandidatesImpl.apply(this, arguments); }
    finally { perfEnd("collectSoulHeroProbeCandidates", __perfStart, ""); }
  }


  function pickLocalHeroCandidate(candidates) {
    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var score = c.localScore || 0;
      if (c.hero) score += 3;
      if (c.teamGuess === "friendly" || c.teamGuess === "team1" || c.teamGuess === "team2") score += 1;
      c.pickScore = score;
      if (!best || score > best.pickScore) best = c;
    }
    if (!best || !best.hero || best.pickScore < 8) return null;
    return best;
  }

  function joinHeroList(candidates, teamGuess) {
    var out = [];
    var seen = Object.create(null);
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c.hero || (teamGuess && c.teamGuess !== teamGuess)) continue;
      var key = c.hero.toLowerCase();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(c.hero);
    }
    return out.join("|") || "-";
  }

  function runLocalHeroProbeImpl(printConsole) {
    var candidates = collectSoulHeroProbeCandidates();
    var best = pickLocalHeroCandidate(candidates);
    var enemyHeroes = joinHeroList(candidates, "enemy");
    var friendlyHeroes = joinHeroList(candidates, "friendly");
    var allHeroes = joinHeroList(candidates, "");
    var resultText = "Local hero: " + (best ? best.hero : "not resolved") +
      " | score=" + (best ? best.pickScore : 0) +
      " | panels=" + candidates.length +
      " | friendly=" + friendlyHeroes +
      " | enemy=" + enemyHeroes;

    if (printConsole) {
      try { $.Msg("[SoulAdvantage] LOCAL_HERO_PROBE_START panels=" + candidates.length); } catch (eStart) {}
      for (var i = 0; i < candidates.length && i < 18; i++) {
        var c = candidates[i];
        try {
          $.Msg("[SoulAdvantage] LOCAL_HERO_CAND idx=" + c.index +
            " hero=" + (c.hero || "-") +
            " heroSource=" + (c.heroSource || "-") +
            " how=" + (c.heroHow || "-") +
            " raw=" + (c.heroRaw ? String(c.heroRaw).substring(0, 120) : "-") +
            " team=" + (c.teamGuess || "unknown") +
            " localScore=" + (c.localScore || 0) +
            " pickScore=" + (c.pickScore || 0) +
            " pid=" + c.playerId +
            " id=" + (c.id || "<no-id>") +
            " type=" + (c.type || "<no-type>") +
            " localHits=" + (c.localHits && c.localHits.length ? c.localHits.join(",") : "-") +
            " teamHits=" + (c.teamInfo && c.teamInfo.hits && c.teamInfo.hits.length ? c.teamInfo.hits.join(",") : "-") +
            " path=" + c.path);
        } catch (eCand) {}
      }
      try {
        $.Msg("[SoulAdvantage] LOCAL_HERO_RESULT hero=" + (best ? best.hero : "-") +
          " confidence=" + (best ? (best.pickScore >= 18 ? "high" : "medium") : "none") +
          " bestIdx=" + (best ? best.index : -1) +
          " all=" + allHeroes +
          " friendly=" + friendlyHeroes +
          " enemy=" + enemyHeroes);
      } catch (eEnd) {}
    }

    try {
      if (debugLabels.heroProbe) debugLabels.heroProbe.text = resultText;
    } catch (eLabel) {}
    return { best: best, candidates: candidates, text: resultText };
  }

  function runLocalHeroProbe() {
    var __perfStart = perfStart();
    try { return runLocalHeroProbeImpl.apply(this, arguments); }
    finally { perfEnd("runLocalHeroProbe", __perfStart, ""); }
  }

  function resetLocalHeroProbe() {
    localHeroPanel = null;
    localHeroName = "";
    autoLocalHeroProbeFailed = false;
    nextLocalHeroProbeMs = 0;
    nextManualLocalHeroFindMs = 0;
    localHeroProbeAttempts = 0;
    localHeroBootMs = 0;
    try { if (DMM && DMM.resetGameTime) DMM.resetGameTime(); } catch (e) {}
  }

  function resetManualLocalHero() {
    manualLocalHeroName = "";
    resetLocalHeroProbe();
  }

  // Fires once when the match clock drops (new match started). Clears every
  // per-match cache so stale/reused panels from the prior game can't leave
  // heroes without a label or an incorrect local-hero reference behind.
  function resetForNewMatch() {
    resetManualLocalHero();
    cachedPanels = [];
    nextRescanMs = 0;
    nextPanelValidationMs = 0;
    try { if (debugLabels.manualHeroEntry) debugLabels.manualHeroEntry.text = ""; } catch (e0) {}
    setHeroResultText("Local hero not selected");
    try { $.Msg("[SoulAdvantage] New match detected; cleared local hero + panel cache."); } catch (e1) {}
  }

  function detectNewMatch(now) {
    var seconds = (DMM && DMM.getGameTime) ? DMM.getGameTime(findRootPanel(), null) : null;
    if (seconds === null) return;
    if (lastSeenGameSeconds !== null && seconds < lastSeenGameSeconds - MATCH_RESET_DROP_SEC) {
      resetForNewMatch();
    }
    lastSeenGameSeconds = seconds;
  }

  function displayParentTag(playerPanel) {
    if (!panelValid(playerPanel)) return "invalid";
    var ids = ["HeroImage", "HeroPortrait", "PlayerPortrait", "HeroIcon", "PlayerIcon", "HeroContents", "PortraitContainer", "PlayerDetailsContainer"];
    for (var i = 0; i < ids.length; i++) {
      try { if (panelValid(playerPanel.FindChildTraverse(ids[i]))) return ids[i]; } catch (e) {}
    }
    return "fallback";
  }

  function diagPanelCoverage(now) {
    if (now < nextDiagMs) return;
    nextDiagMs = now + DIAG_SEC * 1000;
    try {
      var live = collectPlayerPanelsImpl();
      var cachedIds = Object.create(null);
      for (var i = 0; i < cachedPanels.length; i++) {
        if (panelValid(cachedPanels[i])) cachedIds[panelId(cachedPanels[i]) + "|" + panelType(cachedPanels[i])] = true;
      }
      var missing = [];
      for (var j = 0; j < live.length; j++) {
        var key = panelId(live[j]) + "|" + panelType(live[j]);
        if (!cachedIds[key]) missing.push(panelId(live[j]) || "?");
      }
      var fallback = [];
      for (var k = 0; k < cachedPanels.length; k++) {
        var p = cachedPanels[k];
        if (!panelValid(p)) continue;
        if (displayParentTag(p) === "fallback") fallback.push(panelId(p) || "?");
      }
      var seconds = (DMM && DMM.getGameTime) ? DMM.getGameTime(findRootPanel(), null) : null;
      $.Msg("[SoulAdvantage] DIAG t=" + (seconds === null ? "-" : seconds.toFixed(0)) +
        " cached=" + cachedPanels.length + " live=" + live.length +
        " missing=" + (missing.length ? missing.join(",") : "-") +
        " fallbackParent=" + (fallback.length ? fallback.join(",") : "-"));
    } catch (e) {}
  }

  function findPanelForHeroName(heroName) {
    var wanted = canonicalHeroName(heroName) || String(heroName || "").trim();
    if (!wanted) return null;

    if (!cachedPanels.length) cachedPanels = collectPlayerPanels();

    for (var i = 0; i < cachedPanels.length; i++) {
      var p = cachedPanels[i];
      if (!panelValid(p)) continue;
      var heroInfo = extractHeroFromPanel(p);
      var hero = canonicalHeroName(heroInfo.hero || "") || heroInfo.hero || "";
      if (hero && hero.toLowerCase() === wanted.toLowerCase()) return p;
    }
    return null;
  }

  function setManualLocalHeroFromText(text) {
    var hero = canonicalHeroName(text) || String(text || "").trim();
    if (!hero) return false;

    manualLocalHeroName = hero;
    localHeroPanel = null;
    localHeroName = hero;
    autoLocalHeroProbeFailed = true; // Manual replay mode: do not run the expensive auto probe.
    nextManualLocalHeroFindMs = 0;

    var found = findPanelForHeroName(hero);
    if (panelValid(found)) {
      localHeroPanel = found;
      try { $.Msg("[SoulAdvantage] Manual local hero cached: " + hero); } catch (e0) {}
      return true;
    }

    try { $.Msg("[SoulAdvantage] Manual local hero set to " + hero + ", but matching panel not found yet."); } catch (e1) {}
    return true;
  }

  function getLocalHeroPanelOnce(now) {
    if (panelValid(localHeroPanel)) return localHeroPanel;

    localHeroPanel = null;

    if (manualLocalHeroName) {
      localHeroName = manualLocalHeroName;
      if (now < nextManualLocalHeroFindMs) return null;
      nextManualLocalHeroFindMs = now + MANUAL_LOCAL_HERO_FIND_RETRY_SEC * 1000;
      localHeroPanel = findPanelForHeroName(manualLocalHeroName);
      return panelValid(localHeroPanel) ? localHeroPanel : null;
    }

    localHeroName = "";

    // In replay/spectator contexts, no local hero may exist — bounded retries
    // (not infinite) still avoid repeating the expensive scan forever.
    if (autoLocalHeroProbeFailed) return null;
    if (now < nextLocalHeroProbeMs) return null;

    if (!localHeroBootMs) localHeroBootMs = now;
    var seconds = (DMM && DMM.getGameTime) ? DMM.getGameTime(findRootPanel(), null) : null;
    var elapsedSinceBoot = (now - localHeroBootMs) / 1000;
    var ready = seconds !== null ? seconds >= LOCAL_HERO_GATE_SEC : elapsedSinceBoot >= LOCAL_HERO_GATE_SEC + 15;
    if (!ready) { nextLocalHeroProbeMs = now + 1000; return null; }

    localHeroProbeAttempts++;
    nextLocalHeroProbeMs = now + LOCAL_HERO_PROBE_ATTEMPT_RETRY_SEC * 1000;

    var probe = runLocalHeroProbe(LOCAL_HERO_DIAG);
    if (probe && probe.best && panelValid(probe.best.panel)) {
      localHeroPanel = probe.best.panel;
      localHeroName = probe.best.hero || "";
      nextLocalHeroProbeMs = now + LOCAL_HERO_PROBE_RETRY_SEC * 1000;
      try { $.Msg("[SoulAdvantage] Local hero cached: " + (localHeroName || "unknown") + " (auto, attempt " + localHeroProbeAttempts + ")"); } catch (e) {}
      return localHeroPanel;
    }

    if (localHeroProbeAttempts >= LOCAL_HERO_PROBE_MAX_ATTEMPTS) {
      autoLocalHeroProbeFailed = true;
      try { $.Msg("[SoulAdvantage] Local hero auto probe failed after " + localHeroProbeAttempts + " attempts; auto retry disabled. Open F10 and set replay hero manually."); } catch (e2) {}
    }
    return null;
  }


  function findDisplayParent(playerPanel) {
    if (!panelValid(playerPanel)) return null;
    var ids = ["HeroImage", "HeroPortrait", "PlayerPortrait", "HeroIcon", "PlayerIcon", "HeroContents", "PortraitContainer", "PlayerDetailsContainer"];
    for (var i = 0; i < ids.length; i++) {
      try {
        var child = playerPanel.FindChildTraverse(ids[i]);
        if (panelValid(child)) {
          var parent = null;
          try { parent = child.GetParent ? child.GetParent() : null; } catch (e0) { parent = null; }
          return panelValid(parent) ? parent : child;
        }
      } catch (e1) {}
    }
    return playerPanel;
  }

  function ensureLabel(playerPanel) {
    var parent = findDisplayParent(playerPanel);
    if (!panelValid(parent)) return null;

    try {
      var legacy = parent.FindChildTraverse(LEGACY_LABEL_ID);
      if (panelValid(legacy)) legacy.DeleteAsync(0.0);
    } catch (eLegacy) {}

    var label = null;
    try { label = parent.FindChildTraverse(LABEL_ID); } catch (e0) { label = null; }
    if (!panelValid(label)) { try { label = $.CreatePanel("Label", parent, LABEL_ID); } catch (e1) { label = null; } }
    if (!panelValid(label)) return null;
    return label;
  }

  function normalizeHex(hex, fallback) {
    hex = String(hex || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback || "#ffffff";
    return hex.toLowerCase();
  }

  function applyLabelStyle(label, color) {
    if (!panelValid(label)) return;
    var scale = Math.max(0.55, Math.min(2.5, Number(settings.scale) || 1));
    try {
      label.hittest = false;
      label.hittestchildren = false;
      label.style.position = Math.round(settings.x) + "px " + Math.round(settings.y) + "px 0px";
      label.style.horizontalAlign = "center";
      label.style.verticalAlign = "top";
      label.style.width = Math.round(58 * scale) + "px";
      label.style.height = Math.round(18 * scale) + "px";
      label.style.fontSize = Math.round(13 * scale) + "px";
      label.style.fontWeight = "bold";
      label.style.textAlign = "center";
      label.style.color = color;
      label.style.textShadow = "1px 1px 2px 2.0 #000000";
      label.style.backgroundColor = "rgba(0,0,0,0.62)";
      label.style.border = "1px solid rgba(255,255,255,0.22)";
      label.style.borderRadius = Math.round(4 * scale) + "px";
      label.style.zIndex = "9000";
    } catch (e) {}
  }

  function formatSouls(value) {
    var n = (Number(value) || 0) / 1000;
    return (n > 0 ? "+" : "") + n.toFixed(1) + "k";
  }

  function clamp255(value) {
    value = Math.round(Number(value) || 0);
    if (value < 0) return 0;
    if (value > 255) return 255;
    return value;
  }

  function rgbText(r, g, b) {
    return "rgb(" + clamp255(r) + "," + clamp255(g) + "," + clamp255(b) + ")";
  }

  function lerp(a, b, t) {
    return a + (b - a) * Math.max(0, Math.min(1, Number(t) || 0));
  }

  function soulAdvantageColor(diff, heroAItemSouls) {
    diff = Number(diff) || 0;
    heroAItemSouls = Math.max(Number(heroAItemSouls) || 0, 800);

    var pct = Math.abs(diff) / heroAItemSouls;
    var rawIntensity = Math.min(pct / 0.40, 1);
    var intensity = Math.pow(rawIntensity, 0.85);

    // Keep 0-10% readable but low-noise; 40%+ reaches full danger/favorable color.
    var neutral = { r: 230, g: 230, b: 230 };
    var target;
    if (diff > 0) {
      // Enemy has more item investment than local hero: white -> orange -> red.
      target = intensity < 0.55
        ? { r: 255, g: 176, b: 64 }
        : { r: 255, g: 64, b: 48 };
    } else if (diff < 0) {
      // Enemy has less item investment than local hero: white -> mint -> green/blue.
      target = intensity < 0.55
        ? { r: 120, g: 255, b: 170 }
        : { r: 56, g: 220, b: 140 };
    } else {
      return rgbText(neutral.r, neutral.g, neutral.b);
    }

    return rgbText(
      lerp(neutral.r, target.r, intensity),
      lerp(neutral.g, target.g, intensity),
      lerp(neutral.b, target.b, intensity)
    );
  }

  function cachedPlayerPanelsNeedRefresh(now) {
    if (!cachedPanels.length) return true;
    if (now < nextPanelValidationMs && now < nextRescanMs) return false;
    nextPanelValidationMs = now + PANEL_CACHE_VALIDATE_SEC * 1000;
    var validCount = 0;
    for (var i = 0; i < cachedPanels.length; i++) {
      if (panelValid(cachedPanels[i])) validCount++;
    }
    if (validCount < Math.max(6, Math.floor(cachedPanels.length * 0.70))) return true;
    return now >= nextRescanMs && validCount < 12;
  }

  function updatePanelsImpl() {
    var now = nowMs();
    detectNewMatch(now);
    diagPanelCoverage(now);
    if (cachedPlayerPanelsNeedRefresh(now)) {
      cachedPanels = collectPlayerPanels();
      nextRescanMs = now + RESCAN_SEC * 1000;
      nextPanelValidationMs = now + PANEL_CACHE_VALIDATE_SEC * 1000;
    }

    var localPanel = getLocalHeroPanelOnce(now);
    var localInfo = localPanel ? calculateSoulInfo(localPanel) : null;
    var localEffective = localInfo ? localInfo.effective : 0;

    var visibleCount = 0;
    for (var i = 0; i < cachedPanels.length; i++) {
      var p = cachedPanels[i];
      if (!panelValid(p)) continue;

      var info = calculateSoulInfo(p);
      var label = ensureLabel(p);
      if (!panelValid(label)) continue;

      try {
        var diff = localPanel ? (info.effective - localEffective) : info.effective;
        var text = formatSouls(diff);
        var color = localPanel ? soulAdvantageColor(diff, localEffective) : normalizeHex(settings.fixedColor, "#ffffff");
        var styleKey = Math.round(settings.x) + "|" + Math.round(settings.y) + "|" + Number(settings.scale).toFixed(2) + "|" + color;
        if (label.__saLastText !== text) {
          label.text = text;
          label.__saLastText = text;
        }
        if (label.__saStyleKey !== styleKey) {
          applyLabelStyle(label, color);
          label.__saStyleKey = styleKey;
        }
        if (label.__saVisible !== 1) {
          label.style.visibility = "visible";
          label.__saVisible = 1;
        }
        visibleCount++;
      } catch (e1) {}
    }

    lastPanelCount = cachedPanels.length;
    lastEffectiveCount = visibleCount;
  }

  function updatePanels() {
    var __perfStart = perfStart();
    try { return updatePanelsImpl.apply(this, arguments); }
    finally { perfEnd("updatePanels", __perfStart, "cached=" + cachedPanels.length + " visible=" + lastEffectiveCount); }
  }


  function cyclePreset(field, dir) {
    var cur = normalizeHex(settings[field], COLOR_PRESETS[0]);
    var idx = 0;
    for (var i = 0; i < COLOR_PRESETS.length; i++) if (COLOR_PRESETS[i].toLowerCase() === cur.toLowerCase()) idx = i;
    idx = (idx + dir + COLOR_PRESETS.length) % COLOR_PRESETS.length;
    settings[field] = COLOR_PRESETS[idx];
    updateDebugText();
    updatePanels();
  }

  function makeCode() {
    return [
      "SA1",
      "x=" + Math.round(settings.x),
      "y=" + Math.round(settings.y),
      "s=" + Number(settings.scale).toFixed(2),
      "f=" + normalizeHex(settings.fixedColor, "#ffffff")
    ].join("|");
  }

  function loadCode(code) {
    code = String(code || "").trim();
    if (!code) return false;
    var parts = code.split("|");
    if (parts[0] !== "SA1" && parts[0] !== "US2") return false;
    for (var i = 1; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv.length < 2) continue;
      var k = kv[0], v = kv.slice(1).join("=");
      if (k === "x") settings.x = Number(v) || 0;
      else if (k === "y") settings.y = Number(v) || 0;
      else if (k === "s") settings.scale = Math.max(0.55, Math.min(2.5, Number(v) || 1));
      else if (k === "f") settings.fixedColor = normalizeHex(v, settings.fixedColor);
    }
    updateDebugText();
    updatePanels();
    return true;
  }

  function stylePanel(panel) {
    try {
      panel.style.position = "80px 120px 0px";
      panel.style.width = "460px";
      panel.style.height = "430px";
      panel.style.flowChildren = "down";
      panel.style.padding = "14px";
      panel.style.backgroundColor = "rgba(8,8,12,0.94)";
      panel.style.border = "1px solid rgba(255,255,255,0.22)";
      panel.style.borderRadius = "8px";
      panel.style.zIndex = "40000";
    } catch (e) {}
  }

  function styleLabel(label, size, color, height) {
    try {
      label.style.fontSize = size + "px";
      label.style.color = color;
      label.style.height = height + "px";
      label.style.width = "100%";
      label.style.whiteSpace = "normal";
      label.style.textAlign = "center";
      label.style.textShadow = "1px 1px 2px 2.0 #000000";
    } catch (e) {}
  }

  function styleButton(btn, width, height, accent) {
    try {
      btn.style.width = width + "px";
      btn.style.height = (height || 30) + "px";
      btn.style.marginRight = "5px";
      btn.style.backgroundColor = accent ? "rgba(88,58,132,0.96)" : "rgba(38,38,48,0.96)";
      btn.style.border = accent ? "1px solid rgba(214,163,255,0.70)" : "1px solid rgba(255,255,255,0.22)";
      btn.style.borderRadius = "5px";
    } catch (e) {}
  }

  function makeRow(parent, id) {
    var row = $.CreatePanel("Panel", parent, id);
    try {
      row.style.width = "100%";
      row.style.height = "34px";
      row.style.flowChildren = "right";
      row.style.marginTop = "4px";
      row.style.horizontalAlign = "center";
    } catch (e) {}
    return row;
  }

  function makeSectionLabel(parent, id, text) {
    var label = $.CreatePanel("Label", parent, id);
    label.text = text;
    styleLabel(label, 12, "#bfc0c8", 22);
    try {
      label.style.textAlign = "left";
      label.style.marginTop = "8px";
      label.style.opacity = "0.85";
    } catch (e) {}
    return label;
  }

  function makeButton(parent, id, text, fn, width, height, accent) {
    var btn = $.CreatePanel("Button", parent, id);
    styleButton(btn, width || 80, height || 30, !!accent);
    try { btn.SetPanelEvent("onactivate", fn); } catch (e) {}
    var lbl = $.CreatePanel("Label", btn, id + "Label");
    lbl.text = text;
    try {
      lbl.style.width = "100%";
      lbl.style.height = "100%";
      lbl.style.textAlign = "center";
      lbl.style.verticalAlign = "center";
      lbl.style.color = "white";
      lbl.style.fontSize = accent ? "20px" : "13px";
      lbl.style.fontWeight = accent ? "bold" : "semi-bold";
      lbl.style.textShadow = "1px 1px 2px 2.0 #000000";
    } catch (e2) {}
    return lbl;
  }

  function resetDefaults() {
    settings.x = 0;
    settings.y = 4;
    settings.scale = 1.65;
    settings.fixedColor = "#ffffff";
    updateDebugText();
    updatePanels();
  }

  function localHeroText() {
    if (localHeroName) return "Local hero found: " + localHeroName;
    if (manualLocalHeroName) return "Local hero set: " + manualLocalHeroName;
    if (autoLocalHeroProbeFailed) return "Local hero not found";
    return "Local hero not selected";
  }

  function setHeroResultText(extraText) {
    try {
      if (!debugLabels.heroProbe) return;
      debugLabels.heroProbe.text = extraText || localHeroText();
      if (localHeroName || manualLocalHeroName) {
        debugLabels.heroProbe.style.color = "#66ff99";
        debugLabels.heroProbe.style.border = "1px solid rgba(102,255,153,0.35)";
        debugLabels.heroProbe.style.backgroundColor = "rgba(20,60,38,0.42)";
      } else {
        debugLabels.heroProbe.style.color = "#fff0a8";
        debugLabels.heroProbe.style.border = "1px solid rgba(255,240,168,0.25)";
        debugLabels.heroProbe.style.backgroundColor = "rgba(70,55,20,0.36)";
      }
    } catch (e) {}
  }

  function ensureDebugPanel() {
    if (panelValid(debugPanel)) return debugPanel;
    var root = findRootPanel();
    if (!panelValid(root)) return null;
    try { debugPanel = root.FindChildTraverse(DEBUG_PANEL_ID); } catch (e0) { debugPanel = null; }
    if (!panelValid(debugPanel)) {
      try {
        debugPanel = $.CreatePanel("Panel", root, DEBUG_PANEL_ID);
        stylePanel(debugPanel);
        debugPanel.hittest = true;
        debugPanel.hittestchildren = true;

        var title = $.CreatePanel("Label", debugPanel, "DMMSoulAdvantageTitle");
        title.text = "Soul Advantage";
        styleLabel(title, 22, "#ffffff", 30);
        try {
          title.style.fontWeight = "bold";
          title.style.textTransform = "uppercase";
          title.style.letterSpacing = "1px";
        } catch (eTitle) {}

        var subtitle = $.CreatePanel("Label", debugPanel, "DMMSoulAdvantageSubtitle");
        subtitle.text = "Choose your local hero, then tune the overlay.";
        styleLabel(subtitle, 12, "#bfc0c8", 24);

        // Automatic probe (gated on DMM.getGameTime()>=30s, see
        // getLocalHeroPanelOnce) resolves the local hero on its own in the
        // common case. The manual override below covers the cases it
        // doesn't (replay/spectator, a slow/failed auto probe) — kept behind
        // a small toggle so it doesn't clutter the panel at a glance.
        debugLabels.heroProbe = $.CreatePanel("Label", debugPanel, "DMMSoulAdvantageHeroProbeResult");
        debugLabels.heroProbe.text = "Local hero not selected";
        styleLabel(debugLabels.heroProbe, 15, "#fff0a8", 42);
        try {
          debugLabels.heroProbe.style.marginTop = "8px";
          debugLabels.heroProbe.style.padding = "8px";
          debugLabels.heroProbe.style.borderRadius = "5px";
          debugLabels.heroProbe.style.backgroundColor = "rgba(70,55,20,0.36)";
          debugLabels.heroProbe.style.border = "1px solid rgba(255,240,168,0.25)";
        } catch (eHeroStyle) {}

        var manualToggleRow = makeRow(debugPanel, "DMMSoulAdvantageRowManualToggle");
        makeButton(manualToggleRow, "DMMSoulAdvantageManualToggle", "Manual Hero...", function () {
          var row = debugLabels.manualHeroRow;
          if (!row) return;
          try {
            var collapsed = row.style.visibility === "collapse";
            row.style.visibility = collapsed ? "visible" : "collapse";
            row.style.height = collapsed ? "34px" : "0px";
          } catch (eToggle) {}
        }, 110, 24);

        var manualRow = makeRow(debugPanel, "DMMSoulAdvantageRowManualHero");
        try { manualRow.style.visibility = "collapse"; manualRow.style.height = "0px"; } catch (eManualRow) {}
        debugLabels.manualHeroRow = manualRow;
        debugLabels.manualHeroEntry = $.CreatePanel("TextEntry", manualRow, "DMMSoulAdvantageManualHeroEntry");
        try {
          debugLabels.manualHeroEntry.style.width = "160px";
          debugLabels.manualHeroEntry.style.height = "30px";
          debugLabels.manualHeroEntry.style.fontSize = "12px";
          debugLabels.manualHeroEntry.style.color = "white";
          debugLabels.manualHeroEntry.style.backgroundColor = "rgba(0,0,0,0.55)";
          debugLabels.manualHeroEntry.style.border = "1px solid rgba(255,255,255,0.18)";
          debugLabels.manualHeroEntry.style.marginRight = "6px";
        } catch (eManualEntry) {}
        makeButton(manualRow, "DMMSoulAdvantageManualHeroSet", "Set", function () {
          var text = "";
          try { text = debugLabels.manualHeroEntry.text || ""; } catch (eReadEntry) {}
          var ok = setManualLocalHeroFromText(text);
          setHeroResultText(ok ? localHeroText() : "Enter a valid hero name.");
          updatePanels();
          updateDebugText();
        }, 60, 30);
        makeButton(manualRow, "DMMSoulAdvantageManualHeroClear", "Clear", function () {
          resetManualLocalHero();
          try { debugLabels.manualHeroEntry.text = ""; } catch (eClearEntry) {}
          setHeroResultText("Local hero not selected");
          updatePanels();
          updateDebugText();
        }, 60, 30);

        makeSectionLabel(debugPanel, "DMMSoulAdvantageColorTitle", "Color");
        var colorRow = makeRow(debugPanel, "DMMSoulAdvantageRowColor");
        debugLabels.fixed = makeButton(colorRow, "DMMSoulAdvantageFixedColor", "Fallback Color", function(){ cyclePreset("fixedColor", 1); }, 150);
        makeButton(colorRow, "DMMSoulAdvantageReset", "Reset", resetDefaults, 90);
        makeButton(colorRow, "DMMSoulAdvantageRescan", "Rescan Panels", function(){
          cachedPanels=[];
          nextRescanMs=0;
          nextPanelValidationMs=0;
          resetLocalHeroProbe();
          setHeroResultText("Local hero not selected");
          updatePanels();
          updateDebugText();
        }, 130);

        makeSectionLabel(debugPanel, "DMMSoulAdvantageTransformTitle", "Transform");
        var r1 = makeRow(debugPanel, "DMMSoulAdvantageRowXY");
        makeButton(r1, "DMMSoulAdvantageXMinus", "X -5", function(){ settings.x -= 5; updateDebugText(); updatePanels(); }, 62);
        makeButton(r1, "DMMSoulAdvantageXPlus", "X +5", function(){ settings.x += 5; updateDebugText(); updatePanels(); }, 62);
        makeButton(r1, "DMMSoulAdvantageYMinus", "Y -5", function(){ settings.y -= 5; updateDebugText(); updatePanels(); }, 62);
        makeButton(r1, "DMMSoulAdvantageYPlus", "Y +5", function(){ settings.y += 5; updateDebugText(); updatePanels(); }, 62);
        makeButton(r1, "DMMSoulAdvantageScaleDown", "Scale -", function(){ settings.scale = Math.max(0.55, settings.scale - 0.05); updateDebugText(); updatePanels(); }, 78);
        makeButton(r1, "DMMSoulAdvantageScaleUp", "Scale +", function(){ settings.scale = Math.min(2.5, settings.scale + 0.05); updateDebugText(); updatePanels(); }, 78);

        debugLabels.transform = $.CreatePanel("Label", debugPanel, "DMMSoulAdvantageTransformReadout");
        styleLabel(debugLabels.transform, 12, "#d8d8d8", 22);
        try { debugLabels.transform.style.textAlign = "left"; } catch (eTransformStyle) {}

        makeSectionLabel(debugPanel, "DMMSoulAdvantageCodeTitle", "Settings Code");
        debugLabels.codeEntry = $.CreatePanel("TextEntry", debugPanel, "DMMSoulAdvantageCodeEntry");
        try {
          debugLabels.codeEntry.style.width = "100%";
          debugLabels.codeEntry.style.height = "32px";
          debugLabels.codeEntry.style.fontSize = "12px";
          debugLabels.codeEntry.style.color = "white";
          debugLabels.codeEntry.style.backgroundColor = "rgba(0,0,0,0.55)";
          debugLabels.codeEntry.style.border = "1px solid rgba(255,255,255,0.18)";
        } catch (eEntry) {}

        var r3 = makeRow(debugPanel, "DMMSoulAdvantageRowCode");
        makeButton(r3, "DMMSoulAdvantageGenerate", "Generate Code", function(){ try { debugLabels.codeEntry.text = makeCode(); } catch(e) {} updateDebugText(); }, 132);
        makeButton(r3, "DMMSoulAdvantageLoad", "Load Code", function(){
          var ok=false;
          try { ok = loadCode(debugLabels.codeEntry.text || ""); } catch(e) {}
          setHeroResultText(ok ? localHeroText() : "Could not load that settings code.");
          updateDebugText();
        }, 100);
        makeButton(r3, "DMMSoulAdvantageClose", "Close", function(){ debugVisible=false; try{ debugPanel.style.visibility="collapse"; }catch(e){} }, 80);
      } catch (eCreate) {
        try { $.Msg("[SoulAdvantage] panel_create_failed " + eCreate); } catch (ignore) {}
      }
    }
    updateDebugText();
    return debugPanel;
  }

  function updateDebugText() {
    if (!panelValid(debugPanel)) return;
    try {
      if (debugLabels.fixed) debugLabels.fixed.text = "Fallback " + settings.fixedColor;
      if (debugLabels.transform) debugLabels.transform.text = "X " + Math.round(settings.x) + "   Y " + Math.round(settings.y) + "   Scale " + Number(settings.scale).toFixed(2);
      if (debugLabels.manualHeroEntry && manualLocalHeroName && !debugLabels.manualHeroEntry.text) debugLabels.manualHeroEntry.text = manualLocalHeroName;
      if (debugLabels.codeEntry && !debugLabels.codeEntry.text) debugLabels.codeEntry.text = makeCode();
      setHeroResultText();
    } catch (e) {}
  }

  function toggleDebugPanel() {
    debugVisible = !debugVisible;
    var panel = ensureDebugPanel();
    if (!panelValid(panel)) return true;
    try { panel.style.visibility = debugVisible ? "visible" : "collapse"; } catch (e) {}
    updateDebugText();
    return true;
  }

  function bindKey() {
    if (keybindBound) return;
    if (typeof $ === "undefined" || !$ || typeof $.RegisterKeyBind !== "function") { $.Schedule(0.25, bindKey); return; }
    var context = null;
    try { context = $.GetContextPanel(); } catch (e0) { context = null; }
    var ok = false;
    try { $.RegisterKeyBind(context, SETTINGS_KEY, toggleDebugPanel); ok = true; } catch (e1) {}
    try { $.RegisterKeyBind("", SETTINGS_KEY, toggleDebugPanel); ok = true; } catch (e2) {}
    keybindBound = ok;
    if (!ok) $.Schedule(0.25, bindKey);
  }

  function updateLoopImpl() {
    try {
      updatePanels();
      updateDebugText();
    } catch (e) {
      try { $.Msg("[SoulAdvantage] update_failed " + e); } catch (ignore) {}
    }
    $.Schedule(UPDATE_SEC, updateLoop);
  }

  function updateLoop() {
    var __perfStart = perfStart();
    try { return updateLoopImpl.apply(this, arguments); }
    finally { perfEnd("updateLoop", __perfStart, ""); }
  }


  bindKey();
  updateLoop();
})();
