# Backlog

Open work on `vm`'s dashboard, picked up from the "per-machine busy state, booting spinner"
change (`5de3e6a`). Roughly in order: verify first, then the races that change opened up, then
polish.

## 1. Verify `5de3e6a` by booting (not done yet)

It was only typechecked, linted and unit-tested: the cloud session had no Nix/QEMU. On a real
host:

- [ ] `vm`, `[u]` on machine A, then while it builds: move to B and use `u`, `d`, `x`, `y`, `k`,
      `e`, `i`, `n` - they should all work; A's own buttons stay disabled.
- [ ] A's row shows the braille spinner instead of `○` and the hint `booting…`; it turns into `●`
      once QEMU is up.
- [ ] `[n]` mid-boot, cancel the wizard: A still shows the spinner, and `[u]` on A is still
      refused.
- [ ] Create & up from the wizard while another machine is booting - both boot.
- [ ] `s` / `c` / `l` / `g` are disabled (on every machine) while anything is working, and come
      back once it's done.

## 2. Races that concurrent actions now allow

Before `5de3e6a` only one action could run at a time, so these could not happen from the
dashboard (they always could from two terminals).

- [ ] **SSH port clash.** `prepare` (`apps/vm/src/core/machine/index.ts`) picks
      `firstFreePort()` by probing for a listener. Two `up`s finishing their builds close
      together can both pick the same port before either QEMU binds it. Fix: reserve the port in
      `<state>/ssh-port` and skip ports another machine's state dir already claims (running or
      mid-boot), or retry on QEMU's "could not set up host forwarding".
- [ ] **flake.lock written twice.** `relockPathInputs` runs `nix flake update` on the repo's
      flake.lock; two builds that both hit it race on the same file. Serialise it (a module-level
      promise/mutex in `core/machine`).
- [ ] **Status line is shared.** Two builds stream into the one `notify` line and overwrite each
      other. Give each machine its own last progress line (shown in its row hint or detail pane)
      and keep the shared line for finished/failed messages.

## 3. "Booting" should last until the guest answers

- [ ] The spinner stops when QEMU's pid appears (`upDetached` returns), but the guest is still
      booting until SSH answers (`[s]` then waits). Keep the machine in `booting` until an
      **async** SSH probe succeeds (`spawn`, not `spawnSync` like `waitSsh` - it would freeze
      the UI), giving up when the pid goes away. Then show `● :port`.
- [ ] Machines started elsewhere (`vm up -d` in another terminal) never show booting. Maybe the
      same probe on the refresh timer for running machines not yet seen answering.

## 4. Lift the "no handoff while working" restriction

- [ ] ssh / console / lock / Add to GitHub are disabled while any machine works, because
      `runTuiSession` (`libs/dev-tools/libs/ui/app/runTuiSession`) runs the handoff with
      `spawnSync`. That blocks the event loop: the in-flight build's piped output stalls, and
      when the dashboard reopens it's a fresh `App` that has lost the in-flight action. Options:
  - run builds/launches as a detached `vm up -d` child whose progress goes to
    `<state>/up.log` (inside the machine's state dir, per AGENTS.md), with the dashboard tailing
    it and reading "booting" from a marker file there - survives handoffs *and* quitting;
  - or make the handoff async in dev-tools and keep `App` mounted underneath.
- [ ] Same root cause: `[q]` during a build - check whether the nix build dies with the
      dashboard. Either ask first ("A is still building - quit anyway?") or detach as above.

## 5. Polish

- [ ] The spinner re-renders the whole dashboard 10×/s while anything boots, because a
      `PickItem.label` is a string. In dev-tools: let a `PickItem` take a leading glyph node (or
      a `spinning` flag) so only that cell re-renders, and move giti's `SpinnerGlyph` from
      `apps/giti/src/ui/dashboard/SpinnerGlyph` to `libs/ui/components` for both apps.
- [ ] Spinner (or another mark) for other in-flight actions too - power off, kill - instead
      of only the `working…` hint?

## 6. Cloud sessions / tooling

- [ ] `.gitmodules` points `libs/dev-tools` at `git@github.com:...`; a cloud session can't fetch
      that and needs `git -c url."https://github.com/".insteadOf="git@github.com:" submodule
      update --init`. Consider a SessionStart hook that does that plus `bun install`, so
      `bun run typecheck` works out of the box.
- [ ] The cloud container's Bun rewrites `bun.lock` on `bun install` (lockfileVersion 2 → 1,
      biome 2.5.14 → 2.5.15). Pin the Bun version (e.g. `packageManager` in `package.json`) so
      sessions don't produce lockfile churn.
