use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // 1) Tauri build glue
    tauri_build::build();

    // 2) Generate Python schema mirrors. We invoke hub.py for the harness
    //    schema and a tiny inline -c program for the risks schema, so the
    //    Rust mirror can `include_str!` JSON at compile time. The Python
    //    sources are the single source of truth — touching any of them must
    //    trigger a rebuild on the Rust side.

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR not set");
    let repo_root = PathBuf::from(&manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(&manifest_dir));

    let hub_py = repo_root.join("hub.py");
    let harnesses_py = repo_root.join("harnesses.py");
    let risks_py = repo_root.join("risks.py");
    let permissions_py = repo_root.join("permissions.py");
    let permission_adapters_py = repo_root.join("permission_adapters.py");

    println!("cargo:rerun-if-changed={}", hub_py.display());
    println!("cargo:rerun-if-changed={}", harnesses_py.display());
    println!("cargo:rerun-if-changed={}", risks_py.display());
    println!("cargo:rerun-if-changed={}", permissions_py.display());
    println!("cargo:rerun-if-changed={}", permission_adapters_py.display());

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));

    // ── harnesses.generated.json ───────────────────────────────────────
    let harnesses_out = out_dir.join("harnesses.generated.json");
    let harnesses_json = match Command::new("python3")
        .arg(&hub_py)
        .arg("harnesses")
        .arg("emit-schema")
        .current_dir(&repo_root)
        .output()
    {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        Ok(out) => {
            println!(
                "cargo:warning=hub.py harnesses emit-schema failed (status {}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            "[]".to_string()
        }
        Err(e) => {
            println!(
                "cargo:warning=could not invoke python3 for harness emit-schema: {} (falling back to empty registry)",
                e
            );
            "[]".to_string()
        }
    };
    std::fs::write(&harnesses_out, harnesses_json)
        .unwrap_or_else(|e| panic!("failed to write {}: {}", harnesses_out.display(), e));

    // ── risks.generated.json ───────────────────────────────────────────
    let risks_out = out_dir.join("risks.generated.json");
    let risks_json = match Command::new("python3")
        .arg("-c")
        .arg("import risks, sys; sys.stdout.write(risks.emit_schema_json())")
        .current_dir(&repo_root)
        .output()
    {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).into_owned()
        }
        Ok(out) => {
            println!(
                "cargo:warning=risks.emit_schema_json failed (status {}): {}",
                out.status,
                String::from_utf8_lossy(&out.stderr).trim()
            );
            "[]".to_string()
        }
        Err(e) => {
            println!(
                "cargo:warning=could not invoke python3 for risks emit_schema_json: {} (falling back to empty list)",
                e
            );
            "[]".to_string()
        }
    };
    std::fs::write(&risks_out, risks_json)
        .unwrap_or_else(|e| panic!("failed to write {}: {}", risks_out.display(), e));
}
