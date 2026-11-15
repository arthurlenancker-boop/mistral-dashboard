// Test UI (Playwright) : vérifie le rendu réel du dashboard dans un navigateur headless.
// Utilise le chrome-headless-shell téléchargé par Remotion si présent, sinon le chromium Playwright.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const workdir = mkdtempSync(join(tmpdir(), "mistral-dashboard-ui-"));

function chromePath() {
  // Chrome Headless Shell de Remotion s'il a déjà été téléchargé ; layout et binaire selon l'OS.
  const p = process.platform === "win32"
    ? join(process.cwd(), "data/render/template/node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe")
    : join(process.cwd(), "data/render/template/node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell");
  return existsSync(p) ? p : undefined;
}

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(BASE + "/api/agents")).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("serveur non démarré");
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(1); console.log("ok -", name); }
  catch (e) { results.push(0); console.log("FAIL -", name, "|", e.message.split("\n")[0]); }
}

let server, browser;
try {
  // node --import tsx : évite npx, inexistant en tant qu'exécutable sous Windows (npx y est un .cmd).
  // DATA_DIR isole toute écriture (runs.json, settings.json…) dans le workdir temporaire.
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, PORT: String(PORT), MISTRAL_API_KEY: "mstrl-fictive-test", DATA_DIR: workdir },
    stdio: "ignore",
  });
  await waitUp();
  try {
    browser = await chromium.launch({ executablePath: chromePath(), args: ["--no-sandbox"] });
  } catch (e) {
    console.log("SKIP UI: navigateur headless indisponible dans cet environnement (" + e.message.split("\n")[0] + "). Lancer `npx playwright install --with-deps chromium` ou exécuter en CI.");
    server?.kill("SIGTERM");
    process.exit(0);
  }
  const page = await browser.newPage();

  await check("landing : hero + graphe + 6 agents + rôles + how-it-works", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator("#hero-graph svg").waitFor({ state: "visible" });
    assert.equal(await page.locator(".agent-item").count(), 6);
    assert.ok(await page.locator(".agent-role").first().isVisible());
    await page.locator(".how").waitFor({ state: "visible" });
  });

  await check("deep link #/agent ouvre le chat avec le bon agent", async () => {
    const agents = await (await fetch(BASE + "/api/agents")).json();
    await page.goto(`${BASE}/#/agent/${agents[1].id}`, { waitUntil: "networkidle" });
    await page.locator("#chat-form").waitFor({ state: "visible" });
    assert.ok((await page.locator("#view-title").textContent()).includes(agents[1].name));
  });

  await check("paramètres : test clé fictive -> toast erreur", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click("#open-settings");
    await page.click("#test-key");
    await page.locator(".toast.error").waitFor({ state: "visible", timeout: 10000 });
  });

  await check("nouvelle tâche : formulaire -> lancement -> vue run (timeline + graphe)", async () => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click("#new-task");
    await page.fill("#task-input", "Vidéo de test UI");
    await page.click("#launch-task");
    await page.locator(".timeline svg").waitFor({ state: "visible", timeout: 10000 });
    await page.locator(".graph svg").waitFor({ state: "visible" });
    assert.ok((await page.locator("#view-title").textContent()).includes("Vidéo de test UI"));
  });
} finally {
  await browser?.close();
  server?.kill("SIGTERM");
  rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter((x) => x === 0).length;
console.log(`\n# ${results.length - failed} pass, ${failed} fail`);
process.exit(failed ? 1 : 0);
