import Tauri
import WebKit
import AVFoundation
import UIKit
import CallKit

struct SystemCallOptions: Decodable {
 let action: String
 let id: String
 let name: String
 let incoming: Bool
}

struct AudioOptions: Decodable {
 let active: Bool
 let speaker: Bool?
}
class KitChatVoicePlugin: Plugin, CXProviderDelegate {
 private weak var callWebView: WKWebView?
 private var callID: UUID?
 private var incoming = false
 private var answered = false
 private let controller = CXCallController()
 private lazy var provider: CXProvider = {
   let config = CXProviderConfiguration(localizedName: "KitChat")
   config.supportsVideo = false
   config.maximumCallGroups = 1
   config.maximumCallsPerCallGroup = 1
   config.supportedHandleTypes = [.generic]
   config.includesCallsInRecents = false
   let value = CXProvider(configuration: config)
   value.setDelegate(self, queue: .main)
   return value
 }()
 private func emitCall(_ action: String, muted: Bool = false) {
   guard let id = callID else { return }
   let payload: [String: Any] = ["action": action, "id": id.uuidString.lowercased(), "muted": muted]
   guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
   callWebView?.evaluateJavaScript("window.dispatchEvent(new CustomEvent('kitchat-system-call',{detail:\(json)}))", completionHandler: nil)
 }
 func providerDidReset(_ provider: CXProvider) { emitCall("end"); callID = nil }
 func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
   provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
   action.fulfill()
 }
 func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) { answered = true; emitCall("answer"); action.fulfill() }
 func provider(_ provider: CXProvider, perform action: CXEndCallAction) { emitCall("end"); callID = nil; action.fulfill() }
 func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) { emitCall("mute", muted: action.isMuted); action.fulfill() }
 @objc public func systemCall(_ invoke: Invoke) throws {
   let options = try invoke.parseArgs(SystemCallOptions.self)
   guard let id = UUID(uuidString: options.id) else { invoke.reject("Invalid call ID"); return }
   let name = String(options.name.prefix(80))
   switch options.action {
   case "incoming":
     callID = id; incoming = true; answered = false
     let update = CXCallUpdate(); update.localizedCallerName = name; update.remoteHandle = CXHandle(type: .generic, value: name)
     update.supportsHolding = false; update.supportsGrouping = false; update.supportsUngrouping = false
     provider.reportNewIncomingCall(with: id, update: update) { error in
       if let error = error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
     }
   case "start":
     if options.incoming {
       if answered { invoke.resolve(); return }
       controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { error in
         if let error = error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
       }
       return
     }
     callID = id; incoming = false
     let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: name))
     action.contactIdentifier = name
     controller.request(CXTransaction(action: action)) { error in
       if let error = error { invoke.reject(error.localizedDescription) } else { invoke.resolve() }
     }
   case "connected":
     if !incoming { provider.reportOutgoingCall(with: id, connectedAt: Date()) }
     invoke.resolve()
   case "end":
     if callID == id { provider.reportCall(with: id, endedAt: Date(), reason: .remoteEnded); callID = nil }
     invoke.resolve()
   default: invoke.reject("Unknown call action")
   }
 }
 @objc public override func load(webview: WKWebView) {
   callWebView = webview
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
