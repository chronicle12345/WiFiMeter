use serde_json::Value;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoginState {
    Missing,
    Current(bool),
    Other,
}

pub trait LoginItems: Send + Sync {
    fn read(&self) -> Result<LoginState, String>;
    fn write(&self, enabled: bool) -> Result<bool, String>;
}

#[derive(Default)]
struct Policy {
    previous: bool,
    preserve: bool,
}

pub struct Autostart {
    login: Box<dyn LoginItems>,
    writable: bool,
    inherit: bool,
    policy: Mutex<Policy>,
}

impl Autostart {
    pub fn new(login: Box<dyn LoginItems>, writable: bool, inherit: bool) -> Self {
        Self {
            login,
            writable,
            inherit,
            policy: Mutex::new(Policy::default()),
        }
    }

    // Read only: the caller persists an inherited preference before applying it to Windows.
    pub fn prepare(&self, settings: &Value, migration: &Value) -> (bool, Option<&'static str>) {
        let mut policy = self.policy.lock().unwrap();
        policy.previous = settings["autoStart"] == true;
        if !self.writable {
            return (false, None);
        }
        if migration["error"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
        {
            policy.preserve = true;
            return (false, None);
        }
        let adopting =
            self.inherit && migration["found"] == true && migration["settingsApplied"] == true;
        match self.login.read() {
            Ok(LoginState::Current(true)) if adopting => {
                policy.preserve = false;
                (true, None)
            }
            Ok(LoginState::Other) | Ok(LoginState::Missing | LoginState::Current(false))
                if adopting =>
            {
                policy.preserve = true;
                (false, Some("unmatched"))
            }
            Ok(LoginState::Other) => {
                policy.preserve = true;
                (false, Some("unmatched"))
            }
            Err(_) => {
                policy.preserve = true;
                (false, Some("unavailable"))
            }
            _ => (false, None),
        }
    }

    pub fn preserve(&self) {
        self.policy.lock().unwrap().preserve = true;
    }

    pub fn apply(&self, settings: &Value, explicitly_requested: bool) -> Option<bool> {
        let requested = settings["autoStart"] == true;
        let mut policy = self.policy.lock().unwrap();
        let changed = explicitly_requested && requested != policy.previous;
        policy.previous = requested;
        if changed {
            policy.preserve = false;
        }
        if !self.writable || policy.preserve {
            return None;
        }
        Some(self.login.write(requested).unwrap_or_else(|error| {
            eprintln!("[autostart] {error}");
            false
        }))
    }
}

#[derive(Default)]
pub struct IsolatedLogin(Mutex<bool>);
impl LoginItems for IsolatedLogin {
    fn read(&self) -> Result<LoginState, String> {
        Ok(LoginState::Current(*self.0.lock().unwrap()))
    }
    fn write(&self, enabled: bool) -> Result<bool, String> {
        *self.0.lock().unwrap() = enabled;
        Ok(enabled)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    struct Fake {
        state: LoginState,
        writes: Arc<Mutex<Vec<bool>>>,
        fail: bool,
    }
    impl LoginItems for Fake {
        fn read(&self) -> Result<LoginState, String> {
            Ok(self.state)
        }
        fn write(&self, enabled: bool) -> Result<bool, String> {
            self.writes.lock().unwrap().push(enabled);
            if self.fail {
                Err("denied".into())
            } else {
                Ok(enabled)
            }
        }
    }
    fn manager(
        state: LoginState,
        writable: bool,
        inherit: bool,
        fail: bool,
    ) -> (Autostart, Arc<Mutex<Vec<bool>>>) {
        let writes = Arc::new(Mutex::new(vec![]));
        (
            Autostart::new(
                Box::new(Fake {
                    state,
                    writes: writes.clone(),
                    fail,
                }),
                writable,
                inherit,
            ),
            writes,
        )
    }
    #[test]
    fn import_only_inherits_enabled_current_executable() {
        let migration = json!({"found":true,"settingsApplied":true});
        for state in [
            LoginState::Missing,
            LoginState::Other,
            LoginState::Current(false),
            LoginState::Current(true),
        ] {
            let (manager, writes) = manager(state, true, true, false);
            let (inherit, _) = manager.prepare(&json!({"autoStart":false}), &migration);
            assert_eq!(inherit, state == LoginState::Current(true));
            assert!(writes.lock().unwrap().is_empty());
            manager.apply(&json!({"autoStart":inherit}), false);
            assert_eq!(writes.lock().unwrap().len(), usize::from(inherit));
        }
    }
    #[test]
    fn failed_inherited_preference_write_preserves_the_enabled_entry() {
        let (manager, writes) = manager(LoginState::Current(true), true, true, false);
        assert!(
            manager
                .prepare(
                    &json!({"autoStart":false}),
                    &json!({"found":true,"settingsApplied":true})
                )
                .0
        );
        manager.preserve();
        assert_eq!(manager.apply(&json!({"autoStart":false}), false), None);
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn foreign_portable_entry_survives_startup_and_unrelated_settings_changes() {
        let (manager, writes) = manager(LoginState::Other, true, true, false);
        manager.prepare(&json!({"autoStart":false}), &json!({"found":false}));
        assert_eq!(
            manager.apply(&json!({"autoStart":false,"language":"en"}), false),
            None
        );
        assert_eq!(manager.apply(&json!({"autoStart":false}), true), None);
        assert!(writes.lock().unwrap().is_empty());
        assert_eq!(manager.apply(&json!({"autoStart":true}), true), Some(true));
        assert_eq!(*writes.lock().unwrap(), vec![true]);
    }
    #[test]
    fn failed_import_is_preserved_until_an_explicit_toggle() {
        let (manager, writes) = manager(LoginState::Current(true), true, true, false);
        manager.prepare(
            &json!({"autoStart":true}),
            &json!({"error":"import failed"}),
        );
        assert_eq!(manager.apply(&json!({"autoStart":true}), false), None);
        assert_eq!(
            manager.apply(&json!({"autoStart":false}), true),
            Some(false)
        );
        assert_eq!(*writes.lock().unwrap(), vec![false]);
    }
    #[test]
    fn isolated_profiles_never_write_real_login_items_and_denials_are_reported() {
        let (manager, writes) = manager(LoginState::Current(true), false, false, false);
        assert_eq!(
            manager.prepare(&json!({}), &json!({"found":true,"settingsApplied":true})),
            (false, None)
        );
        assert_eq!(manager.apply(&json!({"autoStart":true}), true), None);
        assert!(writes.lock().unwrap().is_empty());
        let (denied, _) = super::tests::manager(LoginState::Missing, true, false, true);
        assert_eq!(denied.apply(&json!({"autoStart":true}), true), Some(false));
    }
}
