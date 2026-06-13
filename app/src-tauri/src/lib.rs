mod commands;

use commands::hub::resolved_python;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Detect Python at startup so check_python() is instant on first call
    let _ = resolved_python();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::registry::read_registry,
            commands::registry::read_skill_content,
            commands::registry::read_skill_document,
            commands::registry::write_skill_content,
            commands::registry::save_skill_full,
            commands::hub::hub_cmd,
            commands::hub::check_python,
            commands::fs::pick_directory,
            commands::fs::path_exists,
            commands::fs::create_empty_file,
            commands::bootstrap::bootstrap_check,
            commands::bootstrap::bootstrap_run,
            commands::projects::project_add_with_path,
            commands::projects::project_edit_path,
            commands::projects::project_remove_preview,
            commands::projects::project_remove_clean,
            commands::harnesses::harness_list,
            commands::harnesses::harness_set_global,
            commands::harnesses::project_set_harnesses,
            commands::agent_docs::list_agent_docs,
            commands::agent_docs::read_agent_doc,
            commands::agent_docs::write_agent_doc,
            commands::agent_docs::agent_docs_root_status,
            commands::agent_docs::agent_docs_strategy_get,
            commands::agent_docs::agent_docs_strategy_set,
            commands::agent_docs::agent_docs_fix_plan,
            commands::agent_docs::agent_docs_fix_apply,
            commands::agent_docs::agent_docs_resolve,
            commands::snippets::snippets_list,
            commands::snippets::snippet_show,
            commands::snippets::snippet_new,
            commands::snippets::snippet_edit,
            commands::snippets::snippet_delete,
            commands::snippets::snippet_apply,
            commands::snippets::snippet_remove,
            commands::snippets::snippet_update,
            commands::snippets::snippet_status,
            commands::permissions::permissions_show,
            commands::permissions::permissions_set,
            commands::permissions::permissions_validate,
            commands::permissions::permissions_capabilities,
            commands::permissions::permissions_doctor,
            commands::permissions::permissions_adopt,
            commands::permissions::permissions_import_candidates,
            commands::permissions::permissions_import_apply,
            commands::permissions::permissions_reconcile_candidates,
            commands::permissions::permissions_reconcile_apply,
            commands::permissions::permissions_disable,
            commands::permissions::permissions_migrate_scope,
            commands::permissions::permissions_risks_schema,
            commands::permissions::permissions_recent_imports,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}
