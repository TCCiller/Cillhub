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
}
