#!/bin/bash
# Render every diagram source to PNG. PlantUML for UML/C4/Gantt, Graphviz for flowcharts.
[ -f plantuml.jar ] || curl -sL -o plantuml.jar https://github.com/plantuml/plantuml/releases/download/v1.2024.7/plantuml-1.2024.7.jar
cd "$(dirname "$0")"
rm -f *.png
for f in *.puml; do [ "$f" = "style.iuml" ] && continue; timeout 300 java -jar plantuml.jar -tpng -nometadata "$f" 2>&1 | grep -v "^$"; done
for f in *.dot; do timeout 180 dot -Tpng -Gdpi=150 -o "${f%.dot}.png" "$f" 2>&1; done
