//! Agent Docs commands — read, write, and list the project-local instruction
//! files (`CLAUDE.md`, `AGENT.md`, and nested variants) that coding agents
//! consume.
//!
//! Disk is the source of truth. Path confinement is enforced server-side; the
//! frontend never names absolute paths.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{code_home, data_home, harnesses, hub_py};
use super::hub::resolved_python;

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
pub const ALLOWED_BASENAMES: &[&str] = &["CLAUDE.md", "AGENTS.md", "AGENT.md"];

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

pub const MAX_DEPTH: usize = 8;
pub const MAX_FILES: usize = 500;
pub const MAX_EDITOR_BYTES: u64 = 1024 * 1024; // 1 MiB

// ─── DTOs ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
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
    pub truncated: bool,
    pub warning: Option<String>,
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
}

/// Effective canonical-root policy for a project, resolved from the registry
/// (effective harnesses) and the root-derivation strategy setting.
#[derive(Debug, Clone, Serialize)]
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

fn normalize_rel(rel: &str) -> Result<String, AgentDocError> {
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

fn canonicalize_project_root(project_path: &str) -> Result<PathBuf, AgentDocError> {
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
fn resolve_in_project(project_root: &Path, rel: &str) -> Result<PathBuf, AgentDocError> {
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

fn hash_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    hex_encode(&digest[..16])
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(*b >> 4) as usize] as char);
        out.push(HEX[(*b & 0x0f) as usize] as char);
    }
    out
}

fn mtime_secs(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
}

/// Stat-and-fingerprint a file at `abs_path`, returning its metadata in the
/// frontend shape. Reads the file to hash it; for the listing path we accept
/// the cost since these files are small (Agent Docs limit is 1 MiB).
fn build_file_meta(
    rel: &str,
    abs_path: &Path,
    project_root: &Path,
    is_known: bool,
    is_discovered: bool,
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
        };
    }

    // Follow the link (or stat directly).
    let resolved_meta = fs::metadata(abs_path);
    match resolved_meta {
        Ok(meta) if meta.is_file() => {
            let bytes = fs::read(abs_path).ok();
            let (hash, size) = match bytes {
                Some(b) => {
                    let h = hash_bytes(&b);
                    let size = b.len() as u64;
                    (Some(h), size)
                }
                None => (None, meta.len()),
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
        },
    }
}

/// Walk the project root looking for nested `CLAUDE.md` / `AGENT.md` files.
/// Bounded by depth and file count; returns the set of discovered rels plus a
/// truncation flag.
fn discover_nested(project_root: &Path, already: &HashSet<String>) -> (Vec<String>, bool) {
    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;
    let ignored_dir_names: HashSet<&str> = IGNORED_DIR_NAMES.iter().copied().collect();
    // (dir_path, depth, rel_so_far)
    let mut stack: Vec<(PathBuf, usize, String)> =
        vec![(project_root.to_path_buf(), 0, String::new())];

    while let Some((dir, depth, rel_prefix)) = stack.pop() {
        if depth > MAX_DEPTH {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().into_owned();
            let new_rel = if rel_prefix.is_empty() {
                name_str.clone()
            } else {
                format!("{rel_prefix}/{name_str}")
            };
            let file_type = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if file_type.is_dir() {
                if ignored_dir_names.contains(name_str.as_str()) {
                    continue;
                }
                if IGNORED_NESTED_PATHS.iter().any(|p| *p == new_rel) {
                    continue;
                }
                if depth < MAX_DEPTH {
                    stack.push((entry.path(), depth + 1, new_rel));
                }
            } else if (file_type.is_file() || file_type.is_symlink())
                && ALLOWED_BASENAMES.contains(&name_str.as_str())
            {
                if already.contains(&new_rel) {
                    continue;
                }
                if out.len() >= MAX_FILES {
                    truncated = true;
                    return (out, truncated);
                }
                out.push(new_rel);
            }
        }
    }

    (out, truncated)
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
pub fn resolve_policy_for_project(project_root: &Path) -> CanonicalPolicy {
    #[cfg(test)]
    {
        let _ = project_root;
        return TEST_POLICY.with(|t| t.borrow().clone()).unwrap_or(CanonicalPolicy {
            requires_claude: true,
            requires_agent: false,
            strategy: "symlink".into(),
            claude_harnesses: vec!["claude-code".into()],
            agent_harnesses: Vec::new(),
        });
    }
    #[cfg(not(test))]
    {
        resolve_policy_from_registry(project_root)
    }
}

#[cfg_attr(test, allow(dead_code))]
fn resolve_policy_from_registry(project_root: &Path) -> CanonicalPolicy {
    let mut policy = CanonicalPolicy {
        requires_claude: false,
        requires_agent: false,
        strategy: "symlink".into(),
        claude_harnesses: Vec::new(),
        agent_harnesses: Vec::new(),
    };
    let installed: HashSet<String> = harnesses::detected_installed().into_iter().collect();
    let Ok(home) = data_home() else {
        return policy;
    };
    let Ok(content) = fs::read_to_string(home.join("registry.yaml")) else {
        return policy;
    };
    let Ok(yaml) = serde_yaml::from_str::<Value>(&content) else {
        return policy;
    };
    let valid = |s: &str| s == "symlink" || s == "import";
    if let Some(s) = yaml
        .get("agent_docs")
        .and_then(|v| v.get("root_strategy"))
        .and_then(|v| v.as_str())
    {
        if valid(s) {
            policy.strategy = s.to_string();
        }
    }
    let mut ids: HashSet<String> = HashSet::new();
    if let Some(arr) = yaml.get("harnesses_global").and_then(|v| v.as_array()) {
        ids.extend(arr.iter().filter_map(|v| v.as_str().map(String::from)));
    }
    let project_path = project_root.to_string_lossy();
    if let Some(projects) = yaml.get("projects").and_then(|v| v.as_object()) {
        for (_name, cfg) in projects {
            let matches_path = cfg.get("path").and_then(|v| v.as_str()).is_some_and(|p| {
                PathBuf::from(p).canonicalize().ok().as_deref() == Some(project_root)
                    || p == project_path
            });
            if matches_path {
                if let Some(arr) = cfg.get("harnesses").and_then(|v| v.as_array()) {
                    ids.extend(arr.iter().filter_map(|v| v.as_str().map(String::from)));
                }
                if let Some(s) = cfg
                    .get("agent_docs")
                    .and_then(|v| v.get("root_strategy"))
                    .and_then(|v| v.as_str())
                {
                    if valid(s) {
                        policy.strategy = s.to_string();
                    }
                }
            }
        }
    }
    for id in ids.into_iter().filter(|id| installed.contains(id)) {
        if id == "claude-code" {
            policy.requires_claude = true;
            policy.claude_harnesses.push(id);
        } else {
            policy.requires_agent = true;
            policy.agent_harnesses.push(id);
        }
    }
    policy.claude_harnesses.sort();
    policy.agent_harnesses.sort();
    policy
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
pub async fn list_agent_docs(project_path: String) -> Result<AgentDocsListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        list_agent_docs_impl(project_path)
    })
    .await
    .map_err(|e| format!("list_agent_docs task failed: {e}"))?
}

fn list_agent_docs_impl(project_path: String) -> Result<AgentDocsListing, String> {
    let canonical = canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;

    let known: Vec<String> = KNOWN_RELS.iter().map(|s| s.to_string()).collect();
    let mut all_set: HashSet<String> = known.iter().cloned().collect();

    // Discover nested files.
    let (discovered, truncated) = discover_nested(&canonical, &all_set);
    for rel in &discovered {
        all_set.insert(rel.clone());
    }

    // Build file metas.
    let mut all_rels: Vec<String> = all_set.iter().cloned().collect();
    all_rels.sort();

    let mut root = AgentDocFolder {
        name: String::new(),
        path: String::new(),
        dirs: Vec::new(),
        files: Vec::new(),
    };
    let mut metas: Vec<AgentDocFileMeta> = Vec::new();
    for rel in &all_rels {
        let abs = canonical.join(rel);
        let is_known = KNOWN_RELS.contains(&rel.as_str());
        let is_discovered = !is_known;
        let meta = build_file_meta(rel, &abs, &canonical, is_known, is_discovered);
        metas.push(meta.clone());
        insert_file_into_tree(&mut root, meta);
    }
    let policy = resolve_policy_for_project(&canonical);
    let (instruction_sets, required_formats) =
        build_instruction_sets(&canonical, &metas, &policy);

    let warning = if truncated {
        Some(format!("Discovery truncated at {} files", MAX_FILES))
    } else {
        None
    };

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
        truncated,
        warning,
    })
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
    if !is_allowed_agent_doc_rel(&rel) {
        return Err(AgentDocError::NotAllowedBasename { rel }.to_string_payload());
    }
    let project_root =
        canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;
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

fn meta_after_write(rel: &str, abs: &Path, project_root: &Path) -> AgentDocFileMeta {
    build_file_meta(
        rel,
        abs,
        project_root,
        KNOWN_RELS.contains(&rel),
        !KNOWN_RELS.contains(&rel),
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
) -> Result<AgentDocWriteResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = AGENT_DOCS_LOCK.lock().unwrap();
        write_agent_doc_impl(project_path, relative_path, content, expected_hash, overwrite)
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
    let rel = normalize_rel(&relative_path).map_err(|e| e.to_string_payload())?;
    if !is_allowed_agent_doc_rel(&rel) {
        return Err(AgentDocError::NotAllowedBasename { rel }.to_string_payload());
    }
    let project_root =
        canonicalize_project_root(&project_path).map_err(|e| e.to_string_payload())?;
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
    let policy = resolve_policy_for_project(&project_root);
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

    atomic_write(&abs, &content).map_err(|e| e.to_string_payload())?;
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

    Ok(AgentDocWriteResult { written, derived })
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

/// Spawn `hub.py` with the given args (and optional stdin body) and parse
/// stdout as JSON of `T`.
pub(crate) fn run_hub_json_stdin<T: for<'de> Deserialize<'de>>(
    args: &[&str],
    stdin_body: Option<&str>,
) -> Result<T, String> {
    let python = resolved_python()
        .ok_or_else(|| "Python not found. Install Python 3 and ensure it is in PATH.".to_string())?;
    let code = code_home()?;
    let data = data_home()?;
    let hub = hub_py()?;
    let mut cmd = std::process::Command::new(python);
    cmd.arg(&hub)
        .args(args)
        .current_dir(&code)
        .env("SKILL_HUB_HOME", data.as_os_str())
        .env("SKILL_HUB_CODE", code.as_os_str())
        .env_remove("SKILL_HUB_DIR");
    let output = if let Some(body) = stdin_body {
        use std::process::Stdio;
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("Failed to run hub.py: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(body.as_bytes())
                .map_err(|e| format!("Failed to pipe plan to hub.py: {e}"))?;
        }
        child
            .wait_with_output()
            .map_err(|e| format!("Failed to run hub.py: {e}"))?
    } else {
        cmd.output().map_err(|e| format!("Failed to run hub.py: {e}"))?
    };
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        return Err(format!(
            "hub.py exited {}: {}{}",
            output.status.code().unwrap_or(-1),
            stderr,
            stdout
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<T>(stdout.trim()).map_err(|e| {
        format!(
            "Failed to parse hub.py JSON output: {e}\n--- stdout ---\n{stdout}"
        )
    })
}

/// Spawn `hub.py` with the given args and parse stdout as JSON of `T`.
pub(crate) fn run_hub_json<T: for<'de> Deserialize<'de>>(args: &[&str]) -> Result<T, String> {
    run_hub_json_stdin(args, None)
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
    run_hub_json::<AgentDocRootStatus>(&[
        "agent-docs",
        "status",
        "--path",
        &project_path,
        "--json",
    ])
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
    let raw: Raw = run_hub_json(&args)?;
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
    let raw: Raw = run_hub_json(&arg_refs)?;
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
    run_hub_json(&["agent-docs", "fix", "--path", &project_path, "--json"])
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
    run_hub_json_stdin(&args, Some(&plan.to_string()))
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
    run_hub_json(&args)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;
    use tempfile::TempDir;

    fn setup_project() -> TempDir {
        TempDir::new().expect("tempdir")
    }

    fn project_str(td: &TempDir) -> String {
        td.path()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    fn multi_policy(strategy: &str) -> CanonicalPolicy {
        CanonicalPolicy {
            requires_claude: true,
            requires_agent: true,
            strategy: strategy.into(),
            claude_harnesses: vec!["claude-code".into()],
            agent_harnesses: vec!["codex".into()],
        }
    }

    fn with_policy<R>(policy: CanonicalPolicy, f: impl FnOnce() -> R) -> R {
        TEST_POLICY.with(|t| *t.borrow_mut() = Some(policy));
        let out = f();
        TEST_POLICY.with(|t| *t.borrow_mut() = None);
        out
    }

    // ── Shared corpus: the one status model, pinned against agent_docs.py ──

    #[test]
    fn corpus_verdicts_match_shared_definition() {
        let corpus_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/agent_docs_corpus.json"
        );
        let raw = fs::read_to_string(corpus_path).expect("read corpus");
        let doc: Value = serde_json::from_str(&raw).expect("parse corpus");
        let cases = doc["cases"].as_array().expect("cases");
        assert!(!cases.is_empty());
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let td = TempDir::new().unwrap();
            let root = td.path().join("proj");
            fs::create_dir_all(&root).unwrap();
            let outside = td.path().join("outside");
            for f in case["files"].as_array().unwrap() {
                let rel = f["path"].as_str().unwrap();
                let p = root.join(rel);
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                if f["kind"].as_str().unwrap() == "file" {
                    fs::write(&p, f["content"].as_str().unwrap()).unwrap();
                } else {
                    let mut target = f["target"].as_str().unwrap().to_string();
                    if let Some(ext_rel) = target.strip_prefix("__outside__/") {
                        let ext = outside.join(ext_rel);
                        fs::create_dir_all(ext.parent().unwrap()).unwrap();
                        fs::write(&ext, "# outside\n").unwrap();
                        target = ext.to_string_lossy().into_owned();
                    }
                    symlink(&target, &p).unwrap();
                }
            }
            let policy = CanonicalPolicy {
                requires_claude: case["requires_claude"].as_bool().unwrap(),
                requires_agent: case["requires_agent"].as_bool().unwrap(),
                strategy: case["strategy"].as_str().unwrap().into(),
                claude_harnesses: Vec::new(),
                agent_harnesses: Vec::new(),
            };
            for (rel, expected) in case["expect"].as_object().unwrap() {
                let dir = if rel.is_empty() {
                    root.clone()
                } else {
                    root.join(rel)
                };
                let dv = classify_dir(&dir, &root, rel.is_empty(), &policy);
                assert_eq!(
                    dv.verdict,
                    expected["verdict"].as_str().unwrap(),
                    "{name}:{} verdict",
                    if rel.is_empty() { "root" } else { rel }
                );
                let mut got = dv.flags.clone();
                got.sort();
                let mut want: Vec<String> = expected["flags"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v.as_str().unwrap().to_string())
                    .collect();
                want.sort();
                assert_eq!(got, want, "{name}:{} flags", if rel.is_empty() { "root" } else { rel });
            }
        }
    }

    #[test]
    fn pointer_plus_extracts_appendix() {
        let td = setup_project();
        let root = td.path().canonicalize().unwrap();
        fs::write(root.join("AGENTS.md"), "# A\n").unwrap();
        fs::write(
            root.join("CLAUDE.md"),
            "@AGENTS.md\n\n- remember: run tests first\n",
        )
        .unwrap();
        let dv = classify_dir(&root, &root, true, &multi_policy("import"));
        assert_eq!(dv.verdict, "pointer_plus_content");
        assert_eq!(dv.appendix.as_deref(), Some("- remember: run tests first\n"));
    }

    // ── Discovery + listing ──

    #[test]
    fn known_paths_always_included() {
        let td = setup_project();
        let listing = list_agent_docs_impl(project_str(&td)).expect("list");
        for rel in KNOWN_RELS {
            assert!(listing.all_rels.iter().any(|r| r == rel), "missing {rel}");
        }
    }

    #[test]
    fn nested_discovery_finds_files() {
        let td = setup_project();
        let core = td.path().join("core").join("canvas");
        fs::create_dir_all(&core).unwrap();
        fs::write(core.join("CLAUDE.md"), "# nested").unwrap();
        let listing = list_agent_docs_impl(project_str(&td)).expect("list");
        assert!(listing
            .all_rels
            .iter()
            .any(|r| r == "core/canvas/CLAUDE.md"));
    }

    #[test]
    fn ignored_dirs_skipped() {
        let td = setup_project();
        for d in &["node_modules", "target", ".git"] {
            let sub = td.path().join(d);
            fs::create_dir_all(&sub).unwrap();
            fs::write(sub.join("CLAUDE.md"), "# hidden").unwrap();
        }
        let listing = list_agent_docs_impl(project_str(&td)).expect("list");
        for d in &["node_modules", "target", ".git"] {
            let rel = format!("{d}/CLAUDE.md");
            assert!(
                !listing.all_rels.contains(&rel),
                "should skip ignored dir {d}"
            );
        }
    }

    #[test]
    fn skills_subdirs_skipped() {
        let td = setup_project();
        let p = td.path().join(".claude").join("skills").join("foo");
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("CLAUDE.md"), "# in skills").unwrap();
        let listing = list_agent_docs_impl(project_str(&td)).expect("list");
        assert!(!listing
            .all_rels
            .iter()
            .any(|r| r == ".claude/skills/foo/CLAUDE.md"));
    }

    #[test]
    fn missing_known_file_metadata() {
        let td = setup_project();
        let listing = list_agent_docs_impl(project_str(&td)).expect("list");
        let claude = listing
            .root
            .files
            .iter()
            .find(|f| f.rel == "CLAUDE.md")
            .expect("CLAUDE.md row");
        assert!(!claude.exists);
        assert!(claude.is_known);
        assert!(claude.size.is_none());
    }

    // ── Instruction sets: verdicts in the listing ──

    #[test]
    fn instruction_sets_group_same_directory_and_extract_title() {
        let td = setup_project();
        let dir = td.path().join("presentation").join("board");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("AGENTS.md"), "# Board Instructions\nbody").unwrap();
        symlink("AGENTS.md", dir.join("CLAUDE.md")).unwrap();

        let listing = with_policy(multi_policy("symlink"), || {
            list_agent_docs_impl(project_str(&td)).expect("list")
        });
        let set = listing
            .instruction_sets
            .iter()
            .find(|s| s.relative_dir == "presentation/board")
            .expect("set");
        assert_eq!(set.label, "Board Instructions");
        assert_eq!(set.label_source, "heading:AGENT");
        assert_eq!(set.verdict, "canonical");
        assert!(set.flags.is_empty());
    }

    #[test]
    fn legacy_agent_md_never_satisfies_and_is_flagged() {
        let td = setup_project();
        fs::write(td.path().join("CLAUDE.md"), "# C\n").unwrap();
        symlink("CLAUDE.md", td.path().join("AGENT.md")).unwrap();

        let listing = with_policy(multi_policy("symlink"), || {
            list_agent_docs_impl(project_str(&td)).expect("list")
        });
        let set = listing
            .instruction_sets
            .iter()
            .find(|s| s.relative_dir.is_empty())
            .expect("root set");
        assert_eq!(set.verdict, "claude_only");
        assert!(set.flags.iter().any(|f| f == "legacy"));
        // The AGENT format record is NOT satisfied by the legacy file.
        let agent = set.formats.get(&AgentDocFormatKind::AGENT).unwrap();
        assert!(!agent.exists);
        // The legacy artifact is exposed separately.
        assert_eq!(set.legacy.len(), 1);
        assert_eq!(set.legacy[0].name, "AGENT.md");
    }

    #[test]
    fn legacy_composes_with_canonical_layout() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "# A\n").unwrap();
        symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
        symlink("CLAUDE.md", td.path().join("AGENT.md")).unwrap();

        let listing = with_policy(multi_policy("symlink"), || {
            list_agent_docs_impl(project_str(&td)).expect("list")
        });
        let set = listing
            .instruction_sets
            .iter()
            .find(|s| s.relative_dir.is_empty())
            .expect("root set");
        assert_eq!(set.verdict, "canonical");
        assert!(set.flags.iter().any(|f| f == "legacy"));
    }

    #[test]
    fn broken_and_external_links_are_flagged() {
        let td = setup_project();
        let broken = td.path().join("broken");
        fs::create_dir_all(&broken).unwrap();
        symlink("missing.md", broken.join("AGENT.md")).unwrap();

        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("AGENTS.md"), "# Outside\n").unwrap();
        let external = td.path().join("external");
        fs::create_dir_all(&external).unwrap();
        symlink(
            outside.path().join("AGENTS.md"),
            external.join("AGENTS.md"),
        )
        .unwrap();

        let listing = with_policy(multi_policy("symlink"), || {
            list_agent_docs_impl(project_str(&td)).expect("list")
        });
        let broken_set = listing
            .instruction_sets
            .iter()
            .find(|s| s.relative_dir == "broken")
            .expect("broken set");
        assert!(broken_set.flags.iter().any(|f| f == "broken_link"));
        assert!(broken_set.flags.iter().any(|f| f == "legacy"));
        let external_set = listing
            .instruction_sets
            .iter()
            .find(|s| s.relative_dir == "external")
            .expect("external set");
        assert!(external_set.flags.iter().any(|f| f == "external_link"));
        assert_eq!(external_set.verdict, "canonical");
    }

    #[test]
    fn listing_carries_policy_summary() {
        let td = setup_project();
        let listing = with_policy(multi_policy("import"), || {
            list_agent_docs_impl(project_str(&td)).expect("list")
        });
        assert!(listing.policy.requires_claude);
        assert!(listing.policy.requires_agent);
        assert_eq!(listing.policy.strategy, "import");
        assert_eq!(listing.policy.canonical.as_deref(), Some("AGENTS.md"));
        assert_eq!(listing.policy.derived.as_deref(), Some("CLAUDE.md"));
    }

    // ── Path confinement ──

    #[test]
    fn rejects_traversal() {
        let td = setup_project();
        let err = read_agent_doc_impl(project_str(&td), "../CLAUDE.md".into())
            .err()
            .expect("should reject traversal");
        assert!(
            err.contains("invalid_path") || err.contains("Invalid path"),
            "{err}"
        );
    }

    #[test]
    fn rejects_absolute() {
        let td = setup_project();
        let err = read_agent_doc_impl(project_str(&td), "/etc/passwd".into())
            .err()
            .expect("should reject absolute");
        assert!(
            err.contains("invalid_path") || err.contains("Absolute"),
            "{err}"
        );
    }

    #[test]
    fn rejects_non_agent_doc_basename() {
        let td = setup_project();
        fs::write(td.path().join("README.md"), "# readme").unwrap();
        let err = write_agent_doc_impl(
            project_str(&td),
            "notes/README.md".into(),
            "hi".into(),
            None,
            None,
        )
        .err()
        .expect("should reject non-agent-doc basename");
        assert!(err.contains("not_allowed_basename"), "{err}");
    }

    // ── Read / write ──

    #[test]
    fn write_then_read_roundtrip() {
        let td = setup_project();
        let res = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "# hello\n".into(),
            None,
            None,
        )
        .expect("write");
        assert_eq!(res.written.len(), 1);
        assert!(!res.derived);

        let read = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
        assert_eq!(read.content, "# hello\n");
        assert_eq!(res.written[0].hash.as_deref(), Some(read.hash.as_str()));
    }

    #[test]
    fn write_conflict_when_disk_changed() {
        let td = setup_project();
        fs::write(td.path().join("CLAUDE.md"), "original").unwrap();
        let read = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
        fs::write(td.path().join("CLAUDE.md"), "external changed").unwrap();
        let err = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "user edits".into(),
            Some(read.hash.clone()),
            Some(false),
        )
        .err()
        .expect("should conflict");
        assert!(err.contains("conflict"), "{err}");
    }

    #[test]
    fn write_overwrite_after_conflict() {
        let td = setup_project();
        fs::write(td.path().join("CLAUDE.md"), "original").unwrap();
        let res = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "user edits".into(),
            None,
            Some(true),
        )
        .expect("overwrite");
        assert_eq!(res.written.len(), 1);
        let content = fs::read_to_string(td.path().join("CLAUDE.md")).unwrap();
        assert_eq!(content, "user edits");
    }

    // ── Canonical-by-construction root writes ──

    #[test]
    fn create_root_doc_in_multi_harness_project_writes_canonical_pair() {
        let td = setup_project();
        let res = with_policy(multi_policy("symlink"), || {
            write_agent_doc_impl(
                project_str(&td),
                "CLAUDE.md".into(),
                "# Root doc\n".into(),
                None,
                None,
            )
            .expect("canonical create")
        });
        assert!(res.derived);
        assert_eq!(res.written.len(), 2);
        assert_eq!(
            fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
            "# Root doc\n"
        );
        let claude = td.path().join("CLAUDE.md");
        assert!(claude.is_symlink());
        assert_eq!(
            fs::read_link(&claude).unwrap().to_string_lossy(),
            "AGENTS.md"
        );
    }

    #[test]
    fn create_root_doc_import_strategy_writes_pointer() {
        let td = setup_project();
        let res = with_policy(multi_policy("import"), || {
            write_agent_doc_impl(
                project_str(&td),
                "AGENTS.md".into(),
                "# Root doc\n".into(),
                None,
                None,
            )
            .expect("canonical create")
        });
        assert!(res.derived);
        assert_eq!(
            fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
    }

    #[test]
    fn canonicalizing_create_still_conflicts_against_existing_agents_md() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "existing real root\n").unwrap();
        let err = with_policy(multi_policy("symlink"), || {
            write_agent_doc_impl(
                project_str(&td),
                "CLAUDE.md".into(),
                "draft\n".into(),
                None,
                None,
            )
            .err()
            .expect("must conflict, not clobber AGENTS.md")
        });
        assert!(err.contains("conflict"), "{err}");
        assert_eq!(
            fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
            "existing real root\n"
        );
    }

    #[test]
    fn saving_agents_md_never_touches_existing_real_claude_md() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "a\n").unwrap();
        fs::write(td.path().join("CLAUDE.md"), "user prose\n").unwrap();
        let read = read_agent_doc_impl(project_str(&td), "AGENTS.md".into()).expect("read");
        let res = with_policy(multi_policy("symlink"), || {
            write_agent_doc_impl(
                project_str(&td),
                "AGENTS.md".into(),
                "a v2\n".into(),
                Some(read.hash),
                None,
            )
            .expect("save")
        });
        assert!(!res.derived);
        assert_eq!(
            fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
            "user prose\n"
        );
    }

    // ── Derived-pointer handling ──

    #[test]
    fn read_marks_symlinked_claude_as_derived_pointer() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
        symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
        let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
        assert!(res.is_derived_pointer);
        assert!(res.is_symlink);
    }

    #[test]
    fn read_marks_import_pointer_claude_as_derived_pointer() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
        fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
        assert!(res.is_derived_pointer);
        assert!(!res.is_symlink);
    }

    #[test]
    fn read_user_authored_claude_is_not_derived_pointer() {
        let td = setup_project();
        fs::write(td.path().join("CLAUDE.md"), "# Project\nReal prose.\n").unwrap();
        let res = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into()).expect("read");
        assert!(!res.is_derived_pointer);
    }

    #[test]
    fn nested_claude_with_pointer_body_is_not_treated_as_root_derived() {
        let td = setup_project();
        let dir = td.path().join("feature");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        let res = read_agent_doc_impl(project_str(&td), "feature/CLAUDE.md".into()).expect("read");
        assert!(!res.is_derived_pointer);
    }

    #[test]
    fn write_refuses_to_overwrite_derived_symlink_claude_with_prose() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
        symlink("AGENTS.md", td.path().join("CLAUDE.md")).unwrap();
        let err = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "rogue edit\n".into(),
            None,
            Some(true),
        )
        .err()
        .expect("derived-pointer write should be rejected");
        assert!(err.contains("derived_pointer"), "{err}");
        assert_eq!(
            fs::read_to_string(td.path().join("AGENTS.md")).unwrap(),
            "shared\n"
        );
    }

    #[test]
    fn write_refuses_to_overwrite_import_pointer_claude_with_prose() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
        fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        let err = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "real prose\n".into(),
            None,
            Some(true),
        )
        .err()
        .expect("derived-pointer write should be rejected");
        assert!(err.contains("derived_pointer"), "{err}");
        assert_eq!(
            fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
            "@AGENTS.md\n"
        );
    }

    #[test]
    fn write_idempotent_pointer_to_pointer_is_allowed() {
        let td = setup_project();
        fs::write(td.path().join("AGENTS.md"), "shared\n").unwrap();
        fs::write(td.path().join("CLAUDE.md"), "@AGENTS.md\n").unwrap();
        let prior = fs::read_to_string(td.path().join("CLAUDE.md")).unwrap();
        let res = write_agent_doc_impl(
            project_str(&td),
            "CLAUDE.md".into(),
            "@AGENTS.md\n".into(),
            None,
            Some(true),
        )
        .expect("pointer-to-pointer should be allowed");
        assert!(!res.written.is_empty());
        assert_eq!(
            fs::read_to_string(td.path().join("CLAUDE.md")).unwrap(),
            prior
        );
    }

    // ── Editor limits ──

    #[test]
    fn oversized_read_returns_error() {
        let td = setup_project();
        let big = vec![b'x'; (MAX_EDITOR_BYTES + 100) as usize];
        fs::write(td.path().join("CLAUDE.md"), &big).unwrap();
        let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
            .err()
            .expect("should reject oversized");
        assert!(err.contains("oversized"), "{err}");
    }

    #[test]
    fn non_utf8_returns_error() {
        let td = setup_project();
        fs::write(td.path().join("CLAUDE.md"), [0xFF, 0xFE, 0xFD]).unwrap();
        let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
            .err()
            .expect("should reject non-utf8");
        assert!(err.contains("not_utf8"), "{err}");
    }

    #[test]
    fn external_symlink_marked_non_editable() {
        let td = setup_project();
        let outside = TempDir::new().unwrap();
        fs::write(outside.path().join("CLAUDE.md"), "# outside\n").unwrap();
        symlink(
            outside.path().join("CLAUDE.md"),
            td.path().join("CLAUDE.md"),
        )
        .unwrap();
        let err = read_agent_doc_impl(project_str(&td), "CLAUDE.md".into())
            .err()
            .expect("external symlink read should error");
        assert!(err.contains("external_symlink"), "{err}");
    }
}
