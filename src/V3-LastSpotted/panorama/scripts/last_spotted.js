// Made by V3. Discord: v3nty.
// LastSpot — lingering enemy last-seen markers for the Deadlock minimap.
// Rewrite: modular, built on dmm_core.js (the DMM namespace). See CLAUDE.md.
//
// Data flow (400ms loop):
//   Scanner.tick -> resolve panels -> collect minimap map_buttons ->
//   build enemy candidate list -> assign each to a stable tracker ID (1..6) ->
//   Markers render a live dot while in view; when a tracked enemy drops out of
//   view a linger marker is left behind and fades out over `persistenceMs`.
//   LaneAssist narrows/auto-fills hero picks using topbar hero names + lane X.
(function () {
  "use strict";

  var G = (typeof globalThis !== "undefined") ? globalThis : (function () { return this; })();
  var DMM = G.DMM;
  if (!DMM) { try { $.Msg("[LastSpot] FATAL: dmm_core.js not loaded before last_spotted.js"); } catch (e) {} return; }

  var log = DMM.makeLogger("LastSpot");
  var perf = DMM.makePerf("LastSpot");

  // ===========================================================================
  // Cfg — constants & tunable defaults
  // ===========================================================================
  var Cfg = {
    SCAN_MS: 400,
    STATUS_MS: 500,
    REFRESH_PANELS_MS: 10000,
    MAP_BUTTON_CACHE_MS: 10000,
    MISSING_CONFIRM_MS: 450,
    STALE_PLAYER_MS: 60000,
    MAX_SLOTS: 6,
    SETTINGS_KEYBIND: "key_f9",

    DEF_OFFSET_X: -100,
    DEF_OFFSET_Y: -98,
    DEF_SCALE_X: 0.75,
    DEF_SCALE_Y: 0.75,
    DEF_PERSISTENCE_MS: 25000,
    DEF_FADE_HOLD_MS: 5000,
    DEF_LINGER_START_OPACITY: 0.75,
    DEF_LINGER_END_OPACITY: 0.20,
    DEF_MARKER_SCALE: 1.30,
    LIVE_MARKER_LEFT_OFFSET_PX: -30,

    REF_MINIMAP_W: 1512,
    REF_MINIMAP_H: 862,

    // Topbar names are read ONCE, gated on real match time (DMM.getGameTime()) reaching
    // 30s — not wall-clock-since-load, so a HUD reload mid-match doesn't reset
    // the gate. A SMALL bounded number of retries handle late-loading panels;
    // after that the probe permanently gives up rather than retrying for the
    // rest of the match (previously-unenforced NAME_PROBE_MAX_ATTEMPTS was the
    // cause of the recurring frame spike — every 30s, forever, full-match).
    NAME_PROBE_DELAY_SEC: 60,
    NAME_PROBE_RETRY_SEC: 5,
    NAME_PROBE_MAX_ATTEMPTS: 3,

    SUPPORTED_TEAM_SIZES: [4, 6],
    DEF_LANE_SPLIT_RIGHT_MIDDLE: 0.333,
    DEF_LANE_SPLIT_MIDDLE_LEFT: 0.667,
    LANE_SPLIT_MIN_GAP: 0.05,

    STORE_KEY: "lastspot_settings_v3"
  };

  // Team layout: which minimap team-class is "us" vs "enemy", and whether the
  // marker overlay is mirrored. Auto-detected from the local player's map button.
  var TEAM = {
    // topbarHalf: which half of the left->right topbar roster holds the enemy team.
    archmother:  { label: "ArchMother",  localClass: "team2", enemyClass: "team1", mirror: true,  topbarHalf: "first" },
    hidden_king: { label: "Hidden King", localClass: "team1", enemyClass: "team2", mirror: false, topbarHalf: "second" }
  };

  // Scoped to the actual topbar containers only. Broad roots (Hud, minimap_persp,
  // Roster, Scoreboard) were traversed in full every 6s and caused a ~100ms JS spike.
  // TeamEnemy/TeamFriendly scanned first as the more direct roster/order source.
  var TOPBAR_ROOT_IDS = [
    "TeamFriendly", "TeamEnemy",
    "TopBar", "top_bar", "CitadelHudTopBar", "HudTopBar", "HeroTopBar",
    "PlayersTopBar", "PlayerTopBar", "TopBarPlayers", "TopBarContainer",
    "players_topbar"
  ];

  // ===========================================================================
  // ST — runtime state
  // ===========================================================================
  var ST = {
    // resolved panels
    root: null, hud: null, minimapBox: null, minimapContainer: null, minimap: null, overlay: null, scanWarning: null,
    panelsTs: 0,
    contextKey: "",

    // toggles / settings
    enabled: true,
    showLive: true,
    debug: false,

    // Full per-candidate dump of the topbar name probe. Safe to leave on: it
    // fires only inside finalizeOrder, i.e. once per name probe (at most a few
    // times per match, never per frame). Toggle at runtime with
    // $.GetContextPanel().LastSpotToggleTopbarDiag().
    topbarDiag: true,

    offsetX: Cfg.DEF_OFFSET_X, offsetY: Cfg.DEF_OFFSET_Y,
    scaleX: Cfg.DEF_SCALE_X, scaleY: Cfg.DEF_SCALE_Y,
    persistenceMs: Cfg.DEF_PERSISTENCE_MS,
    fadeHoldMs: Cfg.DEF_FADE_HOLD_MS,
    lingerStartOpacity: Cfg.DEF_LINGER_START_OPACITY,
    lingerEndOpacity: Cfg.DEF_LINGER_END_OPACITY,
    markerScale: Cfg.DEF_MARKER_SCALE,

    // team / orientation
    teamKey: "archmother",
    mirror: true,
    teamManual: false,
    teamAutoTs: 0,

    // lane assist
    laneAssistEnabled: true,
    laneSplitRM: Cfg.DEF_LANE_SPLIT_RIGHT_MIDDLE,
    laneSplitML: Cfg.DEF_LANE_SPLIT_MIDDLE_LEFT,
    laneLayoutLocked: false,
    laneLastSetupSig: "",
    laneLastSnapshot: null,
    laneBusy: false,
    laneSummary: "idle",

    // enemy hero names (fed by TopBar)
    enemyHeroNames: [],
    // ally names — free byproduct of the same topbar scan, not currently
    // consumed by anything, cached in case future automation wants it.
    friendlyHeroNames: [],
    // Ground-truth local hero name, read off the local player's own minimap
    // map_button portrait (Detect.heroFromMapButton) in Scanner.autoDetectTeam.
    // Used to filter the topbar-half positional guess in TopBar.setEnemyChoices
    // — the topbar probe has no concept of "which half is really the enemy
    // half" beyond a fixed left/right slice per map orientation, so it can
    // occasionally slice the local hero's own topbar entry into the enemy
    // half. This is independent ground truth that can't make that mistake.
    localHeroName: "",
    enemyTeamSizeHint: 0,
    namesCached: false,
    nameAttempts: 0,
    nameProbeGaveUp: false,
    deferredProbeToken: 0,
    bootMs: 0,
    lastStartMs: 0,
    // null = "no reading yet"; used by Runtime.checkMatchBoundary to detect a
    // match start/end even when the minimap panel's own object identity
    // doesn't change across the transition (the panel-identity-based reset in
    // Panels.maybeResetContext proved unreliable — some HUD structures keep
    // the same minimap panel instance across hideout<->match).
    lastGameTimeSeconds: null,

    // tracker id lock
    idsLocked: false,
    idsLockSig: "",

    // caches / bookkeeping
    mapButtonCache: null, mapButtonCacheTs: 0,
    scanToken: 0,
    nextSlotId: 1,
    selectedSlotId: 1,

    // handles
    scanHandle: null, statusHandle: null,
    settingsVisible: false, keybindBound: false
  };

  // enemy entries keyed by "enemy_panel_<slotId>"
  var enemyState = new Map();

  // 6 tracker slots
  var slots = [];
  for (var si = 1; si <= Cfg.MAX_SLOTS; si++) {
    slots.push({
      id: si, key: "", label: String(si), customName: "", choiceIndex: 0,
      lastSeenMs: 0, lastX: 0, lastY: 0, active: false, panelValid: false, dead: false,
      laneKey: "", laneLabel: "", laneCandidates: [], attachedPanel: null,
      // manualOverride: set once the user explicitly picks/types a hero for this
      // slot; blocks the map_button auto-detect (Scanner.updateEntry) from
      // overwriting their choice. Lane-assist's own guesses are NOT manual —
      // ground-truth auto-detect is allowed to confirm/correct those.
      manualOverride: false
    });
  }

  // ===========================================================================
  // Small local helpers (things not general enough for dmm_core)
  // ===========================================================================
  function findDirect(panel, id) { return DMM.findDirect(panel, id); }

  function slotById(id) {
    for (var i = 0; i < slots.length; i++) if (slots[i].id === id) return slots[i];
    return null;
  }
  function slotByKey(key) {
    if (!key) return null;
    for (var i = 0; i < slots.length; i++) if (slots[i].key === key) return slots[i];
    return null;
  }

  function expectedTeamSize() {
    var h = ST.enemyTeamSizeHint | 0;
    return (h === 4 || h === 6) ? h : 6;
  }
  function isSupportedTeamSize(n) { return Cfg.SUPPORTED_TEAM_SIZES.indexOf(n | 0) !== -1; }

  function teamCfg() { return TEAM[ST.teamKey] || TEAM.archmother; }
  function enemyMapClass() { return teamCfg().enemyClass; }

  // ===========================================================================
  // Panels — resolve the HUD/minimap tree, overlay layer, minimap size
  // ===========================================================================
  var Panels = {
    refresh: function () {
      var now = DMM.now();
      // Runs on every call (not gated by the panel-cache short-circuit below)
      // since it's cheap (single cached .text read in the common case) and
      // needs to keep working even in hideout, where the minimap panels
      // below may not resolve at all.
      Runtime.checkMatchBoundary();
      if (now - ST.panelsTs < Cfg.REFRESH_PANELS_MS &&
          DMM.valid(ST.root) && DMM.valid(ST.minimapBox) &&
          DMM.valid(ST.minimapContainer) && DMM.valid(ST.minimap)) {
        return true;
      }
      var root = DMM.root($.GetContextPanel());
      if (!DMM.valid(root)) return false;
      ST.root = root;
      ST.hud = DMM.find(root, "Hud");
      ST.minimapBox = DMM.find(root, "minimap_container");
      ST.minimapContainer = DMM.find(root, "HudMinimapContainer");
      ST.minimap = DMM.find(root, "hud_minimap");
      var ok = DMM.valid(ST.minimapBox) && DMM.valid(ST.minimapContainer) && DMM.valid(ST.minimap);
      if (ok) {
        ST.panelsTs = now;
        Panels.maybeResetContext();
      } else if (ST.contextKey) {
        // Belt-and-suspenders: if the minimap panel identity DOES change
        // (some HUD layouts recreate it), clear on that too. The primary
        // signal is Runtime.checkMatchBoundary() above (gametime-based),
        // since this panel-identity path proved unreliable on its own —
        // some HUD structures keep the same minimap panel instance across
        // hideout<->match, so it never fires by itself.
        Runtime.clearAll("left_match");
        ST.contextKey = "";
      }
      return ok;
    },

    // Reset runtime markers when the minimap instance changes (new match/map).
    maybeResetContext: function () {
      var key = "";
      try { key = DMM.id(ST.minimap) + ":" + (ST.minimap.GetChildCount ? "" : ""); } catch (e) {}
      // Use the panel object identity via a monotonic tag stamped on the panel.
      try {
        if (!ST.minimap.__lastSpotCtx) ST.minimap.__lastSpotCtx = "ctx_" + DMM.now();
        key = ST.minimap.__lastSpotCtx;
      } catch (e) {}
      if (!key) return;
      if (ST.contextKey && ST.contextKey !== key) {
        Runtime.clearAll("context_change");
      }
      ST.contextKey = key;
    },

    overlay: function () {
      if (DMM.valid(ST.overlay)) return ST.overlay;
      var parent = ST.minimapBox;
      if (!DMM.valid(parent)) return null;
      var ov = DMM.find(parent, "LastSpotOverlayLayer");
      if (!DMM.valid(ov)) {
        try {
          ov = $.CreatePanel("Panel", parent, "LastSpotOverlayLayer");
          ov.AddClass("lastspot-overlay-layer");
          ov.hittest = false; ov.hittestchildren = false;
        } catch (e) { ov = null; }
      }
      ST.overlay = ov;
      return ov;
    },

    // Screen-level (not minimap-scoped) box used to warn the player the
    // topbar name probe is about to run — that probe is a full HUD scan and
    // can cause a noticeable hitch.
    //
    // FIX HISTORY: attempt 1 parented this directly to ST.root (the raw
    // WindowRoot/CitadelHud panel returned by DMM.root()). It rendered as
    // fully unstyled (no background/border, default top-left position,
    // default text color) and its "hidden" class toggle had no visible
    // effect either — i.e. NONE of the CSS for this panel was being applied,
    // even though the exact same last_spotted.vcss_c already styles other
    // dynamically-created ls-* panels correctly (e.g. the lane-tint chips
    // under LastSpotSlots, the marker portraits under the minimap overlay).
    // The one thing genuinely different about this panel vs. every other
    // working one: it's the only ls-* element parented at the raw
    // WindowRoot level instead of somewhere under the existing LastSpotPanel
    // (or the minimap overlay) subtree. Attempt 2: parent to the SAME
    // container LastSpotPanel itself lives in (its GetParent()) — a
    // container proven, by LastSpotPanel's own visible styling every time
    // F9 is opened, to correctly cascade this stylesheet.
    scanWarning: function () {
      if (DMM.valid(ST.scanWarning)) return ST.scanWarning;
      var settingsPanel = DMM.find(ST.root, "LastSpotPanel");
      var parent = (DMM.valid(settingsPanel) && settingsPanel.GetParent) ? settingsPanel.GetParent() : null;
      if (!DMM.valid(parent)) parent = ST.root;
      if (!DMM.valid(parent)) return null;
      var box = DMM.find(parent, "LastSpotScanWarning");
      if (!DMM.valid(box)) {
        try {
          box = $.CreatePanel("Panel", parent, "LastSpotScanWarning");
          box.AddClass("ls-scan-warning");
          box.AddClass("hidden");
          box.hittest = false; box.hittestchildren = false;
          var lbl = $.CreatePanel("Label", box, "LastSpotScanWarningLabel");
          lbl.AddClass("ls-scan-warning-label");
        } catch (e) { box = null; }
      }
      ST.scanWarning = box;
      return box;
    },

    minimapSize: function () {
      var mm = DMM.valid(ST.minimap) ? ST.minimap : null;
      return {
        width: DMM.safeExtent(mm && (mm.actuallayoutwidth || mm.contentwidth), Cfg.REF_MINIMAP_W, 8192),
        height: DMM.safeExtent(mm && (mm.actuallayoutheight || mm.contentheight), Cfg.REF_MINIMAP_H, 8192)
      };
    }
  };

  // ===========================================================================
  // Detect — classify minimap map_button panels
  // ===========================================================================
  var Detect = {
    isHeroMapButton: function (panel) {
      if (!DMM.valid(panel) || !DMM.hasClass(panel, "map_button")) return false;
      if (DMM.hasClass(panel, "boss") || DMM.hasClass(panel, "powerup_spawn")) return false;
      if (findDirect(panel, "BossHealth") || findDirect(panel, "BossHealthBG")) return false;
      if (findDirect(panel, "CastRange")) return false;
      if (DMM.hasClass(panel, "player")) return true;
      if (!findDirect(panel, "MainImage")) return false;
      var hasMarker = !!(findDirect(panel, "SpeakingImage") || findDirect(panel, "DeathImage") ||
        findDirect(panel, "HeldIdolImage") || findDirect(panel, "LocalSpecularImage") ||
        findDirect(panel, "FrogImage") || findDirect(panel, "ArrowImage"));
      var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 2048);
      var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 2048);
      return hasMarker && w >= 30 && h >= 30 && w <= 110 && h <= 110;
    },

    isEnemyButton: function (panel) {
      if (!DMM.valid(panel)) return false;
      if (DMM.hasClass(panel, enemyMapClass())) return true;
      if (DMM.hasClass(panel, "team1") || DMM.hasClass(panel, "team2")) return false;
      return DMM.hasClass(panel, "enemy");
    },

    isPositioned: function (panel) {
      if (!DMM.valid(panel) || !DMM.visible(panel)) return false;
      var x = DMM.safeNumber(panel.actualxoffset);
      var y = DMM.safeNumber(panel.actualyoffset);
      if (x === null || y === null) return false;
      var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 2048);
      var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 2048);
      if (w < 18 || h < 18 || w > 120 || h > 120) return false;
      if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01 && w <= 32 && h <= 32) return false;
      return true;
    },

    isActive: function (panel) {
      if (!DMM.valid(panel) || !DMM.visible(panel)) return false;
      if (!DMM.hasClass(panel, "active")) return false;
      var x = DMM.safeNumber(panel.actualxoffset);
      var y = DMM.safeNumber(panel.actualyoffset);
      if (x === null || y === null) return false;
      var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 2048);
      var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 2048);
      if (w <= 0 || h <= 0) return false;
      if (Math.abs(x) < 0.01 && Math.abs(y) < 0.01 && w <= 32 && h <= 32) return false;
      return true;
    },

    isDead: function (panel) {
      if (!DMM.valid(panel)) return false;
      if (DMM.hasClass(panel, "dead") || DMM.hasClass(panel, "PlayerDead") || DMM.hasClass(panel, "playerdead")) return true;
      var death = findDirect(panel, "DeathImage");
      return DMM.valid(death) && DMM.visible(death);
    },

    // team-key from a local player's map button
    localTeamKey: function (panel) {
      if (!DMM.valid(panel)) return "";
      if (DMM.hasClass(panel, "team1")) return "hidden_king";
      if (DMM.hasClass(panel, "team2")) return "archmother";
      return "";
    },

    // Direct hero identity from a minimap map_button's own portrait image —
    // ground truth (this IS the tracked enemy), not topbar inference. Cheap:
    // MainImage is a direct child every hero map_button already has (isHeroMapButton
    // uses findDirect on it too), so this is safe to call from the 400ms scan loop.
    // The image src is a bare codename ("archer_mm_vtex.psd", no "hero" marker) —
    // resolved the same way as topbar portraits, via TopBar.heroFromImg/findHeroMention.
    HERO_IMAGE_CHILD_IDS: ["MainImage", "Icon", "Portrait", "HeroImage"],
    heroFromMapButton: function (panel) {
      if (!DMM.valid(panel)) return "";
      for (var i = 0; i < Detect.HERO_IMAGE_CHILD_IDS.length; i++) {
        var img = findDirect(panel, Detect.HERO_IMAGE_CHILD_IDS[i]);
        if (!img) continue;
        var src = DMM.readAnyString(img, TopBar.IMG_ATTRS);
        var hero = src ? TopBar.heroFromImg(src) : "";
        if (hero) return hero;
      }
      return "";
    }
  };

  // ===========================================================================
  // Transform — minimap raw coords -> overlay pixel position
  // ===========================================================================
  function transformPoint(rawX, rawY, w, h) {
    var mm = Panels.minimapSize();
    var rx = rawX, ry = rawY;
    if (ST.mirror) { rx = mm.width - rawX; ry = mm.height - rawY; }
    var cx = mm.width * 0.5, cy = mm.height * 0.5;
    var x = cx + (rx - cx) * ST.scaleX + ST.offsetX;
    var y = cy + (ry - cy) * ST.scaleY + ST.offsetY;
    return { x: x - (w || 0) * 0.5, y: y - (h || 0) * 0.5 };
  }

  // ===========================================================================
  // Markers — live dot (in view) + linger marker (fading, out of view)
  // ===========================================================================
  var Markers = {
    baseSize: function (mode) { return mode === "live" ? 18 : 22; },
    scaledSize: function (mode) {
      return Math.max(8, Math.round(Markers.baseSize(mode) * DMM.clamp(ST.markerScale, 0.4, 3.0)));
    },

    ensure: function (entry, mode) {
      var overlay = Panels.overlay();
      if (!DMM.valid(overlay)) return null;
      var marker = mode === "live" ? entry.liveMarker : entry.lingerMarker;
      if (!DMM.valid(marker)) {
        var mid = (mode === "live" ? "LastSpotLive_" : "LastSpotLinger_") + entry.key.replace(/[^a-zA-Z0-9_]/g, "_");
        try {
          marker = $.CreatePanel("Panel", overlay, mid);
          marker.hittest = false; marker.hittestchildren = false;
          marker.AddClass(mode === "live" ? "lastspot-live-marker" : "lastspot-linger-marker");
        } catch (e) { marker = null; }
      }
      Markers.ensureChildren(marker, mode);
      if (mode === "live") entry.liveMarker = marker; else entry.lingerMarker = marker;
      return marker;
    },

    ensureChildren: function (marker, mode) {
      if (!DMM.valid(marker)) return;
      try {
        var created = false;
        var portrait = DMM.find(marker, "LastSpotPortrait");
        if (!DMM.valid(portrait)) {
          portrait = $.CreatePanel("Image", marker, "LastSpotPortrait");
          portrait.AddClass("lastspot-marker-portrait");
          portrait.hittest = false; portrait.hittestchildren = false;
          created = true;
        }
        var fallback = DMM.find(marker, "LastSpotFallbackLabel");
        if (!DMM.valid(fallback)) {
          fallback = $.CreatePanel("Label", marker, "LastSpotFallbackLabel");
          fallback.AddClass("lastspot-marker-fallback");
          fallback.hittest = false; fallback.hittestchildren = false;
          created = true;
        }
        var size = Markers.scaledSize(mode);
        var font = mode === "live" ? Math.max(11, Math.round(12 * ST.markerScale)) : Math.max(13, Math.round(17 * ST.markerScale));
        var styleKey = mode + "|" + size + "|" + font;
        if (!created && marker.__childStyleKey === styleKey) return;
        marker.__childStyleKey = styleKey;
        portrait.style.width = size + "px"; portrait.style.height = size + "px";
        fallback.style.width = size + "px"; fallback.style.height = size + "px";
        fallback.style.fontSize = font + "px"; fallback.style.lineHeight = size + "px";
      } catch (e) {}
    },

    setContent: function (entry, marker, fallbackText, mode) {
      if (!DMM.valid(marker)) return;
      Markers.ensureChildren(marker, mode);
      var portrait = DMM.find(marker, "LastSpotPortrait");
      var fallback = DMM.find(marker, "LastSpotFallbackLabel");
      var slot = entry && entry.trackerId ? slotById(entry.trackerId) : null;
      var iconPath = (mode === "linger" && slot && slot.customName) ? DMM.heroIconPath(slot.customName) : "";
      var useIcon = !!iconPath;
      var key = mode + "|" + String(fallbackText || "?") + "|" + (useIcon ? String(slot.customName) : "");
      if (marker.__contentKey === key) return;
      marker.__contentKey = key;
      try {
        if (DMM.valid(portrait)) {
          if (useIcon) {
            if (portrait.SetImage) portrait.SetImage(iconPath);
            portrait.style.backgroundImage = 'url("' + iconPath + '")';
            portrait.style.backgroundSize = "100% 100%";
            portrait.style.visibility = "visible";
            marker.style.backgroundColor = "transparent";
            marker.style.border = "1px solid rgba(255,255,255,0.90)";
          } else {
            portrait.style.visibility = "collapse";
            marker.style.backgroundColor = mode === "live" ? "rgba(255,60,90,0.86)" : "rgba(255,75,75,0.92)";
            marker.style.border = mode === "live" ? "1px solid rgba(255,255,255,0.80)" : "2px solid rgba(255,255,255,0.92)";
          }
        }
        if (DMM.valid(fallback)) {
          fallback.text = fallbackText || "?";
          fallback.style.visibility = useIcon ? "collapse" : "visible";
        }
      } catch (e) {}
    },

    position: function (marker, entry, extraX) {
      if (!DMM.valid(marker)) return;
      var mode = marker === entry.liveMarker ? "live" : "linger";
      var size = Markers.scaledSize(mode);
      var px = transformPoint(entry.x, entry.y, size, size);
      var fx = px.x + (Number(extraX) || 0), fy = px.y;
      var posKey = fx.toFixed(1) + "|" + fy.toFixed(1);
      try {
        if (marker.__posKey !== posKey) {
          marker.style.position = fx.toFixed(1) + "px " + fy.toFixed(1) + "px 0px";
          marker.__posKey = posKey;
        }
        if (marker.__vis !== 1) { marker.style.visibility = null; marker.__vis = 1; }
      } catch (e) {}
    },

    hideLive: function (entry) {
      if (!entry || !DMM.valid(entry.liveMarker)) return;
      try { entry.liveMarker.style.visibility = "collapse"; entry.liveMarker.__vis = 0; } catch (e) {}
    },

    del: function (marker) { DMM.remove(marker); },

    displayText: function (entry) { return entry && entry.trackerId ? String(entry.trackerId) : "?"; },

    startLinger: function (entry, reason, now) {
      if (!entry || !isFinite(entry.x) || !isFinite(entry.y)) return;
      Markers.hideLive(entry);
      entry.lingerUntilMs = (now || DMM.now()) + ST.persistenceMs;
      entry.lingerReason = reason || "lost";
      var marker = Markers.ensure(entry, "linger");
      if (DMM.valid(marker)) {
        try { marker.RemoveClass("lastspot-expiring"); } catch (e) {}
        Markers.position(marker, entry, 0);
        Markers.setContent(entry, marker, Markers.displayText(entry), "linger");
      }
    },

    clearLinger: function (entry) {
      if (!entry) return;
      entry.lingerUntilMs = 0; entry.lingerReason = "";
      Markers.del(entry.lingerMarker); entry.lingerMarker = null;
    },

    updateLinger: function (entry, now) {
      if (!entry || entry.lingerUntilMs <= 0) return;
      var marker = Markers.ensure(entry, "linger");
      if (!DMM.valid(marker)) return;
      var age = Math.max(0, (now || DMM.now()) - (entry.lastSeenMs || now));
      var start = DMM.clamp(ST.lingerStartOpacity, 0.02, 1.0);
      var end = DMM.clamp(ST.lingerEndOpacity, 0.02, 1.0);
      var opacity = start;
      if (age > ST.fadeHoldMs) {
        var span = Math.max(1000, ST.persistenceMs - ST.fadeHoldMs);
        opacity = start + (end - start) * DMM.clamp((age - ST.fadeHoldMs) / span, 0, 1);
      }
      opacity = DMM.clamp(opacity, 0.02, 1.0);
      try {
        marker.style.opacity = opacity.toFixed(2);
        if (entry.lingerUntilMs - now < 5000) marker.AddClass("lastspot-expiring");
        else marker.RemoveClass("lastspot-expiring");
      } catch (e) {}
      Markers.position(marker, entry, 0);
      Markers.setContent(entry, marker, Markers.displayText(entry), "linger");
    }
  };

  // ===========================================================================
  // Trackers — 6 stable IDs. Once an ID is written onto a panel it never moves.
  // ===========================================================================
  var Trackers = {
    readPanelId: function (panel) {
      if (!DMM.valid(panel)) return 0;
      try {
        var n = panel.GetAttributeInt ? panel.GetAttributeInt("__lastSpotTrackerId", 0) : 0;
        if (n >= 1 && n <= Cfg.MAX_SLOTS) return n;
      } catch (e) {}
      try {
        var v = panel.__lastSpotTrackerId;
        if (v >= 1 && v <= Cfg.MAX_SLOTS) return v;
      } catch (e) {}
      return 0;
    },
    writePanelId: function (panel, id) {
      if (!DMM.valid(panel)) return;
      try { if (panel.SetAttributeInt) panel.SetAttributeInt("__lastSpotTrackerId", id); } catch (e) {}
      try { panel.__lastSpotTrackerId = id; } catch (e) {}
    },
    clearPanelId: function (panel) {
      if (!DMM.valid(panel)) return;
      try { if (panel.SetAttributeInt) panel.SetAttributeInt("__lastSpotTrackerId", 0); } catch (e) {}
      try { panel.__lastSpotTrackerId = 0; } catch (e) {}
    },
    attachedElsewhere: function (slot, panel) {
      return !!(slot && slot.attachedPanel && slot.attachedPanel !== panel && DMM.valid(slot.attachedPanel));
    },
    attach: function (slot, panel) { if (slot) slot.attachedPanel = panel; },

    assign: function (panel, key, now, preferredId) {
      // 1) panel already carries an ID -> keep it, forever.
      var existing = Trackers.readPanelId(panel);
      if (existing) {
        var s0 = slotById(existing);
        if (s0) {
          if (key && !s0.key) s0.key = key;
          s0.lastSeenMs = now; s0.panelValid = true;
          Trackers.attach(s0, panel);
          return s0;
        }
      }
      // 2) preferred slot from candidate/lane order
      var pref = slotById(preferredId);
      if (pref && !Trackers.attachedElsewhere(pref, panel)) {
        pref.key = pref.key || key || ("enemy_panel_" + pref.id);
        pref.label = pref.customName || String(pref.id);
        pref.lastSeenMs = now; pref.panelValid = true; pref.dead = false;
        Trackers.attach(pref, panel);
        return pref;
      }
      // 3) slot already bound to this key
      var byKey = slotByKey(key);
      if (byKey && !Trackers.attachedElsewhere(byKey, panel)) {
        Trackers.attach(byKey, panel); byKey.lastSeenMs = now; byKey.panelValid = true;
        return byKey;
      }
      // 4) first empty slot
      var slot = null, i;
      for (i = 0; i < slots.length; i++) {
        if (!slots[i].key && !Trackers.attachedElsewhere(slots[i], panel)) { slot = slots[i]; break; }
      }
      // 5) stalest inactive slot
      if (!slot) {
        var bestAge = -1;
        for (i = 0; i < slots.length; i++) {
          var age = now - (slots[i].lastSeenMs || 0);
          if (!slots[i].active && !Trackers.attachedElsewhere(slots[i], panel) && age > bestAge) { bestAge = age; slot = slots[i]; }
        }
      }
      // 6) cyclic fallback (never steal a still-valid attachment)
      if (!slot) {
        for (i = 0; i < Cfg.MAX_SLOTS; i++) {
          var fid = ((ST.nextSlotId - 1) % Cfg.MAX_SLOTS) + 1;
          ST.nextSlotId++;
          var c = slotById(fid);
          if (c && !Trackers.attachedElsewhere(c, panel)) { slot = c; break; }
        }
      }
      if (slot) {
        slot.key = key || ("unknown_slot_" + slot.id);
        slot.label = slot.customName || String(slot.id);
        slot.lastSeenMs = now; slot.panelValid = true; slot.dead = false;
        Trackers.attach(slot, panel);
      }
      return slot;
    },

    updateFromEntry: function (entry, active) {
      if (!entry || !entry.trackerId) return;
      var slot = slotById(entry.trackerId);
      if (!slot) return;
      slot.key = entry.key || slot.key;
      slot.label = slot.customName || entry.manualLabel || String(slot.id);
      slot.lastSeenMs = entry.lastSeenMs || slot.lastSeenMs || DMM.now();
      slot.lastX = entry.x || slot.lastX || 0;
      slot.lastY = entry.y || slot.lastY || 0;
      slot.active = !!active;
      slot.panelValid = DMM.valid(entry.panel);
      if (active) slot.dead = false;
    },

    // ID lock: flips true once lane assist has produced a layout AND every active
    // slot has a hero assigned, so IDs stop shuffling post-solve.
    lockActive: function () { return ST.idsLocked; },
    lockSignature: function () {
      var parts = [];
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (s.key && s.lastSeenMs) parts.push(s.id + ":" + (DMM.canonicalHeroName(s.customName) || "-"));
      }
      return parts.join("|");
    },
    maybeLockPostSolve: function () {
      if (ST.idsLocked) return;
      var active = [], i;
      for (i = 0; i < slots.length; i++) if (slots[i].key && slots[i].lastSeenMs) active.push(slots[i]);
      if (!active.length) return;
      for (i = 0; i < active.length; i++) if (!DMM.canonicalHeroName(active[i].customName)) return;
      ST.idsLocked = true;
      ST.idsLockSig = Trackers.lockSignature();
      log.log("tracker_ids_locked " + ST.idsLockSig);
    },
    unlock: function (reason) {
      if (!ST.idsLocked && !ST.idsLockSig) return;
      ST.idsLocked = false; ST.idsLockSig = "";
      log.log("tracker_ids_unlocked reason=" + (reason || "?"));
    },
    heroForLock: function (panel, fallbackIdx) {
      // best-effort hero identity for a recreated panel (used only when locked)
      var hint = DMM.readAnyString(panel, ["hero_name", "heroName", "hero", "unit", "name"]);
      var hero = DMM.canonicalHeroName(hint) || DMM.findHeroMention(hint);
      return hero || "";
    },
    findAssignedSlotForHero: function (hero, used) {
      var canon = DMM.canonicalHeroName(hero);
      if (!canon) return 0;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (used[s.id]) continue;
        if (DMM.canonicalHeroName(s.customName) === canon) return s.id;
      }
      return 0;
    },

    clear: function () {
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        s.key = ""; s.label = String(s.id); s.customName = ""; s.choiceIndex = 0;
        s.lastSeenMs = 0; s.lastX = 0; s.lastY = 0; s.active = false; s.panelValid = false; s.dead = false;
        s.laneKey = ""; s.laneLabel = ""; s.laneCandidates = []; s.attachedPanel = null; s.manualOverride = false;
      }
      enemyState.forEach(function (entry) {
        if (!entry) return;
        entry.trackerId = 0; entry.manualLabel = "";
        Trackers.clearPanelId(entry.panel);
        Markers.del(entry.liveMarker); Markers.del(entry.lingerMarker);
      });
      enemyState.clear();
      ST.mapButtonCache = null; ST.mapButtonCacheTs = 0;
      ST.nextSlotId = 1; ST.selectedSlotId = 1; ST.showLive = true;
      LaneAssist.resetCache();
      Trackers.unlock("clear");
      SettingsUI.update();
      DMM.schedule(0.03, function () {
        ST.mapButtonCache = null; ST.mapButtonCacheTs = 0;
        Scanner.tick();
        LaneAssist.primeOnce("clear_repopulate");
        SettingsUI.update();
      });
      log.log("slots_cleared repopulate_scheduled", true);
    }
  };

  // ===========================================================================
  // LaneAssist — bucket tracked IDs into lanes by X, match topbar hero order
  // (left->middle->right) into those buckets, narrow choices & auto-fill by
  // deduction. Works independent of game mode (no Standard/Street-Brawl gates).
  // ===========================================================================
  var LaneAssist = {
    allowed: function () { return ST.laneAssistEnabled; },

    normalizeSplits: function () {
      var rm = Number(ST.laneSplitRM), ml = Number(ST.laneSplitML);
      if (!isFinite(rm)) rm = Cfg.DEF_LANE_SPLIT_RIGHT_MIDDLE;
      if (!isFinite(ml)) ml = Cfg.DEF_LANE_SPLIT_MIDDLE_LEFT;
      rm = DMM.clamp(Number(rm.toFixed(3)), 0.05, 0.90);
      ml = DMM.clamp(Number(ml.toFixed(3)), 0.10, 0.95);
      if (ml - rm < Cfg.LANE_SPLIT_MIN_GAP) {
        var mid = DMM.clamp((rm + ml) * 0.5, 0.10, 0.90);
        rm = DMM.clamp(Number((mid - Cfg.LANE_SPLIT_MIN_GAP * 0.5).toFixed(3)), 0.05, 0.90);
        ml = DMM.clamp(Number((mid + Cfg.LANE_SPLIT_MIN_GAP * 0.5).toFixed(3)), 0.10, 0.95);
      }
      ST.laneSplitRM = rm; ST.laneSplitML = ml;
    },

    // Natural convention: "left" = low display-space X, "right" = high. Field
    // names (laneSplitRM/laneSplitML) are unchanged from the original config,
    // just reinterpreted here — they're generic split points, not inherently
    // tied to a left/right label.
    ranges: function () {
      LaneAssist.normalizeSplits();
      return [
        { key: "left", label: "left", min: 0.00, max: ST.laneSplitRM },
        { key: "middle", label: "middle", min: ST.laneSplitRM, max: ST.laneSplitML },
        { key: "right", label: "right", min: ST.laneSplitML, max: 1.01 }
      ];
    },

    // BUG FIX (Hidden King IDs bucketed into the visually-opposite lane):
    // this buckets on raw (unmirrored) minimap-panel X, but the SAME raw X
    // displays on opposite screen sides depending on team — that's exactly
    // what ST.mirror/transformPoint already corrects for when drawing marker
    // overlays (mirror=true for ArchMother, false for Hidden King). laneForX
    // wasn't applying that same correction, so its "left"/"right" bucket
    // LABELS only matched the visual screen side for one team's orientation.
    // Applying the identical mirror flip here (before bucketing on the new
    // natural-left=low/right=high ranges above) makes bucket labels always
    // match what the player actually sees, for both teams. This is provably
    // a no-op for mirror=true (old bucket assignment was mathematically
    // identical under the old inverted-range convention) — only mirror=false
    // (Hidden King) changes, matching the reported symptom.
    // FIX HISTORY on this specific line (Hidden King lane bucketing), so the
    // next attempt doesn't repeat a tried-and-failed config:
    //   1. Original (pre-rewrite-session): nx=rawNx unconditionally (no
    //      mirror), inverted ranges (high nx=left). Broken for Hidden King
    //      (the original "Billy/Silver on the wrong ID" report).
    //   2. Attempt 2: nx = mirror?(1-rawNx):rawNx (conditional on ST.mirror),
    //      natural ranges (low nx=left). Mathematically a no-op for
    //      ArchMother vs attempt 1 (numeric coincidence: default split points
    //      0.333/0.667 are complements) — that's why ArchMother tested fine
    //      both before and after. For Hidden King (mirror=false) this made nx
    //      unflipped, which is DIFFERENT from attempt 1's formula and turned
    //      out to STILL be wrong (order fixed, but wrong IDs populated each
    //      lane — i.e. still a genuine bucketing error, not just a display
    //      one; the separate displayRank reversal added on top of this was
    //      the wrong kind of fix and is removed now).
    //   3. Attempt 3: ALWAYS flip (unconditional on team/mirror), natural
    //      ranges. Proved WRONG by real logged data (test-23): for Hidden
    //      King (mirror=false), true-yellow IDs sat at raw nx~0.16 (raw-left)
    //      and true-green IDs at raw nx~0.89 (raw-right) — always-flipping
    //      inverted that into exactly the wrong buckets.
    //   4. This attempt: reuse the EXACT mirror transform `transformPoint`
    //      already uses for marker rendering (`rx = mirror ? width-rawX :
    //      rawX`, confirmed correct — markers have never been reported in
    //      the wrong place): nx = mirror ? (1-rawNx) : rawNx. Verified
    //      against real Hidden King LANE_DIAG data (test-23): raw nx~0.16
    //      (ids 4,6, true yellow) stays low with no flip -> "left" bucket;
    //      raw nx~0.89 (ids 3,5, true green) stays high -> "right" bucket;
    //      heroes sliced left->middle->right from the fixed topbar order
    //      then match true hero-to-ID ownership exactly. For ArchMother
    //      (mirror=true) this is identical to the formula already confirmed
    //      working, so zero regression risk there.
    laneForX: function (x) {
      var mm = Panels.minimapSize();
      var width = DMM.safeExtent(mm.width, Cfg.REF_MINIMAP_W, 8192);
      var rawNx = width > 0 ? DMM.clamp(Number(x) / width, 0, 1) : 0;
      var nx = ST.mirror ? (1 - rawNx) : rawNx;
      var ranges = LaneAssist.ranges();
      for (var i = 0; i < ranges.length; i++) {
        if (nx >= ranges[i].min && nx < ranges[i].max) {
          return { index: i, key: ranges[i].key, label: ranges[i].label, nx: nx };
        }
      }
      var f = ranges[ranges.length - 1];
      return { index: ranges.length - 1, key: f.key, label: f.label, nx: nx };
    },

    // hero visual lane order: topbar is already left->middle->right
    canonList: function (values) {
      var out = [], seen = Object.create(null);
      for (var i = 0; i < (values || []).length; i++) {
        var hero = DMM.canonicalHeroName(values[i]);
        if (!hero) continue;
        var k = hero.toLowerCase();
        if (seen[k]) continue;
        seen[k] = true; out.push(hero);
      }
      return out;
    },
    // assignment rank: topbar order left(0) -> middle(1) -> right(2)
    laneRank: function (lane) {
      var l = String(lane.key || "");
      return l === "left" ? 0 : (l === "middle" ? 1 : (l === "right" ? 2 : 99));
    },

    // UI color tint (ls-lane-left/middle/right CSS = green/blue/yellow) was
    // authored against ArchMother's convention (Green->Blue->Yellow, so
    // spatial left=green, right=yellow). Hidden King reads the opposite
    // color order (Yellow->Blue->Green) despite using the SAME spatial
    // left/middle/right buckets for hero-matching — so for Hidden King only,
    // swap which CSS tint (left/right) a bucket key maps to; middle is blue
    // for both sides. Spatial bucket keys themselves (laneKey, laneRank,
    // hero-matching) are untouched — this only affects which color chip is
    // drawn for the same, already-correct, bucket.
    laneColorKey: function (key) {
      if (ST.teamKey === "hidden_king") {
        if (key === "left") return "right";
        if (key === "right") return "left";
      }
      return key;
    },

    slotLane: function (slot) {
      if (!slot || !slot.lastSeenMs) return null;
      if (ST.laneLayoutLocked && slot.laneKey) {
        var ranges = LaneAssist.ranges();
        for (var i = 0; i < ranges.length; i++) if (ranges[i].key === slot.laneKey) return ranges[i];
      }
      if (!isFinite(slot.lastX) || !isFinite(slot.lastY)) return null;
      var lane = LaneAssist.laneForX(slot.lastX);
      if (slot._laneDiagKey !== lane.key) {
        slot._laneDiagKey = lane.key;
        log.log("LANE_DIAG id=" + slot.id + " team=" + ST.teamKey + " mirror=" + ST.mirror +
          " lastX=" + slot.lastX + " nx=" + lane.nx.toFixed(3) + " key=" + lane.key, true);
      }
      return lane;
    },

    activeSlots: function () {
      var out = [];
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (!s.key || !s.lastSeenMs) continue;
        var lane = LaneAssist.slotLane(s);
        if (!lane) continue;
        out.push({ slot: s, lane: lane });
      }
      out.sort(function (a, b) { return a.slot.id - b.slot.id; });
      return out;
    },

    clearHints: function () {
      for (var i = 0; i < slots.length; i++) { slots[i].laneKey = ""; slots[i].laneLabel = ""; slots[i].laneCandidates = []; }
    },

    resetCache: function () {
      ST.laneLastSetupSig = ""; ST.laneLastSnapshot = null; ST.laneLayoutLocked = false;
    },

    // balanced-layout gate: 6-team requires 2/2/2; smaller sizes require all slots bucketed
    layoutReady: function (lanes, tracked, expected) {
      if (tracked !== expected) return false;
      if (expected === Cfg.MAX_SLOTS) {
        return lanes.length === 3 && lanes[0].ids.length === 2 && lanes[1].ids.length === 2 && lanes[2].ids.length === 2;
      }
      return expected >= 1 && expected <= 4;
    },

    setupSignature: function (requireAll) {
      if (!LaneAssist.allowed()) return "";
      var expected = expectedTeamSize();
      var ranges = LaneAssist.ranges();
      var buckets = Object.create(null), i;
      for (i = 0; i < ranges.length; i++) buckets[ranges[i].key] = [];
      var active = LaneAssist.activeSlots();
      for (i = 0; i < active.length; i++) {
        if (!buckets[active[i].lane.key]) continue;
        buckets[active[i].lane.key].push(active[i].slot.id);
      }
      if (requireAll) {
        if (active.length !== expected) return "";
        if (expected === Cfg.MAX_SLOTS) {
          for (i = 0; i < ranges.length; i++) if ((buckets[ranges[i].key] || []).length !== 2) return "";
        }
      }
      var parts = ["rm=" + ST.laneSplitRM.toFixed(3), "ml=" + ST.laneSplitML.toFixed(3), "exp=" + expected, "n=" + active.length];
      for (i = 0; i < ranges.length; i++) { buckets[ranges[i].key].sort(function (a, b) { return a - b; }); parts.push(ranges[i].key + "=" + buckets[ranges[i].key].join(".")); }
      return parts.join("|");
    },

    // build lane buckets + assign topbar hero names into them; returns snapshot
    buildSnapshot: function () {
      if (!LaneAssist.allowed()) { ST.laneSummary = "disabled"; LaneAssist.clearHints(); return null; }
      if (!Panels.refresh()) { ST.laneSummary = "no_hud"; return null; }

      var expected = expectedTeamSize();
      if (!(ST.enemyHeroNames && ST.enemyHeroNames.length >= expected)) {
        ST.laneSummary = "waiting_for_topbar_names";
        return null;
      }
      var heroes = LaneAssist.canonList(ST.enemyHeroNames.slice(0, expected));

      var ranges = LaneAssist.ranges(), lanes = [], byKey = Object.create(null), i;
      for (i = 0; i < ranges.length; i++) {
        var lane = { index: i, key: ranges[i].key, label: ranges[i].label, ids: [], heroes: [], complete: false };
        lanes.push(lane); byKey[lane.key] = lane;
      }
      LaneAssist.clearHints();

      var active = LaneAssist.activeSlots(), tracked = 0;
      for (i = 0; i < active.length; i++) {
        var it = active[i];
        if (!byKey[it.lane.key]) continue;
        byKey[it.lane.key].ids.push(it.slot.id);
        it.slot.laneKey = it.lane.key; it.slot.laneLabel = it.lane.label;
        tracked++;
      }
      for (i = 0; i < lanes.length; i++) lanes[i].ids.sort(function (a, b) { return a - b; });

      if (!LaneAssist.layoutReady(lanes, tracked, expected)) {
        ST.laneSummary = expected === Cfg.MAX_SLOTS ? "waiting_for_balanced_pairs" : "waiting_for_team_size_" + expected;
        LaneAssist.clearHints();
        return null;
      }

      // assign heroes in topbar order (left->middle->right) to lane buckets
      lanes.sort(function (a, b) { var ar = LaneAssist.laneRank(a), br = LaneAssist.laneRank(b); return ar !== br ? ar - br : a.index - b.index; });
      var cursor = 0;
      for (i = 0; i < lanes.length; i++) {
        var L = lanes[i];
        L.heroes = heroes.slice(cursor, cursor + L.ids.length);
        L.complete = L.ids.length > 0 && L.heroes.length === L.ids.length;
        cursor += L.ids.length;
        for (var j = 0; j < L.ids.length; j++) { var slot = slotById(L.ids[j]); if (slot) slot.laneCandidates = L.heroes.slice(0); }
      }

      var partialReady = tracked === expected && heroes.length > 0;
      ST.laneSummary = "ids=" + tracked + "/" + expected + " heroes=" + heroes.length + "/" + expected;
      return { partialReady: partialReady, tracked: tracked, heroes: heroes, lanes: lanes };
    },

    // deduction: a lane with N slots and N candidate heroes where N-1 are already
    // assigned -> auto-assign the last one. Iterate to cascade.
    applySnapshot: function (snapshot) {
      if (!snapshot || !snapshot.partialReady) return 0;
      var changed = 0, passes = 0, again = true;
      while (again && passes < 4) {
        again = false; passes++;
        for (var li = 0; li < snapshot.lanes.length; li++) {
          var lane = snapshot.lanes[li];
          if (!lane.ids.length || lane.heroes.length !== lane.ids.length) continue;
          var remaining = lane.heroes.slice(0), unassigned = [];
          for (var i = 0; i < lane.ids.length; i++) {
            var slot = slotById(lane.ids[i]); if (!slot) continue;
            var assigned = DMM.canonicalHeroName(slot.customName);
            if (assigned) {
              var idx = remaining.map(function (h) { return h.toLowerCase(); }).indexOf(assigned.toLowerCase());
              if (idx >= 0) remaining.splice(idx, 1);
            } else unassigned.push(slot);
          }
          if (unassigned.length === 1 && remaining.length === 1) {
            unassigned[0].customName = remaining[0];
            unassigned[0].label = remaining[0]; unassigned[0].choiceIndex = 0;
            changed++; again = true;
          }
        }
      }
      if (changed) {
        Runtime.maybeDisableLiveAfterAssignments();
        Trackers.maybeLockPostSolve();
        SettingsUI.update();
      }
      return changed;
    },

    // Called right after a manual pick (Cmd.setSlotHero). If `changedSlot`'s
    // new hero is already held by a sibling slot in the SAME lane (the user
    // reselecting one ID to a hero that belongs to another ID in that lane),
    // clear the sibling and re-run elimination for that lane: if exactly one
    // candidate hero remains unclaimed, it's the only hero that can possibly
    // go to the now-unassigned sibling, so auto-assign it (a swap). With 3+
    // slots in a lane and genuine ambiguity left, the sibling is simply
    // cleared for the user to reassign rather than guessed.
    resolveConflict: function (changedSlot) {
      if (!changedSlot || !changedSlot.laneKey) return;
      var canon = DMM.canonicalHeroName(changedSlot.customName);
      // If this pick collides with a sibling in the same lane (reselecting
      // one ID to a hero another ID in that lane already has), clear the
      // sibling first so the elimination pass below can reconsider it.
      if (canon) {
        for (var i = 0; i < slots.length; i++) {
          var s = slots[i];
          if (s !== changedSlot && s.laneKey === changedSlot.laneKey && DMM.canonicalHeroName(s.customName) === canon) {
            s.customName = ""; s.label = String(s.id); s.choiceIndex = 0;
            break;
          }
        }
      }
      LaneAssist.eliminateLane(changedSlot.laneKey);
    },

    // Given a lane key, if exactly one slot in that lane is unassigned and
    // exactly one candidate hero remains unclaimed from the lane's candidate
    // pool, auto-assign it. Works from the FIRST pick in the lane onward —
    // not just after N-1 of N are already filled by something else — since it
    // only depends on the current assigned/unassigned split, not history.
    eliminateLane: function (laneKey) {
      if (!laneKey) return;
      var laneSlots = [];
      for (var i = 0; i < slots.length; i++) if (slots[i].laneKey === laneKey) laneSlots.push(slots[i]);
      if (!laneSlots.length) return;
      var pool = null;
      for (var j = 0; j < laneSlots.length; j++) {
        if (laneSlots[j].laneCandidates && laneSlots[j].laneCandidates.length) { pool = laneSlots[j].laneCandidates.slice(0); break; }
      }
      if (!pool) return;
      var unassigned = [];
      for (var k = 0; k < laneSlots.length; k++) {
        var a = DMM.canonicalHeroName(laneSlots[k].customName);
        if (a) {
          var idx = pool.map(function (h) { return h.toLowerCase(); }).indexOf(a.toLowerCase());
          if (idx >= 0) pool.splice(idx, 1);
        } else {
          unassigned.push(laneSlots[k]);
        }
      }
      if (unassigned.length === 1 && pool.length === 1) {
        unassigned[0].customName = pool[0];
        unassigned[0].label = pool[0];
      }
    },

    primeOnce: function (reason) {
      if (!LaneAssist.allowed() || ST.laneBusy) return null;
      var sig = LaneAssist.setupSignature(true);
      if (!sig) return null;
      if (ST.laneLastSnapshot && ST.laneLastSetupSig === sig) return ST.laneLastSnapshot;
      ST.laneBusy = true;
      try {
        var snap = LaneAssist.buildSnapshot();
        if (snap) {
          if (!snap.partialReady) { ST.laneSummary += " waiting_for_topbar_names"; return snap; }
          ST.laneLastSetupSig = sig; ST.laneLastSnapshot = snap;
          ST.laneLayoutLocked = true;
          log.log("LANE_DIAG LOCKED team=" + ST.teamKey + " mirror=" + ST.mirror +
            " topbarHalf=" + teamCfg().topbarHalf +
            " enemyHeroNames=" + ST.enemyHeroNames.join("|"), true);
          for (var li = 0; li < snap.lanes.length; li++) {
            var L = snap.lanes[li];
            log.log("LANE_DIAG lane=" + L.key + " ids=[" + L.ids.join(",") + "] heroes=[" + L.heroes.join("|") + "]", true);
          }
          LaneAssist.applySnapshot(snap);
          Trackers.maybeLockPostSolve();
        }
        return snap;
      } catch (e) {
        ST.laneSummary = "error"; log.log("lane_error reason=" + (reason || "prime") + " " + e, true);
      } finally { ST.laneBusy = false; }
      return null;
    },

    autoTick: function () {
      if (!LaneAssist.allowed()) return;
      LaneAssist.primeOnce("auto");
    }
  };

  // ===========================================================================
  // TopBar — discover enemy hero names (left->right) from the HUD topbar.
  // Focused reimplementation of the original probe's proven signals:
  //   * hero identity comes from a panel's portrait image path (contains the
  //     hero codename), or a hero-name attribute hint;
  //   * team comes from the ancestry path (TeamEnemy / TeamFriendly);
  //   * enemy names are the topbar roster half for the local team.
  // Only a COMPLETE enemy set (>= expected size) is stored, so lane assist never
  // acts on a half-populated pre-game roster.
  // ===========================================================================
  var TopBar = {
    NAME_ATTRS: ["hero_name", "heroName", "heroname", "hero", "unit", "unit_name", "unitName",
      "npc_name", "npcName", "player_name", "playerName", "name", "localizedName", "localized_name",
      "selectedHero", "selected_hero", "heroToken", "hero_token", "m_HeroName", "m_strHeroName", "tooltip"],
    // Real minimap/topbar portrait paths are bare codenames (e.g. "archer_mm_vtex.psd")
    // with no literal "hero" substring — do not filter candidates on that. Widened to
    // match the original's lastSpotReadHeroValueFromPanelWide field list.
    IMG_ATTRS: ["src", "image", "texture", "source", "defaultsrc", "defaultSrc", "backgroundImage",
      "heroImage", "hero_image", "heroIcon", "hero_icon", "portrait", "portraitImage", "portrait_image",
      "heroname", "heroName", "hero_name", "unit", "unit_name"],
    // Port of lastSpotReadHeroValueFromPanelWide's field list — used ONLY by the
    // deep/heavy scan (heroFromImageTree), never the fast path, which stays
    // narrow/cheap on purpose (matches original: fast path = direct scrape,
    // deep path = wide value walk). Adds fields the fast-path lists don't have:
    // hero_id-style numeric-id names, and — critically — "text"/"label"/
    // "dialogVariable", which a generic Label-type panel would expose a hero
    // codename through even though it's not an image at all.
    WIDE_ATTRS: ["hero_name", "heroName", "heroname", "hero", "hero_id", "heroID", "heroid", "heroId",
      "hero_unit", "heroUnit", "unit", "unit_name", "unitName", "npc_name", "npcName", "selectedHero",
      "selected_hero", "selectedHeroName", "selected_hero_name", "heroToken", "hero_token", "heroImage",
      "hero_image", "heroIcon", "hero_icon", "portrait", "portraitImage", "portrait_image",
      "m_HeroName", "m_strHeroName", "m_heroName", "m_nHeroID", "m_nHeroId", "m_unHeroID",
      "image", "src", "texture", "source", "defaultsrc", "defaultSrc", "backgroundImage", "tooltip",
      "dialogVariable", "text", "label", "localizedText", "localized_text"],

    readDialogVariable: function (panel, name) {
      if (!DMM.valid(panel) || !name) return "";
      try { if (typeof panel.GetDialogVariable === "function") { var v = panel.GetDialogVariable(name); if (v !== undefined && v !== null && String(v)) return String(v); } } catch (e) {}
      try { if (typeof panel.GetDialogVariableInt === "function") { var vi = panel.GetDialogVariableInt(name); if (vi !== undefined && vi !== null && String(vi)) return String(vi); } } catch (e) {}
      return "";
    },

    // hero codename from a portrait image path, canonicalized to a hero name.
    // Real paths are usually bare codenames ("archer_mm_vtex.psd") with no
    // "heroes/"/"hero_" wrapper, so the structured patterns are tried first
    // (they're more precise) but findHeroMention against the whole raw string
    // is the real workhorse — it substring-matches every known codename
    // (archer, haze, digger, spectre, ...) directly, no "hero" marker needed.
    heroFromImg: function (src) {
      var raw = String(src || "");
      if (!raw) return "";
      var patterns = [/heroes[\/\}_]+([^\/\}.?#]+)/i, /hero[_\-]([^\/\}.?#]+)/i, /(npc_[a-z0-9_]*hero_[a-z0-9_]+)/i];
      for (var i = 0; i < patterns.length; i++) {
        var m = raw.match(patterns[i]);
        if (m && m[1]) {
          var code = String(m[1]).replace(/^npc_.*?hero_/i, "").replace(/[^a-z0-9_\-]/gi, "").toLowerCase();
          var hero = DMM.canonicalHeroName(code) || DMM.findHeroMention(code);
          if (hero) return hero;
        }
      }
      return DMM.findHeroMention(raw);
    },

    // Bounded BFS over a panel's subtree collecting every IMG_ATTRS/NAME_ATTRS
    // string and resolving each through heroFromImg/findHeroMention as it goes
    // — no "must contain the word hero" gate (real codenames don't), and no
    // longer capped at 2 child levels. Still bounded (depth/node caps) so it's
    // safe to run off the 400ms scan loop, just not ON it.
    heroFromImageTree: function (panel, maxDepth, maxNodes) {
      if (!DMM.valid(panel)) return "";
      var maxD = maxDepth === undefined ? 4 : maxDepth;
      var maxN = maxNodes || 60;
      var queue = [{ p: panel, d: 0 }], scanned = 0;
      while (queue.length && scanned < maxN) {
        var node = queue.shift(), p = node.p;
        if (!DMM.valid(p)) continue;
        scanned++;
        var hero = TopBar.heroFromWideScan(p);
        if (hero) return hero;
        if (node.d >= maxD) continue;
        var n = DMM.childCount(p);
        for (var c = 0; c < n && c < 16; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
      }
      return "";
    },

    // Port of lastSpotReadHeroValueFromPanelWide + lastSpotFindHeroValueDeep's
    // per-node check: WIDE_ATTRS (incl. text/label/dialogVariable — a plain
    // Label panel can expose a hero codename as its .text with no image
    // involved at all, which the narrower fast-path lists never check) plus
    // dialog variables plus panel.Data(). This is the actual gap that made the
    // deep scan come back empty while the original's deep scan found "Rem" —
    // not a downstream propagation bug; heroFromImageTree simply wasn't
    // checking these fields yet.
    heroFromWideScan: function (p) {
      if (!DMM.valid(p)) return "";
      var raw = DMM.readAnyString(p, TopBar.WIDE_ATTRS);
      var hero = raw ? (TopBar.heroFromImg(raw) || DMM.canonicalHeroName(raw) || DMM.findHeroMention(raw)) : "";
      if (hero) return hero;
      for (var i = 0; i < TopBar.WIDE_ATTRS.length; i++) {
        var dv = TopBar.readDialogVariable(p, TopBar.WIDE_ATTRS[i]);
        if (dv) {
          hero = TopBar.heroFromImg(dv) || DMM.canonicalHeroName(dv) || DMM.findHeroMention(dv);
          if (hero) return hero;
        }
      }
      try {
        if (typeof p.Data === "function") {
          var d = p.Data();
          if (d) {
            for (var k in d) {
              var v = d[k];
              if (v === undefined || v === null) continue;
              var s = String(v);
              if (!s) continue;
              hero = TopBar.heroFromImg(s) || DMM.canonicalHeroName(s) || DMM.findHeroMention(s);
              if (hero) return hero;
            }
          }
        }
      } catch (e) {}
      return "";
    },

    // player_id from a CitadelHudTopBarPlayer panel (attrs or "TopBarPlayerN" id).
    readPlayerId: function (panel) {
      if (!DMM.valid(panel)) return -1;
      var names = ["player_id", "playerID", "playerid", "player", "player_slot", "playerSlot",
        "player_index", "playerIndex", "account_id", "accountid", "steamid", "entindex",
        "index", "slot", "slot_id", "slotID"];
      for (var i = 0; i < names.length; i++) {
        // BUG (fixed): DMM.readString returns "" when nothing is found, and
        // Number("") is 0, not NaN — isFinite(0) passes, so an empty read on
        // the FIRST attr name was silently reported as pid=0 for every panel
        // instead of falling through to the id-regex fallback below. Require a
        // genuinely non-empty string before treating it as a candidate pid.
        var raw = DMM.readString(panel, names[i]);
        if (!raw) continue;
        var n = Number(raw);
        if (isFinite(n) && n >= 0 && n < 128) return n | 0;
      }
      // Missing in the first port: PlayerIntentsPlayer* and the generic
      // Player(Name|Container|Slot)?N fallback the original also tries.
      try {
        var idStr = String(DMM.id(panel) || "");
        var patterns = [/TopBarPlayer(\d+)/i, /PlayerIntentsPlayer(\d+)/i, /Player(?:Name|Container|Slot)?(\d+)/i];
        for (var p = 0; p < patterns.length; p++) {
          var m = idStr.match(patterns[p]);
          if (m && m[1]) { var num = Number(m[1]); if (isFinite(num) && num >= 0 && num < 128) return num | 0; }
        }
      } catch (e) {}
      return -1;
    },

    // Heavy fallback ported from the original mod (lastSpotTryHeroNameFromTopBarLocalContext):
    // runs injected script INSIDE the topbar panel's own script context via
    // RunScriptInPanelContext, not our top-level LastSpot script scope. That
    // panel's layout file may bind globals (Players/Entities) differently than
    // ours does — our top-level probe found them missing, but that only proves
    // they're missing HERE, not everywhere. Also reads panel.Data(), a
    // data-binding channel plain property/attr reads never touch. Result is
    // cached onto the panel via an attribute so repeat calls are free.
    heroFromLocalContext: function (panel) {
      if (!DMM.valid(panel)) return "";
      var attrName = "__lastSpotLocalProbe";
      function parse(raw) {
        if (!raw) return "";
        return DMM.canonicalHeroName(raw) || DMM.findHeroMention(raw) || TopBar.heroFromImg(raw);
      }
      var cached = "";
      try { cached = panel.GetAttributeString ? panel.GetAttributeString(attrName, "") : ""; } catch (e) {}
      var hero = parse(cached);
      if (hero) return hero;

      var pid = TopBar.readPlayerId(panel);
      var script = "(function(){" +
        "var out=[];" +
        "function add(k,v){try{if(v!==undefined&&v!==null&&String(v)!=='')out.push(k+'='+String(v));}catch(e){}}" +
        "function pval(p,tag){if(!p)return;try{add(tag+'.id',p.id);}catch(e){}try{add(tag+'.text',p.text);}catch(e){}" +
        "var ns=['src','image','texture','source','defaultsrc','defaultSrc','backgroundImage','heroname','heroName','hero_name','hero','unit','unit_name','npc_name','localizedName','tooltip'];" +
        "for(var i=0;i<ns.length;i++){try{add(tag+'.'+ns[i],p[ns[i]]);}catch(e){}try{if(p.GetAttributeString)add(tag+'.attr_'+ns[i],p.GetAttributeString(ns[i],''));}catch(e){}}" +
        "try{if(p.style){add(tag+'.style_bg',p.style.backgroundImage);}}catch(e){}" +
        "try{if(p.Data){var d=p.Data(); if(d){for(var dk in d){add(tag+'.data_'+dk,d[dk]);}}}}catch(e){}" +
        "}" +
        "function walk(p,d,tag){if(!p||d>5||out.length>260)return;pval(p,tag);var n=0;try{n=p.GetChildCount?p.GetChildCount():0;}catch(e){}for(var c=0;c<n&&c<48;c++){try{walk(p.GetChild(c),d+1,tag+'/'+c);}catch(e){}}}" +
        "var panel=$.GetContextPanel();" +
        "pval(panel,'self');" +
        "var ids=['PlayerDetailsContainer','HeroContents','HeroImage','HeroPortrait','HeroPortraitImage','Portrait','MainImage','PlayerImage','MinimapHeroImage','HeroIcon'];" +
        "for(var x=0;x<ids.length;x++){try{var q=panel.FindChildTraverse(ids[x]); if(q){walk(q,0,ids[x]);}}catch(e){}}" +
        "try{walk(panel,0,'card');}catch(e){}" +
        "var pid=" + String(pid) + "; var ids2=[pid,pid-1,pid+1,pid-6,pid+6,pid%12,(pid+11)%12];" +
        "try{if(typeof Players!=='undefined'){var f=['GetPlayerSelectedHero','GetPlayerSelectedHeroName','GetPlayerHero','GetPlayerHeroName','GetSelectedHero','GetHeroName','GetPlayerUnitName','GetPlayerHeroUnitName','GetPlayerSelectedHeroID','GetPlayerHeroID','GetHeroId','GetHeroID','GetPlayerHeroEntityIndex'];" +
        "for(var a=0;a<ids2.length;a++){var pi=ids2[a]; if(pi<0)continue; for(var fi=0;fi<f.length;fi++){try{if(typeof Players[f[fi]]==='function')add('Players.'+f[fi]+'('+pi+')',Players[f[fi]](pi));}catch(e){}}}}}catch(e){}" +
        "try{if(typeof Entities!=='undefined'&&typeof Players!=='undefined'&&typeof Players.GetPlayerHeroEntityIndex==='function'){for(var b=0;b<ids2.length;b++){try{var ent=Players.GetPlayerHeroEntityIndex(ids2[b]); add('heroEnt('+ids2[b]+')',ent); if(ent&&ent!==-1){if(Entities.GetUnitName)add('Entities.GetUnitName('+ent+')',Entities.GetUnitName(ent)); if(Entities.GetClassname)add('Entities.GetClassname('+ent+')',Entities.GetClassname(ent));}}catch(e){}}}}catch(e){}" +
        "try{panel.SetAttributeString('" + attrName + "',out.join(' || ').slice(0,3900));}catch(e){}" +
        "})()";

      try {
        if (typeof panel.RunScriptInPanelContext === "function") panel.RunScriptInPanelContext(script);
      } catch (e) {}
      try {
        var raw = panel.GetAttributeString ? panel.GetAttributeString(attrName, "") : "";
        return parse(raw);
      } catch (e) {}
      return "";
    },

    heroForPanel: function (panel) {
      var hero = TopBar.heroFromImageTree(panel, 4, 60);
      if (hero) return hero;
      return TopBar.heroFromLocalContext(panel);
    },

    roots: function () {
      var out = [], root = ST.root, i;
      if (!DMM.valid(root)) return out;
      function add(p) { if (DMM.valid(p) && out.indexOf(p) === -1) out.push(p); }
      for (i = 0; i < TOPBAR_ROOT_IDS.length; i++) add(DMM.find(root, TOPBAR_ROOT_IDS[i]));
      return out;
    },

    // ===== V1 call-chain port (lastSpotWarmTopBarHeroCacheNow / GetTopBarHeroOrderDetailed /
    // SetEnemyHeroNameChoices / RunDeferredTopBarHeroNameProbe / ExtractTopBarHeroInfo) =====
    // Replaces the old boolean-prefilter collect()/selectEnemyNames() with V1's actual
    // algorithm: a SCORED wide candidate scan (not a narrow id-substring filter) +
    // ancestry-path-based team classification + tiered topbarHalf selection with
    // fallbacks + a one-candidate-per-frame deferred heavy pass. Game-mode gating
    // (lastSpotIsHideout/lastSpotLaneAssistAllowedForCurrentMode) and the short-TTL
    // order cache are intentionally dropped — ST.namesCached already caches at a
    // higher level, and per-project-goal no game-mode-specific conditionals.

    // full ancestor chain as "id:type/id:type/..." — used for team classification
    // (path contains "teamenemy"/"teamfriendly") and tooltip filtering.
    ancestryPath: function (panel, maxDepth) {
      var parts = [], cur = panel, max = maxDepth || 9;
      try {
        for (var i = 0; i < max && DMM.valid(cur); i++) {
          parts.push((DMM.id(cur) || "<no-id>") + ":" + DMM.type(cur));
          cur = cur.GetParent ? cur.GetParent() : null;
        }
      } catch (e) {}
      return parts.reverse().join("/");
    },

    teamKeyFromPath: function (path) {
      var p = String(path || "").toLowerCase();
      if (p.indexOf("teamenemy") >= 0) return "enemy";
      if (p.indexOf("teamfriendly") >= 0) return "friendly";
      if (p.indexOf("enemy") >= 0 && p.indexOf("topbar") >= 0) return "enemy";
      if (p.indexOf("friendly") >= 0 && p.indexOf("topbar") >= 0) return "friendly";
      return "unknown";
    },

    looksTooltipish: function (panel) {
      var path = String(TopBar.ancestryPath(panel, 10)).toLowerCase();
      return path.indexOf("tooltip") >= 0 || path.indexOf("herocard") >= 0 || path.indexOf("rosterselect") >= 0;
    },

    // cheap: panel itself + 1 child level, no gate on the value. Used both for
    // scoring (presence-only signal) and as a fast-path hero source.
    portraitSrcShallow: function (panel) {
      if (!DMM.valid(panel)) return "";
      var self = DMM.readAnyString(panel, TopBar.IMG_ATTRS);
      if (self) return self;
      var n = DMM.childCount(panel);
      for (var i = 0; i < n && i < 12; i++) {
        var s = DMM.readAnyString(DMM.childAt(panel, i), TopBar.IMG_ATTRS);
        if (s) return s;
      }
      return "";
    },

    looksLikeTopBarPlayerPanel: function (panel) {
      var idl = String(DMM.id(panel) || "").toLowerCase();
      var tyl = String(DMM.type(panel) || "").toLowerCase();
      return idl.indexOf("topbarplayer") >= 0 || tyl.indexOf("citadelhudtopbarplayer") >= 0 ||
        idl.indexOf("playerintentsplayer") >= 0 || tyl.indexOf("citadelhudplayerintentsplayer") >= 0;
    },

    // Port of lastSpotTopBarHeroProbeScore: multi-signal score instead of a
    // boolean prefilter, so panels our old id-substring check missed still get
    // picked up if enough weaker signals line up (>=6 threshold below).
    probeScore: function (panel, rootY) {
      if (!DMM.valid(panel)) return 0;
      var score = 0;
      var idl = String(DMM.id(panel) || "").toLowerCase();
      var tyl = String(DMM.type(panel) || "").toLowerCase();
      var portrait = TopBar.portraitSrcShallow(panel);
      var hint = DMM.readAnyString(panel, TopBar.NAME_ATTRS);
      var name = (portrait && TopBar.heroFromImg(portrait)) || DMM.canonicalHeroName(hint) || DMM.findHeroMention(hint);
      if (TopBar.looksLikeTopBarPlayerPanel(panel)) score += 8;
      if (portrait) score += 4;
      if (name) score += 5;
      if (idl.indexOf("hero") >= 0 || tyl.indexOf("hero") >= 0) score += 2;
      if (idl.indexOf("player") >= 0 || tyl.indexOf("player") >= 0) score += 1;
      if (idl.indexOf("slot") >= 0 || idl.indexOf("card") >= 0 || idl.indexOf("portrait") >= 0) score += 1;
      var x = DMM.safeNumber(panel.actualxoffset), y = DMM.safeNumber(panel.actualyoffset);
      var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 4096);
      var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 4096);
      if (x !== null && y !== null && w >= 12 && h >= 12 && w <= 260 && h <= 260) score += 2;
      if (y !== null && rootY !== null && Math.abs(y - rootY) <= 260) score += 1;
      return score;
    },

    // Fast path (portrait/name-hint scrape) + optional heavy path (RunScriptInPanelContext
    // local-context + deep value-tree scan). Port of lastSpotExtractTopBarHeroInfo,
    // minus the dead player-API branch (confirmed unavailable this session).
    extractHeroInfo: function (panel, heavyProbe) {
      if (!DMM.valid(panel)) return { hero: "", source: "invalid", playerId: -1 };
      var playerId = TopBar.readPlayerId(panel);
      var direct = TopBar.portraitSrcShallow(panel) || DMM.readAnyString(panel, TopBar.NAME_ATTRS);
      var directHero = (direct && TopBar.heroFromImg(direct)) || DMM.canonicalHeroName(direct) || DMM.findHeroMention(direct);
      if (directHero) return { hero: directHero, source: "direct_fast", playerId: playerId };
      if (!heavyProbe) return { hero: "", source: "fast_empty", playerId: playerId };
      var local = TopBar.heroFromLocalContext(panel);
      if (local) return { hero: local, source: "local_context", playerId: playerId };
      var deep = TopBar.heroFromImageTree(panel, 5, 96);
      if (deep) return { hero: deep, source: "panel_deep", playerId: playerId };
      return { hero: "", source: "heavy_empty", playerId: playerId };
    },

    // Same fast path, but the heavy fallback is a deep VALUE scan only — no
    // RunScriptInPanelContext. Called once per candidate per frame from
    // runDeferredProbe; repeating RunScriptInPanelContext across many candidates
    // synchronously was V1's actual documented cause of multi-second hitches.
    extractHeroInfoDeferred: function (panel) {
      if (!DMM.valid(panel)) return { hero: "", source: "invalid", playerId: -1 };
      var playerId = TopBar.readPlayerId(panel);
      var direct = TopBar.portraitSrcShallow(panel) || DMM.readAnyString(panel, TopBar.NAME_ATTRS);
      var directHero = (direct && TopBar.heroFromImg(direct)) || DMM.canonicalHeroName(direct) || DMM.findHeroMention(direct);
      if (directHero) return { hero: directHero, source: "deferred_direct", playerId: playerId };
      var deep = TopBar.heroFromImageTree(panel, 5, 72);
      if (deep) return { hero: deep, source: "deferred_deep", playerId: playerId };
      return { hero: "", source: "deferred_empty", playerId: playerId };
    },

    // Port of lastSpotMakeTopBarProbeItem: one candidate's full record (position,
    // ancestry path, inferred team, resolved hero if any).
    makeProbeItem: function (panel, rootIndex, depth, ordinal, heavyProbe) {
      var portrait = TopBar.portraitSrcShallow(panel);
      var hint = DMM.readAnyString(panel, TopBar.NAME_ATTRS);
      var info = TopBar.extractHeroInfo(panel, !!heavyProbe);
      var canonical = DMM.canonicalHeroName(info.hero) || (portrait && TopBar.heroFromImg(portrait)) ||
        DMM.canonicalHeroName(hint) || DMM.findHeroMention(hint);
      var x = DMM.safeNumber(panel.actualxoffset), y = DMM.safeNumber(panel.actualyoffset);
      var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 0, 4096);
      var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 0, 4096);
      var path = TopBar.ancestryPath(panel, 9);
      return {
        rootIndex: rootIndex, depth: depth, ordinal: ordinal, panel: panel,
        canonical: canonical || "", heroSource: info.source || "", playerId: info.playerId,
        id: DMM.id(panel), type: DMM.type(panel),
        x: x === null ? -999999 : x, y: y === null ? -999999 : y, w: w, h: h,
        // raw strings the hero was inferred from — kept so the diag dump can
        // trace a wrong hero back to the exact panel/image path that produced it
        portrait: portrait || "", hint: hint || "",
        path: path, teamKey: TopBar.teamKeyFromPath(path)
      };
    },

    // Port of lastSpotFindTopBarProbeRoots: known ids first, then (aggressive
    // mode only) a bounded BFS for anything topbar/roster-smelling.
    findProbeRoots: function (aggressive) {
      var roots = [], root = ST.root;
      if (!DMM.valid(root)) return roots;
      function add(p) { if (DMM.valid(p) && !TopBar.looksTooltipish(p) && roots.indexOf(p) === -1) roots.push(p); }
      for (var i = 0; i < TOPBAR_ROOT_IDS.length; i++) { try { add(DMM.find(root, TOPBAR_ROOT_IDS[i])); } catch (e) {} }
      if (aggressive !== false) {
        var queue = [{ p: root, d: 0 }], scanned = 0;
        while (queue.length && scanned < 1800 && roots.length < 18) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > 7) continue;
          scanned++;
          var idl = String(DMM.id(p) || "").toLowerCase();
          var tyl = String(DMM.type(p) || "").toLowerCase();
          var looksTop = idl.indexOf("topbar") >= 0 || idl.indexOf("top_bar") >= 0 || idl.indexOf("roster") >= 0 || tyl.indexOf("citadelhudtopbar") >= 0;
          if (looksTop) add(p);
          var n = DMM.childCount(p);
          for (var c = 0; c < n && c < 90; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
        }
      }
      return roots;
    },

    // Port of lastSpotFindTopBarTeamRoots: TeamFriendly/TeamEnemy specifically,
    // with an aggressive BFS fallback in case FindChildTraverse resolves to a
    // shadowing PlayerIntents copy that doesn't carry hero data.
    findTeamRoots: function (aggressive) {
      var roots = [], root = ST.root;
      if (!DMM.valid(root)) return roots;
      function add(p) { if (DMM.valid(p) && !TopBar.looksTooltipish(p) && roots.indexOf(p) === -1) roots.push(p); }
      try { add(DMM.find(root, "TeamFriendly")); } catch (e) {}
      try { add(DMM.find(root, "TeamEnemy")); } catch (e) {}
      if (aggressive !== false) {
        var queue = [{ p: root, d: 0 }], scanned = 0;
        while (queue.length && scanned < 2400 && roots.length < 48) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > 8) continue;
          scanned++;
          var idl = String(DMM.id(p) || "").toLowerCase();
          var tyl = String(DMM.type(p) || "").toLowerCase();
          var isTeamRoot = idl === "teamfriendly" || idl === "teamenemy" ||
            tyl.indexOf("citadelhudtopbarteam") >= 0 || tyl.indexOf("citadelhudplayerintentsteam") >= 0;
          if (isTeamRoot) add(p);
          var n = DMM.childCount(p);
          for (var c = 0; c < n && c < 90; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
        }
      }
      return roots;
    },

    // Port of lastSpotCollectTopBarPlayerProbeItems: every TopBarPlayer*/
    // PlayerIntentsPlayer* panel, forced score=10 regardless of probeScore.
    // Direct whole-HUD sweep for every TopBarPlayer*/PlayerIntentsPlayer* panel,
    // regardless of which root finds it. findProbeRoots' TeamFriendly/TeamEnemy
    // entries resolve via native FindChildTraverse, which returns only the
    // FIRST match — and there are TWO panels named "TeamFriendly"/"TeamEnemy"
    // in a live match (the real topbar tree AND a data-less PlayerIntents
    // shadow copy). When the shadow copy resolves first, the real topbar
    // subtree (and the other team's panels) never gets scanned at all — a
    // coverage gap, not a scoring/classification bug (confirmed: one team's
    // TopBarPlayer1-6 resolve real heroes every time, the other team never
    // even appears as a candidate). This sweep is independent of root
    // resolution, so it can't be shadowed the same way. Rare/bounded (probe
    // fires at most 3x per match), so a generous budget is fine here.
    sweepAllTopBarPlayers: function (maxNodes) {
      var out = [], root = ST.root;
      if (!DMM.valid(root)) return out;
      var queue = [{ p: root, d: 0 }], scanned = 0, max = maxNodes || 4000;
      while (queue.length && scanned < max) {
        var node = queue.shift(), p = node.p;
        if (!DMM.valid(p) || node.d > 14) continue;
        scanned++;
        if (TopBar.looksLikeTopBarPlayerPanel(p)) out.push(p);
        var n = DMM.childCount(p);
        for (var c = 0; c < n && c < 90; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
      }
      return out;
    },

    collectPlayerProbeItems: function (heavyProbe) {
      var out = [], seen = [];
      var roots = TopBar.findProbeRoots(!!heavyProbe);
      for (var r = 0; r < roots.length; r++) {
        var queue = [{ p: roots[r], d: 0 }], scanned = 0;
        var scanLimit = heavyProbe ? 1000 : 260, depthLimit = heavyProbe ? 8 : 5, outLimit = heavyProbe ? 32 : 14;
        while (queue.length && scanned < scanLimit && out.length < outLimit) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > depthLimit) continue;
          scanned++;
          if (TopBar.looksLikeTopBarPlayerPanel(p) && seen.indexOf(p) === -1) {
            seen.push(p);
            var probe = TopBar.makeProbeItem(p, r, node.d, out.length, !!heavyProbe);
            probe.score = 10;
            out.push(probe);
          }
          var n = DMM.childCount(p);
          var childLimit = heavyProbe ? 80 : 36;
          for (var c = 0; c < n && c < childLimit; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
        }
      }
      var swept = TopBar.sweepAllTopBarPlayers(4000);
      for (var s = 0; s < swept.length; s++) {
        if (seen.indexOf(swept[s]) === -1) {
          seen.push(swept[s]);
          var sweptProbe = TopBar.makeProbeItem(swept[s], 99, 0, out.length, !!heavyProbe);
          sweptProbe.score = 10;
          out.push(sweptProbe);
        }
      }
      return { roots: roots, items: out };
    },

    // Port of lastSpotCollectTopBarTeamHeroProbeItems: heavy-only deep pass
    // rooted specifically at TeamFriendly/TeamEnemy.
    collectTeamHeroProbeItems: function (heavyProbe) {
      var out = [], seen = [];
      if (!heavyProbe) return { items: out };
      var teams = TopBar.findTeamRoots(true);
      for (var t = 0; t < teams.length; t++) {
        var teamRoot = teams[t];
        var teamKey = TopBar.teamKeyFromPath(TopBar.ancestryPath(teamRoot, 8));
        var queue = [{ p: teamRoot, d: 0 }], scanned = 0;
        while (queue.length && scanned < 850 && out.length < 24) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > 10) continue;
          scanned++;
          var idl = String(DMM.id(p) || "").toLowerCase();
          var tyl = String(DMM.type(p) || "").toLowerCase();
          var looksRelevant = idl.indexOf("hero") >= 0 || tyl.indexOf("hero") >= 0 ||
            idl.indexOf("topbarplayer") >= 0 || tyl.indexOf("topbarplayer") >= 0 || idl.indexOf("player") >= 0;
          if (looksRelevant && seen.indexOf(p) === -1) {
            var info = TopBar.extractHeroInfo(p, true);
            if (info.hero) {
              seen.push(p);
              var probe = TopBar.makeProbeItem(p, t, node.d, out.length, true);
              probe.canonical = info.hero;
              probe.heroSource = "team_deep:" + (info.source || "-");
              probe.teamKey = teamKey || probe.teamKey;
              probe.score = 9;
              out.push(probe);
            }
          }
          var n = DMM.childCount(p);
          for (var c = 0; c < n && c < 80; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
        }
      }
      return { items: out };
    },

    // Port of lastSpotCollectTopBarHeroProbeItems: the master collector — scored
    // BFS across probe roots, merged with the player-panel pass and (heavy only)
    // the team-deep pass, sorted topbar-player-first then position then score.
    collectHeroProbeItems: function (heavyProbe) {
      var out = [], seen = [];
      var roots = TopBar.findProbeRoots(!!heavyProbe);
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        var rootY = DMM.safeNumber(root.actualyoffset);
        var queue = [{ p: root, d: 0, o: 0 }], scanned = 0;
        var scanLimit = heavyProbe ? 900 : 220, depthLimit = heavyProbe ? 8 : 5, outLimit = heavyProbe ? 64 : 18;
        while (queue.length && scanned < scanLimit && out.length < outLimit) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > depthLimit) continue;
          scanned++;
          var score = TopBar.probeScore(p, rootY);
          if (score >= 6 && seen.indexOf(p) === -1) {
            seen.push(p);
            var probe = TopBar.makeProbeItem(p, r, node.d, out.length, !!heavyProbe);
            probe.score = score;
            out.push(probe);
          }
          var n = DMM.childCount(p);
          var childLimit = heavyProbe ? 80 : 36;
          for (var c = 0; c < n && c < childLimit; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1, o: c });
        }
      }
      var i, directPlayers = TopBar.collectPlayerProbeItems(!!heavyProbe).items || [];
      for (i = 0; i < directPlayers.length; i++) {
        if (seen.indexOf(directPlayers[i].panel) === -1) { seen.push(directPlayers[i].panel); out.push(directPlayers[i]); }
      }
      var teamDeep = heavyProbe ? (TopBar.collectTeamHeroProbeItems(true).items || []) : [];
      for (i = 0; i < teamDeep.length; i++) {
        if (seen.indexOf(teamDeep[i].panel) === -1) { seen.push(teamDeep[i].panel); out.push(teamDeep[i]); }
      }
      out.sort(function (a, b) {
        var atp = TopBar.looksLikeTopBarPlayerPanel(a.panel) ? 1 : 0;
        var btp = TopBar.looksLikeTopBarPlayerPanel(b.panel) ? 1 : 0;
        if (atp !== btp) return btp - atp;
        if (atp && btp) { if (a.rootIndex !== b.rootIndex) return a.rootIndex - b.rootIndex; if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal; }
        if (a.y !== b.y) return a.y - b.y;
        if (a.x !== b.x) return a.x - b.x;
        return (b.score || 0) - (a.score || 0);
      });
      return { roots: roots, items: out };
    },

    // Full per-candidate dump of one name probe. Deliberately verbose: it prints
    // the RAW portrait/hint string every hero was inferred from, so a hero that
    // isn't even in the match can be traced to the exact panel and image path
    // that produced it.
    //
    // Cost: this is called from finalizeOrder, which runs once per name probe
    // (a few times per match at most, never per frame), so the logging is free
    // in steady state. Toggle with $.GetContextPanel().LastSpotToggleTopbarDiag().
    diagDump: function (c) {
      var cfg = teamCfg();
      log.log("=== TOPBAR_DIAG " + (c.tag || "probe") + " team=" + cfg.label +
        " half=" + cfg.topbarHalf + " mirror=" + ST.mirror + " expected=" + c.size +
        " candidates=" + c.items.length + " roots=" + c.roots.length, true);

      // Which subtrees the probe searched. Two panels can legitimately be named
      // TeamFriendly/TeamEnemy (the real topbar AND a data-less PlayerIntents
      // shadow copy) — if a shadow root shows up here, that is the smoking gun.
      for (var r = 0; r < c.roots.length; r++) {
        log.log("TB_ROOT r=" + r + " id=" + DMM.id(c.roots[r]) + " type=" + DMM.type(c.roots[r]) +
          " children=" + DMM.childCount(c.roots[r]), true);
      }

      // One line per candidate, in the exact order finalizeOrder slices them.
      // sel=Y marks the ones that ended up being reported as the enemy team.
      //
      // Hard cap: sweepAllTopBarPlayers() has no output limit, so a degenerate
      // HUD state could otherwise make this dump unbounded. 60 candidates is far
      // more than the ~12-24 real topbar player panels and keeps the burst small.
      var chosen = {}, k;
      for (k = 0; k < c.selectedNames.length; k++) chosen[String(c.selectedNames[k]).toLowerCase()] = 1;
      var limit = Math.min(c.items.length, 60);
      if (c.items.length > limit) log.log("TB_NOTE truncating dump to " + limit + " of " + c.items.length + " candidates", true);
      for (var i = 0; i < limit; i++) {
        var it = c.items[i];
        var hero = it.canonical || "";
        log.log("TB_CAND i=" + i +
          " sel=" + (hero && chosen[hero.toLowerCase()] ? "Y" : "n") +
          " root=" + it.rootIndex + " ord=" + it.ordinal + " team=" + it.teamKey +
          " hero=" + (hero || "-") + " via=" + (it.heroSource || "-") + " pid=" + it.playerId +
          " x=" + it.x + " y=" + it.y + " w=" + it.w + " h=" + it.h +
          " id=" + it.id + " type=" + it.type, true);
        log.log("TB_SRC  i=" + i + " portrait=" + (DMM.shortValue(it.portrait, 100) || "-") +
          " hint=" + (DMM.shortValue(it.hint, 50) || "-"), true);
        log.log("TB_PATH i=" + i + " " + it.path, true);
      }

      // Compact roster view: the REAL topbar player panels only (the PlayerIntents
      // shadows are excluded), ordered left-to-right by screen x. This is the
      // fastest way to spot a panel that failed to resolve — it shows as EMPTY,
      // and that gap is what lets the enemy slice backfill with an ally.
      var real = [], q;
      for (q = 0; q < c.items.length; q++) {
        if (String(c.items[q].type || "").toLowerCase().indexOf("citadelhudtopbarplayer") < 0) continue;
        real.push(c.items[q]);
      }
      real.sort(function (a, b) { return a.x - b.x; });
      var rdesc = [];
      for (q = 0; q < real.length; q++) {
        rdesc.push(real[q].id + "/" + real[q].teamKey + "/x" + real[q].x + "=" + (real[q].canonical || "**EMPTY**"));
      }
      log.log("TB_ROSTER " + (rdesc.join("  ") || "-"), true);

      log.log("TB_BUCKETS all=" + (c.allNames.join("|") || "-") +
        " || friendly=" + (c.friendlyNames.join("|") || "-") +
        " || enemy=" + (c.enemyNames.join("|") || "-") +
        " || unknown=" + (c.unknownNames.join("|") || "-"), true);
      log.log("TB_SELECT source=" + c.source + " selected=" + (c.selectedNames.join("|") || "-") +
        " count=" + c.selectedNames.length + "/" + c.size +
        " (NB: the '" + cfg.topbarHalf + "' half is sliced from ALL names — both teams —" +
        " so an unresolved enemy lets an ally backfill the gap)", true);
      log.log("=== TOPBAR_DIAG_END", true);
    },

    // Port of lastSpotFinalizeTopBarHeroOrderFromResult: dedupe into all/friendly/
    // enemy/unknown by ancestry-path team, then pick the local team's topbar half
    // with the same 3-tier fallback (canonical slice -> team-path slice -> tail slice).
    finalizeOrder: function (result, forceLog) {
      result = result || { roots: [], items: [] };
      var items = result.items || [];
      var all = [], friendly = [], enemy = [], unknown = [];
      var seenAll = {}, seenF = {}, seenE = {}, seenU = {};
      function addHero(arr, seen, item) {
        var hero = item.canonical;
        if (!hero) return;
        var k = hero.toLowerCase();
        if (seen[k]) return;
        seen[k] = 1;
        arr.push({ hero: hero, teamKey: item.teamKey });
      }
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        addHero(all, seenAll, item);
        if (item.teamKey === "enemy") addHero(enemy, seenE, item);
        else if (item.teamKey === "friendly") addHero(friendly, seenF, item);
        else addHero(unknown, seenU, item);
      }

      function names(arr) { var o = []; for (var k = 0; k < arr.length; k++) o.push(arr[k].hero); return o; }
      var allNames = names(all), enemyNames = names(enemy), friendlyNames = names(friendly);
      var size = expectedTeamSize();
      var half = teamCfg().topbarHalf;
      var source = "", selected = [];

      if (half === "first") {
        source = "canonical_first";
        selected = allNames.slice(0, size);
        if (selected.length < size && enemyNames.length > selected.length) { source = "team_enemy_path"; selected = enemyNames.slice(0, size); }
      } else {
        var canonicalAfter = allNames.slice(size, size + size);
        var hasFullVisualEnemyHalf = canonicalAfter.length >= size && allNames.length >= size * 2;
        if (hasFullVisualEnemyHalf) {
          source = "canonical_after"; selected = canonicalAfter;
        } else {
          source = "team_enemy_path_direct"; selected = enemyNames.slice(0, size);
          if (selected.length < size) {
            if (canonicalAfter.length > selected.length) { source = "canonical_after"; selected = canonicalAfter; }
            else if (selected.length === 0) { source = "canonical_after"; selected = canonicalAfter; }
          }
        }
        if (selected.length < size && allNames.length >= size * 2) {
          var canonicalLast = allNames.slice(Math.max(0, allNames.length - size));
          if (canonicalLast.length > selected.length) { source = "canonical_last"; selected = canonicalLast; }
        }
      }

      var selectedNames = [], seenSel = {};
      for (var s = 0; s < selected.length && selectedNames.length < size; s++) {
        var hero = DMM.canonicalHeroName(selected[s]);
        if (!hero) continue;
        var k2 = hero.toLowerCase();
        if (seenSel[k2]) continue;
        seenSel[k2] = 1; selectedNames.push(hero);
      }

      if (ST.topbarDiag) {
        if (!allNames.length) {
          // In a LIVE match the fast pass resolves nothing — hero data is only
          // cheaply readable in bot games / private lobbies; live matches need the
          // deferred (heavy) pass. So a zero-hero result here is expected, not a
          // fault. Dumping the full candidate list for it would just bury the
          // deferred pass's dump, which is the one that carries the real names.
          log.log("TOPBAR_DIAG skipped: 0 heroes from " + items.length +
            " candidates (expected for the fast pass in a live match)", true);
        } else {
          TopBar.diagDump({
            tag: "probe", size: size, items: items, roots: result.roots || [],
            allNames: allNames, friendlyNames: friendlyNames, enemyNames: enemyNames,
            unknownNames: names(unknown), selectedNames: selectedNames, source: source
          });
        }
      }

      if (forceLog) {
        log.log("TOPBAR_ASSIST_ORDER source=" + source + " team=" + teamCfg().label +
          " enemy=" + (selectedNames.join("|") || "-") + " enemyCount=" + selectedNames.length +
          " expected=" + size + " friendly=" + (friendlyNames.join("|") || "-") +
          " unknown=" + (names(unknown).join("|") || "-") + " all=" + (allNames.join("|") || "-"), true);
      }

      return { roots: result.roots || [], items: items, all: all, friendly: friendly, enemy: enemy,
        unknown: unknown, selectedNames: selectedNames, teamSize: size, source: source };
    },

    // Port of lastSpotGetTopBarHeroOrderDetailed (no short-TTL cache — ST.namesCached
    // is the higher-level cache once a complete set is found).
    getOrderDetailed: function (forceLog, heavyProbe) {
      var result = TopBar.collectHeroProbeItems(!!heavyProbe);
      return TopBar.finalizeOrder(result, !!forceLog);
    },

    // Port of lastSpotSetEnemyHeroNameChoices.
    // Filters out the ground-truth local hero (ST.localHeroName, set from the
    // local minimap map_button — see Scanner.autoDetectTeam) before caching.
    // The topbar-half selection in finalizeOrder is a positional guess (fixed
    // left/right slice); if that guess ever includes the local player's own
    // topbar entry, this catches it here rather than tracking the local hero
    // as a 7th "enemy". A drop makes the set fall short of expected size,
    // which correctly triggers a retry (see TopBar.warm) instead of caching
    // a wrong name.
    setEnemyChoices: function (names, reason, forceLog, expectedSizeHint) {
      var canonical = [], seen = {};
      var localKey = ST.localHeroName ? ST.localHeroName.toLowerCase() : "";
      var droppedLocal = "";
      for (var i = 0; i < (names || []).length && canonical.length < Cfg.MAX_SLOTS; i++) {
        var hero = DMM.canonicalHeroName(names[i]);
        if (!hero) continue;
        var k = hero.toLowerCase();
        if (seen[k]) continue;
        if (localKey && k === localKey) { droppedLocal = hero; continue; }
        seen[k] = 1; canonical.push(hero);
      }
      var hint = Number(expectedSizeHint) | 0;
      if (hint >= 1 && hint <= Cfg.MAX_SLOTS) ST.enemyTeamSizeHint = hint;
      if (canonical.length) ST.enemyHeroNames = canonical;
      if (forceLog || droppedLocal) {
        log.log("HERO_NAMES_CACHE reason=" + (reason || "set") + " count=" + canonical.length +
          " names=" + (canonical.join("|") || "-") +
          (droppedLocal ? " dropped_local=" + droppedLocal : ""), true);
      }
      return canonical;
    },

    // Port of lastSpotWarmTopBarHeroCacheNow: fast synchronous pass only.
    warmNow: function (reason, forceLog) {
      if (!Panels.refresh()) return [];
      var detailed = TopBar.getOrderDetailed(!!forceLog, false);
      return TopBar.setEnemyChoices(detailed.selectedNames, (reason || "warmup") + "_fast", !!forceLog, detailed.teamSize);
    },

    // Port of lastSpotRunDeferredTopBarHeroNameProbe: resolves ONE unresolved
    // candidate per scheduled frame (heavy path, incl. RunScriptInPanelContext)
    // instead of all of them synchronously — the documented cause of V1's hitch
    // when this was done eagerly for every candidate in one pass.
    runDeferredProbe: function (reason, forceLog, done) {
      if (!Panels.refresh()) { if (done) done([], null); return; }
      ST.deferredProbeToken = (ST.deferredProbeToken || 0) + 1;
      var token = ST.deferredProbeToken;
      var result = TopBar.collectHeroProbeItems(false);
      var items = result.items || [];
      var index = 0;

      function finish() {
        if (token !== ST.deferredProbeToken) return;
        var detailed = TopBar.finalizeOrder(result, !!forceLog);
        var names = TopBar.setEnemyChoices(detailed.selectedNames, reason || "deferred_probe", !!forceLog, detailed.teamSize);
        if (done) { try { done(names, detailed); } catch (e) {} }
      }

      function step() {
        if (token !== ST.deferredProbeToken) return;
        var processed = 0;
        while (index < items.length && processed < 1) {
          var item = items[index++];
          // BUG (fixed): logged item.heroSource, which was already set to the
          // INITIAL fast-pass label ("fast_empty") during collection and only
          // gets overwritten if it was previously falsy — so the log showed
          // the stale pre-deferred source even though extractHeroInfoDeferred
          // genuinely ran. Log the freshly-computed info.source instead.
          var freshSource = item ? (item.heroSource || "-") : "-";
          if (item && !item.canonical) {
            var info = TopBar.extractHeroInfoDeferred(item.panel);
            freshSource = info.source || "-";
            if (info.hero) { item.canonical = info.hero; item.heroSource = info.source || item.heroSource; }
            else if (!item.heroSource) item.heroSource = info.source || "deferred_empty";
          }
          if (item) {
            // Debug-gated now that extraction is confirmed working — this was
            // a per-candidate diagnostic (12+ lines every probe attempt), not
            // something every user needs force-printed by default.
            log.log("DEFERRED_ITEM id=" + item.id + " type=" + item.type + " pid=" + item.playerId +
              " source=" + freshSource + " hero=" + (item.canonical || "-"));
          }
          processed++;
        }
        if (index < items.length) DMM.schedule(0.01, step);
        else finish();
      }
      DMM.schedule(0.01, step);
    },

    // Port of lastSpotWarmTopBarHeroCacheDeferred: fast pass first; only run the
    // per-frame heavy pass if the fast pass didn't already produce a full roster.
    warmDeferred: function (reason, forceLog, done) {
      var fastNames = TopBar.warmNow((reason || "warmup") + "_fast", !!forceLog);
      if (fastNames.length >= expectedTeamSize()) { if (done) done(fastNames, null); return; }
      TopBar.runDeferredProbe(reason || "warmup_deferred", !!forceLog, done);
    },

    // Broad attribute probe used by the diagnostic dump to reveal how the topbar
    // stores hero identity (path? heroid? label text?).
    PROBE_ATTRS: ["heroid", "hero_id", "heroId", "m_nHeroID", "nHeroID", "hero", "heroname",
      "hero_name", "heroName", "unit", "unit_name", "npc_name", "name", "text", "player_name",
      "playerName", "player_id", "playerid", "account_id", "accountid", "steamid",
      "src", "image", "texture", "source", "defaultsrc", "defaultSrc", "tooltip"],

    probeAttrs: function (panel) {
      var out = [];
      for (var i = 0; i < TopBar.PROBE_ATTRS.length; i++) {
        var v = DMM.readString(panel, TopBar.PROBE_ATTRS[i]);
        if (v) out.push(TopBar.PROBE_ATTRS[i] + "=" + DMM.shortValue(v, 60));
      }
      return out.join("  ");
    },

    // Diagnostic dump: prints a terse summary line for any topbar panel that
    // looks player/hero-related. Confirmed dead end for hero identity (both
    // topbar HeroIcon and minimap map_button MainImage panels expose nothing
    // readable — see LASTSPOT_REWRITE_CONTEXT.md) but kept as a cheap sanity
    // check of topbar roster/order.
    dump: function (tag) {
      if (!Panels.refresh()) { log.log("DUMP no_hud", true); return; }
      var roots = TopBar.roots();
      log.log("=== TOPBAR_DUMP " + (tag || "") + " roots=" + roots.length + " existing_ids=" + TOPBAR_ROOT_IDS.join(","), true);
      var printed = 0;
      for (var r = 0; r < roots.length; r++) {
        var root = roots[r];
        log.log("TOPBAR_ROOT r=" + r + " id=" + DMM.id(root) + " type=" + DMM.type(root) + " children=" + DMM.childCount(root), true);
        var queue = [{ p: root, d: 0 }], scanned = 0;
        while (queue.length && scanned < 320 && printed < 240) {
          var node = queue.shift(), p = node.p;
          if (!DMM.valid(p) || node.d > 7) continue;
          scanned++;
          var attrs = TopBar.probeAttrs(p);
          var hero = TopBar.heroForPanel(p);
          var idl = String(DMM.id(p)).toLowerCase();
          var tyl = String(DMM.type(p)).toLowerCase();
          var interesting = attrs || hero || idl.indexOf("player") >= 0 || idl.indexOf("hero") >= 0 ||
            tyl.indexOf("player") >= 0 || tyl.indexOf("hero") >= 0 || tyl.indexOf("image") >= 0;
          if (interesting) {
            printed++;
            var pid = TopBar.readPlayerId(p);
            log.log("TB d=" + node.d + " id=" + DMM.id(p) + " type=" + DMM.type(p) +
              " x=" + DMM.safeNumber(p.actualxoffset) + " pid=" + pid + " hero=" + (hero || "-") +
              (attrs ? "  " + attrs : ""), true);
          }
          var n = DMM.childCount(p);
          for (var c = 0; c < n && c < 40; c++) queue.push({ p: DMM.childAt(p, c), d: node.d + 1 });
        }
      }
      log.log("=== TOPBAR_DUMP_END printed=" + printed, true);
    },

    // Read topbar enemy names. Fast pass first (warmNow, inside warmDeferred);
    // only runs the per-frame heavy pass if the fast pass came up short. Stores
    // only a complete set. This is now async (results land in the done callback
    // below, potentially several frames later) since the heavy pass is spread
    // one candidate per frame instead of run all at once.
    // verbose=true (only the manual "Probe names" command passes this) also
    // force-prints the per-candidate DEFERRED_ITEM/TOPBAR_ASSIST_ORDER detail;
    // the automatic gametime-gated/retry calls stay concise (TOPBAR_WARM only)
    // unless the debug toggle is on.
    warm: function (reason, verbose) {
      if (!Panels.refresh()) { TopBar.scheduleRetry(); return; }
      var size = expectedTeamSize();
      TopBar.warmDeferred(reason, !!verbose, function (names, detailed) {
        var laneBuckets = [];
        var active = LaneAssist.activeSlots();
        for (var li = 0; li < active.length; li++) laneBuckets.push("id" + active[li].slot.id + ":" + active[li].lane.key);
        log.log("TOPBAR_WARM attempt=" + ST.nameAttempts + " team=" + teamCfg().label + " expected=" + size +
          " tracked=" + enemyState.size + " lanedIds=[" + laneBuckets.join(",") + "]" +
          " selected=" + (names.join("|") || "-"), true);

        // Ally names are a free byproduct of the same scan (virtually no extra
        // cost) — cache them even though nothing consumes them yet.
        if (detailed && detailed.friendly && detailed.friendly.length) {
          var friendlyNames = [], seenF = {};
          for (var fi = 0; fi < detailed.friendly.length; fi++) {
            var fh = DMM.canonicalHeroName(detailed.friendly[fi].hero);
            if (fh && !seenF[fh.toLowerCase()]) { seenF[fh.toLowerCase()] = 1; friendlyNames.push(fh); }
          }
          if (friendlyNames.length) ST.friendlyHeroNames = friendlyNames;
        }

        if (names.length >= size) {
          ST.namesCached = true;
          LaneAssist.resetCache();
          log.log("TOPBAR_CACHED enemy=" + names.join("|") + " ally=" + (ST.friendlyHeroNames.join("|") || "-") + " (locked; polling stopped)", true);
          LaneAssist.primeOnce("topbar_cached");
          SettingsUI.update();
          return;
        }
        TopBar.scheduleRetry();
      });
    },

    // Bounded retry (survives a slow initial load), then PERMANENTLY gives up.
    // The full deep-scan+deferred pipeline is not cheap, and an unenforced
    // "retry every 30s forever" was the actual cause of the recurring
    // full-match frame spike — this mod should probe hero names once, not
    // for the rest of the game.
    scheduleRetry: function () {
      if (ST.namesCached) return;
      if (ST.nameAttempts >= Cfg.NAME_PROBE_MAX_ATTEMPTS) {
        if (!ST.nameProbeGaveUp) {
          ST.nameProbeGaveUp = true;
          log.log("topbar name probe gave up after " + ST.nameAttempts + " attempts; partial=" + (ST.enemyHeroNames.join("|") || "-"), true);
        }
        return;
      }
      ST.topbarHandle = DMM.schedule(Cfg.NAME_PROBE_RETRY_SEC, function () {
        ST.nameAttempts++;
        TopBar.warm("retry");
      });
    },

    // Gate the (expensive) hero-name probe on REAL match time reaching
    // NAME_PROBE_DELAY_SEC via DMM.getGameTime() (shared with Soul Advantage's
    // local-hero probe), not wall-clock-since-script-load — the poll itself is
    // cheap (the shared clock caches its panel after the first find). Falls
    // back to wall-clock if the clock panel is never found at all.
    pollGameTime: function () {
      if (ST.namesCached || ST.nameProbeGaveUp) { TopBar.hideScanWarning(); return; }
      var seconds = DMM.getGameTime(ST.root, ST.hud);
      var elapsedSinceBoot = (DMM.now() - (ST.bootMs || DMM.now())) / 1000;
      var ready = seconds !== null ? seconds >= Cfg.NAME_PROBE_DELAY_SEC : elapsedSinceBoot >= Cfg.NAME_PROBE_DELAY_SEC + 15;
      if (ready) {
        TopBar.hideScanWarning();
        log.log("topbar name probe firing gameTime=" + (seconds === null ? "unavailable" : seconds.toFixed(1)), true);
        ST.nameAttempts = 1;
        TopBar.warm("initial");
        return;
      }
      // Countdown box is strictly GameTime-driven (per explicit request): only
      // shown while real match time is known AND under the delay, so it never
      // displays during the wall-clock fallback grace period above, and always
      // clears itself at exactly NAME_PROBE_DELAY_SEC rather than lingering.
      if (seconds !== null) {
        TopBar.showScanWarning(Math.max(1, Math.ceil(Cfg.NAME_PROBE_DELAY_SEC - seconds)));
      } else {
        TopBar.hideScanWarning();
      }
      ST.topbarHandle = DMM.schedule(1, TopBar.pollGameTime);
    },

    showScanWarning: function (secondsLeft) {
      var box = Panels.scanWarning();
      if (!DMM.valid(box)) return;
      var lbl = DMM.find(box, "LastSpotScanWarningLabel");
      if (DMM.valid(lbl)) {
        lbl.text = "Warning: LastSpot Scan in " + secondsLeft + " second" + (secondsLeft === 1 ? "" : "s") + ". Game will momentarily freeze.";
      }
      box.RemoveClass("hidden");
    },

    hideScanWarning: function () {
      if (!DMM.valid(ST.scanWarning)) return;
      ST.scanWarning.AddClass("hidden");
    },

    // Runtime.clearAll re-arms this on every detected "context change" (new
    // minimap panel instance — see Panels.maybeResetContext). If that fires
    // more than once in a row (e.g. the minimap panel identity flaps across
    // the hideout -> queue -> loading -> match-start transition), bootMs
    // kept getting reset to "now" each time, so "30s since boot" could
    // restart indefinitely and never actually reach 30 real seconds of
    // standing still. Debounce: a re-arm within 5s of the previous one is
    // treated as spurious and ignored (the already-running poll keeps
    // counting from its original bootMs — this ONLY holds if the caller
    // doesn't cancel ST.topbarHandle before calling start(); see the fixed
    // bug at Runtime.clearAll's call site).
    start: function () {
      var now = DMM.now();
      if (ST.lastStartMs && now - ST.lastStartMs < 5000) {
        log.log("topbar name probe re-arm debounced (" + ((now - ST.lastStartMs) / 1000).toFixed(1) + "s after previous start)", true);
        return;
      }
      ST.lastStartMs = now;
      ST.nameAttempts = 0;
      ST.namesCached = false;
      ST.nameProbeGaveUp = false;
      ST.bootMs = now;
      DMM.resetGameTime();
      DMM.cancel(ST.topbarHandle);
      TopBar.pollGameTime();
      log.log("topbar name probe waiting for gameTime>=" + Cfg.NAME_PROBE_DELAY_SEC + "s (real match time, polled cheaply)", true);
    },

    getEnemyNames: function () { return ST.enemyHeroNames.slice(0); }
  };

  // ===========================================================================
  // Scanner — the 400ms heartbeat
  // ===========================================================================
  var Scanner = {
    getMapButtons: function () {
      var now = DMM.now();
      if (ST.mapButtonCache && now - ST.mapButtonCacheTs < Cfg.MAP_BUTTON_CACHE_MS) {
        try { if (ST.mapButtonCache[0] && ST.mapButtonCache[0].IsValid && ST.mapButtonCache[0].IsValid()) return ST.mapButtonCache; } catch (e) {}
      }
      var buttons = [];
      try { buttons = (ST.minimap && ST.minimap.FindChildrenWithClassTraverse) ? ST.minimap.FindChildrenWithClassTraverse("map_button") : []; } catch (e) { buttons = []; }
      ST.mapButtonCache = buttons; ST.mapButtonCacheTs = now;
      return buttons;
    },

    buildCandidates: function (buttons) {
      var list = [];
      for (var i = 0; i < buttons.length; i++) {
        var panel = buttons[i];
        if (!DMM.valid(panel) || !Detect.isHeroMapButton(panel) || !Detect.isPositioned(panel)) continue;
        var classMatch = Detect.isEnemyButton(panel);
        var hasEnemy = DMM.hasClass(panel, "enemy");
        var hasFriend = DMM.hasClass(panel, "friend") || DMM.hasClass(panel, "ally");
        var t1 = DMM.hasClass(panel, "team1"), t2 = DMM.hasClass(panel, "team2");
        if (!classMatch && !hasEnemy && !hasFriend && !t1 && !t2) continue;
        list.push({ c: list.length + 1, idx: i, panel: panel, hasEnemy: hasEnemy, t1: t1, t2: t2, classMatch: classMatch, active: Detect.isActive(panel) });
      }
      return list;
    },

    matchesAssignmentTeam: function (cand) {
      if (!cand) return false;
      if (cand.hasEnemy || cand.classMatch) return true;
      var ec = enemyMapClass();
      if (ec === "team1") return !!cand.t1;
      if (ec === "team2") return !!cand.t2;
      return false;
    },

    autoDetectTeam: function (buttons, now) {
      if (ST.teamManual) return;
      if (now - (ST.teamAutoTs || 0) < 1000) return;
      ST.teamAutoTs = now;
      for (var i = 0; i < buttons.length; i++) {
        var panel = buttons[i];
        if (!DMM.valid(panel) || !Detect.isHeroMapButton(panel)) continue;
        var isLocal = DMM.hasClass(panel, "localplayer") || DMM.hasClass(panel, "local_player") || DMM.hasClass(panel, "local") || DMM.hasClass(panel, "self");
        if (!isLocal) continue;
        var localHero = Detect.heroFromMapButton(panel);
        if (localHero) ST.localHeroName = localHero;
        var tk = Detect.localTeamKey(panel);
        if (tk) { Runtime.setTeam(tk, "auto"); return; }
      }
    },

    updateEntry: function (panel, key, keySource, idx, now, token, forcedSlotId) {
      var entry = enemyState.get(key);
      if (!entry) {
        entry = { key: key, x: 0, y: 0, w: 0, h: 0, lastSeenMs: 0, lastMissingMs: 0, lastToken: 0,
          wasVisible: false, missingArmed: false, liveMarker: null, lingerMarker: null,
          lingerUntilMs: 0, lingerReason: "", trackerId: 0, manualLabel: "", displayName: "Enemy" };
        enemyState.set(key, entry);
      }
      entry.panel = panel;
      var slot = Trackers.assign(panel, key, now, forcedSlotId);
      if (slot) {
        entry.trackerId = slot.id;
        // Ground-truth auto-assign: read the hero directly off THIS panel's own
        // portrait (Detect.heroFromMapButton — cheap, direct-child lookup) rather
        // than waiting on topbar/lane-assist inference. Never overwrites a
        // manual pick; free to confirm/fill an inference-only (lane-assist) guess.
        if (!slot.manualOverride) {
          var autoHero = Detect.heroFromMapButton(panel);
          if (autoHero && autoHero !== slot.customName) {
            slot.customName = autoHero;
            slot.label = autoHero;
          }
        }
        entry.manualLabel = slot.customName || String(slot.id);
        Trackers.writePanelId(panel, slot.id);
      }
      entry.lastToken = token;

      if (Detect.isDead(panel)) {
        entry.wasVisible = false; entry.missingArmed = false; entry.lastMissingMs = 0;
        entry.lingerUntilMs = 0; entry.lingerReason = "dead";
        Markers.hideLive(entry); Markers.clearLinger(entry);
        var ds = entry.trackerId ? slotById(entry.trackerId) : null;
        if (ds) { ds.active = false; ds.dead = true; ds.lastX = 0; ds.lastY = 0; ds.lastSeenMs = 0; }
        return;
      }

      var active = Detect.isActive(panel);
      if (active) {
        var w = DMM.safeExtent(panel.actuallayoutwidth || panel.contentwidth, 64, 2048);
        var h = DMM.safeExtent(panel.actuallayoutheight || panel.contentheight, 64, 2048);
        var x = DMM.safeNumber(panel.actualxoffset) || 0;
        var y = DMM.safeNumber(panel.actualyoffset) || 0;
        entry.x = x + w * 0.5; entry.y = y + h * 0.5; entry.w = w; entry.h = h;
        entry.lastSeenMs = now; entry.lastMissingMs = 0; entry.missingArmed = true; entry.wasVisible = true;
        Markers.clearLinger(entry);
        if (ST.showLive) {
          var m = Markers.ensure(entry, "live");
          if (DMM.valid(m)) {
            try { m.style.opacity = "1"; } catch (e) {}
            Markers.setContent(entry, m, Markers.displayText(entry), "live");
            Markers.position(m, entry, Cfg.LIVE_MARKER_LEFT_OFFSET_PX);
          }
        } else Markers.hideLive(entry);
      } else {
        Markers.hideLive(entry);
        if (entry.wasVisible && entry.missingArmed) {
          if (!entry.lastMissingMs) entry.lastMissingMs = now;
          if (now - entry.lastMissingMs >= Cfg.MISSING_CONFIRM_MS) {
            entry.wasVisible = false; entry.missingArmed = false;
            Markers.startLinger(entry, "inactive_or_hidden", now);
          }
        }
      }
      Trackers.updateFromEntry(entry, active);
    },

    tickImpl: function () {
      if (!ST.enabled) { Runtime.hideAllMarkers(); return; }
      if (!Panels.refresh()) return;
      var now = DMM.now();
      var token = ++ST.scanToken;
      var buttons = Scanner.getMapButtons();
      Scanner.autoDetectTeam(buttons, now);

      var candidates = Scanner.buildCandidates(buttons);
      var expected = Math.max(1, Math.min(Cfg.MAX_SLOTS, expectedTeamSize()));

      // team-size upgrade: 5+ active enemies => standard 6
      var activeEnemies = 0, i;
      for (i = 0; i < candidates.length; i++) if (candidates[i].active && Scanner.matchesAssignmentTeam(candidates[i])) activeEnemies++;
      if (activeEnemies >= 5 && ST.enemyTeamSizeHint !== Cfg.MAX_SLOTS) {
        LaneAssist.resetCache(); ST.enemyTeamSizeHint = Cfg.MAX_SLOTS;
        TopBar.warm("active_enemy_upgrade");
      }

      // build candidate -> slot map
      var forced = Object.create(null), used = Object.create(null);
      var activeCands = [], inactiveCands = [];
      for (i = 0; i < candidates.length; i++) {
        if (!Scanner.matchesAssignmentTeam(candidates[i])) continue;
        (candidates[i].active ? activeCands : inactiveCands).push(candidates[i]);
      }
      var defCands = activeCands.length >= expected ? activeCands : activeCands.concat(inactiveCands);

      // 1) ALWAYS honor an ID already written onto the panel. This is the core
      //    "IDs never change once assigned" rule and it also keeps a leaving
      //    enemy's slot reserved so its linger entry is not reused by a new panel.
      for (i = 0; i < defCands.length; i++) {
        var c1 = defCands[i]; if (forced[c1.c]) continue;
        var ex = Trackers.readPanelId(c1.panel);
        if (ex >= 1 && ex <= expected && !used[ex]) { forced[c1.c] = ex; used[ex] = true; }
      }
      // 2) When locked, resolve recreated panels by their assigned hero identity.
      if (Trackers.lockActive()) {
        for (i = 0; i < defCands.length; i++) {
          var c2 = defCands[i]; if (forced[c2.c]) continue;
          var hero = Trackers.heroForLock(c2.panel, c2.idx);
          var hid = Trackers.findAssignedSlotForHero(hero, used);
          if (hid >= 1 && hid <= expected) { forced[c2.c] = hid; used[hid] = true; }
        }
      }
      // 3) Give any still-unassigned (genuinely new) panel a free slot. Prefer a
      //    slot with no active linger so a leaving enemy keeps its ID and its
      //    linger survives; only reuse a lingering slot as a last resort, and
      //    clear that stale linger when we do.
      function slotLingering(sid) {
        var e = enemyState.get("enemy_panel_" + sid);
        return !!(e && e.lingerUntilMs > 0);
      }
      function pickFreeSlot() {
        var sid;
        for (sid = 1; sid <= expected; sid++) if (!used[sid] && !slotLingering(sid)) return sid;
        for (sid = 1; sid <= expected; sid++) if (!used[sid]) return sid;
        return 0;
      }
      for (i = 0; i < defCands.length; i++) {
        var c3 = defCands[i]; if (forced[c3.c]) continue;
        var sid = pickFreeSlot();
        if (!sid) break;
        if (slotLingering(sid)) {
          var old = enemyState.get("enemy_panel_" + sid);
          if (old) Markers.clearLinger(old);
        }
        forced[c3.c] = sid; used[sid] = true;
      }

      for (i = 0; i < candidates.length; i++) {
        var cand = candidates[i];
        var fid = forced[cand.c] || 0;
        if (!fid) continue;
        Scanner.updateEntry(cand.panel, "enemy_panel_" + fid, "forced_c" + cand.c, cand.idx, now, token, fid);
      }

      // linger/expire sweep
      enemyState.forEach(function (entry) {
        if (!entry) return;
        if (entry.lastToken !== token && entry.wasVisible && entry.missingArmed) {
          if (!entry.lastMissingMs) entry.lastMissingMs = now;
          if (now - entry.lastMissingMs >= Cfg.MISSING_CONFIRM_MS) {
            entry.wasVisible = false; entry.missingArmed = false;
            Markers.startLinger(entry, "panel_missing", now);
          }
        }
        if (entry.lingerUntilMs > 0) {
          if (entry.lingerUntilMs - now <= 0) Markers.clearLinger(entry);
          else Markers.updateLinger(entry, now);
        }
        if (!entry.wasVisible && entry.lingerUntilMs <= 0 && now - (entry.lastSeenMs || 0) > Cfg.STALE_PLAYER_MS) {
          Markers.del(entry.liveMarker); Markers.del(entry.lingerMarker);
          enemyState.delete(entry.key);
        }
      });

      LaneAssist.autoTick();
      Trackers.maybeLockPostSolve();
    },

    tick: function () { perf.time("scan", Scanner.tickImpl, function () { return "tracked=" + enemyState.size; }); },

    loop: function () {
      Scanner.tick();
      ST.scanHandle = DMM.schedule(Cfg.SCAN_MS / 1000, Scanner.loop);
    }
  };

  // ===========================================================================
  // Runtime — cross-module actions
  // ===========================================================================
  var Runtime = {
    setTeam: function (teamKey, reason) {
      if (!TEAM[teamKey]) return;
      if (ST.teamKey === teamKey && ST.mirror === TEAM[teamKey].mirror) return;
      ST.teamKey = teamKey;
      ST.mirror = TEAM[teamKey].mirror;
      LaneAssist.resetCache();
      Trackers.unlock("team_change");
      log.log("team=" + teamKey + " mirror=" + ST.mirror + " reason=" + (reason || "?"));
    },

    hideAllMarkers: function () {
      enemyState.forEach(function (entry) {
        if (!entry) return;
        Markers.hideLive(entry); Markers.clearLinger(entry);
      });
    },

    clearAll: function (reason) {
      Runtime.hideAllMarkers();
      enemyState.forEach(function (entry) {
        if (!entry) return;
        Markers.del(entry.liveMarker); Markers.del(entry.lingerMarker);
        Trackers.clearPanelId(entry.panel);
      });
      enemyState.clear();
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        // BUG (found while chasing stale-names-after-match reports): this
        // reset tracking state but never touched the assigned hero name, so
        // even when clearAll() DID run, customName/label survived untouched —
        // the exact symptom reported (old hero names persisting into a new
        // match). Now resets everything a fresh match needs blank.
        s.key = ""; s.lastSeenMs = 0; s.lastX = 0; s.lastY = 0; s.active = false; s.panelValid = false; s.dead = false;
        s.laneKey = ""; s.laneLabel = ""; s.laneCandidates = []; s.attachedPanel = null;
        s.customName = ""; s.label = String(s.id); s.choiceIndex = 0; s.manualOverride = false;
      }
      ST.mapButtonCache = null; ST.mapButtonCacheTs = 0;
      ST.enemyHeroNames = []; ST.friendlyHeroNames = [];
      LaneAssist.resetCache(); Trackers.unlock(reason || "clear_all");
      // New match/map: re-arm the 30s one-shot. Do NOT cancel ST.topbarHandle
      // here — start() already does that itself, but ONLY on the path where
      // it's actually about to reschedule (see start()'s debounce). BUG
      // FOUND (2026-07-08): this used to unconditionally cancel the handle
      // right before calling start(), so a debounced start() (a re-arm
      // within 5s of the previous one, e.g. from panel-identity flapping
      // during load) would cancel the live poll loop and then return without
      // rescheduling it — permanently killing the countdown/probe until some
      // later trigger happened to land outside the debounce window. This is
      // the likely root cause of "needed a manual reprobe" reports and of
      // the new scan-warning countdown getting stuck instead of clearing.
      TopBar.hideScanWarning();
      TopBar.start();
      // Re-enable live marks for the fresh match. maybeDisableLiveAfterAssignments
      // turns these off once every slot has a hero (no longer needed that
      // match) — without resetting it here, a match that ended fully-mapped
      // would carry showLive=false into the NEXT match, silently hiding live
      // marks for its entire duration until (if ever) all 6 got mapped again.
      ST.showLive = true;
      log.log("runtime_cleared reason=" + (reason || "?"), true);
    },

    // Panel-identity-based reset (Panels.maybeResetContext) proved unreliable
    // — reported stale IDs/names surviving a match exit and carrying into the
    // next match. Real match seconds (DMM.getGameTime(), shared with the
    // topbar/local-hero probes) is a more robust signal: hideout has no real
    // match clock (reads null) and a fresh match starts near 0, so either the
    // clock going from "known" to "unavailable" (left the match) or JUMPING
    // BACKWARD by more than a few seconds (a new match's clock is lower than
    // the previous one's) means a boundary was crossed. Cheap: getGameTime()
    // is a single cached .text read in the common case.
    checkMatchBoundary: function () {
      var gt = DMM.getGameTime(ST.root, ST.hud);
      var last = ST.lastGameTimeSeconds;
      var crossedBoundary = (last !== null && gt === null) || (last !== null && gt !== null && gt < last - 5);
      ST.lastGameTimeSeconds = gt;
      if (crossedBoundary) Runtime.clearAll("gametime_reset");
    },

    allSlotsHaveHeroes: function () {
      var any = false;
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (!s.key || !s.lastSeenMs) continue;
        any = true;
        if (!DMM.canonicalHeroName(s.customName)) return false;
      }
      return any;
    },
    maybeDisableLiveAfterAssignments: function () {
      if (ST.showLive && Runtime.allSlotsHaveHeroes()) {
        ST.showLive = false;
        Runtime.hideAllMarkers();
        log.log("live_marks_auto_off all_assigned");
      }
    }
  };

  // ===========================================================================
  // Settings — persist calibration/linger tuning across sessions
  // ===========================================================================
  var Settings = {
    KEYS: ["offsetX", "offsetY", "scaleX", "scaleY", "persistenceMs", "fadeHoldMs",
      "lingerStartOpacity", "lingerEndOpacity", "markerScale"],
    save: function () {
      var o = {};
      for (var i = 0; i < Settings.KEYS.length; i++) o[Settings.KEYS[i]] = ST[Settings.KEYS[i]];
      DMM.storageSet(Cfg.STORE_KEY, o);
    },
    load: function () {
      var o = DMM.storageGet(Cfg.STORE_KEY, null);
      if (!o) return;
      for (var i = 0; i < Settings.KEYS.length; i++) {
        var k = Settings.KEYS[i];
        if (typeof o[k] === "number" && isFinite(o[k])) ST[k] = o[k];
      }
    }
  };

  // ===========================================================================
  // Cmd — user actions (invoked from the XML panel via LastSpotCmd)
  // ===========================================================================
  var Cmd = {
    toggleEnabled: function () {
      ST.enabled = !ST.enabled;
      if (!ST.enabled) Runtime.hideAllMarkers();
      SettingsUI.update();
      log.log("enabled=" + ST.enabled, true);
    },
    adjustOffset: function (dx, dy) { ST.offsetX += (dx | 0); ST.offsetY += (dy | 0); Cmd.afterCalib(); },
    adjustScale: function (dx, dy) {
      ST.scaleX = DMM.clamp(Number((ST.scaleX + (dx || 0)).toFixed(3)), 0.05, 4);
      ST.scaleY = DMM.clamp(Number((ST.scaleY + (dy || 0)).toFixed(3)), 0.05, 4);
      Cmd.afterCalib();
    },
    resetTransform: function () {
      ST.offsetX = Cfg.DEF_OFFSET_X; ST.offsetY = Cfg.DEF_OFFSET_Y;
      ST.scaleX = Cfg.DEF_SCALE_X; ST.scaleY = Cfg.DEF_SCALE_Y;
      Cmd.afterCalib();
    },
    adjustMarkerScale: function (d) { ST.markerScale = DMM.clamp(Number((ST.markerScale + d).toFixed(2)), 0.4, 3); Cmd.afterCalib(); },
    afterCalib: function () { Settings.save(); Runtime.repositionAll(); SettingsUI.update(); },

    adjustFadeHold: function (d) { ST.fadeHoldMs = DMM.clamp(ST.fadeHoldMs + d * 1000, 0, 60000); Cmd.afterFade(); },
    adjustPersistence: function (d) { ST.persistenceMs = DMM.clamp(ST.persistenceMs + d * 1000, 3000, 120000); Cmd.afterFade(); },
    adjustStartOpacity: function (d) { ST.lingerStartOpacity = DMM.clamp(Number((ST.lingerStartOpacity + d).toFixed(2)), 0.02, 1); Cmd.afterFade(); },
    adjustEndOpacity: function (d) { ST.lingerEndOpacity = DMM.clamp(Number((ST.lingerEndOpacity + d).toFixed(2)), 0.02, 1); Cmd.afterFade(); },
    resetFade: function () {
      ST.persistenceMs = Cfg.DEF_PERSISTENCE_MS; ST.fadeHoldMs = Cfg.DEF_FADE_HOLD_MS;
      ST.lingerStartOpacity = Cfg.DEF_LINGER_START_OPACITY; ST.lingerEndOpacity = Cfg.DEF_LINGER_END_OPACITY;
      Cmd.afterFade();
    },
    afterFade: function () { Settings.save(); SettingsUI.update(); },

    makeCode: function () {
      return "ox=" + ST.offsetX + ";oy=" + ST.offsetY + ";sx=" + ST.scaleX.toFixed(3) + ";sy=" + ST.scaleY.toFixed(3);
    },
    applyCode: function (code) {
      var m = String(code || "");
      var ox = m.match(/ox=(-?\d+(?:\.\d+)?)/), oy = m.match(/oy=(-?\d+(?:\.\d+)?)/);
      var sx = m.match(/sx=(-?\d+(?:\.\d+)?)/), sy = m.match(/sy=(-?\d+(?:\.\d+)?)/);
      if (ox) ST.offsetX = Number(ox[1]);
      if (oy) ST.offsetY = Number(oy[1]);
      if (sx) ST.scaleX = DMM.clamp(Number(sx[1]), 0.05, 4);
      if (sy) ST.scaleY = DMM.clamp(Number(sy[1]), 0.05, 4);
      Cmd.afterCalib();
    },

    // Same import/export pattern as the Calibration code, for the Linger
    // settings (fade hold, persistence life, start/end opacity). Current
    // values (Cfg.DEF_FADE_HOLD_MS etc.) remain the defaults — this is just a
    // copyable snapshot/restore of whatever they're currently set to.
    makeLingerCode: function () {
      return "hold=" + (ST.fadeHoldMs / 1000) + ";life=" + (ST.persistenceMs / 1000) +
        ";startop=" + ST.lingerStartOpacity.toFixed(3) + ";endop=" + ST.lingerEndOpacity.toFixed(3);
    },
    applyLingerCode: function (code) {
      var m = String(code || "");
      var hold = m.match(/hold=(-?\d+(?:\.\d+)?)/), life = m.match(/life=(-?\d+(?:\.\d+)?)/);
      var sop = m.match(/startop=(-?\d+(?:\.\d+)?)/), eop = m.match(/endop=(-?\d+(?:\.\d+)?)/);
      if (hold) ST.fadeHoldMs = DMM.clamp(Number(hold[1]) * 1000, 0, 60000);
      if (life) ST.persistenceMs = DMM.clamp(Number(life[1]) * 1000, 3000, 120000);
      if (sop) ST.lingerStartOpacity = DMM.clamp(Number(sop[1]), 0.02, 1);
      if (eop) ST.lingerEndOpacity = DMM.clamp(Number(eop[1]), 0.02, 1);
      Cmd.afterFade();
    },

    selectSlot: function (id) { ST.selectedSlotId = id | 0; SettingsUI.update(); SettingsUI.populateGrid(); },
    // Picking a hero for a slot is now the only way to assign one (grid
    // buttons only — no free-text entry, no separate clear button). If the
    // pick collides with a sibling in the same lane, LaneAssist.resolveConflict
    // resolves it (swap by elimination, or leaves the sibling unassigned).
    setSlotHero: function (id, hero) {
      var slot = slotById(id | 0); if (!slot) return;
      slot.customName = DMM.canonicalHeroName(hero) || "";
      slot.label = slot.customName || String(slot.id);
      slot.manualOverride = !!slot.customName;
      LaneAssist.resolveConflict(slot);
      Runtime.maybeDisableLiveAfterAssignments();
      Trackers.maybeLockPostSolve();
      SettingsUI.update(); SettingsUI.populateGrid();
    }
  };

  // ===========================================================================
  // SettingsUI — populate & sync the XML panel (#LastSpotPanel)
  // ===========================================================================
  var SettingsUI = {
    built: false,
    el: {},

    resolve: function () {
      if (!Panels.refresh()) return false;
      var root = ST.root;
      var panel = DMM.find(root, "LastSpotPanel");
      if (!DMM.valid(panel)) return false;
      var E = SettingsUI.el;
      E.panel = panel;
      E.enableBtn = DMM.find(root, "LastSpotEnableBtn");
      E.enableLabel = DMM.find(root, "LastSpotEnableLabel");
      E.status = DMM.find(root, "LastSpotStatus");
      E.slots = DMM.find(root, "LastSpotSlots");
      E.pickerSel = DMM.find(root, "LastSpotPickerSelected");
      E.heroGrid = DMM.find(root, "LastSpotHeroGrid");
      E.transformLabel = DMM.find(root, "LastSpotTransformLabel");
      E.codeEntry = DMM.find(root, "LastSpotCodeEntry");
      E.fadeLabel = DMM.find(root, "LastSpotFadeLabel");
      E.lingerCodeEntry = DMM.find(root, "LastSpotLingerCodeEntry");
      return true;
    },

    build: function () {
      if (SettingsUI.built) return true;
      if (!SettingsUI.resolve()) return false;
      SettingsUI.populateSlots();
      SettingsUI.populateGrid();
      SettingsUI.built = true;
      return true;
    },

    // Display order: by LANE (left->middle->right, already mirror-corrected
    // to true visual screen position by LaneAssist.laneForX — see that fix),
    // not sequential tracker ID. This means Hidden King shows Yellow IDs
    // first (its left lane), then Blue, then Green; ArchMother shows Green
    // first (its left lane), then Blue, then Yellow — same left->right rule,
    // different colors per side. Slots without a lane yet sort last.
    laneOrderSignature: function () {
      var parts = [];
      for (var i = 0; i < slots.length; i++) parts.push(slots[i].id + ":" + (slots[i].laneKey || "?"));
      return parts.join(",");
    },

    populateSlots: function () {
      var host = SettingsUI.el.slots;
      if (!DMM.valid(host)) return;
      try { host.RemoveAndDeleteChildren(); } catch (e) {}
      var ordered = slots.slice(0).sort(function (a, b) {
        var ar = LaneAssist.laneRank({ key: a.laneKey }), br = LaneAssist.laneRank({ key: b.laneKey });
        if (ar !== br) return ar - br;
        return a.id - b.id;
      });
      SettingsUI.lastSlotOrderSig = SettingsUI.laneOrderSignature();
      for (var i = 0; i < ordered.length; i++) {
        (function (slot) {
          var row = $.CreatePanel("Panel", host, "LSSlotRow" + slot.id);
          row.AddClass("ls-slot-row");
          var chip = $.CreatePanel("Label", row, "");
          chip.AddClass("ls-slot-id");
          chip.text = String(slot.id);
          var name = $.CreatePanel("Label", row, "");
          name.AddClass("ls-slot-name");
          name.text = slot.customName || ("ID " + slot.id);
          try { row.SetPanelEvent("onactivate", function () { Cmd.selectSlot(slot.id); }); } catch (e) {}
          row.__lsChip = chip; row.__lsName = name; row.__lsId = slot.id;
        })(ordered[i]);
      }
    },

    // Signature of everything that affects the picker grid's contents — used
    // to refresh it event-drivenly (whenever lane assist resolves/changes a
    // candidate list) instead of only on manual slot reselection.
    pickerSignature: function () {
      var slot = slotById(ST.selectedSlotId);
      if (!slot) return "none";
      return ST.selectedSlotId + ":" + (slot.customName || "") + ":" + (slot.laneCandidates || []).join("|");
    },

    // The grid lists ONLY the selected ID's lane-assist candidates (empty until
    // lane assist resolves that lane). Grid-only — no free-text entry; every
    // candidate hero for the lane stays listed/clickable regardless of which
    // sibling ID currently holds it, so a wrong pick can always be corrected
    // (Cmd.setSlotHero + LaneAssist.resolveConflict handles the swap).
    populateGrid: function () {
      var host = SettingsUI.el.heroGrid;
      if (!DMM.valid(host)) return;
      try { host.RemoveAndDeleteChildren(); } catch (e) {}
      SettingsUI.lastPickerSig = SettingsUI.pickerSignature();
      var slot = slotById(ST.selectedSlotId);
      var list = (slot && slot.laneCandidates && slot.laneCandidates.length) ? slot.laneCandidates.slice(0) : [];
      for (var i = 0; i < list.length; i++) {
        (function (hero) {
          var canon = DMM.canonicalHeroName(hero);
          if (!canon) return;
          var cell = $.CreatePanel("Button", host, "");
          cell.AddClass("ls-hero-cell");
          if (slot && DMM.canonicalHeroName(slot.customName) === canon) cell.AddClass("selected");
          var lbl = $.CreatePanel("Label", cell, "");
          lbl.AddClass("ls-hero-cell-label");
          lbl.text = canon;
          try { cell.SetPanelEvent("onactivate", function () { Cmd.setSlotHero(ST.selectedSlotId, canon); }); } catch (e) {}
        })(list[i]);
      }
    },

    update: function () {
      var E = SettingsUI.el;
      if (!DMM.valid(E.panel)) return;
      // enable button
      if (DMM.valid(E.enableBtn)) DMM.setClass(E.enableBtn, "off", !ST.enabled);
      if (DMM.valid(E.enableLabel)) { try { E.enableLabel.text = ST.enabled ? "ENABLED" : "DISABLED"; } catch (e) {} }
      // status
      if (DMM.valid(E.status)) {
        try {
          E.status.text = "Team: " + teamCfg().label + "   Tracked: " + enemyState.size +
            "   Lane: " + ST.laneSummary + "   " + (ST.showLive ? "Live marks ON" : "Live marks off");
        } catch (e) {}
      }
      // slot rows — rebuild (reorder) if lane assignments changed since last render
      if (DMM.valid(E.slots) && SettingsUI.laneOrderSignature() !== SettingsUI.lastSlotOrderSig) {
        SettingsUI.populateSlots();
      }
      if (DMM.valid(E.slots)) {
        var n = DMM.childCount(E.slots);
        for (var i = 0; i < n; i++) {
          var row = DMM.childAt(E.slots, i);
          if (!DMM.valid(row)) continue;
          var slot = slotById(row.__lsId);
          if (!slot) continue;
          DMM.setClass(row, "selected", slot.id === ST.selectedSlotId);
          if (DMM.valid(row.__lsName)) {
            try {
              row.__lsName.text = slot.customName || ("ID " + slot.id);
              DMM.setClass(row.__lsName, "unassigned", !slot.customName);
            } catch (e) {}
          }
          if (DMM.valid(row.__lsChip)) {
            var chip = row.__lsChip;
            chip.RemoveClass("ls-lane-left"); chip.RemoveClass("ls-lane-middle"); chip.RemoveClass("ls-lane-right");
            var pending = ST.laneAssistEnabled && slot.laneKey && !DMM.canonicalHeroName(slot.customName);
            if (pending) chip.AddClass("ls-lane-" + LaneAssist.laneColorKey(slot.laneKey));
          }
        }
      }
      // hero picker grid — refresh whenever its inputs change (lane assist
      // resolving/narrowing candidates), not only on manual slot reselection.
      if (DMM.valid(E.heroGrid) && SettingsUI.pickerSignature() !== SettingsUI.lastPickerSig) {
        SettingsUI.populateGrid();
      }
      // picker selected label
      if (DMM.valid(E.pickerSel)) {
        var sel = slotById(ST.selectedSlotId);
        try { E.pickerSel.text = "Assigning ID " + ST.selectedSlotId + (sel && sel.customName ? " — " + sel.customName : ""); } catch (e) {}
      }
      // calibration + fade labels
      if (DMM.valid(E.transformLabel)) { try { E.transformLabel.text = "Offset " + ST.offsetX + "," + ST.offsetY + "   Scale " + ST.scaleX.toFixed(2) + "," + ST.scaleY.toFixed(2) + "   Icon " + ST.markerScale.toFixed(2); } catch (e) {} }
      if (DMM.valid(E.fadeLabel)) { try { E.fadeLabel.text = "Hold " + (ST.fadeHoldMs / 1000).toFixed(0) + "s   Life " + (ST.persistenceMs / 1000).toFixed(0) + "s   Opacity " + ST.lingerStartOpacity.toFixed(2) + " -> " + ST.lingerEndOpacity.toFixed(2); } catch (e) {} }
      if (DMM.valid(E.codeEntry)) { try { if (!E.codeEntry.__lsTouched) E.codeEntry.text = Cmd.makeCode(); } catch (e) {} }
      if (DMM.valid(E.lingerCodeEntry)) { try { if (!E.lingerCodeEntry.__lsTouched) E.lingerCodeEntry.text = Cmd.makeLingerCode(); } catch (e) {} }
    },

    setVisible: function (v) {
      ST.settingsVisible = !!v;
      if (v && !SettingsUI.build()) return;
      var panel = SettingsUI.el.panel;
      if (DMM.valid(panel)) DMM.setClass(panel, "hidden", !v);
      if (v) { SettingsUI.populateGrid(); SettingsUI.update(); }
    },
    toggle: function () { SettingsUI.setVisible(!ST.settingsVisible); },

    bindKey: function () {
      if (ST.keybindBound) return;
      var ctx = $.GetContextPanel();
      try { $.RegisterKeyBind(ctx, Cfg.SETTINGS_KEYBIND, SettingsUI.toggle); ST.keybindBound = true; } catch (e) {}
      try { $.RegisterKeyBind("", Cfg.SETTINGS_KEYBIND, SettingsUI.toggle); ST.keybindBound = true; } catch (e) {}
      if (!ST.keybindBound) DMM.schedule(0.25, SettingsUI.bindKey);
    }
  };

  // Reposition all live/linger markers after a calibration change.
  Runtime.repositionAll = function () {
    enemyState.forEach(function (entry) {
      if (!entry) return;
      if (DMM.valid(entry.liveMarker) && entry.wasVisible) Markers.position(entry.liveMarker, entry, Cfg.LIVE_MARKER_LEFT_OFFSET_PX);
      if (entry.lingerUntilMs > 0) Markers.position(entry.lingerMarker, entry, 0);
    });
  };

  // Global command dispatcher used by the XML panel's onactivate handlers.
  G.LastSpotCmd = function (cmd, a, b) {
    switch (cmd) {
      case "enable": Cmd.toggleEnabled(); break;
      case "offset": Cmd.adjustOffset(a, b); break;
      case "scale": Cmd.adjustScale(a, b); break;
      case "resetTransform": Cmd.resetTransform(); break;
      case "icon": Cmd.adjustMarkerScale(a); break;
      case "hold": Cmd.adjustFadeHold(a); break;
      case "life": Cmd.adjustPersistence(a); break;
      case "startOp": Cmd.adjustStartOpacity(a); break;
      case "endOp": Cmd.adjustEndOpacity(a); break;
      case "resetFade": Cmd.resetFade(); break;
      case "applyCode":
        try { var e = DMM.find(ST.root, "LastSpotCodeEntry"); if (DMM.valid(e)) Cmd.applyCode(e.text); } catch (er) {}
        break;
      case "codeTouched":
        try { var ce = DMM.find(ST.root, "LastSpotCodeEntry"); if (DMM.valid(ce)) ce.__lsTouched = true; } catch (er) {}
        break;
      case "applyLingerCode":
        try { var le = DMM.find(ST.root, "LastSpotLingerCodeEntry"); if (DMM.valid(le)) Cmd.applyLingerCode(le.text); } catch (er) {}
        break;
      case "lingerCodeTouched":
        try { var lce = DMM.find(ST.root, "LastSpotLingerCodeEntry"); if (DMM.valid(lce)) lce.__lsTouched = true; } catch (er) {}
        break;
      case "close": SettingsUI.setVisible(false); break;
    }
  };

  // ===========================================================================
  // Boot
  // ===========================================================================
  function statusLoop() {
    if (ST.settingsVisible) SettingsUI.update();
    ST.statusHandle = DMM.schedule(Cfg.STATUS_MS / 1000, statusLoop);
  }

  function boot() {
    if (!Panels.refresh()) { DMM.schedule(0.5, boot); return; }
    Settings.load();
    SettingsUI.bindKey();
    Scanner.loop();
    TopBar.start();
    statusLoop();
    log.log("booted v2", true);
  }

  // expose a tiny debug API on the context panel for console poking
  try {
    var ctx = $.GetContextPanel();
    if (ctx) {
      ctx.LastSpotToggleDebug = function () { ST.debug = !ST.debug; log.setEnabled(ST.debug); perf.setEnabled(ST.debug); log.log("debug=" + ST.debug, true); };
      ctx.LastSpotToggleTopbarDiag = function () { ST.topbarDiag = !ST.topbarDiag; log.log("topbarDiag=" + ST.topbarDiag, true); };
      ctx.LastSpotClear = function () { Trackers.clear(); };
      ctx.LastSpotPerf = function () { log.log(perf.snapshot(false), true); };
      ctx.LastSpotDumpTopBar = function () { var was = log.isEnabled(); log.setEnabled(true); TopBar.dump(); log.setEnabled(was); };
      ctx.LastSpotNames = function () { log.log("enemy_names=" + ST.enemyHeroNames.join("|") + " ally_names=" + ST.friendlyHeroNames.join("|"), true); };
      // Console-only manual probe (the UI button was removed — hero picking
      // is grid-only now). Same path the automatic gametime-gated timer uses.
      ctx.LastSpotProbeNames = function () {
        log.log("===== MANUAL TOPBAR PROBE (copy from here) =====", true);
        TopBar.dump("manual");
        ST.nameAttempts++;
        TopBar.warm("manual", true);
        log.log("===== MANUAL TOPBAR PROBE END =====", true);
      };
    }
  } catch (e) {}

  DMM.schedule(1.0, boot);
})();
