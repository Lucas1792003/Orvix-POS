// Browser code of the phone upload page served by ./index.ts.
//
// IMPORTANT: `phoneUploadPage` is embedded into the HTML with
// Function.prototype.toString(), so it must stay SELF-CONTAINED: plain
// browser JavaScript, no imports, no references to anything outside its own
// body. It is the vanilla-JS twin of src/pages/PhoneProductImageUploadPage.tsx
// + src/lib/productImagePhoneUpload.ts (uploadPhoneProductImage) +
// src/lib/compressProductImage.ts, and must behave the same:
//   * the session token comes from the URL FRAGMENT (#<token>): it is never
//     sent to the server in the request line, so it is not in access logs
//     or a Referer;
//   * session status: rpc get_product_image_upload_session_by_token;
//   * just-in-time signed upload token: POST /functions/v1/phone-upload-token
//     immediately before the transfer (60 s token, migration 081 limits:
//     429 -> wait Retry-After and retry by itself, at most 3 times, only for
//     waits <= 60 s that end before the link expires);
//   * transfer: PUT /storage/v1/object/upload/sign/product-images/<path>?token=
//     (multipart, x-upsert: false - same request as supabase-js
//     uploadToSignedUrl); an expired token / network failure is retried once
//     with a fresh token; 409 / "already exists" means the object is there;
//   * completion: POST /functions/v1/phone-upload-token {token, action:
//     "complete"} (083/G5: the server checks the stored bytes, then runs
//     complete_product_image_upload_session with the service role and
//     derives the URL itself); on failure the session is re-read and
//     COMPLETED for the same path counts as success.
// Only the anon key is used (it is public: it ships in every app build).
// Same origin only (CSP connect-src 'self'): the page is served by the API
// origin itself, so every call goes to window.location.origin.
//
// `deps` is a test seam (src/lib/phoneUploadPageClient.test.ts); the page
// passes nothing.
export function phoneUploadPage(win, cfg, deps) {
  "use strict";
  deps = deps || {};
  var doc = win.document;
  var MESSAGES = cfg.messages;
  var ANON_KEY = String(cfg.anonKey || "");
  var ORIGIN = win.location.origin;
  var BUCKET = "product-images";
  var MAX_BYTES = 100 * 1024;
  var MAX_ORIGINAL_BYTES = 10 * 1024 * 1024;
  var ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
  var DIMENSIONS = [320, 256, 192];
  var QUALITIES = [0.72, 0.65, 0.58, 0.5, 0.45];
  var MAX_RATE_LIMIT_RETRIES = 3;
  var MAX_AUTO_WAIT_SECONDS = 60;
  var STATUSES = ["PENDING", "COMPLETED", "EXPIRED", "CANCELED"];
  var LANG_KEY = "pos-language";

  var sleep = deps.sleep || function (ms) {
    return new Promise(function (resolve) { win.setTimeout(resolve, ms); });
  };
  var now = deps.now || function () { return Date.now(); };
  var random = deps.random || Math.random;

  // ------------------------------------------------------------ language
  var language = (function () {
    try {
      var stored = JSON.parse(win.localStorage.getItem(LANG_KEY) || "null");
      var lang = stored && stored.state && stored.state.language;
      if (lang === "en" || lang === "my") return lang;
    } catch (e) { /* storage unavailable */ }
    var langs = (win.navigator && win.navigator.languages) || [];
    for (var i = 0; i < langs.length; i++) if (/^my\b/i.test(String(langs[i]))) return "my";
    return "en";
  })();
  function t(key, vars) {
    var text = (MESSAGES[language] && MESSAGES[language][key]) || MESSAGES.en[key] || key;
    if (vars) Object.keys(vars).forEach(function (k) { text = text.split("{" + k + "}").join(String(vars[k])); });
    return text;
  }

  // ------------------------------------------------------------ errors
  function InactiveError(status) {
    this.name = "PhoneUploadInactiveError";
    this.status = status;
    this.message = "This upload link is no longer active.";
  }
  function RateLimitedError(seconds, message) {
    this.name = "PhoneUploadRateLimitedError";
    this.retryAfterSeconds = seconds;
    this.message = message || "Too many upload attempts. Please wait a moment and try again.";
  }
  function RefusedError(message) {
    this.name = "PhoneUploadRefusedError";
    this.message = message;
  }

  function adviseOnRateLimit(retryAfterSeconds, expiresAt, retriesSoFar) {
    var seconds = Math.max(1, Math.ceil(isFinite(retryAfterSeconds) ? retryAfterSeconds : MAX_AUTO_WAIT_SECONDS));
    var expiry = expiresAt ? Date.parse(expiresAt) : NaN;
    if (isFinite(expiry) && now() + seconds * 1000 >= expiry) return { kind: "linkExhausted" };
    if (seconds <= MAX_AUTO_WAIT_SECONDS && (retriesSoFar || 0) < MAX_RATE_LIMIT_RETRIES) return { kind: "wait", seconds: seconds };
    return { kind: "later", minutes: Math.max(1, Math.ceil(seconds / 60)) };
  }

  // ------------------------------------------------------------ server calls (same origin, anon key only)
  function apiHeaders(json) {
    var h = { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  function rpc(name, body) {
    return win.fetch(ORIGIN + "/rest/v1/rpc/" + name, {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify(body),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) throw new Error((data && typeof data.message === "string" && data.message) || "Request failed (" + res.status + ").");
        if (!data) throw new Error("Upload session was not found.");
        return data;
      });
    });
  }

  function readSession(sessionToken) {
    return rpc("get_product_image_upload_session_by_token", { p_token: sessionToken });
  }

  function requestTarget(sessionToken) {
    return win.fetch(ORIGIN + "/functions/v1/phone-upload-token", {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({ token: sessionToken }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (body) {
        return { status: res.status, body: body, retryAfter: res.headers.get("Retry-After") };
      });
    }, function () {
      throw new Error("Could not reach the server. Check the phone's connection and try again.");
    }).then(function (r) {
      var b = r.body || {};
      if (r.status === 200) {
        if (b.alreadyUploaded === true && typeof b.path === "string") return { kind: "alreadyUploaded", storagePath: b.path };
        if (typeof b.token === "string" && b.token && typeof b.path === "string" && b.path) {
          return { kind: "upload", storagePath: b.path, uploadToken: b.token };
        }
        throw new Error("The upload server returned an unexpected answer. Try again.");
      }
      var message = typeof b.error === "string" && b.error ? b.error : null;
      if (r.status === 410 || b.code === "inactive") {
        throw new InactiveError(STATUSES.indexOf(b.status) >= 0 ? b.status : "EXPIRED");
      }
      if (r.status === 429 || b.code === "rate_limited") {
        var fromBody = typeof b.retry_after_seconds === "number" ? b.retry_after_seconds : NaN;
        var ra = r.retryAfter == null ? "" : String(r.retryAfter).trim();
        var fromHeader = /^\d+$/.test(ra) ? Number(ra) : NaN;
        var seconds = isFinite(fromBody) && fromBody > 0 ? fromBody : isFinite(fromHeader) && fromHeader > 0 ? fromHeader : 10;
        throw new RateLimitedError(Math.ceil(seconds), message || undefined);
      }
      if (r.status === 404 || r.status === 403) throw new RefusedError(message || "Invalid upload link.");
      throw new Error(message || "Phone upload is temporarily unavailable. Try again.");
    });
  }

  function encodePath(path) {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  function uploadToSignedUrl(path, uploadToken, image) {
    var form = new win.FormData();
    form.append("cacheControl", "31536000");
    form.append("", image.blob);
    var headers = apiHeaders(false);
    headers["x-upsert"] = "false";
    return win.fetch(ORIGIN + "/storage/v1/object/upload/sign/" + BUCKET + "/" + encodePath(path) + "?token=" + encodeURIComponent(uploadToken), {
      method: "PUT",
      headers: headers,
      body: form,
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      if (res.ok) return { error: null };
      return res.json().catch(function () { return null; }).then(function (b) {
        b = b || {};
        return { error: { name: "StorageApiError", status: res.status, statusCode: b.statusCode, message: typeof b.message === "string" ? b.message : typeof b.error === "string" ? b.error : "" } };
      });
    }, function () {
      return { error: { name: "StorageUnknownError", message: "network error" } };
    });
  }

  function classifyStorageUploadError(e) {
    e = e || {};
    var status = typeof e.status === "number" ? e.status : Number(e.statusCode);
    var message = typeof e.message === "string" ? e.message : "";
    if (status === 409 || /already exists|duplicate/i.test(message)) return "duplicate";
    if (/InvalidJWT/i.test(String(e.statusCode)) || ((status === 400 || status === 403) && /exp|jwt|signature|token/i.test(message))) return "expired_token";
    if (e.name === "StorageUnknownError" || !isFinite(status) || status === 0) return "network";
    return "other";
  }

  // 083 (G5): completion goes through phone-upload-token {action:"complete"},
  // which checks the stored bytes (magic number, size, no markup) before it
  // completes the session with the service role; a refused object is deleted
  // there. anon can no longer call complete_product_image_upload_session.
  function complete(sessionToken, storagePath, image) {
    if (!isFinite(image.bytes) || image.bytes <= 0 || image.bytes > MAX_BYTES) {
      return Promise.reject(new Error("Compressed image is over the 100 KB limit and was not uploaded."));
    }
    return win.fetch(ORIGIN + "/functions/v1/phone-upload-token", {
      method: "POST",
      headers: apiHeaders(true),
      body: JSON.stringify({ token: sessionToken, action: "complete" }),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (b) {
        if (res.ok && b && b.status === "COMPLETED" && b.storagePath === storagePath) return b;
        b = b || {};
        if (res.status === 410 || b.code === "inactive") throw new InactiveError(STATUSES.indexOf(b.status) >= 0 ? b.status : "EXPIRED");
        throw new Error((typeof b.error === "string" && b.error) || "Upload could not be completed (" + res.status + ").");
      });
    }, function () {
      throw new Error("Could not reach the server. Check the phone's connection and try again.");
    });
  }

  /** The whole upload, retry-safe (uploadPhoneProductImage twin). */
  function upload(sessionToken, image, opts) {
    opts = opts || {};
    var rateLimitRetries = 0;
    function requestTargetPolitely() {
      return requestTarget(sessionToken).catch(function (e) {
        if (!(e instanceof RateLimitedError)) throw e;
        var advice = adviseOnRateLimit(e.retryAfterSeconds, opts.sessionExpiresAt, rateLimitRetries);
        if (advice.kind !== "wait") throw e;
        rateLimitRetries += 1;
        if (opts.onRateLimitWait) opts.onRateLimitWait(advice.seconds, rateLimitRetries);
        // + up to 1 s jitter so phones that were refused together do not return together
        return sleep(advice.seconds * 1000 + Math.floor(random() * 1000)).then(requestTargetPolitely);
      });
    }
    function attempt(n) {
      return requestTargetPolitely().then(function (target) {
        if (target.kind === "alreadyUploaded") return target.storagePath;
        return uploadToSignedUrl(target.storagePath, target.uploadToken, image).then(function (r) {
          if (!r.error) return target.storagePath;
          var failure = classifyStorageUploadError(r.error);
          if (failure === "duplicate") return target.storagePath;
          if ((failure === "expired_token" || failure === "network") && n === 0) return attempt(1);
          throw new Error("Image upload failed: " + (r.error.message || "unknown error"));
        });
      });
    }
    return attempt(0).then(function (storagePath) {
      return complete(sessionToken, storagePath, image).catch(function (e) {
        return readSession(sessionToken).catch(function () { return null; }).then(function (current) {
          if (current && current.status === "COMPLETED" && current.storagePath === storagePath) return current;
          if (current && current.status !== "PENDING") throw new InactiveError(current.status);
          throw e;
        });
      });
    });
  }

  // ------------------------------------------------------------ compression (compressProductImage twin)
  function compress(file) {
    if (ALLOWED_TYPES.indexOf(file.type) < 0) return Promise.reject(new Error("Unsupported image type. Please choose a JPEG, PNG or WebP image."));
    if (file.size > MAX_ORIGINAL_BYTES) return Promise.reject(new Error("Image is too large (max 10 MB). Please choose a smaller file."));
    var probe = doc.createElement("canvas");
    probe.width = 1;
    probe.height = 1;
    var mimeType = probe.toDataURL("image/webp").indexOf("data:image/webp") === 0 ? "image/webp" : "image/jpeg";
    return new Promise(function (resolve, reject) {
      var url = win.URL.createObjectURL(file);
      var img = new win.Image();
      img.onload = function () { win.URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { win.URL.revokeObjectURL(url); reject(new Error("That file could not be read as an image.")); };
      img.src = url;
    }).then(function (img) {
      var sw = img.naturalWidth || img.width;
      var sh = img.naturalHeight || img.height;
      if (!sw || !sh) throw new Error("That file could not be read as an image.");
      var canvas = doc.createElement("canvas");
      var ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("The image could not be processed (canvas is unavailable).");
      var steps = [];
      DIMENSIONS.forEach(function (d) { QUALITIES.forEach(function (q) { steps.push([d, q]); }); });
      function next(i) {
        if (i >= steps.length) throw new Error("Image could not be compressed below 100 KB. Please choose a simpler or smaller image.");
        var scale = Math.min(1, steps[i][0] / sw, steps[i][0] / sh);
        canvas.width = Math.max(1, Math.round(sw * scale));
        canvas.height = Math.max(1, Math.round(sh * scale));
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return new Promise(function (resolve, reject) {
          canvas.toBlob(function (blob) { blob ? resolve(blob) : reject(new Error("The image could not be processed.")); }, mimeType, steps[i][1]);
        }).then(function (blob) {
          if (blob.size <= MAX_BYTES) return { blob: blob, bytes: blob.size, mimeType: blob.type || mimeType };
          return next(i + 1);
        });
      }
      return next(0);
    });
  }
  var compressImage = deps.compress || compress;

  // ------------------------------------------------------------ token from the fragment
  var token = (function () {
    var raw = String(win.location.hash || "").replace(/^#/, "");
    try { raw = decodeURIComponent(raw); } catch (e) { return ""; }
    return /^[A-Za-z0-9._~-]{32,512}$/.test(raw) ? raw : "";
  })();

  // ------------------------------------------------------------ UI
  var el = function (id) { return doc.getElementById(id); };
  var ui = {
    title: el("title"), status: el("status"), compressed: el("compressed"), error: el("error"),
    take: el("take"), choose: el("choose"), camera: el("camera-input"), library: el("library-input"),
    done: el("done"), lang: el("lang"),
  };
  var state = { phase: "loading", session: null, error: null, compressedBytes: null, waitSeconds: 0 };
  var inFlight = false;
  var expiryTimer = null;
  var waitTimer = null;

  function statusText() {
    switch (state.phase) {
      case "loading": return t("loading");
      case "compressing": return t("compressing");
      case "uploading": return t("uploading");
      case "waiting": return t("rateLimitedWaiting", { seconds: Math.max(0, state.waitSeconds) });
      case "complete": return t("complete");
      case "expired": return t("expired");
      case "cancelled": return t("cancelled");
      case "ready": return t("ready");
      default: return t("failed");
    }
  }
  function rateLimitMessage(advice) {
    if (advice.kind === "linkExhausted") return t("rateLimitedLinkUsedUp");
    if (advice.kind === "later") return t("rateLimitedLater", { minutes: advice.minutes });
    return t("rateLimitedWaiting", { seconds: advice.seconds });
  }
  function render() {
    doc.documentElement.lang = language === "my" ? "my" : "en";
    if (doc.title !== undefined) doc.title = t("title");
    ui.title.textContent = t("title");
    ui.lang.textContent = t("language");
    ui.take.textContent = t("takePhoto");
    ui.choose.textContent = t("chooseFromLibrary");
    ui.status.textContent = statusText();
    ui.compressed.hidden = state.compressedBytes === null;
    ui.compressed.textContent = state.compressedBytes === null ? "" : t("compressed", { size: Math.round(state.compressedBytes / 1024) + " KB" });
    ui.error.hidden = !state.error;
    ui.error.textContent = state.error || "";
    var busy = state.phase === "loading" || state.phase === "compressing" || state.phase === "uploading" || state.phase === "waiting";
    ui.take.disabled = state.phase !== "ready" || busy;
    ui.choose.disabled = state.phase !== "ready" || busy;
    ui.done.hidden = state.phase !== "complete";
    ui.done.textContent = t("complete");
  }
  function setPhase(phase) {
    state.phase = phase;
    if (expiryTimer !== null) { win.clearTimeout(expiryTimer); expiryTimer = null; }
    if (phase === "ready" && state.session) {
      var delay = Date.parse(state.session.expiresAt) - now();
      if (!(delay > 0)) { state.phase = "expired"; }
      else expiryTimer = win.setTimeout(function () { if (state.phase === "ready") setPhase("expired"); }, Math.min(delay, 2147483647));
    }
    render();
  }
  function startCountdown(seconds) {
    if (waitTimer !== null) win.clearTimeout(waitTimer);
    state.waitSeconds = seconds;
    state.phase = "waiting";
    render();
    var tick = function () {
      if (state.phase !== "waiting") { waitTimer = null; return; }
      state.waitSeconds -= 1;
      if (state.waitSeconds <= 0) { waitTimer = null; setPhase("uploading"); return; }
      render();
      waitTimer = win.setTimeout(tick, 1000);
    };
    waitTimer = win.setTimeout(tick, 1000);
  }
  function phaseForStatus(status) {
    return status === "PENDING" ? "ready" : status === "COMPLETED" ? "complete" : status === "EXPIRED" ? "expired" : "cancelled";
  }

  function handleFile(file) {
    var session = state.session;
    if (!session || state.phase !== "ready" || inFlight) return Promise.resolve();
    if (Date.parse(session.expiresAt) <= now()) { setPhase("expired"); return Promise.resolve(); }
    inFlight = true;
    state.error = null;
    setPhase("compressing");
    return compressImage(file).then(function (image) {
      state.compressedBytes = image.bytes;
      setPhase("uploading");
      // Just in time: the signed upload token (valid ~60 s) is requested
      // inside upload(), immediately before the transfer - never at load.
      return upload(token, image, { sessionExpiresAt: session.expiresAt, onRateLimitWait: startCountdown });
    }).then(function (completed) {
      state.session = completed;
      setPhase("complete");
    }, function (e) {
      if (e instanceof InactiveError) { setPhase(phaseForStatus(e.status)); return; }
      if (e instanceof RateLimitedError) {
        var advice = adviseOnRateLimit(e.retryAfterSeconds, session.expiresAt, MAX_RATE_LIMIT_RETRIES);
        state.error = rateLimitMessage(advice);
        setPhase(advice.kind === "linkExhausted" ? "error" : "ready");
        return;
      }
      if (win.console) win.console.error("[phone-upload-page] upload", e && e.message);
      state.error = (e && e.message) || "The photo could not be uploaded.";
      setPhase("error");
    }).then(function () { inFlight = false; });
  }

  function onPicked(event) {
    var input = event.target;
    var file = input.files && input.files[0];
    input.value = "";
    if (file) handleFile(file);
  }
  ui.camera.addEventListener("change", onPicked);
  ui.library.addEventListener("change", onPicked);
  ui.take.addEventListener("click", function () { ui.camera.click(); });
  ui.choose.addEventListener("click", function () { ui.library.click(); });
  ui.lang.addEventListener("click", function () {
    language = language === "en" ? "my" : "en";
    try { win.localStorage.setItem(LANG_KEY, JSON.stringify({ state: { language: language, isZawgyi: false }, version: 2 })); } catch (e) { /* ignore */ }
    render();
  });

  var ready;
  if (!token) {
    state.error = t("invalidLink");
    setPhase("error");
    ready = Promise.resolve();
  } else {
    render();
    ready = readSession(token).then(function (s) {
      state.session = s;
      setPhase(phaseForStatus(s.status));
    }, function (e) {
      if (win.console) win.console.error("[phone-upload-page] session", e && e.message);
      state.error = (e && e.message) || "Invalid or expired upload link.";
      setPhase("error");
    });
  }

  // Programmatic entry for the e2e race check (two concurrent uploads of the
  // same session through this page's own code). Grants nothing the page
  // itself cannot already do with the token in its own address bar.
  var api = {
    ready: ready,
    state: state,
    handleFile: handleFile,
    uploadImage: function (image) { return upload(token, image, {}); },
  };
  win.orvixPhoneUpload = api;
  return api;
}
