//! Bounded, read-only Codex title and lineage metadata.
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;

const MAX_LINE: usize = 1024 * 1024;

#[derive(Debug, Default, Clone)]
pub(crate) struct CodexMetadata {
    pub own_id: Option<String>,
    pub explicit_name: Option<String>,
    pub parent_id: Option<String>,
    pub role: Option<String>,
    pub nickname: Option<String>,
    pub path: Option<String>,
}

fn value(v: &Value, paths: &[&str]) -> Option<String> {
    paths.iter().find_map(|p| {
        v.pointer(p)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .filter(|s| !s.trim().is_empty())
    })
}

fn next_bounded<R: BufRead>(reader: &mut R, buf: &mut Vec<u8>) -> std::io::Result<Option<bool>> {
    buf.clear();
    let mut oversized = false;
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(if buf.is_empty() {
                None
            } else {
                Some(!oversized)
            });
        }
        let end = chunk
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(chunk.len());
        if !oversized {
            let room = MAX_LINE.saturating_sub(buf.len());
            if end > room {
                buf.extend_from_slice(&chunk[..room]);
                oversized = true;
            } else {
                buf.extend_from_slice(&chunk[..end]);
            }
        }
        let done = end < chunk.len() || chunk[end - 1] == b'\n';
        reader.consume(end);
        if done {
            return Ok(Some(!oversized));
        }
    }
}

pub(crate) fn read_transcript(path: &Path) -> CodexMetadata {
    let mut out = CodexMetadata::default();
    let Ok(file) = File::open(path) else {
        return out;
    };
    let mut reader = BufReader::new(file);
    let mut line = Vec::new();
    for _ in 0..4096 {
        let Some(valid) = next_bounded(&mut reader, &mut line).unwrap_or(None) else {
            break;
        };
        if !valid {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&line) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let payload = v.get("payload").unwrap_or(&v);
        out.own_id = value(payload, &["/id", "/session_id", "/sessionId"])
            .or_else(|| value(&v, &["/id", "/session_id", "/sessionId"]));
        out.explicit_name = value(payload, &["/name", "/thread_name", "/threadName"]);
        out.parent_id = value(
            &v,
            &[
                "/parent_thread_id",
                "/payload/parent_thread_id",
                "/payload/parentThreadId",
                "/source/subagent/thread_spawn/parent_thread_id",
                "/payload/source/subagent/thread_spawn/parent_thread_id",
            ],
        );
        let source = payload.get("source").or_else(|| v.get("source"));
        out.role = value(payload, &["/agent_role", "/agentRole", "/role"]);
        out.nickname = value(payload, &["/agent_nickname", "/agentNickname", "/nickname"]);
        out.path = value(payload, &["/agent_path", "/agentPath"]);
        if let Some(source) = source {
            let spawn = source.pointer("/subagent/thread_spawn");
            if let Some(role) = value(source, &["/subagent/role", "/subagent/agent_role", "/role"])
                .or_else(|| spawn.and_then(|s| value(s, &["/agent_role", "/role"])))
            {
                out.role = Some(role);
            }
            if let Some(nickname) = value(
                source,
                &[
                    "/subagent/nickname",
                    "/subagent/agent_nickname",
                    "/nickname",
                ],
            )
            .or_else(|| spawn.and_then(|s| value(s, &["/agent_nickname", "/nickname"])))
            {
                out.nickname = Some(nickname);
            }
            if let Some(path) = value(
                source,
                &["/subagent/agent_path", "/subagent/path", "/agent_path"],
            )
            .or_else(|| spawn.and_then(|s| value(s, &["/agent_path", "/path"])))
            {
                out.path = Some(path);
            }
        }
        break;
    }
    out
}

pub(crate) struct Lookup {
    index: HashMap<String, String>,
    db: HashMap<String, (Option<String>, Option<String>)>,
    client_titles: HashMap<String, String>,
}
impl Lookup {
    pub(crate) fn new(home: &Path, requested: &std::collections::HashSet<String>) -> Self {
        let mut index = HashMap::new();
        if let Ok(file) = File::open(home.join("session_index.jsonl")) {
            let mut reader = BufReader::new(file);
            let mut line = Vec::new();
            loop {
                let Some(valid) = next_bounded(&mut reader, &mut line).unwrap_or(None) else {
                    break;
                };
                if !valid {
                    continue;
                }
                let Ok(line) = std::str::from_utf8(&line) else {
                    continue;
                };
                let Ok(v) = serde_json::from_str::<Value>(line) else {
                    continue;
                };
                let Some(id) = value(&v, &["/id", "/session_id", "/sessionId"]) else {
                    continue;
                };
                if requested.contains(&id) {
                    if let Some(name) = value(&v, &["/thread_name", "/threadName"]) {
                        index.insert(id, name);
                    }
                }
            }
        }
        Self {
            index,
            db: load_db(home, requested),
            client_titles: load_client_titles(home, requested),
        }
    }
    pub(crate) fn enrich(&self, m: &mut CodexMetadata) {
        let Some(id) = m.own_id.as_deref() else {
            return;
        };
        if m.explicit_name.is_none() {
            m.explicit_name = self
                .db
                .get(id)
                .and_then(|(name, _)| name.clone())
                .or_else(|| self.index.get(id).cloned())
                .or_else(|| self.client_titles.get(id).cloned())
                .or_else(|| self.db.get(id).and_then(|(_, title)| title.clone()));
        }
    }
}

/// T3 owns its display titles separately from Codex's first-prompt fallback.
/// Only a local Codex runtime's exact native thread id can supply a title.
fn load_client_titles(
    home: &Path,
    requested: &std::collections::HashSet<String>,
) -> HashMap<String, String> {
    let mut result = HashMap::new();
    if requested.is_empty() || home.file_name().and_then(|n| n.to_str()) != Some(".codex") {
        return result;
    }
    let Some(user_home) = home.parent() else {
        return result;
    };
    let path = user_home.join(".t3/userdata/state.sqlite");
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return result;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(100));
    let ids: Vec<&String> = requested.iter().collect();
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        // CASE protects JSON extraction even if an old runtime row is malformed.
        let sql = format!("SELECT CASE WHEN json_valid(r.resume_cursor_json) THEN json_extract(r.resume_cursor_json, '$.threadId') END AS native_id, substr(t.title,1,4096) \
            FROM provider_session_runtime r JOIN projection_threads t ON t.thread_id = r.thread_id \
            WHERE r.provider_name = 'codex' AND t.deleted_at IS NULL AND native_id IN ({placeholders}) \
            ORDER BY t.updated_at DESC, t.thread_id");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        }) else {
            continue;
        };
        for (id, title) in rows.flatten() {
            if !title.trim().is_empty() {
                result.entry(id).or_insert(title);
            }
        }
    }
    result
}

fn state_version(path: &Path) -> Option<u64> {
    path.file_name()?
        .to_str()?
        .strip_prefix("state_")?
        .strip_suffix(".sqlite")?
        .parse()
        .ok()
}
fn load_db(
    home: &Path,
    requested: &std::collections::HashSet<String>,
) -> HashMap<String, (Option<String>, Option<String>)> {
    if requested.is_empty() {
        return HashMap::new();
    }
    let Some(path) = fs::read_dir(home).ok().and_then(|it| {
        it.flatten()
            .map(|e| e.path())
            .filter_map(|p| state_version(&p).map(|v| (v, p)))
            .max_by_key(|(v, _)| *v)
            .map(|(_, p)| p)
    }) else {
        return HashMap::new();
    };
    let Ok(conn) = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return HashMap::new();
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(100));
    let Ok(mut info) = conn.prepare("PRAGMA table_info(threads)") else {
        return HashMap::new();
    };
    let cols: Vec<String> = info
        .query_map([], |r| r.get(1))
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .collect();
    if !cols.iter().any(|c| c == "id") {
        return HashMap::new();
    }
    let has_name = cols.iter().any(|c| c == "name");
    let has_title = cols.iter().any(|c| c == "title");
    if !has_name && !has_title {
        return HashMap::new();
    }
    let columns = match (has_name, has_title) {
        (true, true) => "id,substr(name,1,4096),substr(title,1,4096)",
        (true, false) => "id,substr(name,1,4096)",
        _ => "id,substr(title,1,4096)",
    };
    let ids: Vec<&String> = requested.iter().collect();
    let mut result = HashMap::new();
    // Stay below even older SQLite builds' 999-variable limit.
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!("SELECT {columns} FROM threads WHERE id IN ({placeholders})");
        let Ok(mut stmt) = conn.prepare(&sql) else {
            continue;
        };
        let Ok(rows) = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
            let id: String = r.get(0)?;
            let a: Option<String> = r.get(1)?;
            let a = a.filter(|s| !s.trim().is_empty());
            let b: Option<String> = if has_name && has_title {
                r.get(2)?
            } else {
                None
            };
            Ok((
                id,
                if has_name {
                    (a, b.filter(|s| !s.trim().is_empty()))
                } else {
                    (None, a)
                },
            ))
        }) else {
            continue;
        };
        result.extend(rows.flatten());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn client_titles_use_exact_codex_identity_and_preserve_explicit_names() {
        let td = TempDir::new().unwrap();
        let home = td.path().join(".codex");
        fs::create_dir(&home).unwrap();
        let client_dir = td.path().join(".t3/userdata");
        fs::create_dir_all(&client_dir).unwrap();
        let client = client_dir.join("state.sqlite");
        let conn = Connection::open(&client).unwrap();
        conn.execute_batch(r#"
            CREATE TABLE projection_threads (thread_id TEXT, title TEXT, deleted_at TEXT, updated_at TEXT);
            CREATE TABLE provider_session_runtime (thread_id TEXT, provider_name TEXT, resume_cursor_json TEXT);
            INSERT INTO projection_threads VALUES ('ui','Fix usage labels',NULL,'2026-09-16'), ('other','Wrong provider',NULL,'2026-09-17'), ('deleted','Deleted title','2026-09-16','2026-09-18');
            INSERT INTO provider_session_runtime VALUES ('ui','codex','{"threadId":"native"}'), ('other','claude-code','{"threadId":"native"}'), ('deleted','codex','{"threadId":"native"}'), ('other','codex','bad json');
        "#).unwrap();
        drop(conn);
        let before = fs::read(&client).unwrap();
        let db = Connection::open(home.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads (id TEXT, name TEXT, title TEXT); INSERT INTO threads VALUES ('native',NULL,'A very long first prompt'), ('unrelated',NULL,'Unrelated prompt');").unwrap();
        let ids = ["native".into(), "unrelated".into()].into_iter().collect();
        let lookup = Lookup::new(&home, &ids);
        let mut m = CodexMetadata { own_id: Some("native".into()), ..Default::default() };
        lookup.enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("Fix usage labels"));
        let mut unrelated = CodexMetadata { own_id: Some("unrelated".into()), ..Default::default() };
        lookup.enrich(&mut unrelated);
        assert_eq!(unrelated.explicit_name.as_deref(), Some("Unrelated prompt"));
        fs::write(home.join("session_index.jsonl"), "{\"id\":\"native\",\"thread_name\":\"User rename\"}\n").unwrap();
        m.explicit_name = None;
        Lookup::new(&home, &ids).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("User rename"));
        db.execute("UPDATE threads SET name = 'Database rename' WHERE id = 'native'", []).unwrap();
        m.explicit_name = None;
        Lookup::new(&home, &ids).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("Database rename"));
        m.explicit_name = Some("Transcript rename".into());
        Lookup::new(&home, &ids).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("Transcript rename"));
        assert_eq!(fs::read(&client).unwrap(), before);
        // A missing, corrupt, or unsupported client database never loses Codex data.
        fs::remove_file(&client).unwrap();
        for content in [None, Some(b"not sqlite".as_slice())] {
            if let Some(content) = content { fs::write(&client, content).unwrap(); }
            m.explicit_name = None;
            Lookup::new(&home, &ids).enrich(&mut m);
            assert_eq!(m.explicit_name.as_deref(), Some("Database rename"));
        }
        fs::remove_file(&client).unwrap();
        Connection::open(&client).unwrap().execute("CREATE TABLE unsupported (id TEXT)", []).unwrap();
        m.explicit_name = None;
        Lookup::new(&home, &ids).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("Database rename"));
    }

    #[test]
    fn sparse_source_keeps_payload_agent_fields() {
        let td = TempDir::new().unwrap();
        let path = td.path().join("session.jsonl");
        fs::write(&path, r#"{"type":"session_meta","payload":{"id":"own","agent_role":"reviewer","agent_nickname":"nick","agent_path":"/tmp/agent","source":{"vscode":{}}}}"#).unwrap();
        let got = read_transcript(&path);
        assert_eq!(got.role.as_deref(), Some("reviewer"));
        assert_eq!(got.nickname.as_deref(), Some("nick"));
        assert_eq!(got.path.as_deref(), Some("/tmp/agent"));
    }

    #[test]
    fn latest_index_record_is_found_past_old_prefix_cap() {
        let td = TempDir::new().unwrap();
        let id = "late";
        let mut file = File::create(td.path().join("session_index.jsonl")).unwrap();
        for i in 0..33_000 {
            writeln!(file, "{{\"id\":\"noise-{i}\",\"thread_name\":\"noise\"}}").unwrap();
        }
        writeln!(file, "{{\"id\":\"{id}\",\"thread_name\":\"old\"}}").unwrap();
        writeln!(file, "{{\"id\":\"{id}\",\"thread_name\":\"renamed\"}}").unwrap();
        let lookup = Lookup::new(td.path(), &std::iter::once("late".to_string()).collect());
        let mut metadata = CodexMetadata {
            own_id: Some(id.into()),
            ..Default::default()
        };
        lookup.enrich(&mut metadata);
        assert_eq!(metadata.explicit_name.as_deref(), Some("renamed"));
    }

    #[test]
    fn database_title_is_found_past_old_row_cap() {
        let td = TempDir::new().unwrap();
        let db = td.path().join("state_9.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)", [])
            .unwrap();
        for i in 0..9_000 {
            conn.execute(
                "INSERT INTO threads VALUES (?1,?2)",
                rusqlite::params![format!("noise-{i}"), "noise"],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO threads VALUES (?1,?2)",
            rusqlite::params!["late", "late title"],
        )
        .unwrap();
        drop(conn);
        let lookup = Lookup::new(td.path(), &std::iter::once("late".to_string()).collect());
        let mut metadata = CodexMetadata {
            own_id: Some("late".into()),
            ..Default::default()
        };
        lookup.enrich(&mut metadata);
        assert_eq!(metadata.explicit_name.as_deref(), Some("late title"));
    }
    #[test]
    fn unsupported_and_corrupt_databases_leave_latest_index_available() {
        let td = TempDir::new().unwrap();
        let requested = std::iter::once("own".to_string()).collect();
        let index = td.path().join("session_index.jsonl");
        fs::write(
            &index,
            "not json\n{\"id\":\"own\",\"thread_name\":\"first\"}\n",
        )
        .unwrap();
        let db = td.path().join("state_5.sqlite");
        for unsupported in [false, true] {
            if unsupported {
                fs::remove_file(&db).unwrap();
                let conn = Connection::open(&db).unwrap();
                conn.execute("CREATE TABLE threads (unrecognized TEXT)", [])
                    .unwrap();
            } else {
                fs::write(&db, b"not sqlite").unwrap();
            }
            let before = fs::read(&db).unwrap();
            let mut m = CodexMetadata {
                own_id: Some("own".into()),
                ..Default::default()
            };
            Lookup::new(td.path(), &requested).enrich(&mut m);
            assert_eq!(m.explicit_name.as_deref(), Some("first"));
            assert_eq!(fs::read(&db).unwrap(), before);
        }
        fs::write(&index, "{\"id\":\"own\",\"thread_name\":\"renamed\"}\n").unwrap();
        let mut m = CodexMetadata {
            own_id: Some("own".into()),
            ..Default::default()
        };
        Lookup::new(td.path(), &requested).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("renamed"));
    }

    #[test]
    fn locked_database_falls_back_without_writing() {
        let td = TempDir::new().unwrap();
        let db = td.path().join("state_5.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)", [])
            .unwrap();
        conn.execute("INSERT INTO threads VALUES ('own','database title')", [])
            .unwrap();
        let before = fs::read(&db).unwrap();
        conn.execute_batch("BEGIN EXCLUSIVE").unwrap();
        fs::write(
            td.path().join("session_index.jsonl"),
            "{\"id\":\"own\",\"thread_name\":\"fallback\"}\n",
        )
        .unwrap();
        let mut m = CodexMetadata {
            own_id: Some("own".into()),
            ..Default::default()
        };
        Lookup::new(td.path(), &std::iter::once("own".into()).collect()).enrich(&mut m);
        assert_eq!(m.explicit_name.as_deref(), Some("fallback"));
        conn.execute_batch("ROLLBACK").unwrap();
        assert_eq!(fs::read(db).unwrap(), before);
    }
}
