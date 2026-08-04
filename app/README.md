# Skill Tree App

Skill Tree is the native desktop app for managing the Skill Hub registry.
It gives you a visual way to browse skills, edit `SKILL.md` content, manage reusable bundles, and control which skills are active for each project.

## What the app can do

### Browse the skill library

- View every registered skill and MCP server in one place
- Filter by type (`SKILL` vs `MCP`)
- Search by skill name or description
- Group skills by scope: global, portable, and project-specific

### Create and edit skills

- Create new skills from the UI
- Open a full editor for a skill's metadata and markdown content
- Edit:
  - name
  - description
  - scope
  - version
  - upstream link
  - `SKILL.md` body
- Use built-in markdown toolbar actions and live preview
- Archive skills when they are no longer needed

### Manage bundles

- Create bundles of related skills
- Add descriptions and icons to bundles
- Pick bundle membership from the registered skills list
- Update bundle contents later
- See which projects a bundle is assigned to
- Delete bundles when they are no longer needed

### Manage projects

- Add projects to the registry
- Open a project workspace to see:
  - assigned bundles
  - individually enabled skills
  - globally available skills
  - other available skills that can be equipped
- Equip or unequip skills per project
- Apply or remove bundles from a project
- Remove a project from the registry without changing the project files themselves

### Sync the registry to agent folders

- Run `hub sync` from the app
- Refresh registry-backed UI after changes
- See sync status feedback in the interface
- Keep `.claude/skills/` and `.agents/skills/` aligned with the resolved active skills

### Navigate quickly

- Use the sidebar to jump between skills, projects, and bundles
- Use the command palette to search across the registry
- Reopen recently visited items
- Trigger common actions like creating a skill or syncing

### Handle environment issues

- Detect when Python 3 is unavailable
- Show a guided error state explaining how to fix the missing runtime

## App structure

- **Frontend:** React + TypeScript + Vite
- **Desktop shell:** Tauri 2
- **State/data:** Zustand + TanStack Query
- **Editor:** CodeMirror
- **Motion/UI polish:** Framer Motion

## Run the app

### Development

```bash
cd app
npm install
npm run tauri dev
```

### Production build

```bash
cd app
npm install
npm run tauri build
```

Then copy the built app bundle to `/Applications` if desired.

## Launch the installed app

```bash
hub dashboard
```

Or open **Skill Tree.app** directly from `/Applications`.

## Test commands

```bash
npm test
npm run test:e2e
```

## Notes

- Skill Tree replaces the older FastAPI dashboard.
- The app depends on Python 3 because registry operations are delegated through `hub.py`.
- The registry remains the source of truth; the app is a native UI for working with it safely and quickly.
