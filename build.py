"""Builds dist/smoke-signal.html: one offline file with the modem core inlined."""
from pathlib import Path

root = Path(__file__).parent
page = (root / "src/app.html").read_text()
modem = (root / "src/modem.js").read_text()
assert "%%MODEM%%" in page
out = root / "dist/smoke-signal.html"
out.parent.mkdir(exist_ok=True)
out.write_text(page.replace("%%MODEM%%", modem))
print(f"built {out} ({out.stat().st_size // 1024} KB)")
