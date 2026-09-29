//! Skill files — list, read, create and write the files that live *inside* one
//! skill's directory (`references/*.md`, `scripts/*.py`, assets, …), so the
//! skill editor can be a small file navigator instead of a SKILL.md-only view.
//!
//! Disk is the source of truth and path confinement is enforced server-side:
//! the frontend only ever names a skill by its registry key and a POSIX rel
//! path. It never names an absolute path, and no rel path may reach outside the
//! skill's own directory.
//!
//! The confinement machinery is **reused** from [`super::agent_docs`] rather
//! than re-implemented — `normalize_rel`, `canonicalize_project_root`,
//! `resolve_in_project`, `hash_bytes` and `MAX_EDITOR_BYTES` are the same
//! primitives the agent-docs browser is built on (they were widened to
//! `pub(crate)` for this module). Only the error *shape* differs: agent-docs
//! serializes a tagged `AgentDocError`, while every command in this file
//! follows `registry.rs`'s plain `Result<T, String>` style with a small set of
//! **stable error prefixes** the frontend can branch on:
//!
//! | prefix | meaning |
//! |---|---|
//! | `outside:` | rel is not a plain relative path, or resolves out of the skill dir |
//! | `not_found:` | the rel names nothing, or names something that is not a regular file |
//! | `binary:` | the file is not valid UTF-8, so it has no editor representation |
//! | `too_large:` | the file exceeds `MAX_EDITOR_BYTES` |
//! | `exists:` | create was asked for a path that already exists |
//! | `read_only:` | the skill is source-managed (`managed: external`/`starter`) |
//! | `conflict:` | the on-disk bytes changed since the caller last read them |
//!
//! ### Membership
//! The listing mirrors `collect_skill_pack_files` (`hub.py`) so the navigator
//! and a `.skillpack`/cloud ZIP agree about what a skill contains: same junk
//! set, same "a symlink must resolve inside the skill dir" rule, same
//! sorted-POSIX-rel output. It adds bounds Python deliberately does not have
//! (`MAX_DEPTH`, `MAX_FILES`, pruned VCS/build dirs) because a registry
//! `source` may point at a whole git worktree, not just a hub-owned skill dir.
//!
//! One intentional asymmetry with Python: a symlink whose target escapes the
//! skill dir is **listed here** as a non-editable `symlink_outside` row, while
//! the pack walk skips it silently. The author needs to see that a link in
//! their skill is broken for distribution; the pack must not ship it. Reads and
//! writes of such a row still fail with `outside:`.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use super::agent_docs::{
    canonicalize_project_root, hash_bytes, normalize_rel, resolve_in_project, MAX_EDITOR_BYTES,
};
use super::{data_home, expand_tilde};

// ─── Bounds ─────────────────────────────────────────────────────────────────

/// Maximum number of path components in a listed rel (`a/b/c.md` = 3). A
/// directory at this depth is not descended into.
const MAX_DEPTH: usize = 8;

/// Hard cap on listed entries. Reaching it sets `truncated` rather than
/// erroring — a git worktree registered as a skill `source` can hold thousands
/// of files and the navigator must still open.
const MAX_FILES: usize = 500;

/// Path components that are never listed and never descended into — the
/// `collect_skill_pack_files` junk set (`.DS_Store`, `__pycache__`, `.hub-bak*`)
/// plus the VCS/dependency dirs a source-checkout `source` drags in.
fn is_ignored_component(name: &str) -> bool {
    matches!(
        name,
        ".git" | ".hg" | ".svn" | "__pycache__" | "node_modules" | ".DS_Store"
    ) || name.starts_with(".hub-bak")
}

/// Compiled-Python noise: present in the pack walk's sibling filter
/// (`cloud_targets._extra_ignored`) and pruned here for the same reason.
fn is_ignored_file_ext(ext: &str) -> bool {
    matches!(ext, "pyc" | "pyo")
}

// ─── Kinds ──────────────────────────────────────────────────────────────────

const MARKDOWN_EXTS: &[&str] = &["md", "mdx", "markdown"];
const SCRIPT_EXTS: &[&str] = &["py", "sh", "bash", "zsh", "js", "ts", "mjs", "rb"];
const TEXT_EXTS: &[&str] = &["txt", "rst", "csv", "log"];
const DATA_EXTS: &[&str] = &["json", "yaml", "yml", "toml", "xml"];

/// Extensions taken as binary without opening the file. The NUL sniff below
/// catches everything else; this list only avoids a pointless read for formats
/// that are binary by definition.
const BINARY_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tiff", "pdf", "zip", "gz", "tgz",
    "bz2", "xz", "tar", "7z", "rar", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "m4a",
    "wav", "mov", "webm", "so", "dylib", "dll", "exe", "class", "jar", "pack", "idx", "wasm",
];

/// Bytes sniffed for a NUL when the extension is not decisive.
const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Markdown,
    Script,
    Text,
    Data,
    Binary,
    Other,
}

// ─── DTOs ───────────────────────────────────────────────────────────────────
//
// Wire casing follows the rest of the bridge (`AgentDocContent`, `SkillDocument`):
// serde default = the Rust field name, i.e. snake_case. No `rename_all`.

#[derive(Debug, Clone, Serialize)]
pub struct SkillFileEntry {
    /// POSIX path relative to the skill root. Never absolute, never `..`-bearing.
    pub rel: String,
    pub size: u64,
    pub kind: FileKind,
    /// True when the editor can round-trip this file as text.
    pub editable: bool,
    /// Why not, when `editable` is false: `"binary"` | `"too_large"` |
    /// `"symlink_outside"`. `None` when editable.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillFileList {
    /// Canonical absolute path of the skill directory.
    pub root: String,
    pub files: Vec<SkillFileEntry>,
    /// True when `MAX_FILES` cut the walk short.
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillFileContent {
    pub rel: String,
    pub content: String,
    /// Optimistic-concurrency fingerprint — send it back as `expectedHash`.
    pub hash: String,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillFileWriteResult {
    pub hash: String,
}

// ─── Errors ─────────────────────────────────────────────────────────────────

fn err_outside(rel: &str) -> String {
    format!("outside: {rel} is not inside the skill directory")
}

fn err_not_found(rel: &str) -> String {
    format!("not_found: {rel}")
}

// ─── Registry resolution ────────────────────────────────────────────────────

fn load_registry() -> Result<Value, String> {
    let registry_path = data_home()?.join("registry.yaml");
    let content = std::fs::read_to_string(&registry_path)
        .map_err(|e| format!("Cannot read registry.yaml: {e}"))?;
    serde_yaml::from_str(&content).map_err(|e| format!("Cannot parse registry.yaml: {e}"))
}

/// The skill's directory: `expand_tilde(registry.skills[name].source)` — the
/// same source `skill_md_path_for` (registry.rs) derives the SKILL.md path
/// from, so the navigator lists exactly the dir the editor already writes into.
///
/// Rust deliberately knows nothing about `state/skill_variants/` (the sync-time
/// invocation/rename variants): those are generated mirrors, and editing one
/// would be edited-then-overwritten on the next sync.
///
/// Takes the parsed registry rather than reading it, so tests can exercise the
/// resolution without touching the process-wide `data_home()` `OnceLock`.
fn skill_root_from_registry(registry: &Value, name: &str) -> Result<PathBuf, String> {
    let entry = &registry["skills"][name];
    let source = entry["source"]
        .as_str()
        .ok_or_else(|| format!("Skill '{name}' not found in registry"))?;

    // (F2, plans/E1.md) The former blanket `type == "mcp-server"` refusal
    // lived here. An MCP server registered via `hub mcp add` DOES own a real
    // folder (`<mcp-servers>/<name>/SKILL.md`, plus `server.py` etc. for a
    // scaffolded stdio server) — only the control-plane entry (`source: null`)
    // has nothing to resolve, and that now falls through to the same
    // "not found"-shaped error every other sourceless entry gets. The one
    // caller that must never surface that as a hard failure — the LIST
    // command — special-cases `is_mcp` itself (`list_files_for`) rather than
    // this shared resolver refusing every mcp-server outright, which is what
    // made the FILES navigator dead-on-arrival for a real scaffolded server.

    let expanded = expand_tilde(source);
    let expanded_str = expanded
        .to_str()
        .ok_or_else(|| format!("Skill '{name}' has a non-UTF-8 source path"))?;
    // Rejects a relative `source` before it can resolve against the CWD, and
    // canonicalizes so every later `starts_with` comparison is like-for-like.
    let root = canonicalize_project_root(expanded_str).map_err(|_| {
        format!(
            "Skill '{name}' has no readable directory at {}",
            expanded.display()
        )
    })?;
    if !root.is_dir() {
        return Err(format!(
            "Skill '{name}' source is not a directory: {}",
            root.display()
        ));
    }
    Ok(root)
}

/// Server-side mirror of the frontend's `isExternalManaged`: a source-managed
/// or starter skill is upstream-owned, so hub never writes into its checkout.
fn is_read_only(registry: &Value, name: &str) -> bool {
    matches!(
        registry["skills"][name]["managed"].as_str(),
        Some("external") | Some("starter")
    )
}

// ─── Path confinement ───────────────────────────────────────────────────────

/// `agent_docs::normalize_rel` plus one stricter rule: a backslash is rejected
/// outright instead of being folded to `/`. Every rel the frontend sends comes
/// from a listing this module produced, and those are always POSIX — so a
/// backslash can only be a hand-built path, and guessing at its intent is not
/// something a confinement check should do.
fn normalize_skill_rel(rel: &str) -> Result<String, String> {
    if rel.contains('\\') {
        return Err(err_outside(rel));
    }
    // A NUL survives `normalize_rel` (it is a plain `Normal` component) and is
    // refused only deep inside `fs::*`, by the OS rejecting the `CString`
    // conversion — which surfaces as an UNPREFIXED error string and breaks the
    // stable error grammar the frontend branches on. Refuse it here instead:
    // no path that denotes a real file inside the root can carry one.
    if rel.contains('\0') {
        return Err(err_outside(rel));
    }
    // Every rejection here (empty, absolute, `.`/`..` component) describes a
    // path that can never denote a file inside the root, so they collapse to
    // the one prefix the frontend branches on.
    normalize_rel(rel).map_err(|_| err_outside(rel))
}

/// Reject a rel whose ancestry leaves the root through a symlink.
///
/// `resolve_in_project` canonicalizes the *immediate* parent when it exists,
/// which covers read/write of an existing file. It is not enough for
/// `skill_file_create`, where the parent may not exist yet: with
/// `root/link -> /tmp/elsewhere`, the rel `link/new/f.md` has a non-existent
/// parent, so the fallback normalizer accepts it and `create_dir_all` would
/// happily build `/tmp/elsewhere/new`. Walking every ancestor that *does* exist
/// closes that.
fn ancestors_confined(root: &Path, rel: &str) -> Result<(), String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut acc = root.to_path_buf();
    for comp in &parts[..parts.len().saturating_sub(1)] {
        acc.push(comp);
        if let Ok(meta) = fs::symlink_metadata(&acc) {
            if meta.file_type().is_symlink() {
                let canon = acc.canonicalize().map_err(|_| err_outside(rel))?;
                if !canon.starts_with(root) {
                    return Err(err_outside(rel));
                }
            }
        }
    }
    Ok(())
}

/// Full guard chain shared by read/write/create: normalize → ancestor check →
/// resolve inside the canonical root. Returns the normalized rel and the
/// absolute target path (which need not exist).
fn confine(root: &Path, rel: &str) -> Result<(String, PathBuf), String> {
    let norm = normalize_skill_rel(rel)?;
    ancestors_confined(root, &norm)?;
    let abs = resolve_in_project(root, &norm).map_err(|_| err_outside(&norm))?;
    if !abs.starts_with(root) {
        return Err(err_outside(&norm));
    }
    Ok((norm, abs))
}

/// A symlinked *file* inside a real directory survives `confine` (only its
/// parent is canonicalized), so the final hop is checked separately — the same
/// order `read_agent_doc` uses.
fn reject_escaping_symlink(root: &Path, rel: &str, abs: &Path) -> Result<(), String> {
    match fs::symlink_metadata(abs) {
        Ok(meta) if meta.file_type().is_symlink() => {
            let canon = abs.canonicalize().map_err(|_| err_outside(rel))?;
            if !canon.starts_with(root) {
                return Err(err_outside(rel));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

// ─── Classification ─────────────────────────────────────────────────────────

/// Lowercased extension of a rel's basename. A leading-dot basename
/// (`.gitignore`) has no extension.
fn ext_lower(rel: &str) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i + 1..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

fn binary_by_ext(rel: &str) -> bool {
    BINARY_EXTS.contains(&ext_lower(rel).as_str())
}

/// A NUL in the first `SNIFF_BYTES` — the classic "this is not text" test. Note
/// that NUL *is* valid UTF-8, so `String::from_utf8` alone would happily hand
/// the editor a control-character soup; the listing and the read path share
/// this predicate so a row marked `kind: "binary"` can never read back as text.
fn nul_in_prefix(bytes: &[u8]) -> bool {
    bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0)
}

/// `nul_in_prefix` over the head of a file. An unreadable file sniffs as text;
/// the read path will surface the real IO error instead.
fn sniffs_binary(abs: &Path) -> bool {
    let Ok(mut f) = fs::File::open(abs) else {
        return false;
    };
    let mut buf = vec![0u8; SNIFF_BYTES];
    match f.read(&mut buf) {
        Ok(n) => nul_in_prefix(&buf[..n]),
        Err(_) => false,
    }
}

fn classify(abs: &Path, rel: &str) -> FileKind {
    let ext = ext_lower(rel);
    if binary_by_ext(rel) {
        return FileKind::Binary;
    }
    if sniffs_binary(abs) {
        return FileKind::Binary;
    }
    if MARKDOWN_EXTS.contains(&ext.as_str()) {
        FileKind::Markdown
    } else if SCRIPT_EXTS.contains(&ext.as_str()) {
        FileKind::Script
    } else if TEXT_EXTS.contains(&ext.as_str()) {
        FileKind::Text
    } else if DATA_EXTS.contains(&ext.as_str()) {
        FileKind::Data
    } else {
        FileKind::Other
    }
}

fn entry_for(abs: &Path, rel: String, size: u64) -> SkillFileEntry {
    let kind = classify(abs, &rel);
    let (editable, reason) = if kind == FileKind::Binary {
        (false, Some("binary".to_string()))
    } else if size > MAX_EDITOR_BYTES {
        (false, Some("too_large".to_string()))
    } else {
        (true, None)
    };
    SkillFileEntry {
        rel,
        size,
        kind,
        editable,
        reason,
    }
}

fn escaping_symlink_entry(rel: String) -> SkillFileEntry {
    SkillFileEntry {
        rel,
        size: 0,
        kind: FileKind::Other,
        editable: false,
        reason: Some("symlink_outside".to_string()),
    }
}

// ─── Walk ───────────────────────────────────────────────────────────────────

struct Walk {
    entries: Vec<SkillFileEntry>,
    truncated: bool,
}

impl Walk {
    fn push(&mut self, entry: SkillFileEntry) {
        if self.entries.len() >= MAX_FILES {
            self.truncated = true;
            return;
        }
        self.entries.push(entry);
    }
}

/// Depth-first, entries sorted per directory (so *which* files survive
/// truncation is deterministic, not filesystem-order-dependent).
fn walk_dir(root: &Path, dir: &Path, prefix: &str, depth: usize, walk: &mut Walk) {
    if walk.truncated {
        return;
    }
    let Ok(read) = fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<std::ffi::OsString> = read.filter_map(|e| e.ok()).map(|e| e.file_name()).collect();
    names.sort();

    for name in names {
        if walk.truncated {
            return;
        }
        let name_str = name.to_string_lossy().into_owned();
        if is_ignored_component(&name_str) {
            continue;
        }
        let abs = dir.join(&name);
        let rel = if prefix.is_empty() {
            name_str.clone()
        } else {
            format!("{prefix}/{name_str}")
        };

        let Ok(link_meta) = fs::symlink_metadata(&abs) else {
            continue;
        };
        if link_meta.file_type().is_symlink() {
            // A link that cannot be resolved cannot be proven to stay inside
            // the skill, so a broken link and an escaping link get the same
            // honest row.
            let inside = abs
                .canonicalize()
                .map(|c| c.starts_with(root))
                .unwrap_or(false);
            if !inside {
                walk.push(escaping_symlink_entry(rel));
                continue;
            }
        }

        let Ok(meta) = fs::metadata(&abs) else {
            continue;
        };
        if meta.is_dir() {
            if depth < MAX_DEPTH {
                walk_dir(root, &abs, &rel, depth + 1, walk);
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        if is_ignored_file_ext(&ext_lower(&rel)) {
            continue;
        }
        walk.push(entry_for(&abs, rel, meta.len()));
    }
}

/// List every file that belongs to the skill rooted at `root` (already
/// canonical). Sorted by POSIX rel with `SKILL.md` hoisted first.
fn list_files_in_root(root: &Path) -> SkillFileList {
    let mut walk = Walk {
        entries: Vec::new(),
        truncated: false,
    };
    walk_dir(root, root, "", 1, &mut walk);
    walk
        .entries
        .sort_by(|a, b| (a.rel != "SKILL.md", &a.rel).cmp(&(b.rel != "SKILL.md", &b.rel)));
    SkillFileList {
        root: root.to_string_lossy().into_owned(),
        files: walk.entries,
        truncated: walk.truncated,
    }
}

// ─── Read / write / create ──────────────────────────────────────────────────

/// Serializes the read-then-compare-then-replace of a write so two concurrent
/// saves cannot both pass the `expected_hash` check. Reads are not gated: they
/// take no lock, so opening files in the navigator never queues behind a save.
static SKILL_FILES_LOCK: Mutex<()> = Mutex::new(());

fn read_file_in_root(root: &Path, rel: &str) -> Result<SkillFileContent, String> {
    let (norm, abs) = confine(root, rel)?;
    reject_escaping_symlink(root, &norm, &abs)?;

    let meta = fs::metadata(&abs).map_err(|_| err_not_found(&norm))?;
    if !meta.is_file() {
        return Err(err_not_found(&norm));
    }
    if meta.len() > MAX_EDITOR_BYTES {
        return Err(format!(
            "too_large: {norm} is {} bytes (limit {MAX_EDITOR_BYTES})",
            meta.len()
        ));
    }
    let bytes = fs::read(&abs).map_err(|e| format!("Cannot read {norm}: {e}"))?;
    // Same predicate the listing classified this row with, so `editable: false`
    // and a `binary:` refusal can never disagree.
    if binary_by_ext(&norm) || nul_in_prefix(&bytes) {
        return Err(format!("binary: {norm} has no text representation"));
    }
    let hash = hash_bytes(&bytes);
    let size = bytes.len() as u64;
    let content =
        String::from_utf8(bytes).map_err(|_| format!("binary: {norm} is not valid UTF-8"))?;
    Ok(SkillFileContent {
        rel: norm,
        hash,
        size,
        content,
    })
}

/// Atomic replace: stage a dot-prefixed sibling, then rename over the target.
/// Content is written byte-for-byte as given — no trailing-newline
/// normalization, no reformatting.
fn atomic_write(abs: &Path, content: &str) -> Result<(), String> {
    let parent = abs
        .parent()
        .ok_or_else(|| format!("Cannot write {}: no parent directory", abs.display()))?;
    let file_name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp_path = parent.join(format!(".{file_name}.skill-files.tmp"));
    {
        let mut f = fs::File::create(&tmp_path)
            .map_err(|e| format!("Cannot stage write at {}: {e}", tmp_path.display()))?;
        f.write_all(content.as_bytes())
            .map_err(|e| format!("Cannot write content: {e}"))?;
        f.flush().ok();
    }
    fs::rename(&tmp_path, abs).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("Cannot finalize write at {}: {e}", abs.display())
    })
}

/// v1 writes existing files only — `skill_file_create` is the one path that
/// brings a new file into being, so a typo'd rel can never silently create a
/// stray file next to the real one.
///
/// `rel == "SKILL.md"` is allowed through here as raw bytes. The skill editor
/// keeps saving SKILL.md through `save_skill_full`, which round-trips
/// frontmatter and forwards metadata to `hub set-meta`; this path is the raw
/// escape hatch a file navigator needs, and it does not touch the registry.
fn write_file_in_root(
    root: &Path,
    rel: &str,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<SkillFileWriteResult, String> {
    let (norm, abs) = confine(root, rel)?;
    reject_escaping_symlink(root, &norm, &abs)?;

    let _guard = SKILL_FILES_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // Write THROUGH an in-root symlink, never over it. `atomic_write` finishes
    // with `fs::rename`, which replaces the *link* rather than following it —
    // so saving `links/inside.md -> references/real.md` would silently turn the
    // link into a regular file and strand the bytes the author believes they
    // just edited, leaving two rows with divergent content. `agent_docs`'
    // writer refuses an escaping link and permits an in-root one; the same rule
    // holds here (`reject_escaping_symlink` above already proved this one
    // resolves inside the root), and the hash compare below must see the same
    // file the write lands on.
    let abs = match fs::symlink_metadata(&abs) {
        Ok(m) if m.file_type().is_symlink() => {
            abs.canonicalize().map_err(|_| err_outside(&norm))?
        }
        _ => abs,
    };

    let meta = fs::metadata(&abs).map_err(|_| err_not_found(&norm))?;
    if !meta.is_file() {
        return Err(err_not_found(&norm));
    }
    if let Some(expected) = expected_hash {
        let current = fs::read(&abs).map_err(|e| format!("Cannot read {norm}: {e}"))?;
        let current_hash = hash_bytes(&current);
        if expected != current_hash {
            return Err(format!(
                "conflict: {norm} changed on disk (current hash {current_hash})"
            ));
        }
    }
    atomic_write(&abs, content)?;
    Ok(SkillFileWriteResult {
        hash: hash_bytes(content.as_bytes()),
    })
}

/// The shallowest ancestor of `dir` (inclusive) that does not exist yet, or
/// `None` when `dir` is already on disk. The walk stops at `root`, so a rollback
/// can never climb out of the skill directory.
fn topmost_missing_dir(root: &Path, dir: &Path) -> Option<PathBuf> {
    let mut missing: Option<PathBuf> = None;
    let mut cur = dir;
    while cur != root && cur.starts_with(root) {
        if fs::symlink_metadata(cur).is_ok() {
            break;
        }
        missing = Some(cur.to_path_buf());
        cur = cur.parent()?;
    }
    missing
}

fn create_file_in_root(root: &Path, rel: &str) -> Result<SkillFileWriteResult, String> {
    let (norm, abs) = confine(root, rel)?;

    let _guard = SKILL_FILES_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // `symlink_metadata` so an existing (even broken) link also counts as taken.
    if fs::symlink_metadata(&abs).is_ok() {
        return Err(format!("exists: {norm}"));
    }
    // Remember the shallowest directory this call is about to bring into being,
    // so a failed write can undo it (1b): otherwise a read-only mount or ENOSPC
    // leaves an empty `references/deep/` behind with no file in it, and since
    // directories are never listed the clutter is invisible.
    let mut created_root: Option<PathBuf> = None;
    if let Some(parent) = abs.parent() {
        created_root = topmost_missing_dir(root, parent);
        // `ancestors_confined` (inside `confine`) already proved no existing
        // ancestor escapes the root, and `normalize_rel` rejected `..`, so this
        // can only create directories under `root`.
        fs::create_dir_all(parent)
            .map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    if let Err(e) = atomic_write(&abs, "") {
        if let Some(dir) = created_root {
            let _ = fs::remove_dir_all(dir);
        }
        return Err(e);
    }
    Ok(SkillFileWriteResult {
        hash: hash_bytes(b""),
    })
}

// ─── Registry-driven impls ──────────────────────────────────────────────────
//
// Each command is `load_registry()` + one of these. Splitting on the parsed
// registry (rather than on the skill root alone) keeps the `read_only:` gate
// inside a unit-testable function instead of stranding it in the async command
// where only `data_home()` could reach it.

/// (F2) An `mcp-server` lists like any other skill when its folder holds more
/// than `SKILL.md` (a scaffolded stdio server's `server.py`, say); one with no
/// resolvable folder at all (`source: null`, the control-plane entry) OR a
/// folder holding nothing but `SKILL.md` returns an EMPTY list — never an
/// `Err`. A non-mcp skill's resolution failure still propagates as a real
/// error (an editor opened on a broken `source` should say so).
fn list_files_for(registry: &Value, name: &str) -> Result<SkillFileList, String> {
    let is_mcp = registry["skills"][name]["type"].as_str() == Some("mcp-server");
    match skill_root_from_registry(registry, name) {
        Ok(root) => {
            let mut listing = list_files_in_root(&root);
            if is_mcp && listing.files.len() <= 1 {
                listing.files = Vec::new();
                listing.truncated = false;
            }
            Ok(listing)
        }
        Err(e) => {
            if is_mcp {
                Ok(SkillFileList {
                    root: String::new(),
                    files: Vec::new(),
                    truncated: false,
                })
            } else {
                Err(e)
            }
        }
    }
}

fn read_file_for(registry: &Value, name: &str, rel: &str) -> Result<SkillFileContent, String> {
    let root = skill_root_from_registry(registry, name)?;
    read_file_in_root(&root, rel)
}

fn write_file_for(
    registry: &Value,
    name: &str,
    rel: &str,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<SkillFileWriteResult, String> {
    if is_read_only(registry, name) {
        return Err(format!("read_only: {name} is managed by its source"));
    }
    let root = skill_root_from_registry(registry, name)?;
    write_file_in_root(&root, rel, content, expected_hash)
}

fn create_file_for(
    registry: &Value,
    name: &str,
    rel: &str,
) -> Result<SkillFileWriteResult, String> {
    if is_read_only(registry, name) {
        return Err(format!("read_only: {name} is managed by its source"));
    }
    let root = skill_root_from_registry(registry, name)?;
    create_file_in_root(&root, rel)
}

// ─── Commands ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn skill_files_list(name: String) -> Result<SkillFileList, String> {
    tauri::async_runtime::spawn_blocking(move || list_files_for(&load_registry()?, &name))
        .await
        .map_err(|e| format!("skill_files_list task failed: {e}"))?
}

#[tauri::command]
pub async fn skill_file_read(name: String, rel: String) -> Result<SkillFileContent, String> {
    tauri::async_runtime::spawn_blocking(move || read_file_for(&load_registry()?, &name, &rel))
        .await
        .map_err(|e| format!("skill_file_read task failed: {e}"))?
}

#[tauri::command]
pub async fn skill_file_write(
    name: String,
    rel: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<SkillFileWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        write_file_for(
            &load_registry()?,
            &name,
            &rel,
            &content,
            expected_hash.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("skill_file_write task failed: {e}"))?
}

#[tauri::command]
pub async fn skill_file_create(name: String, rel: String) -> Result<SkillFileWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || create_file_for(&load_registry()?, &name, &rel))
        .await
        .map_err(|e| format!("skill_file_create task failed: {e}"))?
}

// ─── Tests ──────────────────────────────────────────────────────────────────
//
// Every test drives the `*_in_root` / `*_from_registry` impls against a
// `TempDir`. None of them call `data_home()` / `code_home()`: those are
// process-wide `OnceLock`s that other tests in this binary already populate,
// and racing them risks reading (or writing) the developer's real
// `~/.skill-hub`. See the same note at `registry.rs`'s `mod tests`.

#[cfg(test)]
mod tests;
