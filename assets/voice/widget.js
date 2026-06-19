/* Static portfolio widget: typed RAG chat plus opt-in low-latency voice. */
(function () {
  "use strict";

  var DEFAULT_BACKEND = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
    ? "ws://localhost:8000"
    : "wss://api.yashbansal.xyz";
  var BACKEND = (window.TTP_BACKEND_URL || DEFAULT_BACKEND).replace(/\/$/, "");
  var WS_URL = BACKEND + "/ws/converse";
  var HTTP_URL = BACKEND.replace(/^ws:/, "http:").replace(/^wss:/, "https:") + "/chat";
  window.__TTP_WIDGET_BACKEND = BACKEND;

  var MIN_VAD_THRESHOLD = 0.018;
  var CALIBRATION_FRAMES = 36;
  var START_FRAMES = 15;
  var BARGE_FRAMES = 12;
  var SILENCE_FRAMES = 42;
  var PREROLL = 8;

  var WORKLET_SRC =
    "class P extends AudioWorkletProcessor{" +
    "process(i){const c=i[0]&&i[0][0];if(c){const b=new ArrayBuffer(c.length*2),v=new DataView(b);" +
    "for(let n=0;n<c.length;n++){let s=Math.max(-1,Math.min(1,c[n]));v.setInt16(n*2,s<0?s*32768:s*32767,true)}this.port.postMessage(b,[b])}return true}}" +
    "registerProcessor('ttp-pcm',P);";

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function rms(int16) {
    var sum = 0;
    for (var i = 0; i < int16.length; i += 1) {
      var value = int16[i] / 32768;
      sum += value * value;
    }
    return Math.sqrt(sum / int16.length);
  }

  function Widget(mount) {
    this.mount = mount;
    this.ws = null;
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.zeroGain = null;
    this.active = false;
    this.state = "idle";
    this.speechRun = 0;
    this.silenceRun = 0;
    this.noiseFloor = 0.006;
    this.calibrationFrames = 0;
    this.preroll = [];
    this.mediaSource = null;
    this.sourceBuffer = null;
    this.audioQueue = [];
    this._blobChunks = [];
    this.render();
  }

  Widget.prototype.render = function () {
    var self = this;
    this.root = el("section", "ttp-shell ttp-closed");
    this.root.setAttribute("aria-label", "Ask Yash portfolio chat");
    this.root.setAttribute("data-backend", BACKEND);

    this.launcher = el("button", "ttp-launcher");
    this.launcher.type = "button";
    this.launcher.setAttribute("aria-label", "Open chat");
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.innerHTML =
      '<span class="ttp-launcher-mark" aria-hidden="true">yb</span>' +
      '<span class="ttp-launcher-text">ask yash</span>' +
      '<span class="ttp-launcher-dot" aria-hidden="true"></span>';

    this.panel = el("div", "ttp-panel");
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-modal", "false");
    this.panel.setAttribute("aria-label", "Portfolio chat");

    var inner = el("div", "ttp");
    var head = el("div", "ttp-head");
    var copy = el("div");
    copy.appendChild(el("h2", "ttp-title", "ask yash"));
    this.status = el("div", "ttp-status", "ask or talk. no scrolling tax.");
    copy.appendChild(this.status);
    this.closeBtn = el("button", "ttp-close", "x");
    this.closeBtn.type = "button";
    this.closeBtn.setAttribute("aria-label", "Close chat");
    head.appendChild(copy);
    head.appendChild(this.closeBtn);

    this.log = el("div", "ttp-log");
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "polite");
    this.addMessage("assistant", "Hi, I'm Yash. Ask away.");

    this.form = el("form", "ttp-form");
    this.input = el("input", "ttp-input");
    this.input.type = "text";
    this.input.placeholder = "ask about a project, paper, code...";
    this.input.autocomplete = "off";
    this.submit = el("button", "ttp-send", "ask");
    this.submit.type = "submit";
    this.form.appendChild(this.input);
    this.form.appendChild(this.submit);

    var controls = el("div", "ttp-controls");
    this.btn = el("button", "ttp-voice", "talk");
    this.btn.type = "button";
    this.badge = el("div", "ttp-badge ttp-hidden");
    controls.appendChild(this.btn);
    controls.appendChild(this.badge);

    this.transcript = el("div", "ttp-live-text");
    this.audio = el("audio");
    this.audio.autoplay = true;

    [head, this.log, this.form, controls, this.transcript, this.audio].forEach(function (node) {
      inner.appendChild(node);
    });
    this.panel.appendChild(inner);
    this.root.appendChild(this.launcher);
    this.root.appendChild(this.panel);
    this.mount.appendChild(this.root);

    this.launcher.addEventListener("click", function () { self.toggle(); });
    this.closeBtn.addEventListener("click", function () { self.close(); });
    this.form.addEventListener("submit", function (event) {
      event.preventDefault();
      self.sendChat();
    });
    this.btn.addEventListener("click", function () {
      self.active ? self.stop() : self.start();
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && self.isOpen()) self.close();
    });
  };

  Widget.prototype.isOpen = function () {
    return this.root && this.root.classList.contains("ttp-open");
  };

  Widget.prototype.open = function () {
    this.root.classList.remove("ttp-closed");
    this.root.classList.add("ttp-open");
    this.launcher.setAttribute("aria-expanded", "true");
    this.launcher.setAttribute("aria-label", "Close chat");
    var self = this;
    setTimeout(function () { self.input.focus(); }, 120);
  };

  Widget.prototype.close = function () {
    if (this.active) this.stop();
    this.root.classList.remove("ttp-open");
    this.root.classList.add("ttp-closed");
    this.launcher.setAttribute("aria-expanded", "false");
    this.launcher.setAttribute("aria-label", "Open chat");
  };

  Widget.prototype.toggle = function () {
    this.isOpen() ? this.close() : this.open();
  };

  Widget.prototype.setStatus = function (message) {
    this.status.textContent = message;
  };

  Widget.prototype.addMessage = function (role, text, meta) {
    var message = el("article", "ttp-msg ttp-" + role);
    message.appendChild(el("div", "ttp-msg-role", role === "user" ? "you" : "answer"));
    message.appendChild(el("div", "ttp-msg-text", text));

    if (meta && meta.sources && meta.sources.length) {
      var evidence = el("details", "ttp-evidence");
      var summary = el("summary", "ttp-evidence-label", "sources");
      var sources = el("div", "ttp-sources");
      meta.sources.slice(0, 4).forEach(function (source) {
        sources.appendChild(el("span", "ttp-source", source.section || source.source));
      });
      evidence.appendChild(summary);
      evidence.appendChild(sources);
      message.appendChild(evidence);
    }

    if (meta && meta.diagrams && meta.diagrams.length) {
      var diagrams = el("details", "ttp-evidence");
      diagrams.open = true;
      diagrams.appendChild(el("summary", "ttp-evidence-label", "diagram"));
      meta.diagrams.slice(0, 2).forEach(function (diagram) {
        var pre = el("pre", "ttp-diagram");
        pre.textContent = diagram;
        diagrams.appendChild(pre);
      });
      message.appendChild(diagrams);
    }

    this.log.appendChild(message);
    this.log.scrollTop = this.log.scrollHeight;
  };

  Widget.prototype.sendChat = async function () {
    var question = this.input.value.trim();
    if (!question) return;
    this.input.value = "";
    this.addMessage("user", question);
    this.setStatus("checking receipts...");
    this.submit.disabled = true;
    try {
      var response = await fetch(HTTP_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question })
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      this.addMessage("assistant", data.answer || "No answer came back.", data);
      this.setStatus("ready");
    } catch (error) {
      this.addMessage("assistant", "Backend is not live yet. The wires are staged.");
      this.setStatus("offline");
    } finally {
      this.submit.disabled = false;
      this.input.focus();
    }
  };

  Widget.prototype.connect = function () {
    var self = this;
    return new Promise(function (resolve, reject) {
      var ws = new WebSocket(WS_URL);
      ws.binaryType = "arraybuffer";
      var woke = setTimeout(function () {
        self.setStatus("waking up...");
      }, 2500);
      ws.onopen = function () {
        clearTimeout(woke);
        self.ws = ws;
        resolve(ws);
      };
      ws.onerror = function () {
        clearTimeout(woke);
        reject(new Error("WebSocket failed"));
      };
      ws.onmessage = function (event) { self.onMessage(event); };
      ws.onclose = function () { self.ws = null; };
    });
  };

  Widget.prototype.start = async function () {
    try {
      await this.connect();
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1
        }
      });
      this.ctx = new AudioContext({ sampleRate: 16000 });
      var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
      await this.ctx.audioWorklet.addModule(url);
      var src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "ttp-pcm");
      this.zeroGain = this.ctx.createGain();
      this.zeroGain.gain.value = 0;
      var self = this;
      this.node.port.onmessage = function (event) {
        self.onFrame(new Int16Array(event.data));
      };
      src.connect(this.node).connect(this.zeroGain).connect(this.ctx.destination);
      this.active = true;
      this.state = "idle";
      this.speechRun = 0;
      this.calibrationFrames = 0;
      this.btn.textContent = "stop";
      this.btn.classList.add("ttp-live");
      this.setStatus("listening");
    } catch (error) {
      this.setStatus("voice not ready yet");
      this.stop();
    }
  };

  Widget.prototype.stop = function () {
    this.active = false;
    this.state = "idle";
    this.btn.textContent = "talk";
    this.btn.classList.remove("ttp-live");
    this.transcript.textContent = "";
    if (this.node) { try { this.node.disconnect(); } catch (error) {} this.node = null; }
    if (this.zeroGain) { try { this.zeroGain.disconnect(); } catch (error) {} this.zeroGain = null; }
    if (this.ctx) { try { this.ctx.close(); } catch (error) {} this.ctx = null; }
    if (this.stream) {
      this.stream.getTracks().forEach(function (track) { track.stop(); });
      this.stream = null;
    }
    if (this.ws) { try { this.ws.close(); } catch (error) {} this.ws = null; }
    this.setStatus("ready");
  };

  Widget.prototype.threshold = function () {
    return Math.max(MIN_VAD_THRESHOLD, this.noiseFloor * 3.2);
  };

  Widget.prototype.onFrame = function (frame) {
    if (!this.active) return;
    var level = rms(frame);
    if (this.state === "idle" && this.calibrationFrames < CALIBRATION_FRAMES) {
      this.noiseFloor = this.noiseFloor * 0.92 + level * 0.08;
      this.calibrationFrames += 1;
    }
    var loud = level > this.threshold();

    if (this.state === "idle") {
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL) this.preroll.shift();
      this.speechRun = loud ? this.speechRun + 1 : 0;
      if (this.speechRun >= START_FRAMES) this.beginUtterance();
    } else if (this.state === "recording") {
      this.sendFrame(frame);
      this.silenceRun = loud ? 0 : this.silenceRun + 1;
      if (this.silenceRun >= SILENCE_FRAMES) this.endUtterance();
    } else if (this.state === "speaking") {
      this.speechRun = loud ? this.speechRun + 1 : 0;
      if (this.speechRun >= BARGE_FRAMES) this.barge();
    }
  };

  Widget.prototype.beginUtterance = function () {
    this.state = "recording";
    this.silenceRun = 0;
    this.transcript.textContent = "listening...";
    this.badge.classList.add("ttp-hidden");
    this.setStatus("got it");
    this.preroll.forEach(this.sendFrame.bind(this));
    this.preroll = [];
  };

  Widget.prototype.endUtterance = function () {
    this.state = "speaking";
    this.speechRun = 0;
    this.setStatus("thinking...");
    this.setupPlayback();
    this.sendCtrl("eot");
  };

  Widget.prototype.barge = function () {
    this.sendCtrl("barge");
    try { this.audio.pause(); } catch (error) {}
    this.audioQueue = [];
    this._blobChunks = [];
    this.setStatus("go ahead");
    this.beginUtterance();
  };

  Widget.prototype.sendFrame = function (frame) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame.buffer);
  };

  Widget.prototype.sendCtrl = function (type) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: type }));
    }
  };

  Widget.prototype.setupPlayback = function () {
    this.audioQueue = [];
    this._blobChunks = [];
    if (!window.MediaSource) {
      this.mediaSource = null;
      return;
    }
    try {
      this.mediaSource = new MediaSource();
      this.audio.src = URL.createObjectURL(this.mediaSource);
      var self = this;
      this.mediaSource.addEventListener("sourceopen", function () {
        try {
          self.sourceBuffer = self.mediaSource.addSourceBuffer("audio/mpeg");
          self.sourceBuffer.addEventListener("updateend", function () { self.pump(); });
          self.audio.play().catch(function () {});
          self.pump();
        } catch (error) {
          self.mediaSource = null;
        }
      }, { once: true });
    } catch (error) {
      this.mediaSource = null;
    }
  };

  Widget.prototype.pump = function () {
    if (!this.sourceBuffer || this.sourceBuffer.updating || !this.audioQueue.length) return;
    try {
      this.sourceBuffer.appendBuffer(this.audioQueue.shift());
    } catch (error) {}
  };

  Widget.prototype.flushBlob = function () {
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === "open") this.mediaSource.endOfStream();
      } catch (error) {}
      return;
    }
    if (this._blobChunks.length) {
      this.audio.src = URL.createObjectURL(new Blob(this._blobChunks, { type: "audio/mpeg" }));
      this.audio.play().catch(function () {});
    }
  };

  Widget.prototype.onMessage = function (event) {
    if (typeof event.data !== "string") {
      if (this.mediaSource) {
        this.audioQueue.push(new Uint8Array(event.data));
        this.pump();
      } else {
        this._blobChunks.push(new Uint8Array(event.data));
      }
      return;
    }
    var msg;
    try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (msg.type === "transcript") {
      this.transcript.textContent = msg.text;
    } else if (msg.type === "answer") {
      this.addMessage("assistant", msg.text);
      this.flushBlob();
      this.afterAnswer();
    } else if (msg.type === "latency") {
      this.showLatency(msg);
    } else if (msg.type === "error") {
      this.setStatus(msg.message);
    }
  };

  Widget.prototype.afterAnswer = function () {
    if (this.active && this.state === "speaking") {
      this.state = "idle";
      this.speechRun = 0;
      this.transcript.textContent = "";
      this.setStatus("listening");
    }
  };

  Widget.prototype.showLatency = function (msg) {
    this.badge.textContent = msg.e2e_ms + "ms";
    this.badge.classList.remove("ttp-hidden");
  };

  function boot() {
    var mount = document.getElementById("voice-widget");
    if (mount) new Widget(mount);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
