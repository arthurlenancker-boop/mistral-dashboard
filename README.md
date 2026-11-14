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
- `voix-off.mp3` — voix off synthétisée via l'API speech Mistral (`POST /v1/audio/speech`, modèle `voxtral-small-latest` par défaut, surchargeable via `MISTRAL_TTS_MODEL` / `MISTRAL_TTS_VOICE`) à partir de la sortie de l'agent Voix
- `montage.md` — plan de montage produit par l'agent Monteur

Le chat reste via le SDK officiel `@mistralai/mistralai` (`mistral-large-4`) ; la synthèse vocale passe par l'endpoint REST car le SDK 1.15.x n'expose pas encore `audio.speech`. La clé reste exclusivement côté serveur.

## Paramètres (clé API dans le dashboard)

Bouton **⚙ Paramètres** : saisir / supprimer la clé API directement dans l'UI. La clé est stockée dans `data/settings.json` (gitignoré) et n'est jamais renvoyée par l'API (statut masqué). Priorité : `MISTRAL_API_KEY` (env) > clé des paramètres. Sans aucune clé, le serveur démarre mais les appels renvoient `503` avec un message explicite.

## Voix clonée (Voxtral)

- Par défaut, la synthèse utilise le **clonage zero-shot** depuis `data/voice-ref.mp3` (champ `ref_audio`, base64) — fichier gitignoré, à remplacer par votre propre enregistrement (MP3/WAV, voix claire d'un seul locuteur).
- Pour utiliser une voix prédéfinie ou une voix clonée enregistrée : `MISTRAL_TTS_VOICE=<voice_id>` (champ `voice_id`).
- Modèle TTS par défaut : `voxtral-mini-tts-3-0` (surchargeable via `MISTRAL_TTS_MODEL`).
| GET | `/api/runs` | Liste des exécutions |
| GET | `/api/runs/:id` | Détail d'une exécution (statuts running/done/error) |

## Scripts

- `npm run dev` — serveur en mode watch
- `npm run typecheck` — vérification TypeScript
