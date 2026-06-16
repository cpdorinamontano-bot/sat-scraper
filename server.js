import express from "express";
import { chromium } from "playwright";
import forge from "node-forge";
import fs from "fs/promises";
import path from "path";
import os from "os";

const PORT = process.env.PORT || 8080;
const API_KEY = process.env.SCRAPER_API_KEY || "";

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

app.get("/health", (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.get("/", (_, res) => res.json({ name: "sat-scraper", version: "1.1.0" }));

// ---- helpers ----
async function writeFiel({ cer_base64, key_base64, password }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fiel-"));
  const cerPath = path.join(dir, "cert.cer");
  const keyPath = path.join(dir, "key.key");
  await fs.writeFile(cerPath, Buffer.from(cer_base64, "base64"));
  await fs.writeFile(keyPath, Buffer.from(key_base64, "base64"));
  return { dir, cerPath, keyPath, password };
}

async function loginSAT(page, fiel) {
  await page.goto("https://loginc.mat.sat.gob.mx/nidp/idff/sso?id=XAC-ConstanciasFIEL&sid=0&option=credential&sid=0", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.click('a:has-text("e.firma")', { timeout: 10000 }).catch(() => {});
  await page.setInputFiles('input[name="fileCertificado"]', fiel.cerPath);
  await page.setInputFiles('input[name="fileLlave"]', fiel.keyPath);
  await page.fill('input[name="password"]', fiel.password);
  await page.click('input[type="submit"], button[type="submit"]');
  await page.waitForLoadState("networkidle", { timeout: 60000 });
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

// ---- /constancia ----
app.post("/constancia", async (req, res) => {
  const { rfc, cer_base64, key_base64, password } = req.body || {};
  if (!rfc || !cer_base64 || !key_base64 || !password)
    return res.status(400).json({ ok: false, error: "Missing rfc/cer_base64/key_base64/password" });

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  let dir;
  try {
    const fiel = await writeFiel({ cer_base64, key_base64, password });
    dir = fiel.dir;
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    await loginSAT(page, fiel);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      page.click('a:has-text("Generar Constancia"), button:has-text("Generar"), a[href*="ConsultaCif"]').catch(() => {}),
    ]);

    const tmp = path.join(dir, "csf.pdf");
    await download.saveAs(tmp);
    const pdf = await fs.readFile(tmp);

    res.json({
      ok: true,
      metodo: "playwright",
      pdf_base64: pdf.toString("base64"),
      rfc,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e), url_manual: "https://www.sat.gob.mx/aplicacion/login/53027/genera-tu-constancia-de-situacion-fiscal" });
  } finally {
    await browser.close().catch(() => {});
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---- /opinion ----
app.post("/opinion", async (req, res) => {
  const { rfc, cer_base64, key_base64, password } = req.body || {};
  if (!rfc || !cer_base64 || !key_base64 || !password)
    return res.status(400).json({ ok: false, error: "Missing rfc/cer_base64/key_base64/password" });

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  let dir;
  try {
    const fiel = await writeFiel({ cer_base64, key_base64, password });
    dir = fiel.dir;
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();

    await page.goto("https://portalsat.plataforma.sat.gob.mx/SATAuthenticator/AuthLogin/showLogin.action?appOrigen=OpinionDelCumplimiento32DCFFInternetv2Web", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.click('a:has-text("e.firma")', { timeout: 10000 }).catch(() => {});
    await page.setInputFiles('input[name="fileCertificado"]', fiel.cerPath);
    await page.setInputFiles('input[name="fileLlave"]', fiel.keyPath);
    await page.fill('input[name="password"]', fiel.password);
    await page.click('input[type="submit"], button[type="submit"]');
    await page.waitForLoadState("networkidle", { timeout: 60000 });

    const bodyText = await page.locator("body").innerText().catch(() => "");
    const positiva = /positiva/i.test(bodyText);
    const negativa = /negativa/i.test(bodyText);

    let pdf_base64;
    try {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30000 }),
        page.click('a:has-text("Imprimir"), button:has-text("Imprimir"), a:has-text("PDF")').catch(() => {}),
      ]);
      const tmp = path.join(dir, "opinion.pdf");
      await download.saveAs(tmp);
      pdf_base64 = (await fs.readFile(tmp)).toString("base64");
    } catch {}

    res.json({
      ok: true,
      metodo: "playwright",
      rfc,
      resultado: positiva ? "POSITIVA" : negativa ? "NEGATIVA" : "DESCONOCIDO",
      positiva,
      pdf_base64,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message ?? e), url_manual: "https://www.sat.gob.mx/aplicacion/operacion/32846/consulta-tu-opinion-de-cumplimiento-de-obligaciones-fiscales" });
  } finally {
    await browser.close().catch(() => {});
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`SAT scraper v1.1.0 listening on :${PORT}`));
