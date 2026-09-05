#!/usr/bin/env bash
# Cache the seed splats locally. Venue wifi is not a dependency worth having
# during a two-minute demo, and local loads are ~10x faster.
set -euo pipefail
BASE="https://storage.googleapis.com/forge-dev-public/hackathon-260227"
mkdir -p public/worlds
for f in haunted-house.spz cozy_ship.spz cozy_cottage.spz cozy-spaceship_2.spz; do
  if [ -s "public/worlds/$f" ]; then
    echo "have $f"
  else
    echo "fetching $f"
    curl -fL --progress-bar "$BASE/$f" -o "public/worlds/$f.part" && mv "public/worlds/$f.part" "public/worlds/$f"
  fi
done
echo "done: $(du -sh public/worlds | cut -f1)"
