// Writes ui/en_loc.js with the launcher section of localization/en_loc.json for the window's loc()
fn write_ui_loc() {
    let src = "../../localization/en_loc.json";
    println!("cargo:rerun-if-changed={src}");
    let table: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(src).expect("read en_loc.json")).expect("parse en_loc.json");
    let js = format!("window.EN_LOC = {};\n", table["launcher"]);
    std::fs::write("../ui/en_loc.js", js).expect("write ui/en_loc.js");
}

fn main() {
    write_ui_loc();
    tauri_build::build()
}
