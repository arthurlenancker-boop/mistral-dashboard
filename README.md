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
