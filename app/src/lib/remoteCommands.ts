// Unit A6 part 2 — `RemoteDetail.tsx`'s local `runHub(cmd, args, okMsg,
// actionKey?)` helper takes `cmd` as a runtime variable, never a string
// passed as a literal first argument to `invoke`, so `ipcParity.test.ts`'s
// scan of direct invoke call sites structurally cannot see these seven
// commands (they sit in `KNOWN_UNWIRED` there instead). This type is the
// exhaustive list `runHub`'s `cmd` parameter is narrowed to, so a call site
// that names a command outside this set — or a command dropped from here
// while a call site still uses it — is a compile error instead of a silent
// gap. `ipcParity.test.ts`'s `scanDispatchUnions()` reads the literals out of
// this file's `export type … =` block and folds them into F (the "frontend
// calls this" set) so the parity checks still see them.

export type RemoteDetailCommand =
	| "remote_sync"
	| "remote_resolve"
	| "remote_disable"
	| "remote_enable"
	| "remote_import_skill"
	| "remote_remove"
	| "remote_clear";
