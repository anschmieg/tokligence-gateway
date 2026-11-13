#!/usr/bin/env python3
"""Exercise a nonbuilt-in assistant slug using the existing isolated billing fixture."""
import argparse, subprocess, sys, tempfile
from pathlib import Path
p = argparse.ArgumentParser(); p.add_argument('--output', type=Path, required=True); a = p.parse_args()
if a.output.exists(): p.error('output must be new')
with tempfile.TemporaryDirectory() as directory:
    base = Path(directory)/'base.py'
    subprocess.run([sys.executable, str(Path(__file__).with_name('prepare_billing_smoke.py')), '--output', str(base)], check=True)
    source = base.read_text()
# Keep protocol /chat/completions unchanged: replace profile identifiers only.
source = source.replace("'chat'", "'assistant'").replace('/chat/v1/', '/assistant/v1/')
source = source.replace('chat_alias_selectable', 'assistant_alias_selectable')
a.output.write_text(source)
