use serde_json::Value;
use std::sync::OnceLock;

static TABLE: OnceLock<Value> = OnceLock::new();

fn section() -> &'static Value {
    TABLE.get_or_init(|| {
        let all: Value = serde_json::from_str(include_str!("../../../localization/en_loc.json")).unwrap_or(Value::Null);
        all["launcher"].clone()
    })
}

// Line from the launcher section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
pub fn loc(key: &str, vars: &[(&str, &str)]) -> String {
    let mut node = section();
    for part in key.split('.') {
        node = &node[part];
    }
    let Some(line) = node.as_str() else { return key.to_string() };
    let mut out = line.to_string();
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}
