"""Builds dist/smoke-signal.html: one offline file with the modem core and icons inlined."""
import base64
from pathlib import Path
from urllib.parse import quote

root = Path(__file__).parent
page = (root / "src/app.html").read_text()
modem = (root / "src/modem.js").read_text()
favicon = "data:image/svg+xml," + quote((root / "assets/logo-small.svg").read_text().strip(), safe=" =:/\"'#,.-")
touch = "data:image/png;base64," + base64.b64encode((root / "assets/apple-touch-icon.png").read_bytes()).decode()
for key, value in {"%%MODEM%%": modem, "%%FAVICON%%": favicon, "%%TOUCH_ICON%%": touch}.items():
    assert key in page, key
    page = page.replace(key, value)
out = root / "dist/smoke-signal.html"
out.parent.mkdir(exist_ok=True)
out.write_text(page)
print(f"built {out} ({out.stat().st_size // 1024} KB)")
