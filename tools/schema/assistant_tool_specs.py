"""The admin assistant's tool specs (name, description, input_schema) exactly as the reference offers them to the model.
The .NET assistant (BAL/AssistantTools.cs, live mode in BAL/AssistantAskBAL.cs) embeds this file and sends these specs.
Regenerate after the reference's tools change:
  cd <reference backend> && PYTHONPATH=. .venv/Scripts/python <this file> <repo>/PixCartAPI/BAL/Assets/assistant/tool-specs.json
Output: JSON list of tools.TOOLS[...].spec() in the reference's order (the order the model sees them)."""
import json
import sys

from app.assistant import tools

specs = [t.spec() for t in tools.TOOLS.values()]
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as f:
    json.dump(specs, f, ensure_ascii=False, indent=1)
    f.write("\n")
print(f"{len(specs)} tool specs written to {sys.argv[1]}")
