#!/bin/bash
# start a virtual display with a compositor + window manager
export DISPLAY=:77
pkill -x Xvfb 2>/dev/null; pkill -x openbox 2>/dev/null; pkill -x xcompmgr 2>/dev/null; sleep 0.5
Xvfb :77 -screen 0 1920x1080x24 +extension Composite +extension RENDER -ac >/tmp/zri-xvfb.log 2>&1 &
sleep 1.5
openbox >/tmp/zri-openbox.log 2>&1 &
sleep 0.8
xcompmgr -n >/tmp/zri-xcomp.log 2>&1 &
xsetroot -solid '#3b4252'
sleep 0.5
echo "display ready"
pulseaudio --kill 2>/dev/null; sleep 0.3
pulseaudio -D --exit-idle-time=-1 --disallow-exit >/tmp/zri-pulse.log 2>&1
sleep 1
pactl info | grep -E "Server Name|Default Source" 
