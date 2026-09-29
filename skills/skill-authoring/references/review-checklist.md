# Skill review checklist

Run every item against the skill. A red item is a fix, not a note. Report the
result as a table with three columns: item, red or green, fix applied.

## A. Trigger (the description)

| # | Check | How to check | Fix when red |
|---|---|---|---|
| A1 | States what the skill does and when to use it | Read it as a stranger; both halves present? | Rewrite with the formula: what, when, phrases, boundary |
| A2 | Carries the literal phrases a user would type | Compare with the intent notes | Add two or three quoted phrases |
| A3 | At or under 200 characters | `wc -c` on the folded text | Cut adjectives first, then move detail into the body |
| A4 | Names a boundary when a neighbouring skill could fire | List adjacent skills in the library | Add "Not for X; use `other`" |
| A5 | Would not fire on three near-miss prompts | Say the prompts aloud; decide | Add the boundary, never delete keywords |
| A6 | Not a summary of the workflow | Does it list steps? | Replace steps with the situation that calls for them |

## B. Body

| # | Check | How to check | Fix when red |
|---|---|---|---|
| B1 | Opens with what changes about how the agent works | First paragraph | Replace background with the change |
| B2 | Has a gotchas section of environment facts | Section present, facts non-obvious | Add the corrections you had to make while writing |
| B3 | Workflow is numbered and each step has a checkable end | Read each step's last sentence | Add the end state or merge the step |
| B4 | Has a done-criteria section the agent can verify | Section present, criteria checkable | Add it; convert claims to checks |
| B5 | Contains nothing the model already knows | For each paragraph ask "would the agent get this wrong without it?" | Delete |
| B6 | Critical constraints sit at the top or the bottom | Locate the MUST-level lines | Move them |
| B7 | One default with an escape hatch, not a menu | Look for "you can either" | Pick the default; name the exception |
| B8 | Names the step the agent will skip and pre-empts the excuse | Look at validation and review steps | Add "do not skip because ..." |
| B9 | Under 500 lines; references used above about 150 | `wc -l` | Move material to `references/`, say when to read |
| B10 | Examples are concrete and one per pattern | Count examples per rule | Cut duplicates; make the one example real |
| B11 | Imperative voice, "why" given once, no MUST stacks | Grep for MUST, NEVER, ALWAYS | Rewrite; keep one reason |

## C. Skill Tree fit

| # | Check | How to check | Fix when red |
|---|---|---|---|
| C1 | `name` equals directory name, slug only | `ls`, frontmatter | Rename one to match |
| C2 | Scope matches reach: `global` only when needed everywhere | Registry `scope` | `hub set-meta <name> --scope portable` |
| C3 | Invocation matches use: `user-only` for deliberate rituals | Frontmatter flags | `hub set-meta <name> --invocation user-only` |
| C4 | `harnesses` set only when the body needs one harness's tools | Frontmatter | Remove or narrow |
| C5 | Skill mentions use backtick or slash form | Grep for other skill names | Wrap in backticks |
| C6 | Every referenced skill exists in the library | `hub skill refs <name> --json` | Fix the name or mute with `--refs-ignore` |
| C7 | `ships_with` only for companions the workflow cannot work without | Frontmatter | Remove; describe the manual step instead |
| C8 | Claude-only fields are not load-bearing for Codex or opencode | Read with those harnesses in mind | Add a plain-text fallback |

## D. Files and safety

| # | Check | How to check | Fix when red |
|---|---|---|---|
| D1 | No machine path, no backslash path | Grep for a home-directory prefix, a drive letter, a backslash | Make it relative or a placeholder |
| D2 | Every linked file exists, one level deep | Follow each link | Create, move, or drop the link |
| D3 | Scripts handle their own errors and print what they did | Read the script | Add checks and messages |
| D4 | No secret, token, or private hostname | Grep for `token`, `key`, `@` | Replace with a `${VAR}` reference |
| D5 | Content would not surprise the user if described aloud | Read the whole skill once | Remove the surprising part |
| D6 | No time-sensitive statement that will rot | Grep for dates, "currently", "new" | Make it timeless or dated |

## E. Proof

| # | Check | How to check | Fix when red |
|---|---|---|---|
| E1 | Two or three test prompts exist | Intent notes or `evals/` | Write them |
| E2 | With-skill run beat the no-skill run in a nameable way | Compare outputs and traces | Cut or sharpen the skill |
| E3 | Trace shows no instruction followed that did not apply | Read the with-skill trace | Split or trim the body |
| E4 | `hub sync` reports no warning for the skill | Run it after registering | Fix the warned field |
