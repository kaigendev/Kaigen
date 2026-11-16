//! Bounded notification data shared by the native queue and authenticated Webgate streams.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPreferences {
    pub notify_messages: bool,
    pub notify_requests: bool,
    pub notify_sound: bool,
    pub notification_volume: f64,
}

impl Default for NotificationPreferences {
    fn default() -> Self {
        Self {
            notify_messages: false,
            notify_requests: false,
            notify_sound: false,
            notification_volume: 0.7,
        }
    }
}

impl NotificationPreferences {
    pub fn from_local_state(value: &Value) -> Self {
        let enabled = |key| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        Self {
            notify_messages: enabled("notifyMessages"),
            notify_requests: enabled("notifyRequests"),
            notify_sound: enabled("notifySound"),
            notification_volume: value
                .get("notificationVolume")
                .and_then(Value::as_f64)
                .filter(|volume| volume.is_finite())
                .unwrap_or(0.7)
                .clamp(0.0, 1.0),
        }
    }

    pub fn value(self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NotificationKind {
    Message,
    Request,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NotificationProjection {
    pub version: u8,
    pub event_id: String,
    pub kind: NotificationKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub friend_public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    pub title: String,
    pub body: String,
}

pub fn excerpt(text: &str) -> String {
    crate::sanitize_untrusted_text(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(160)
        .collect()
}

fn public_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn valid_event_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_:.".contains(&byte))
}

impl NotificationProjection {
    /// Accept only an actual incoming business event, never a snapshot or resync.
    pub fn from_payload(payload: &Value) -> Option<Self> {
        let value = payload.get("notification")?;
        let mut notice: Self = serde_json::from_value(value.clone()).ok()?;
        if notice.version != 1
            || !valid_event_id(&notice.event_id)
            || notice.title.len() > 640
            || notice.body.len() > 640
            || notice.title.chars().count() > 160
            || notice.body.chars().count() > 160
        {
            return None;
        }
        match notice.kind {
            NotificationKind::Message => {
                let key = notice.friend_public_key.as_deref()?;
                let id = notice.message_id.as_deref()?;
                if !public_key(key)
                    || id.is_empty()
                    || id.len() > 128
                    || notice.public_key.is_some()
                    || payload.get("kind")?.as_str()? != "message"
                    || !payload
                        .get("friendPublicKey")?
                        .as_str()?
                        .eq_ignore_ascii_case(key)
                    || payload.get("messageId")?.as_str()? != id
                {
                    return None;
                }
                notice.friend_public_key = Some(key.to_ascii_uppercase());
            }
            NotificationKind::Request => {
                let key = notice.public_key.as_deref()?;
                if !public_key(key)
                    || notice.message_id.is_some()
                    || notice.friend_public_key.is_some()
                    || payload.get("kind")?.as_str()? != "friend-request"
                    || !payload
                        .get("publicKey")?
                        .as_str()?
                        .eq_ignore_ascii_case(key)
                {
                    return None;
                }
                notice.public_key = Some(key.to_ascii_uppercase());
            }
        }
        notice.title = excerpt(&notice.title);
        notice.body = excerpt(&notice.body);
        Some(notice)
    }

    pub fn target_key(&self) -> Option<String> {
        match self.kind {
            NotificationKind::Message => {
                Some(format!("friend-key:{}", self.friend_public_key.as_deref()?))
            }
            NotificationKind::Request => Some("requests".to_string()),
        }
    }
}
