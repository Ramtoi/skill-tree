use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    // 1) Tauri build glue
    tauri_build::build();

    // 2) Generate the risk schema mirror. Harness inventory and native paths
    //    come from Python operation contexts at runtime.

    let manifest_dir = env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let repo_root = PathBuf::from(&manifest_dir)
        .parent()
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from(&manifest_dir));

    let hub_py = repo_root.join("hub.py");
    let package_dir = repo_root.join("skill_hub");
    let harnesses_py = package_dir.join("infrastructure/harnesses/harnesses.py");
    let risks_py = package_dir.join("domain/diagnostics/risks.py");
    let permissions_py = package_dir.join("domain/permissions/permissions.py");
    let permission_adapters_py =
        package_dir.join("infrastructure/permissions/permission_adapters.py");
    let permission_adapter_base_py =
        package_dir.join("domain/permissions/permission_adapter_base.py");
    let permission_adapter_codex_py =
        package_dir.join("infrastructure/permissions/permission_adapter_codex.py");
    let permission_adapter_opencode_py =
        package_dir.join("infrastructure/permissions/permission_adapter_opencode.py");

    println!("cargo:rerun-if-changed={}", hub_py.display());
    println!("cargo:rerun-if-changed={}", package_dir.display());
    println!("cargo:rerun-if-changed={}", harnesses_py.display());
    for module in [
        "domain/harnesses/harness_adapter_api.py",
        "domain/harnesses/harness_usage_api.py",
        "infrastructure/harnesses/harness_bundled_usage.py",
        "domain/harnesses/harness_catalog.py",
        "infrastructure/harnesses/harness_bundled_mcp.py",
        "infrastructure/harnesses/harness_bundled_hooks.py",
        "infrastructure/harnesses/harness_bundled_invocation.py",
        "infrastructure/harnesses/harness_bundled_layouts.py",
        "infrastructure/harnesses/harness_bundled_subagents.py",
        "infrastructure/harnesses/harness_bundled_permissions.py",
        "domain/harnesses/harness_resolution.py",
        "application/harnesses/harness_runtime.py",
        "infrastructure/harnesses/harness_native_executor.py",
        "infrastructure/harnesses/harness_execution_supervisor.py",
        "application/harnesses/harness_operation_context.py",
        "application/harnesses/harness_layout_context.py",
        "infrastructure/harnesses/harness_validation.py",
        "domain/usage/usage_identity.py",
        "infrastructure/usage/usage_reader_context.py",
        "infrastructure/usage/usage_jsonl.py",
        "domain/usage/usage_reader_resolution.py",
        "application/usage/usage_source_layout.py",
    ] {
        println!(
            "cargo:rerun-if-changed={}",
            package_dir.join(module).display()
        );
    }
    println!("cargo:rerun-if-changed={}", risks_py.display());
    println!("cargo:rerun-if-changed={}", permissions_py.display());
    println!(
        "cargo:rerun-if-changed={}",
        permission_adapters_py.display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        permission_adapter_base_py.display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        permission_adapter_codex_py.display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        permission_adapter_opencode_py.display()
    );

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR not set"));

    // ── risks.generated.json ───────────────────────────────────────────
    let risks_out = out_dir.join("risks.generated.json");
    let risks_json = match Command::new("python3")
        .arg("-c")
        .arg("import skill_hub.domain.diagnostics.risks as risks, sys; sys.stdout.write(risks.emit_schema_json())")
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
