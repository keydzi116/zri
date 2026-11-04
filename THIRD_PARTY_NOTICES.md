# Third-party software

Zri's own code is MIT-licensed (see `LICENSE`). Release builds bundle these components,
each under its own license:

| Component | License | Source |
|---|---|---|
| [Electron](https://www.electronjs.org/) (includes Chromium) | MIT; Chromium notices ship in the app as `LICENSES.chromium.html` | https://github.com/electron/electron |
| [FFmpeg](https://ffmpeg.org/) static build, run as a separate program to convert recordings to MP4 | GPL v3 (static build with libx264) | Binaries from https://github.com/eugeneware/ffmpeg-static (release `b6.1.1`); FFmpeg source: https://ffmpeg.org/download.html |
| [koffi](https://koffi.dev/) | MIT | https://github.com/Koromix/koffi |

FFmpeg is not linked into Zri; it is shipped unmodified as a standalone executable
(`Resources/ffmpeg/`) and invoked as a separate process.
