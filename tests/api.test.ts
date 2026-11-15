import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3299;
const BASE = `http://localhost:${PORT}`;
let server: ChildProcess;
let workdir: string;

async function waitUp(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + "/api/agents");
      if (r.ok) return;
    } catch { /* pas encore prêt */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Le serveur de test n'a pas démarré");
}

before(async () => {
  workdir = mkdtempSync(join(tmpdir(), "mistral-dashboard-test-"));
  // node --import tsx : évite npx, inexistant en tant qu'exécutable sous Windows
  // (npx y est un .cmd) ; DATA_DIR isole toute écriture dans le workdir temporaire.
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: join(process.cwd()),
    env: { ...process.env, PORT: String(PORT), MISTRAL_API_KEY: "mstrl-fictive-test", DATA_DIR: workdir },
    stdio: "ignore",
  });
  await waitUp();
});

after(() => {
  server?.kill("SIGTERM");
  rmSync(workdir, { recursive: true, force: true });
});

const j = (r: Response) => r.json();

test("GET / sert l'UI (hero + graphe)", async () => {
  const r = await fetch(BASE + "/");
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /hero-graph/);
  assert.match(html, /@font-face/);
});

test("GET /api/agents renvoie 6 agents dont Interviewer hors pipeline", async () => {
  const r = await fetch(BASE + "/api/agents");
  assert.equal(r.status, 200);
  const agents = (await j(r)) as any[];
  assert.equal(agents.length, 6);
  const interviewer = agents.find((a) => a.name === "Interviewer");
  assert.equal(interviewer.inPipeline, false);
});

test("POST /api/runs sans tâche -> 400", async () => {
  const r = await fetch(BASE + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 400);
});

test("POST /api/runs crée une tâche avec 5 étapes dans l'ordre du pipeline", async () => {
  const r = await fetch(BASE + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "vidéo test" }) });
  assert.equal(r.status, 201);
  const run = (await j(r)) as any;
  assert.deepEqual(run.steps.map((s: any) => s.agentName), ["Chef de projet", "Scénariste", "Voix", "Monteur", "QA"]);
  assert.equal(run.status, "running");
  // isolation DATA_DIR : le run est bien persisté dans le workdir, pas dans data/ du dépôt
  assert.ok(existsSync(join(workdir, "runs.json")), "runs.json doit être écrit dans DATA_DIR");
  // avec une clé fictive, le pipeline doit passer en erreur proprement
  for (let i = 0; i < 40; i++) {
    const d = await (await fetch(`${BASE}/api/runs/${run.id}`)).json() as any;
    if (d.status !== "running") {
      assert.equal(d.status, "error");
      assert.equal(d.steps[0].status, "error");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.fail("Le run est resté bloqué en running");
});

test("GET /api/settings masque la clé", async () => {
  const r = await fetch(BASE + "/api/settings");
  const s = (await j(r)) as any;
  assert.equal(s.hasKey, true);
  assert.equal(s.source, "env");
  assert.ok(!JSON.stringify(s).includes("mstrl-fictive-test"));
});

test("POST /api/settings enregistre une clé (source=settings après suppression env impossible ici -> reste env)", async () => {
  const r = await fetch(BASE + "/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "mstrl-autre-fictive" }) });
  assert.equal(r.status, 200);
});

test("GET /api/settings/test avec clé fictive -> 401", async () => {
  const r = await fetch(BASE + "/api/settings/test");
  assert.equal(r.status, 401);
  const d = (await j(r)) as any;
  assert.equal(d.ok, false);
});

test("chat sans message -> 400", async () => {
  const agents = (await (await fetch(BASE + "/api/agents")).json()) as any[];
  const r = await fetch(`${BASE}/api/agents/${agents[0].id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 400);
});

test("artefact inconnu -> 404 et traversée de chemin bloquée", async () => {
  const r1 = await fetch(BASE + "/api/runs/abc/artifacts/x.mp3");
  assert.equal(r1.status, 404);
  const r2 = await fetch(BASE + "/api/runs/abc/artifacts/..%2F..%2Fpackage.json");
  assert.equal(r2.status, 404);
});

test("upload voix : format invalide -> 400", async () => {
  const r = await fetch(BASE + "/api/settings/voice-ref", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filename: "x.exe", contentBase64: "AAAA" }) });
  assert.equal(r.status, 400);
});

test("polices auto-hébergées servies en font/woff2", async () => {
  const r = await fetch(BASE + "/fonts/Inter-400.woff2");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "font/woff2");
});
