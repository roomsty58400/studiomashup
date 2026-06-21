export const mixTracks = async (trackA, trackB, mode, output) => {
  // Version simple : mix 50/50
  // Version avancée : crossfade, alignement BPM, etc.
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -i "${trackA}" -i "${trackB}" -filter_complex amix=inputs=2:duration=longest "${output}" -y`;
    exec(cmd, (err) => {
      if (err) return reject(err);
      resolve(output);
    });
  });
};
