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
  pipeline en direct via polling 2 s).

Chaque agent reçoit un brief contenant la tâche initiale + les sorties des
agents précédents (`client.chat.complete({ model: "mistral-large-4", messages })`).

## Skills mobilisés par agent

Les system prompts des agents sont enrichis par les skills Mistral Studio de
l'utilisateur :

| Agent | Skills mobilisés |
|---|---|
| Chef de projet | — (brief structuré, règle d'or 1 idée = 1 scène = 1 phrase) |
| Scénariste | `video-cours-production` (storyboard d'abord, prompts structurés avec beats horodatés, chapitrage, itération par corrections ciblées) + `explainer-video` (arc Problème → Enjeux → Solution → Comment → Payoff, script-first à ~2,3 mots/s, une seule analogie, specs sous-titres ≤ 2 lignes / ≤ 42 caractères) |
| Voix | `voxtral-narration` (normalisation du texte, `phoneme_hints`, tags inline `[emotion]`/`[pace]`, disfluences, régénération par segment) + `tts` (mode timeline, alignement SRT/audio, durées réelles par segment) |
| Monteur | famille `remotion-*` : `remotion-best-practices` (animation par code frame-deterministic), `remotion-create`/`remotion-markup` (`useCurrentFrame`/`interpolate`, `useVideoConfig`, `<Sequence>`, `staticFile()`, durées dérivées des données), `remotion-captions` (type `Caption`, synchro sur l'audio), `remotion-render`/`remotion-studio` (vérification frame par frame avant encodage) |
| QA | `video-cours-production` (QA frame par frame du master rendu, corrections ciblées une valeur absolue à la fois) + `remotion-captions` (lisibilité et synchro des sous-titres : ≤ 2 lignes, ≤ 42 caractères/ligne, ≥ 1 s, zones de sécurité) |

## API locale

| Méthode | Chemin | Description |
|---|---|---|
| GET | `/api/agents` | Liste des agents |
| POST | `/api/agents` | Créer un agent |
| DELETE | `/api/agents/:id` | Supprimer un agent |
| POST | `/api/agents/:id/chat` | Chat direct avec un agent |
| POST | `/api/runs` | Lancer le pipeline `{ task }` |
| GET | `/api/runs` | Liste des exécutions |
| GET | `/api/runs/:id` | Détail d'une exécution (statuts running/done/error) |

## Scripts

- `npm run dev` — serveur en mode watch
- `npm run typecheck` — vérification TypeScript
