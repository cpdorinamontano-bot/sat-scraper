# SAT Scraper (Playwright)

Microservicio para descargar **Constancia de Situación Fiscal (CSF)** y **Opinión de Cumplimiento 32-D** del portal SAT usando e.Firma.

> La descarga de CFDI (sat_solicitar/verificar/descargar_paquete) ya NO depende de este servicio — vive en las Supabase Edge Functions `sat-hub` / `sat-crypto-bridge` / `sat-autenticar`. Este repo solo cubre CSF y Opinión, que requieren un navegador (Playwright) y por eso no pueden vivir en Deno Edge Functions.

## Endpoints

- `GET  /health` → `{ ok: true, inFlight }`
- `POST /constancia` (alias `POST /csf`) → body: `{ rfc, cer_base64, key_base64, password }` → `{ ok, pdf_base64, rfc }`
- `POST /opinion` (alias `POST /opinion32d`) → body: `{ rfc, cer_base64, key_base64, password }` → `{ ok, pdf_base64, resultado, positiva }`
- `POST /sat/sign` → firma RSA-SHA1 para WS-Security (usado por sat-crypto-bridge cuando se requiere descifrado PBE)

Auth: header `X-Api-Key: <SCRAPER_API_KEY>`.

Cada request reintenta hasta `MAX_ATTEMPTS` veces con un navegador nuevo antes de fallar. Si falla, la respuesta incluye `debug_screenshot_base64` con una captura de pantalla del último intento para diagnosticar sin acceso a Railway.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `SCRAPER_API_KEY` | — | Requerido en producción; protege todos los endpoints excepto `/` y `/health` |
| `MAX_CONCURRENT_BROWSERS` | `2` | Tope de instancias Chromium simultáneas (evita OOM en el plan de Railway) |
| `MAX_ATTEMPTS` | `2` | Reintentos por request antes de devolver error |
| `REQUEST_TIMEOUT_MS` | `110000` | Timeout total del flujo completo (login + descarga) por intento |

## Despliegue en Railway

1. Sube este repo a GitHub.
2. En Railway: **New → Deploy from GitHub repo** → selecciona `sat-scraper`.
3. **Settings → Variables**: añade `SCRAPER_API_KEY` (cualquier string aleatorio). Opcional: ajusta `MAX_CONCURRENT_BROWSERS`/`MAX_ATTEMPTS`.
4. **Settings → Networking → Generate Domain** (puerto `8080`).
5. **Settings → Regions**: solo `us-west2` (NO uses `sfo`).
6. **Settings → Resources**: asigna al menos 1 GB de RAM por instancia de Chromium concurrente permitida (`MAX_CONCURRENT_BROWSERS`). Con el default de 2, usar ≥2 GB.
7. Confirma que el plan no tenga "sleep on inactivity" habilitado (solo aplica a planes free/trial; en planes de pago Railway no duerme el servicio).

Pasa la URL pública (`https://xxx.up.railway.app`) y `SCRAPER_API_KEY` a Lovable/Supabase.
