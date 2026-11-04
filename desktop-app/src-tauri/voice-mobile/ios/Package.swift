// swift-tools-version:5.3
import PackageDescription
let package = Package(
 name: "tauri-plugin-voice-mobile",
 platforms: [.iOS(.v13)],
 products: [.library(name: "tauri-plugin-voice-mobile", type: .static, targets: ["tauri-plugin-voice-mobile"])],
 dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
 targets: [.target(name: "tauri-plugin-voice-mobile", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
