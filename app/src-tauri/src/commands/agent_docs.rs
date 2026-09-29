//! Agent Docs commands — read, write, and list the project-local instruction
//! files (`CLAUDE.md`, `AGENT.md`, and nested variants) that coding agents
//! consume.
//!
//! Disk is the source of truth. Path confinement is enforced server-side; the
//! frontend never names absolute paths.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::hex_encode;

// ─── Constants ──────────────────────────────────────────────────────────────

pub const KNOWN_RELS: &[&str] = &[
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/CLAUDE.md",
    ".agents/AGENTS.md",
];

/// Basenames accepted by read/write commands. `AGENTS.md` (plural) is canonical;
/// the singular `AGENT.md` is still recognized so legacy files remain visible
/// and cleanable, but it NEVER satisfies the AGENT format — no configured
/// harness reads it.
/// `CLAUDE.local.md` loads alongside `CLAUDE.md` and satisfies no root format —
/// it is a personal, usually-gitignored overlay, not a canonical root.
pub const ALLOWED_BASENAMES: &[&str] = &[
    "CLAUDE.md",
    "CLAUDE.local.md",
    "AGENTS.md",
    "AGENT.md",
];

/// Legacy singular filename — classified and cleaned, never satisfied-by.
pub const LEGACY_BASENAME: &str = "AGENT.md";

/// Canonical import-pointer body for the `import` derivation strategy.
pub const CANONICAL_BASENAME: &str = "AGENTS.md";

/// Directory names skipped during nested discovery.
pub const IGNORED_DIR_NAMES: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    "node_modules",
    "vendor",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    ".turbo",
    ".gradle",
];

/// Two-segment relative paths skipped (under their parent).
pub const IGNORED_NESTED_PATHS: &[&str] = &[".claude/skills", ".agents/skills"];

pub const MAX_EDITOR_BYTES: u64 = 1024 * 1024; // 1 MiB

fn is_markdown_rel(rel: &str) -> bool {
    match rel.rsplit('/').next() {
        Some(name) => name.ends_with(".md"),
        None => false,
    }
}

/// True when a normalized (`/`-separated) rel lives under a directory the
/// listing intentionally skips (`IGNORED_DIR_NAMES` anywhere in its ancestry,
/// or an `IGNORED_NESTED_PATHS` prefix). Used to keep the widened all-Markdown
/// read/write surface consistent with discovery: a caller must not name an
/// ignored path directly (e.g. `node_modules/pkg/README.md` or a hub-managed
/// `.claude/skills/foo/SKILL.md`) to reach a file the scan never exposes.
fn is_ignored_rel(rel: &str) -> bool {
    let ignored_dirs: HashSet<&str> = IGNORED_DIR_NAMES.iter().copied().collect();
    // Only ancestor directory components gate the path; the file basename never
    // makes a path "ignored" on its own.
    let mut parts: Vec<&str> = rel.split('/').collect();
    parts.pop();
    if parts.iter().any(|c| ignored_dirs.contains(c)) {
        return true;
    }
    IGNORED_NESTED_PATHS
        .iter()
        .any(|p| rel == *p || rel.starts_with(&format!("{p}/")))
}

/// True when any ancestor directory of `rel` (relative to `project_root`) is a
/// symlink. Discovery never recurses into symlinked directories, so a generic
/// `.md` read/write must not either — otherwise `docs/alias/README.md` where
/// `docs/alias -> node_modules/pkg` would resolve into an ignored subtree that
/// `is_ignored_rel` (a string check) cannot see.
fn has_symlinked_ancestor(project_root: &Path, rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let mut acc = project_root.to_path_buf();
    for comp in &parts[..parts.len().saturating_sub(1)] {
        acc.push(comp);
        match fs::symlink_metadata(&acc) {
            Ok(m) if m.file_type().is_symlink() => return true,
            _ => {}
        }
    }
    false
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
pub struct AgentDocFileMeta {
    pub rel: String,
    pub name: String,
    pub label: String,
    pub absolute_path: String,
    pub exists: bool,
    pub is_known: bool,
    pub is_discovered: bool,
    pub is_symlink: bool,
    pub symlink_to: Option<String>,
    pub symlink_target_in_project: bool,
    pub can_read: bool,
    pub can_write: bool,
    pub size: Option<u64>,
    pub modified_at: Option<u64>,
    pub hash: Option<String>,
    pub error: Option<String>,
    /// Reached through the `@` import graph.
    pub is_import: bool,
    /// Agent docs that declare this import, deduped by canonical target and
    /// sorted, so attribution never depends on directory walk order.
    pub imported_by: Vec<String>,
    /// `in_project` | `external` | `beyond_depth`; `None` when not imported.
    pub import_class: Option<String>,
    /// The project's effective harnesses would not load this file. `@` imports
    /// are a Claude Code feature — neither the AGENTS.md standard, Codex, nor
    /// opencode implements one — so an unqualified "this is loaded" claim is
    /// false for a `harnesses: [codex]` project.
    pub import_unreachable: bool,
    /// The target is not Markdown (`@package.json` is in the docs). Listed,
    /// marked, and opened read-only.
    pub is_non_markdown: bool,
    /// Raw import paths declared by THIS file that do not exist.
    pub unresolved_imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocFolder {
    pub name: String,
    pub path: String,
    pub dirs: Vec<AgentDocFolder>,
    pub files: Vec<AgentDocFileMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocsListing {
    pub project_path: String,
    pub root: AgentDocFolder,
    pub instruction_sets: Vec<AgentDocInstructionSet>,
    pub required_formats: Vec<AgentDocFormatKind>,
    pub policy: AgentDocPolicyInfo,
    pub all_rels: Vec<String>,
    /// The files an agent actually loads: agent-basename instruction files, the
    /// virtual known roots, and (once resolved) import targets. Eagerly sized,
    /// so the context estimate is a fixed number rather than one that drifts
    /// upward as the user expands folders full of ordinary markdown.
    pub instruction_rels: Vec<String>,
    /// Import targets that resolve OUTSIDE the project root.
    /// `@~/.claude/my-project-instructions.md` is the documented way to share
    /// preferences across worktrees, so these are real, working configuration.
    /// They are kept off the rel namespace on purpose: rels are what read and
    /// write confinement is expressed in, and an external path has no honest
    /// one. The map reveals them in Finder rather than opening them.
    pub external_imports: Vec<AgentDocFileMeta>,
    /// `.md` files the project's own ignore rules withheld from the browse
    /// index. Reported so a withheld file is a stated absence with a way to
    /// see it, not a silent one.
    pub ignored_count: usize,
    /// Whether this listing was built with ignore rules switched off.
    pub include_ignored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentDocFormatKind {
    CLAUDE,
    AGENT,
}

impl AgentDocFormatKind {
    fn basename(&self) -> &'static str {
        match self {
            AgentDocFormatKind::CLAUDE => "CLAUDE.md",
            // Canonical is the plural AGENTS.md; the AGENT kind now denotes it.
            AgentDocFormatKind::AGENT => "AGENTS.md",
        }
    }

    fn from_basename(name: &str) -> Option<Self> {
        match name {
            "CLAUDE.md" => Some(AgentDocFormatKind::CLAUDE),
            // Only the canonical plural maps to the AGENT format. The legacy
            // singular `AGENT.md` is collected separately as a legacy artifact
            // and never satisfies the format.
            "AGENTS.md" => Some(AgentDocFormatKind::AGENT),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocInstructionSet {
    pub id: String,
    pub relative_dir: String,
    pub display_path: String,
    pub full_path_title: String,
    pub label: String,
    pub label_source: String,
    /// Canonical-status verdict per design D2 (single shared model with
    /// `agent_docs.py`; pinned by tests/fixtures/agent_docs_corpus.json).
    pub verdict: String,
    /// Composed deviation flags: `legacy` | `broken_link` | `external_link`.
    pub flags: Vec<String>,
    pub formats: HashMap<AgentDocFormatKind, AgentDocFormatRecord>,
    /// Legacy `AGENT.md` artifacts in this directory (never satisfy a format).
    pub legacy: Vec<AgentDocFileMeta>,
    /// Appendix text when `verdict == "pointer_plus_content"`.
    pub appendix: Option<String>,
    pub required_formats: Vec<AgentDocFormatKind>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocFormatRecord {
    pub format: AgentDocFormatKind,
    pub rel: String,
    pub exists: bool,
    pub file: Option<AgentDocFileMeta>,
    pub is_symlink: bool,
    pub target_kind: String,
    pub required_by_harnesses: Vec<String>,
    pub warnings: Vec<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocContent {
    pub rel: String,
    pub absolute_path: String,
    pub content: String,
    pub size: u64,
    pub modified_at: Option<u64>,
    pub hash: String,
    pub is_symlink: bool,
    pub symlink_to: Option<String>,
    pub oversized: bool,
    /// True when this file is a hub-derived `CLAUDE.md` pointing at the
    /// canonical `AGENTS.md`: either a symlink to it, or a regular file whose
    /// entire body is the import line `@AGENTS.md`. The UI uses this to render
    /// a read-only stub and redirect edits to the canonical source.
    pub is_derived_pointer: bool,
}

/// Canonical import-pointer line used by the `import` derivation strategy.
pub const IMPORT_POINTER_LINE: &str = "@AGENTS.md";

/// True iff `content` is a hub-derived `@AGENTS.md` import pointer (trim-only,
/// permissive of surrounding whitespace).
pub fn is_import_pointer_body(content: &str) -> bool {
    content.trim() == IMPORT_POINTER_LINE
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentDocWriteResult {
    pub written: Vec<AgentDocFileMeta>,
    /// True when the write canonicalized the root pair (wrote `AGENTS.md` and
    /// derived `CLAUDE.md` in one command).
    pub derived: bool,
    /// The final persisted content. Snippet-bearing docs may be normalized by
    /// hub.py before the native write completes.
    pub content: String,
    /// Present when this save requested publish-on-save. A failed publish does
    /// not turn a successful local write into an editor error.
    pub publish: Option<AgentDocPublishResult>,
}

/// Effective canonical-root policy for a project, resolved from the registry
/// (effective harnesses) and the root-derivation strategy setting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CanonicalPolicy {
    pub requires_claude: bool,
    pub requires_agent: bool,
    pub strategy: String, // "symlink" | "import"
    pub claude_harnesses: Vec<String>,
    pub agent_harnesses: Vec<String>,
}

impl CanonicalPolicy {
    pub fn canonical(&self) -> Option<&'static str> {
        match (self.requires_claude, self.requires_agent) {
            (_, true) => Some("AGENTS.md"),
            (true, false) => Some("CLAUDE.md"),
            (false, false) => None,
        }
    }
    pub fn derived(&self) -> Option<&'static str> {
        if self.requires_claude && self.requires_agent {
            Some("CLAUDE.md")
        } else {
            None
        }
    }
}

/// Policy summary shipped with the listing so the frontend renders verdicts
/// without re-deriving link state from raw file flags.
#[derive(Debug, Clone, Serialize)]
pub struct AgentDocPolicyInfo {
    pub requires_claude: bool,
    pub requires_agent: bool,
    pub strategy: String,
    pub canonical: Option<String>,
    pub derived: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AgentDocError {
    InvalidPath {
        message: String,
    },
    NotAllowedBasename {
        rel: String,
    },
    OutsideProject {
        rel: String,
    },
    Conflict {
        rel: String,
        current_hash: String,
        current_size: u64,
        modified_at: Option<u64>,
    },
    NotUtf8 {
        rel: String,
    },
    Oversized {
        rel: String,
        size: u64,
        limit: u64,
    },
    ExternalSymlink {
        rel: String,
        target: String,
    },
    /// Attempted to overwrite a hub-derived `CLAUDE.md` (symlink or `@AGENTS.md`
    /// pointer) with prose other than the pointer line itself. The frontend
    /// redirects the edit to `AGENTS.md` rather than clobbering the derived
    /// artifact.
    DerivedPointer {
        rel: String,
        canonical_rel: String,
    },
    IoError {
        rel: String,
        message: String,
    },
}

impl AgentDocError {
    fn to_string_payload(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| format!("{:?}", self))
    }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

pub(crate) fn normalize_rel(rel: &str) -> Result<String, AgentDocError> {
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Err(AgentDocError::InvalidPath {
            message: "Relative path is empty".into(),
        });
    }
    if trimmed.starts_with('/') || trimmed.starts_with('\\') {
        return Err(AgentDocError::InvalidPath {
            message: format!("Absolute paths are not allowed: {trimmed}"),
        });
    }
    if PathBuf::from(trimmed).is_absolute() {
        return Err(AgentDocError::InvalidPath {
            message: format!("Absolute paths are not allowed: {trimmed}"),
        });
    }
    let unified = trimmed.replace('\\', "/");
    for part in unified.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(AgentDocError::InvalidPath {
                message: format!("Invalid path component in {unified}"),
            });
        }
    }
    Ok(unified)
}

pub fn is_allowed_agent_doc_rel(rel: &str) -> bool {
    if KNOWN_RELS.contains(&rel) {
        return true;
    }
    let basename = match rel.rsplit('/').next() {
        Some(b) => b,
        None => return false,
    };
    ALLOWED_BASENAMES.contains(&basename)
}

pub(crate) fn canonicalize_project_root(project_path: &str) -> Result<PathBuf, AgentDocError> {
    let p = PathBuf::from(project_path);
    if !p.is_absolute() {
        return Err(AgentDocError::InvalidPath {
            message: format!("Project path must be absolute: {}", project_path),
        });
    }
    p.canonicalize().map_err(|e| AgentDocError::IoError {
        rel: String::new(),
        message: format!("Cannot canonicalize project path {}: {e}", project_path),
    })
}

/// Resolve a relative path against the project root, ensuring the result is
/// inside the canonical project. Used for both reads and writes — does NOT
/// require the file to exist (so creates work).
pub(crate) fn resolve_in_project(project_root: &Path, rel: &str) -> Result<PathBuf, AgentDocError> {
    let candidate = project_root.join(rel);

    // Canonicalize the parent dir (since the file itself might not exist).
    let parent = candidate.parent().unwrap_or(project_root);
    let canon_parent = if parent.exists() {
        parent.canonicalize().map_err(|e| AgentDocError::IoError {
            rel: rel.to_string(),
            message: format!("Cannot canonicalize parent {}: {e}", parent.display()),
        })?
    } else {
        // Manually normalize for not-yet-existing parents — strip any
        // `.`/`..` components and resolve against the project root.
        let mut acc = project_root.to_path_buf();
        for comp in parent
            .strip_prefix(project_root)
            .unwrap_or(parent)
            .components()
        {
            match comp {
                Component::Normal(p) => acc.push(p),
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(AgentDocError::InvalidPath {
                        message: format!("Path traversal in {rel}"),
                    });
                }
                _ => {
                    return Err(AgentDocError::InvalidPath {
                        message: format!("Unsupported path component in {rel}"),
                    });
                }
            }
        }
        acc
    };

    // The canonical parent must be within the canonical project root.
    if !canon_parent.starts_with(project_root) {
        return Err(AgentDocError::OutsideProject {
            rel: rel.to_string(),
        });
    }

    let file_name = candidate
        .file_name()
        .ok_or_else(|| AgentDocError::InvalidPath {
            message: format!("No file name in {rel}"),
        })?;
    Ok(canon_parent.join(file_name))
}

pub(crate) fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    // Truncated to 16 bytes — this is the frontend's optimistic-concurrency
    // fingerprint, NOT a full content hash. Do not widen it.
    hex_encode(&digest[..16])
}

fn mtime_secs(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// How much of a file's metadata to resolve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaMode {
    /// Listing rows and on-demand directory resolution: stat only — existence,
    /// link state, size, mtime. No read, no hash. Hashing every row was what
    /// made a listing cost scale with the project rather than with what is on
    /// screen, and the listing has no use for a content fingerprint.
    Stat,
    /// The write path. Adds the SHA-256 that the optimistic-concurrency check
    /// compares against: `write_agent_doc_impl` treats a `None` expected hash
    /// against an existing file as a hard conflict, so dropping the hash here
    /// would break the SECOND save of every session, not the first.
    Full,
}

/// Stat a file at `abs_path`, returning its metadata in the frontend shape.
fn build_file_meta(
    rel: &str,
    abs_path: &Path,
    project_root: &Path,
    is_known: bool,
    is_discovered: bool,
    mode: MetaMode,
) -> AgentDocFileMeta {
    let basename = abs_path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let abs_str = abs_path.to_string_lossy().into_owned();

    // Existence (symlink-aware via symlink_metadata so dangling links still
    // count as present so the row can warn).
    let symlink_meta = fs::symlink_metadata(abs_path).ok();
    let exists = symlink_meta.is_some();

    if !exists {
        return AgentDocFileMeta {
            rel: rel.to_string(),
            name: basename.clone(),
            label: rel.to_string(),
            absolute_path: abs_str,
            exists: false,
            is_known,
            is_discovered,
            is_symlink: false,
            symlink_to: None,
            symlink_target_in_project: false,
            can_read: false,
            can_write: true,
            size: None,
            modified_at: None,
            hash: None,
            error: None,
            ..Default::default()
        };
    }

    let smeta = symlink_meta.unwrap();
    let is_symlink = smeta.file_type().is_symlink();
    let (symlink_to, symlink_target_in_project) = if is_symlink {
        let target = fs::read_link(abs_path).ok();
        let resolved = abs_path.canonicalize().ok();
        let in_project = resolved
            .as_ref()
            .map(|p| p.starts_with(project_root))
            .unwrap_or(false);
        (target.map(|p| p.to_string_lossy().into_owned()), in_project)
    } else {
        (None, false)
    };

    // For symlinks, only build hash/size when the link target is inside the
    // project (otherwise we surface it as non-editable).
    if is_symlink && !symlink_target_in_project {
        return AgentDocFileMeta {
            rel: rel.to_string(),
            name: basename,
            label: rel.to_string(),
            absolute_path: abs_str,
            exists: true,
            is_known,
            is_discovered,
            is_symlink: true,
            symlink_to,
            symlink_target_in_project: false,
            can_read: false,
            can_write: false,
            size: Some(smeta.len()),
            modified_at: mtime_secs(&smeta),
            hash: None,
            error: Some("symlink target outside project".into()),
            ..Default::default()
        };
    }

    // Follow the link (or stat directly).
    let resolved_meta = fs::metadata(abs_path);
    match resolved_meta {
        Ok(meta) if meta.is_file() => {
            let (hash, size) = match mode {
                MetaMode::Full => match fs::read(abs_path) {
                    Ok(b) => (Some(hash_bytes(&b)), b.len() as u64),
                    Err(_) => (None, meta.len()),
                },
                MetaMode::Stat => (None, meta.len()),
            };
            AgentDocFileMeta {
                rel: rel.to_string(),
                name: basename,
                label: rel.to_string(),
                absolute_path: abs_str,
                exists: true,
                is_known,
                is_discovered,
                is_symlink,
                symlink_to,
                symlink_target_in_project,
                can_read: true,
                can_write: !is_symlink || symlink_target_in_project,
                size: Some(size),
                modified_at: mtime_secs(&meta),
                hash,
                error: None,
                ..Default::default()
            }
        }
        Ok(meta) => AgentDocFileMeta {
            rel: rel.to_string(),
            name: basename,
            label: rel.to_string(),
            absolute_path: abs_str,
            exists: true,
            is_known,
            is_discovered,
            is_symlink,
            symlink_to,
            symlink_target_in_project,
            can_read: false,
            can_write: false,
            size: Some(meta.len()),
            modified_at: mtime_secs(&meta),
            hash: None,
            error: Some("not a regular file".into()),
            ..Default::default()
        },
        Err(e) => AgentDocFileMeta {
            rel: rel.to_string(),
            name: basename,
            label: rel.to_string(),
            absolute_path: abs_str,
            exists: true,
            is_known,
            is_discovered,
            is_symlink,
            symlink_to,
            symlink_target_in_project,
            can_read: false,
            can_write: false,
            size: Some(smeta.len()),
            modified_at: mtime_secs(&smeta),
            hash: None,
            error: Some(format!("stat failed: {e}")),
            ..Default::default()
        },
    }
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/// True when a walked entry sits under a directory the listing intentionally
/// skips. Applied on top of ignore rules and independently of them: this static
/// list is the ONLY gate on read/write access, so discovery and access must
/// agree on it whatever the project's `.gitignore` says.
fn walk_entry_allowed(rel: &str, is_dir: bool) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if is_dir {
        if IGNORED_DIR_NAMES.contains(&name) {
            return false;
        }
        if IGNORED_NESTED_PATHS.iter().any(|p| *p == rel) {
            return false;
        }
        return true;
    }
    !is_ignored_rel(rel)
}

/// `/`-separated path of `path` under `root`, or `None` for `root` itself and
/// anything that escapes it.
fn rel_under(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut out = String::new();
    for comp in rel.components() {
        let Component::Normal(seg) = comp else {
            return None;
        };
        if !out.is_empty() {
            out.push('/');
        }
        out.push_str(&seg.to_string_lossy());
    }
    if out.is_empty() { None } else { Some(out) }
}

/// A walker over one project root.
///
/// Every option is set explicitly, because the crate's defaults are wrong here
/// in four separate ways:
///
/// - `hidden(false)` — the map deliberately descends dotdirectories. The
///   default would delete `.claude/CLAUDE.md`, `.agents/AGENTS.md`, and
///   `.github/*.md` from the listing without a word.
/// - `require_git(false)` + `parents(false)` — otherwise a project root that an
///   ANCESTOR repository gitignores (a vendored subtree, a generated
///   directory) yields an empty index and no explanation.
/// - `git_global(false)` + `ignore(false)` — only the project's own
///   `.gitignore` and `.git/info/exclude` count. A machine-local `~/.gitignore`
///   must not make two people see different instruction maps for one repo.
/// - `follow_links(false)`, with symlinked entries INCLUDED as files. Hub's own
///   `symlink` root strategy writes `CLAUDE.md -> AGENTS.md`, so a walker
///   filtering on `is_file()` would drop every derived root and with it that
///   directory's canonical verdict. Not following links is also what keeps the
///   walk loop-free and its rels readable (`read_agent_doc` refuses a path
///   under a symlinked ancestor).
fn md_walker(root: &Path, apply_ignore_rules: bool) -> ignore::Walk {
    let mut b = ignore::WalkBuilder::new(root);
    b.hidden(false)
        .parents(false)
        .git_global(false)
        .ignore(false)
        .git_ignore(apply_ignore_rules)
        .git_exclude(apply_ignore_rules)
        .require_git(false)
        .follow_links(false);
    let owned_root = root.to_path_buf();
    b.filter_entry(move |entry| {
        let Some(rel) = rel_under(&owned_root, entry.path()) else {
            return true; // the root itself
        };
        let is_dir = entry.file_type().is_some_and(|t| t.is_dir());
        walk_entry_allowed(&rel, is_dir)
    });
    b.build()
}

fn is_walked_file(entry: &ignore::DirEntry) -> bool {
    // `follow_links(false)` means a symlink reports as a symlink, never a dir,
    // so "not a directory" is the correct file test — and the one that keeps
    // hub's derived `CLAUDE.md -> AGENTS.md` roots in the listing.
    entry.file_type().is_some_and(|t| !t.is_dir())
}

/// One walked `.md` file. The walk already proves it exists and whether it is a
/// symlink, so an ordinary browse row needs no syscall of its own at all.
struct BrowseEntry {
    rel: String,
    is_symlink: bool,
}

/// Complete `.md` path index for the browse view — **paths only**. No `stat`,
/// no read, no hash, so enumeration cost is independent of metadata cost and
/// there is no budget to justify: the index is complete, which is also what
/// lets the map filter match a file the user has not expanded to.
///
/// Returns the rels plus the number of `.md` files the project's own ignore
/// rules withheld. The count is what the map reports; silently applying a new
/// filter would only swap one kind of unexplained absence for another.
fn browse_index(root: &Path, include_ignored: bool, total_md: usize) -> (Vec<BrowseEntry>, usize) {
    let mut rels: Vec<BrowseEntry> = Vec::new();
    for entry in md_walker(root, !include_ignored).flatten() {
        if !is_walked_file(&entry) {
            continue;
        }
        let Some(rel) = rel_under(root, entry.path()) else {
            continue;
        };
        if is_markdown_rel(&rel) {
            let is_symlink = entry.file_type().is_some_and(|t| t.is_symlink());
            rels.push(BrowseEntry { rel, is_symlink });
        }
    }
    rels.sort_by(|a, b| a.rel.cmp(&b.rel));
    // The unfiltered total comes from the classification pass, which already
    // walks the whole tree. Counting it with a THIRD walk would descend into
    // exactly the gitignored subtrees the filter exists to skip — on the
    // project this was measured against, 720 of them.
    let withheld = if include_ignored {
        0
    } else {
        total_md.saturating_sub(rels.len())
    };
    (rels, withheld)
}

/// A row the walk found and nothing else needs to know about yet: it exists (or
/// the walk would not have yielded it) but its size and mtime are unresolved,
/// and `resolve_agent_doc_dir_meta` fills them in when the row is displayed.
/// Distinguishing this from "not on disk" is not cosmetic — `FileRow` derives
/// everything from `exists`, so an unresolved row that reported `exists: false`
/// would open the create-new draft for a file that is already there.
///
/// Symlinks fall back to the full stat path: they are rare, and their target
/// has to be resolved before the row can claim to be editable.
fn walked_file_meta(
    rel: &str,
    abs_path: &Path,
    project_root: &Path,
    is_symlink: bool,
) -> AgentDocFileMeta {
    if is_symlink {
        return build_file_meta(rel, abs_path, project_root, false, true, MetaMode::Stat);
    }
    AgentDocFileMeta {
        rel: rel.to_string(),
        name: rel.rsplit('/').next().unwrap_or(rel).to_string(),
        label: rel.to_string(),
        absolute_path: abs_path.to_string_lossy().into_owned(),
        exists: true,
        is_known: false,
        is_discovered: true,
        is_symlink: false,
        symlink_to: None,
        symlink_target_in_project: false,
        can_read: true,
        can_write: true,
        size: None,
        modified_at: None,
        hash: None,
        error: None,
        ..Default::default()
    }
}

/// The agent-basename scan. Deliberately NOT ignore-filtered: gitignoring
/// `CLAUDE.md` is normal (a machine-local root), and an import target can be a
/// deliberately untracked file, so ignore rules bound the browse index and
/// nothing else — never classification, never read/write access.
fn classification_scan(root: &Path) -> Vec<String> {
    classification_scan_counting(root).0
}

/// The classification walk, also returning the total number of `.md` files it
/// saw. Both numbers come from one traversal: this pass is already unfiltered,
/// so it is exactly the walk the withheld count needs.
fn classification_scan_counting(root: &Path) -> (Vec<String>, usize) {
    let mut rels: Vec<String> = Vec::new();
    let mut total_md = 0usize;
    for entry in md_walker(root, false).flatten() {
        if !is_walked_file(&entry) {
            continue;
        }
        let Some(rel) = rel_under(root, entry.path()) else {
            continue;
        };
        if is_markdown_rel(&rel) {
            total_md += 1;
        }
        let name = rel.rsplit('/').next().unwrap_or(&rel);
        if ALLOWED_BASENAMES.contains(&name) {
            rels.push(rel);
        }
    }
    rels.sort();
    (rels, total_md)
}

// ─── Import graph (`@path`) ─────────────────────────────────────────────────

/// Claude Code follows imports four hops deep. Not five.
pub const MAX_IMPORT_HOPS: usize = 4;

/// Where a resolved import target landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportClass {
    /// Inside the project root — an ordinary row, editable as usual.
    InProject,
    /// Outside it. `@~/.claude/my-project-instructions.md` is the documented
    /// way to share preferences across worktrees, so this is a STATE, not an
    /// error: reporting a working configuration as a broken import would be a
    /// lie with a red badge on it.
    External,
    /// Past the four-hop limit. Listed, but reported as not loaded rather than
    /// silently presented as context the agent reads.
    BeyondDepth,
}

impl ImportClass {
    fn as_str(self) -> &'static str {
        match self {
            ImportClass::InProject => "in_project",
            ImportClass::External => "external",
            ImportClass::BeyondDepth => "beyond_depth",
        }
    }
}

/// One node of the resolved graph, keyed by the rel it occupies in the map
/// (in-project) or by its absolute path (external).
#[derive(Debug, Clone)]
pub struct ImportNode {
    pub rel: Option<String>,
    pub abs: PathBuf,
    pub class: ImportClass,
    /// Rels of the agent docs that declare this import, deduped by canonical
    /// target, sorted, so attribution never depends on walk order.
    pub importers: Vec<String>,
    pub is_markdown: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ImportGraph {
    /// Resolved targets, keyed by in-project rel when there is one.
    pub nodes: Vec<ImportNode>,
    /// Importer rel → the raw paths it imports that do not exist.
    pub unresolved: HashMap<String, Vec<String>>,
}

/// The fence marker opening or closing a fenced code block: its character and
/// run length.
fn fence_marker(trimmed: &str) -> Option<(char, usize)> {
    let first = trimmed.chars().next()?;
    if first != '`' && first != '~' {
        return None;
    }
    let n = trimmed.chars().take_while(|c| *c == first).count();
    if n >= 3 { Some((first, n)) } else { None }
}

/// Blank out matched code spans so a backticked path reads as the literal text
/// the docs say it is. An unmatched run of backticks is literal text itself and
/// is left alone.
fn strip_code_spans(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<char> = chars.clone();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] != '`' {
            i += 1;
            continue;
        }
        let run = chars[i..].iter().take_while(|c| **c == '`').count();
        // Look for a closing run of exactly the same length.
        let mut j = i + run;
        let mut close: Option<usize> = None;
        while j < chars.len() {
            if chars[j] == '`' {
                let r = chars[j..].iter().take_while(|c| **c == '`').count();
                if r == run {
                    close = Some(j);
                    break;
                }
                j += r;
            } else {
                j += 1;
            }
        }
        match close {
            Some(c) => {
                for slot in out.iter_mut().take(c + run).skip(i) {
                    *slot = ' ';
                }
                i = c + run;
            }
            None => i += run,
        }
    }
    out.into_iter().collect()
}

/// True when `@` at this position starts a directive rather than sitting inside
/// a word — an email address or a `foo@bar` handle is not an import.
fn at_is_directive_start(before: Option<char>) -> bool {
    match before {
        None => true,
        Some(c) => !(c.is_alphanumeric() || matches!(c, '.' | '_' | '-' | '/' | '~' | '@')),
    }
}

fn imports_in_line(line: &str) -> Vec<String> {
    let stripped = strip_code_spans(line);
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    let mut iter = stripped.char_indices().peekable();
    while let Some((i, c)) = iter.next() {
        if c != '@' || !at_is_directive_start(prev) {
            prev = Some(c);
            continue;
        }
        let rest = &stripped[i + 1..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == '`')
            .unwrap_or(rest.len());
        let token = rest[..end].trim_end_matches(|c| ".,;:!?)]}>\"'".contains(c));
        // A bare `@word` is a mention, not a path. Requiring a separator or an
        // extension is what keeps `@Composable`-shaped prose out of the map
        // without narrowing the syntax the docs actually describe.
        if !token.is_empty()
            && (token.contains('/') || token.contains('.') || token.starts_with('~'))
        {
            out.push(token.to_string());
        }
        // Skip past the token so a path can't be rescanned character by char.
        // `end` is a BYTE offset into `rest` and `iter` walks CHARS, so advance
        // by comparing positions — counting `end` iterations would overshoot on
        // any non-ASCII path and could skip the next directive on the line.
        let token_end = i + 1 + end;
        while iter.peek().is_some_and(|(j, _)| *j < token_end) {
            iter.next();
        }
        prev = rest[..end].chars().last().or(Some('@'));
    }
    out
}

/// Import directives declared by `content`, in order, deduped.
///
/// Follows the documented behaviour rather than a convenient subset: a
/// directive is `@path` ANYWHERE in a line (the docs' own example is
/// `- git workflow @docs/git-instructions.md`), and code spans, fenced blocks,
/// and indented code blocks are all literal text.
pub fn parse_imports(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut fence: Option<(char, usize)> = None;
    for raw in content.lines() {
        let trimmed = raw.trim_start();
        if let Some((ch, n)) = fence_marker(trimmed) {
            match fence {
                None => fence = Some((ch, n)),
                Some((open_ch, open_n)) => {
                    if ch == open_ch && n >= open_n {
                        fence = None;
                    }
                }
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if raw.starts_with("    ") || raw.starts_with('\t') {
            continue;
        }
        for path in imports_in_line(raw) {
            if seen.insert(path.clone()) {
                out.push(path);
            }
        }
    }
    out
}

/// Lexically normalize `..` and `.` without touching the filesystem, so a
/// target that climbs out of the project is recognized as external rather than
/// silently failing to canonicalize.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Resolve one raw import path declared by a file at `importer_abs`.
/// Relative paths resolve against the IMPORTING FILE's directory — never the
/// working directory and never the project root.
fn resolve_import_path(raw: &str, importer_abs: &Path) -> Option<PathBuf> {
    let expanded: PathBuf = if raw == "~" {
        home_dir()?
    } else if let Some(rest) = raw.strip_prefix("~/") {
        home_dir()?.join(rest)
    } else if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        importer_abs.parent()?.join(raw)
    };
    Some(lexical_normalize(&expanded))
}

/// Group seed docs by the file they ultimately point at and keep one per group.
///
/// A real project had `AGENTS.md` and `AGENT.md` as symlinks to `CLAUDE.md`; all
/// three enumerate as distinct rels and parse the same imports. Without this,
/// `rules.md` has three importers and walk order picks the winner — plausibly
/// `AGENT.md`, which no harness reads at all. Symlinked twins are hub's own
/// default root strategy, so this is the common case, not an edge one.
fn dedup_seeds_by_target(project_root: &Path, seeds: &[String]) -> Vec<String> {
    let mut groups: HashMap<PathBuf, Vec<String>> = HashMap::new();
    for rel in seeds {
        let abs = project_root.join(rel);
        let key = abs.canonicalize().unwrap_or_else(|_| abs.clone());
        groups.entry(key).or_default().push(rel.clone());
    }
    let mut out: Vec<String> = Vec::new();
    for (target, mut rels) in groups {
        rels.sort();
        let winner = rels
            .iter()
            .find(|r| project_root.join(r) == target)
            .or_else(|| {
                rels.iter().find(|r| {
                    fs::symlink_metadata(project_root.join(r))
                        .map(|m| !m.file_type().is_symlink())
                        .unwrap_or(false)
                })
            })
            .cloned()
            .unwrap_or_else(|| rels[0].clone());
        out.push(winner);
    }
    out.sort();
    out
}

/// True when the project's agent docs actually import `rel`. Recomputed rather
/// than trusted from the caller: the frontend is a convenience, not the
/// boundary, and this is the one thing standing between "a documented
/// `@package.json` import opens read-only" and "any file in the project opens".
pub fn is_reached_import_target(project_root: &Path, rel: &str) -> bool {
    let seeds = classification_scan(project_root);
    resolve_import_graph(project_root, &seeds)
        .nodes
        .iter()
        .any(|n| n.rel.as_deref() == Some(rel) && n.class == ImportClass::InProject)
}

/// Follow `@` imports from `seeds` transitively, four hops deep, with a cycle
/// guard.
pub fn resolve_import_graph(project_root: &Path, seeds: &[String]) -> ImportGraph {
    let mut graph = ImportGraph::default();
    // Canonical path → index into `graph.nodes`, so a file reached twice is one
    // row with both importers rather than two rows.
    let mut index: HashMap<PathBuf, usize> = HashMap::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();

    let roots = dedup_seeds_by_target(project_root, seeds);
    let mut queue: VecDeque<(String, PathBuf, usize)> = VecDeque::new();
    for rel in &roots {
        let abs = project_root.join(rel);
        let key = abs.canonicalize().unwrap_or_else(|_| abs.clone());
        if visited.insert(key) {
            queue.push_back((rel.clone(), abs, 0));
        }
    }

    while let Some((importer_rel, importer_abs, depth)) = queue.pop_front() {
        let Ok(content) = fs::read_to_string(&importer_abs) else {
            continue;
        };
        for raw in parse_imports(&content) {
            let Some(target_abs) = resolve_import_path(&raw, &importer_abs) else {
                graph
                    .unresolved
                    .entry(importer_rel.clone())
                    .or_default()
                    .push(raw.clone());
                continue;
            };
            let in_project = target_abs.starts_with(project_root);
            let exists = fs::symlink_metadata(&target_abs).is_ok();

            if !exists {
                // Only an IN-PROJECT miss is reportable. A `@~/…` target that
                // is not on this machine is the documented cross-worktree
                // pattern seen from the other worktree — hub cannot see another
                // user's home directory, so its absence here is not evidence
                // that the configuration is broken. Externals are a state, not
                // an error, in both directions.
                if in_project {
                    graph
                        .unresolved
                        .entry(importer_rel.clone())
                        .or_default()
                        .push(raw.clone());
                }
                continue;
            }

            let hop = depth + 1;
            let class = if !in_project {
                ImportClass::External
            } else if hop > MAX_IMPORT_HOPS {
                ImportClass::BeyondDepth
            } else {
                ImportClass::InProject
            };
            let rel = if in_project {
                rel_under(project_root, &target_abs)
            } else {
                None
            };
            let is_markdown = rel
                .as_deref()
                .map(is_markdown_rel)
                .unwrap_or_else(|| {
                    target_abs
                        .file_name()
                        .map(|n| n.to_string_lossy().ends_with(".md"))
                        .unwrap_or(false)
                });
            // A hub-managed skip-listed path is out of reach for read/write, so
            // listing it as loaded context would produce a row that errors on
            // click.
            if rel.as_deref().is_some_and(is_ignored_rel) {
                continue;
            }

            let key = target_abs.canonicalize().unwrap_or_else(|_| target_abs.clone());
            match index.get(&key) {
                Some(&i) => {
                    let node = &mut graph.nodes[i];
                    if !node.importers.contains(&importer_rel) {
                        node.importers.push(importer_rel.clone());
                        node.importers.sort();
                    }
                    // A file first seen past the limit and later reached within
                    // it is loaded; the reverse is not true.
                    if class == ImportClass::InProject {
                        node.class = ImportClass::InProject;
                    }
                }
                None => {
                    index.insert(key.clone(), graph.nodes.len());
                    graph.nodes.push(ImportNode {
                        rel: rel.clone(),
                        abs: target_abs.clone(),
                        class,
                        importers: vec![importer_rel.clone()],
                        is_markdown,
                    });
                }
            }

            // Recurse only into readable, in-project, markdown targets within
            // the limit. An external target cannot be confined, and a
            // non-markdown one carries no directives worth following.
            if class == ImportClass::InProject && is_markdown && visited.insert(key) {
                if let Some(r) = rel {
                    queue.push_back((r, target_abs, hop));
                }
            }
        }
    }

    for list in graph.unresolved.values_mut() {
        list.sort();
        list.dedup();
    }
    graph.nodes.sort_by(|a, b| a.abs.cmp(&b.abs));
    graph
}

fn first_markdown_heading(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_EDITOR_BYTES {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    for line in content.lines().take(200) {
        let trimmed = line.trim_start();
        let hashes = trimmed.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes) && trimmed.chars().nth(hashes) == Some(' ') {
            let title = trimmed[hashes..].trim();
            if !title.is_empty() {
                return Some(title.to_string());
            }
        }
    }
    None
}

fn parent_rel(rel: &str) -> String {
    rel.rsplit_once('/')
        .map(|(p, _)| p.to_string())
        .unwrap_or_default()
}

fn rel_in_dir(dir: &str, basename: &str) -> String {
    if dir.is_empty() {
        basename.to_string()
    } else {
        format!("{dir}/{basename}")
    }
}

fn display_dir(dir: &str) -> String {
    if dir.is_empty() {
        "root".to_string()
    } else {
        dir.to_string()
    }
}

fn folder_label(dir: &str) -> String {
    if dir.is_empty() {
        "Project Instructions".to_string()
    } else {
        dir.rsplit('/')
            .next()
            .unwrap_or(dir)
            .replace(['-', '_'], " ")
    }
}

fn symlink_target_kind(file: &AgentDocFileMeta, abs: &Path, format: AgentDocFormatKind) -> String {
    if !file.is_symlink {
        return "none".into();
    }
    if file
        .error
        .as_deref()
        .is_some_and(|e| e.contains("stat failed"))
    {
        return "broken".into();
    }
    let Some(target) = file.symlink_to.as_ref() else {
        return "unknown".into();
    };
    // A derived CLAUDE.md points at the canonical AGENTS.md; a (reverse)
    // AGENTS.md symlink would point at CLAUDE.md.
    let expected: &[&str] = match format {
        AgentDocFormatKind::CLAUDE => &["AGENTS.md"],
        AgentDocFormatKind::AGENT => &["CLAUDE.md"],
    };
    let matches_sibling = |name: &std::ffi::OsStr| expected.iter().any(|e| name == *e);
    if Path::new(target).file_name().is_some_and(matches_sibling)
        && Path::new(target)
            .parent()
            .is_none_or(|p| p.as_os_str().is_empty())
    {
        return "sibling".into();
    }
    if !file.symlink_target_in_project {
        let target_path = Path::new(target);
        let resolved_target = if target_path.is_absolute() {
            target_path.to_path_buf()
        } else {
            abs.parent()
                .unwrap_or_else(|| Path::new(""))
                .join(target_path)
        };
        if !resolved_target.exists() {
            return "broken".into();
        }
        return "external".into();
    }
    if let Ok(resolved) = abs.canonicalize() {
        if resolved.file_name().is_some_and(matches_sibling) && resolved.parent() == abs.parent() {
            return "sibling".into();
        }
    }
    "external".into()
}

// Test-only policy override: unit tests run against tmp projects and must not
// depend on the developer's real registry / installed harnesses.
#[cfg(test)]
thread_local! {
    pub static TEST_POLICY: std::cell::RefCell<Option<CanonicalPolicy>> =
        const { std::cell::RefCell::new(None) };
}

/// Resolve the effective canonical-root policy for a project: effective
/// harnesses = (harnesses_global ∪ project.harnesses) ∩ installed, mapped to
/// required root files (`claude-code` → CLAUDE.md, every other harness →
/// AGENTS.md), plus the strategy (project override ?? global ?? symlink).
pub fn resolve_policy_for_project(project_root: &Path) -> Result<CanonicalPolicy, String> {
    #[cfg(test)]
    {
        let _ = project_root;
        return Ok(TEST_POLICY.with(|t| t.borrow().clone()).unwrap_or(CanonicalPolicy {
            requires_claude: true,
            requires_agent: false,
            strategy: "symlink".into(),
            claude_harnesses: vec!["claude-code".into()],
            agent_harnesses: Vec::new(),
        }));
    }
    #[cfg(not(test))]
    {
        resolve_policy_from_registry(project_root)
    }
}

#[cfg_attr(test, allow(dead_code))]
fn resolve_policy_from_registry(project_root: &Path) -> Result<CanonicalPolicy, String> {
    super::hub_json(
        ["agent-docs", "policy", "--project-path", &project_root.to_string_lossy(), "--json"],
        None,
    )
}

// ─── Canonical-status classifier ────────────────────────────────────────────
//
// THE status definition (design D2). `agent_docs.py::classify_directory`
// implements the same table; tests/fixtures/agent_docs_corpus.json pins both.

#[derive(Debug, Clone, PartialEq)]
enum PathKind {
    Missing,
    File,
    Symlink,
}

#[derive(Debug, Clone)]
struct LinkState {
    kind: PathKind,
    resolves: bool,
    sibling: bool,
    external: bool,
    resolved_name: Option<String>,
}

fn link_state(p: &Path, project_root: &Path) -> LinkState {
    let mut out = LinkState {
        kind: PathKind::Missing,
        resolves: false,
        sibling: false,
        external: false,
        resolved_name: None,
    };
    let Ok(meta) = fs::symlink_metadata(p) else {
        return out;
    };
    if meta.file_type().is_symlink() {
        out.kind = PathKind::Symlink;
        let Ok(resolved) = p.canonicalize() else {
            return out; // broken
        };
        out.resolves = true;
        out.resolved_name = resolved
            .file_name()
            .map(|n| n.to_string_lossy().into_owned());
        let root_canon = project_root
            .canonicalize()
            .unwrap_or_else(|_| project_root.to_path_buf());
        if !resolved.starts_with(&root_canon) {
            out.external = true;
            return out;
        }
        let parent_canon = p
            .parent()
            .and_then(|d| d.canonicalize().ok());
        out.sibling = parent_canon.as_deref() == resolved.parent()
            && out
                .resolved_name
                .as_deref()
                .is_some_and(|n| n == "CLAUDE.md" || n == CANONICAL_BASENAME || n == LEGACY_BASENAME);
        return out;
    }
    out.kind = PathKind::File;
    out.resolves = true;
    out
}

/// Classify a regular CLAUDE.md body.
/// `import` | `materialized` | `pointer_plus` | `user`.
fn pointer_body_kind(content: &str) -> &'static str {
    let stripped = content.trim();
    if stripped == IMPORT_POINTER_LINE {
        return "import";
    }
    if stripped == CANONICAL_BASENAME {
        return "materialized";
    }
    let trimmed_start = content.trim_start();
    let (first, rest) = match trimmed_start.split_once('\n') {
        Some((f, r)) => (f, r),
        None => (trimmed_start, ""),
    };
    if first.trim() == IMPORT_POINTER_LINE && !rest.trim().is_empty() {
        return "pointer_plus";
    }
    "user"
}

#[derive(Debug, Clone)]
pub struct DirVerdict {
    pub verdict: String,
    pub flags: Vec<String>,
    pub appendix: Option<String>,
}

pub fn classify_dir(
    dir: &Path,
    project_root: &Path,
    is_root: bool,
    policy: &CanonicalPolicy,
) -> DirVerdict {
    let claude_p = dir.join("CLAUDE.md");
    let agents_p = dir.join(CANONICAL_BASENAME);
    let legacy_p = dir.join(LEGACY_BASENAME);
    let claude = link_state(&claude_p, project_root);
    let agents = link_state(&agents_p, project_root);
    let legacy = link_state(&legacy_p, project_root);

    let mut flags: Vec<String> = Vec::new();
    for st in [&claude, &agents, &legacy] {
        if st.kind == PathKind::Symlink && !st.resolves && !flags.iter().any(|f| f == "broken_link")
        {
            flags.push("broken_link".into());
        }
        if st.kind == PathKind::Symlink && st.external && !flags.iter().any(|f| f == "external_link")
        {
            flags.push("external_link".into());
        }
    }
    if legacy.kind != PathKind::Missing {
        flags.push("legacy".into());
    }

    let mut out = DirVerdict {
        verdict: "none".into(),
        flags,
        appendix: None,
    };
    if !policy.requires_claude && !policy.requires_agent {
        return out;
    }

    let claude_external = claude.kind == PathKind::Symlink && claude.external;
    let agents_external = agents.kind == PathKind::Symlink && agents.external;
    let agents_real = agents.kind == PathKind::File;
    let claude_real = claude.kind == PathKind::File;
    let claude_content = if claude_real {
        fs::read_to_string(&claude_p).ok()
    } else {
        None
    };
    let claude_kind: &str = match (&claude_content, claude_real) {
        (Some(c), _) => pointer_body_kind(c),
        (None, true) => "unreadable",
        (None, false) => "absent",
    };
    let claude_derived_link = claude.kind == PathKind::Symlink
        && claude.resolves
        && claude.sibling
        && claude.resolved_name.as_deref() == Some(CANONICAL_BASENAME);

    // Claude-only project.
    if policy.requires_claude && !policy.requires_agent {
        out.verdict = if claude_real || claude_derived_link || claude_external {
            "canonical".into()
        } else {
            "empty".into()
        };
        return out;
    }

    // Agent-only project.
    if policy.requires_agent && !policy.requires_claude {
        out.verdict = if agents_real || agents_external {
            "canonical".into()
        } else if claude_real && claude_kind == "user" {
            "claude_only".into()
        } else {
            "empty".into()
        };
        return out;
    }

    // Multi-harness.
    if agents_real || agents_external {
        out.verdict = if claude_external {
            "canonical".into()
        } else if claude.kind == PathKind::Missing {
            if is_root { "agents_only".into() } else { "canonical".into() }
        } else if claude_derived_link {
            if policy.strategy == "symlink" { "canonical".into() } else { "derived_drift".into() }
        } else if claude.kind == PathKind::Symlink && !claude.resolves {
            if is_root { "agents_only".into() } else { "canonical".into() }
        } else if claude.kind == PathKind::Symlink {
            "derived_drift".into()
        } else if claude_kind == "import" {
            if policy.strategy == "import" { "canonical".into() } else { "derived_drift".into() }
        } else if claude_kind == "materialized" {
            "derived_drift".into()
        } else if claude_kind == "pointer_plus" {
            let content = claude_content.unwrap_or_default();
            let trimmed_start = content.trim_start();
            let rest = trimmed_start
                .split_once('\n')
                .map(|(_, r)| r)
                .unwrap_or("");
            out.appendix = Some(rest.trim_start_matches('\n').to_string());
            "pointer_plus_content".into()
        } else if claude_kind == "unreadable" {
            "conflict".into()
        } else {
            let agents_txt = fs::read_to_string(&agents_p).ok();
            if agents_txt.is_some() && agents_txt == claude_content {
                "replaced_derived".into()
            } else {
                "conflict".into()
            }
        };
        return out;
    }

    // No real AGENTS.md.
    if claude_real && claude_kind == "user" {
        out.verdict = "claude_only".into();
    } else if claude_real
        && (claude_kind == "import" || claude_kind == "materialized" || claude_kind == "pointer_plus")
    {
        if !out.flags.iter().any(|f| f == "broken_link") {
            out.flags.push("broken_link".into());
        }
        out.verdict = "empty".into();
    } else {
        out.verdict = "empty".into();
    }
    out
}

fn build_instruction_sets(
    project_root: &Path,
    files: &[AgentDocFileMeta],
    policy: &CanonicalPolicy,
) -> (Vec<AgentDocInstructionSet>, Vec<AgentDocFormatKind>) {
    let mut required_formats: Vec<AgentDocFormatKind> = Vec::new();
    let mut requirements: HashMap<AgentDocFormatKind, Vec<String>> = HashMap::new();
    if policy.requires_claude {
        required_formats.push(AgentDocFormatKind::CLAUDE);
        requirements.insert(AgentDocFormatKind::CLAUDE, policy.claude_harnesses.clone());
    }
    if policy.requires_agent {
        required_formats.push(AgentDocFormatKind::AGENT);
        requirements.insert(AgentDocFormatKind::AGENT, policy.agent_harnesses.clone());
    }

    let mut dirs: HashMap<String, HashMap<AgentDocFormatKind, AgentDocFileMeta>> = HashMap::new();
    let mut legacy_by_dir: HashMap<String, Vec<AgentDocFileMeta>> = HashMap::new();
    for file in files.iter().filter(|f| f.exists) {
        let dir = parent_rel(&file.rel);
        if file.name == LEGACY_BASENAME {
            legacy_by_dir.entry(dir).or_default().push(file.clone());
        } else if let Some(format) = AgentDocFormatKind::from_basename(&file.name) {
            dirs.entry(dir).or_default().insert(format, file.clone());
        }
    }
    // Legacy-only directories still form a set (so the LEGACY badge has a row).
    for dir in legacy_by_dir.keys() {
        dirs.entry(dir.clone()).or_default();
    }

    let mut sets = Vec::new();
    for (dir, by_format) in dirs {
        let claude = by_format.get(&AgentDocFormatKind::CLAUDE);
        let agent = by_format.get(&AgentDocFormatKind::AGENT);
        let claude_title = claude.and_then(|f| first_markdown_heading(Path::new(&f.absolute_path)));
        let agent_title = agent.and_then(|f| first_markdown_heading(Path::new(&f.absolute_path)));
        // The canonical AGENTS.md is the real root, so its title leads.
        let (label, label_source) = agent_title
            .clone()
            .map(|t| (t, "heading:AGENT".to_string()))
            .or_else(|| {
                claude_title
                    .clone()
                    .map(|t| (t, "heading:CLAUDE".to_string()))
            })
            .unwrap_or_else(|| (folder_label(&dir), "path".to_string()));
        let mut formats = HashMap::new();
        let mut warnings = Vec::new();
        for format in [AgentDocFormatKind::CLAUDE, AgentDocFormatKind::AGENT] {
            let existing = by_format.get(&format).cloned();
            let rel = rel_in_dir(&dir, format.basename());
            let target_kind = existing
                .as_ref()
                .map(|f| symlink_target_kind(f, Path::new(&f.absolute_path), format))
                .unwrap_or_else(|| "missing".into());
            let mut record_warnings = Vec::new();
            if target_kind == "broken" {
                record_warnings.push("Broken symlink".into());
            }
            if target_kind == "external" {
                record_warnings.push("External symlink".into());
            }
            warnings.extend(record_warnings.clone());
            formats.insert(
                format,
                AgentDocFormatRecord {
                    format,
                    rel: rel.clone(),
                    exists: existing.as_ref().is_some_and(|f| f.exists),
                    file: existing.clone(),
                    is_symlink: existing.as_ref().is_some_and(|f| f.is_symlink),
                    target_kind: target_kind.clone(),
                    required_by_harnesses: requirements.get(&format).cloned().unwrap_or_default(),
                    warnings: record_warnings,
                    title: match format {
                        AgentDocFormatKind::CLAUDE => claude_title.clone(),
                        AgentDocFormatKind::AGENT => agent_title.clone(),
                    },
                },
            );
        }
        let legacy = legacy_by_dir.get(&dir).cloned().unwrap_or_default();
        if !legacy.is_empty() {
            warnings.push("Legacy AGENT.md — not read by your agents".into());
        }
        let abs_dir = if dir.is_empty() {
            project_root.to_path_buf()
        } else {
            project_root.join(&dir)
        };
        let dv = classify_dir(&abs_dir, project_root, dir.is_empty(), policy);
        sets.push(AgentDocInstructionSet {
            id: hash_bytes(format!("{}::{}", project_root.display(), dir).as_bytes()),
            relative_dir: dir.clone(),
            display_path: display_dir(&dir),
            full_path_title: if dir.is_empty() {
                project_root.display().to_string()
            } else {
                project_root.join(&dir).display().to_string()
            },
            label,
            label_source,
            verdict: dv.verdict,
            flags: dv.flags,
            formats,
            legacy,
            appendix: dv.appendix,
            required_formats: required_formats.clone(),
            warnings,
        });
    }
    sets.sort_by(|a, b| a.relative_dir.cmp(&b.relative_dir));
    (sets, required_formats)
}

fn insert_file_into_tree(root: &mut AgentDocFolder, file: AgentDocFileMeta) {
    let parts: Vec<&str> = file.rel.split('/').collect();
    let mut cursor: &mut AgentDocFolder = root;
    for i in 0..parts.len() - 1 {
        let part = parts[i].to_string();
        let path_so_far = parts[..=i].join("/");
        let pos = cursor.dirs.iter().position(|d| d.name == part);
        match pos {
            Some(idx) => {
                cursor = &mut cursor.dirs[idx];
            }
            None => {
                cursor.dirs.push(AgentDocFolder {
                    name: part,
                    path: path_so_far,
                    dirs: Vec::new(),
                    files: Vec::new(),
                });
                cursor = cursor.dirs.last_mut().unwrap();
            }
        }
    }
    cursor.files.push(file);
}

// ─── Commands ───────────────────────────────────────────────────────────────

/// Serializes all agent-doc commands. `write_agent_doc_impl` updates the
/// canonical root and its derived twin as two separate FS operations, so an
/// unserialized concurrent read could observe the half-written layout.
static AGENT_DOCS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command]
pub async fn list_agent_docs(
    project_path: String,
    include_all_markdown: Option<bool>,
    include_ignored: Option<bool>,
) -> Result<AgentDocsListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Deliberately NOT under AGENT_DOCS_LOCK. The lock exists because a
        // canonicalizing write updates the root and its derived twin as two
        // separate FS operations; an unbounded walk of a broad root has nothing
        // to do with that, and holding the lock across it would put a queued
        // ⌘S behind a full-project enumeration.
        list_agent_docs_impl_with_options(
            project_path,
            include_all_markdown.unwrap_or(false),
            include_ignored.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| format!("list_agent_docs task failed: {e}"))?
}

#[cfg(test)]
fn list_agent_docs_impl(project_path: String) -> Result<AgentDocsListing, String> {
    list_agent_docs_impl_with_options(project_path, false, false)
}

fn list_agent_docs_impl_with_options(
    project_path: String,
    include_all_markdown: bool,
    include_ignored: bool,
) -> Result<AgentDocsListing, String> {
    let canonical = canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;

    // Two passes, unioned. Classification is never ignore-filtered, so a
    // gitignored `CLAUDE.md` stays an instruction file in BOTH views; the
    // browse index is, so a CI checkout of the repo inside itself stops
    // crowding out the real docs. `insert_file_into_tree` does no dedup, so
    // the union has to happen before metas are built or a file in both passes
    // yields two rows with contradictory flags.
    let (classification, total_md) = classification_scan_counting(&canonical);

    // Follow `@` imports from the discovered agent docs. This is what puts a
    // file the agent genuinely loads — a project root's `CLAUDE.md:11` imports
    // `@docs/agent/rules.md` — into the map at all: classification is
    // basename-only, so it never saw it.
    let import_graph = resolve_import_graph(&canonical, &classification);
    let mut imported: HashMap<String, &ImportNode> = HashMap::new();
    for node in &import_graph.nodes {
        if let Some(rel) = &node.rel {
            imported.insert(rel.clone(), node);
        }
    }

    let mut instruction_set: HashSet<String> = classification.iter().cloned().collect();
    // An import target is a first-class map entry whatever its basename, and it
    // is loaded context, so it belongs to the instruction index in both modes.
    for rel in imported.keys() {
        instruction_set.insert(rel.clone());
    }
    if !include_all_markdown {
        // The virtual placeholders. They belong to the instruction map only —
        // two tests pin that a browse listing reports them as not-known.
        instruction_set.extend(KNOWN_RELS.iter().map(|s| s.to_string()));
    }

    let mut ignored_count = 0usize;
    let mut browse_only: Vec<BrowseEntry> = Vec::new();
    if include_all_markdown {
        let (browse, withheld) = browse_index(&canonical, include_ignored, total_md);
        ignored_count = withheld;
        browse_only = browse
            .into_iter()
            .filter(|e| !instruction_set.contains(&e.rel))
            .collect();
    }

    let mut instruction_rels: Vec<String> = instruction_set.into_iter().collect();
    instruction_rels.sort();

    let mut root = AgentDocFolder {
        name: String::new(),
        path: String::new(),
        dirs: Vec::new(),
        files: Vec::new(),
    };
    // Instruction files are stat'd eagerly: there are 76 of them on the project
    // this change was measured against, they drive every verdict, and the
    // context estimate has to be a fixed number rather than one that climbs as
    // the user expands folders.
    let policy = resolve_policy_for_project(&canonical)?;
    // `@` imports are Claude Code's. A project whose effective harnesses do not
    // include it still SEES the row — suppressing it would leave the file
    // unexplained — but the row says the project's harnesses will not load it.
    let import_unreachable = !policy.requires_claude;

    let mut metas: Vec<AgentDocFileMeta> = Vec::new();
    for rel in &instruction_rels {
        let abs = canonical.join(rel);
        let is_known = !include_all_markdown && KNOWN_RELS.contains(&rel.as_str());
        let mut meta = build_file_meta(
            rel,
            &abs,
            &canonical,
            is_known,
            !is_known,
            MetaMode::Stat,
        );
        if let Some(node) = imported.get(rel.as_str()) {
            meta.is_import = true;
            meta.imported_by = node.importers.clone();
            meta.import_class = Some(node.class.as_str().to_string());
            meta.import_unreachable = import_unreachable;
            meta.is_non_markdown = !node.is_markdown;
            if !node.is_markdown {
                // `read_agent_doc` gates on markdown-or-agent-basename, so a
                // non-Markdown target has to be read-only or clicking it errors.
                meta.can_write = false;
            }
        }
        // `@` imports are Claude Code's. `agent_docs.py` reports unresolved
        // ones only for a project whose effective harnesses include it, and a
        // GUI that warns while `hub sync` says `ok` is the disagreement the
        // shared model exists to prevent. The ROW still says `imported` and
        // `unreachable` — that explains the file; a broken-import warning for a
        // harness that never reads imports does not.
        if !import_unreachable {
            if let Some(missing) = import_graph.unresolved.get(rel.as_str()) {
                meta.unresolved_imports = missing.clone();
            }
        }
        metas.push(meta.clone());
        insert_file_into_tree(&mut root, meta);
    }
    // Everything else the browse walk found gets a row with no syscall behind
    // it. On 1034 files that is the difference between a listing that costs
    // what it displays and one that costs what the project contains.
    let mut all_rels: Vec<String> = instruction_rels.clone();
    for entry in &browse_only {
        let abs = canonical.join(&entry.rel);
        insert_file_into_tree(
            &mut root,
            walked_file_meta(&entry.rel, &abs, &canonical, entry.is_symlink),
        );
        all_rels.push(entry.rel.clone());
    }
    all_rels.sort();

    let (mut instruction_sets, required_formats) =
        build_instruction_sets(&canonical, &metas, &policy);
    // An unresolved import is the importing file's problem, so it surfaces on
    // the set that owns that file — the row the user would go looking at.
    for set in &mut instruction_sets {
        if import_unreachable {
            continue;
        }
        for format in [AgentDocFormatKind::CLAUDE, AgentDocFormatKind::AGENT] {
            let Some(record) = set.formats.get(&format) else {
                continue;
            };
            if let Some(missing) = import_graph.unresolved.get(&record.rel) {
                for path in missing {
                    set.warnings
                        .push(format!("Unresolved import: {path}"));
                }
            }
        }
        set.warnings.dedup();
    }

    let external_imports: Vec<AgentDocFileMeta> = import_graph
        .nodes
        .iter()
        .filter(|n| n.class == ImportClass::External)
        .map(|n| AgentDocFileMeta {
            rel: n.abs.to_string_lossy().into_owned(),
            name: n
                .abs
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            label: n.abs.to_string_lossy().into_owned(),
            absolute_path: n.abs.to_string_lossy().into_owned(),
            exists: true,
            is_discovered: true,
            can_read: false,
            can_write: false,
            is_import: true,
            imported_by: n.importers.clone(),
            import_class: Some(n.class.as_str().to_string()),
            import_unreachable,
            is_non_markdown: !n.is_markdown,
            ..Default::default()
        })
        .collect();

    Ok(AgentDocsListing {
        project_path: canonical.to_string_lossy().into_owned(),
        root,
        instruction_sets,
        required_formats,
        policy: AgentDocPolicyInfo {
            requires_claude: policy.requires_claude,
            requires_agent: policy.requires_agent,
            strategy: policy.strategy.clone(),
            canonical: policy.canonical().map(String::from),
            derived: policy.derived().map(String::from),
        },
        all_rels,
        instruction_rels,
        external_imports,
        ignored_count,
        include_ignored,
    })
}

/// Size and mtime for the `.md` files directly inside one directory, resolved
/// when its rows are actually displayed. The listing ships browse rows with
/// unresolved metadata precisely so this cost lands per expanded folder rather
/// than per project.
///
/// Confinement is the listing's, unchanged: the static skip list and a
/// symlinked-ancestor check, never the project's ignore rules — those bound the
/// browse index and nothing else.
#[tauri::command]
pub async fn resolve_agent_doc_dir_meta(
    project_path: String,
    relative_dir: String,
) -> Result<Vec<AgentDocFileMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        resolve_agent_doc_dir_meta_impl(project_path, relative_dir)
    })
    .await
    .map_err(|e| format!("resolve_agent_doc_dir_meta task failed: {e}"))?
}

fn resolve_agent_doc_dir_meta_impl(
    project_path: String,
    relative_dir: String,
) -> Result<Vec<AgentDocFileMeta>, String> {
    let project_root =
        canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;
    let dir_rel = if relative_dir.trim().is_empty() {
        String::new()
    } else {
        normalize_rel(&relative_dir).map_err(|e| e.to_string_payload())?
    };

    let abs_dir = if dir_rel.is_empty() {
        project_root.clone()
    } else {
        if !walk_entry_allowed(&dir_rel, true)
            || is_ignored_rel(&format!("{dir_rel}/x.md"))
            || has_symlinked_ancestor(&project_root, &format!("{dir_rel}/x.md"))
        {
            return Err(AgentDocError::InvalidPath {
                message: format!("Directory is skipped by the Agent Docs scan: {dir_rel}"),
            }
            .to_string_payload());
        }
        resolve_in_project(&project_root, &dir_rel).map_err(|e| e.to_string_payload())?
    };

    let entries = match fs::read_dir(&abs_dir) {
        Ok(e) => e,
        // A directory that vanished between listing and expansion is not an
        // error the user can act on; the next listing drops its rows.
        Err(_) => return Ok(Vec::new()),
    };
    let mut out: Vec<AgentDocFileMeta> = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".md") {
            continue;
        }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            continue;
        }
        let rel = if dir_rel.is_empty() {
            name.clone()
        } else {
            format!("{dir_rel}/{name}")
        };
        let is_known = KNOWN_RELS.contains(&rel.as_str());
        out.push(build_file_meta(
            &rel,
            &entry.path(),
            &project_root,
            is_known,
            !is_known,
            MetaMode::Stat,
        ));
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(out)
}

#[tauri::command]
pub async fn read_agent_doc(
    project_path: String,
    relative_path: String,
) -> Result<AgentDocContent, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        read_agent_doc_impl(project_path, relative_path)
    })
    .await
    .map_err(|e| format!("read_agent_doc task failed: {e}"))?
}

fn read_agent_doc_impl(
    project_path: String,
    relative_path: String,
) -> Result<AgentDocContent, String> {
    let rel = normalize_rel(&relative_path).map_err(|e| e.to_string_payload())?;
    let project_root =
        canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;
    // `@package.json` is in the Claude Code docs, so an import target need not
    // be Markdown. Rather than widen the read surface to every project file, a
    // non-Markdown rel is admitted only when the import graph actually reaches
    // it — the same graph that put the row on screen. The cost is one
    // classification walk, and only on a click on such a row.
    if !is_allowed_agent_doc_rel(&rel)
        && !is_markdown_rel(&rel)
        && !is_reached_import_target(&project_root, &rel)
    {
        return Err(AgentDocError::NotAllowedBasename { rel }.to_string_payload());
    }
    // Reads/writes must match discovery: refuse to reach under a directory the
    // scan skips — directly (`is_ignored_rel`) or via a symlinked ancestor,
    // which discovery never recurses into. Applies to every basename (an agent
    // doc named `node_modules/pkg/CLAUDE.md` is just as hidden as a `.md`); only
    // the curated `KNOWN_RELS` (e.g. `.claude/CLAUDE.md`) are exempt.
    if !KNOWN_RELS.contains(&rel.as_str())
        && (is_ignored_rel(&rel) || has_symlinked_ancestor(&project_root, &rel))
    {
        return Err(AgentDocError::InvalidPath {
            message: format!("Path is under an ignored or symlinked directory: {rel}"),
        }
        .to_string_payload());
    }
    let abs = resolve_in_project(&project_root, &rel).map_err(|e| e.to_string_payload())?;

    let smeta = fs::symlink_metadata(&abs).map_err(|e| {
        AgentDocError::IoError {
            rel: rel.clone(),
            message: format!("File not found: {e}"),
        }
        .to_string_payload()
    })?;
    let is_symlink = smeta.file_type().is_symlink();

    if is_symlink {
        let target = fs::read_link(&abs).ok();
        let resolved = abs.canonicalize().ok();
        let in_project = resolved
            .as_ref()
            .map(|p| p.starts_with(&project_root))
            .unwrap_or(false);
        if !in_project {
            return Err(AgentDocError::ExternalSymlink {
                rel,
                target: target
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            }
            .to_string_payload());
        }
    }

    let meta = fs::metadata(&abs).map_err(|e| {
        AgentDocError::IoError {
            rel: rel.clone(),
            message: format!("Cannot stat: {e}"),
        }
        .to_string_payload()
    })?;

    let size = meta.len();
    let oversized = size > MAX_EDITOR_BYTES;

    if oversized {
        return Err(AgentDocError::Oversized {
            rel,
            size,
            limit: MAX_EDITOR_BYTES,
        }
        .to_string_payload());
    }

    let bytes = fs::read(&abs).map_err(|e| {
        AgentDocError::IoError {
            rel: rel.clone(),
            message: format!("Cannot read: {e}"),
        }
        .to_string_payload()
    })?;

    let content = String::from_utf8(bytes.clone())
        .map_err(|_| AgentDocError::NotUtf8 { rel: rel.clone() }.to_string_payload())?;

    let hash = hash_bytes(&bytes);
    let symlink_to = if is_symlink {
        fs::read_link(&abs)
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    } else {
        None
    };

    // A derived CLAUDE.md is either a symlink to AGENTS.md or a regular file
    // whose body is `@AGENTS.md`. Only the CLAUDE.md at the project root counts
    // as a derived pointer — nested CLAUDE.md files are user-authored.
    let is_derived_pointer = rel == "CLAUDE.md"
        && (is_symlink || is_import_pointer_body(&content));

    Ok(AgentDocContent {
        rel: rel.clone(),
        absolute_path: abs.to_string_lossy().into_owned(),
        content,
        size,
        modified_at: mtime_secs(&meta),
        hash,
        is_symlink,
        symlink_to,
        oversized: false,
        is_derived_pointer,
    })
}

fn atomic_write(abs: &Path, content: &str) -> Result<(), AgentDocError> {
    let parent = abs.parent().ok_or_else(|| AgentDocError::IoError {
        rel: String::new(),
        message: "No parent dir for write target".into(),
    })?;
    fs::create_dir_all(parent).map_err(|e| AgentDocError::IoError {
        rel: String::new(),
        message: format!("Cannot create parent {}: {e}", parent.display()),
    })?;
    let file_name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "doc".into());
    let tmp_name = format!(".{}.tmp", file_name);
    let tmp_path = parent.join(tmp_name);
    {
        let mut f = fs::File::create(&tmp_path).map_err(|e| AgentDocError::IoError {
            rel: String::new(),
            message: format!("Cannot stage write: {e}"),
        })?;
        f.write_all(content.as_bytes())
            .map_err(|e| AgentDocError::IoError {
                rel: String::new(),
                message: format!("Cannot write content: {e}"),
            })?;
        f.flush().ok();
    }
    fs::rename(&tmp_path, abs).map_err(|e| AgentDocError::IoError {
        rel: String::new(),
        message: format!("Cannot finalize write: {e}"),
    })?;
    Ok(())
}

/// The write result's `written` entries. `MetaMode::Full` is load-bearing: the
/// frontend adopts `hash` as the buffer's `loadedHash`, and the next save sends
/// it back as `expected_hash`. A `None` there against an existing file is a
/// hard conflict, so a hashless write result produces a spurious conflict
/// dialog on the second save of every session.
fn meta_after_write(rel: &str, abs: &Path, project_root: &Path) -> AgentDocFileMeta {
    build_file_meta(
        rel,
        abs,
        project_root,
        KNOWN_RELS.contains(&rel),
        !KNOWN_RELS.contains(&rel),
        MetaMode::Full,
    )
}

#[cfg(unix)]
fn create_symlink_file(source_basename: &str, target_abs: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source_basename, target_abs)
}

#[cfg(windows)]
fn create_symlink_file(source_basename: &str, target_abs: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source_basename, target_abs)
}

/// Derive `CLAUDE.md` next to a real `AGENTS.md` per the strategy.
fn write_derived_claude(dir: &Path, strategy: &str) -> Result<(), AgentDocError> {
    let claude = dir.join("CLAUDE.md");
    if fs::symlink_metadata(&claude).is_ok() {
        fs::remove_file(&claude).map_err(|e| AgentDocError::IoError {
            rel: "CLAUDE.md".into(),
            message: format!("Cannot replace CLAUDE.md: {e}"),
        })?;
    }
    if strategy == "import" {
        atomic_write(&claude, &format!("{IMPORT_POINTER_LINE}\n"))
    } else {
        create_symlink_file(CANONICAL_BASENAME, &claude).map_err(|e| AgentDocError::IoError {
            rel: "CLAUDE.md".into(),
            message: format!("Cannot derive CLAUDE.md symlink: {e}"),
        })
    }
}

#[tauri::command]
pub async fn write_agent_doc(
    project_path: String,
    relative_path: String,
    content: String,
    expected_hash: Option<String>,
    overwrite: Option<bool>,
    publish_on_save: Option<bool>,
) -> Result<AgentDocWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let baseline_rel = normalize_rel(&relative_path).unwrap_or_else(|_| relative_path.clone());
        let baseline_hash = expected_hash.clone();
        let mut result = {
            let _guard = AGENT_DOCS_LOCK.lock().unwrap();
            write_agent_doc_impl(
                project_path.clone(),
                relative_path,
                content,
                expected_hash,
                overwrite,
            )?
        };
        if publish_on_save.unwrap_or(false) {
            let files: Vec<String> = result
                .written
                .iter()
                .filter(|file| file.rel == "AGENTS.md" || file.rel == "CLAUDE.md")
                .map(|file| file.rel.clone())
                .collect();
            if !files.is_empty() {
                let expected_hashes = baseline_hash
                    .filter(|_| files.iter().any(|file| file == &baseline_rel))
                    .map(|hash| vec![(baseline_rel, hash)])
                    .unwrap_or_default();
                result.publish = Some(
                    agent_docs_publish_now_impl(project_path, files, expected_hashes)
                        .unwrap_or_else(AgentDocPublishResult::bridge_error),
                );
            }
        }
        Ok(result)
    })
    .await
    .map_err(|e| format!("write_agent_doc task failed: {e}"))?
}

fn write_agent_doc_impl(
    project_path: String,
    relative_path: String,
    content: String,
    expected_hash: Option<String>,
    overwrite: Option<bool>,
) -> Result<AgentDocWriteResult, String> {
    let mut content = content;
    let rel = normalize_rel(&relative_path).map_err(|e| e.to_string_payload())?;
    if !is_allowed_agent_doc_rel(&rel) && !is_markdown_rel(&rel) {
        return Err(AgentDocError::NotAllowedBasename { rel }.to_string_payload());
    }
    let project_root =
        canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;
    // Reads/writes must match discovery: refuse to reach under a directory the
    // scan skips — directly (`is_ignored_rel`) or via a symlinked ancestor,
    // which discovery never recurses into. Applies to every basename (an agent
    // doc named `node_modules/pkg/CLAUDE.md` is just as hidden as a `.md`); only
    // the curated `KNOWN_RELS` (e.g. `.claude/CLAUDE.md`) are exempt.
    if !KNOWN_RELS.contains(&rel.as_str())
        && (is_ignored_rel(&rel) || has_symlinked_ancestor(&project_root, &rel))
    {
        return Err(AgentDocError::InvalidPath {
            message: format!("Path is under an ignored or symlinked directory: {rel}"),
        }
        .to_string_payload());
    }
    let mut abs = resolve_in_project(&project_root, &rel).map_err(|e| e.to_string_payload())?;

    // Symlink guards: refuse to write if abs is an external symlink.
    if let Ok(smeta) = fs::symlink_metadata(&abs) {
        if smeta.file_type().is_symlink() {
            let resolved = abs.canonicalize().ok();
            let in_project = resolved
                .as_ref()
                .map(|p| p.starts_with(&project_root))
                .unwrap_or(false);
            if !in_project {
                let target = fs::read_link(&abs)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default();
                return Err(AgentDocError::ExternalSymlink { rel, target }.to_string_payload());
            }
            // Root-level CLAUDE.md symlinks are hub-derived pointers under the
            // canonical root policy; refuse to overwrite them with prose so the
            // UI redirects edits to AGENTS.md.
            if rel == "CLAUDE.md" {
                return Err(AgentDocError::DerivedPointer {
                    rel,
                    canonical_rel: "AGENTS.md".into(),
                }
                .to_string_payload());
            }
        }
    }

    // Refuse to overwrite a regular-file `@AGENTS.md` import pointer with
    // anything other than the pointer line itself.
    if rel == "CLAUDE.md" {
        if let Ok(existing) = fs::read_to_string(&abs) {
            if is_import_pointer_body(&existing) && !is_import_pointer_body(&content) {
                return Err(AgentDocError::DerivedPointer {
                    rel,
                    canonical_rel: "AGENTS.md".into(),
                }
                .to_string_payload());
            }
        }
    }

    // Canonical-by-construction (root docs, multi-harness): the root document
    // is written as a real AGENTS.md; if the user drafted it via the missing
    // CLAUDE.md surface, redirect the write target before the conflict check
    // so an existing AGENTS.md still conflicts safely. The content-conflict
    // check below always runs against the actual write target —
    // canonicalization never overrides it.
    let policy = resolve_policy_for_project(&project_root)?;
    let is_root_doc = rel == "CLAUDE.md" || rel == "AGENTS.md";
    let multi = policy.requires_claude && policy.requires_agent;
    let mut target_rel = rel.clone();
    if multi && is_root_doc && rel == "CLAUDE.md" && fs::symlink_metadata(&abs).is_err() {
        target_rel = "AGENTS.md".into();
        abs = resolve_in_project(&project_root, &target_rel).map_err(|e| e.to_string_payload())?;
    }

    // Conflict check unless overwrite explicitly true.
    let force = overwrite.unwrap_or(false);
    if !force {
        if let Ok(existing) = fs::read(&abs) {
            let current_hash = hash_bytes(&existing);
            let stale = match expected_hash.as_deref() {
                Some(h) => h != current_hash,
                None => true, // new-file save against an existing file is a conflict
            };
            if stale {
                let meta = fs::metadata(&abs).ok();
                return Err(AgentDocError::Conflict {
                    rel: target_rel.clone(),
                    current_hash,
                    current_size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    modified_at: meta.as_ref().and_then(mtime_secs),
                }
                .to_string_payload());
            }
        }
    }

    let mut written: Vec<AgentDocFileMeta> = Vec::new();
    let mut derived = false;

    // Marker-bearing Agent Docs are written by the Python snippet authority.
    // It rechecks the optimistic fingerprint while holding Hub's data lock,
    // then performs the backup-first atomic write. Marker-free Markdown keeps
    // the lightweight native path used by the editor's existing tests.
    let hub_wrote = is_allowed_agent_doc_rel(&target_rel)
        && content.contains("skill-tree:snippet");
    if hub_wrote {
        let expected = expected_hash.as_deref();
        let mut args = vec![
            "snippet",
            "reconcile-content",
            "--path",
            project_path.as_str(),
            "--file",
            target_rel.as_str(),
            "--json",
        ];
        if let Some(hash) = expected {
            args.push("--expected-hash");
            args.push(hash);
        }
        if force {
            args.push("--overwrite");
        }
        let result: Value = super::hub_json(&args, Some(&content))?;
        content = result
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| "hub snippet reconciliation returned no content".to_string())?
            .to_string();
    } else {
        atomic_write(&abs, &content).map_err(|e| e.to_string_payload())?;
    }
    written.push(meta_after_write(&target_rel, &abs, &project_root));

    // After a root AGENTS.md write in a multi-harness project, derive a
    // missing CLAUDE.md so the app's own writes never produce a layout the
    // banner would immediately flag. An existing real CLAUDE.md is never
    // touched here — that's a conflict state, owned by the fix/resolve flow.
    if multi && target_rel == "AGENTS.md" {
        let claude_abs = project_root.join("CLAUDE.md");
        if fs::symlink_metadata(&claude_abs).is_err() {
            write_derived_claude(&project_root, &policy.strategy)
                .map_err(|e| e.to_string_payload())?;
            written.push(meta_after_write("CLAUDE.md", &claude_abs, &project_root));
            derived = true;
        }
    }

    Ok(AgentDocWriteResult {
        written,
        derived,
        content,
        publish: None,
    })
}

// ─── Canonical root status / strategy / fix (hub.py bridge) ─────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDocRootStatus {
    pub project: String,
    pub state: String,        // "none" | "ok" | "needs_canonicalization" | "conflict"
    pub canonical: Option<String>,
    pub derived: Option<String>,
    pub strategy: String,     // "symlink" | "import"
    pub reason: String,
    /// Shared-model root verdict (see classify_dir / agent_docs.py).
    #[serde(default)]
    pub verdict: Option<String>,
    #[serde(default)]
    pub flags: Vec<String>,
    #[serde(default)]
    pub nested_deviations: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDocStrategyInfo {
    /// Always set: the resolved global value (default `symlink`).
    pub global: String,
    /// Project name when scoped to one project (else `None`).
    pub project: Option<String>,
    /// Per-project override, if any.
    #[serde(default)]
    pub override_value: Option<String>,
    /// Effective resolution for the project, when scoped.
    #[serde(default)]
    pub effective: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDocPublishInfo {
    pub project: String,
    pub enabled: bool,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentDocPublishResult {
    #[serde(default)]
    pub project: Option<String>,
    pub enabled: bool,
    pub attempted: bool,
    pub published: bool,
    pub committed: bool,
    #[serde(default)]
    pub sha: Option<String>,
    pub remote: String,
    pub branch: String,
    pub reason: String,
    pub message: String,
}

impl AgentDocPublishResult {
    fn bridge_error(message: String) -> Self {
        Self {
            project: None,
            enabled: true,
            attempted: true,
            published: false,
            committed: false,
            sha: None,
            remote: "origin".into(),
            branch: "main".into(),
            reason: "bridge_error".into(),
            message: format!("The file was saved locally, but publishing failed. {message}"),
        }
    }
}

#[tauri::command]
pub async fn agent_docs_publish_get(project_name: String) -> Result<AgentDocPublishInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::hub_json::<AgentDocPublishInfo, _, _>(
            &[
                "agent-docs",
                "publish-on-save",
                "--project",
                &project_name,
                "--json",
            ],
            None,
        )
    })
    .await
    .map_err(|e| format!("agent_docs_publish_get task failed: {e}"))?
}

#[tauri::command]
pub async fn agent_docs_publish_set(
    project_name: String,
    enabled: bool,
) -> Result<AgentDocPublishInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mode = if enabled { "--enable" } else { "--disable" };
        super::hub_json::<AgentDocPublishInfo, _, _>(
            &[
                "agent-docs",
                "publish-on-save",
                "--project",
                &project_name,
                mode,
                "--json",
            ],
            None,
        )
    })
    .await
    .map_err(|e| format!("agent_docs_publish_set task failed: {e}"))?
}

#[tauri::command]
pub async fn agent_docs_publish_now(
    project_path: String,
) -> Result<AgentDocPublishResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_docs_publish_now_impl(project_path, vec![], vec![])
    })
    .await
    .map_err(|e| format!("agent_docs_publish_now task failed: {e}"))?
}

fn agent_docs_publish_now_impl(
    project_path: String,
    files: Vec<String>,
    expected_hashes: Vec<(String, String)>,
) -> Result<AgentDocPublishResult, String> {
    let mut args = vec![
        "agent-docs".to_string(),
        "publish-now".to_string(),
        "--path".to_string(),
        project_path,
        "--json".to_string(),
    ];
    for file in files {
        args.push("--file".into());
        args.push(file);
    }
    for (file, hash) in expected_hashes {
        args.push("--expected-hash".into());
        args.push(format!("{file}={hash}"));
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    super::hub_json(&arg_refs, None)
}

#[tauri::command]
pub async fn agent_docs_root_status(project_path: String) -> Result<AgentDocRootStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_root_status_impl(project_path)
    })
        .await
        .map_err(|e| format!("agent_docs_root_status task failed: {e}"))?
}

fn agent_docs_root_status_impl(project_path: String) -> Result<AgentDocRootStatus, String> {
    super::hub_json::<AgentDocRootStatus, _, _>(
        &["agent-docs", "status", "--path", &project_path, "--json"],
        None,
    )
}

/// Get the current strategy. Pass `project_name` to include the per-project
/// override + effective resolution; otherwise returns the global value only.
#[tauri::command]
pub async fn agent_docs_strategy_get(
    project_name: Option<String>,
) -> Result<AgentDocStrategyInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_strategy_get_impl(project_name)
    })
        .await
        .map_err(|e| format!("agent_docs_strategy_get task failed: {e}"))?
}

fn agent_docs_strategy_get_impl(
    project_name: Option<String>,
) -> Result<AgentDocStrategyInfo, String> {
    let mut args: Vec<&str> = vec!["agent-docs", "strategy", "--get", "--json"];
    if let Some(ref name) = project_name {
        args.push("--project");
        args.push(name);
    }
    // The Python CLI emits `{global: ...}` for global scope and
    // `{project, override, global, effective}` for per-project scope; normalize
    // into `AgentDocStrategyInfo` (override field is named `override` in JSON).
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        global: Option<String>,
        #[serde(default)]
        project: Option<String>,
        #[serde(default, rename = "override")]
        override_value: Option<String>,
        #[serde(default)]
        effective: Option<String>,
    }
    let raw: Raw = super::hub_json(&args, None)?;
    Ok(AgentDocStrategyInfo {
        global: raw.global.unwrap_or_else(|| "symlink".into()),
        project: raw.project,
        override_value: raw.override_value,
        effective: raw.effective,
    })
}

/// Set the global strategy, or a per-project override when `project_name` is
/// set. When `clear` is true, drops the per-project override (requires project).
#[tauri::command]
pub async fn agent_docs_strategy_set(
    project_name: Option<String>,
    value: Option<String>,
    clear: Option<bool>,
) -> Result<AgentDocStrategyInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_strategy_set_impl(project_name, value, clear)
    })
    .await
    .map_err(|e| format!("agent_docs_strategy_set task failed: {e}"))?
}

fn agent_docs_strategy_set_impl(
    project_name: Option<String>,
    value: Option<String>,
    clear: Option<bool>,
) -> Result<AgentDocStrategyInfo, String> {
    let clear = clear.unwrap_or(false);
    let mut args: Vec<String> = vec!["agent-docs".into(), "strategy".into(), "--json".into()];
    if let Some(ref name) = project_name {
        args.push("--project".into());
        args.push(name.clone());
    }
    if clear {
        if project_name.is_none() {
            return Err("clear requires project_name".into());
        }
        args.push("--clear".into());
    } else {
        let value = value.ok_or_else(|| "value required when not clearing".to_string())?;
        if value != "symlink" && value != "import" {
            return Err(format!("invalid strategy '{value}'; expected 'symlink' or 'import'"));
        }
        args.push("--set".into());
        args.push(value);
    }
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        global: Option<String>,
        #[serde(default)]
        project: Option<String>,
        #[serde(default, rename = "override")]
        override_value: Option<String>,
        #[serde(default)]
        effective: Option<String>,
    }
    let raw: Raw = super::hub_json(&arg_refs, None)?;
    Ok(AgentDocStrategyInfo {
        global: raw.global.unwrap_or_else(|| "symlink".into()),
        project: raw.project,
        override_value: raw.override_value,
        effective: raw.effective,
    })
}

/// Build the transactional fix plan for one project (dry-run; never writes).
/// The plan JSON is passed through verbatim — `agent_docs_fix_apply` consumes
/// it unchanged so hub.py can re-verify its precondition fingerprints.
#[tauri::command]
pub async fn agent_docs_fix_plan(project_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_fix_plan_impl(project_path)
    })
        .await
        .map_err(|e| format!("agent_docs_fix_plan task failed: {e}"))?
}

fn agent_docs_fix_plan_impl(project_path: String) -> Result<Value, String> {
    super::hub_json(
        &["agent-docs", "fix", "--path", &project_path, "--json"],
        None,
    )
}

/// Apply a previously previewed fix plan (with the UI's opt-in selections).
/// hub.py re-verifies every step's precondition against disk and aborts the
/// whole apply (`applied: false`, `error: "disk_changed"`) on any mismatch.
/// `commit: true` opts into a scoped git commit of the touched files.
#[tauri::command]
pub async fn agent_docs_fix_apply(
    project_path: String,
    plan: Value,
    commit: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_fix_apply_impl(project_path, plan, commit)
    })
        .await
        .map_err(|e| format!("agent_docs_fix_apply task failed: {e}"))?
}

fn agent_docs_fix_apply_impl(
    project_path: String,
    plan: Value,
    commit: Option<bool>,
) -> Result<Value, String> {
    let mut args = vec![
        "agent-docs",
        "fix",
        "--path",
        &project_path,
        "--apply",
        "--plan-stdin",
        "--json",
    ];
    if commit.unwrap_or(false) {
        args.push("--commit");
    }
    super::hub_json(&args, Some(&plan.to_string()))
}

/// Explicit conflict/appendix resolution (`keep_agents` | `keep_claude` |
/// `absorb_appendix`) for one instruction directory. Never merges.
#[tauri::command]
pub async fn agent_docs_resolve(
    project_path: String,
    dir: String,
    op: String,
    commit: Option<bool>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        agent_docs_resolve_impl(project_path, dir, op, commit)
    })
        .await
        .map_err(|e| format!("agent_docs_resolve task failed: {e}"))?
}

fn agent_docs_resolve_impl(
    project_path: String,
    dir: String,
    op: String,
    commit: Option<bool>,
) -> Result<Value, String> {
    let mut args = vec![
        "agent-docs",
        "resolve",
        "--path",
        &project_path,
        "--dir",
        &dir,
        "--op",
        &op,
        "--json",
    ];
    if commit.unwrap_or(false) {
        args.push("--commit");
    }
    super::hub_json(&args, None)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests;
