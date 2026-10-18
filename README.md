<p align="center"><img src="assets/logo.svg" width="112" height="112" alt=""></p>

<h1 align="center">Smoke Signal</h1>

A modem in your browser. It turns messages, photos and files into sound that any radio can carry, and turns that sound back into messages. One offline HTML file, no installs, no servers.

**Use it now:** <https://droo-bin.github.io/smoke-signal/>. Or download `smoke-signal.html` from the [latest release](https://github.com/droo-bin/smoke-signal/releases/latest) and keep a copy on every device you might need it on: it works with no internet at all.

- **1200 baud AFSK packet radio** (Bell 202, AX.25 UI frames with CRC), the same format as APRS. Direwolf decodes its packets, and it matches Direwolf on Direwolf's own noisy benchmark (72/100 each).
- **A 300 baud mode for echoey paths:** speaker to microphone in a room, or weak and fading signals. Echoes of a few milliseconds smear 1200 baud symbols into each other; at 300 baud each symbol is four times longer and they survive. Listening decodes both speeds at once, so only the sender has to choose.
- **No hard size limit:** transfers can run to tens of thousands of blocks (up to 4 MB after compression). Anything over about ten minutes on air gets a warning instead.
- **Bulletins for longer messages and files:** split into 64-byte blocks and sent as a stream of mixed packets (a random linear fountain code). Listeners rebuild them from about two more packets than the block count, in any order, with no replies. "Send more packets" tops up anyone still missing pieces.
- **Repeat until stopped:** tick "Keep repeating" to send on a loop with a pause between rounds. Later rounds of a file or long message are fresh mixed packets, so someone who tunes in partway through still rebuilds the whole thing.
- **Several stations on one channel:** everything heard is decoded and labelled by callsign. The Stations tab lists who's been heard (last heard, packets, signal), with **Watch** (flag their messages) and **Mute** (hide them). Messages can be filtered to one station or to "To me".
- **To:** send to everyone or to one callsign (it goes in the packet's destination field). Messages addressed to you are highlighted.
- **Listen before talking:** with "Wait for a clear channel" on (the default) and listening switched on, it waits until no one else is sending, then a random short pause, before each burst. This is what keeps two stations from talking over each other.
- **Queue and replies:** everything you send joins a queue. Messages and files sent to one callsign wait for that station's automatic "got it" reply, retrying with growing gaps (then "no reply"), and stop early once confirmed. Repeats show once with "heard ×N".
- **Recovering from loss:** the Listen card counts packets heard but too damaged to read. A transfer that stops part way shows how many more packets it needs; if it was sent to you, your page asks the sender for exactly that many, otherwise there's an "Ask for more" button.
- **Resending files:** a file's id comes from its content, so sending the same file again (even after a reload) adds to whatever a listener already has rather than starting over, and each send carries on with fresh packets. Sent files stay in the queue after a reload; **Send more…** sends some fresh packets or particular blocks (e.g. 37 to 157). Half-received files are remembered too, so a later resend finishes them.
- **Press-to-talk cue:** if your radio needs its talk button held, choose that in Radio settings and a banner tells you when to hold it and when to let go.
- **Photos shrink for radio:** resized, re-encoded as WebP (or JPEG), optionally black and white. A phone photo typically becomes 1–4 KB, about 30–60 seconds on air.
- **Test without a radio (hidden):** open the page with `#test` on the end (for example `smoke-signal.html#test`) to show a panel that sends what you've written through a pretend link with hiss and lost packets, then decodes it.

## Use

```
python3 build.py                                        # builds dist/smoke-signal.html
node --test test/modem.test.js                          # modem core
python3 -m unittest discover -s test -p "test_*.py"     # browser tests (needs: pip install playwright)
```

`npm test` runs all three.

Open `dist/smoke-signal.html`. To try it over the air acoustically, open it on two phones, start listening on one and send from the other with the phones close together. With radios, connect a phone's headphone output to the radio's mic input (and the radio's speaker to the listening device), and set the radio to voice-activated transmit.

The interop tests use Direwolf's `atest` and `gen_packets`, built from source. They look in `/tmp/direwolf/build/src`, or wherever `DIREWOLF_BIN` points, and skip if the tools aren't there:

```
git clone https://github.com/wb2osz/direwolf.git /tmp/direwolf
cmake -S /tmp/direwolf -B /tmp/direwolf/build       # needs cmake and the ALSA headers (libasound2-dev)
make -C /tmp/direwolf/build atest gen_packets
```

| Test | What it checks |
| --- | --- |
| `test/modem.test.js` | Framing and CRC, decoding through noise and echo at both speeds, bulletins and resends, damaged-packet counting, Direwolf decoding our packets and matching Direwolf on its own benchmark |
| `test/test_page.py` | The page loads with no errors or network requests, fits phone and desktop widths, remembers settings, warns on big files; two stations exchange messages and confirmations; through Chrome's fake microphone, messages at 300 baud get through a room echo that defeats 1200 baud |

## Publishing

`.github/workflows/publish.yml` builds and runs every test on each push and pull request.

- **Pushes to `main`** publish the page to GitHub Pages, at the site root and as `smoke-signal.html`.
- **Tags like `v1.0.0`** also create a GitHub release with `smoke-signal.html` and a `.sha256` checksum attached:

  ```
  git tag v1.0.0 && git push origin v1.0.0
  ```

One-time setup: in the repository's **Settings → Pages**, set **Source** to **GitHub Actions**. For the link preview, upload `assets/social-preview.png` under **Settings → General → Social preview**.

## Logo and icons

`assets/` holds the logo (`logo.svg`, and a bolder `logo-small.svg` for tiny sizes), PNG icons at 512, 192 and 32 px, the home-screen icon and the GitHub social preview. The mark is a continuous-phase FSK wave: a slow tone switching to a faster one, which is what the modem actually sends. `python3 assets/make_icons.py` redraws them all. The build inlines the favicon and home-screen icon into the page, so it still works as a single offline file.

## Before you transmit

In the UK, sending data on amateur bands needs a licence and your callsign (sent in every packet), and messages must not be encrypted. Licence-free radios have their own rules. Check with Ofcom.

## Disclaimer

Smoke Signal is provided "as is", without warranty of any kind. It is not a certified or emergency-grade communications system, and it may fail to send or receive. Don't rely on it as your only way to call for help: in an emergency, use 999 or 112 first. You are responsible for holding any licence you need to transmit and for following the rules of the band and radio you use. As far as the law allows, the authors are not liable for any loss or damage arising from its use.

## Licence

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
