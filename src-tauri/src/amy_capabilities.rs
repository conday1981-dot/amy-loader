//! A.M.Y Loader: switch on HealthKit for apps that ask for it, and give
//! widget extensions their own App IDs so iOS will run them.
//!
//! isideload signs with whatever the free provisioning profile grants, and the
//! only capability it switches on by itself is "increased memory limit". Apple
//! lets free Apple IDs use HealthKit, but only after the app's App ID has the
//! HealthKit capability. The next profile Apple issues then includes the
//! `com.apple.developer.healthkit` entitlement.
//!
//! The capability stays on the App ID, so the extra work only matters once per
//! app. After that, every normal install and 7-day refresh gets a profile with
//! HealthKit in it.
//!
//! An app "asks for" HealthKit when its Info.plist has an Apple Health usage
//! description (`NSHealthShareUsageDescription` or
//! `NSHealthUpdateUsageDescription`). iOS refuses Health access without one,
//! so no app that doesn't need Health is touched.

use isideload::{
    dev::{
        app_ids::{AppId, AppIdsApi},
        developer_session::DeveloperSession,
        teams::DeveloperTeam,
    },
    sideload::{builder::ExtensionsBehavior, bundle::Bundle},
};
use reqwest::header::HeaderValue;
use rootcause::prelude::*;

/// Info.plist keys that mean "this app reads or writes Apple Health".
pub const HEALTH_USAGE_KEYS: [&str; 2] = ["NSHealthShareUsageDescription", "NSHealthUpdateUsageDescription"];

/// The App ID identifier isideload registers for an app: "<bundle id>.<team id>".
pub fn app_id_identifier(bundle_id: &str, team: &DeveloperTeam) -> String {
    format!("{}.{}", bundle_id, team.team_id)
}

async fn find_app_id(session: &mut DeveloperSession, team: &DeveloperTeam, identifier: &str) -> Result<Option<AppId>, Report> {
    let list = session.list_app_ids(team, None).await?;
    Ok(list.app_ids.into_iter().find(|a| a.identifier == identifier))
}

/// Switch HealthKit on for the app's App ID.
///
/// Returns `Ok(true)` when it is on, and `Ok(false)` when the App ID doesn't
/// exist yet: on a first install isideload creates it while signing, so the
/// caller signs once, calls this again, then signs a second time to get a
/// profile that includes HealthKit.
pub async fn enable_healthkit(session: &mut DeveloperSession, team: &DeveloperTeam, bundle_id: &str) -> Result<bool, Report> {
    let identifier = app_id_identifier(bundle_id, team);
    let Some(app_id) = find_app_id(session, team, &identifier).await? else {
        return Ok(false);
    };

    let mut headers = session.get_headers().await.context("Failed to get anisette headers")?;
    headers.insert("Content-Type", HeaderValue::from_static("application/vnd.api+json"));
    headers.insert("Accept", HeaderValue::from_static("application/vnd.api+json"));

    // Same request isideload makes for INCREASED_MEMORY_LIMIT, with HEALTHKIT.
    // Enabling a capability that is already on is accepted, so this is safe to repeat.
    let body = format!(
        "{{\"data\":{{\"relationships\":{{\"bundleIdCapabilities\":{{\"data\":[{{\"relationships\":{{\"capability\":{{\"data\":{{\"id\":\"HEALTHKIT\",\"type\":\"capabilities\"}}}}}},\"type\":\"bundleIdCapabilities\",\"attributes\":{{\"settings\":[],\"enabled\":true}}}}]}}}},\"id\":\"{}\",\"attributes\":{{\"hasExclusiveManagedCapabilities\":false,\"teamId\":\"{}\",\"bundleType\":\"bundle\",\"identifier\":\"{}\",\"seedId\":\"{}\",\"name\":\"{}\"}},\"type\":\"bundleIds\"}}}}",
        app_id.app_id_id, team.team_id, app_id.identifier, team.team_id, app_id.name
    );

    session
        .get_grandslam_client()
        .patch(&format!("https://developerservices2.apple.com/services/v1/bundleIds/{}", app_id.app_id_id))?
        .headers(headers)
        .body(body)
        .send()
        .await
        .context("Failed to request the HealthKit capability")?
        .error_for_status()
        .context("Apple refused the HealthKit capability")?;

    tracing::info!("HealthKit capability enabled for {}", identifier);
    Ok(true)
}

/// WidgetKit extensions (home and lock screen widgets).
const WIDGET_POINT: &str = "com.apple.widgetkit-extension";

fn extension_point(bundle: &Bundle) -> Option<&str> {
    bundle
        .app_info
        .get("NSExtension")?
        .as_dictionary()?
        .get("NSExtensionPointIdentifier")?
        .as_string()
}

/// How to sign an app's extensions.
///
/// iOS only loads a widget whose signature carries its own App ID, so when an
/// app's extensions are all widgets (at most two), each gets its own App ID.
/// That costs one App ID per widget once (they are kept and reused at every
/// refresh). Anything else keeps sharing the main App ID, as before, so other
/// apps don't eat into the free account's 10-App-IDs-a-week limit.
pub fn extensions_behavior(extensions: &[Bundle]) -> ExtensionsBehavior {
    let points: Vec<Option<&str>> = extensions.iter().map(extension_point).collect();
    if widgets_only(&points) {
        tracing::info!("Widget extensions: registering their own App IDs");
        ExtensionsBehavior::RegisterAll
    } else {
        ExtensionsBehavior::ReuseMain
    }
}

fn widgets_only(points: &[Option<&str>]) -> bool {
    !points.is_empty() && points.len() <= 2 && points.iter().all(|p| *p == Some(WIDGET_POINT))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_isideload() {
        let team = DeveloperTeam { name: None, team_id: "ABCDE12345".into(), r#type: None, status: None };
        assert_eq!(app_id_identifier("uk.con.duo", &team), "uk.con.duo.ABCDE12345");
    }

    #[test]
    fn only_widget_extensions_get_their_own_ids() {
        let w = Some(WIDGET_POINT);
        assert!(widgets_only(&[w]));
        assert!(widgets_only(&[w, w]));
        assert!(!widgets_only(&[]));
        assert!(!widgets_only(&[w, w, w]));
        assert!(!widgets_only(&[w, Some("com.apple.share-services")]));
        assert!(!widgets_only(&[None]));
    }
}
