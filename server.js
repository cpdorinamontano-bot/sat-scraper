import express from "express";
import { chromium } from "playwright";
import forge from "node-forge";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.SCRAPER_API_KEY || "";
const MAX_CONCURRENT_BROWSERS = Number(process.env.MAX_CONCURRENT_BROWSERS || 2);
const MAX_ATTEMPTS = Number(process.env.MAX_ATTEMPTS || 2);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 110000);

const app = express();
app.use(express.json({ limit: "20mb" }));

// ---- auth middleware ----
app.use((req, res, next) => {
  if (req.path === "/health" || req.path === "/") return next();
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Invalid X-Api-Key" });
  }
  next();
});

app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString(), inFlight: activeBrowsers }));
app.get("/", (_, res) => res.json({ name: "sat-scraper", version: "1.2.0" }));

// ---- concurrency limiter ----
// Railway containers have fixed RAM; an unbounded number of concurrent Chromium
// instances is the most common cause of OOM kills (which Railway reports as a
// generic restart, not a clear "out of memory" error). Cap concurrent browser
// sessions and queue the rest instead of crashing the container.
let activeBrowsers = 0;
const waitQueue = [];

async function acquireBrowserSlot() {
  if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
    activeBrowsers++;
    return;
  }
  await new Promise((resolve) => waitQueue.push(resolve));
  activeBrowsers++;
}

function releaseBrowserSlot() {
  activeBrowsers--;
  const next = waitQueue.shift();
  if (next) next();
}

// ---- logging ----
function log(reqId, msg, extra) {
  console.log(`[${new Date().toISOString()}] [${reqId}] ${msg}`, extra ?? "");
}

// ---- helpers ----
function decodeCertField(value, label, reqId) {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} ausente o inválido`);
  }
  // Defensive cleanup: strips data-URI prefixes ("data:application/...;base64,")
  // and whitespace/newlines that some upstream JSON/transport layers introduce,
  // which otherwise produce "Unparsed DER bytes remain after ASN.1 parsing".
  let clean = value.trim();
  const commaIdx = clean.indexOf(",");
  if (clean.startsWith("data:") && commaIdx !== -1) clean = clean.slice(commaIdx + 1);
  clean = clean.replace(/\s+/g, "");

  const buf = Buffer.from(clean, "base64");
  if (buf.length === 0) {
    throw new Error(`${label} decodificó a 0 bytes (base64 inválido)`);
  }
  // Re-encoding and comparing catches double-base64-encoding: if the input was
  // already valid base64 of base64, decoding once still yields printable base64
  // text instead of binary DER, and this round-trip will not match.
  const roundTrip = buf.toString("base64").replace(/=+$/, "");
  const cleanNoPad = clean.replace(/=+$/, "");
  if (roundTrip !== cleanNoPad) {
    log(reqId, `WARN ${label}: posible doble-encode detectado, usando valor decodificado una vez`);
  }
  return buf;
}

async function writeFiel({ cer_base64, key_base64, password }, reqId) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fiel-"));
  const cerPath = path.join(dir, "cert.cer");
  const keyPath = path.join(dir, "key.key");
  await fs.writeFile(cerPath, decodeCertField(cer_base64, "cer_base64", reqId));
  await fs.writeFile(keyPath, decodeCertField(key_base64, "key_base64", reqId));
  return { dir, cerPath, keyPath, password };
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} excedió ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Tries each selector in order, returns the first that appears. Surfaces a
// clear error (instead of a silent .catch(() => {})) when the SAT portal HTML
// has changed and none of the known selectors match.
async function clickFirstMatch(page, selectors, timeout, reqId) {
  for (const sel of selectors) {
    try {
      await page.click(sel, { timeout });
      log(reqId, `click ok: ${sel}`);
      return sel;
    } catch {
      // try next selector
    }
  }
  throw new Error(`Ningún selector coincidió: ${selectors.join(" | ")} (el portal SAT pudo haber cambiado su HTML)`);
}

async function captureDebugScreenshot(page, dir, reqId) {
  try {
    const shotPath = path.join(dir, "debug.png");
    await page.screenshot({ path: shotPath, fullPage: true });
    const buf = await fs.readFile(shotPath);
    return buf.toString("base64");
  } catch (e) {
    log(reqId, "No se pudo capturar screenshot de depuración", e.message);
    return undefined;
  }
}

async function loginSAT(page, fiel, reqId) {
  await page.goto("https://loginc.mat.sat.gob.mx/nidp/idff/sso?id=XAC-ConstanciasFIEL&sid=0&option=credential&sid=0", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await clickFirstMatch(page, ['a:has-text("e.firma")', 'a:has-text("E.firma")', 'a:has-text("FIEL")'], 10000, reqId);
  await page.setInputFiles('input[name="fileCertificado"]', fiel.cerPath);
  await page.setInputFiles('input[name="fileLlave"]', fiel.keyPath);
  await page.fill('input[name="password"]', fiel.password);
  await clickFirstMatch(page, ['input[type="submit"]', 'button[type="submit"]'], 10000, reqId);
  await page.waitForLoadState("networkidle", { timeout: 60000 });
}

// Runs `fn(browser, dir)` up to MAX_ATTEMPTS times with a fresh browser/profile
// each time, retrying on transient errors (SAT portal timeouts, flaky network).
// Surfaces a debug screenshot from the last failed attempt so failures are
// diagnosable from the API response/logs without shell access to Railway.
async function runWithRetry(reqId, fn) {
  let lastError;
  let lastShot;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await acquireBrowserSlot();
    let browser;
    let dir;
    try {
      log(reqId, `intento ${attempt}/${MAX_ATTEMPTS}: lanzando browser`);
      browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
      const result = await withTimeout(fn(browser, (d) => (dir = d)), REQUEST_TIMEOUT_MS, "flujo completo");
      log(reqId, `intento ${attempt}: OK`);
      return result;
    } catch (e) {
      lastError = e;
      log(reqId, `intento ${attempt} falló: ${e.message}`);
      if (browser && dir) {
        try {
          const ctx = browser.contexts()[0];
          const page = ctx?.pages()[0];
          if (page) lastShot = await captureDebugScreenshot(page, dir, reqId);
        } catch {}
      }
    } finally {
      await browser?.close().catch(() => {});
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      releaseBrowserSlot();
    }
  }
  const err = new Error(lastError?.message ?? "Fallo desconocido tras reintentos");
  err.debugScreenshotBase64 = lastShot;
  throw err;
}

// ---- /sat/sign — descifrado PBE + firma XML-DSig RSA-SHA1 ----
// Recibe el .key del SAT (binario DER cifrado con DES3/PBE), la contraseña
// y el texto C14N del SignedInfo. Devuelve la firma RSA-SHA1 en base64.
// Supabase Deno no puede descifrar PBE — por eso se delega aquí a Node.js.
app.post("/sat/sign", async (req, res) => {
  const { key_b64, password, xml } = req.body || {};
  if (!key_b64 || !password || !xml) {
    return res.status(400).json({ ok: false, error: "Faltan campos: key_b64, password, xml" });
  }

  try {
    // 1. Descifrar .key PBE con node-forge
    const keyDer = forge.util.decode64(key_b64);
    const keyAsn1 = forge.asn1.fromDer(keyDer);
    const encryptedPkInfo = forge.pki.encryptedPrivateKeyInfoFromAsn1(keyAsn1);
    const pkiAsn1 = forge.pki.decryptPrivateKeyInfo(encryptedPkInfo, password);
    if (!pkiAsn1) {
      return res.status(422).json({ ok: false, error: "PBE_ERROR: contraseña incorrecta o formato no reconocido" });
    }
    const privateKey = forge.pki.privateKeyFromAsn1(pkiAsn1);

    // 2. Firmar el XML (SignedInfo canonicalizado) con RSA-SHA1
    const md = forge.md.sha1.create();
    md.update(xml, "utf8");
    const signatureBytes = privateKey.sign(md);
    const signature = forge.util.encode64(signatureBytes);

    return res.json({ ok: true, signature });

  } catch (e) {
    console.error("[/sat/sign] Error:", e.message);
    return res.status(500).json({ ok: false, error: String(e?.message ?? e) });
  }
});

// ---- /constancia (alias: /csf) ----
async function handleConstancia(req, res) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const { rfc, cer_base64, key_base64, password } = req.body || {};
  if (!rfc || !cer_base64 || !key_base64 || !password)
    return res.status(400).json({ ok: false, error: "Missing rfc/cer_base64/key_base64/password" });

  log(reqId, `/constancia rfc=${rfc}`);
  try {
    const pdf_base64 = await runWithRetry(reqId, async (browser, setDir) => {
      const fiel = await writeFiel({ cer_base64, key_base64, password }, reqId);
      setDir(fiel.dir);
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await ctx.newPage();
      await loginSAT(page, fiel, reqId);

      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        clickFirstMatch(
          page,
          ['a:has-text("Generar Constancia")', 'button:has-text("Generar")', 'a[href*="ConsultaCif"]'],
          10000,
          reqId
        ),
      ]);

      const tmp = path.join(fiel.dir, "csf.pdf");
      await download.saveAs(tmp);
      return (await fs.readFile(tmp)).toString("base64");
    });

    res.json({ ok: true, metodo: "playwright", pdf_base64, rfc, ts: new Date().toISOString() });
  } catch (e) {
    log(reqId, `/constancia FALLÓ: ${e.message}`);
    res.status(500).json({
      ok: false,
      error: String(e?.message ?? e),
      debug_screenshot_base64: e.debugScreenshotBase64,
      url_manual: "https://www.sat.gob.mx/aplicacion/login/53027/genera-tu-constancia-de-situacion-fiscal",
    });
  }
}
app.post("/constancia", handleConstancia);
app.post("/csf", handleConstancia);

// ---- /opinion (alias: /opinion32d) ----
async function handleOpinion(req, res) {
  const reqId = crypto.randomUUID().slice(0, 8);
  const { rfc, cer_base64, key_base64, password } = req.body || {};
  if (!rfc || !cer_base64 || !key_base64 || !password)
    return res.status(400).json({ ok: false, error: "Missing rfc/cer_base64/key_base64/password" });

  log(reqId, `/opinion rfc=${rfc}`);
  try {
    const { resultado, positiva, pdf_base64 } = await runWithRetry(reqId, async (browser, setDir) => {
      const fiel = await writeFiel({ cer_base64, key_base64, password }, reqId);
      setDir(fiel.dir);
      const ctx = await browser.newContext({ acceptDownloads: true });
      const page = await ctx.newPage();

      await page.goto(
        "https://portalsat.plataforma.sat.gob.mx/SATAuthenticator/AuthLogin/showLogin.action?appOrigen=OpinionDelCumplimiento32DCFFInternetv2Web",
        { waitUntil: "domcontentloaded", timeout: 60000 }
      );
      await clickFirstMatch(page, ['a:has-text("e.firma")', 'a:has-text("E.firma")', 'a:has-text("FIEL")'], 10000, reqId);
      await page.setInputFiles('input[name="fileCertificado"]', fiel.cerPath);
      await page.setInputFiles('input[name="fileLlave"]', fiel.keyPath);
      await page.fill('input[name="password"]', fiel.password);
      await clickFirstMatch(page, ['input[type="submit"]', 'button[type="submit"]'], 10000, reqId);
      await page.waitForLoadState("networkidle", { timeout: 60000 });

      const bodyText = await page.locator("body").innerText().catch(() => "");
      const positiva = /positiva/i.test(bodyText);
      const negativa = /negativa/i.test(bodyText);

      let pdf_base64;
      try {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 30000 }),
          clickFirstMatch(page, ['a:has-text("Imprimir")', 'button:has-text("Imprimir")', 'a:has-text("PDF")'], 10000, reqId),
        ]);
        const tmp = path.join(fiel.dir, "opinion.pdf");
        await download.saveAs(tmp);
        pdf_base64 = (await fs.readFile(tmp)).toString("base64");
      } catch (e) {
        log(reqId, `no se pudo descargar PDF de opinión, continuando con resultado de texto: ${e.message}`);
      }

      return { resultado: positiva ? "POSITIVA" : negativa ? "NEGATIVA" : "DESCONOCIDO", positiva, pdf_base64 };
    });

    res.json({ ok: true, metodo: "playwright", rfc, resultado, positiva, pdf_base64, ts: new Date().toISOString() });
  } catch (e) {
    log(reqId, `/opinion FALLÓ: ${e.message}`);
    res.status(500).json({
      ok: false,
      error: String(e?.message ?? e),
      debug_screenshot_base64: e.debugScreenshotBase64,
      url_manual: "https://www.sat.gob.mx/aplicacion/operacion/32846/consulta-tu-opinion-de-cumplimiento-de-obligaciones-fiscales",
    });
  }
}
app.post("/opinion", handleOpinion);
app.post("/opinion32d", handleOpinion);

app.listen(PORT, () => console.log(`SAT scraper v1.2.0 listening on :${PORT} (maxConcurrentBrowsers=${MAX_CONCURRENT_BROWSERS}, maxAttempts=${MAX_ATTEMPTS})`));
