# Flip Xiangqi MVP Implementation Plan

> **For Hermes:** Follow `subagent-driven-development`, `test-driven-development`, and `requesting-code-review` while executing this plan. Complete phases in order and keep Multica issues updated.

**Goal:** Deliver a playable local two-player Flip Xiangqi MVP that covers PHASE1 through PHASE5 from the roadmap.

**Architecture:** Use a React + TypeScript frontend with a pure rules engine in `src/game/`. Keep domain types, board setup, move validation, check/checkmate logic, and UI rendering separated so the engine is testable without the browser.

**Tech Stack:** Vite, React, TypeScript, Vitest, Testing Library.

---

## Task 1: Bootstrap the app skeleton (PHASE1)

**Objective:** Create the project scaffold and establish the UI-vs-engine boundary.

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`
- Create: `src/main.tsx`, `src/App.tsx`, `src/styles.css`
- Create: `src/game/`, `src/components/`
- Test: `src/game/__tests__/smoke.test.ts`

**Steps:**
1. Write a failing smoke test proving the game engine module is loadable.
2. Run the targeted test and verify failure.
3. Add the Vite/React/Vitest scaffold and minimal engine entry point.
4. Re-run the targeted test and then the full suite.
5. Commit.

## Task 2: Implement core domain models (PHASE1)

**Objective:** Model board coordinates, piece identities, visibility, camps, and full game state.

**Files:**
- Create: `src/game/types.ts`, `src/game/constants.ts`, `src/game/state.ts`
- Test: `src/game/__tests__/state.test.ts`

**Steps:**
1. Write tests for board size, initial piece inventory, and state shape.
2. Verify RED.
3. Implement minimal types/constants/state helpers.
4. Verify GREEN with targeted and full tests.
5. Commit.

## Task 3: Generate randomized hidden openings (PHASE2)

**Objective:** Build the opening generator that keeps kings fixed and randomizes all other pieces onto legal starting squares.

**Files:**
- Create: `src/game/setup.ts`
- Modify: `src/game/state.ts`
- Test: `src/game/__tests__/setup.test.ts`

**Steps:**
1. Write tests for fixed king positions, 30 hidden pieces, and legal opening squares.
2. Verify RED.
3. Implement the generator.
4. Verify GREEN with focused tests and full suite.
5. Commit.

## Task 4: Add turn state and flip action handling (PHASE2)

**Objective:** Support turn ownership, flipping a hidden piece as one action, and turn switching.

**Files:**
- Create: `src/game/actions.ts`
- Modify: `src/game/state.ts`
- Test: `src/game/__tests__/flip-action.test.ts`

**Steps:**
1. Write tests for flipping, revealing ownership, and turn advancement.
2. Verify RED.
3. Implement flip action resolution.
4. Verify GREEN with targeted and full tests.
5. Commit.

## Task 5: Implement movement rules for every piece (PHASE3)

**Objective:** Validate standard Xiangqi movement with hidden-piece occupancy/blocking rules.

**Files:**
- Create: `src/game/move-rules.ts`
- Modify: `src/game/actions.ts`
- Test: `src/game/__tests__/move-rules.test.ts`

**Steps:**
1. Write focused tests for rook, knight, cannon, elephant, advisor, soldier, and king movement.
2. Verify RED.
3. Implement move generation/validation.
4. Verify GREEN with focused tests and full suite.
5. Commit.

## Task 6: Enforce capture restrictions and illegal-action reasons (PHASE3)

**Objective:** Prevent direct captures on hidden pieces, handle cannon screen logic, and return explicit validation errors.

**Files:**
- Modify: `src/game/actions.ts`, `src/game/move-rules.ts`, `src/game/types.ts`
- Test: `src/game/__tests__/capture-rules.test.ts`

**Steps:**
1. Write tests for hidden target rejection, cannon edge cases, and friendly-piece blocking.
2. Verify RED.
3. Implement minimal logic and error reporting.
4. Verify GREEN.
5. Commit.

## Task 7: Add check, facing-kings, and endgame logic (PHASE4)

**Objective:** Recompute threats after every action and reject moves that leave your own king in check.

**Files:**
- Create: `src/game/check.ts`
- Modify: `src/game/actions.ts`, `src/game/state.ts`
- Test: `src/game/__tests__/checkmate.test.ts`

**Steps:**
1. Write tests for check detection, facing kings, illegal self-check, and checkmate.
2. Verify RED.
3. Implement threat analysis and outcome calculation.
4. Verify GREEN with targeted and full tests.
5. Commit.

## Task 8: Build the board UI and interaction flow (PHASE5)

**Objective:** Render a playable board with click-to-flip, select, move, and restart interactions.

**Files:**
- Create: `src/components/Board.tsx`, `src/components/StatusPanel.tsx`, `src/components/CapturedPieces.tsx`
- Modify: `src/App.tsx`, `src/styles.css`
- Test: `src/components/__tests__/app-flow.test.tsx`

**Steps:**
1. Write a UI test for flipping, selecting, and showing turn / error / restart state.
2. Verify RED.
3. Implement minimal UI wired to the engine.
4. Verify GREEN with targeted and full tests.
5. Commit.

## Task 9: Final verification and documentation pass

**Objective:** Confirm the MVP is test-covered, understandable, and ready to ship.

**Files:**
- Modify: `README.md`
- Review: entire repo

**Steps:**
1. Update README with setup and gameplay notes.
2. Run all tests.
3. Run an independent review.
4. Commit final polish.
5. Push and update Multica issues/comments.

## Validation

- `npm test`
- `npm run build`
- `npm run test:ui` (if added)
- Manual browser smoke test via Vite preview

## Risks / Notes

- Hidden pieces must count as blockers before reveal.
- Flip actions must still trigger check-state recomputation.
- Keep the rules engine deterministic when a seeded RNG is injected for tests.
- Prefer clarity over premature optimization; MVP scope excludes networking, AI, and advanced animation.
