# Vagues dashboard : voix longue durée, finitions, itération vidéo — Plan d'implémentation

> **Pour les exécutants :** SUB-SKILL REQUIS : utiliser superpowers:subagent-driven-development (recommandé) ou superpowers:executing-plans pour implémenter ce plan tâche par tâche. Les étapes utilisent des cases (`- [ ]`) pour le suivi.

**Objectif :** Trois vagues pour le dashboard d'agents — (1) itérer sur une vidéo produite (corrections utilisateur → Monteur → QA → livrables régénérés), (2) voix off sans troncature silencieuse pour les cours longs, (3) finitions produit (suppression de tâche, CRUD agents).

**Architecture :** Le serveur `node:http` existant (`src/server.ts`), le store JSON (`src/store.ts`) et l'UI vanilla (`public/index.html`) absorberont chaque tâche sans restructuration. Aucune nouvelle dépendance. Les routes suivent le modèle existant : JSON partout, échecs en `{ error: "message français" }`.

**Stack :** TypeScript strict, `node:test` + tsx, Playwright (`tests/ui.test.mjs`), `fetch` global (TTS/OCR), Remotion (rendu existant).

**Spéc :** Design court approuvé en conversation (l'utilisateur a retenu les trois vagues) :
1. **Itérer** : `POST /api/runs/:id/revise` — Monteur révise à partir des corrections ciblées (même mécanique que la boucle QA bornée existante), QA re-vérifie, livrables régénérés. Révisions visibles dans la même tâche. Alternative écartée : tout rediscuter via le chat (perd le contexte du run) ; le chat gagne juste un contexte optionnel (tâche 5).
2. **Voix longue** : découpage par phrases ≤ ~1800 caractères, un appel TTS par paquet, concaténation des MP3. Alternative écartée : découpage par segments du tableau de l'agent Voix (parsing fragile).
3. **Finitions** : `DELETE /api/runs/:id` (+ nettoyage artefacts/rendu), `PUT /api/agents/:id`, UI créer/modifier agent. L'API POST agents existait sans UI.

## Contraintes globales

- `npm run typecheck` doit passer (tsc strict, aucun `any` nouveau).
- `npm test` et `npm run test:ui` verts sur Windows local (exigence de la session) et CI Linux.
- Aucune nouvelle dépendance runtime (`package.json` inchangé hors script `test`).
- Copie UI en français, style et ton existants (`button.primary`/`ghost`, toasts, `.del.confirm` deux clics).
- Les tests n'écrivent jamais hors de `DATA_DIR` (isolation déjà en place).
- Toute erreur d'appel externe remonte un message français explicite, sans faire planter la route.

## Review Focus

1. **Supprimer une tâche pendant qu'elle tourne** : `saveRun` la recréerait (idx -1 → unshift). Comportement attendu : `DELETE` refuse avec `409` et un message. Test possible sans couvrir la rareté temporelle : couvert par test unitaire du refus sur statut `running` (tâche 2, étape 1 : on fige un run en `running` via un run fraîchement créé AVANT que le pipeline n'échoue — sinon le 409 est vérifié par le code + revue).
2. **Revise sur une tâche sans sortie Monteur** (run en erreur ou en cours) : `400` explicite, jamais d'appel modèle. Couvert (tâche 4).
3. **TTS courte** (≤ `TTS_CHUNK_MAX`) : un seul chunk, comportement identique à l'existant. Couvert (tâche 1).
4. **Suppression sans artefacts** (run en erreur, aucun fichier) : ne jette pas. Couvert (tâche 2).
5. **Régénération des livrables** : la liste d'artefacts ne double pas à chaque revise (recréée à plat, entrées « Cours source » préservées). Structure vérifiée par revue (le chemin nominal exige une vraie clé API).

---

### Task 1: Voix off longue durée (chunking TTS)

**Fichiers :**
- Modify: `src/tools.ts`
- Create: `tests/tools.test.ts`
- Modify: `package.json` (script `test`)

**Interfaces :**
- Produces (pour les exécutants des tâches suivantes et les tests) : `export const TTS_CHUNK_MAX = 1800` et `export function splitTtsChunks(text: string): string[]` dans `src/tools.ts`. Le texte passé est déjà normalisé par `synthesizeSpeech` (espaces repliées, trim). Retour : groupes de phrases ≤ `TTS_CHUNK_MAX`, chaque phrase intacte ; phrase unique > max → découpe brute au caractère ; texte vide → `[]`. `synthesizeSpeech(text: string): Promise<Buffer>` garde sa signature : n'appelle l'API qu'aussi souvent qu'il y a de chunks, concatène les MP3 (`Buffer.concat`), et remonte l'erreur du chunk qui échoue en la préfixant `Chunk ${i}/${n} : `.

- [ ] **Étape 1 : écrire les tests en échec**

`tests/tools.test.ts` (nouveau fichier, `node:test` + `assert/strict`, import depuis `../src/tools.js`) :

```ts
test("splitTtsChunks : texte court -> un seul chunk identique", () => {
  const chunks = splitTtsChunks("Bonjour. Ceci est court.");
  assert.deepEqual(chunks, ["Bonjour. Ceci est court."]);
});

test("splitTtsChunks : long texte -> chunks <= TTS_CHUNK_MAX, phrases intactes, rien perdu", () => {
  const sentence = "Une phrase complete de longueur fixe pour tester. "; // ~55 car.
  const text = sentence.repeat(60).trim(); // ~3 300 car. -> plusieurs chunks
  const chunks = splitTtsChunks(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.equal(chunks.join(" "), text);
  assert.ok(chunks.every((c) => c.startsWith("Une phrase"))); // chaque chunk commence au début d'une phrase, phrases jamais coupées au milieu
});

test("splitTtsChunks : phrase unique > max -> decoupe brute", () => {
  const text = "a".repeat(4000);
  const chunks = splitTtsChunks(text);
  assert.deepEqual(chunks, ["a".repeat(1800), "a".repeat(1800), "a".repeat(400)]);
});

test("splitTtsChunks : vide -> []", () => {
  assert.deepEqual(splitTtsChunks(""), []);
});
```

- [ ] **Étape 2 : lancer et constater l'échec**

Run: `npm test`
Attendu : FAIL — `splitTtsChunks`/`TTS_CHUNK_MAX` non exportés (module import error), et le reste de la suite reste au vert.

- [ ] **Étape 3 : implémenter dans `src/tools.ts`**

Découpage : `text.split(/(?<=[.!?…])\s+/).filter(Boolean)`, accumulation dans un buffer par phrases jusqu'à dépasser `TTS_CHUNK_MAX` (alors on flush), hard-cut `slice(0, 1800)` pour une phrase trop longue. Dans `synthesizeSpeech` : remplacer le `.slice(0, 2000)` par les chunks (0 chunk → erreur « Texte vide » existante), boucle séquentielle sur l'appel fetch existant (le corps de requête par chunk est construit à l'identique — voice_id ou ref_audio), `Buffer.concat(buffers)` en retour.

- [ ] **Étape 4 : lancer les tests**

Run: `npm test` — attendu : nouveaux tests OK, 11 tests API précédents toujours verts.
Run: `npm run typecheck` — attendu : aucune erreur.

- [ ] **Étape 5 : commit**

```bash
git add src/tools.ts tests/tools.test.ts package.json
git commit -m "TTS longue durée : découpage par phrases (chunk <= 1800) + concaténation MP3, plus de troncature silencieuse"
```

---

### Task 2: Suppression de tâche + nettoyage des livrables

**Fichiers :**
- Modify: `src/store.ts`
- Modify: `src/tools.ts`
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Modify: `tests/api.test.ts`
- Modify: `tests/ui.test.mjs`

**Interfaces :**
- Consumes: `DATA_DIR` (store) — déjà exporté.
- Produces: `export function deleteRun(id: string): boolean` (store : retire du tableau, `false` si absent). `export function deleteRunArtifacts(runId: string): void` (tools : unlink tous les `${runId}__*` de `ARTIFACTS_DIR`, no-op si dossier absent — pas de throw). Serveur : `DELETE /api/runs/:id` → `404` inconnu, `409 { error: "La tâche est en cours" }` si `status === "running"`, sinon `200 { ok: true }` + suppression du run, des artefacts et du répertoire de rendu `join(DATA_DIR, "render", runId)` (`rmSync` force). UI : croix `.del` sur chaque `.run-item` avec le même confirm deux clics que les agents ; après suppression, si c'était la tâche affichée, retour sur la vue d'accueil du hero (réinjection du hero + `renderHeroGraph()`).

- [ ] **Étape 1 : écrire les tests API en échec**

Dans `tests/api.test.ts` (après le test pipeline existant) :

```ts
test("DELETE /api/runs/:id supprime la tâche et ses artefacts", async () => {
  const r = await fetch(BASE + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "tâche à supprimer" }) });
  const run = (await j(r)) as any;
  for (let i = 0; i < 40; i++) { const d = await (await fetch(`${BASE}/api/runs/${run.id}`)).json() as any; if (d.status === "error") break; await new Promise((x) => setTimeout(x, 250)); }
  // déposer un artefact factice pour vérifier le nettoyage
  writeFileSync(join(workdir, "artifacts", `${run.id}__voix-off.mp3`), Buffer.from("x"));
  const d = await fetch(`${BASE}/api/runs/${run.id}`, { method: "DELETE" });
  assert.equal(d.status, 200);
  assert.equal(existsSync(join(workdir, "artifacts", `${run.id}__voix-off.mp3`)), false);
  const list = (await (await fetch(BASE + "/api/runs")).json()) as any[];
  assert.ok(!list.some((x) => x.id === run.id));
  assert.equal((await fetch(`${BASE}/api/runs/${run.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/runs/${run.id}`, { method: "DELETE" })).status, 404);
});
```

(imports à ajouter : `writeFileSync` depuis `node:fs`.)

- [ ] **Étape 2 : lancer et constater l'échec**

Run: `npm test` — attendu : FAIL sur le nouveau test (404 ou 405 → jamais 200).

- [ ] **Étape 3 : implémenter**

`deleteRun` dans store.ts (filter + length comparé), `deleteRunArtifacts` dans tools.ts (`readdirSync` + `startsWith(runId + "__")` + `unlinkSync`), route serveur : étendre le bloc `runMatch` existant avec une branche `DELETE` (404 / 409 / 200, cleanupRender via `rmSync(join(DATA_DIR, "render", id), { recursive: true, force: true })`).

- [ ] **Étape 4 : test UI correspondant**

Dans `tests/ui.test.mjs`, ajouter un check (`await check(...)`) : créer une tâche via l'UI (clic `#new-task`, remplir, lancer), attendre la vue run, retour à l'accueil, cliquer la croix de suppression une fois (état confirm) puisannuler… — version simple : premier clic ajoute `.confirm`, second clic supprime et fait disparaître la ligne.

- [ ] **Étape 5 : lancer toute la suite**

Run: `npm test` puis `npm run test:ui` puis `npm run typecheck` — tout vert.

- [ ] **Étape 6 : commit**

```bash
git add src/store.ts src/tools.ts src/server.ts public/index.html tests/api.test.ts tests/ui.test.mjs
git commit -m "Suppression de tâche : DELETE /api/runs/:id (409 si en cours) + nettoyage artefacts et rendu + croix confirm 2 clics dans la sidebar"
```

---

### Task 3: CRUD agents (PUT + UI créer/modifier)

**Fichiers :**
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Modify: `tests/api.test.ts`
- Modify: `tests/ui.test.mjs`

**Interfaces :**
- Produces: serveur `PUT /api/agents/:id` — body `{ name?, role?, order?, systemPrompt?, inPipeline? }`, seuls les champs fournis sont mis à jour (`name` trim et non vide sinon `400`, `order` coercé `Number`, `inPipeline` booléen), `404` inconnu, `200` renvoie l'agent mis à jour. UI : bouton « + Nouvel agent » dans l'en-tête de la section Agents de la sidebar ; bouton ✎ sur chaque ligne d'agent ; les deux ouvrent le même panneau formulaire (zone `#content` style `settings`) — champs `#ae-name`, `#ae-role`, `#ae-order` (number), `#ae-prompt` (textarea), `#ae-pipeline` (checkbox) ; boutons « Enregistrer » (POST `/api/agents` si création, PUT si édition), « Annuler » (retour hero). Après enregistrement : toast, `refreshSidebar()`, et si édition sans changement de vue : simplement reload de la liste.

- [ ] **Étape 1 : écrire les tests API en échec**

```ts
test("PUT /api/agents/:id met à jour partiellement, 404 inconnu, 400 name vide", async () => {
  const agents = (await (await fetch(BASE + "/api/agents")).json()) as any[];
  const put = await fetch(`${BASE}/api/agents/${agents[1].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "nouveau rôle", order: "7" }) });
  assert.equal(put.status, 200);
  const updated = (await j(put)) as any;
  assert.equal(updated.role, "nouveau rôle");
  assert.equal(updated.order, 7);
  assert.equal((await fetch(BASE + "/api/agents/agent_inconnu", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "x" }) })).status, 404);
  assert.equal((await fetch(`${BASE}/api/agents/${agents[1].id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "  " }) })).status, 400);
});
```

- [ ] **Étape 2 : lancer et constater l'échec**

Run: `npm test` — FAIL (PUT → 404 route inconnue).

- [ ] **Étape 3 : implémenter serveur**

Dans le bloc `agentMatch` (qui gère déjà DELETE) : ajouter la branche `PUT` avec merge des champs fournis.

- [ ] **Étape 4 : implémenter l'UI**

Bouton + dans `<h2>Agents</h2>` (mettre le h2 en flex avec le bouton à droite), croix ✎ à côté du `.del` existant dans le template de ligne d'agent, handler `#agents` onclick étendu (`data-edit`), panneau formulaire, POST/PUT existants côté API (POST déjà en place).

- [ ] **Étape 5 : test UI correspondant**

Check Playwright : clic « + Nouvel agent » → formulaire visible ; remplir nom, envoyer → la ligne apparaît dans la sidebar (`.agent-name` contient le nom).

- [ ] **Étape 6 : suite complète + commit**

```bash
npm test && npm run test:ui && npm run typecheck
git add src/server.ts public/index.html tests/api.test.ts tests/ui.test.mjs
git commit -m "CRUD agents : PUT /api/agents/:id + UI créer/modifier (nom, rôle, ordre, prompt, pipeline)"
```

---

### Task 4: Itération vidéo — `POST /api/runs/:id/revise` + régénération des livrables

**Fichiers :**
- Modify: `src/store.ts`
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Modify: `tests/api.test.ts`
- Modify: `README.md` (table API + paragraphe itération)

**Interfaces :**
- Consumes: `complete`, `buildBrief`, `COMMON_CONTRACT` (mistral.ts) ; `pipelineAgents()` ; `produceArtifacts` (server.ts — partagé) ; `deleteRunArtifacts` n'est PAS utilisé ici.
- Produces: store `export interface RunRevision { corrections: string; requestedAt: string; status: "running" | "done" | "error"; error?: string }` ; `Run.revisions?: RunRevision[]`. Serveur : `POST /api/runs/:id/revise` body `{ corrections }` — `404` inconnu ; `400` corrections absentes/vides ; `400` si aucune étape « Monteur » avec sortie ou `run.status !== "done"` (message : « Rien à réviser : la tâche doit être terminée »). Sinon : `200` renvoie le run (statut repassé à `"running"`, `revisions` avec la nouvelle entrée `status: "running"`), puis exécution asynchrone en `void` (même pattern que `runPipeline`) : Monteur reçoit `buildBrief(task, previousOutputs)` + `\n\nCORRECTIONS DEMANDÉES PAR L'UTILISATEUR (itération N) :\n${corrections}\nApplique UNIQUEMENT ces corrections ciblées, ne réécris pas tout.` → sa step est mise à jour en place (status/startedAt/endedAt/output) ; QA re-vérifie une fois (si l'agent QA existe) ; puis `produceArtifacts(run)` ; `run.status` → `"done"` (ou `"error"` + `revision.status: "error"` + message si un appel échoue). **`produceArtifacts` est changé : la liste d'artefacts est recréée à plat (plus de push cumulatif), en préservant les entrées existantes dont `label` commence par `"Cours source"`.** UI : quand `run.status === "done"`, la vue run affiche une section `#revise-box` (`.step`) — textarea `#revise-input` + bouton `#send-revisions` « Envoyer les corrections » → POST revise → `showRun(id, true)` (polling reprend) ; un bloc « Révisions » liste `run.revisions` (corrections + date + statut).

- [ ] **Étape 1 : écrire les tests API en échec**

```ts
const r0 = await fetch(BASE + "/api/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ task: "tâche revise" }) });
const err = (await j(r0)) as any;
for (let i = 0; i < 40; i++) { const d = await (await fetch(`${BASE}/api/runs/${err.id}`)).json() as any; if (d.status === "error") break; await new Promise((x) => setTimeout(x, 250)); }

test("revise : 404 run inconnu", async () => {
  const r = await fetch(BASE + "/api/runs/run_inconnu/revise", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ corrections: "x" }) });
  assert.equal(r.status, 404);
});

test("revise : 400 sans corrections", async () => {
  const r = await fetch(`${BASE}/api/runs/${err.id}/revise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
});

test("revise : 400 run en erreur sans sortie Monteur -> rien à réviser", async () => {
  const r = await fetch(`${BASE}/api/runs/${err.id}/revise`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ corrections: "raccourcis la scène 3" }) });
  assert.equal(r.status, 400);
  const d = (await j(r)) as any;
  assert.match(d.error, /terminée/i);
});
```

- [ ] **Étape 2 : lancer et constater l'échec**

Run: `npm test` — FAIL (404 via route inconnue → JSON API renverrait "Introuvable" 404 : le premier test passerait par accident, les deux non → ajuster : attendu FAIL sur `400` attendu mais route inconnue renvoie 404).

- [ ] **Étape 3 : implémenter store + serveur**

`RunRevision` dans store.ts ; route avant le `runMatch` (regex `^/api/runs/([^/]+)/revise$`) ; re-brief comme la boucle QA existante de `runPipeline` (réutiliser son pattern de rebuild de `previousOutputs`) ; exécution async `void reviseRun(run, task, corrections).catch(...)` ; refactor léger : extraire `regenerateArtifacts` ou modifier `produceArtifacts` en place pour recréer la liste.

- [ ] **Étape 4 : implémenter l'UI**

Section revise (visible si `run.status === "done"`), bloc Révisions, POST → polling. Le test Playwright de la tâche 2 continue de passer (la vue run d'un run error n'affiche ni l'un ni l'autre).

- [ ] **Étape 5 : suite complète + commit**

```bash
npm test && npm run test:ui && npm run typecheck
git add src/store.ts src/server.ts public/index.html tests/api.test.ts README.md
git commit -m "Itération vidéo : POST /api/runs/:id/revise (Monteur revisé + QA re-check + livrables régénérés), section ✏ Itérer et historique des révisions dans la vue tâche"
```

(Vérification du chemin nominal avec une vraie clé API : manuelle, hors suite automatisée — documentée dans le README.)

---

### Task 5: Chat contextualisé à une tâche

**Fichiers :**
- Modify: `src/server.ts`
- Modify: `public/index.html`
- Modify: `tests/api.test.ts`
- Modify: `README.md` (documenter `runId` dans la ligne du chat de la table API)

**Interfaces :**
- Consumes: `buildBrief` (mistral.ts) ; `getRun` (store).
- Produces: serveur `POST /api/agents/:id/chat` accepte `runId` optionnel — run inconnu → `404 { error: "Run introuvable" }` ; connu → le system message devient `${COMMON_CONTRACT}\n\n${agent.systemPrompt}\n\nCONTEXTE DE LA TÂCHE :\n${buildBrief(run.task, outputsOf(run))}` où `outputsOf` liste toutes les steps avec sortie (`{ agentName, output }`). UI : dans la vue run, chaque carte `.step` gagne un bouton « discuter » (classe `step-chat`) ; clic → `showChat(agent, undefined, run.id)` ; `showChat` accepte un 3e argument optionnel `contextRunId` : l'indiquer dans `#view-title` (`Chat avec Monteur — tâche <id>`), l'inclure dans le body du POST chat, et NE PAS persister ce contexte dans l'historique localStorage (la valeur est gardée dans l'état du chat courant).

- [ ] **Étape 1 : test API en échec**

```ts
test("chat avec runId inconnu -> 404", async () => {
  const agents = (await (await fetch(BASE + "/api/agents")).json()) as any[];
  const r = await fetch(`${BASE}/api/agents/${agents[0].id}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "que penses-tu de la scène 3 ?" }], runId: "run_inconnu" }) });
  assert.equal(r.status, 404);
});
```

- [ ] **Étape 2 : constater l'échec**

Run: `npm test` — FAIL (le chat répond actuellement 500 sans clé et ignore runId — le test attend 404).

- [ ] **Étape 3 : implémenter serveur + UI**

Validation runId AVANT l'appel modèle ; construction du system message contextué ; bouton par step dans la vue run (`render` de `showRun` — placer le bouton dans le `<h3>` de chaque step) ; `showChat(agent, onReply?, contextRunId?)`.

- [ ] **Étape 4 : suite complète + commit**

```bash
npm test && npm run test:ui && npm run typecheck
git add src/server.ts public/index.html tests/api.test.ts README.md
git commit -m "Chat contextualisé : /api/agents/:id/chat accepte runId (tâche + sorties en contexte), bouton discuter par étape dans la vue tâche"
```
