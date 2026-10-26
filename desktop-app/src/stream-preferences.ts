const RESOLUTIONS: Record<string, { width: number; height: number; bitrates: Record<number, number> }> = {
  "720": { width: 1280, height: 720, bitrates: { 15: 1_500_000, 30: 2_500_000, 60: 4_000_000 } },
  "1080": { width: 1920, height: 1080, bitrates: { 15: 3_000_000, 30: 4_500_000, 60: 6_000_000 } },
  "1440": { width: 2560, height: 1440, bitrates: { 15: 4_500_000, 30: 7_000_000, 60: 10_000_000 } },
};
export const STREAM_QUALITY_PRESETS = [["720", 30], ["720", 60], ["1080", 30], ["1080", 60], ["1440", 30], ["1440", 60]] as const;

export function streamProfile(saved: string | null, economy: boolean, resolution: string | null = "1080") {
  const requested = Number(saved);
  const fps = economy ? 15 : [15,30,60].includes(requested) ? requested : 30;
  if (economy) return { fps, width: 1280, height: 720, bitrate: 1_200_000, resolution: "720" };
  const key = resolution && RESOLUTIONS[resolution] ? resolution : "1080";
  const preset = RESOLUTIONS[key];
  return { fps, width: preset.width, height: preset.height, bitrate: preset.bitrates[fps], resolution: key };
}
