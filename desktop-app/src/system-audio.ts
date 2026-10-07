import { Channel, invoke } from "@tauri-apps/api/core";

type SystemAudioEvent =
  | { kind: "pcm"; source: "mic" | "loopback"; sample_rate: number; channels?: number; samples_base64: string }
  | { kind: "level"; mic_rms: number; loopback_rms: number }
  | { kind: "failure"; category: string; message: string }
  | { kind: "info"; excluded_pid: number; excluded_process: string };

function decodePcm(value: string) {
  const raw = atob(value), bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return new Int16Array(bytes.buffer);
}

export async function startSystemAudioTrack() {
  const context = new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
  await context.resume();
  const destination = context.createMediaStreamDestination();
  const channel = new Channel<SystemAudioEvent>();
  let stopped = false, nextStart = context.currentTime + 0.04;
  channel.onmessage = (event) => {
    if (stopped) return;
    if (event.kind === "info") {
      console.info(`[Kitchat screen audio] excluding ${event.excluded_process} PID ${event.excluded_pid}`);
      return;
    }
    if (event.kind !== "pcm" || event.source !== "loopback") return;
    const pcm = decodePcm(event.samples_base64);
    const channels = Math.max(1, Math.min(2, event.channels || 1));
    const frames = Math.floor(pcm.length / channels);
    const buffer = context.createBuffer(channels, frames, event.sample_rate || 48_000);
    for (let channelIndex = 0; channelIndex < channels; channelIndex++) {
      const output = buffer.getChannelData(channelIndex);
      for (let frame = 0; frame < frames; frame++)
        output[frame] = pcm[frame * channels + channelIndex] / 32768;
    }
    const source = context.createBufferSource(), gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = 1;
    source.connect(gain).connect(destination);
    // Never let delayed IPC packets build a multi-second audio queue. Resetting
    // at 300 ms trades one tiny discontinuity for stable A/V sync.
    if (nextStart < context.currentTime || nextStart > context.currentTime + .18)
      nextStart = context.currentTime + .04;
    nextStart = Math.max(nextStart, context.currentTime + .025);
    source.start(nextStart);
    nextStart += buffer.duration;
    source.onended = () => { source.disconnect(); gain.disconnect(); };
  };
  await invoke("process_audio_start", { channel });
  const track = destination.stream.getAudioTracks()[0];
  if (!track) throw new Error("Системная аудиодорожка не создана");
  return {
    track,
    stop: async () => {
      if (stopped) return;
      stopped = true; track.stop();
      await invoke("process_audio_stop").catch(() => {});
      await context.close().catch(() => {});
    },
  };
}
