# Remote receipt OCR agent

Receipt OCR can run on another machine, for example a laptop at home, instead of on the API server.
The agent (`backend/scripts/ocr_agent.py`) asks the server for photos over HTTPS, reads them with the
same OCR code (`app/services/receipt_ai/ocr.py`) and sends the text back. The server never connects to
the agent, so nothing has to be opened on the home router.

```
scan ─► API server ─► Redis queue ◄── agent: POST /ocr-agent/claim (waits up to 20 s)
                                      agent reads the photo on its CPU
          scan ◄── Redis ◄────────── agent: POST /ocr-agent/jobs/<id>/result
```

When no agent has asked for work in the last minute, or none answers within
`RECEIPT_OCR_AGENT_TIMEOUT_SECONDS`, the scan uses the fallback: the photos go to the admins' model
(`RECEIPT_OCR_WHEN_AGENT_OFFLINE=photos`, the default) or the server reads them itself (`local`).
Scans keep working either way. Each fallback just costs more than the OCR path.

## 1. Server

In the server's `.env`:

```
RECEIPT_OCR_AGENT_TOKEN=<python -c "import secrets;print(secrets.token_urlsafe(32))">
RECEIPT_OCR_AGENT_TIMEOUT_SECONDS=60
RECEIPT_OCR_WHEN_AGENT_OFFLINE=photos
```

Restart the API. With the token unset, the agent routes return 404 and OCR runs on the server as before.
The photo-model fallback is whatever model the admins chose in the admin console. Pick Sonnet there
rather than Opus if fallbacks should stay cheap.

## 2. The laptop

Uses the backend's own venv (`uv venv --python 3.12` + `pip install -r requirements.txt`).

```
cat > ~/.config/shareeven-ocr-agent.env <<'ENV'
SHAREEVEN_API=https://api.shareeven.com/api/v1
OCR_AGENT_TOKEN=<the same token>
OCR_AGENT_WORKERS=3
RECEIPT_OCR_THREADS=4
ENV
chmod 600 ~/.config/shareeven-ocr-agent.env

cp infra/ocr-agent/shareeven-ocr-agent.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now shareeven-ocr-agent
loginctl enable-linger $USER          # keeps running after logout
journalctl --user -u shareeven-ocr-agent -f
```

The workers multiplied by the threads should stay a few cores below the CPU count (3 × 4 on a 14-core laptop).
Stop the laptop from sleeping while it serves. On GNOME: Settings → Power → Automatic suspend off,
and keep the lid-close action at "nothing" when plugged in
(`HandleLidSwitchExternalPower=ignore` in `/etc/systemd/logind.conf`).

## 3. Phone as backup internet (USB tethering)

Plug the phone in and turn on Settings → Network & internet → Hotspot & tethering → USB tethering.
Linux prefers the connection with the lowest route metric, so give home Wi-Fi or ethernet a low one
and the phone a high one. The phone is then used only when the home connection is down:

```
nmcli connection show                                   # find the names
nmcli connection modify "<home wifi>" ipv4.route-metric 100 ipv6.route-metric 100
nmcli connection modify "<usb tether>" ipv4.route-metric 700 ipv6.route-metric 700 connection.autoconnect yes
```

When the network switches over, the agent's next request fails, it waits a few seconds and carries on.
A photo is under about 1 MB, so mobile data use stays small. While the phone is always plugged in,
turn on Settings → Battery → Charging optimization → limit to 80%.

## Privacy

The server sends a decrypted photo only to the agent that claimed it, over HTTPS. In Redis the photo is
sealed with the media key, which never leaves the server. The agent keeps photos in memory only and
logs row counts and timings, never receipt text. Mention the processing machine in the privacy policy.
