use tauri::{Manager, Runtime, plugin::{Builder, PluginHandle, TauriPlugin}};
tauri::ios_plugin_binding!(init_plugin_kitchat_voice);
pub struct MobileVoice<R: Runtime>(PluginHandle<R>);
impl<R: Runtime> MobileVoice<R> {
    pub fn configure(&self, active: bool, speaker: Option<bool>) -> Result<serde_json::Value, String> {
        self.0.run_mobile_plugin("configure", serde_json::json!({"active":active,"speaker":speaker})).map_err(|error| error.to_string())
    }
}
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("voice-mobile").setup(|app, api| {
        let handle = api.register_ios_plugin(init_plugin_kitchat_voice)?;
        app.manage(MobileVoice(handle));
        Ok(())
    }).build()
}
