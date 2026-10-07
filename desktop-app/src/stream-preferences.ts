export function streamProfile(saved: string | null, economy: boolean) {
  const requested = Number(saved);
  const fps = economy ? 15 : [15,30,60].includes(requested) ? requested : 30;
  return { fps, width: economy ? 1280 : 1920, height: economy ? 720 : 1080,
    bitrate: economy ? 1_200_000 : fps === 60 ? 6_000_000 : fps === 30 ? 4_500_000 : 3_000_000 };
}
