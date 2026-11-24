//! Cillhub pure-Rust native desktop client (`cillhub_core`).
//! Re-exports all protocol, audio DSP, game activity, League LCU lobby,
//! Ed25519 auto-update, and native `egui`/`eframe` UI modules from `cillhub_client_core`.

pub use cillhub_client_core::{
    api, audio, config, deeplink, games, gateway, i18n, league, model, native_gateway,
    permissions, run_desktop_app, settings, state, theme, ui, update, websocket,
    websocket_transport,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_core_reexports_game_and_league_invite() {
        let invite = league::GameInviteData {
            game: "League of Legends".into(),
            queue_name: "Ranked Solo/Duo".into(),
            queue_id: Some(420),
            party_id: "party-100".into(),
            host_name: "Cillerian".into(),
            host_puuid: None,
            members: 2,
            max_members: 5,
        };
        let url = league::format_game_invite_url(&invite);
        assert_eq!(league::parse_game_invite(&url), Some(invite));

        let procs = vec![games::ProcessInfo {
            names: vec!["LeagueClientUx.exe".into()],
            cmdline: String::new(),
        }];
        assert_eq!(
            games::detect_game(&procs, &[], None).as_deref(),
            Some("League of Legends")
        );
    }

    #[test]
    fn installer_argv_deep_link_launch_selection_and_validation() {
        let exe = r"C:\Users\Alice\AppData\Local\Programs\Cillhub\cillhub-desktop.exe";

        // 1. Valid invite link as passed by Windows shell '"$INSTDIR\${PRODUCT_EXE}" "%1"'
        let link = deeplink::deep_link_from_args([exe, "cillhub://invite/abc-123"]);
        assert_eq!(link.as_deref(), Some("cillhub://invite/abc-123"));
        assert_eq!(
            deeplink::parse_deep_link(link.as_deref().unwrap()),
            Some(deeplink::DeepLinkTarget::Invite("abc-123".into()))
        );

        // 2. Upper-case scheme (both cillhub:// and legacy cillcord://)
        let upper_invite = deeplink::deep_link_from_args([exe, "CILLHUB://invite/upper-99"]);
        assert_eq!(upper_invite.as_deref(), Some("CILLHUB://invite/upper-99"));
        assert_eq!(
            deeplink::parse_deep_link(upper_invite.as_deref().unwrap()),
            Some(deeplink::DeepLinkTarget::Invite("upper-99".into()))
        );
        let upper_node = deeplink::deep_link_from_args([exe, "CILLCORD://add-node#https://node.example.org"]);
        assert_eq!(
             upper_node.as_deref().and_then(deeplink::parse_deep_link),
            Some(deeplink::DeepLinkTarget::AddNode("https://node.example.org".into()))
        );
        let upper_game = deeplink::deep_link_from_args([exe, "CILLHUB://game-invite?game=League+of+Legends&partyId=party-100"]);
        assert!(matches!(
            upper_game.as_deref().and_then(deeplink::parse_deep_link),
            Some(deeplink::DeepLinkTarget::GameInvite(_))
        ));

        // 3. Add-node link with an http origin must be refused by parse_deep_link
        let http_node = deeplink::deep_link_from_args([exe, "cillhub://add-node#http://node.example.org"]);
        assert_eq!(http_node.as_deref(), Some("cillhub://add-node#http://node.example.org"));
        assert_eq!(deeplink::parse_deep_link(http_node.as_deref().unwrap()), None);

        // 4. Links with path traversal or extra flags after them
        for traversal in [
            "cillhub://invite/../admin",
            "cillhub://invite/abc/../def",
            "cillhub://add-node#https://node.example.org/../admin",
            "cillhub://game-invite?game=League&partyId=../../admin",
        ] {
            let picked = deeplink::deep_link_from_args([exe, traversal]);
            assert_eq!(picked.as_deref(), Some(traversal));
            assert_eq!(deeplink::parse_deep_link(traversal), None, "{traversal}");
        }
        for with_inline_flags in [
            "cillhub://invite/abc-123 --demo",
            "cillhub://add-node#https://node.example.org --demo",
            "cillhub://add-node#https%3A%2F%2Fnode.example.org%20--demo",
            "cillhub://game-invite?game=League+of+Legends&partyId=party-100 --demo",
        ] {
            let picked = deeplink::deep_link_from_args([exe, with_inline_flags]);
            assert_eq!(picked.as_deref(), Some(with_inline_flags));
            assert_eq!(deeplink::parse_deep_link(with_inline_flags), None, "{with_inline_flags}");
        }
        let with_trailing_argv_flags = deeplink::deep_link_from_args([exe, "cillhub://invite/abc-123", "--demo", "--extra"]);
        assert_eq!(
            with_trailing_argv_flags.as_deref().and_then(deeplink::parse_deep_link),
            Some(deeplink::DeepLinkTarget::Invite("abc-123".into()))
        );

        // 5. Non-link arguments such as --demo must not be taken as a link
        assert_eq!(deeplink::deep_link_from_args([exe, "--demo"]), None);
        assert_eq!(deeplink::deep_link_from_args([exe, "--sandbox", "--version"]), None);
        assert_eq!(
            deeplink::deep_link_from_args([exe, "--demo", "CILLHUB://invite/after-flag"]),
            Some("CILLHUB://invite/after-flag".to_string())
        );
    }

    #[test]
    fn unreadable_settings_file_is_set_aside_not_overwritten() {
        // a field of another type (a newer version wrote it) made load fall back to the defaults, and the next save
        // replaced the file: node tokens kept in it and the sign-out journal were gone
        let dir = std::env::temp_dir().join(format!("cillhub-desktop-settings-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("settings.json");
        let original = r#"{"closeToTray":{"mode":"always"},"nodeTokens":{"k":"node-secret"},"pendingRevokes":{"r":"tok"}}"#;
        std::fs::write(&file, original).unwrap();

        let s = settings::AppSettings::load_from(&file);
        assert!(s.close_to_tray && s.node_tokens.is_empty(), "defaults are used");
        s.save_to(&file).unwrap();
        let aside = dir.join("settings.json.unreadable");
        assert_eq!(std::fs::read_to_string(&aside).unwrap(), original, "the old file is kept");
        assert!(std::fs::read_to_string(&file).unwrap().contains("closeToTray"), "the new file is the defaults");

        // a missing file is simply the defaults, nothing set aside
        let _ = std::fs::remove_file(&aside);
        let fresh = dir.join("none.json");
        settings::AppSettings::load_from(&fresh);
        assert!(!dir.join("none.json.unreadable").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn download_page_links_only_published_desktop_files() {
        // The page's main buttons linked the old desktop app's names (Cillhub-Setup-<v>.exe, an AppImage,
        // cillhub_<v>_amd64.deb), which publish.js never writes: "Download for Windows" was a 404.
        let page = include_str!("../download-page/index.html");
        let publish = include_str!("../scripts/publish.js");
        let block = publish
            .split("const rustArtifacts = {")
            .nth(1)
            .and_then(|b| b.split("};").next())
            .expect("publish.js lists rustArtifacts");
        let published: Vec<String> = block
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                let (open, close) = if l.starts_with("[`") { ("[`", "`]") } else { ("'", "'") };
                let rest = l.strip_prefix(open)?;
                Some(rest[..rest.find(close)?].to_string())
            })
            .collect();
        assert!(published.len() >= 5, "parsed {published:?}");
        let links: Vec<&str> = page
            .split("/download/desktop/")
            .skip(1)
            .map(|r| &r[..r.find(['"', '<']).unwrap()])
            .collect();
        assert!(links.len() >= 4);
        for link in links {
            let name = link.replace("{{VERSION}}", "${version}");
            assert!(published.contains(&name), "download page links {link}, which publish.js does not publish");
        }
        assert!(page.contains(r#"data-os="windows" href="/download/desktop/Cillhub-Rust-Setup-{{VERSION}}.exe""#));
        assert!(page.contains(r#"data-os="linux" href="/download/desktop/cillhub-desktop-rust_{{VERSION}}_amd64.deb""#));
    }

    #[test]
    fn installer_script_qualifies_nsexec_and_taskkill_with_sysdir() {
        let script = include_str!("../installer.nsi");
        let has_nsexec = script.lines().any(|line| line.contains("nsExec::"));
        assert!(has_nsexec, "installer.nsi must contain at least one nsExec:: line");

        for (idx, line) in script.lines().enumerate() {
            if line.contains("nsExec::") || line.contains("taskkill") {
                let sysdir = line
                    .find(r"$SYSDIR\")
                    .unwrap_or_else(|| panic!("line {} missing $SYSDIR\\ prefix: {line}", idx + 1));
                if let Some(nsexec) = line.find("nsExec::") {
                    assert!(
                        nsexec < sysdir,
                        "line {} must place $SYSDIR\\ after nsExec:: command: {line}",
                        idx + 1
                    );
                }
                if let Some(prog) = line.find("taskkill") {
                    assert!(
                        sysdir < prog,
                        "line {} must name $SYSDIR\\ before taskkill: {line}",
                        idx + 1
                    );
                }
                assert!(
                    line.contains(r#"nsExec::ExecToLog '"$SYSDIR\taskkill.exe" "#),
                    "line {} must invoke \"$SYSDIR\\taskkill.exe\": {line}",
                    idx + 1
                );
            }
        }
    }

    fn cargo_package_version(toml: &str) -> Result<String, String> {
        let mut in_pkg = false;
        for line in toml.lines() {
            let trimmed = line.trim();
            if trimmed.starts_with('[') {
                in_pkg = trimmed == "[package]";
                continue;
            }
            if in_pkg {
                if let Some(rest) = trimmed.strip_prefix("version") {
                    let rest = rest.trim_start();
                    if let Some(rest) = rest.strip_prefix('=') {
                        let v = rest.trim().trim_matches('"');
                        if !v.is_empty() {
                            return Ok(v.to_string());
                        }
                    }
                }
            }
        }
        Err("missing [package] version".into())
    }

    fn nsi_default_version(nsi: &str) -> Result<String, String> {
        for line in nsi.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("!define VERSION ") {
                let v = rest.trim().trim_matches('"');
                if !v.is_empty() {
                    return Ok(v.to_string());
                }
            }
        }
        Err("missing !define VERSION in installer.nsi".into())
    }

    fn check_desktop_versions(
        desktop_cargo: &str,
        client_cargo: &str,
        pkg_json: &str,
        nsi: &str,
    ) -> Result<String, String> {
        let desktop_ver = cargo_package_version(desktop_cargo)?;
        let client_ver = cargo_package_version(client_cargo)?;
        let pkg: serde_json::Value =
            serde_json::from_str(pkg_json).map_err(|e| format!("invalid package.json: {e}"))?;
        let pkg_ver = pkg
            .get("version")
            .and_then(|v| v.as_str())
            .ok_or("missing version in package.json")?
            .to_string();
        let nsi_ver = nsi_default_version(nsi)?;
        let build_win = pkg
            .pointer("/scripts/build:windows")
            .and_then(|v| v.as_str())
            .ok_or("missing scripts.build:windows in package.json")?;
        let dver = build_win
            .split_whitespace()
            .find_map(|tok| tok.strip_prefix("-DVERSION="))
            .ok_or("scripts.build:windows missing -DVERSION=")?;
        let build_win_ver = if dver == "$npm_package_version" || dver == "${npm_package_version}" {
            pkg_ver.clone()
        } else {
            dver.trim_matches('"').to_string()
        };

        let all = [
            ("desktop-rust/Cargo.toml", desktop_ver.as_str()),
            ("rust-client/Cargo.toml", client_ver.as_str()),
            ("desktop-rust/package.json", pkg_ver.as_str()),
            ("desktop-rust/installer.nsi", nsi_ver.as_str()),
            ("package.json scripts.build:windows", build_win_ver.as_str()),
        ];
        if all.iter().any(|(_, v)| *v != desktop_ver) {
            return Err(format!("desktop version mismatch: {all:?}"));
        }
        Ok(desktop_ver)
    }

    #[test]
    fn desktop_version_copies_all_agree() {
        let desktop_cargo = include_str!("../Cargo.toml");
        let client_cargo = include_str!("../../rust-client/Cargo.toml");
        let pkg_json = include_str!("../package.json");
        let nsi = include_str!("../installer.nsi");

        let ver = check_desktop_versions(desktop_cargo, client_cargo, pkg_json, nsi)
            .expect("all desktop version copies must agree");
        assert_eq!(ver, env!("CARGO_PKG_VERSION"));
        let expected_marker = format!("CILLHUB_NATIVE_VERSION={ver}\0");
        assert_eq!(cillhub_client_core::BUILD_VERSION_MARKER, expected_marker.as_bytes());
        let exe_bytes = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        assert!(
            exe_bytes.windows(expected_marker.len()).any(|w| w == expected_marker.as_bytes()),
            "compiled binary must embed BUILD_VERSION_MARKER"
        );

        // Mutating any single copy in a scratch copy must make the check fail.
        assert!(check_desktop_versions(
            &desktop_cargo.replacen(&ver, "9.9.9", 1),
            client_cargo,
            pkg_json,
            nsi,
        )
        .is_err());
        assert!(check_desktop_versions(
            desktop_cargo,
            &client_cargo.replacen(&ver, "9.9.9", 1),
            pkg_json,
            nsi,
        )
        .is_err());
        assert!(check_desktop_versions(
            desktop_cargo,
            client_cargo,
            &pkg_json.replacen(&format!(r#""version": "{ver}""#), r#""version": "9.9.9""#, 1),
            nsi,
        )
        .is_err());
        assert!(check_desktop_versions(
            desktop_cargo,
            client_cargo,
            pkg_json,
            &nsi.replacen(&ver, "9.9.9", 1),
        )
        .is_err());
        let bad_build_win = pkg_json
            .replace("-DVERSION=$npm_package_version", "-DVERSION=9.9.9")
            .replace(&format!("-DVERSION={ver}"), "-DVERSION=9.9.9");
        assert_ne!(bad_build_win, pkg_json, "scratch mutation must change build:windows");
        assert!(check_desktop_versions(desktop_cargo, client_cargo, &bad_build_win, nsi).is_err());
    }

    #[test]
    fn publish_guard_refuses_mismatched_or_unmarked_binaries() {
        let project_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let publish_js = project_dir.join("scripts").join("publish.js");
        let expected = env!("CARGO_PKG_VERSION");
        let other = "0.0.1";
        let good_marker = format!("ELF\0CILLHUB_NATIVE_VERSION={expected}\0pad");
        let bad_marker = format!("ELF\0CILLHUB_NATIVE_VERSION={other}\0pad");

        let cases = [
            ("linux_wrong", bad_marker.as_bytes(), good_marker.as_bytes(), other),
            ("linux_missing", b"ELF\0no-marker-here" as &[u8], good_marker.as_bytes(), "none"),
            ("win_wrong", good_marker.as_bytes(), bad_marker.as_bytes(), other),
            ("win_missing", good_marker.as_bytes(), b"MZ\0no-marker-here" as &[u8], "none"),
        ];

        for (label, linux_bytes, win_bytes, expected_got) in cases {
            let root = std::env::temp_dir().join(format!(
                "cillhub-publish-guard-{}-{label}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&root);
            let target = root.join("target");
            let linux_dir = target.join("release");
            let win_dir = target.join("x86_64-pc-windows-msvc").join("release");
            let download_dir = root.join("download");
            let fake_key = root.join("nonexistent-test-key.pem");
            std::fs::create_dir_all(&linux_dir).unwrap();
            std::fs::create_dir_all(&win_dir).unwrap();
            std::fs::create_dir_all(&download_dir).unwrap();

            std::fs::write(linux_dir.join("cillhub"), linux_bytes).unwrap();
            std::fs::write(win_dir.join("cillhub.exe"), win_bytes).unwrap();
            // Present so publish.js never invokes makensis even before the fix.
            std::fs::write(
                win_dir.join(format!("Cillhub-Rust-Setup-{expected}.exe")),
                b"dummy-setup",
            )
            .unwrap();

            let out = std::process::Command::new("node")
                .arg(&publish_js)
                .arg(&download_dir)
                .env("CARGO_TARGET_DIR", &target)
                .env("RELEASE_KEY", &fake_key)
                .output()
                .expect("node must be available on PATH to test publish.js");

            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let combined = format!("{stdout}\n{stderr}");
            let download_entries: Vec<_> = std::fs::read_dir(&download_dir).unwrap().collect();
            let _ = std::fs::remove_dir_all(&root);

            assert!(
                !out.status.success(),
                "{label}: publish.js must exit non-zero, got status {:?}",
                out.status
            );
            assert!(
                combined.contains(expected) && combined.contains(expected_got),
                "{label}: error message must name expected ({expected}) and found ({expected_got}); got:\n{combined}"
            );
            assert!(
                !combined.contains("dpkg-deb") && !combined.contains("openssl"),
                "{label}: publish.js must stop before staging or signing; got:\n{combined}"
            );
            assert!(
                download_entries.is_empty(),
                "{label}: temp download directory must stay empty"
            );
        }
    }
}
