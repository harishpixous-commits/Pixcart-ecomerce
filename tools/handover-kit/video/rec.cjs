/*
 * Recording helpers for the demo videos: one recorded browser per person (customer, seller, partner, admin), an
 * on-screen caption bar with the person and the step, a visible cursor with click ripples, smooth mouse moves,
 * visible typing, and "scenes" (time ranges of a page's recording) that assemble.cjs stitches into one video.
 */
const path = require("path");
const fs = require("fs");
const { chromium, request } = require(path.join(process.env.E2E_DIR, "node_modules/@playwright/test"));

const BASE = process.env.BASE || "http://localhost:3200";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROLES = {
  customer: { label: "CUSTOMER", color: "#16A34A" },
  seller: { label: "SELLER", color: "#EA580C" },
  partner: { label: "DELIVERY PARTNER", color: "#2563EB" },
  admin: { label: "ADMIN", color: "#0B3354" },
};

/** Runs in every page: caption bar, role badge, cursor and click ripple (pointer-events: none, never in the way). */
function overlay() {
  if (window.top !== window) return; // not inside the admin's live preview window
  const css = `
  [data-testid="environment-badge"]{display:none!important}
  #__demo_cap{position:fixed;left:50%;transform:translateX(-50%);z-index:2147483646;pointer-events:none;display:flex;align-items:center;gap:12px;
    max-width:92vw;padding:12px 18px;border-radius:14px;background:rgba(10,24,40,.9);color:#fff;box-shadow:0 8px 28px rgba(0,0,0,.35);
    font:600 20px/1.35 "Plus Jakarta Sans",Inter,system-ui,sans-serif;transition:opacity .25s}
  #__demo_cap .r{flex:none;font-size:12px;letter-spacing:.08em;padding:5px 10px;border-radius:999px;color:#fff;font-weight:800}
  #__demo_cap .n{flex:none;font-size:13px;opacity:.7;font-weight:600}
  #__demo_cur{position:fixed;z-index:2147483647;pointer-events:none;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
    background:rgba(255,196,0,.55);border:2px solid #fff;box-shadow:0 0 0 2px rgba(10,24,40,.55);left:-50px;top:-50px;transition:transform .12s}
  .__demo_rip{position:fixed;z-index:2147483646;pointer-events:none;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;
    border:3px solid #FFC400;animation:__demo_rip .6s ease-out forwards}
  @keyframes __demo_rip{to{transform:scale(4);opacity:0}}
  #__demo_cap.__m{left:10px!important;right:10px!important;transform:none!important;max-width:none!important;bottom:84px!important;
    flex-wrap:wrap;gap:6px 8px;padding:9px 12px;font:600 14px/1.35 "Plus Jakarta Sans",Inter,system-ui,sans-serif}
  #__demo_cap.__m .r{font-size:10px;padding:4px 8px}
  #__demo_cap.__m .n{font-size:11px}`;
  const mobile = Math.min(window.innerWidth, window.innerHeight) < 600;
  function mount() {
    if (document.getElementById("__demo_cap") || !document.body) return;
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    const cap = document.createElement("div"); cap.id = "__demo_cap"; document.body.appendChild(cap);
    const cur = document.createElement("div"); cur.id = "__demo_cur"; document.body.appendChild(cur);
    if (Math.min(window.innerWidth || 9999, window.innerHeight || 9999) < 600) cap.classList.add("__m");
    else cap.style.bottom = "26px";
    render();
  }
  function render() {
    const cap = document.getElementById("__demo_cap"); if (!cap) return;
    let d = null; try { d = JSON.parse(localStorage.getItem("__demo") || "null"); } catch { /* */ }
    if (!d || !d.text) { cap.style.opacity = "0"; return; }
    cap.style.opacity = "1";
    const m = cap.classList.contains("__m");
    cap.innerHTML = `<span class="r" style="background:${d.color}">${d.role}</span>${d.step ? `<span class="n">${d.step}</span>` : ""}<span style="flex:${m ? "1 1 100%" : "1 1 auto"};min-width:0">${d.text}</span>`;
  }
  window.__demoRender = render;
  addEventListener("mousemove", (e) => { const c = document.getElementById("__demo_cur"); if (c) { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; } }, true);
  addEventListener("mousedown", (e) => {
    const r = document.createElement("div"); r.className = "__demo_rip"; r.style.left = e.clientX + "px"; r.style.top = e.clientY + "px";
    document.body.appendChild(r); setTimeout(() => r.remove(), 700);
    const c = document.getElementById("__demo_cur"); if (c) { c.style.transform = "scale(.7)"; setTimeout(() => (c.style.transform = ""), 150); }
  }, true);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
  new MutationObserver(() => { if (!document.getElementById("__demo_cap")) mount(); }).observe(document.documentElement, { childList: true, subtree: true });
}

class Recorder {
  constructor(name, outDir) {
    this.name = name;
    this.dir = path.join(outDir, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.pages = {};
    this.scenes = [];
  }
  async start() {
    this.browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ["--hide-scrollbars", "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding", "--disable-background-timer-throttling"] });
  }
  /** A recorded browser for one person. mobile: phone size. */
  async page(key, role, { mobile = false, geolocation } = {}) {
    const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
    const ctx = await this.browser.newContext({
      viewport, deviceScaleFactor: mobile ? 2 : 1, isMobile: mobile, hasTouch: mobile,
      ...(mobile ? {} : { recordVideo: { dir: path.join(this.dir, key), size: viewport } }),
      ...(geolocation ? { geolocation, permissions: ["geolocation"] } : {}),
    });
    await ctx.addInitScript(overlay);
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    this.pages[key] = { page, ctx, t0: Date.now(), role, mobile };
    if (mobile) this.pages[key].loop = this.capture(key);
    return page;
  }
  /** Phone screens: sharp 2x frames captured continuously (the built-in recorder only gives 390 x 844). */
  async capture(key) {
    const p = this.pages[key];
    const dir = path.join(this.dir, key, "frames");
    fs.mkdirSync(dir, { recursive: true });
    const cdp = await p.ctx.newCDPSession(p.page);
    p.frames = [];
    while (!p.stop) {
      try {
        const within = (pr) => Promise.race([pr, sleep(3000).then(() => { throw new Error("capture timeout"); })]);
        const v = (await within(cdp.send("Page.getLayoutMetrics"))).cssVisualViewport;
        const r = await within(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 82, optimizeForSpeed: true,
          clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 2 } }));
        const t = (Date.now() - p.t0) / 1000;
        const f = path.join(dir, String(p.frames.length).padStart(6, "0") + ".jpg");
        fs.writeFileSync(f, Buffer.from(r.data, "base64"));
        p.frames.push({ f, t });
      } catch { await sleep(40); }
    }
  }
  /** Turns the captured phone frames into a video whose clock matches the scene times. */
  buildPhoneVideo(key) {
    const p = this.pages[key];
    const lst = path.join(this.dir, key, "frames.txt");
    const lines = [];
    const fwd = (f) => f.split(path.sep).join("/");
    p.frames.forEach((fr, i) => {
      const start = i === 0 ? 0 : fr.t;
      const next = p.frames[i + 1] ? p.frames[i + 1].t : fr.t + 0.5;
      lines.push(`file '${fwd(fr.f)}'`, `duration ${Math.max(0.01, next - start).toFixed(3)}`);
    });
    lines.push(`file '${fwd(p.frames[p.frames.length - 1].f)}'`);
    fs.writeFileSync(lst, lines.join("\n"));
    const out = path.join(this.dir, key, "phone.mp4");
    const r = require("child_process").spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst,
      "-vf", "scale=780:1688,fps=30", "-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p", out], { encoding: "utf8" });
    if (r.status) throw new Error(r.stderr);
    return out;
  }
  /** Sets the caption (person + text + optional step) on a page. */
  async cap(key, text, step) {
    const { page, role } = this.pages[key];
    const r = ROLES[role];
    const d = JSON.stringify({ role: r.label, color: r.color, text, step: step || "" });
    await page.evaluate((v) => { localStorage.setItem("__demo", v); window.__demoRender && window.__demoRender(); }, d).catch(() => {});
  }
  /** Records the time range of a scene on a page; assemble.cjs keeps only scenes, in this order. */
  async scene(key, title, fn) {
    const p = this.pages[key];
    const from = (Date.now() - p.t0) / 1000;
    console.log(new Date().toTimeString().slice(0, 8), key, title);
    await fn(p.page);
    const to = (Date.now() - p.t0) / 1000;
    this.scenes.push({ key, title, from: Math.max(0, from - 0.2), to: to + 0.4 });
  }
  card(title, sub, seconds = 3) { this.scenes.push({ card: true, title, sub, seconds }); }
  async finish() {
    for (const [key, p] of Object.entries(this.pages)) {
      await sleep(600);
      if (p.mobile) { p.stop = true; await p.loop; await p.ctx.close(); p.video = this.buildPhoneVideo(key); }
      else { await p.ctx.close(); p.video = await p.page.video().path(); }
    }
    await this.browser.close();
    const plan = { name: this.name, mobile: Object.values(this.pages).some((p) => p.mobile) && Object.values(this.pages).every((p) => p.mobile),
      scenes: this.scenes.map((s) => (s.card ? s : { ...s, video: this.pages[s.key].video, mobile: this.pages[s.key].mobile })) };
    fs.writeFileSync(path.join(this.dir, "plan.json"), JSON.stringify(plan, null, 1));
    return plan;
  }
}

/** Moves the cursor smoothly to an element, pauses, clicks. */
async function tap(page, locator, { pause = 450, after = 700 } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const box = await locator.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
    await sleep(pause);
  }
  await locator.click();
  await sleep(after);
}
/** Clicks a field and types into it visibly. */
async function type(page, locator, text, { delay = 55, clear = true } = {}) {
  await tap(page, locator, { pause: 250, after: 150 });
  if (clear) await locator.fill("");
  await locator.pressSequentially(String(text), { delay });
  await sleep(350);
}
/** Scrolls down smoothly by about px pixels, then waits. */
async function scroll(page, px = 600, wait = 900) {
  const steps = Math.max(1, Math.round(Math.abs(px) / 60));
  for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, Math.sign(px) * 60); await sleep(28); }
  await sleep(wait);
}
async function top(page) { await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" })); await sleep(700); }
async function go(page, url, wait = 1500) {
  // the next page starts without the previous caption; the scene sets its own
  await page.evaluate(() => { try { localStorage.removeItem("__demo"); window.__demoRender && window.__demoRender(); } catch { /* */ } }).catch(() => {});
  await page.goto(BASE + url, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {});
  await page.waitForFunction(() => [...document.images].filter((i) => i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), null, { timeout: 15000 }).catch(() => {});
  await sleep(wait);
}

/** Signs in with a mobile number; the test install shows the code on screen with a "Fill in" button. */
async function otpSignIn(page, phone) {
  await type(page, page.locator("input[type=tel]").first(), phone);
  await tap(page, page.getByRole("button", { name: "Send code" }));
  const fill = page.getByRole("button", { name: /Fill in/i });
  await fill.waitFor({ timeout: 30000 });
  await sleep(600);
  await tap(page, fill);
  await tap(page, page.getByRole("button", { name: /Verify/ }), { after: 1500 });
}

async function apiAs(phoneOrAdmin, name) {
  const api = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { "X-Requested-With": "pixcart" } });
  let token;
  if (phoneOrAdmin === "admin") {
    token = (await (await api.post("/api/auth/login", { data: { email: "admin@pixcart.in", password: process.env.ADMIN_PW } })).json()).access_token;
  } else {
    const code = (await (await api.post("/api/auth/otp/request", { data: { phone: phoneOrAdmin } })).json()).dev_otp;
    token = (await (await api.post("/api/auth/otp/verify", { data: { phone: phoneOrAdmin, code, name: name || "Demo" } })).json()).access_token;
  }
  const h = { Authorization: `Bearer ${token}` };
  return {
    get: (u) => api.get(u, { headers: h }).then((r) => r.json()),
    post: (u, data) => api.post(u, { headers: h, data }),
    put: (u, data) => api.put(u, { headers: h, data }),
    del: (u) => api.delete(u, { headers: h }),
    upload: (u, file) => api.post(u, { headers: h, multipart: { file } }),
    dispose: () => api.dispose(),
  };
}

module.exports = { Recorder, tap, type, scroll, top, go, otpSignIn, apiAs, sleep, BASE };
