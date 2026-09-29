Auto-Editor GUI V6
==================

1) Put auto-editor-windows-x86_64.exe in this folder.
2) Double-click start-gui.bat.
3) Choose a video.
4) Optional: click "حلّل الصوت واقترح" for Safe / Recommended / Aggressive threshold suggestions.
5) Click "تحليل أماكن القص".
6) Click "معاينة سلسة بعد القص". The first time, V6 creates a low-resolution temporary proxy; playback is then continuous and does not seek at every cut.
7) Review the waveform timeline. Red areas are cuts, gray waveform is audio energy, blue line is the selected threshold.
8) Export the final video, or create an editable CapCut project with the cuts already on the timeline.

During long analysis/render jobs the GUI shows progress when Auto-Editor reports it, and the operation can be cancelled from the status bar.
Changing a Cut to "احتفظ" keeps that range in the final preview/export without forcing a new analysis.

Notes
-----
- Editable CapCut export requires `capcut-cli` 0.26.0. Install once with: npm install -g capcut-cli@0.26.0
- CapCut export references the kept source ranges correctly and does not render/transcode the video. capcut-cli copies the source media into the generated draft's assets folder.
- The watermark/logo is used by the final-video render only; it is not added to the CapCut timeline yet.
- Fast no-UI mode: run `install-cutcap.cmd` once, then from any terminal use `cutcap "D:\video.mp4"`. It measures the video's audio, automatically uses the recommended threshold, uses 0s before/after speech, and creates an editable CapCut draft.
- The threshold suggestion is a GUI heuristic built on the official `auto-editor levels` data. Auto-Editor itself does not expose an official "best threshold" command.
- Smooth preview files are temporary and are deleted by stop-gui.bat / next clean start.
- The launcher kills only old Auto-Editor GUI server.js instances on the known GUI ports, plus their child processes. It does not delete your videos or Auto-Editor EXE.
- Browser tabs keep separate video/preview state, so choosing a different video in another tab does not change an existing tab's source.

Developer check
---------------
Run: node --test tests/shared.test.js tests/server.integration.test.js tests/server-process.test.js tests/launcher.test.js tests/ui.contract.test.js tests/auto-editor.integration.test.js

Unified YouTube workspace
-------------------------
The same local Studio now includes a YouTube download workspace.

Features:
- Download only a selected time range with yt-dlp --download-sections.
- Fast mode is the default and uses stream copy instead of re-encoding.
- Optional exact-cut mode is available under Advanced settings.
- Full-video and MP3 audio modes.
- Quality caps from 360p to 2160p or best.
- Video title, channel, duration and thumbnail inspection before download.
- Live phase, progress, processed time, file size, download data, speed, ETA and elapsed time.
- Download cancellation and output-folder selection.
- yt-dlp update action from the UI.
- 403/SABR retry fallback.
- The Studio prefers the pinned CutCap FFmpeg build when it is installed.

Download data:
The UI prefers the byte count reported by yt-dlp/FFmpeg. If that number is not available, it falls back to an approximate whole-device receive counter and marks it with an approximation sign.

Open the YouTube workspace from the top tab in the Studio.
Fast clip download is the recommended default for normal use.