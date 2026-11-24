//! cillhub://invite/<code> (or the older cillcord://) → "/invite/<code>";
//! cillhub://game-invite?... → parsed game lobby invite; cillhub://add-node#<address> → a node to confirm;
//! plus unread badge count.

use crate::config::DEEP_LINK_SCHEMES;
use crate::league::{parse_game_invite, GameInviteData};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeepLinkTarget {
    Invite(String),
    GameInvite(GameInviteData),
    /// cillhub://add-node#<address>: the node origin, shown for confirmation first.
    AddNode(String),
}

pub(crate) fn scheme_rest(raw: &str) -> Option<&str> {
    DEEP_LINK_SCHEMES.iter().find_map(|s| {
        raw.get(..s.len() + 3)
            .filter(|p| p.eq_ignore_ascii_case(&format!("{s}://")))
            .map(|_| &raw[s.len() + 3..])
    })
}

/// Picks the first command-line argument after `argv[0]` that starts with one of `DEEP_LINK_SCHEMES` (case-insensitively).
pub fn deep_link_from_args<I, S>(args: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .skip(1)
        .find(|a| scheme_rest(a.as_ref()).is_some())
        .map(|a| a.as_ref().to_string())
}

pub fn deep_link_path(raw: &str) -> Option<String> {
    if raw.chars().any(char::is_whitespace) {
        return None;
    }
    let rest = scheme_rest(raw)?;
    let code = rest.strip_prefix("invite/")?.trim_end_matches('/');
    ((2..=32).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
        .then(|| format!("/invite/{code}"))
}

pub fn parse_deep_link(raw: &str) -> Option<DeepLinkTarget> {
    if raw.chars().any(char::is_whitespace) {
        return None;
    }
    let rest = scheme_rest(raw)?;
    if let Some(query) = rest.strip_prefix("game-invite?") {
        let normalized = format!("cillhub://game-invite?{query}");
        return parse_game_invite(&normalized).map(DeepLinkTarget::GameInvite);
    }
    if let Some(origin) = crate::nodes::parse_add_deep_link(raw) {
        return Some(DeepLinkTarget::AddNode(origin));
    }
    if let Some(path) = deep_link_path(raw) {
        let code = path.strip_prefix("/invite/")?.to_string();
        return Some(DeepLinkTarget::Invite(code));
    }
    None
}

/// "(N) …" = N mentions, "• …" = unread without a count (-1), else 0.
pub fn parse_unread(title: &str) -> i32 {
    let t = title.trim_start();
    if let Some(rest) = t.strip_prefix('(') {
        if let Some(end) = rest.find(')') {
            return rest[..end].trim_end_matches('+').parse().unwrap_or(0);
        }
    }
    if t.starts_with('•') || t.starts_with('●') {
        -1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_links() {
        assert_eq!(
            deep_link_path("cillhub://invite/abc-123").as_deref(),
            Some("/invite/abc-123")
        );
        assert_eq!(
            deep_link_path("CILLCORD://invite/ab/").as_deref(),
            Some("/invite/ab")
        );
        assert_eq!(deep_link_path("cillhub://invite/a"), None);
        assert_eq!(deep_link_path("cillhub://invite/../x"), None);
        assert_eq!(deep_link_path("cillhub://channels/1/2"), None);
        assert_eq!(deep_link_path("https://example.com/invite/abc"), None);
    }

    #[test]
    fn deep_link_arg_selection_and_parsing() {
        assert_eq!(
            deep_link_from_args(["cillhub-desktop.exe", "--demo", "CILLHUB://invite/abc-123"]),
            Some("CILLHUB://invite/abc-123".to_string())
        );
        assert_eq!(
            deep_link_from_args(["cillhub-desktop.exe", "CiLlCoRd://add-node#https://node.example.org", "--demo"]),
            Some("CiLlCoRd://add-node#https://node.example.org".to_string())
        );
        assert_eq!(
            deep_link_from_args(["cillhub://invite/ignored-argv0", "--demo", "--sandbox", "https://example.com"]),
            None
        );

        assert_eq!(
            parse_deep_link("CILLHUB://game-invite?game=League+of+Legends&partyId=party-100"),
            Some(DeepLinkTarget::GameInvite(GameInviteData {
                game: "League of Legends".into(),
                queue_name: "Custom Game".into(),
                queue_id: None,
                party_id: "party-100".into(),
                host_name: "Host".into(),
                host_puuid: None,
                members: 1,
                max_members: 5,
            }))
        );
        assert_eq!(
            parse_deep_link("cillhub://game-invite?game=League+of+Legends&partyId=party-100 --extra-flag"),
            None
        );
        assert_eq!(
            parse_deep_link("cillhub://add-node#https://node.example.org --extra-flag"),
            None
        );
    }

    #[test]
    fn unread() {
        assert_eq!(parse_unread("Cillhub"), 0);
        assert_eq!(parse_unread("(5) Cillhub"), 5);
        assert_eq!(parse_unread("(99+) Cillhub"), 99);
        assert_eq!(parse_unread("● #general — Cillhub"), -1);
        assert_eq!(parse_unread("(x) Cillhub"), 0);
    }
}
