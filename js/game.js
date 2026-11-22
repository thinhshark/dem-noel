/**
 * Đêm Noel — endless runner 3 làn, chơi trong webview.
 *
 * Game báo ra ngoài qua:
 *   window.onSantaRunnerEvent?.(payload)
 *   window.postMessage(payload, "*")
 *   parent.postMessage nếu đang nằm trong iframe
 *   ReactNativeWebView / flutter_inappwebview / SantaBridge nếu app gắn sẵn
 *
 * payload.source luôn là "santa-runner".
 * type: ready | start | pause | resume | collect | milestone | gameover | continue
 *
 * App điều khiển game:
 *   SantaRunner.pause()
 *   SantaRunner.resume()
 *   SantaRunner.restart()
 *   SantaRunner.continueRun()   // hồi sinh do app chủ động, game không có nút này
 *   SantaRunner.getState()
 *   postMessage { source: "santa-runner-host", type: "pause"|"resume"|"restart"|"continue" }
 */
(() => {
  "use strict";

  const VERSION = "1.0.0";

  const CONFIG = {
    cam: 9,
    spawnZ: 20.5,
    scoreRate: 2.2,
    jumpDuration: 0.62,
    slideDuration: 0.56,
    shieldTime: 5,
    slowTime: 5,
    slowFactor: 0.62,
    giftPoints: 100,
    giftBonus: 25,
    grace: 1.35,
    minGap: 6.8,
    swipe: 30,
  };

  // Mốc điểm → tốc độ (m/s). Nhịp đầu nhanh, sau đó mỗi mốc dài hơn.
  const TIERS = [
    { score: 0, speed: 7.2, label: "" },
    { score: 120, speed: 8.1, label: "Tăng tốc" },
    { score: 320, speed: 9.0, label: "Tăng tốc" },
    { score: 600, speed: 9.8, label: "Nhanh hơn" },
    { score: 1000, speed: 10.6, label: "Tăng tốc" },
    { score: 1550, speed: 11.3, label: "Rất nhanh" },
    { score: 2300, speed: 12.0, label: "Tăng tốc" },
    { score: 3200, speed: 12.6, label: "Tốc độ tối đa" },
  ];

  const DEATH_LINE = {
    car: "Đâm phải ô tô",
    van: "Đụng phải xe tải",
    barrier: "Vướng rào chắn",
    hole: "Rơi xuống cống",
  };

  const CARS = [
    ["#d64545", "#9d2e2e"],
    ["#2f6f8f", "#1d4e66"],
    ["#3e6b4f", "#274936"],
    ["#e6e1d6", "#b7b1a4"],
    ["#3d4c7a", "#2a3558"],
    ["#c47b2b", "#8d571c"],
  ];

  const WALLS = ["#8d3d4c", "#245546", "#314e78", "#6e4b32"];
  const BEST_KEY = "santa-runner-best";
  const MUTE_KEY = "santa-runner-muted";
  const DEBUG = new URLSearchParams(location.search).has("debug");

  const $ = (id) => document.getElementById(id);

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  function storageGet(key) {
    try { return localStorage.getItem(key); } catch (err) { return null; }
  }

  function storageSet(key, value) {
    try { localStorage.setItem(key, value); } catch (err) { /* webview riêng tư */ }
  }

  function formatScore(n) {
    return Math.max(0, Math.floor(n)).toLocaleString("vi-VN");
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, t) {
    const A = hexToRgb(a);
    const B = hexToRgb(b);
    const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
    return "rgb(" + c[0] + ", " + c[1] + ", " + c[2] + ")";
  }

  function shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }

  function emit(type, extra) {
    const msg = Object.assign({
      source: "santa-runner",
      version: VERSION,
      type: type,
      ts: Date.now(),
    }, extra || {});
    try { if (window.onSantaRunnerEvent) window.onSantaRunnerEvent(msg); } catch (err) {}
    try { window.dispatchEvent(new CustomEvent("santa-runner", { detail: msg })); } catch (err) {}
    try { window.postMessage(msg, "*"); } catch (err) {}
    try {
      if (window.parent && window.parent !== window) window.parent.postMessage(msg, "*");
    } catch (err) {}
    try {
      if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    } catch (err) {}
    try {
      if (window.flutter_inappwebview) window.flutter_inappwebview.callHandler("SantaRunner", msg);
    } catch (err) {}
    try {
      if (window.SantaBridge && window.SantaBridge.onEvent) {
        window.SantaBridge.onEvent(JSON.stringify(msg));
      }
    } catch (err) {}
  }

  function roundRect(ctx, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  class Sfx {
    constructor() {
      this.muted = storageGet(MUTE_KEY) === "1";
      this.ctx = null;
    }

    unlock() {
      if (this.muted) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!this.ctx) this.ctx = new Ctx();
      if (this.ctx.state === "suspended") this.ctx.resume();
    }

    tone(freq, when, dur, type, gain) {
      if (this.muted || !this.ctx) return;
      const ctx = this.ctx;
      const start = ctx.currentTime + when;
      const osc = ctx.createOscillator();
      const amp = ctx.createGain();
      osc.type = type || "sine";
      osc.frequency.setValueAtTime(freq, start);
      amp.gain.setValueAtTime(Math.max(0.0001, gain), start);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(amp);
      amp.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.02);
    }

    noise(dur, gain) {
      if (this.muted || !this.ctx) return;
      const ctx = this.ctx;
      const length = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
      const src = ctx.createBufferSource();
      const amp = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 420;
      src.buffer = buffer;
      amp.gain.value = gain;
      src.connect(filter);
      filter.connect(amp);
      amp.connect(ctx.destination);
      src.start();
    }

    tick() { this.tone(520, 0, 0.05, "square", 0.03); }
    bump() { this.tone(180, 0, 0.07, "sine", 0.04); }
    jump() { this.tone(460, 0, 0.09, "square", 0.035); }
    slide() { this.noise(0.12, 0.05); }
    coin() {
      this.tone(880, 0, 0.08, "sine", 0.05);
      this.tone(1320, 0.07, 0.12, "sine", 0.04);
    }
    shield() {
      this.tone(660, 0, 0.08, "sine", 0.04);
      this.tone(990, 0.08, 0.1, "sine", 0.04);
      this.tone(1320, 0.16, 0.16, "sine", 0.035);
    }
    slow() { this.tone(520, 0, 0.12, "triangle", 0.04); this.tone(340, 0.08, 0.16, "sine", 0.035); }
    phase() { this.tone(990, 0, 0.1, "sine", 0.04); }
    milestone() {
      this.tone(523, 0, 0.1, "sine", 0.04);
      this.tone(659, 0.09, 0.1, "sine", 0.04);
      this.tone(784, 0.18, 0.16, "sine", 0.045);
    }
    crash() {
      this.noise(0.28, 0.12);
      this.tone(110, 0, 0.28, "sawtooth", 0.05);
    }
  }

  class Game {
    constructor() {
      this.canvas = $("game");
      this.ctx = this.canvas.getContext("2d");
      this.sfx = new Sfx();
      this.els = {
        score: $("score"),
        bestHud: $("best-hud"),
        tiers: $("tiers"),
        scoreboard: $("scoreboard"),
        pauseBtn: $("btn-pause"),
        mute: $("btn-mute"),
        shield: $("buff-shield"),
        shieldT: $("buff-shield-t"),
        slow: $("buff-slow"),
        slowT: $("buff-slow-t"),
        toast: $("toast"),
        hint: $("hint"),
        startScreen: $("screen-start"),
        pauseScreen: $("screen-pause"),
        overScreen: $("screen-over"),
        bestStart: $("best-start"),
        pauseScore: $("pause-score"),
        overTitle: $("over-title"),
        overScore: $("over-score"),
        overBest: $("over-best"),
        overRecord: $("over-record"),
      };
      this.best = Math.max(0, parseInt(storageGet(BEST_KEY) || "0", 10) || 0);
      this.reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      this.tierDots = [];
      this.pointer = null;
      this.stars = [];
      this.snow = [];
      this.time = 0;
      this.dpr = 1;
      this.w = 1;
      this.h = 1;
      this.buildTiers();
      this.seedSky();
      this.resetRun(false);
      this.resize();
      this.ensureProps(true);
      this.bind();
      this.renderMute();
      this.paintTiers();
      this.els.bestStart.textContent = this.best > 0 ? formatScore(this.best) : "chưa có";
      this.syncHud(true);
      this.applyChrome();
      emit("ready", { best: this.best });
    }

    buildTiers() {
      this.els.tiers.textContent = "";
      this.tierDots = TIERS.map(() => {
        const dot = document.createElement("i");
        this.els.tiers.appendChild(dot);
        return dot;
      });
    }

    seedSky() {
      this.stars = Array.from({ length: 42 }, () => ({
        x: Math.random(),
        y: Math.random() * 0.34,
        r: 0.6 + Math.random() * 1.5,
        p: Math.random() * Math.PI * 2,
      }));
      const count = this.reduceMotion ? 28 : 64;
      this.snow = Array.from({ length: count }, () => this.makeFlake(true));
    }

    makeFlake(anywhere) {
      return {
        x: Math.random(),
        y: anywhere ? Math.random() : -0.04,
        r: Math.random() < 0.82 ? 1 + Math.random() * 1.5 : 2.4 + Math.random() * 2,
        v: 0.05 + Math.random() * 0.11,
        drift: Math.random() * Math.PI * 2,
        front: Math.random() < 0.2,
      };
    }

    resetRun(playing) {
      this.state = playing ? "playing" : "ready";
      this.score = 0;
      this.shownScore = -1;
      this.tier = 0;
      this.baseSpeed = TIERS[0].speed;
      this.speed = playing ? this.baseSpeed : 5.2;
      this.lane = 1;
      this.laneVisual = 1;
      this.travel = 0;
      this.actors = [];
      this.props = [];
      this.particles = [];
      this.floats = [];
      this.jumpT = -1;
      this.slideT = -1;
      this.shield = 0;
      this.slow = 0;
      this.grace = CONFIG.grace;
      this.rowAccum = 0;
      this.pendingGap = 11;
      this.lastBlockAt = [-999, -999, -999];
      this.hintT = playing ? 4.2 : 0;
      this.resumeGrace = 0;
      this.toastT = 0;
      this.toastText = "";
      this.deathT = 0;
      this.deathType = "";
      this.shake = 0;
      this.calm = 0;
      this.phase = 0;
      this.surpassed = false;
      this.popScore = false;
      this.reported = false;
      this.unfair = 0;
    }

    bind() {
      $("btn-start").addEventListener("click", () => this.start());
      $("btn-retry").addEventListener("click", () => this.start());
      $("btn-pause").addEventListener("click", () => this.pause());
      $("btn-resume").addEventListener("click", () => this.resume());
      this.els.mute.addEventListener("click", () => this.toggleMute());

      window.addEventListener("pointerdown", (e) => this.onPointerDown(e));
      window.addEventListener("pointerup", (e) => this.onPointerUp(e));
      window.addEventListener("pointercancel", (e) => {
        if (this.pointer && e.pointerId === this.pointer.id) this.pointer = null;
      });
      document.body.addEventListener("touchmove", (e) => {
        if (e.target.closest && e.target.closest(".card")) return;
        e.preventDefault();
      }, { passive: false });
      window.addEventListener("keydown", (e) => this.onKey(e));
      window.addEventListener("resize", () => this.resize());
      if (window.visualViewport) window.visualViewport.addEventListener("resize", () => this.resize());
      document.addEventListener("visibilitychange", () => {
        if (document.hidden && this.state === "playing") this.pause();
      });
      window.addEventListener("message", (event) => this.onHostMessage(event));
      this.canvas.tabIndex = 0;
    }

    onHostMessage(event) {
      let data = event.data;
      if (typeof data === "string") {
        try { data = JSON.parse(data); } catch (err) { return; }
      }
      if (!data || data.source !== "santa-runner-host") return;
      if (data.type === "pause") this.pause();
      else if (data.type === "resume") this.resume();
      else if (data.type === "restart") this.start();
      else if (data.type === "continue") this.continueRun();
      else if (data.type === "mute") this.setMuted(true);
      else if (data.type === "unmute") this.setMuted(false);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const width = Math.max(1, rect.width || window.innerWidth);
      const height = Math.max(1, rect.height || window.innerHeight);
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.round(width * this.dpr);
      this.canvas.height = Math.round(height * this.dpr);
      this.w = width;
      this.h = height;
      this.playW = Math.min(width, height * 0.58);
      this.originX = (width - this.playW) / 2;
      this.horizon = height * 0.4;
      this.groundY = height * 0.84;
      this.laneSpread = this.playW * 0.2;
      this.cam = CONFIG.cam;
    }

    project(lane, z) {
      const depth = z < -this.cam + 0.45 ? -this.cam + 0.45 : z;
      const scale = this.cam / (this.cam + depth);
      return {
        x: this.originX + this.playW * 0.5 + (lane - 1) * this.laneSpread * scale,
        y: this.horizon + (this.groundY - this.horizon) * scale,
        scale: scale,
      };
    }

    traceQuad(laneL, laneR, zNear, zFar) {
      const a = this.project(laneL, zNear);
      const b = this.project(laneR, zNear);
      const c = this.project(laneR, zFar);
      const d = this.project(laneL, zFar);
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(d.x, d.y);
      ctx.closePath();
    }

    start() {
      this.resetRun(true);
      this.ensureProps(true);
      this.paintTiers();
      this.sfx.unlock();
      this.applyChrome();
      this.syncHud(true);
      this.canvas.focus();
      emit("start", { best: this.best });
    }

    pause() {
      if (this.state !== "playing") return;
      this.state = "paused";
      this.els.pauseScore.textContent = "Điểm " + formatScore(this.score);
      this.applyChrome();
      emit("pause", { score: Math.floor(this.score) });
    }

    resume() {
      if (this.state !== "paused") return;
      this.state = "playing";
      this.resumeGrace = 0.4;
      this.applyChrome();
      emit("resume", { score: Math.floor(this.score) });
    }

    continueRun() {
      if (this.state !== "over" && this.state !== "dying") return false;
      const lane = this.lane;
      this.actors = this.actors.filter((actor) => {
        return !(actor.kind === "obstacle" && actor.lane === lane && actor.z < 8);
      });
      this.shield = Math.max(this.shield, 2.6);
      this.state = "playing";
      this.deathT = 0;
      this.shake = 0;
      this.reported = false;
      this.applyChrome();
      emit("continue", { score: Math.floor(this.score) });
      return true;
    }

    toggleMute() {
      this.setMuted(!this.sfx.muted);
    }

    setMuted(muted) {
      this.sfx.muted = !!muted;
      storageSet(MUTE_KEY, this.sfx.muted ? "1" : "0");
      if (!this.sfx.muted) this.sfx.unlock();
      this.renderMute();
    }

    renderMute() {
      this.els.mute.classList.toggle("is-off", this.sfx.muted);
      this.els.mute.setAttribute("aria-label", this.sfx.muted ? "Bật âm thanh" : "Tắt âm thanh");
    }

    applyChrome() {
      const showScore = this.state === "playing" || this.state === "paused" || this.state === "dying";
      this.els.scoreboard.hidden = !showScore;
      this.els.pauseBtn.hidden = this.state !== "playing";
      this.els.startScreen.hidden = this.state !== "ready";
      this.els.pauseScreen.hidden = this.state !== "paused";
      this.els.overScreen.hidden = this.state !== "over";
    }

    onPointerDown(e) {
      if (e.button !== undefined && e.button !== 0) return;
      if (e.target.closest && e.target.closest("button")) {
        this.pointer = null;
        return;
      }
      if (this.pointer) return;
      this.pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    }

    onPointerUp(e) {
      if (!this.pointer || e.pointerId !== this.pointer.id) return;
      const dx = e.clientX - this.pointer.x;
      const dy = e.clientY - this.pointer.y;
      this.pointer = null;
      const dist = Math.hypot(dx, dy);
      if (dist < CONFIG.swipe) {
        if (this.state === "ready") this.start();
        return;
      }
      if (this.state !== "playing") return;
      if (Math.abs(dx) > Math.abs(dy)) this.shift(dx < 0 ? -1 : 1);
      else if (dy < 0) this.jump();
      else this.slide();
    }

    onKey(e) {
      const arrows = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "];
      if (arrows.indexOf(e.key) !== -1) e.preventDefault();
      if (e.repeat) return;
      if (e.key === "Escape") {
        if (this.state === "playing") this.pause();
        else if (this.state === "paused") this.resume();
        return;
      }
      if (e.key === "Enter") {
        if (this.state === "ready" || this.state === "over") this.start();
        else if (this.state === "paused") this.resume();
        return;
      }
      if ((e.key === " " || e.key === "Spacebar") && (this.state === "ready" || this.state === "over")) {
        this.start();
        return;
      }
      if (this.state !== "playing") return;
      if (e.key === "ArrowLeft" || e.key === "a" || e.key === "A") this.shift(-1);
      else if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") this.shift(1);
      else if (e.key === "ArrowUp" || e.key === "w" || e.key === "W" || e.key === " ") this.jump();
      else if (e.key === "ArrowDown" || e.key === "s" || e.key === "S") this.slide();
    }

    shift(dir) {
      if (this.state !== "playing") return;
      const next = this.lane + dir;
      if (next < 0 || next > 2) {
        this.sfx.bump();
        this.shake = Math.max(this.shake, this.reduceMotion ? 0 : 0.18);
        return;
      }
      this.lane = next;
      this.sfx.tick();
    }

    jump() {
      if (this.state !== "playing") return;
      if (this.jumpT >= 0 || this.slideT >= 0) return;
      this.jumpT = 0;
      this.sfx.jump();
    }

    slide() {
      if (this.state !== "playing") return;
      if (this.jumpT >= 0 || this.slideT >= 0) return;
      this.slideT = 0;
      this.sfx.slide();
    }

    jumpingClear() {
      if (this.jumpT < 0 || this.jumpT >= 1) return false;
      return Math.sin(this.jumpT * Math.PI) > 0.22;
    }

    sliding() {
      return this.slideT >= 0 && this.slideT < 1;
    }

    dayT() {
      return clamp(this.score / 3200, 0, 1);
    }

    difficulty() {
      return this.tier / (TIERS.length - 1);
    }

    update(dt) {
      this.time += dt;
      const moving = this.state === "playing" || this.state === "ready";
      if (moving) this.phase += dt * (7 + this.speed * 0.35);
      this.stepSnow(dt);
      this.stepFx(dt);

      if (this.state === "ready") {
        this.speed = 5.2;
        this.stepScenery(this.speed * dt);
        this.ensureProps(false);
        this.syncHud(false);
        return;
      }
      if (this.state === "paused" || this.state === "over") {
        this.syncHud(false);
        return;
      }
      if (this.state === "dying") {
        this.deathT += dt;
        this.shake = Math.max(0, this.shake - dt * 2.2);
        const crawl = Math.max(0, 2.4 * (1 - this.deathT / 0.4));
        this.stepScenery(crawl * dt);
        if (this.deathT > 0.72) this.finishDeath();
        this.syncHud(false);
        return;
      }

      this.grace = Math.max(0, this.grace - dt);
      this.resumeGrace = Math.max(0, this.resumeGrace - dt);
      this.shield = Math.max(0, this.shield - dt);
      this.slow = Math.max(0, this.slow - dt);
      this.calm = Math.max(0, this.calm - dt);
      this.hintT = Math.max(0, this.hintT - dt);
      this.toastT = Math.max(0, this.toastT - dt);
      if (this.jumpT >= 0) {
        this.jumpT += dt / CONFIG.jumpDuration;
        if (this.jumpT >= 1) this.jumpT = -1;
      }
      if (this.slideT >= 0) {
        this.slideT += dt / CONFIG.slideDuration;
        if (this.slideT >= 1) this.slideT = -1;
      }

      const target = this.baseSpeed * (this.slow > 0 ? CONFIG.slowFactor : 1);
      this.speed += (target - this.speed) * Math.min(1, dt * 2.4);
      const dist = this.speed * dt;
      this.score += dist * CONFIG.scoreRate;
      this.applyTiers();
      if (!this.surpassed && this.best > 0 && this.score > this.best) {
        this.surpassed = true;
        this.toast("Phá kỷ lục");
        this.sfx.milestone();
      }
      this.stepScenery(dist);
      this.ensureProps(false);
      if (this.grace <= 0) {
        this.rowAccum += dist;
        let guard = 0;
        while (this.rowAccum >= this.pendingGap && guard < 3) {
          this.rowAccum -= this.pendingGap;
          this.spawnRow();
          this.pendingGap = this.nextGap();
          guard += 1;
        }
      }
      this.laneVisual += (this.lane - this.laneVisual) * Math.min(1, dt * 14);
      this.collide();
      this.syncHud(false);
    }

    applyTiers() {
      let climbed = false;
      while (this.tier < TIERS.length - 1 && this.score >= TIERS[this.tier + 1].score) {
        this.tier += 1;
        this.baseSpeed = TIERS[this.tier].speed;
        this.calm = 3.2;
        climbed = true;
        const label = TIERS[this.tier].label;
        if (label) {
          this.toast(label);
          this.sfx.milestone();
        }
        emit("milestone", {
          tier: this.tier,
          score: Math.floor(this.score),
          speed: Math.round(this.baseSpeed * 10) / 10,
        });
      }
      if (climbed) this.paintTiers();
    }

    paintTiers() {
      for (let i = 0; i < this.tierDots.length; i++) {
        this.tierDots[i].classList.toggle("on", i <= this.tier);
      }
    }

    stepScenery(dist) {
      this.travel += dist;
      for (let i = 0; i < this.actors.length; i++) this.actors[i].z -= dist;
      for (let i = 0; i < this.props.length; i++) this.props[i].z -= dist;
      if (this.actors.length) this.actors = this.actors.filter((actor) => actor.z > -5);
      if (this.props.length) this.props = this.props.filter((prop) => prop.z > -6);
      for (let i = 0; i < this.actors.length; i++) {
        if (this.actors[i].flash > 0) this.actors[i].flash -= dist * 0.05;
      }
    }

    stepSnow(dt) {
      const rush = this.state === "playing" ? 0.8 + this.speed / 16 : 0.62;
      const slowMul = this.slow > 0 ? 0.62 : 1;
      for (let i = 0; i < this.snow.length; i++) {
        const flake = this.snow[i];
        flake.y += flake.v * rush * slowMul * dt;
        flake.x += Math.sin(this.time * 0.7 + flake.drift) * dt * 0.018;
        if (flake.y > 1.08) {
          flake.y = -0.04;
          flake.x = Math.random();
        }
        if (flake.x < -0.05) flake.x = 1.02;
        if (flake.x > 1.05) flake.x = -0.02;
      }
    }

    stepFx(dt) {
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        p.life -= dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 90 * dt;
      }
      if (this.particles.length) this.particles = this.particles.filter((p) => p.life > 0);
      for (let i = 0; i < this.floats.length; i++) {
        const f = this.floats[i];
        f.life -= dt;
        f.y -= 32 * dt;
      }
      if (this.floats.length) this.floats = this.floats.filter((f) => f.life > 0);
    }

    ensureProps(reset) {
      if (reset) this.props = [];
      let maxZ = reset ? -2 : -2;
      if (!reset) {
        for (let i = 0; i < this.props.length; i++) {
          if (this.props[i].z > maxZ) maxZ = this.props[i].z;
        }
      }
      let guard = 0;
      while (maxZ < 28 && guard < 40) {
        maxZ += 3.1 + Math.random() * 2.3;
        const side = Math.random() < 0.5 ? -1 : 1;
        this.props.push(this.makeProp(side, maxZ));
        if (Math.random() < 0.72) this.props.push(this.makeProp(-side, maxZ + 0.6 + Math.random() * 0.8));
        guard += 1;
      }
    }

    makeProp(side, z) {
      const roll = Math.random();
      const type = roll < 0.4 ? "tree" : roll < 0.62 ? "lamp" : "house";
      return { type: type, side: side, z: z, variant: Math.floor(Math.random() * 4) };
    }

    nextGap() {
      const diff = this.difficulty();
      const bonus = this.calm > 0 ? 1.5 : 0;
      const gap = 8.7 - diff * 1.35 + bonus;
      return Math.max(CONFIG.minGap, gap * (0.92 + Math.random() * 0.16));
    }

    rollObstacle() {
      const roll = Math.random();
      if (roll < 0.34) return "car";
      if (roll < 0.5) return "van";
      if (roll < 0.75) return "barrier";
      return "hole";
    }

    depthFor(type, speed) {
      if (type === "hole") return Math.max(2.2, speed * 0.32);
      if (type === "barrier") return Math.max(1.85, speed * 0.27);
      return Math.max(2.25, speed * 0.25);
    }

    laneBlocked(lane, z, depth) {
      for (let i = 0; i < this.actors.length; i++) {
        const actor = this.actors[i];
        if (actor.kind !== "obstacle" || actor.lane !== lane) continue;
        if (Math.abs(actor.z - z) < (actor.depth + depth) / 2) return true;
      }
      return false;
    }

    spawnRow() {
      if (this.actors.length > 40) return;
      const speed = Math.max(7, this.speed);
      const diff = this.difficulty();
      const calm = this.calm > 0;
      const spawnZ = CONFIG.spawnZ;
      const at = this.travel + spawnZ;
      const minSep = speed * 1.25;
      const probe = 4.3;
      const physical = [];
      const candidates = [];
      for (let lane = 0; lane < 3; lane++) {
        if (this.laneBlocked(lane, spawnZ, probe)) continue;
        physical.push(lane);
        if (at - this.lastBlockAt[lane] >= minSep) candidates.push(lane);
      }
      const density = calm ? 0.42 : 0.56 + diff * 0.28;
      if (Math.random() > density || candidates.length === 0 || physical.length < 2) {
        this.maybeGift(physical, spawnZ, calm);
        return;
      }
      let count = 1;
      if (candidates.length >= 2 && physical.length === 3 && Math.random() < (calm ? 0.05 : 0.08 + diff * 0.22)) {
        count = 2;
      }
      count = Math.min(count, physical.length - 1, candidates.length);
      shuffle(candidates);
      const chosen = candidates.slice(0, count);
      for (let i = 0; i < chosen.length; i++) {
        const lane = chosen[i];
        const type = this.rollObstacle();
        this.actors.push({
          kind: "obstacle",
          type: type,
          lane: lane,
          z: spawnZ,
          depth: this.depthFor(type, speed),
          variant: Math.floor(Math.random() * CARS.length),
          flash: 0,
          phased: false,
        });
        this.lastBlockAt[lane] = at;
      }
      if (!this.sliceIsFair()) {
        this.unfair += 1;
        this.actors = this.actors.filter((actor) => {
          return !(actor.kind === "obstacle" && Math.abs(actor.z - spawnZ) < 0.05);
        });
        this.maybeGift(physical, spawnZ, calm);
        return;
      }
      const free = physical.filter((lane) => chosen.indexOf(lane) === -1);
      this.maybeGift(free, spawnZ, calm);
    }

    sliceIsFair() {
      for (let z = -1; z <= CONFIG.spawnZ + 1; z += 0.4) {
        const lanes = new Set();
        for (let i = 0; i < this.actors.length; i++) {
          const actor = this.actors[i];
          if (actor.kind !== "obstacle") continue;
          if (Math.abs(actor.z - z) <= actor.depth * 0.5 + 0.08) lanes.add(actor.lane);
        }
        if (lanes.size >= 3) return false;
      }
      return true;
    }

    maybeGift(freeLanes, z, calm) {
      if (!freeLanes.length) return;
      const chance = calm ? 0.74 : 0.48;
      if (Math.random() > chance) return;
      const lane = freeLanes[Math.floor(Math.random() * freeLanes.length)];
      let type = this.rollGift();
      if (freeLanes.length === 1 && type === "slow") {
        type = Math.random() < 0.72 ? "points" : "shield";
      }
      this.actors.push({
        kind: "gift",
        type: type,
        lane: lane,
        z: z,
        depth: 1.35,
        variant: 0,
        flash: 0,
        phased: false,
      });
    }

    rollGift() {
      const roll = Math.random();
      if (roll < 0.5) return "points";
      if (roll < 0.78) return "slow";
      return "shield";
    }

    collide() {
      for (let i = 0; i < this.actors.length; i++) {
        const actor = this.actors[i];
        if (actor.lane !== this.lane) continue;
        if (Math.abs(actor.z) > actor.depth * 0.5) continue;
        if (actor.kind === "gift") {
          this.collect(actor);
          continue;
        }
        if (actor.type === "hole" && this.jumpingClear()) continue;
        if (actor.type === "barrier" && this.sliding()) continue;
        if (this.resumeGrace > 0) continue;
        if (this.shield > 0) {
          if (!actor.phased) {
            actor.phased = true;
            actor.flash = 0.25;
            this.sfx.phase();
            this.burst(actor, "#ffe08a");
          }
          continue;
        }
        this.kill(actor.type);
        break;
      }
      this.actors = this.actors.filter((actor) => !actor.dead);
    }

    collect(actor) {
      if (actor.dead) return;
      actor.dead = true;
      if (actor.type === "points") {
        this.score += CONFIG.giftPoints;
        this.floatAt(actor, "+" + CONFIG.giftPoints, "#f6e1ad");
        this.sfx.coin();
        this.burst(actor, "#f2d48a");
      } else if (actor.type === "shield") {
        this.shield = Math.min(8, this.shield + CONFIG.shieldTime);
        this.score += CONFIG.giftBonus;
        this.floatAt(actor, "Bất tử", "#ffe1a3");
        this.sfx.shield();
        this.burst(actor, "#fff1c9");
      } else {
        this.slow = Math.min(8, this.slow + CONFIG.slowTime);
        this.score += CONFIG.giftBonus;
        this.floatAt(actor, "Chậm lại", "#c8eef8");
        this.sfx.slow();
        this.burst(actor, "#9ad7ea");
      }
      this.popScore = true;
      emit("collect", { gift: actor.type, score: Math.floor(this.score) });
    }

    kill(type) {
      if (this.state !== "playing") return;
      this.state = "dying";
      this.deathT = 0;
      this.deathType = type || "car";
      this.shake = this.reduceMotion ? 0 : 1;
      this.sfx.crash();
      if (!this.reduceMotion && navigator.vibrate) navigator.vibrate(36);
      this.applyChrome();
    }

    finishDeath() {
      if (this.reported) return;
      this.reported = true;
      this.state = "over";
      const score = Math.floor(this.score);
      const isNew = score > this.best && score > 0;
      if (isNew) {
        this.best = score;
        storageSet(BEST_KEY, String(score));
      }
      this.els.overTitle.textContent = DEATH_LINE[this.deathType] || "Hết đêm";
      this.els.overScore.textContent = formatScore(score);
      this.els.overBest.textContent = "Kỷ lục " + formatScore(this.best);
      this.els.overRecord.hidden = !isNew;
      this.els.bestStart.textContent = this.best > 0 ? formatScore(this.best) : "chưa có";
      this.applyChrome();
      emit("gameover", {
        score: score,
        best: this.best,
        obstacle: this.deathType,
        record: isNew,
      });
    }

    toast(text) {
      this.toastText = text;
      this.toastT = 1.25;
      this.els.toast.textContent = text;
    }

    floatAt(actor, text, color) {
      const p = this.project(actor.lane, Math.max(0, actor.z));
      this.floats.push({
        x: p.x,
        y: p.y - 70 * p.scale,
        text: text,
        color: color,
        life: 0.85,
        max: 0.85,
      });
      if (this.floats.length > 8) this.floats.shift();
    }

    burst(actor, color) {
      const p = this.project(actor.lane, Math.max(-0.2, actor.z));
      for (let i = 0; i < 11; i++) {
        const ang = (Math.PI * 2 * i) / 11 + Math.random() * 0.4;
        const sp = 50 + Math.random() * 110;
        this.particles.push({
          x: p.x,
          y: p.y - 24 * p.scale,
          vx: Math.cos(ang) * sp,
          vy: Math.sin(ang) * sp - 30,
          life: 0.35 + Math.random() * 0.25,
          max: 0.6,
          color: color,
          size: 2 + Math.random() * 2.4,
        });
      }
      if (this.particles.length > 90) this.particles.splice(0, this.particles.length - 90);
    }

    syncHud(force) {
      const score = Math.floor(this.score);
      if (force || score !== this.shownScore) {
        this.els.score.textContent = formatScore(score);
        this.shownScore = score;
        if (this.popScore) {
          this.els.score.classList.remove("pop");
          void this.els.score.offsetWidth;
          this.els.score.classList.add("pop");
          this.popScore = false;
        }
      }
      this.els.score.classList.toggle("record", this.surpassed);
      this.els.bestHud.textContent = "Kỷ lục " + formatScore(this.best);
      const showBuff = this.state === "playing" || this.state === "paused" || this.state === "dying";
      this.els.shield.hidden = !(showBuff && this.shield > 0);
      this.els.slow.hidden = !(showBuff && this.slow > 0);
      if (this.shield > 0) this.els.shieldT.textContent = this.shield.toFixed(1);
      if (this.slow > 0) this.els.slowT.textContent = this.slow.toFixed(1);
      if (this.toastT > 0 && (this.state === "playing" || this.state === "dying")) {
        this.els.toast.hidden = false;
        this.els.toast.style.opacity = String(clamp(this.toastT * 2.2, 0, 1));
      } else {
        this.els.toast.hidden = true;
      }
      if (this.hintT > 0 && this.state === "playing") {
        this.els.hint.hidden = false;
        this.els.hint.style.opacity = String(clamp(this.hintT, 0, 1));
      } else {
        this.els.hint.hidden = true;
      }
    }

    draw() {
      if (!this.ctx || this.w < 2 || this.h < 2) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.w, this.h);
      const shake = this.reduceMotion ? 0 : this.shake;
      ctx.save();
      if (shake > 0) {
        ctx.translate((Math.random() - 0.5) * shake * 10, (Math.random() - 0.5) * shake * 8);
      }
      this.drawSky();
      this.drawGround();
      this.drawLaneGlow();
      this.drawDashes();
      this.drawSnow(false);
      this.drawWorld();
      this.drawSnow(true);
      this.drawFloats();
      this.drawParticles();
      if (this.state === "dying") {
        ctx.fillStyle = "rgba(168, 24, 32, " + Math.max(0, 0.42 - this.deathT).toFixed(3) + ")";
        ctx.fillRect(-20, -20, this.w + 40, this.h + 40);
      }
      ctx.restore();
      if (DEBUG) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "12px Segoe UI, sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(
          this.state + "  " + this.speed.toFixed(1) + "m/s  mốc " + this.tier +
          "  vật " + this.actors.length + "  lỗi " + this.unfair,
          12,
          this.h - 14
        );
      }
    }

    drawSky() {
      const ctx = this.ctx;
      const t = this.state === "ready" ? 0 : this.dayT();
      const top = mix("#07111f", "#2a2144", t);
      const mid = mix("#16345c", "#6a3d58", t);
      const horizon = mix("#1d4e78", "#f0a06a", t);
      const sky = ctx.createLinearGradient(0, 0, 0, this.horizon + 40);
      sky.addColorStop(0, top);
      sky.addColorStop(0.62, mid);
      sky.addColorStop(1, horizon);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, this.w, this.h);

      for (let i = 0; i < this.stars.length; i++) {
        const star = this.stars[i];
        const alpha = (0.35 + 0.65 * Math.abs(Math.sin(this.time * 1.4 + star.p))) * (1 - t);
        if (alpha < 0.05) continue;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#f7f3ea";
        ctx.beginPath();
        ctx.arc(star.x * this.w, star.y * this.h, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const moonA = 1 - t * 0.85;
      if (moonA > 0.05) {
        const mx = this.w * 0.8;
        const my = this.horizon * 0.32;
        const glow = ctx.createRadialGradient(mx, my, 8, mx, my, 70);
        glow.addColorStop(0, "rgba(255, 244, 214, " + (0.45 * moonA) + ")");
        glow.addColorStop(1, "rgba(255, 244, 214, 0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(mx, my, 70, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = moonA;
        ctx.fillStyle = "#f6f1e2";
        ctx.beginPath();
        ctx.arc(mx, my, 22, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      this.drawSkyline(t);
      this.drawStringLights(t);
    }

    drawSkyline(day) {
      const ctx = this.ctx;
      const base = this.horizon;
      ctx.fillStyle = mix("#102338", "#4a3544", day);
      ctx.beginPath();
      ctx.moveTo(0, base);
      const roofs = [16, 34, 22, 48, 26, 40, 18, 56, 24, 36, 20, 44, 28, 16];
      const seg = this.w / roofs.length;
      for (let i = 0; i < roofs.length; i++) {
        const x = i * seg;
        ctx.lineTo(x, base - roofs[i]);
        ctx.lineTo(x + seg * 0.78, base - roofs[i]);
      }
      ctx.lineTo(this.w, base);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255, 214, 140, 0.8)";
      for (let i = 0; i < roofs.length; i++) {
        if (roofs[i] < 30) continue;
        const x = i * seg + 8;
        const y = base - roofs[i] + 12;
        const twinkle = 0.45 + 0.55 * Math.abs(Math.sin(this.time * 2 + i));
        ctx.globalAlpha = twinkle * (1 - day * 0.35);
        ctx.fillRect(x, y, 3, 4);
        ctx.fillRect(x + 8, y + 8, 3, 4);
      }
      ctx.globalAlpha = 1;
    }

    drawStringLights(day) {
      const ctx = this.ctx;
      const colors = ["#e23d3d", "#f2d48a", "#7dcea0"];
      for (let i = 0; i < 16; i++) {
        const x = ((i + 0.5) / 16) * this.w;
        const y = this.horizon - 6 - (i % 4) * 2;
        ctx.globalAlpha = (0.45 + 0.55 * Math.abs(Math.sin(this.time * 2.2 + i))) * (1 - day * 0.45);
        ctx.fillStyle = colors[i % 3];
        ctx.beginPath();
        ctx.arc(x, y, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawGround() {
      const ctx = this.ctx;
      const t = this.state === "ready" ? 0 : this.dayT();
      ctx.fillStyle = mix("#d5e3ec", "#f0ddd0", t * 0.45);
      ctx.fillRect(0, this.horizon, this.w, this.h - this.horizon);
      this.traceQuad(-0.32, 2.32, -3.35, 32);
      ctx.fillStyle = "#2a3544";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.42)";
      ctx.lineWidth = 2;
      ctx.stroke();
      this.traceQuad(-0.08, 2.08, -2.2, 18);
      ctx.fillStyle = "rgba(255,255,255,0.035)";
      ctx.fill();
    }

    drawLaneGlow() {
      const lane = this.laneVisual;
      this.traceQuad(lane - 0.4, lane + 0.4, -0.6, 9);
      const near = this.project(lane, -0.6);
      const far = this.project(lane, 9);
      const glow = this.ctx.createLinearGradient(0, near.y, 0, far.y);
      glow.addColorStop(0, "rgba(242, 212, 138, 0)");
      glow.addColorStop(0.25, "rgba(242, 212, 138, 0.16)");
      glow.addColorStop(1, "rgba(242, 212, 138, 0)");
      this.ctx.fillStyle = glow;
      this.ctx.fill();
    }

    drawDashes() {
      const ctx = this.ctx;
      const period = 2.05;
      const start = Math.floor((-2.2 + this.travel) / period) * period;
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.lineCap = "butt";
      for (let world = start; world < this.travel + 26; world += period) {
        const z0 = world - this.travel;
        const z1 = z0 + 0.72;
        if (z1 < -2.4 || z0 > 24) continue;
        for (let edge = 0; edge < 2; edge++) {
          const lane = edge === 0 ? 0.5 : 1.5;
          const a = this.project(lane, z0);
          const b = this.project(lane, z1);
          ctx.lineWidth = Math.max(1.5, a.scale * 4);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }

    drawSnow(front) {
      const ctx = this.ctx;
      ctx.fillStyle = "#f7fbff";
      for (let i = 0; i < this.snow.length; i++) {
        const flake = this.snow[i];
        if (flake.front !== front) continue;
        ctx.globalAlpha = front ? 0.9 : 0.55;
        ctx.beginPath();
        ctx.arc(flake.x * this.w, flake.y * this.h, flake.r * (front ? 1.15 : 1), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawWorld() {
      const items = [];
      for (let i = 0; i < this.props.length; i++) {
        items.push({ z: this.props[i].z, prop: this.props[i] });
      }
      for (let i = 0; i < this.actors.length; i++) {
        items.push({ z: this.actors[i].z, actor: this.actors[i] });
      }
      items.push({ z: 0.45, santa: true });
      items.sort((a, b) => b.z - a.z);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.santa) this.drawSanta();
        else if (item.prop) this.drawProp(item.prop);
        else this.drawActor(item.actor);
      }
    }

    drawProp(prop) {
      const lane = prop.side < 0 ? -0.9 : 2.9;
      const p = this.project(lane, prop.z);
      if (p.scale < 0.07) return;
      if (prop.type === "house") this.drawHouse(p.x, p.y, p.scale, prop.variant);
      else if (prop.type === "tree") this.drawTree(p.x, p.y, p.scale, prop.variant);
      else this.drawLamp(p.x, p.y, p.scale);
    }

    drawHouse(x, y, s, variant) {
      const ctx = this.ctx;
      const w = 68 * s;
      const h = 54 * s;
      ctx.fillStyle = WALLS[variant % WALLS.length];
      ctx.fillRect(x - w / 2, y - h, w, h);
      ctx.fillStyle = "#f3f7fa";
      ctx.beginPath();
      ctx.moveTo(x - w * 0.62, y - h + s);
      ctx.lineTo(x, y - h - 26 * s);
      ctx.lineTo(x + w * 0.62, y - h + s);
      ctx.closePath();
      ctx.fill();
      const glow = 0.72 + 0.28 * Math.abs(Math.sin(this.time * 1.8 + variant));
      ctx.globalAlpha = glow;
      ctx.fillStyle = "rgba(255, 214, 140, 0.35)";
      ctx.fillRect(x - w * 0.32, y - h * 0.68, w * 0.22, w * 0.24);
      ctx.fillRect(x + w * 0.08, y - h * 0.68, w * 0.22, w * 0.24);
      ctx.fillStyle = "#ffd98a";
      ctx.fillRect(x - w * 0.28, y - h * 0.62, w * 0.14, w * 0.16);
      ctx.fillRect(x + w * 0.12, y - h * 0.62, w * 0.14, w * 0.16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#4a2c24";
      ctx.fillRect(x - w * 0.08, y - h * 0.36, w * 0.16, h * 0.36);
      ctx.strokeStyle = "#2f6b45";
      ctx.lineWidth = Math.max(1, 2 * s);
      ctx.beginPath();
      ctx.arc(x, y - h * 0.2, 4.5 * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "#d7263d";
      ctx.beginPath();
      ctx.arc(x, y - h * 0.2, 1.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    drawTree(x, y, s, variant) {
      const ctx = this.ctx;
      ctx.fillStyle = "#6b4228";
      ctx.fillRect(x - 3 * s, y - 12 * s, 6 * s, 12 * s);
      const greens = ["#1f6a45", "#174e34", "#2c8a55"];
      for (let i = 0; i < 3; i++) {
        ctx.fillStyle = greens[i];
        ctx.beginPath();
        const top = y - (50 - i * 8) * s;
        const bot = y - (16 + i * 5) * s;
        const half = (20 - i * 3) * s;
        ctx.moveTo(x, top);
        ctx.lineTo(x + half, bot);
        ctx.lineTo(x - half, bot);
        ctx.closePath();
        ctx.fill();
      }
      const colors = ["#e23d3d", "#f2d48a", "#7ec8e3"];
      for (let i = 0; i < 5; i++) {
        ctx.globalAlpha = 0.45 + 0.55 * Math.abs(Math.sin(this.time * 3 + i + variant));
        ctx.fillStyle = colors[(i + variant) % 3];
        ctx.beginPath();
        ctx.arc(x + Math.sin(i * 2 + variant) * 7 * s, y - (22 + i * 5) * s, 2 * s, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#f2d48a";
      ctx.beginPath();
      ctx.arc(x, y - 54 * s, 2.6 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    drawLamp(x, y, s) {
      const ctx = this.ctx;
      ctx.strokeStyle = "#243246";
      ctx.lineWidth = Math.max(1.5, 3 * s);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y - 64 * s);
      ctx.lineTo(x + 14 * s, y - 66 * s);
      ctx.stroke();
      const gx = x + 14 * s;
      const gy = y - 66 * s;
      const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 26 * s);
      glow.addColorStop(0, "rgba(255, 214, 140, 0.9)");
      glow.addColorStop(1, "rgba(255, 214, 140, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(gx, gy, 26 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f6f1e4";
      ctx.beginPath();
      ctx.arc(gx, gy, 3.4 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    drawActor(actor) {
      if (actor.phased) this.ctx.globalAlpha = 0.55;
      if (actor.type === "hole") this.drawHole(actor);
      else if (actor.type === "barrier") this.drawBarrier(actor);
      else if (actor.type === "car" || actor.type === "van") this.drawVehicle(actor);
      else this.drawGift(actor);
      this.ctx.globalAlpha = 1;
      if (actor.kind === "obstacle") this.drawHint(actor);
    }

    drawHole(actor) {
      const ctx = this.ctx;
      const sc = this.project(actor.lane, actor.z).scale;
      const z0 = actor.z - actor.depth * 0.5;
      const z1 = actor.z + actor.depth * 0.5;
      this.traceQuad(actor.lane - 0.34, actor.lane + 0.34, z0, z1);
      ctx.fillStyle = "#070b10";
      ctx.fill();
      ctx.strokeStyle = "#ffb03a";
      ctx.lineWidth = Math.max(3, 6 * sc);
      ctx.stroke();
      const rim = this.project(actor.lane, actor.z);
      ctx.strokeStyle = "#ffe08a";
      ctx.lineWidth = Math.max(2, 3 * rim.scale);
      ctx.beginPath();
      ctx.ellipse(rim.x, rim.y, 18 * rim.scale, 7 * rim.scale, 0, 0, Math.PI * 2);
      ctx.stroke();
      const cover = this.project(actor.lane + 0.46, actor.z);
      ctx.save();
      ctx.translate(cover.x, cover.y - 8 * cover.scale);
      ctx.rotate(-0.6);
      ctx.fillStyle = "#9aa4ad";
      ctx.beginPath();
      ctx.ellipse(0, 0, 14 * cover.scale, 14 * cover.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#66717a";
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = "rgba(213, 230, 239, 0.45)";
      for (let i = 0; i < 3; i++) {
        const f = (this.time * 0.45 + i * 0.33) % 1;
        ctx.globalAlpha = (1 - f) * 0.35;
        ctx.beginPath();
        ctx.arc(rim.x + (i - 1) * 4 * rim.scale, rim.y - f * 26 * rim.scale, (3 + f * 5) * rim.scale, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    drawBarrier(actor) {
      const ctx = this.ctx;
      const foot = this.project(actor.lane, actor.z);
      const sc = foot.scale;
      const w = 76 * sc;
      const gap = 52 * sc;
      const top = 176 * sc;
      const left = foot.x - w / 2;
      const bottom = foot.y - gap;
      const yTop = foot.y - top;
      this.candyPole(left, foot.y, yTop, sc);
      this.candyPole(left + w, foot.y, yTop, sc);
      ctx.save();
      roundRect(ctx, left, yTop, w, Math.max(4, bottom - yTop), 6 * sc);
      ctx.fillStyle = "#f4f4f4";
      ctx.fill();
      ctx.clip();
      ctx.fillStyle = "#d7263d";
      const stripe = 12 * sc;
      for (let x = left - top; x < left + w + top; x += stripe * 2) {
        ctx.beginPath();
        ctx.moveTo(x, yTop);
        ctx.lineTo(x + stripe, yTop);
        ctx.lineTo(x + stripe * 0.2, bottom);
        ctx.lineTo(x - stripe * 0.8, bottom);
        ctx.fill();
      }
      ctx.restore();
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.lineWidth = Math.max(1, 2 * sc);
      ctx.beginPath();
      ctx.moveTo(left, bottom);
      ctx.lineTo(left + w, bottom);
      ctx.stroke();
    }

    candyPole(x, yGround, yTop, sc) {
      const ctx = this.ctx;
      const h = Math.max(0, yGround - yTop);
      ctx.fillStyle = "#f4f4f4";
      ctx.fillRect(x - 4 * sc, yTop, 8 * sc, h);
      ctx.fillStyle = "#d7263d";
      const step = 9 * sc;
      for (let y = yTop; y < yGround; y += step * 2) {
        ctx.fillRect(x - 4 * sc, y, 8 * sc, Math.min(step, yGround - y));
      }
    }

    drawVehicle(actor) {
      const ctx = this.ctx;
      const foot = this.project(actor.lane, actor.z);
      const s = foot.scale;
      const van = actor.type === "van";
      const palette = CARS[actor.variant % CARS.length];
      const body = van ? "#efe8dc" : palette[0];
      const roof = van ? "#d9d2c6" : palette[1];
      const w = (van ? 78 : 70) * s;
      const h = (van ? 78 : 58) * s;
      ctx.save();
      ctx.translate(foot.x, foot.y);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(0, 2 * s, w * 0.42, 7 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      const cone = ctx.createLinearGradient(0, -h * 0.2, 0, 34 * s);
      cone.addColorStop(0, "rgba(255, 236, 180, 0.22)");
      cone.addColorStop(1, "rgba(255, 236, 180, 0)");
      ctx.fillStyle = cone;
      ctx.beginPath();
      ctx.moveTo(-w * 0.18, -8 * s);
      ctx.lineTo(w * 0.18, -8 * s);
      ctx.lineTo(w * 0.55, 32 * s);
      ctx.lineTo(-w * 0.55, 32 * s);
      ctx.closePath();
      ctx.fill();
      roundRect(ctx, -w / 2, -h, w, h * 0.78, 8 * s);
      ctx.fillStyle = body;
      ctx.fill();
      roundRect(ctx, -w * 0.34, -h - (van ? 8 * s : 2 * s), w * 0.68, van ? h * 0.34 : h * 0.24, 6 * s);
      ctx.fillStyle = roof;
      ctx.fill();
      if (van) {
        ctx.fillStyle = palette[0];
        ctx.fillRect(-w / 2, -h * 0.62, w, 6 * s);
        ctx.fillStyle = "#1f6a45";
        ctx.beginPath();
        ctx.moveTo(0, -h - 22 * s);
        ctx.lineTo(10 * s, -h - 4 * s);
        ctx.lineTo(-10 * s, -h - 4 * s);
        ctx.fill();
      }
      roundRect(ctx, -w * 0.26, -h + 7 * s, w * 0.52, 15 * s, 3 * s);
      ctx.fillStyle = "#d7eef8";
      ctx.fill();
      this.headlight(ctx, -w * 0.28, -h * 0.22, s);
      this.headlight(ctx, w * 0.28, -h * 0.22, s);
      ctx.fillStyle = "#1b1f27";
      ctx.beginPath();
      ctx.arc(-w * 0.28, -6 * s, 7 * s, 0, Math.PI * 2);
      ctx.arc(w * 0.28, -6 * s, 7 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    headlight(ctx, x, y, s) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 16 * s);
      glow.addColorStop(0, "rgba(255, 244, 200, 0.95)");
      glow.addColorStop(1, "rgba(255, 244, 200, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 16 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff6d2";
      ctx.beginPath();
      ctx.arc(x, y, 4 * s, 0, Math.PI * 2);
      ctx.fill();
    }

    drawGift(actor) {
      const ctx = this.ctx;
      const foot = this.project(actor.lane, actor.z);
      const s = foot.scale;
      const bob = Math.sin(this.time * 4 + actor.lane) * 6 * s;
      const style = actor.type === "shield"
        ? { box: "#f7f3ea", ribbon: "#d7263d", glow: "rgba(255, 220, 150, 0.7)", ink: "#ffe7b0", label: "★" }
        : actor.type === "slow"
          ? { box: "#e5f6fb", ribbon: "#2c86a8", glow: "rgba(150, 214, 232, 0.65)", ink: "#e7f8ff", label: "❄" }
          : { box: "#e7b33a", ribbon: "#d7263d", glow: "rgba(242, 196, 90, 0.55)", ink: "#fff1c4", label: "+100" };
      const x = foot.x;
      const y = foot.y - 46 * s + bob;
      const glow = ctx.createRadialGradient(x, y, 2, x, y, 58 * s);
      glow.addColorStop(0, style.glow);
      glow.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, 58 * s, 0, Math.PI * 2);
      ctx.fill();
      const bw = 40 * s;
      const bh = 34 * s;
      roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 5 * s);
      ctx.fillStyle = style.box;
      ctx.fill();
      ctx.fillStyle = style.ribbon;
      ctx.fillRect(x - 3 * s, y - bh / 2, 6 * s, bh);
      ctx.fillRect(x - bw / 2, y - 3 * s, bw, 6 * s);
      ctx.beginPath();
      ctx.moveTo(x, y - bh / 2);
      ctx.lineTo(x - 7 * s, y - bh / 2 - 8 * s);
      ctx.lineTo(x - 1 * s, y - bh / 2);
      ctx.moveTo(x, y - bh / 2);
      ctx.lineTo(x + 7 * s, y - bh / 2 - 8 * s);
      ctx.lineTo(x + 1 * s, y - bh / 2);
      ctx.fill();
      const fontSize = Math.max(13, 16 * s);
      const badgeH = Math.max(18, 18 * s);
      const badgeY = y - bh / 2 - badgeH * 0.85;
      ctx.font = "700 " + fontSize + "px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const tw = Math.max(badgeH, ctx.measureText(style.label).width + fontSize * 0.8);
      roundRect(ctx, x - tw / 2, badgeY - badgeH / 2, tw, badgeH, badgeH / 2);
      ctx.fillStyle = "rgba(8, 14, 24, 0.72)";
      ctx.fill();
      ctx.fillStyle = style.ink;
      ctx.fillText(style.label, x, badgeY);
      ctx.textBaseline = "alphabetic";
    }

    drawHint(actor) {
      let alpha = 1;
      if (actor.z < 6.2) alpha = (actor.z - 3) / 3.2;
      if (actor.z > 16) alpha = (20.5 - actor.z) / 4.5;
      alpha = clamp(alpha, 0, 1);
      if (alpha <= 0.04) return;
      const p = this.project(actor.lane, actor.z);
      const lift = actor.type === "hole" ? 46 : actor.type === "barrier" ? 198 : 108;
      const y = p.y - lift * p.scale;
      const ctx = this.ctx;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(p.x, y);
      const rad = Math.max(8, 13 * p.scale);
      ctx.fillStyle = "rgba(8, 14, 24, 0.72)";
      ctx.beginPath();
      ctx.arc(0, 0, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = actor.type === "hole" || actor.type === "barrier" ? "#ffd166" : "#ffb0b0";
      ctx.lineWidth = Math.max(2, rad * 0.18);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      if (actor.type === "hole") {
        ctx.moveTo(-rad * 0.42, rad * 0.12);
        ctx.lineTo(0, -rad * 0.38);
        ctx.lineTo(rad * 0.42, rad * 0.12);
      } else if (actor.type === "barrier") {
        ctx.moveTo(-rad * 0.42, -rad * 0.12);
        ctx.lineTo(0, rad * 0.38);
        ctx.lineTo(rad * 0.42, -rad * 0.12);
      } else {
        ctx.moveTo(-rad * 0.46, 0);
        ctx.lineTo(-rad * 0.12, -rad * 0.32);
        ctx.moveTo(-rad * 0.46, 0);
        ctx.lineTo(-rad * 0.12, rad * 0.32);
        ctx.moveTo(rad * 0.46, 0);
        ctx.lineTo(rad * 0.12, -rad * 0.32);
        ctx.moveTo(rad * 0.46, 0);
        ctx.lineTo(rad * 0.12, rad * 0.32);
      }
      ctx.stroke();
      ctx.restore();
    }

    drawSanta() {
      const ctx = this.ctx;
      const foot = this.project(this.laneVisual, 0);
      const lift = this.jumpT >= 0 ? Math.sin(Math.min(1, this.jumpT) * Math.PI) : 0;
      const sliding = this.slideT >= 0;
      ctx.save();
      ctx.fillStyle = "rgba(18, 26, 36, " + (0.3 - lift * 0.12) + ")";
      ctx.beginPath();
      ctx.ellipse(
        foot.x,
        foot.y + 2,
        (sliding ? 30 : 20) * foot.scale,
        7 * foot.scale,
        0, 0, Math.PI * 2
      );
      ctx.fill();
      ctx.restore();
      const blink = this.shield > 1.4 || this.shield <= 0
        ? 1
        : 0.45 + 0.55 * Math.abs(Math.sin(this.time * 16));
      ctx.save();
      ctx.globalAlpha = blink;
      this.paintSanta(foot.x, foot.y, 74 * foot.scale, {
        phase: this.phase,
        lift: lift,
        slide: sliding,
        dead: this.state === "dying" ? this.deathT : 0,
        shield: this.shield > 0 && this.state !== "over",
      });
      ctx.restore();
    }

    paintSanta(x, y, u, anim) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      if (anim.dead) ctx.rotate(Math.min(1, anim.dead) * 1.05);
      if (anim.slide) {
        ctx.translate(8, -u * 0.2);
        ctx.rotate(-1.15);
      } else {
        ctx.translate(0, -anim.lift * u * 0.78);
      }
      const bob = !anim.slide && anim.lift < 0.08 && !anim.dead ? Math.sin(anim.phase * 2) * u * 0.035 : 0;
      ctx.translate(0, bob);
      const leg = Math.sin(anim.phase);

      ctx.fillStyle = "#2a211c";
      if (anim.slide) {
        roundRect(ctx, -u * 0.34, -u * 0.16, u * 0.62, u * 0.12, u * 0.04);
        ctx.fill();
      } else {
        roundRect(ctx, -u * 0.24, -u * 0.3 - leg * u * 0.05, u * 0.15, u * 0.3, u * 0.04);
        ctx.fill();
        roundRect(ctx, u * 0.08, -u * 0.3 + leg * u * 0.05, u * 0.15, u * 0.3, u * 0.04);
        ctx.fill();
      }

      ctx.fillStyle = "#8a5a32";
      ctx.beginPath();
      ctx.ellipse(-u * 0.34, -u * 0.58, u * 0.15, u * 0.18, -0.45, 0, Math.PI * 2);
      ctx.fill();

      roundRect(ctx, -u * 0.3, -u * 0.78, u * 0.6, u * 0.52, u * 0.12);
      ctx.fillStyle = "#d7263d";
      ctx.fill();
      ctx.fillStyle = "#f4f1ea";
      ctx.fillRect(-u * 0.3, -u * 0.34, u * 0.6, u * 0.09);
      ctx.fillStyle = "#1c1c1c";
      ctx.fillRect(-u * 0.3, -u * 0.58, u * 0.6, u * 0.09);
      ctx.fillStyle = "#e7c36a";
      roundRect(ctx, -u * 0.07, -u * 0.61, u * 0.14, u * 0.15, u * 0.03);
      ctx.fill();

      ctx.fillStyle = "#f2c1a0";
      ctx.beginPath();
      ctx.arc(0, -u * 0.96, u * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#2a211c";
      ctx.beginPath();
      ctx.arc(-u * 0.07, -u * 0.98, u * 0.025, 0, Math.PI * 2);
      ctx.arc(u * 0.07, -u * 0.98, u * 0.025, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(214, 92, 92, 0.45)";
      ctx.beginPath();
      ctx.ellipse(-u * 0.12, -u * 0.9, u * 0.045, u * 0.03, 0, 0, Math.PI * 2);
      ctx.ellipse(u * 0.12, -u * 0.9, u * 0.045, u * 0.03, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#f7f4ef";
      ctx.beginPath();
      ctx.ellipse(0, -u * 0.84, u * 0.16, u * 0.15, 0, 0, Math.PI);
      ctx.fill();

      ctx.fillStyle = "#d7263d";
      ctx.beginPath();
      ctx.moveTo(-u * 0.2, -u * 1.08);
      ctx.quadraticCurveTo(u * 0.34, -u * 1.42, u * 0.04, -u * 1.46);
      ctx.lineTo(u * 0.22, -u * 1.08);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#f4f1ea";
      ctx.fillRect(-u * 0.22, -u * 1.12, u * 0.46, u * 0.08);
      const pom = Math.sin(anim.phase * 2) * u * 0.03;
      ctx.beginPath();
      ctx.arc(u * 0.04 + pom, -u * 1.48, u * 0.07, 0, Math.PI * 2);
      ctx.fill();

      if (anim.shield) {
        ctx.strokeStyle = "rgba(255, 214, 120, 0.95)";
        ctx.lineWidth = Math.max(2, u * 0.045);
        ctx.beginPath();
        ctx.ellipse(0, -u * 0.72, u * 0.52, u * 0.92, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    drawFloats() {
      const ctx = this.ctx;
      ctx.textAlign = "center";
      ctx.font = "700 16px Segoe UI, sans-serif";
      for (let i = 0; i < this.floats.length; i++) {
        const item = this.floats[i];
        ctx.globalAlpha = clamp(item.life / item.max, 0, 1);
        ctx.fillStyle = item.color;
        ctx.fillText(item.text, item.x, item.y);
      }
      ctx.globalAlpha = 1;
    }

    drawParticles() {
      const ctx = this.ctx;
      for (let i = 0; i < this.particles.length; i++) {
        const p = this.particles[i];
        ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }

    getState() {
      return {
        version: VERSION,
        state: this.state,
        score: Math.floor(this.score),
        best: this.best,
        tier: this.tier,
        speed: Math.round(this.speed * 10) / 10,
        shield: Math.round(this.shield * 10) / 10,
        slow: Math.round(this.slow * 10) / 10,
        muted: this.sfx.muted,
      };
    }
  }

  const game = new Game();
  const api = {
    version: VERSION,
    pause: () => game.pause(),
    resume: () => game.resume(),
    restart: () => game.start(),
    continueRun: () => game.continueRun(),
    getState: () => game.getState(),
    setMuted: (muted) => game.setMuted(muted),
  };
  if (DEBUG) api._game = game;
  window.SantaRunner = api;

  let last = 0;
  function frame(now) {
    if (!last) last = now;
    const dt = Math.min(0.034, (now - last) / 1000);
    last = now;
    game.update(dt);
    game.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  requestAnimationFrame(() => game.resize());
})();
