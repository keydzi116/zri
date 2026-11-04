# Tests

End-to-end tests drive the real app on a virtual X11 display (Linux), click through it like a user,
record, and check the saved MP4.

```bash
sudo apt-get install -y xvfb openbox xcompmgr x11-apps imagemagick xdotool pulseaudio pulseaudio-utils espeak-ng
npm install && npm run vendor
source test/xenv.sh          # virtual display :77 + PulseAudio
node test/run.js             # full flow: bubble drag/resize, clicks, pause, hotkeys, cancel
node test/audio.js speech.wav  # mic audio quality + pause timing (fake mic from a WAV file)
node test/crash.js           # kill the app mid-recording, relaunch, recording is recovered
node test/window.js          # record a single window
node test/demo.js            # records the README demo
```

Set `ZRI_LANG=en|ru` to force the UI language and `ZRI_EXE=/path/to/packaged/binary` to test a packaged build.
