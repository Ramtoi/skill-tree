//! Best-effort session enrichment for the ccusage scan.
//!
//! Adds titles, project context and Codex identity metadata to ccusage rows.
//! Claude and Codex tool counts, PRs, branch and native cost-state facts come
//! from canonical inspection. Pi retains its tool-count and breakdown reader
//! here until canonical Pi capture supplies those displayed fields.
//!
//! Reads are bounded and confined to each harness's transcript directory.
//! This module does not retain prompt bodies.
//!
//! Every extraction step is best-effort: a missing file, an oversized file, a
//! bad-UTF8 or malformed line, an unknown agent — all of these just leave that
//! row's `metadata` as it was. Nothing here may panic or bubble an error back
//! to the scan; see `enrich_sessions`.
//!
//! Two invariants hold for everything this module writes:
//!
//! 1. **Confinement.** A session file is only ever read from inside its
//!    harness root. The scan-reported `period` is untrusted input, so it is
//!    joined component-wise (never letting an absolute or `..` value replace
//!    or climb out of the root) and the resolved file is canonicalized back
//!    under the canonicalized root — which also refuses a symlink that points
//!    out of the root. See [`safe_session_path`] / [`confine_to_root`].
//! 2. **Label safety.** Every string written here is safe to render verbatim:
//!    it is scrubbed of path runs, length-capped, and dropped outright if it
//!    is still path-shaped. `usage::redact_scan_for_cache` hashes any
//!    path-shaped string into a `~/redacted/<hash>` placeholder before the
//!    cache write, and the frontend shows titles as labels, so a
//!    path-shaped label would come back out of the cache as a hash chip. See
//!    [`safe_label`].

use serde_json::Value;
use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::env;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Component, Path, PathBuf};

use super::expand_tilde;
use super::usage_codex_metadata;

/// A session transcript file this large is either corrupt or pathological —
/// skip it rather than read it into memory. Checked against the file's
/// METADATA length, so an oversized file is never opened or read at all. A
/// well-behaved session file is orders of magnitude under this.
pub(crate) const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Cap on how much of one line is buffered. A JSONL transcript line is
/// normally a few KB; a line past this cap is pathological (or a whole
/// corrupt file with no newline in it), and buffering it would let one bad
/// file pull up to `MAX_FILE_BYTES` into memory. The head is kept, the tail
/// drained and discarded, and the line is then skipped whole — half a line is
/// not parseable JSON and a partial tool-call count would be a lie.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
/// Cap on the scrubbed session title, in characters.
const MAX_TITLE_CHARS: usize = 160;
/// Cap on how much of a raw string is fed to the path scrubber. The scrubber
/// is a prefix scan per match, so an adversarially long value with many
/// matches would cost more than the capped output is worth.
const MAX_SCRUB_INPUT_CHARS: usize = 4096;
/// How far past a tool-call marker (e.g. `"type":"tool_use"`) to look for its
/// `"name":"..."` value, in bytes. Verified against real transcripts: the
/// id+name pair lands within a few dozen bytes of the marker; this generously
/// bounds the search so a pathological line can't turn per-occurrence lookup
/// into a scan of the whole line.
const TOOL_NAME_LOOKAHEAD_BYTES: usize = 256;
/// Cap on a rendered tool name, in characters. A tool/function name is a
/// short identifier; anything longer isn't one.
const MAX_TOOL_NAME_CHARS: usize = 64;
/// Cap on how many distinct tool names survive into `toolBreakdown` — top by
/// call count, ties broken by name (see `build_tool_breakdown`).
const MAX_TOOL_BREAKDOWN_ENTRIES: usize = 16;

/// Filesystem roots for the three enrichable harnesses' session logs.
pub struct EnrichRoots {
    pub claude_projects: PathBuf,
    pub codex_sessions: PathBuf,
    pub pi_sessions: PathBuf,
}

/// The real `~/.claude/projects`, `~/.codex/sessions`, `~/.pi/agent/sessions`.
/// A free function (not a `Default` impl) so call sites read as "give me the
/// real roots" rather than looking like a cheap struct literal.
pub fn default_roots() -> EnrichRoots {
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/"));
    EnrichRoots {
        claude_projects: home.join(".claude").join("projects"),
        codex_sessions: home.join(".codex").join("sessions"),
        pi_sessions: home.join(".pi").join("agent").join("sessions"),
    }
}

/// `registry.yaml`'s `projects.<name>.path`, `~` expanded, as `(name, path)`
/// pairs. Empty on ANY error (missing/unreadable/unparseable registry, no
/// `projects` block) — this is a best-effort join key source, not a required
/// read.
pub fn registry_projects(data_home: &Path) -> Vec<(String, PathBuf)> {
    let registry_path = data_home.join("registry.yaml");
    let Ok(content) = fs::read_to_string(&registry_path) else {
        return Vec::new();
    };
    let Ok(doc) = serde_yaml::from_str::<Value>(&content) else {
        return Vec::new();
    };
    let Some(projects) = doc.get("projects").and_then(Value::as_object) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (name, entry) in projects {
        if let Some(path) = entry.get("path").and_then(Value::as_str) {
            out.push((name.clone(), expand_tilde(path)));
        }
    }
    out
}

/// Fields mined from one session transcript. Every field is optional — a
/// harness only ever populates the subset its log format carries (see the
/// per-harness `extract_*` functions).
#[derive(Debug, Clone, Default)]
struct ExtractedFields {
    custom_title: Option<String>,
    ai_title: Option<String>,
    tool_calls: Option<u64>,
    /// Per-tool-name call counts mined alongside `tool_calls` (see
    /// [`extract_name_near`]). A call whose name couldn't be read still
    /// counts toward `tool_calls` but has no entry here.
    tool_names: HashMap<String, u64>,
    cwd: Option<String>,
    codex: Option<usage_codex_metadata::CodexMetadata>,
}

/// Mutates `parsed.session[]` in place, adding to (never replacing wholesale)
/// each row's `metadata`. `claude_paths` is the raw claude sessionId → encoded
/// project-dir-name map `fetch_claude_project_paths` already builds in
/// `usage.rs` — reused here so a claude session's transcript can be found
/// directly instead of always falling back to the stem index.
///
/// This function cannot fail: every internal lookup that can fail (open a
/// file, parse a line, resolve a project) degrades to "skip this row/field"
/// rather than propagating an error. Callers should still treat this as
/// enrichment-only and never let its cost or absence affect the scan result.
pub fn enrich_sessions(
    parsed: &mut Value,
    roots: &EnrichRoots,
    projects: &[(String, PathBuf)],
    claude_paths: &HashMap<String, String>,
) {
    let Some(sessions) = parsed.get_mut("session").and_then(Value::as_array_mut) else {
        return;
    };

    // Built lazily (only if a row actually needs it) and reused across rows.
    let mut claude_stem_index: Option<HashMap<String, PathBuf>> = None;
    let mut pi_index: Option<HashMap<String, PathBuf>> = None;
    let mut codex_lookup: Option<usage_codex_metadata::Lookup> = None;
    let requested_codex_ids: HashSet<String> = sessions
        .iter()
        .filter_map(|row| row.get("period").and_then(Value::as_str))
        .filter_map(codex_uuid_suffix)
        .collect();

    for row in sessions.iter_mut() {
        let Some(agent) = row.get("agent").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Some(period) = row
            .get("period")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };

        let file = resolve_session_file_impl(
            &agent,
            &period,
            roots,
            claude_paths,
            &mut claude_stem_index,
            &mut pi_index,
        );
        let Some(file) = file else { continue };

        let extracted = match agent.as_str() {
            "claude" => extract_claude(&file),
            "codex" => extract_codex(&file),
            "pi" => extract_pi(&file),
            _ => None,
        };
        let Some(mut extracted) = extracted else {
            continue;
        };
        if agent == "codex" {
            if let Some(ref mut codex) = extracted.codex {
                if let Some(home) = roots.codex_sessions.parent() {
                    let lookup = codex_lookup.get_or_insert_with(|| {
                        usage_codex_metadata::Lookup::new(home, &requested_codex_ids)
                    });
                    lookup.enrich(codex);
                }
            }
        }

        apply_extracted(row, &extracted, projects);
    }
}

fn codex_uuid_suffix(period: &str) -> Option<String> {
    let start = period.len().checked_sub(36)?;
    let suffix = period.get(start..)?;
    let bytes = suffix.as_bytes();
    (bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|&i| bytes[i] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| [8, 13, 18, 23].contains(&i) || b.is_ascii_hexdigit()))
    .then(|| suffix.to_string())
}

// ── file resolution ─────────────────────────────────────────────────────────

/// Join an untrusted, scan-reported relative path onto a harness root and
/// return it only if it is a real file still inside that root.
///
/// `period` (and claude's encoded dir name) come from ccusage's stdout. They
/// are DERIVED from on-disk names but never validated by us, so a plain
/// `root.join(period)` is a traversal primitive: an absolute `period`
/// ("/etc/shadow") makes `join` DISCARD the root entirely, and `..`
/// components climb out of it. Every component must therefore be a plain name.
/// The survivor is canonicalized and must still live under the canonicalized
/// root — which additionally REFUSES a symlink pointing outside the root
/// (following one would read a file the harness never wrote, and its `cwd`
/// would then be reported as this session's project).
fn safe_session_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative);
    rel.components().next()?; // an empty relative path resolves to the root itself
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return None;
    }
    confine_to_root(root, &root.join(rel))
}

/// Canonicalize `candidate` and require it to be a real file under the
/// canonicalized `root`. Both sides are canonicalized so a symlinked root
/// (e.g. a symlinked `$HOME`) still matches, while a symlinked ENTRY that
/// escapes the root does not.
pub(crate) fn confine_to_root(root: &Path, candidate: &Path) -> Option<PathBuf> {
    if !candidate.is_file() {
        return None;
    }
    let real_root = fs::canonicalize(root).ok()?;
    let real_file = fs::canonicalize(candidate).ok()?;
    real_file.starts_with(&real_root).then_some(real_file)
}

fn resolve_claude_file(
    period: &str,
    roots: &EnrichRoots,
    claude_paths: &HashMap<String, String>,
    stem_index: &mut Option<HashMap<String, PathBuf>>,
) -> Option<PathBuf> {
    if let Some(enc) = claude_paths.get(period) {
        // One relative string, so the confinement check covers the encoded
        // dir name (also scan-reported) as well as the period.
        if let Some(direct) =
            safe_session_path(&roots.claude_projects, &format!("{enc}/{period}.jsonl"))
        {
            return Some(direct);
        }
    }
    let index = stem_index.get_or_insert_with(|| build_stem_index(&roots.claude_projects));
    let hit = index.get(period)?;
    confine_to_root(&roots.claude_projects, hit)
}

fn resolve_pi_file(
    period: &str,
    roots: &EnrichRoots,
    index: &mut Option<HashMap<String, PathBuf>>,
) -> Option<PathBuf> {
    let index = index.get_or_insert_with(|| build_pi_underscore_index(&roots.pi_sessions));
    let hit = index.get(period)?;
    confine_to_root(&roots.pi_sessions, hit)
}

/// Resolve a transcript with per-scan fallback indexes.
fn resolve_session_file_impl(
    agent: &str,
    period: &str,
    roots: &EnrichRoots,
    claude_paths: &HashMap<String, String>,
    claude_stem_index: &mut Option<HashMap<String, PathBuf>>,
    pi_index: &mut Option<HashMap<String, PathBuf>>,
) -> Option<PathBuf> {
    match agent {
        "claude" => resolve_claude_file(period, roots, claude_paths, claude_stem_index),
        // A codex period legitimately carries `/` separators
        // (`2026/02/19/rollout-…`), so confinement is per-component, not
        // "reject any slash".
        "codex" => safe_session_path(&roots.codex_sessions, &format!("{period}.jsonl")),
        "pi" => resolve_pi_file(period, roots, pi_index),
        _ => None,
    }
}

/// Keep the lexicographically smallest path for a key. `fs::read_dir` order is
/// OS- and filesystem-dependent, so "first one wins" would make two project
/// dirs holding the same session stem resolve differently between runs (and
/// between machines). Smallest-path-wins is arbitrary but STABLE.
fn insert_smallest(index: &mut HashMap<String, PathBuf>, key: String, path: PathBuf) {
    match index.entry(key) {
        Entry::Vacant(slot) => {
            slot.insert(path);
        }
        Entry::Occupied(mut slot) => {
            if path < *slot.get() {
                slot.insert(path);
            }
        }
    }
}

/// Index `<root>/*/*.jsonl` by file stem (the whole filename minus `.jsonl`).
/// Used as claude's fallback when the direct `<enc>/<period>.jsonl` path
/// (built from `fetch_claude_project_paths`'s map) doesn't exist.
fn build_stem_index(root: &Path) -> HashMap<String, PathBuf> {
    let mut index = HashMap::new();
    let Ok(entries) = fs::read_dir(root) else {
        return index;
    };
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) {
                insert_smallest(&mut index, stem.to_string(), file_path);
            }
        }
    }
    index
}

/// Index `<root>/*/<anything>_<id>.jsonl` by the part after the LAST `_` in
/// the file stem — pi's `<ts>_<id>.jsonl` naming.
fn build_pi_underscore_index(root: &Path) -> HashMap<String, PathBuf> {
    let mut index = HashMap::new();
    let Ok(entries) = fs::read_dir(root) else {
        return index;
    };
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(&dir_path) else {
            continue;
        };
        for file_entry in files.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = file_path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if let Some((_, id)) = stem.rsplit_once('_') {
                insert_smallest(&mut index, id.to_string(), file_path);
            }
        }
    }
    index
}

// ── size guard + bounded line reading ───────────────────────────────────────

fn check_file_size(path: &Path) -> Option<()> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE_BYTES {
        return None;
    }
    Some(())
}

/// Outcome of one bounded line read.
enum LineRead {
    /// A complete line, buffered in full.
    Line,
    /// A line longer than [`MAX_LINE_BYTES`]: the head is in the buffer, the
    /// tail was drained and discarded. Callers skip the line entirely.
    Overlong,
    Eof,
}

/// `BufRead::read_until` with a cap on the buffer. `read_until` itself grows
/// the buffer to the whole line, so a corrupt 200 MB file with no newline in
/// it would be pulled into memory in one allocation — under the
/// [`MAX_FILE_BYTES`] guard, which is a per-FILE not per-LINE bound.
fn read_line_capped<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<LineRead> {
    buf.clear();
    let mut saw_bytes = false;
    let mut overlong = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(chunk) => chunk,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(err),
        };
        if available.is_empty() {
            return Ok(match (saw_bytes, overlong) {
                (false, _) => LineRead::Eof,
                (true, true) => LineRead::Overlong,
                (true, false) => LineRead::Line,
            });
        }
        saw_bytes = true;
        let (take, complete) = match available.iter().position(|&b| b == b'\n') {
            Some(idx) => (idx + 1, true),
            None => (available.len(), false),
        };
        let room = MAX_LINE_BYTES.saturating_sub(buf.len());
        if room >= take {
            buf.extend_from_slice(&available[..take]);
        } else {
            buf.extend_from_slice(&available[..room]);
            overlong = true;
        }
        reader.consume(take);
        if complete {
            return Ok(if overlong {
                LineRead::Overlong
            } else {
                LineRead::Line
            });
        }
    }
}

/// Feed every non-empty, in-cap line of a transcript to `on_line`, as raw
/// BYTES (a line with invalid UTF-8 in it is handed over as-is; the per-record
/// `serde_json` parse rejects it, so it degrades to "that field is missing"
/// rather than failing the file). `None` means the file was never scanned at
/// all (too big, unreadable, or not a file); a read error part-way through
/// keeps whatever was mined so far.
pub(crate) fn scan_lines<F: FnMut(&[u8])>(path: &Path, mut on_line: F) -> Option<()> {
    check_file_size(path)?;
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        match read_line_capped(&mut reader, &mut buf) {
            Ok(LineRead::Line) => {}
            Ok(LineRead::Overlong) => continue,
            Ok(LineRead::Eof) | Err(_) => break,
        }
        let line = trim_newline(&buf);
        if line.is_empty() {
            continue;
        }
        on_line(line);
    }
    Some(())
}

fn trim_newline(buf: &[u8]) -> &[u8] {
    let mut end = buf.len();
    if end > 0 && buf[end - 1] == b'\n' {
        end -= 1;
    }
    if end > 0 && buf[end - 1] == b'\r' {
        end -= 1;
    }
    &buf[..end]
}

// ── byte-level scanning helpers (no regex dependency) ──────────────────────

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len()).find(|&i| &haystack[i..i + needle.len()] == needle)
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    find_bytes(haystack, needle).is_some()
}

/// Look for a `"name":"..."` value within [`TOOL_NAME_LOOKAHEAD_BYTES`] of
/// `anchor_end` (the byte offset just past a matched tool-call marker) and
/// return its raw value. Bounded on both sides — the key search is windowed,
/// and so is the value scan for the closing quote — so a line with no
/// `"name"` (or no closing quote) in range never turns into a scan of the
/// rest of the line.
fn extract_name_near(line: &[u8], anchor_end: usize) -> Option<String> {
    let key_window_end = line
        .len()
        .min(anchor_end.checked_add(TOOL_NAME_LOOKAHEAD_BYTES)?);
    let key_window = line.get(anchor_end..key_window_end)?;
    let needle = b"\"name\":\"";
    let rel = find_bytes(key_window, needle)?;
    let value_start = anchor_end + rel + needle.len();
    let value_window_end = line
        .len()
        .min(value_start.checked_add(TOOL_NAME_LOOKAHEAD_BYTES)?);
    let value_bytes = line.get(value_start..value_window_end)?;
    let end = value_bytes.iter().position(|&b| b == b'"')?;
    std::str::from_utf8(&value_bytes[..end])
        .ok()
        .map(str::to_string)
}

/// A tool/function name, safe to store and later render: trimmed, dropped
/// when empty or path-shaped (a tool name is never a filesystem path — one
/// that looks like it means the line matched something unexpected, and it
/// must not reach the cache), and capped to [`MAX_TOOL_NAME_CHARS`]
/// characters.
pub(crate) fn clean_tool_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.starts_with('~') {
        return None;
    }
    let capped: String = trimmed.chars().take(MAX_TOOL_NAME_CHARS).collect();
    (!capped.is_empty()).then_some(capped)
}

/// Look for a tool name near `anchor_end` and, if one survives
/// [`clean_tool_name`], bump its count in `names`. A call with no readable
/// name simply contributes nothing here — the caller's own occurrence count
/// (`tool_calls`) is unaffected either way.
fn record_tool_name_near(line: &[u8], anchor_end: usize, names: &mut HashMap<String, u64>) {
    if let Some(name) = extract_name_near(line, anchor_end) {
        if let Some(clean) = clean_tool_name(&name) {
            *names.entry(clean).or_insert(0) += 1;
        }
    }
}

/// Non-overlapping occurrence count of `needle` in `haystack` — also
/// attributes each occurrence to a tool name found near it. Used where
/// multiple tool-call markers can appear per line (claude, pi).
fn count_occurrences_with_names(
    haystack: &[u8],
    needle: &[u8],
    names: &mut HashMap<String, u64>,
) -> u64 {
    if needle.is_empty() || haystack.len() < needle.len() {
        return 0;
    }
    let mut count = 0u64;
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            count += 1;
            record_tool_name_near(haystack, i + needle.len(), names);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    count
}

/// Build the `toolBreakdown` JSON object from a per-name count map: the top
/// [`MAX_TOOL_BREAKDOWN_ENTRIES`] names by count (ties broken by name so the
/// result is deterministic regardless of `HashMap` iteration order), or
/// `None` when nothing survived.
fn build_tool_breakdown(names: &HashMap<String, u64>) -> Option<serde_json::Map<String, Value>> {
    if names.is_empty() {
        return None;
    }
    let mut entries: Vec<(&String, &u64)> = names.iter().collect();
    entries.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    entries.truncate(MAX_TOOL_BREAKDOWN_ENTRIES);
    let mut map = serde_json::Map::new();
    for (name, count) in entries {
        map.insert(name.clone(), Value::Number((*count).into()));
    }
    Some(map)
}

// ── per-harness extraction ──────────────────────────────────────────────────

fn extract_claude(path: &Path) -> Option<ExtractedFields> {
    let mut fields = ExtractedFields::default();
    let mut cwd_attempted = false;

    scan_lines(path, |line| {
        // Record kinds are keyed off the line's LEADING bytes, so a user
        // message whose text happens to quote `{"type":"custom-title"` can't
        // be mistaken for the record (a message line starts with
        // `{"parentUuid"`).
        if line.starts_with(b"{\"type\":\"custom-title\"") {
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    fields.custom_title = Some(t.to_string());
                }
            }
        } else if line.starts_with(b"{\"type\":\"ai-title\"") {
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                    fields.ai_title = Some(t.to_string());
                }
            }
        } else if line.starts_with(b"{\"parentUuid\"") {
            if !cwd_attempted {
                cwd_attempted = true;
                if let Ok(v) = serde_json::from_slice::<Value>(line) {
                    if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                        fields.cwd = Some(c.to_string());
                    }
                }
            }
        }
    })?;

    Some(fields)
}

fn extract_codex(path: &Path) -> Option<ExtractedFields> {
    let mut fields = ExtractedFields::default();
    let mut cwd_attempted = false;

    scan_lines(path, |line| {
        if !cwd_attempted
            && line.starts_with(b"{\"timestamp\"")
            && contains_bytes(line, b"\"type\":\"session_meta\"")
        {
            cwd_attempted = true;
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if let Some(c) = v.pointer("/payload/cwd").and_then(Value::as_str) {
                    fields.cwd = Some(c.to_string());
                }
            }
        }
    })?;

    fields.codex = Some(usage_codex_metadata::read_transcript(path));

    Some(fields)
}

fn extract_pi(path: &Path) -> Option<ExtractedFields> {
    let mut fields = ExtractedFields::default();
    let mut cwd_attempted = false;
    let mut tool_calls: u64 = 0;
    let mut tool_names: HashMap<String, u64> = HashMap::new();

    scan_lines(path, |line| {
        if !cwd_attempted && line.starts_with(b"{\"type\":\"session\"") {
            cwd_attempted = true;
            if let Ok(v) = serde_json::from_slice::<Value>(line) {
                if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                    fields.cwd = Some(c.to_string());
                }
            }
        }

        if contains_bytes(line, b"\"role\":\"assistant\"") {
            tool_calls +=
                count_occurrences_with_names(line, b"\"type\":\"toolCall\"", &mut tool_names);
        }
    })?;

    fields.tool_calls = Some(tool_calls);
    fields.tool_names = tool_names;
    Some(fields)
}

// ── applying extracted fields ───────────────────────────────────────────────

fn apply_extracted(row: &mut Value, extracted: &ExtractedFields, projects: &[(String, PathBuf)]) {
    let Some(obj) = row.as_object_mut() else {
        return;
    };
    let metadata = obj
        .entry("metadata")
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    // A row can arrive with `"metadata": null`; `entry()` keeps that null, so
    // give it an object to write into. Any OTHER non-object metadata (a string,
    // a number, an array) is somebody else's data shape — leave it alone and
    // skip this row rather than clobber it.
    if metadata.is_null() {
        *metadata = Value::Object(serde_json::Map::new());
    }
    let Some(meta) = metadata.as_object_mut() else {
        return;
    };

    let title = extracted
        .custom_title
        .as_ref()
        .map(|t| (t.as_str(), "custom"))
        .or_else(|| extracted.ai_title.as_ref().map(|t| (t.as_str(), "ai")));
    let title = title.or_else(|| {
        extracted
            .codex
            .as_ref()
            .and_then(|c| c.explicit_name.as_deref().map(|t| (t, "native")))
    });
    if let Some((title, source)) = title {
        // A title that is still path-shaped after scrubbing is dropped whole:
        // it would be hashed into a `~/redacted/<hash>` placeholder by the
        // cache redactor, and a session titled with a hash is worse than one
        // falling back to "<Harness> session".
        let safe = if source == "native" {
            scrub_native_title(title)
        } else {
            scrub_title(title)
        };
        if let Some(safe) = safe {
            meta.insert("title".to_string(), Value::String(safe));
            meta.insert("titleSource".to_string(), Value::String(source.to_string()));
        }
    }

    if let Some(codex) = &extracted.codex {
        for (key, value) in [
            ("sessionId", codex.own_id.as_ref()),
            ("parentSessionId", codex.parent_id.as_ref()),
            ("agentRole", codex.role.as_ref()),
            ("agentNickname", codex.nickname.as_ref()),
            ("agentPath", codex.path.as_ref()),
        ] {
            if let Some(value) = value {
                if let Some(safe) = safe_label(value, MAX_TITLE_CHARS) {
                    meta.insert(key.to_string(), Value::String(safe));
                }
            }
        }
    }

    if let Some(tc) = extracted.tool_calls {
        meta.insert("toolCalls".to_string(), Value::Number(tc.into()));
    }
    // Written only when the row doesn't already carry one (same rule as
    // `projectPath` below) — never overwrite a pre-existing value with a
    // best-effort re-scan.
    if !meta.contains_key("toolBreakdown") {
        if let Some(breakdown) = build_tool_breakdown(&extracted.tool_names) {
            meta.insert("toolBreakdown".to_string(), Value::Object(breakdown));
        }
    }
    if let Some(cwd) = &extracted.cwd {
        if let Some(hub_project) = match_hub_project(cwd, projects) {
            meta.insert("hubProject".to_string(), Value::String(hub_project));
        }
        if !meta.contains_key("projectPath") {
            meta.insert("projectPath".to_string(), Value::String(cwd.clone()));
        }
    }
}

/// Longest path-component-prefix match of `cwd` against registered project
/// paths; falls back to a `/worktrees/<seg>/` heuristic matched against a
/// project's NAME or its path's last component. Returns the registry KEY
/// only — `cwd` itself is never written under `hubProject`.
///
/// Comparison is component-wise and CASE-SENSITIVE. macOS is usually
/// case-insensitive, so a `cwd` reported with different casing than the
/// registry path simply does not match and the session falls back to a letter
/// label — an accepted approximation, since case-folding correctly is
/// filesystem-dependent and a wrong fold would name the wrong project.
///
/// Every tie is broken deterministically (see below): the same registry and
/// the same `cwd` must always produce the same name, whatever order the
/// registry mapping happens to iterate in.
fn match_hub_project(cwd: &str, projects: &[(String, PathBuf)]) -> Option<String> {
    let cwd_components: Vec<_> = Path::new(cwd).components().collect();

    let mut best: Option<(usize, &str)> = None;
    for (name, path) in projects {
        let proj_components: Vec<_> = path.components().collect();
        if proj_components.is_empty() || proj_components.len() > cwd_components.len() {
            continue;
        }
        if cwd_components[..proj_components.len()] == proj_components[..] {
            let len = proj_components.len();
            // Deepest path wins; two projects registered at the SAME path are
            // broken by name so the winner never depends on iteration order.
            let better = match best {
                None => true,
                Some((best_len, best_name)) => {
                    len > best_len || (len == best_len && name.as_str() < best_name)
                }
            };
            if better {
                best = Some((len, name.as_str()));
            }
        }
    }
    if let Some((_, name)) = best {
        return Some(name.to_string());
    }

    // Worktree fallback: a NAME match is stronger evidence than a path-leaf
    // match, and within each kind the smallest name wins — so a segment that
    // answers to two projects always resolves to the same one.
    let seg = extract_worktree_segment(cwd)?;
    if let Some(name) = projects
        .iter()
        .filter(|(name, _)| *name == seg)
        .map(|(name, _)| name)
        .min()
    {
        return Some(name.clone());
    }
    projects
        .iter()
        .filter(|(_, path)| path.file_name().and_then(|s| s.to_str()) == Some(seg.as_str()))
        .map(|(name, _)| name)
        .min()
        .cloned()
}

/// The `<seg>` in a `/worktrees/<seg>/` path component. Requires a slash
/// AFTER the segment too (not just a trailing `/worktrees/<seg>` with nothing
/// following) so a bare match at the end of the string doesn't count.
fn extract_worktree_segment(cwd: &str) -> Option<String> {
    const MARKER: &str = "/worktrees/";
    let idx = cwd.find(MARKER)?;
    let rest = &cwd[idx + MARKER.len()..];
    let slash_idx = rest.find('/')?;
    let seg = &rest[..slash_idx];
    (!seg.is_empty()).then(|| seg.to_string())
}

// ── title scrubbing (hand-rolled — no `regex` dependency in this crate) ────

/// Mirrors the frontend's `PATH_RUN_PATTERN`:
/// `(?:~/|/(?:Users|home|workspace|projects)/)[^\s"'\\]*` and
/// `[A-Za-z]:\\[^\s"']+`. Replaces every match with `<redacted-path>`, then
/// caps the result at `MAX_TITLE_CHARS` characters.
fn scrub_title(input: &str) -> Option<String> {
    safe_label(input, MAX_TITLE_CHARS)
}

fn scrub_native_title(input: &str) -> Option<String> {
    let cleaned = input
        .lines()
        .filter(|line| {
            let lower = line.trim().to_ascii_lowercase();
            !(lower.starts_with("attachment:")
                || lower.starts_with("user attached")
                || lower.starts_with("[attachment")
                || lower.starts_with("[attached image"))
        })
        .collect::<Vec<_>>()
        .join(" ");
    safe_label(&cleaned, MAX_TITLE_CHARS)
}

/// Scrub, cap, and VET one free-text value for use as a label.
///
/// Returns `None` when nothing usable survives, or when the survivor is still
/// classified as a local path by `usage::looks_like_local_path` — the same
/// predicate `redact_scan_for_cache` uses. That vetting is the point: a value
/// this module writes must come back OUT of the disk cache unchanged, because
/// the frontend renders `title` and `gitBranch` verbatim. A title like
/// `Fix regex \d+ parsing` (a backslash, no path) or `/tmp cleanup` (a leading
/// slash) is not a path, but the redactor cannot tell, so it would be replaced
/// with a `~/redacted/<hash>` placeholder and shown as one. Dropping it makes
/// the row fall back to its harness-and-id label instead.
pub(crate) fn safe_label(raw: &str, max_chars: usize) -> Option<String> {
    let bounded: String = raw.chars().take(MAX_SCRUB_INPUT_CHARS).collect();
    let scrubbed = redact_path_runs(&bounded);
    let capped: String = scrubbed.chars().take(max_chars).collect();
    let trimmed = capped.trim();
    if trimmed.is_empty() || super::usage::looks_like_local_path(trimmed) {
        return None;
    }
    Some(trimmed.to_string())
}

const HOME_PREFIXES: [&str; 5] = ["~/", "/Users/", "/home/", "/workspace/", "/projects/"];

#[derive(Clone, Copy)]
enum PrefixKind {
    Home,
    Drive,
}

fn find_drive_prefix(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    if bytes.len() < 3 {
        return None;
    }
    (0..=bytes.len() - 3)
        .find(|&i| bytes[i].is_ascii_alphabetic() && bytes[i + 1] == b':' && bytes[i + 2] == b'\\')
}

fn find_next_prefix(rest: &str) -> Option<(usize, usize, PrefixKind)> {
    let mut best: Option<(usize, usize, PrefixKind)> = None;
    for p in HOME_PREFIXES {
        if let Some(pos) = rest.find(p) {
            if best.is_none_or(|(bpos, ..)| pos < bpos) {
                best = Some((pos, p.len(), PrefixKind::Home));
            }
        }
    }
    if let Some(pos) = find_drive_prefix(rest) {
        if best.is_none_or(|(bpos, ..)| pos < bpos) {
            best = Some((pos, 3, PrefixKind::Drive));
        }
    }
    best
}

fn redact_path_runs(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    loop {
        let Some((start, plen, kind)) = find_next_prefix(rest) else {
            out.push_str(rest);
            break;
        };
        let after_prefix = &rest[start + plen..];
        let is_stop = |c: char| {
            c.is_whitespace()
                || c == '"'
                || c == '\''
                || matches!(kind, PrefixKind::Home if c == '\\')
        };
        let run_end = after_prefix.find(is_stop).unwrap_or(after_prefix.len());

        if matches!(kind, PrefixKind::Drive) && run_end == 0 {
            // The drive pattern requires 1+ trailing chars (`[^\s"']+`); a
            // zero-length run isn't a real match. Emit the literal prefix and
            // keep scanning right after it instead of looping forever.
            out.push_str(&rest[..start + plen]);
            rest = after_prefix;
            continue;
        }

        out.push_str(&rest[..start]);
        out.push_str("<redacted-path>");
        rest = &after_prefix[run_end..];
    }
    out
}

#[cfg(test)]
mod tests;
