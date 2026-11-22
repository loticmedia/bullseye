# Bullseye

Scores Nerf-ball shots at a paper bullseye (rings 10–60, centre 100) from your iPhone, entirely in the browser.

- **Live** – point the camera at the target; each hit is scored as it lands (60 fps, so a shot can be one ring off). Zoom with the slider, a pinch, or the lens picker. **Overlay** turns the screen into a full-size scoreboard with the rings tinted in score colours and every hit marked.
- **Slo-mo clip** – record a round in the Camera app's Slo-Mo mode and pick the clip; every frame is scored on the phone. This is the accurate count.

How it works: a ball hitting the hanging paper makes it flap, which shows up as a spike in frame-to-frame motion. The newly arrived ball at that moment is the hit; its ring is read from a clean view of the target just before impact. `scorer.js` holds the algorithm (per-frame stage in plain JavaScript, per-hit stage with OpenCV.js); `frame-worker.js` and `measure-worker.js` run the two stages off the main thread.

Third-party files in `vendor/`: OpenCV.js 4.10.0 (Apache License 2.0, https://opencv.org) mp4box.js 0.5.3 (BSD 3-Clause, https://github.com/gpac/mp4box.js) and the Bungee typeface by David Jonathan Ross (SIL Open Font License 1.1).
