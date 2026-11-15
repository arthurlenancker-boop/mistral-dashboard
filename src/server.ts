import http from "node:http";
import { readFileSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { SEED_AGENTS, COMMON_CONTRACT, type Agent } from "./agents.js";
import {
  getAgents,
  saveAgents,
  getAgent,
  getRuns,
  getRun,
  saveRun,
  deleteRun,
  newRunId,
  getSettings,
  saveSettings,
  DATA_DIR,
  type Run,
  type RunStep,
  type RunRevision,
  type Artifact,
} from "./store.js";
import {
  complete,
  buildBrief,
  getClient,
  resetClient,
  apiKeySource,
  effectiveApiKey,
} from "./mistral.js";
import {
  saveArtifactFile,
  readArtifactFile,
  deleteRunArtifacts,
  artifactMime,
  artifactFilePath,
  synthesizeSpeech,
  TTS_MODEL,
  TTS_VOICE,
  voiceReferencePath,
  saveVoiceReference,
  saveCourseFile,
  extractCourseText,
} from "./tools.js";
import { extractRemotionCode, renderVideoToFile } from "./render.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(process.cwd(), "public");

if (!process.env.MISTRAL_API_KEY && !getSettings().apiKey) {
  console.warn(
    "Avertissement : aucune clé API Mistral. Le serveur démarre mais les appels API échoueront jusqu'à configuration (variable MISTRAL_API_KEY ou page Paramètres du dashboard).",
  );
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 40 * 1024 * 1024; // 40 Mo (uploads base64 inclus)

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Corps de requête trop volumineux (40 Mo max)");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("JSON invalide dans le corps de la requête");
  }
}

function serveStatic(
  res: http.ServerResponse,
  pathname: string,
): boolean {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const path = join(PUBLIC_DIR, file);
  if (!path.startsWith(PUBLIC_DIR) || !existsSync(path)) return false;
  const ext = extname(path);
  const mime = MIME[ext];
  if (!mime) return false;
  res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
  res.end(readFileSync(path));
  return true;
}

/** Ids des agents qui composent le pipeline d'origine (seeds inPipeline !== false).
 * Ils sont identifiés PAR LEUR NOM dans les runs : livrables (outputOf("Voix")/
 * "Monteur"), boucle QA et revise. Renommer ou retirer du pipeline l'un d'eux
 * casserait ces lookups en silence -> refusé via PUT. */
const PIPELINE_SEED_IDS = SEED_AGENTS.filter((s) => s.inPipeline !== false).map((s) => s.id);

/** Agents du pipeline : agents seed, hors agents interactifs, triés par ordre. */
function pipelineAgents(): Agent[] {
  return getAgents()
    .filter((a) => SEED_AGENTS.some((s) => s.id === a.id) && a.inPipeline !== false)
    .sort((a, b) => a.order - b.order);
}

/**
 * Sorties réelles d'une tâche : les steps avec une sortie, mappées
 * { agentName, output } — même forme que previousOutputs du pipeline.
 */
function outputsOf(run: Run): { agentName: string; output: string }[] {
  const outputs: { agentName: string; output: string }[] = [];
  for (const step of run.steps)
    if (step.output) outputs.push({ agentName: step.agentName, output: step.output });
  return outputs;
}

async function runPipeline(run: Run, task: string): Promise<void> {
  const agents = pipelineAgents();
  const previousOutputs: { agentName: string; output: string }[] = [];
  for (const step of run.steps) {
    const agent = agents.find((a) => a.id === step.agentId);
    if (!agent) continue;
    step.status = "running";
    step.startedAt = new Date().toISOString();
    run.updatedAt = step.startedAt;
    saveRun(run);
    try {
      const output = await complete([
        { role: "system", content: `${COMMON_CONTRACT}\n\n${agent.systemPrompt}` },
        { role: "user", content: buildBrief(task, previousOutputs) },
      ]);
      step.status = "done";
      step.output = output;
      previousOutputs.push({ agentName: agent.name, output });
    } catch (err) {
      step.status = "error";
      step.error = err instanceof Error ? err.message : String(err);
      run.status = "error";
      step.endedAt = new Date().toISOString();
      saveRun(run);
      return;
    }
    step.endedAt = new Date().toISOString();
    run.updatedAt = step.endedAt;
    saveRun(run);
  }
  // Boucle de réflexion bornée : si le QA demande des corrections, le Monteur
  // révise (max MAX_QA_REVISIONS itérations), puis le QA re-vérifie.
  const MAX_REVISIONS = Number(process.env.MAX_QA_REVISIONS ?? 2);
  const qaStep = run.steps.find((st) => st.agentName === "QA");
  const monteurStep = run.steps.find((st) => st.agentName === "Monteur");
  const qaAgent = agents.find((a) => a.id === qaStep?.agentId);
  const monteurAgent = agents.find((a) => a.id === monteurStep?.agentId);
  let revisions = 0;
  while (
    revisions < MAX_REVISIONS &&
    qaStep?.output && /CORRECTIONS REQUISES/i.test(qaStep.output) &&
    monteurStep && qaAgent && monteurAgent
  ) {
    revisions++;
    const qaOutput = qaStep.output;
    previousOutputs.length = 0;
    for (const st of run.steps) if (st.output) previousOutputs.push({ agentName: st.agentName, output: st.output });
    // Le Monteur révise à partir des corrections du QA
    monteurStep.status = "running";
    run.updatedAt = new Date().toISOString();
    saveRun(run);
    const revised = await complete([
      { role: "system", content: `${COMMON_CONTRACT}\n\n${monteurAgent.systemPrompt}` },
      { role: "user", content: `${buildBrief(task, previousOutputs)}\n\nCORRECTIONS DU QA (itération ${revisions}/${MAX_REVISIONS}) :\n${qaOutput}\nApplique UNIQUEMENT ces corrections ciblées, ne réécris pas tout.` },
    ]);
    monteurStep.status = "done";
    monteurStep.output = revised;
    monteurStep.endedAt = new Date().toISOString();
    previousOutputs.length = 0;
    for (const st of run.steps) if (st.output) previousOutputs.push({ agentName: st.agentName, output: st.output });
    // Le QA re-vérifie
    qaStep.status = "running";
    saveRun(run);
    const qaOut = await complete([
      { role: "system", content: `${COMMON_CONTRACT}\n\n${qaAgent.systemPrompt}` },
      { role: "user", content: buildBrief(task, previousOutputs) },
    ]);
    qaStep.status = "done";
    qaStep.output = qaOut;
    qaStep.endedAt = new Date().toISOString();
    run.updatedAt = new Date().toISOString();
    saveRun(run);
  }

  run.status = "done";
  run.updatedAt = new Date().toISOString();
  saveRun(run);
  try {
    await produceArtifacts(run);
  } catch (err) {
    console.error("Erreur production d'artefacts:", err);
  }
}

/**
 * Itération demandée par l'utilisateur (POST /api/runs/:id/revise) : le Monteur
 * révise sa sortie à partir des corrections, le QA re-vérifie une fois, puis
 * les livrables sont régénérés. Même mécanique que la boucle de réflexion du
 * QA dans runPipeline, déclenchée manuellement et en une seule passe.
 */
async function reviseRun(run: Run, task: string, revision: RunRevision, iteration: number): Promise<void> {
  const agents = pipelineAgents();
  const monteurStep = run.steps.find((st) => st.agentName === "Monteur");
  const qaStep = run.steps.find((st) => st.agentName === "QA");
  const monteurAgent = agents.find((a) => a.id === monteurStep?.agentId);
  const qaAgent = agents.find((a) => a.id === qaStep?.agentId);
  if (!monteurStep || !monteurAgent) {
    throw new Error("L'agent Monteur est introuvable ou hors pipeline — impossible de réviser");
  }
  const previousOutputs: { agentName: string; output: string }[] = [];
  for (const st of run.steps) if (st.output) previousOutputs.push({ agentName: st.agentName, output: st.output });
  // Le Monteur révise à partir des corrections de l'utilisateur
  monteurStep.status = "running";
  monteurStep.startedAt = new Date().toISOString();
  run.updatedAt = monteurStep.startedAt;
  saveRun(run);
  const revised = await complete([
    { role: "system", content: `${COMMON_CONTRACT}\n\n${monteurAgent.systemPrompt}` },
    { role: "user", content: `${buildBrief(task, previousOutputs)}\n\nCORRECTIONS DEMANDÉES PAR L'UTILISATEUR (itération ${iteration}) :\n${revision.corrections}\nApplique UNIQUEMENT ces corrections ciblées, ne réécris pas tout.` },
  ]);
  monteurStep.status = "done";
  monteurStep.output = revised;
  monteurStep.endedAt = new Date().toISOString();
  run.updatedAt = monteurStep.endedAt;
  previousOutputs.length = 0;
  for (const st of run.steps) if (st.output) previousOutputs.push({ agentName: st.agentName, output: st.output });
  // Le QA re-vérifie une fois (si l'agent QA existe)
  if (qaStep && qaAgent) {
    qaStep.status = "running";
    saveRun(run);
    const qaOut = await complete([
      { role: "system", content: `${COMMON_CONTRACT}\n\n${qaAgent.systemPrompt}` },
      { role: "user", content: buildBrief(task, previousOutputs) },
    ]);
    qaStep.status = "done";
    qaStep.output = qaOut;
    qaStep.endedAt = new Date().toISOString();
    run.updatedAt = qaStep.endedAt;
    saveRun(run);
  }
  run.status = "done";
  run.updatedAt = new Date().toISOString();
  revision.status = "done";
  saveRun(run);
  try {
    await produceArtifacts(run);
  } catch (err) {
    console.error("Erreur production d'artefacts:", err);
  }
}

/**
 * Produit les livrables d'une tâche terminée : transcription JSON complète,
 * voix off MP3 (API speech Mistral) à partir de la sortie de l'agent Voix,
 * et plan de montage Markdown à partir de la sortie de l'agent Monteur.
 * La liste est recréée à plat à chaque production (les livrables régénérés
 * remplacent les précédents), en préservant l'artefact du cours joint au
 * lancement de la tâche. Un échec d'artefact n'échoue pas la tâche.
 */
async function produceArtifacts(run: Run): Promise<void> {
  const artifacts: Artifact[] = (run.artifacts ?? []).filter((a) => a.label.startsWith("Cours source"));
  const outputOf = (name: string) =>
    run.steps.find((s) => s.agentName === name && s.output)?.output ?? "";

  artifacts.push(
    saveArtifactFile(
      run.id,
      { type: "json", name: "transcript.json", label: "Transcription complète (JSON)" },
      JSON.stringify(
        {
          task: run.task,
          status: run.status,
          createdAt: run.createdAt,
          steps: run.steps.map((s) => ({
            agent: s.agentName,
            status: s.status,
            output: s.output ?? null,
            error: s.error ?? null,
          })),
        },
        null,
        2,
      ),
    ),
  );

  const voixText = outputOf("Voix");
  if (voixText) {
    try {
      const audio = await synthesizeSpeech(voixText);
      artifacts.push(
        saveArtifactFile(
          run.id,
          { type: "audio", name: "voix-off.mp3", label: "Voix off (MP3 — API speech Mistral)" },
          audio,
        ),
      );
    } catch (err) {
      artifacts.push({
        type: "audio",
        name: "voix-off.mp3",
        label: "Voix off (MP3 — API speech Mistral)",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const montage = outputOf("Monteur");
  if (montage) {
    artifacts.push(
      saveArtifactFile(
        run.id,
        { type: "text", name: "montage.md", label: "Plan de montage (Markdown)" },
        montage,
      ),
    );
  }

  // Rendu MP4 réel depuis le code Remotion du Monteur (désactivable via RENDER_VIDEO=0)
  if (montage && process.env.RENDER_VIDEO !== "0") {
    const code = extractRemotionCode(montage);
    if (code) {
      try {
        const workDir = join(DATA_DIR, "render", run.id);
        const outFile = join(workDir, "video.mp4");
        mkdirSync(workDir, { recursive: true });
        renderVideoToFile(workDir, code, outFile);
        const target = artifactFilePath(run.id, "video.mp4");
        cpSync(outFile, target);
        artifacts.push({ type: "video", name: "video.mp4", label: "Vidéo finale (MP4, rendu Remotion)" });
      } catch (err) {
        console.error("Erreur rendu MP4:", err);
        artifacts.push({
          type: "video",
          name: "video.mp4",
          label: "Vidéo finale (MP4, rendu Remotion)",
          error: err instanceof Error ? err.message.split("\n")[0] : String(err),
        });
      }
    }
  }

  run.artifacts = artifacts;
  saveRun(run);
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? "GET";

  if (pathname === "/api/agents" && method === "GET") {
    json(res, 200, getAgents());
    return true;
  }

  if (pathname === "/api/agents" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.name !== "string" || !body.name.trim()) {
      json(res, 400, { error: "Le champ 'name' est requis" });
      return true;
    }
    const agents = getAgents();
    const agent: Agent = {
      id: `agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: String(body.name).trim(),
      role: String(body.role ?? "").trim(),
      order: Number(body.order ?? agents.length + 1),
      systemPrompt: String(body.systemPrompt ?? "Tu es un assistant utile."),
    };
    agents.push(agent);
    saveAgents(agents);
    json(res, 201, agent);
    return true;
  }

  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (agentMatch) {
    const id = decodeURIComponent(agentMatch[1]);
    if (method === "DELETE") {
      const agents = getAgents();
      const next = agents.filter((a) => a.id !== id);
      if (next.length === agents.length) {
        json(res, 404, { error: `Agent '${id}' introuvable` });
        return true;
      }
      saveAgents(next);
      json(res, 200, { ok: true });
      return true;
    }
    if (method === "PUT") {
      const body = await readBody(req);
      if (body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) {
        json(res, 400, { error: "Le champ 'name' doit être une chaîne non vide" });
        return true;
      }
      const agents = getAgents();
      const idx = agents.findIndex((a) => a.id === id);
      if (idx === -1) {
        json(res, 404, { error: `Agent '${id}' introuvable` });
        return true;
      }
      // Les agents du pipeline sont identifiés par leur nom dans les runs
      // (livrables Voix/Monteur, boucle QA, revise) : refuser nom/inPipeline.
      if (PIPELINE_SEED_IDS.includes(id) && (body.name !== undefined || body.inPipeline !== undefined)) {
        json(res, 400, {
          error: "Les agents du pipeline se voient refuser le changement de nom ou de retrait du pipeline (ils sont identifiés par leur nom). Modifiez le rôle, l'ordre ou le system prompt.",
        });
        return true;
      }
      const agent: Agent = { ...agents[idx] };
      if (body.name !== undefined) agent.name = String(body.name).trim();
      if (body.role !== undefined) agent.role = String(body.role).trim();
      if (body.order !== undefined) agent.order = Number(body.order);
      if (body.systemPrompt !== undefined) agent.systemPrompt = String(body.systemPrompt);
      if (body.inPipeline !== undefined) agent.inPipeline = Boolean(body.inPipeline);
      agents[idx] = agent;
      saveAgents(agents);
      json(res, 200, agent);
      return true;
    }
  }

  const chatMatch = pathname.match(/^\/api\/agents\/([^/]+)\/chat$/);
  if (chatMatch && method === "POST") {
    const agent = getAgent(decodeURIComponent(chatMatch[1]));
    if (!agent) {
      json(res, 404, { error: "Agent introuvable" });
      return true;
    }
    const body = await readBody(req);
    // Contextualisation à une tâche (optionnelle) : runId fourni -> la tâche et
    // les sorties des agents sont injectées dans le system message. Validé AVANT
    // tout appel modèle : un runId inconnu n'entraîne aucun coût d'API.
    let contextRun: Run | undefined;
    if (body.runId !== undefined) {
      contextRun = getRun(String(body.runId));
      if (!contextRun) {
        json(res, 404, { error: "Run introuvable" });
        return true;
      }
    }
    const history =
      Array.isArray(body.messages) && body.messages.length
        ? body.messages.filter(
            (m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
          )
        : typeof body.message === "string" && body.message.trim()
          ? [{ role: "user", content: String(body.message) }]
          : [];
    if (!history.length) {
      json(res, 400, { error: "Le champ 'message' (ou 'messages') est requis" });
      return true;
    }
    try {
      const systemMessage = contextRun
        ? `${COMMON_CONTRACT}\n\n${agent.systemPrompt}\n\nCONTEXTE DE LA TÂCHE :\n${buildBrief(contextRun.task, outputsOf(contextRun))}`
        : `${COMMON_CONTRACT}\n\n${agent.systemPrompt}`;
      const answer = await getClient().chat.complete({
        model: "mistral-large-4",
        messages: [{ role: "system", content: systemMessage }, ...history],
      });
      json(res, 200, {
        reply: answer.choices?.[0]?.message?.content ?? "",
      });
    } catch (err) {
      const status = apiKeySource() === "none" ? 503 : 500;
      json(res, status, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }

  if (pathname === "/api/settings" && method === "GET") {
    json(res, 200, {
      hasKey: apiKeySource() !== "none",
      source: apiKeySource(),
      ttsModel: TTS_MODEL,
      ttsVoice: TTS_VOICE || null,
      hasVoiceReference: voiceReferencePath() !== null,
    });
    return true;
  }

  if (pathname === "/api/settings/test" && method === "GET") {
    try {
      const r = await getClient().models.list();
      json(res, 200, { ok: true, models: Array.isArray(r.data) ? r.data.length : 0 });
    } catch (err) {
      json(res, 401, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === "/api/settings" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
      json(res, 400, { error: "Le champ 'apiKey' est requis" });
      return true;
    }
    const settings = getSettings();
    settings.apiKey = body.apiKey.trim();
    saveSettings(settings);
    resetClient();
    json(res, 200, { ok: true, source: apiKeySource() });
    return true;
  }

  if (pathname === "/api/settings" && method === "DELETE") {
    const settings = getSettings();
    delete settings.apiKey;
    saveSettings(settings);
    resetClient();
    json(res, 200, { ok: true, source: apiKeySource() });
    return true;
  }

  if (pathname === "/api/settings/voice-ref" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.filename !== "string" || typeof body.contentBase64 !== "string") {
      json(res, 400, { error: "Champs requis : 'filename' et 'contentBase64'" });
      return true;
    }
    try {
      const size = saveVoiceReference(body.filename, body.contentBase64);
      json(res, 200, { ok: true, bytes: size, hasVoiceReference: true });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return true;
  }

  if (pathname === "/api/runs" && method === "GET") {
    json(res, 200, getRuns());
    return true;
  }

  if (pathname === "/api/runs" && method === "POST") {
    const body = await readBody(req);
    if (typeof body.task !== "string" || !body.task.trim()) {
      json(res, 400, { error: "Le champ 'task' est requis" });
      return true;
    }
    const task = String(body.task).trim();
    const agents = pipelineAgents();
    const now = new Date().toISOString();
    const steps: RunStep[] = agents.map((a) => ({
      agentId: a.id,
      agentName: a.name,
      status: "pending",
    }));
    const run: Run = {
      id: newRunId(),
      task,
      status: "running",
      createdAt: now,
      updatedAt: now,
      steps,
    };
    let fullTask = task;
    if (body.course && typeof body.course.name === "string" && typeof body.course.contentBase64 === "string") {
      const apiKey = effectiveApiKey();
      if (!apiKey) {
        json(res, 503, { error: "Aucune clé API Mistral configurée (voir Paramètres) — nécessaire pour lire le cours" });
        return true;
      }
      try {
        const courseBuf = Buffer.from(body.course.contentBase64, "base64");
        saveCourseFile(body.course.name, courseBuf);
        const courseText = await extractCourseText(body.course.name, courseBuf, apiKey);
        run.course = body.course.name;
        fullTask = `${task}\n\n=== CONTENU DU COURS (${body.course.name}) ===\n${courseText}`;
        run.artifacts = [
          saveArtifactFile(
            run.id,
            { type: "text", name: body.course.name.replace(/\.[^.]+$/, "") + ".md", label: `Cours source extrait (${body.course.name})` },
            courseText,
          ),
        ];
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        return true;
      }
    }
    saveRun(run);
    json(res, 201, run);
    void runPipeline(run, fullTask).catch((err) => {
      run.status = "error";
      run.updatedAt = new Date().toISOString();
      saveRun(run);
      console.error("Erreur pipeline:", err);
    });
    return true;
  }

  // Route d'itération : déclarée avant le runMatch ($-ancré, pas de collision,
  // mais l'ordre rend la priorité explicite).
  const reviseMatch = pathname.match(/^\/api\/runs\/([^/]+)\/revise$/);
  if (reviseMatch && method === "POST") {
    const id = decodeURIComponent(reviseMatch[1]);
    const run = getRun(id);
    if (!run) {
      json(res, 404, { error: "Run introuvable" });
      return true;
    }
    const body = await readBody(req);
    const corrections = typeof body.corrections === "string" ? body.corrections.trim() : "";
    if (!corrections) {
      json(res, 400, { error: "Le champ 'corrections' est requis" });
      return true;
    }
    if (run.status !== "done" || !run.steps.some((st) => st.agentName === "Monteur" && st.output)) {
      json(res, 400, { error: "Rien à réviser : la tâche doit être terminée" });
      return true;
    }
    const now = new Date().toISOString();
    const iteration = (run.revisions?.length ?? 0) + 1;
    const revision: RunRevision = { corrections, requestedAt: now, status: "running" };
    run.revisions = [...(run.revisions ?? []), revision];
    run.status = "running";
    run.updatedAt = now;
    saveRun(run);
    json(res, 200, run);
    void reviseRun(run, run.task, revision, iteration).catch((err) => {
      run.status = "error";
      run.updatedAt = new Date().toISOString();
      revision.status = "error";
      revision.error = err instanceof Error ? err.message : String(err);
      saveRun(run);
      console.error("Erreur révision:", err);
    });
    return true;
  }

  const artifactMatch = pathname.match(/^\/api\/runs\/([^/]+)\/artifacts\/([^/]+)$/);
  if (artifactMatch && method === "GET") {
    const runId = decodeURIComponent(artifactMatch[1]);
    const name = decodeURIComponent(artifactMatch[2]);
    const run = getRun(runId);
    if (!run) {
      json(res, 404, { error: "Run introuvable" });
      return true;
    }
    const content = readArtifactFile(runId, name);
    if (!content) {
      json(res, 404, { error: "Artefact introuvable" });
      return true;
    }
    res.writeHead(200, {
      "Content-Type": artifactMime(name),
      "Content-Disposition": `attachment; filename="${name}"`,
      "Cache-Control": "no-store",
    });
    res.end(content);
    return true;
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch && method === "GET") {
    const run = getRun(decodeURIComponent(runMatch[1]));
    if (!run) json(res, 404, { error: "Run introuvable" });
    else json(res, 200, run);
    return true;
  }
  if (runMatch && method === "DELETE") {
    const id = decodeURIComponent(runMatch[1]);
    const run = getRun(id);
    if (!run) {
      json(res, 404, { error: "Run introuvable" });
      return true;
    }
    if (run.status === "running") {
      json(res, 409, { error: "La tâche est en cours" });
      return true;
    }
    // Nettoyages AVANT la suppression du run : si l'un échoue, la tâche reste
    // dans le store (pas de livrables orphelins) et la requête peut être rejouée.
    deleteRunArtifacts(id);
    rmSync(join(DATA_DIR, "render", id), { recursive: true, force: true });
    if (!deleteRun(id)) {
      json(res, 404, { error: "Run introuvable" });
      return true;
    }
    json(res, 200, { ok: true });
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (await handleApi(req, res, pathname)) return;
    if (serveStatic(res, pathname)) return;
    json(res, 404, { error: "Introuvable" });
  } catch (err) {
    json(res, 500, {
      error: err instanceof Error ? err.message : "Erreur interne",
    });
  }
});

server.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
