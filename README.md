# Mistral Agents Dashboard

App web minimale en TypeScript : un dashboard d'agents multi-agents pour créer
et améliorer des vidéos de cours, propulsé par l'API Mistral
(modèle `mistral-large-4`) via le SDK officiel `@mistralai/mistralai`.

## Installation et lancement en local

```bash
npm install
cp .env.example .env   # renseignez MISTRAL_API_KEY dans .env
npm run dev
```

Puis ouvrez http://localhost:3000.

> Sans `MISTRAL_API_KEY`, le serveur refuse de démarrer avec un message explicite.
> La clé reste exclusivement côté serveur (`.env` est gitignoré).

## Architecture

- `src/server.ts` — serveur `node:http` natif : sert `public/` + API JSON.
- `src/agents.ts` — les 5 agents seeds et leurs system prompts :
  Chef de projet → Scénariste → Voix → Monteur → QA.
- `src/store.ts` — persistance des agents et des exécutions dans `data/*.json` (gitignoré).
- `src/mistral.ts` — appels au modèle `mistral-large-4` via le SDK officiel.
- `public/index.html` — UI vanilla (sidebar agents/tâches, chat direct par agent,
  pipeline en direct via polling 2 s) avec une **vue graphe animée** : chaque agent
  est un petit personnage animé relié aux autres par des chemins ; le personnage
  actif pulse en orange et une bille parcourt le chemin au moment du passage du
  message vers l'agent suivant.

Chaque agent reçoit un brief contenant la tâche initiale + les sorties des
agents précédents (`client.chat.complete({ model: "mistral-large-4", messages })`).

## Skills mobilisés par agent

Les system prompts des agents sont enrichis par les skills Mistral Studio de
l'utilisateur :

| Agent | Skills mobilisés |
|---|---|
| Chef de projet | `brainstorming` + `grill-with-docs` (clarifier objectifs/non-objectifs/contraintes avant le brief) + `writing-plans` (mini-plan numéroté avant dispatch). Règle **adaptée TDA/H & TSA** (remplace « 1 idée = 1 scène = 1 phrase ») : 1 idée par scène, scènes ≈ 5–8 s, ancrage visuel dédié, transitions explicites, récapitulatifs, charge cognitive limitée |
| Scénariste | `video-cours-production` + `explainer-video` (storyboard d'abord, arc Problème → Enjeux → Solution → Comment → Payoff, beats horodatés, chapitrage, specs sous-titres ≤ 2 lignes / ≤ 42 caractères) — avec la règle TDA/H-TSA ci-dessus |
| Voix | `voxtral-narration` (normalisation du texte, `phoneme_hints`, tags inline `[emotion]`/`[pace]`, disfluences, régénération par segment) + `tts` (mode timeline, alignement SRT/audio, durées réelles par segment) |
| Monteur | famille `remotion-*` (code frame-deterministic, `useCurrentFrame`/`interpolate`, `<Sequence>`, `staticFile()`, captions `Caption` synchronisées, `remotion still` avant encodage) + styles au choix : `whiteboard-animation` (draw-on SVG + main marqueur), `diagram-animation` (révélation nœuds → arêtes → labels, focus+contexte), `isometric-animation` (2,5D, ombrage par face, lift en Z) + rendu statique `prefers-reduced-motion` |
| QA | `video-cours-production` (QA frame par frame du master rendu, corrections ciblées une valeur absolue à la fois) + `remotion-captions` (lisibilité et synchro des sous-titres : ≤ 2 lignes, ≤ 42 caractères/ligne, ≥ 1 s, zones de sécurité) |

## Qualité des agents (pratiques 2026)

- **Contrat commun** (`COMMON_CONTRACT` dans `src/agents.ts`, prépendé à chaque system prompt) : sortie structurée en JSON délimité pour tout ce qui est consommé par un autre agent, et règle « ne jamais inventer — écrire INCONNU / À VÉRIFIER ».
- **Budget de contexte** : chaque sortie précédente est tronquée à 4 000 caractères dans le brief ; `AGENT_MAX_TOKENS` (défaut 8192) borne la génération.
- **Boucle de réflexion bornée** : si le QA conclut « CORRECTIONS REQUISES », le Monteur révise à partir des corrections (étape ré-exécutée en place, visible dans le graphe) puis le QA re-vérifie — max `MAX_QA_REVISIONS` (défaut 2) itérations.

## API locale

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/agents` | Liste des agents |
| POST | `/api/agents` | Créer un agent |
| DELETE | `/api/agents/:id` | Supprimer un agent |
| POST | `/api/agents/:id/chat` | Chat direct avec un agent |
| POST | `/api/runs` | Lancer le pipeline `{ task }` |
| GET | `/api/runs/:id/artifacts/:file` | Télécharger un livrable (MP3, JSON, MD) |

## Livrables (artefacts)

Quand une tâche termine, le serveur produit des artefacts dans `data/artifacts/` (gitignoré) et les affiche dans l'UI (section « 🎁 Livrables ») :

- `transcript.json` — transcription complète de la tâche (toutes les sorties d'agents)
- `voix-off.mp3` — voix off synthétisée via l'API speech Mistral (`POST /v1/audio/speech`) à partir de la sortie de l'agent Voix
- `montage.md` — plan de montage produit par l'agent Monteur
- `video.mp4` — **rendu MP4 réel** : le code Remotion généré par le Monteur est compilé et rendu headless dans le dashboard (`src/render.ts`, 1920×1080@30 fps ; la **durée est calculée depuis le contenu** via le `calculateMetadata` exporté par l'agent — somme des durées audio réelles, jamais une valeur fixe ; `RENDER_DURATION_FRAMES` n'est qu'un fallback, `RENDER_VIDEO=0` désactive le rendu). Le lecteur vidéo est intégré à la section Livrables. Le template Remotion (npm install + Chrome Headless Shell via `npx remotion browser ensure`) est préparé automatiquement et mis en cache dans `data/render/template/`. **Prérequis système Linux** (Debian/Ubuntu) : `sudo apt-get install libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libasound2` ; sous Windows, aucun prérequis : le rendu et les commandes npm/npx fonctionnent nativement (`node_modules` du template lié par junction).

Le chat reste via le SDK officiel `@mistralai/mistralai` (`mistral-large-4`) ; la synthèse vocale passe par l'endpoint REST car le SDK 1.15.x n'expose pas encore `audio.speech`. La clé reste exclusivement côté serveur.

## Paramètres (clé API dans le dashboard)

Bouton **⚙ Paramètres** : saisir / supprimer la clé API directement dans l'UI. La clé est stockée dans `data/settings.json` (gitignoré) et n'est jamais renvoyée par l'API (statut masqué). Priorité : `MISTRAL_API_KEY` (env) > clé des paramètres. Sans aucune clé, le serveur démarre mais les appels renvoient `503` avec un message explicite.

## Voix clonée (Voxtral)

- Par défaut, la synthèse utilise le **clonage zero-shot** depuis `data/voice-ref.mp3` (champ `ref_audio`, base64) — fichier gitignoré.
- **Changer de voix sans toucher au serveur** : dans ⚙ Paramètres → « Importer une voix de référence », uploadez votre propre MP3/WAV (25 Mo max, voix claire d'un seul locuteur) via `POST /api/settings/voice-ref`. Le prochain TTS l'utilisera.
- Pour utiliser une voix prédéfinie ou une voix clonée enregistrée : `MISTRAL_TTS_VOICE=<voice_id>` (champ `voice_id`).
- Modèle TTS par défaut : `voxtral-mini-tts-3-0` (surchargeable via `MISTRAL_TTS_MODEL`).

## Mode interview (agent Interviewer)

Au lieu de décrire la vidéo, cliquez sur **🎤 Mode interview** : l'agent
**Interviewer** (6e agent, hors pipeline) vous pose des questions une par une
(sujet, public TDA/H-TSA ou non, durée, style visuel, voix, objectifs/non-objectifs)
puis produit un bloc `BRIEF FINAL` structuré. Un bouton **▶ Lancer le pipeline avec
ce brief** apparaît alors et démarre la tâche avec ce brief. Le chat conserve
l'historique (endpoint `/api/agents/:id/chat` accepte `messages` ou `message`).

## Joindre un cours à une tâche

Au lancement d'une tâche (« + Nouvelle tâche »), joignez un fichier de cours :

- **.md / .txt** : texte repris tel quel (2 Mo max)
- **.pdf / .jpg / .jpeg / .png** (20 Mo max) : texte extrait via l'**API OCR Mistral** (`POST /v1/ocr`, `mistral-ocr-latest`) — idéal pour les feuilles scannées/photos
- **OneNote** : exportez la page en `.md`/`.txt` (Fichier → Exporter) ou copiez-collez le texte dans un `.txt`, puis joignez-le

Le texte extrait est enregistré dans `data/courses/`, injecté dans le brief initial du pipeline (les agents travaillent directement dessus) et ajouté aux livrables téléchargeables.
| GET | `/api/runs` | Liste des exécutions |
| GET | `/api/runs/:id` | Détail d'une exécution (statuts running/done/error) |

## Scripts

- `npm run dev` — serveur en mode watch
- `npm run typecheck` — vérification TypeScript
- `npm test` — tests d'API (node:test, 11 tests, isolés via `DATA_DIR`)
- `npm run test:ui` — test Playwright du rendu réel (SKIP propre sans navigateur headless ; `npx -y playwright@1.65.1 install chromium` pour l'installer en local)

Les données (agents, tâches, artefacts) vivent dans `data/` — surchargeable via la
variable `DATA_DIR`, utilisée par les tests pour ne jamais écrire dans `data/`.
