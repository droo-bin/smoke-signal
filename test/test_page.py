"""Browser tests for dist/smoke-signal.html (run `python3 build.py` first).

    python3 -m unittest discover -s test -p "test_*.py" -v
"""
import os
import pathlib
import subprocess
import tempfile
import time
import unittest

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
PAGE = (ROOT / "dist" / "smoke-signal.html").as_uri()


class PageTest(unittest.TestCase):
    launch_args = []

    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(args=cls.launch_args)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def open(self, suffix="", width=1440, **context):
        ctx = self.browser.new_context(viewport={"width": width, "height": 1000}, **context)
        self.addCleanup(ctx.close)
        page = ctx.new_page()
        errors, requests = [], []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("request", lambda r: requests.append(r.url))
        page.goto(PAGE + suffix)
        page.errors, page.requests = errors, requests
        return page


class LayoutTests(PageTest):
    def test_loads_without_errors_or_network_requests(self):
        page = self.open()
        page.fill("#call", "M7ABC")
        page.fill("#msg", "Water at St Mary's until 5pm.")
        page.locator("#plan", has_text="on air").wait_for()
        self.assertEqual(page.errors, [])
        self.assertEqual([u for u in page.requests if not u.startswith(("file:", "data:", "blob:"))], [])

    def test_keeps_everything_inside_the_page_at_phone_and_desktop_widths(self):
        for width in (360, 1000, 1600):
            with self.subTest(width=width):
                page = self.open(width=width)
                self.assertEqual(page.evaluate("document.documentElement.scrollWidth"), width)
                self.assertTrue(page.is_visible("#call"))
                self.assertTrue(page.is_visible("#listen"))

    def test_callsign_speed_and_theme_are_remembered(self):
        page = self.open()
        self.assertTrue(page.evaluate("document.getElementById('callfield').classList.contains('missing')"))
        page.fill("#call", "m7abc")
        page.click('[data-baud="300"]')
        page.click("#theme")
        page.reload()
        self.assertEqual(page.input_value("#call"), "M7ABC")
        self.assertEqual(page.title(), "M7ABC · Smoke Signal")
        self.assertEqual(page.get_attribute('[data-baud="300"]', "aria-pressed"), "true")
        self.assertEqual(page.get_attribute("html", "data-theme"), "light")

    def test_settings_and_about_open_as_dialogs_and_return_focus(self):
        page = self.open()
        page.click("#open-settings")
        self.assertTrue(page.is_visible("#ptt"))
        page.keyboard.press("Escape")
        self.assertFalse(page.is_visible("#ptt"))
        self.assertEqual(page.evaluate("document.activeElement.id"), "open-settings")
        page.click("#open-about")
        self.assertIn("needs a licence", page.inner_text("#about"))

    def test_big_files_get_a_warning_not_a_refusal(self):
        page = self.open()
        page.fill("#call", "M7ABC")
        page.click("#tab-file")
        page.set_input_files("#file", files=[{"name": "big.bin", "mimeType": "application/octet-stream", "buffer": os.urandom(60000)}])
        page.locator("#plan", has_text="long time on air").wait_for(timeout=20000)
        self.assertTrue(page.is_enabled("#send"))

    def test_the_test_panel_only_appears_when_asked_for(self):
        self.assertFalse(self.open().is_visible("#test-panel"))
        self.assertTrue(self.open("#test").is_visible("#test-panel"))


class TwoStationTests(PageTest):
    """Two pages joined by a pretend radio channel: whatever one transmits, the other receives."""

    def setUp(self):
        self.a, self.b = self.station("M7ABC"), self.station("G4XYZ")

    def station(self, call):
        page = self.open("#test")
        page.fill("#call", call)
        page.uncheck("#lbt")
        page.evaluate("window.smokeTest.timing(1500, 3, 0.3, 0.2)")
        page.evaluate("window.__out=[]; window.smokeTest.onTransmit(f=>{ f.forEach(x=>window.__out.push(Array.from(x))); })")
        return page

    def until(self, cond, secs=30):
        end = time.time() + secs
        while time.time() < end:
            for src, dst in ((self.a, self.b), (self.b, self.a)):
                for frame in src.evaluate("window.__out.splice(0)"):
                    dst.evaluate("(b)=>window.smokeTest.frame(new Uint8Array(b))", frame)
            if cond():
                return True
            self.a.wait_for_timeout(60)
        return False

    def queue(self):
        return self.a.evaluate("window.smokeTest.queue()")

    def test_a_message_to_one_station_is_confirmed(self):
        self.a.fill("#to", "G4XYZ")
        self.a.fill("#msg", "Can you bring the spare generator to the church hall?")
        self.a.click("#send")
        self.assertTrue(self.until(lambda: self.queue()[0]["status"] == "acked"))
        self.assertIn("spare generator", self.b.locator("#log li.to-me .body").first.inner_text())

    def test_a_long_message_arrives_in_one_piece(self):
        text = "Rest centre at Holbrook has blankets, water and phone charging. " * 12
        self.a.fill("#msg", text)
        self.a.click("#send")
        self.assertTrue(self.until(lambda: text.strip() in self.b.inner_text("#log")))
        self.assertEqual(self.a.errors + self.b.errors, [])


class MicrophoneTest(PageTest):
    """Plays ten messages with a room echo through Chrome's fake microphone, as if a phone were held up to
    another phone's speaker. Chrome's fake microphone sometimes drops 10 ms of audio, which loses a packet,
    so these allow for one or two losses."""
    baud = None

    @classmethod
    def setUpClass(cls):
        cls.wav = os.path.join(tempfile.mkdtemp(), f"echo-{cls.baud}.wav")
        subprocess.run(["node", str(ROOT / "test/support/echo-wav.js"), str(cls.baud), "3", "0.6", cls.wav], check=True)
        cls.launch_args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
                           f"--use-file-for-fake-audio-capture={cls.wav}%noloop"]
        super().setUpClass()

    def listen(self, seconds):
        page = self.open(permissions=["microphone"])
        page.click("#listen")
        page.wait_for_timeout(seconds * 1000)
        self.assertEqual(page.errors, [])
        return page.locator("#log li .note", has_text="message").count(), page.inner_text("#listen-status")


class EchoAt300BaudTests(MicrophoneTest):
    baud = 300

    def test_nearly_every_message_gets_through_a_room_echo(self):
        heard, status = self.listen(40)  # the recording is about 30 s long
        self.assertGreaterEqual(heard, 8, status)


class EchoAt1200BaudTests(MicrophoneTest):
    baud = 1200

    def test_the_same_echo_defeats_1200_baud(self):
        heard, status = self.listen(22)
        self.assertLessEqual(heard, 2, status)
        self.assertIn("too damaged to read", status)

if __name__ == "__main__":
    unittest.main()
