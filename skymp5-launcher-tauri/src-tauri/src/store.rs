// Launcher settings: one JSON file in %APPDATA%\Alduinak Launcher, the same file the Electron launcher wrote
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Mutex;

pub const DEFAULT_BASE_DIR: &str = "C:\\Alduinak";

pub fn data_dir() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(appdata).join("Alduinak Launcher")
}

fn defaults() -> Value {
    json!({
        "skyrimPath": "",
        "activeServerId": "alduinak",
        "cachedServers": [],
        "filesVersion": "",
        "discordUser": null,
        "mo2Enabled": true,
        "discordPresence": true,
        "nexusOauth": null,
        "nexusUser": null,
        "isolatedGame": true,
        "gameStore": "",
        "baseDirPath": "",
        "forcedDefaultsApplied": false
    })
}

pub struct Store {
    path: PathBuf,
    data: Mutex<Map<String, Value>>,
}

impl Store {
    pub fn open() -> Self {
        let path = data_dir().join("config.json");
        let mut data = defaults().as_object().cloned().unwrap_or_default();
        if let Ok(text) = std::fs::read_to_string(&path) {
            if let Ok(Value::Object(saved)) = serde_json::from_str::<Value>(&text) {
                data.extend(saved);
            }
        }
        Store { path, data: Mutex::new(data) }
    }

    pub fn get(&self, key: &str) -> Value {
        self.data.lock().unwrap().get(key).cloned().unwrap_or(Value::Null)
    }

    pub fn str(&self, key: &str) -> String {
        self.get(key).as_str().unwrap_or("").to_string()
    }

    pub fn bool(&self, key: &str) -> bool {
        self.get(key).as_bool().unwrap_or(false)
    }

    pub fn set(&self, key: &str, value: Value) {
        self.set_many(vec![(key.to_string(), value)]);
    }

    pub fn delete(&self, key: &str) {
        self.data.lock().unwrap().remove(key);
        self.save();
    }

    pub fn set_many(&self, pairs: Vec<(String, Value)>) {
        {
            let mut d = self.data.lock().unwrap();
            for (k, v) in pairs {
                d.insert(k, v);
            }
        }
        self.save();
    }

    fn save(&self) {
        let text = serde_json::to_string_pretty(&Value::Object(self.data.lock().unwrap().clone())).unwrap_or_default();
        let _ = std::fs::create_dir_all(self.path.parent().unwrap());
        let tmp = self.path.with_extension("json.tmp");
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &self.path);
        }
    }
}
