import Tauri
import WebKit
import AVFoundation
import UIKit

struct AudioOptions: Decodable {
 let active: Bool
 let speaker: Bool?
}
class KitChatVoicePlugin: Plugin {
 @objc public override func load(webview: WKWebView) {
   webview.configuration.allowsPictureInPictureMediaPlayback = true
   webview.scrollView.pinchGestureRecognizer?.isEnabled = false
   // CSS owns safe-area spacing. UIKit must not inset the same viewport again.
   webview.scrollView.contentInsetAdjustmentBehavior = .never
   webview.scrollView.contentInset = .zero
   webview.scrollView.scrollIndicatorInsets = .zero
   webview.isOpaque = true
   webview.backgroundColor = UIColor(red: 18/255, green: 18/255, blue: 20/255, alpha: 1)
 }
 @objc public func configure(_ invoke: Invoke) throws {
   let options = try invoke.parseArgs(AudioOptions.self)
   let session = AVAudioSession.sharedInstance()
   do {
     if options.active {
       try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth])
       try session.setActive(true)
       if let speaker = options.speaker {
         try session.overrideOutputAudioPort(speaker ? .speaker : .none)
       }
     } else {
       try session.setActive(false, options: [.notifyOthersOnDeactivation])
     }
     let route = session.currentRoute.outputs.map { $0.portName }.joined(separator: ", ")
     invoke.resolve(["route": route])
   } catch { invoke.reject(error.localizedDescription) }
 }
}
@_cdecl("init_plugin_kitchat_voice")
func initPlugin() -> Plugin { KitChatVoicePlugin() }
